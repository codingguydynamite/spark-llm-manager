'use strict';
// lib/http.js — tiny zero-dependency router: JSON body parse, bearer auth,
// route table. No state access here; ctx methods do the work.
const http = require('node:http');

function parseBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

class Router {
  /**
   * routes: array of {method, path (string | null), pattern (RegExp), match, handler}
   * handler(ctx, req, res, params)
   */
  constructor({ routes, auth, logger }) {
    this.routes = routes;
    this.auth = auth; // { token: string|null, exempt: [predicates] }
    this.log = logger || (() => {});
  }

  authOk(req, pathname) {
    if (!this.auth.token) return true;
    for (const ex of this.auth.exempt || []) if (ex(req, pathname)) return true;
    const h = req.headers['authorization'] || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    try {
      return require('node:crypto').timingSafeEqual(Buffer.from(m[1]), Buffer.from(this.auth.token));
    } catch {
      return false;
    }
  }

  async handle(req, res, ctx) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    let params = null;
    let handler = null;
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      if (r.pattern) {
        const m = pathname.match(r.pattern);
        if (!m) continue;
        params = m.slice(1);
        handler = r.handler;
        break;
      }
      if (pathname === r.path) {
        handler = r.handler;
        break;
      }
    }
    if (!handler) {
      return sendJson(res, 404, { error: 'not found', path: pathname });
    }
    if (!this.authOk(req, pathname)) {
      return sendJson(res, 401, { error: 'unauthorized', hint: 'Authorization: Bearer <token>' });
    }

    let body = null;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      try {
        body = await parseBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    const q = Object.fromEntries(url.searchParams.entries());
    try {
      await handler(ctx, req, res, params, q, body);
    } catch (e) {
      this.log(`[http] ${req.method} ${pathname} error: ${e.message}`);
      sendJson(res, 500, { error: e.message });
    }
  }
}

module.exports = { Router, sendJson };
