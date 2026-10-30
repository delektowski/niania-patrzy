#!/usr/bin/env node
'use strict';

/* ------------------------------------------------------------------ *
 * PeerCast signaling relay.
 *
 * WebRTC cannot describe a connection in ten characters, so the two
 * session descriptions (offer/answer) are parked here for a few minutes
 * instead of being pasted around. Only the handshake passes through
 * this process; audio/video is peer-to-peer.
 *
 * A session is identified by a 6-digit code such as "482913". Codes are
 * single-viewer, expire after 10 minutes and are throttled per IP and globally
 * so the small keyspace cannot be enumerated.
 *
 * Endpoints (all JSON, all under /api):
 *   POST   /api/session                 { name, sdp }  -> { code, expiresAt }
 *   GET    /api/session/:code                          -> { name, sdp }
 *   POST   /api/session/:code/answer    { sdp }        -> { ok: true }
 *   GET    /api/session/:code/answer?wait=25           -> { sdp } | 204
 *   DELETE /api/session/:code
 *   GET    /api/health
 *
 * Set STATIC_DIR to also serve the app itself (handy for local dev and
 * for the e2e test); in production Caddy serves the files and proxies
 * /api/* here.
 * ------------------------------------------------------------------ */

import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const TTL_MS = Number(process.env.SESSION_TTL_MS || 10 * 60 * 1000);
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 500);
const STATIC_DIR = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : null;

const MAX_BODY = 64 * 1024;
const MAX_WAIT_MS = 25_000;

/* ------------------------------- code format ------------------------------ */

// Six digits, 100000-999999: easy to read out loud, type on a phone or paste.
// The keyspace is small, so the relay leans on a short TTL, per-IP limits and a
// global ceiling on wrong guesses instead of on the length of the code.
const CODE_LENGTH = 6;
const CODE_MIN = 10 ** (CODE_LENGTH - 1);
const CODE_MAX = 10 ** CODE_LENGTH;
const CODE_RE = new RegExp(`^\\d{${CODE_LENGTH}}$`);

/** Lookup key: digits only, ignoring the spaces/dashes people type along the way. */
const canon = (code) => String(code || '').replace(/\D+/g, '');
const isCode = (code) => CODE_RE.test(code);

function makeCode() {
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const code = String(randomInt(CODE_MIN, CODE_MAX));
    if (!sessions.has(code)) return { code, key: code };
  }
  throw new Error('could not allocate an unused code');
}

/* -------------------------------- sessions ------------------------------- */

/** key -> { code, name, offer, answer, createdAt, expiresAt, waiters:Set } */
const sessions = new Map();

function purgeExpired(now = Date.now()) {
  for (const [key, session] of sessions) {
    if (session.expiresAt > now) continue;
    flushWaiters(session, 410, 'this code expired');
    sessions.delete(key);
  }
}

function sessionByCode(code) {
  const key = canon(code);
  if (!isCode(key)) return null;
  const session = sessions.get(key) || null;
  if (session && session.expiresAt <= Date.now()) {
    flushWaiters(session, 410, 'this code expired');
    sessions.delete(key);
    return null;
  }
  return session;
}

function flushWaiters(session, status, message) {
  for (const waiter of session.waiters) {
    clearTimeout(waiter.timer);
    if (status === 200) json(waiter.res, 200, { sdp: session.answer });
    else json(waiter.res, status, { error: message });
  }
  session.waiters.clear();
}

/* --------------------------------- helpers ------------------------------- */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const fail = (res, status, error) => json(res, status, { error });

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('body is not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/** Wrong guesses are cheap, so they are capped globally as well as per IP. */
const wrongCodes = [];

function noteWrongCode() {
  const now = Date.now();
  wrongCodes.push(now);
  while (wrongCodes.length && wrongCodes[0] < now - 60_000) wrongCodes.shift();
  return wrongCodes.length;
}

/** Coarse per-IP limit so codes cannot be brute-forced in bulk. */
const buckets = new Map();

function rateLimited(req, name, limit, windowMs = 60_000) {
  const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?');
  const key = `${name}:${ip}`;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count > limit;
}

/* -------------------------------- routing -------------------------------- */

async function handleApi(req, res, url, parts) {
  // parts: ['api', 'session', ':code', 'answer']

  if (parts.length === 2 && parts[1] === 'health') {
    return json(res, 200, { ok: true, sessions: sessions.size });
  }

  if (parts[1] !== 'session') return fail(res, 404, 'unknown endpoint');

  /* --- create a session (broadcaster) --- */
  if (parts.length === 2) {
    if (req.method !== 'POST') return fail(res, 405, 'use POST');
    if (rateLimited(req, 'create', 12)) {
      return fail(res, 429, 'too many broadcasts from this address, wait a minute');
    }

    const body = await readJson(req);
    const sdp = typeof body.sdp === 'string' ? body.sdp : '';
    if (!sdp.includes('v=')) return fail(res, 400, 'missing session description');

    purgeExpired();
    if (sessions.size >= MAX_SESSIONS) {
      return fail(res, 503, 'the relay is busy, try again in a minute');
    }

    const { code, key } = makeCode();
    const now = Date.now();
    sessions.set(key, {
      key,
      code,
      name: typeof body.name === 'string' ? body.name.slice(0, 60) : '',
      offer: sdp,
      answer: null,
      createdAt: now,
      expiresAt: now + TTL_MS,
      waiters: new Set(),
    });

    return json(res, 201, { code, expiresAt: now + TTL_MS, ttl: TTL_MS });
  }

  /* --- everything below needs an existing code --- */
  const action = parts[3];

  // Limit guesses *before* looking anything up, otherwise a wrong code would
  // never be counted against the per-IP budget.
  if (req.method === 'GET' && !action && rateLimited(req, 'lookup', 20)) {
    return fail(res, 429, 'too many attempts, wait a minute');
  }

  const session = sessionByCode(decodeURIComponent(parts[2] || ''));

  if (!session) {
    if (noteWrongCode() > 300) {
      return fail(res, 429, 'too many wrong codes right now — wait a minute');
    }
    return fail(res, 404, 'no stream with that code — check it or ask for a fresh one');
  }

  if (parts.length > 4) return fail(res, 404, 'unknown endpoint');

  /* --- answer slot --- */
  if (action === 'answer') {
    if (req.method === 'POST') {
      if (rateLimited(req, 'answer', 30)) {
        return fail(res, 429, 'too many attempts, wait a minute');
      }
      const body = await readJson(req);
      const sdp = typeof body.sdp === 'string' ? body.sdp : '';
      if (!sdp.includes('v=')) return fail(res, 400, 'missing session description');
      if (session.answer) return fail(res, 409, 'this stream already has a viewer');

      session.answer = sdp;
      flushWaiters(session, 200);
      return json(res, 200, { ok: true, name: session.name });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (session.answer) return json(res, 200, { sdp: session.answer });

      const requested = Number(url.searchParams.get('wait') || 0) * 1000;
      const waitMs = Math.max(0, Math.min(Number.isFinite(requested) ? requested : 0, MAX_WAIT_MS));

      if (!waitMs) {
        res.writeHead(204, { 'cache-control': 'no-store' });
        return res.end();
      }

      // long poll: answer as soon as the viewer posts one
      const waiter = { res, timer: null };
      waiter.timer = setTimeout(() => {
        session.waiters.delete(waiter);
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
      }, waitMs);
      session.waiters.add(waiter);
      res.on('close', () => {
        clearTimeout(waiter.timer);
        session.waiters.delete(waiter);
      });
      return undefined;
    }

    return fail(res, 405, 'use GET or POST');
  }

  if (action) return fail(res, 404, 'unknown endpoint');

  /* --- session itself --- */
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (session.answer) return fail(res, 409, 'this stream already has a viewer');
    return json(res, 200, { name: session.name, sdp: session.offer, expiresAt: session.expiresAt });
  }

  if (req.method === 'DELETE') {
    sessions.delete(session.key);
    flushWaiters(session, 410, 'the broadcaster ended the stream');
    res.writeHead(204, { 'cache-control': 'no-store' });
    return res.end();
  }

  return fail(res, 405, 'use GET or DELETE');
}

/* --------------------------- optional static files ------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

async function serveStatic(res, pathname) {
  let file = join(STATIC_DIR, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (pathname === '/' || pathname === '') file = join(STATIC_DIR, 'index.html');
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

/* --------------------------------- server -------------------------------- */

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  const handler = parts[0] === 'api'
    ? handleApi(req, res, url, parts)
    : STATIC_DIR
      ? serveStatic(res, decodeURIComponent(url.pathname))
      : Promise.resolve(fail(res, 404, 'only /api is served here'));

  Promise.resolve(handler).catch((err) => {
    if (res.headersSent) return;
    fail(res, err.status || 500, err.message || 'internal error');
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use`);
    process.exit(1);
  }
  throw err;
});

const sweeper = setInterval(() => {
  purgeExpired();
  const now = Date.now();
  if (buckets.size > 5000) {
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 30_000);
sweeper.unref();

server.listen(PORT, HOST, () => {
  const ttl = Math.round(TTL_MS / 1000);
  console.log(
    `peercast relay on http://${HOST}:${PORT}` +
      `${STATIC_DIR ? ` (serving ${STATIC_DIR})` : ''} — codes expire after ${ttl}s`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const session of sessions.values()) flushWaiters(session, 410, 'relay shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
