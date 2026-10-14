'use strict';
// lib/sweeper.js — periodic + on-demand liveness sweep.
// - interval sweep every SWEEP_INTERVAL_MS (default 25 min)
// - on-demand: GET /status triggers registry.sweep() single-flight when
//   cache age > REFRESH_MIN_AGE_MS. The caller gets the cache immediately
//   (stale-while-revalidate); the fresh result lands in cache for next call.
class Sweeper {
  constructor(registry, cfg, logger) {
    this.registry = registry;
    this.cfg = cfg;
    this.log = logger || (() => {});
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._arm();
    this.log(`[sweeper] armed; interval=${this.cfg.sweepIntervalMs}ms`);
    // Initial sweep on boot (re-adopts already-running models' RSS too).
    this.registry.sweep().catch((e) => this.log(`[sweeper] initial sweep error: ${e.message}`));
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _arm() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.registry.sweep()
        .catch((e) => this.log(`[sweeper] sweep error: ${e.message}`))
        .finally(() => this._arm());
    }, this.cfg.sweepIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * Stale-while-revalidate: returns current cache entries immediately, and
   * kicks a background refresh when cache is stale. Never blocks on the
   * refresh itself.
   * @returns {{entries:object[], cacheAgeMs:number|null, refresh:'fresh'|'stale'|'in-progress'}}
   */
  cachedStatus() {
    const age = this.registry.cacheAgeMs();
    const stale = this.registry.isCacheStale();
    if (stale && !this.registry.refreshLock) {
      this.registry.sweep().catch((e) => this.log(`[sweeper] bg refresh error: ${e.message}`));
    }
    return {
      entries: this.registry.all(),
      cacheAgeMs: age,
      refresh: !stale ? 'fresh' : (this.registry.refreshLock ? 'in-progress' : 'stale'),
    };
  }
}

module.exports = { Sweeper };
