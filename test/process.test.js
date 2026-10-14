'use strict';
// test/process.test.js — liveness probes, rss, cmdline, kill, re-adoption.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { alive, rssBytes, treeRssBytes, cmdline, findAdoptable, killPid, waitPort, portOpen } = require('../lib/process');
const net = require('node:net');

test('alive(): self is alive, bogus pid is not', () => {
  assert.equal(alive(process.pid), true);
  assert.equal(alive(4194304 + 1), false, 'pid beyond range should be dead');
});

test('rssBytes(): self has positive RSS', () => {
  const b = rssBytes(process.pid);
  assert.ok(b != null && b > 0, `rss should be positive, got ${b}`);
});

test('cmdline(): self returns argv list', () => {
  const c = cmdline(process.pid);
  assert.ok(Array.isArray(c) && c.length >= 2);
  assert.equal(cmdline(4194304 + 1), null);
});

test('killPid(): kills a sleeping child after SIGTERM', async () => {
  const child = spawn('sleep', ['30']);
  await new Promise((r) => child.once('spawn', r));
  const pid = child.pid;
  const r = await killPid(pid, 2000);
  assert.equal(r.alreadyDead, false);
  // Give reaper a moment; alive() should be false or ESRCH
  assert.equal(alive(pid), false);
});

test('killPid(): already-dead pid resolves alreadyDead', async () => {
  const r = await killPid(4194304 + 1, 500);
  assert.equal(r.alreadyDead, true);
});

test('portOpen/waitPort: closed port false, open port true', async () => {
  assert.equal(await portOpen('127.0.0.1', 1), false, 'port 1 closed (or refused)');
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const port = srv.address().port;
  assert.equal(await portOpen('127.0.0.1', port), true);
  assert.equal(await waitPort('127.0.0.1', port, 2000), true);
  srv.close();
});

test('findAdoptable(): finds running process whose cmdline contains match', async () => {
  // Spawn a script whose filename (in /proc/<pid>/cmdline) contains the marker.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-test-'));
  const script = path.join(dir, 'adopt-marker-xyz123.sh');
  fs.writeFileSync(script, '#!/bin/bash\nsleep 30\n');
  fs.chmodSync(script, 0o755);

  const child = spawn(script, []);
  await new Promise((r) => child.once('spawn', r));
  let found = null;
  for (let i = 0; i < 20; i++) {
    found = findAdoptable([{ name: 'm', match: 'adopt-marker-xyz123' }]);
    if (found.has('m')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(found.has('m'), 'expected to find adopted marker process');
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('treeRssBytes(): sums RSS across the process tree', async () => {
  // bash forks sleep here (background job + wait keeps a real parent/child pair).
  const child = spawn('bash', ['-c', 'sleep 30 & wait']);
  await new Promise((r) => child.once('spawn', r));
  await new Promise((r) => setTimeout(r, 100));
  const root = rssBytes(child.pid);
  const tree = treeRssBytes(child.pid);
  assert.ok(root != null && root > 0, 'root rss');
  assert.ok(tree != null && tree >= root, `tree (${tree}) should be >= root (${root})`);
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ }
  try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ }
});

test('killPid(): kills a forked child tree (descendants go too)', async () => {
  const child = spawn('bash', ['-c', 'sleep 30 & wait']);
  await new Promise((r) => child.once('spawn', r));
  await new Promise((r) => setTimeout(r, 100));
  const kids = require('node:fs')
    .readdirSync(`/proc/${child.pid}/task`)
    .flatMap((t) => {
      try {
        return require('node:fs').readFileSync(`/proc/${child.pid}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
      } catch {
        return [];
      }
    });
  const kid = Number(kids[0]);
  assert.ok(kid > 0, 'should have a forked child');
  await killPid(child.pid, 2000);
  assert.equal(alive(child.pid), false, 'root dead');
  assert.equal(alive(kid), false, 'descendant dead');
});

test('findAdoptable(): matches via resolved cwd when cmdline has no marker (bash exec-optimisation)', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  // Simulate: a launch whose argv no longer contains the marker (bash
  // exec-optimisation) but whose working directory does.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adoptcwd-adopt-marker-cwd77-'));
  const child2 = spawn('bash', ['-c', 'echo gone-from-cmdline-marker && exec sleep 30'], { cwd: dir });
  await new Promise((r) => child2.once('spawn', r));
  let found = null;
  for (let i = 0; i < 20; i++) {
    found = findAdoptable([{ name: 'm', match: 'adopt-marker-cwd77' }]);
    if (found.has('m')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(found.has('m'), 'expected cwd match');
  assert.equal(found.get('m'), child2.pid);
  try { process.kill(child2.pid, 'SIGKILL'); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('findAdoptable(): never includes self', () => {
  const found = findAdoptable([{ name: 'm', match: process.execPath }]);
  assert.ok(!found.has('m') || found.get('m') !== process.pid);
});
