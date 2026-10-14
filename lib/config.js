'use strict';
// lib/config.js — load + validate models.json and env configuration.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

class ConfigError extends Error {}

/**
 * Expand ~/... relative to the OS home dir (catalog values only).
 */
function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function validateModel(m, i) {
  const where = `models[${i}]`;
  if (typeof m.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(m.name)) {
    throw new ConfigError(`${where}.name must match ^[a-z0-9][a-z0-9_-]{0,63}$`);
  }
  if (typeof m.command !== 'string' || !m.command.trim()) {
    throw new ConfigError(`${where}.command must be a non-empty shell string`);
  }
  if (typeof m.match !== 'string' || !m.match.trim()) {
    throw new ConfigError(`${where}.match must be a non-empty substring used to re-adopt the process from /proc`);
  }
  if (m.port != null && !(Number.isInteger(m.port) && m.port > 0 && m.port < 65536)) {
    throw new ConfigError(`${where}.port must be an integer in 1..65535`);
  }
  for (const k of ['expectedGpuGb', 'expectedRamGb']) {
    if (m[k] != null && !(typeof m[k] === 'number' && m[k] >= 0)) {
      throw new ConfigError(`${where}.${k} must be a non-negative number (GB) or null`);
    }
  }
  const probe = m.readyProbe;
  if (probe == null) {
    m.readyProbe = { kind: 'alive', ms: 30000 };
  } else {
    if (probe.kind !== 'alive' && probe.kind !== 'port') {
      throw new ConfigError(`${where}.readyProbe.kind must be 'alive' or 'port'`);
    }
    if (!(Number.isFinite(probe.ms) && probe.ms > 0)) {
      throw new ConfigError(`${where}.readyProbe.ms must be a positive number of milliseconds`);
    }
  }
  // Normalise (mutate is fine — config is loaded once at boot).
  m.cwd = expandHome(typeof m.cwd === 'string' ? m.cwd : '.');
  m.port = m.port || null;
  m.expectedGpuGb = m.expectedGpuGb == null ? null : m.expectedGpuGb;
  m.expectedRamGb = m.expectedRamGb == null ? null : m.expectedRamGb;
  m.label = typeof m.label === 'string' && m.label ? m.label : m.name;
}

function loadCatalog(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read catalog ${file}: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`catalog ${file} is not valid JSON: ${e.message}`);
  }
  if (!data || !Array.isArray(data.models) || data.models.length === 0) {
    throw new ConfigError('catalog must have a non-empty "models" array');
  }
  const names = new Set();
  data.models.forEach((m, i) => {
    validateModel(m, i);
    if (names.has(m.name)) throw new ConfigError(`duplicate model name "${m.name}"`);
    names.add(m.name);
  });
  return data.models;
}

function buildConfig() {
  const int = (name, def) => {
    const v = process.env[name];
    if (v == null || v === '') return def;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ConfigError(`env ${name} must be a number (got "${v}")`);
    return n;
  };

  const modelsFile = process.env.MODEL_DIR || path.join(__dirname, '..', 'models.json');
  const token = process.env.LLM_API_TOKEN || '';
  const host = process.env.LLM_API_HOST || '0.0.0.0';
  const port = int('LLM_API_PORT', 8790);
  if (!(port > 0 && port < 65536)) throw new ConfigError('LLM_API_PORT out of range');

  const gpu = (process.env.ENABLE_GPU_PROBE || 'auto').toLowerCase();
  if (!['auto', 'on', 'off'].includes(gpu)) throw new ConfigError('ENABLE_GPU_PROBE must be auto|on|off');

  const models = loadCatalog(modelsFile);
  return {
    host,
    port,
    token,
    modelsFile,
    logDir: process.env.LOG_DIR || path.join(__dirname, '..', 'logs'),
    sweepIntervalMs: int('SWEEP_INTERVAL_MS', 25 * 60 * 1000),
    refreshMinAgeMs: int('REFRESH_MIN_AGE_MS', 5 * 60 * 1000),
    stopGraceMs: int('STOP_GRACE_MS', 10000),
    gpuProbe: gpu,
    stopChildrenOnShutdown: process.env.STOP_CHILDREN_ON_SHUTDOWN === '1',
    models,
    byName: Object.fromEntries(models.map((m) => [m.name, m])),
  };
}

module.exports = { buildConfig, loadCatalog, expandHome, ConfigError };
