'use strict';
// server.js — entry point.
//   1. load config (models.json + env)
//   2. build app (registry + spawner wiring + routes + sweeper)
//   3. /proc re-adoption scan (re-attach to LLMs started before this boot)
//   4. start sweeper (25-min sweep + stale-while-revalidate refresh)
//   5. serve HTTP API
//
// Zero npm dependencies — only node built-ins.
//
// buildApp() is exported so tests can spin up the whole stack in-process.

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { buildConfig, ConfigError } = require('./lib/config');
const { Registry } = require('./lib/registry');
const { Sweeper } = require('./lib/sweeper');
const { Router, sendJson } = require('./lib/http');
const mem = require('./lib/memory');
const proc = require('./lib/process');
const { loadEnvFile } = require('./lib/envfile');

const log = (...a) => console.log(new Date().toISOString(), ...a);

function previewCommand(cmd) {
  const first = cmd.trim().split('\n')[0];
  return first.length > 120 ? first.slice(0, 120) + '…' : first;
}

/**
 * Wire the full application around a config object.
 * @param {object} cfg buildConfig() output
 * @param {{token?:string, reAdopt?:boolean}} opts
 * @returns {{server, registry, sweeper, cfg, listen(port?, host?), close()}}
 */
function buildApp(cfg, opts = {}) {
  const token = opts.token || cfg.token;
  fs.mkdirSync(cfg.logDir, { recursive: true });

  const registry = new Registry(cfg.models, log, {
    refreshMinAgeMs: cfg.refreshMinAgeMs,
    stopGraceMs: cfg.stopGraceMs,
  });
  registry.liveness = (pid) => proc.alive(pid);
  registry.rss = (pid) => proc.treeRssBytes(pid);
  registry.killer = (pid, graceMs) => proc.killPid(pid, graceMs);

  // ---- spawner wiring: spawn + readiness probe + state transitions ----
  registry.spawner = async (name, model, s) => {
    const logPath = path.join(cfg.logDir, `${name}.log`);
    const child = proc.spawnModel(model, logPath);
    registry.attach(name, child, child.pid);
    s.logPath = logPath;
    log(`[spawn] ${name}: pid=${child.pid} log=${logPath}`);

    // Readiness probe runs in the background so the start call returns fast.
    const probe = model.readyProbe || { kind: 'alive', ms: 30000 };
    (async () => {
      try {
        if (probe.kind === 'port' && model.port) {
          const ok = await proc.waitPort('127.0.0.1', model.port, probe.ms);
          if (!ok) {
            registry.markSpawnError(name, new Error(`readiness timeout: port ${model.port} not listening within ${probe.ms}ms`));
            log(`[spawn] ${name}: ${registry.get(name).lastError} — killing child`);
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            return;
          }
        } else {
          await new Promise((r) => setTimeout(r, Math.min(probe.ms, 30000)));
          if (!proc.alive(child.pid)) {
            registry.markSpawnError(name, new Error(`process died during readiness wait (${probe.ms}ms)`));
            return;
          }
        }
        registry.markRunning(name, child.pid);
        log(`[spawn] ${name}: ready (pid=${child.pid})`);
      } catch (e) {
        registry.markSpawnError(name, e);
        log(`[spawn] ${name}: probe error: ${e.message}`);
      }
    })();
  };

  // ---- /proc re-adoption: LLMs started before this API boot ----
  if (opts.reAdopt !== false) {
    const adopted = proc.findAdoptable(cfg.models);
    for (const [name, pid] of adopted) {
      registry.adopt(name, pid);
      log(`[boot] re-adopted ${name} pid=${pid} (matched "${cfg.byName[name].match}")`);
    }
  }

  const sweeper = new Sweeper(registry, cfg, log);

  const routes = [
    {
      method: 'GET',
      path: '/health',
      handler: (_c, _r, res) => sendJson(res, 200, { ok: true, service: 'llm-manager', time: new Date().toISOString() }),
    },
    {
      method: 'GET',
      path: '/models',
      handler: (_c, _r, res) => {
        const list = cfg.models.map((m) => ({
          name: m.name, label: m.label, cwd: m.cwd, port: m.port,
          expectedGpuGb: m.expectedGpuGb, expectedRamGb: m.expectedRamGb,
          readyProbe: m.readyProbe, commandPreview: previewCommand(m.command),
        }));
        sendJson(res, 200, { models: list });
      },
    },
    {
      method: 'GET',
      path: '/status',
      handler: (_c, _r, res) => {
        const out = sweeper.cachedStatus();
        sendJson(res, 200, {
          models: out.entries,
          cache: { ageMs: out.cacheAgeMs, sweepIntervalMs: cfg.sweepIntervalMs, refresh: out.refresh },
        }, {
          'X-Status-Age': String(out.cacheAgeMs ?? 0),
          'X-Status-Refresh': out.refresh,
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/status\/([\w-]+)$/,
      handler: (_c, _r, res, params) => {
        const s = registry.get(params[0]);
        if (!s) return sendJson(res, 404, { error: `unknown model "${params[0]}"` });
        const out = sweeper.cachedStatus();
        sendJson(res, 200, { model: s }, {
          'X-Status-Age': String(out.cacheAgeMs ?? 0),
          'X-Status-Refresh': out.refresh,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/start\/([\w-]+)$/,
      handler: async (_c, _r, res, params) => {
        const name = params[0];
        if (!cfg.byName[name]) return sendJson(res, 404, { error: `unknown model "${name}"` });
        const r = await registry.requestStart(name);
        const status = r.outcome === 'already-running' ? 409 : r.outcome === 'error' ? 500 : 202;
        sendJson(res, status, {
          name,
          state: r.state.state,
          outcome: r.outcome,
          message: r.message,
          pid: r.state.pid,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/stop\/([\w-]+)$/,
      handler: async (_c, _r, res, params) => {
        const name = params[0];
        if (!cfg.byName[name]) return sendJson(res, 404, { error: `unknown model "${name}"` });
        await registry.requestStop(name);
        sendJson(res, 200, { name, state: 'stopped', message: `stop requested for ${name}` });
      },
    },
    {
      method: 'GET',
      path: '/memory',
      handler: async (_c, _r, res) => {
        const report = await mem.report(registry.all(), cfg.gpuProbe);
        sendJson(res, 200, report);
      },
    },
    {
      method: 'GET',
      pattern: /^\/logs\/([\w-]+)$/,
      handler: (_c, _r, res, params, q) => {
        const name = params[0];
        if (!cfg.byName[name]) return sendJson(res, 404, { error: `unknown model "${name}"` });
        const tail = Math.min(Math.max(Number(q.tail) || 100, 1), 5000);
        const logPath = path.join(cfg.logDir, `${name}.log`);
        if (!fs.existsSync(logPath)) {
          return sendJson(res, 404, { error: 'no log file yet (model never started, or log rotated)' });
        }
        const fd = fs.openSync(logPath, 'r');
        let buf;
        try {
          const st = fs.fstatSync(fd);
          const want = 256 * 1024;
          const pos = Math.max(0, st.size - want);
          const len = Math.min(st.size - pos, want);
          buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, pos);
        } finally {
          fs.closeSync(fd);
        }
        const lines = buf.toString('utf8').split('\n');
        sendJson(res, 200, { name, logPath, tail: lines.slice(-tail).join('\n') });
      },
    },
  ];

  const router = new Router({
    routes,
    auth: { token, exempt: [(req, p) => p === '/health'] },
    logger: log,
  });

  const server = http.createServer((req, res) => router.handle(req, res, {}));

  const listen = (port = cfg.port, host = cfg.host) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve(server);
      });
    });

  return {
    server,
    registry,
    sweeper,
    cfg,
    listen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  // Secret env vars (e.g. LLM_API_TOKEN) live in a gitignored token file
  // (default <repo>/token.env, override via TOKEN_FILE) so they survive
  // host/pm2 restarts without being committed. Real env vars always win.
  loadEnvFile({ file: process.env.TOKEN_FILE, log });

  let cfg;
  try {
    cfg = buildConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`config error: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  let token = cfg.token;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    log(`[boot] no LLM_API_TOKEN set — generated ephemeral token: ${token}`);
    log('[boot] set LLM_API_TOKEN (env or ecosystem.config.js) to keep it across restarts');
  }

  const app = buildApp(cfg, { token });
  await app.listen();
  app.sweeper.start();
  log(`[boot] llm-manager listening on ${cfg.host}:${cfg.port} (token ${token ? 'set' : 'none'})`);
  log(`[boot] models: ${cfg.models.map((m) => m.name).join(', ')}`);

  // ---- graceful shutdown ----
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[shutdown] ${sig} received`);
    app.sweeper.stop();
    if (cfg.stopChildrenOnShutdown) {
      for (const [, child] of app.registry.children) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
      }
    } else {
      log('[shutdown] leaving LLM processes running (set STOP_CHILDREN_ON_SHUTDOWN=1 to stop them)');
    }
    app.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[fatal] ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = { buildApp };
