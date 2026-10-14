'use strict';
// lib/memory.js — host RAM from /proc/meminfo (pure Node, no exec),
// optional GPU via nvidia-smi (system binary, graceful when absent),
// per-model expected vs actual RSS, and a "headroom" estimate.
const fs = require('node:fs');
const { execFile } = require('node:child_process');

/** Parse /proc/meminfo into {totalGb, availableGb, usedGb, freeGb}. */
function hostMem() {
  let raw;
  try {
    raw = fs.readFileSync('/proc/meminfo', 'utf8');
  } catch {
    return null;
  }
  const fields = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z]+):\s+(\d+)\s*kB/);
    if (m) fields[m[1]] = Number(m[2]) / 1024 / 1024; // kB -> GB
  }
  if (fields.MemTotal == null) return null;
  const available = fields.MemAvailable != null ? fields.MemAvailable : (fields.MemFree || 0);
  const used = Math.max(0, fields.MemTotal - available);
  return {
    totalGb: round1(fields.MemTotal),
    availableGb: round1(available),
    usedGb: round1(used),
    freeGb: round1(fields.MemFree || 0),
  };
}

/**
 * GPU memory via nvidia-smi. Returns {available:true, gpus:[...]} or
 * {available:false, note}. `execFile` with a fixed argv (no shell) keeps
 * this injection-safe.
 */
function gpuMem(mode) {
  return new Promise((resolve) => {
    if (mode === 'off') return resolve({ available: false, note: 'gpu probe disabled' });
    const argv = ['--query-gpu=index,name,memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'];
    execFile('nvidia-smi', argv, { timeout: 5000 }, (err, stdout) => {
      if (err) {
        return resolve({ available: false, note: `nvidia-smi unavailable: ${err.message}` });
      }
      const gpus = [];
      for (const line of stdout.trim().split('\n')) {
        const parts = line.split(',').map((s) => s.trim());
        if (parts.length >= 5) {
          gpus.push({
            index: Number(parts[0]),
            name: parts[1],
            totalGb: round1(Number(parts[2]) / 1024),
            usedGb: round1(Number(parts[3]) / 1024),
            freeGb: round1(Number(parts[4]) / 1024),
          });
        }
      }
      if (!gpus.length) return resolve({ available: false, note: 'nvidia-smi returned no GPUs' });
      resolve({ available: true, gpus });
    });
  });
}

/**
 * Full memory report: host + gpu + per-model expected/actual + headroom.
 * @param {Array} entries registry.all() entries
 * @param {string} gpuMode 'auto'|'on'|'off'
 */
async function report(entries, gpuMode) {
  const host = hostMem();
  const gpu = gpuMode === 'auto' || gpuMode === 'on' ? await gpuMem(gpuMode) : { available: false, note: 'gpu probe disabled' };

  // Actual = sum of RSS of running models (adopted or spawned).
  const models = entries.map((e) => ({
    name: e.name,
    state: e.state,
    expectedGpuGb: e.expectedGpuGb,
    expectedRamGb: e.expectedRamGb,
    actualRssGb: e.rssGb,
  }));
  const actualUsedGb = round1(models.reduce((a, m) => a + (m.actualRssGb || 0), 0));
  const expectedTotalGb = round1(models.reduce((a, m) => a + (m.expectedRamGb || 0), 0));

  // Headroom: how much more RAM could still fit, given declared expectations.
  let headroom = null;
  if (host) {
    const remainingDeclared = expectedTotalGb - actualUsedGb;
    headroom = {
      note: 'Available host RAM minus declared expectations of models not yet running (best-effort; GPU VRAM is separate).',
      availableGb: host.availableGb,
      actualUsedGb,
      expectedRemainingGb: round1(Math.max(0, remainingDeclared)),
      estFitsGb: round1(Math.max(0, host.availableGb - Math.max(0, remainingDeclared))),
    };
  }

  return { host, gpu, models, headroom };
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

module.exports = { hostMem, gpuMem, report };
