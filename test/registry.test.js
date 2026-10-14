'use strict';
// test/registry.test.js — state machine + single-flight start lock.
const test = require('node:test');
const assert = require('node:assert');
const { Registry } = require('../lib/registry');

function makeRegistry(name = 'm1') {
  const models = [{ name, label: name, cwd: '.', match: 'match-' + name, port: null, readyProbe: { kind: 'alive', ms: 100 } }];
  return new Registry(models, () => {});
}

test('concurrent start requests: exactly one spawn, rest get in-progress', async () => {
  const reg = makeRegistry();
  let spawns = 0;
  reg.spawner = async () => {
    spawns += 1;
    reg.attach('m1', { pid: 12345, on() {}, kill() {} }, 12345);
  };
  reg.liveness = () => true;
  reg.rss = () => 1024;

  const results = await Promise.all([
    reg.requestStart('m1'),
    reg.requestStart('m1'),
    reg.requestStart('m1'),
    reg.requestStart('m1'),
    reg.requestStart('m1'),
  ]);
  assert.equal(spawns, 1, 'only one spawn should happen');
  assert.equal(results.filter((r) => r.outcome === 'started').length, 1);
  assert.equal(results.filter((r) => r.outcome === 'in-progress').length, 4);
});

test('start while running -> already-running, no spawn', async () => {
  const reg = makeRegistry();
  reg.spawner = async () => { reg.attach('m1', { pid: 999, on() {}, kill() {} }, 999); };
  await reg.requestStart('m1');
  reg.markRunning('m1', 999);
  const r = await reg.requestStart('m1');
  assert.equal(r.outcome, 'already-running');
  assert.equal(r.message, 'LLM already running');
  assert.equal(r.state.state, 'running');
});

test('dead pid detected by sweep -> stopped', async () => {
  const reg = makeRegistry();
  reg.spawner = async () => { reg.attach('m1', { pid: 99999999, on() {}, kill() {} }, 99999999); };
  await reg.requestStart('m1');
  reg.markRunning('m1', 99999999);
  reg.liveness = () => false;
  reg.rss = () => null;
  await reg.sweep();
  const s = reg.get('m1');
  assert.equal(s.state, 'stopped');
  assert.equal(s.pid, null);
});

test('alive pid keeps running with rss in cache', async () => {
  const reg = makeRegistry();
  reg.spawner = async () => { reg.attach('m1', { pid: 1, on() {}, kill() {} }, 1); };
  await reg.requestStart('m1');
  reg.markRunning('m1', 1);
  reg.liveness = () => true;
  reg.rss = () => 2 * 1024 ** 3; // 2 GiB
  await reg.sweep();
  const s = reg.get('m1');
  assert.equal(s.state, 'running');
  assert.equal(s.rssGb, 2);
});

test('stop clears state and calls killer', async () => {
  const reg = makeRegistry();
  let killed = null;
  reg.spawner = async () => { reg.attach('m1', { pid: 42, on() {}, kill() {} }, 42); };
  reg.killer = async (pid, grace) => { killed = { pid, grace }; };
  reg.markRunning('m1', 42);
  const r = await reg.requestStop('m1');
  assert.equal(r.outcome, 'stopped');
  assert.deepEqual(killed, { pid: 42, grace: reg.stopGraceMs });
  assert.equal(reg.get('m1').state, 'stopped');
});

test('unknown model -> reject / null', async () => {
  const reg = makeRegistry();
  await assert.rejects(() => reg.requestStart('nope'));
  assert.equal(reg.get('nope'), null);
});

test('cache stale detection + single-flight sweep', async () => {
  const reg = new Registry([{ name: 'm1', label: 'x', cwd: '.', match: 'x', readyProbe: { kind: 'alive', ms: 10 } }], () => {}, { refreshMinAgeMs: 0 });
  reg.liveness = () => false;
  reg.rss = () => null;
  // m1 has no pid -> sweep is a no-op but still stamps the cache.
  const p1 = reg.sweep();
  const p2 = reg.sweep();
  assert.equal(p1, p2, 'sweep must be single-flight');
  await p1;
  assert.ok(reg.cache.at > 0);
  // refreshMinAgeMs = 0 -> any elapsed age is stale.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(reg.isCacheStale(), true, 'minAge 0 -> always stale');
});

test('adopt marks running with pid', () => {
  const reg = makeRegistry();
  reg.adopt('m1', 777);
  const s = reg.get('m1');
  assert.equal(s.state, 'running');
  assert.equal(s.pid, 777);
});
