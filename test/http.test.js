'use strict';
// test/http.test.js — auth + idempotent start semantics + full API flow.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildApp } = require('../server');

function testConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-mgr-test-'));
  const models = [
    {
      name: 'dummy', label: 'dummy', cwd: dir,
      command: `exec sleep 30`,
      port: null,
      match: 'sleep 30',
      expectedGpuGb: null, expectedRamGb: null,
      readyProbe: { kind: 'alive', ms: 300 },
    },
  ];
  return {
    host: '127.0.0.1', port: 0, token: 'test-token-123',
    modelsFile: path.join(dir, 'models.json'),
    logDir: path.join(dir, 'logs'),
    sweepIntervalMs: 60 * 60 * 1000,
    refreshMinAgeMs: 60 * 1000,
    stopGraceMs: 1500,
    gpuProbe: 'off',
    stopChildrenOnShutdown: false,
    models,
    byName: Object.fromEntries(models.map((m) => [m.name, m])),
    _tmpDir: dir,
  };
}

async function withApp(fn) {
  const cfg = testConfig();
  const app = buildApp(cfg, { token: cfg.token, reAdopt: false });
  await app.listen(0, '127.0.0.1');
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const get = async (p, opts = {}) => {
    const r = await fetch(base + p, { headers: { authorization: `Bearer ${cfg.token}` }, ...opts });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  try {
    await fn(get, app, cfg, port);
  } finally {
    await app.close();
    try { fs.rmSync(cfg._tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('auth: /health open, everything else requires token', async () => {
  await withApp(async (get, app) => {
    const port = app.server.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(r.status, 200);
    const bad = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(bad.status, 401);
    const body = await bad.json();
    assert.match(body.error, /unauthorized/i);
  });
});

test('GET /models returns catalog', async () => {
  await withApp(async (get) => {
    const { status, body } = await get('/models');
    assert.equal(status, 200);
    assert.equal(body.models.length, 1);
    assert.equal(body.models[0].name, 'dummy');
  });
});

test('GET /status returns all models stopped initially, with cache headers', async () => {
  await withApp(async (get) => {
    const { status, body, headers } = await get('/status');
    assert.equal(status, 200);
    assert.equal(body.models.length, 1);
    assert.equal(body.models[0].state, 'stopped');
    assert.ok(headers.get('x-status-age') != null);
    assert.ok(['fresh', 'stale', 'in-progress'].includes(headers.get('x-status-refresh')));
  });
});

test('POST /start idempotency: 10 parallel -> 1 spawn; after running -> 409', async () => {
  await withApp(async (get, app) => {
    const starts = await Promise.all(
      Array.from({ length: 10 }, () => get('/start/dummy', { method: 'POST' }))
    );
    const ok = starts.filter((s) => s.status === 202 && s.body.outcome === 'started');
    const inProgress = starts.filter((s) => s.body.outcome === 'in-progress');
    assert.equal(ok.length, 1, `expected exactly one started, got ${JSON.stringify(starts.map((s) => s.body.outcome))}`);
    assert.equal(inProgress.length, 9);

    // Wait for the alive-probe (300ms) to mark it running.
    await new Promise((r) => setTimeout(r, 1200));
    const st = await get('/status/dummy');
    assert.equal(st.body.model.state, 'running');
    assert.ok(st.body.model.pid > 0);

    const again = await get('/start/dummy', { method: 'POST' });
    assert.equal(again.status, 409);
    assert.equal(again.body.outcome, 'already-running');
    assert.equal(again.body.message, 'LLM already running');
  });
});

test('POST /stop stops the model; repeat start works', async () => {
  await withApp(async (get) => {
    await get('/start/dummy', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 800));
    const stop = await get('/stop/dummy', { method: 'POST' });
    assert.equal(stop.status, 200);
    await new Promise((r) => setTimeout(r, 500));
    const st = await get('/status/dummy');
    assert.equal(st.body.model.state, 'stopped');

    const again = await get('/start/dummy', { method: 'POST' });
    assert.equal(again.status, 202);
    await new Promise((r) => setTimeout(r, 800));
    const st2 = await get('/status/dummy');
    assert.equal(st2.body.model.state, 'running');
  });
});

test('POST /start|/stop unknown model -> 404', async () => {
  await withApp(async (get) => {
    assert.equal((await get('/start/nope', { method: 'POST' })).status, 404);
    assert.equal((await get('/stop/nope', { method: 'POST' })).status, 404);
    assert.equal((await get('/status/nope')).status, 404);
  });
});

test('GET /memory returns host + models, no crash without GPU', async () => {
  await withApp(async (get) => {
    const { status, body } = await get('/memory');
    assert.equal(status, 200);
    assert.ok(body.host.totalGb > 0);
    assert.ok(body.host.availableGb > 0);
    assert.ok(Array.isArray(body.models));
    assert.equal(body.models.length, 1);
    assert.equal(body.gpu.available, false);
  });
});

test('GET /logs unknown -> 404; /logs/dummy after start has tail', async () => {
  await withApp(async (get, app, cfg) => {
    assert.equal((await get('/logs/dummy')).status, 404);
    // spawn writes to log file; dummy command is `exec sleep 30` (no output)
    // but the file must exist after start -> tail may be empty, status 200
    await get('/start/dummy', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 400));
    const r = await get('/logs/dummy?tail=5');
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.tail, 'string');
  });
});

test('GET /status/<name> after out-of-band kill flips to stopped on next sweep', async () => {
  await withApp(async (get, app) => {
    await get('/start/dummy', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 800));
    // kill out of band
    const s = app.registry.get('dummy');
    try { process.kill(s.pid, 'SIGKILL'); } catch { /* ignore */ }
    await app.registry.sweep(); // force refresh
    const st = await get('/status/dummy');
    assert.equal(st.body.model.state, 'stopped');
    assert.match(st.body.model.lastError || 'detected', /exited|detected/i);
  });
});
