'use strict';
// lib/envfile.js — minimal env-file loader for the API bearer token.
//
// Motivation: the token has to survive pm2/host restarts, but ecosystem's
// `env` block must stay secret-free (it's committed to git). The token lives
// in a gitignored file (default: <repo>/token.env, override with TOKEN_FILE)
// in plain `KEY=VALUE` lines. Only values that are not already set in
// process.env are applied, so real env vars always win.

const fs = require('node:fs');
const path = require('node:path');

/** Default token file location: <repo root>/token.env */
function defaultTokenFile() {
  return path.join(__dirname, '..', 'token.env');
}

/**
 * Parse a `KEY=VALUE` env file.
 * - `#` comments (whole-line) and blank lines are skipped.
 * - Values may be wrapped in single or double quotes.
 * - `export KEY=VALUE` prefix is tolerated.
 * - No interpolation: values are taken literally.
 * @returns {{keys: string[], get: (k: string) => string|undefined}}
 */
function parseEnvFile(text) {
  const map = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    let m;
    if ((m = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/))) {
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      map.set(m[1], value);
    } else if ((m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/))) {
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      map.set(m[1], value);
    }
    // Malformed lines are ignored (not secrets material — keep it simple).
  }
  return {
    get: (k) => (map.has(k) ? map.get(k) : undefined),
    keys: [...map.keys()],
  };
}

/**
 * Load an env file into `process.env`.
 * Existing env vars are NEVER overwritten (real env wins over file).
 * @param {{file?: string, env?: object, log?: Function}} [opts]
 * @returns {string[]} names of variables that were read from the file.
 */
function loadEnvFile({ file = defaultTokenFile(), env = process.env, log = () => {} } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // no file => nothing to load; caller falls back to defaults
  }
  const parsed = parseEnvFile(raw);
  const applied = [];
  for (const key of parsed.keys) {
    if (env[key] == null || env[key] === '') {
      env[key] = parsed.get(key);
      applied.push(key);
    }
  }
  if (applied.length) log(`[envfile] loaded ${applied.join(', ')} from ${file}`);
  return applied;
}

module.exports = { defaultTokenFile, parseEnvFile, loadEnvFile };
