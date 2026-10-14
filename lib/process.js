'use strict';
// lib/process.js — the ONLY module touching child_process and /proc.
// Pure-Node liveness/RSS (no ps, no grep). /proc re-adoption scan on boot.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');

const PAGE_SIZE = 4096; // statm counts 4 KiB pages (x86_64/ARM64 Linux default)
const NET_CONNECT_TIMEOUT_MS = 1500;

/** True if a process with this pid exists (signal 0 = no-op probe). */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours
  }
  return true;
}

function readProcFile(pid, name) {
  try {
    return fs.readFileSync(path.join('/proc', String(pid), name), 'utf8');
  } catch {
    return null;
  }
}

/** RSS in bytes from /proc/<pid>/statm (field 2, in pages); null if unreadable. */
function rssBytes(pid) {
  if (!Number.isInteger(pid)) return null;
  const statm = readProcFile(pid, 'statm');
  if (!statm) return null;
  const pages = Number(statm.split(/\s+/)[1]);
  return Number.isFinite(pages) ? pages * PAGE_SIZE : null;
}

/** NUL-separated argv from /proc/<pid>/cmdline; null if unreadable (zombie/kernel). */
function cmdline(pid) {
  const raw = readProcFile(pid, 'cmdline');
  if (!raw) return null;
  const args = raw.split('\0').filter(Boolean);
  return args.length ? args : null;
}

/** Resolved cwd of a process via /proc/<pid>/cwd; null if unreadable. */
function cwdOf(pid) {
  if (!Number.isInteger(pid)) return null;
  try {
    return fs.readlinkSync(path.join('/proc', String(pid), 'cwd'));
  } catch {
    return null;
  }
}

/** Direct child pids of a process (from /proc/<pid>/task/<tid>/children). */
function childPids(pid) {
  try {
    const files = fs.readdirSync(path.join('/proc', String(pid), 'task'));
    const set = new Set();
    for (const t of files) {
      let raw;
      try {
        raw = fs.readFileSync(path.join('/proc', String(pid), 'task', t, 'children'), 'utf8');
      } catch {
        continue;
      }
      for (const c of raw.trim().split(/\s+/)) {
        const n = Number(c);
        if (Number.isInteger(n) && n > 0) set.add(n);
      }
    }
    return [...set];
  } catch {
    return [];
  }
}

/**
 * Sum RSS across the process tree (pid + all descendants).
 * The API spawns `bash -lc <cmd>`; bash may fork or exec the actual engine
 * (vLLM python process), so the real footprint lives in the descendants.
 */
function treeRssBytes(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const seen = new Set([pid]);
  const queue = [pid];
  let total = 0;
  let any = false;
  while (queue.length) {
    const p = queue.shift();
    const b = rssBytes(p);
    if (b != null) {
      total += b;
      any = true;
    }
    for (const c of childPids(p)) {
      if (!seen.has(c)) {
        seen.add(c);
        queue.push(c);
      }
    }
  }
  return any ? total : null;
}

/**
 * Re-adopt running model processes after an API restart.
 * A model matches a pid when its `match` string appears in the process's
 * cmdline OR in its resolved cwd (bash -lc exec-optimisation can drop the
 * launch argv, and scripts like `./run.sh` run with a relative path — but the
 * working directory is preserved).
 * models: array of catalog entries (each has .match).
 * Returns Map<modelName, pid>.
 */
function findAdoptable(models) {
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number);
  } catch {
    return new Map();
  }
  const found = new Map();
  for (const pid of pids) {
    if (pid === process.pid) continue;
    const cmd = cmdline(pid);
    if (!cmd) continue;
    const cwd = cwdOf(pid) || '';
    const joined = cmd.join(' ') + ' ' + cwd;
    for (const m of models) {
      if (found.has(m.name)) continue;
      if (joined.includes(m.match)) found.set(m.name, pid);
    }
  }
  return found;
}

function portOpen(host, port, timeoutMs = NET_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
    sock.once('connect', () => finish(true));
    sock.connect(port, host);
  });
}

async function waitPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portOpen(host, port)) return true;
    if (Date.now() + 500 > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Spawn a model. command is executed via bash -lc (login shell — PATH,
 * conda/venv activation and user env are available on the target host).
 * stdout/stderr are redirected to logPath.
 *
 * `detached: true` puts the model in its own process group so it SURVIVES an
 * API crash/restart (pm2 or signal) — the model is re-adopted from /proc on
 * the next API boot. `child.unref()` keeps the event loop from waiting on
 * the model; we still receive its 'exit' event for liveness tracking while
 * the API is alive. Stopping a model kills its whole process tree
 * (see killPid), so detachment does not leak descendants.
 *
 * Returns the child (registry stores pid + child handle).
 */
function spawnModel(model, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, 'a');
  const child = spawn('bash', ['-lc', model.command], {
    cwd: model.cwd && fs.existsSync(model.cwd) ? model.cwd : os.homedir(),
    env: process.env,
    stdio: ['ignore', out, out],
    detached: true,
  });
  fs.closeSync(out);
  child.unref();
  child.on('error', (e) => { /* surface via registry state */ });
  return child;
}

/**
 * SIGTERM now, SIGKILL after graceMs — across the whole process tree, since
 * bash -lc may have forked the actual engine (vLLM python process) as a
 * descendant; killing only the top pid would orphan it.
 * Resolves when the root pid is dead.
 */
function killPid(pid, graceMs = 10000) {
  return new Promise((resolve) => {
    if (!alive(pid)) return resolve({ alreadyDead: true });
    const collect = () => {
      const pids = [pid, ...childPids(pid)];
      const extra = new Set();
      for (const p of [...pids]) for (const c of childPids(p)) extra.add(c);
      return [...new Set([...pids, ...extra])];
    };
    let fired = false;
    const kill = (sig) => {
      for (const p of collect()) {
        try { process.kill(p, sig); } catch (e) {
          if (e.code !== 'ESRCH' && e.code !== 'EPERM') { /* ignore */ }
        }
      }
    };
    kill('SIGTERM');
    const t = setTimeout(() => {
      if (!fired) { fired = true; kill('SIGKILL'); }
    }, graceMs);
    const iv = setInterval(() => {
      if (!alive(pid)) {
        clearTimeout(t);
        clearInterval(iv);
        resolve({ alreadyDead: false });
      }
    }, 200);
  });
}

module.exports = { alive, rssBytes, treeRssBytes, cmdline, cwdOf, findAdoptable, portOpen, waitPort, spawnModel, killPid, PAGE_SIZE };
