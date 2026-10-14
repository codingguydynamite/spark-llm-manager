'use strict';
// lib/registry.js — in-memory state machine, single-flight start lock,
// status cache. Knows nothing about child_process internals: it receives
// pid + liveness facts from lib/process.js and applies transitions.
//
// States per model: stopped | starting | running
// Single-flight: a promise lock per model so two concurrent start requests
// can never both pass the "stopped" check and spawn twice.

class Registry {
  constructor(models, logger, opts = {}) {
    this.models = models; // catalog entries (from config)
    this.log = logger || (() => {});
    this.refreshMinAgeMs = opts.refreshMinAgeMs ?? 5 * 60 * 1000;
    this.stopGraceMs = opts.stopGraceMs ?? 10000;
    /** @type {Map<string, {name,label,state,pid,startedAt,stoppedAt,readyAt,lastError,expectedGpuGb,expectedRamGb,port,match}>} */
    this.state = new Map();
    /** children spawned by THIS api process: Map<name, ChildProcess> */
    this.children = new Map();
    /** single-flight locks: Map<name, Promise> */
    this.startLocks = new Map();
    /** refresh lock shared by sweeper + on-demand refresh */
    this.refreshLock = null;
    this.cache = { at: 0, entries: [] };
    for (const m of models) {
      this.state.set(m.name, {
        name: m.name,
        label: m.label,
        state: 'stopped',
        pid: null,
        startedAt: null,
        stoppedAt: null,
        readyAt: null,
        lastError: null,
        expectedGpuGb: m.expectedGpuGb,
        expectedRamGb: m.expectedRamGb,
        port: m.port,
        match: m.match,
      });
    }
  }

  get(name) {
    const s = this.state.get(name);
    if (!s) return null;
    return {
      ...s,
      rssGb: s.rssGb ?? null,
      cacheAgeMs: this.cache.at ? Date.now() - this.cache.at : null,
      adopted: !this.children.has(name) && s.pid != null,
    };
  }

  all() {
    return this.models.map((m) => this.get(m.name));
  }

  /** Apply a liveness fact for one tracked pid. Returns state (may have transitioned). */
  setLiveness(name, pid, alive, rssBytes) {
    const s = this.state.get(name);
    if (!s) return null;
    if (alive) {
      if (s.state === 'stopped' && pid != null) {
        // externally started process discovered (re-adoption path)
        s.state = 'running';
        s.lastError = null;
      }
      s.pid = pid;
    } else if (s.state !== 'stopped') {
      s.state = 'stopped';
      s.pid = null;
      s.stoppedAt = new Date().toISOString();
      s.lastError = s.lastError || 'process exited (detected by sweep)';
      this.children.delete(name);
      this.log(`[registry] ${name}: process gone -> stopped`);
    }
    s.rssGb = rssBytes != null ? Math.round((rssBytes / 1024 ** 3) * 10) / 10 : null;
    return s;
  }

  /**
   * Request start of a model. Single-flight: the check+spawn is atomic in
   * single-threaded JS (no await between the state check and lock set), so
   * concurrent callers can never both pass the "stopped" check and spawn
   * twice. Callers that observe the model already starting/running get a
   * fast in-progress/already-running answer without waiting on the lock.
   * @returns {Promise<{outcome:'started'|'in-progress'|'already-running'|'error', state:object, message:string}>}
   */
  requestStart(name) {
    const s = this.state.get(name);
    if (!s) return Promise.reject(new Error(`unknown model "${name}"`));
    if (s.state === 'running') {
      return Promise.resolve({ outcome: 'already-running', state: s, message: 'LLM already running' });
    }
    if (s.state === 'starting' || this.startLocks.has(name)) {
      return Promise.resolve({ outcome: 'in-progress', state: s, message: "We're starting an LLM for you" });
    }
    // s.state === 'stopped': acquire the lock and spawn.
    this.startLocks.set(name, true);
    s.state = 'starting';
    s.lastError = null;
    s.startedAt = new Date().toISOString();
    s.readyAt = null;
    s.pid = null;
    this.log(`[registry] ${name}: starting`);
    const model = this.models.find((m) => m.name === name);
    return new Promise((resolve) => {
      Promise.resolve()
        .then(() => this.spawner(name, model, s))
        .then(() => {
          // spawner resolved: process alive, readiness probe may still be
          // pending (state 'starting') or complete (state 'running').
          resolve({ outcome: 'started', state: s, message: `Starting ${name}` });
        })
        .catch((e) => {
          s.state = 'stopped';
          s.lastError = `spawn failed: ${e.message}`;
          this.log(`[registry] ${name}: ${s.lastError}`);
          resolve({ outcome: 'error', state: s, message: s.lastError });
        })
        .finally(() => this.startLocks.delete(name));
    });
  }

  /**
   * Stop a model: SIGTERM -> grace -> SIGKILL.
   * @returns {Promise<{outcome:'stopped'|'not-tracked'|'already-dead', state:object}>}
   */
  async requestStop(name) {
    const s = this.state.get(name);
    if (!s) return { outcome: 'not-tracked', state: null };
    const pid = s.pid;
    s.state = 'stopped';
    s.pid = null;
    s.stoppedAt = new Date().toISOString();
    s.lastError = null;
    const child = this.children.get(name);
    this.children.delete(name);
    if (child) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    if (pid != null && this.killer) await this.killer(pid, this.stopGraceMs);
    this.log(`[registry] ${name}: stop requested`);
    return { outcome: 'stopped', state: s };
  }

  /** Take over an externally-started (or re-adopted) pid without a child handle. */
  adopt(name, pid) {
    const s = this.state.get(name);
    if (!s) return;
    s.state = 'running';
    s.pid = pid;
    s.lastError = null;
    this.log(`[registry] ${name}: adopted pid=${pid}`);
  }

  /** Record successful readiness for a model. */
  markRunning(name, pid) {
    const s = this.state.get(name);
    if (!s) return;
    s.state = 'running';
    s.pid = pid;
    s.readyAt = new Date().toISOString();
    s.lastError = null;
  }

  /** Record spawn failure before first liveness confirmation. */
  markSpawnError(name, err) {
    const s = this.state.get(name);
    if (!s) return;
    s.state = 'stopped';
    s.lastError = err && err.message ? err.message : String(err);
    s.pid = null;
    this.children.delete(name);
  }

  /** Take over a child process handle + pid for a starting/running model. */
  attach(name, child, pid) {
    const s = this.state.get(name);
    if (!s) return;
    this.children.set(name, child);
    s.pid = pid;
    child.on('exit', (code, signal) => {
      const cur = this.state.get(name);
      if (cur && cur.state !== 'stopped') {
        cur.state = 'stopped';
        cur.pid = null;
        cur.stoppedAt = new Date().toISOString();
        cur.lastError = code === 0 ? 'process exited' : `process exited (code=${code ?? 'n/a'}, signal=${signal ?? 'n/a'})`;
        this.log(`[registry] ${name}: child exited -> stopped (${cur.lastError})`);
      }
    });
  }

  /**
   * Run one sweep: liveness + RSS for every tracked pid, write cache.
   * Single-flight with on-demand refresh. `refresh` may be provided by
   * caller for extra checks (none built-in).
   */
  sweep() {
    if (this.refreshLock) return this.refreshLock;
    this.refreshLock = this._sweepOnce().finally(() => { this.refreshLock = null; });
    return this.refreshLock;
  }

  async _sweepOnce() {
    for (const m of this.models) {
      const s = this.state.get(m.name);
      if (s.pid == null) { s.rssGb = null; continue; }
      const a = this.liveness ? this.liveness(s.pid) : true;
      const rss = this.rss ? this.rss(s.pid) : null;
      this.setLiveness(m.name, s.pid, a, rss);
    }
    this.cache = { at: Date.now(), entries: this.all() };
    return this.cache;
  }

  cacheAgeMs() {
    return this.cache.at ? Date.now() - this.cache.at : null;
  }

  isCacheStale() {
    const age = this.cacheAgeMs();
    return age == null || age > this.refreshMinAgeMs;
  }
}

module.exports = { Registry };
