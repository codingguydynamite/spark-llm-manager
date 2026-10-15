'use strict';
// test/envfile.test.js — env-file parser + load semantics.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseEnvFile, loadEnvFile, defaultTokenFile } = require('../lib/envfile');

test('parseEnvFile: comments, blanks, export prefix, quotes', () => {
  const text = [
    '# a comment',
    '',
    'LLM_API_TOKEN=plain-value',
    'export SWEEP_INTERVAL_MS="1500000"',
    "STOP_GRACE_MS='10000'",
    'LLM_API_HOST=0.0.0.0',
    'malformed line without equals',
    'EMPTY=',
  ].join('\n');
  const p = parseEnvFile(text);
  assert.equal(p.get('LLM_API_TOKEN'), 'plain-value');
  assert.equal(p.get('SWEEP_INTERVAL_MS'), '1500000');
  assert.equal(p.get('STOP_GRACE_MS'), '10000');
  assert.equal(p.get('LLM_API_HOST'), '0.0.0.0');
  assert.equal(p.get('EMPTY'), '');
  assert.equal(p.get('NOSUCH'), undefined);
  assert.ok(!p.keys.includes('malformed'));
});

test('parseEnvFile: single-char quoted values stay quoted', () => {
  // A lone quote character is not a valid quoted value.
  const p = parseEnvFile("TOKEN='");
  assert.equal(p.get('TOKEN'), "'");
});

test('loadEnvFile: missing file is a no-op', () => {
  const env = {};
  const applied = loadEnvFile({ file: '/nonexistent/no-such-file.env', env, log: () => {} });
  assert.deepEqual(applied, []);
  assert.deepEqual(env, {});
});

test('loadEnvFile: applies file values when env is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-mgr-envfile-'));
  const file = path.join(dir, 'token.env');
  fs.writeFileSync(file, 'LLM_API_TOKEN=from-file\n# c\nSWEEP_INTERVAL_MS="1500000"\n');
  const env = {};
  const applied = loadEnvFile({ file, env });
  assert.deepEqual(applied.sort(), ['LLM_API_TOKEN', 'SWEEP_INTERVAL_MS']);
  assert.equal(env.LLM_API_TOKEN, 'from-file');
  assert.equal(env.SWEEP_INTERVAL_MS, '1500000');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadEnvFile: real env always wins over the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-mgr-envfile-'));
  const file = path.join(dir, 'token.env');
  fs.writeFileSync(file, 'LLM_API_TOKEN=from-file\n');
  const env = { LLM_API_TOKEN: 'from-env' };
  const applied = loadEnvFile({ file, env });
  assert.deepEqual(applied, []);
  assert.equal(env.LLM_API_TOKEN, 'from-env');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadEnvFile: empty-string env var is treated as unset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-mgr-envfile-'));
  const file = path.join(dir, 'token.env');
  fs.writeFileSync(file, 'LLM_API_TOKEN=from-file\n');
  const env = { LLM_API_TOKEN: '' };
  const applied = loadEnvFile({ file, env });
  assert.deepEqual(applied, ['LLM_API_TOKEN']);
  assert.equal(env.LLM_API_TOKEN, 'from-file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('defaultTokenFile points at <repo>/token.env', () => {
  assert.ok(defaultTokenFile().endsWith(path.join('llm-manager', 'token.env')) ||
    /token\.env$/.test(defaultTokenFile()));
});
