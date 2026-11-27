// Bill Generator reference sync server.
// Node.js 20+, no dependencies. Stores data as JSON files on disk.
// See server/README.md.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const NAME = 'bill-generator-sync';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || './data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION === '1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_BODY_BYTES = 50 * 1024 * 1024;
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const STORES = new Set(['templates', 'bills', 'kv']);
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1024;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_FAILS = 10;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- File helpers ----------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fs.rename(tmp, file);
}

// Serialise work per key so concurrent requests cannot corrupt a file.
const queues = new Map();
function withLock(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

// ---------- Accounts ----------
// accounts.json: { users: { [id]: { id, username, salt, hash, createdAt, tokens: [{ hash, expiresAt }] } } }

async function loadAccounts() {
  const data = await readJson(ACCOUNTS_FILE, null);
  return data && data.users ? data : { users: {} };
}

function saveAccounts(accounts) {
  return writeJsonAtomic(ACCOUNTS_FILE, accounts);
}

function findByUsername(accounts, username) {
  const lower = username.toLowerCase();
  return Object.values(accounts.users).find((u) => u.username === lower) || null;
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return { salt: salt.toString('hex'), hash: key.toString('hex') };
}

async function verifyPassword(password, user) {
  const key = await scrypt(password, Buffer.from(user.salt, 'hex'));
  const expected = Buffer.from(user.hash, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function issueToken(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  user.tokens = (user.tokens || []).filter((t) => t.expiresAt > now);
  user.tokens.push({ hash: sha256(token), expiresAt: now + TOKEN_TTL_MS });
  return token;
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

async function registrationOpen() {
  if (ALLOW_REGISTRATION) return true;
  const accounts = await loadAccounts();
  return Object.keys(accounts.users).length === 0;
}

function getBearer(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

async function authenticate(req) {
  const token = getBearer(req);
  if (!token) throw new HttpError(401, 'Not signed in');
  const tokenHash = sha256(token);
  const accounts = await loadAccounts();
  const now = Date.now();
  for (const user of Object.values(accounts.users)) {
    const t = (user.tokens || []).find((x) => x.hash === tokenHash);
    if (t) {
      if (t.expiresAt <= now) throw new HttpError(401, 'Session expired');
      return { user, tokenHash };
    }
  }
  throw new HttpError(401, 'Invalid or expired token');
}

// ---------- Login rate limiting (in memory) ----------

const failures = new Map(); // key -> [timestamps]

function rateKey(req, username) {
  return `${clientIp(req)}|${String(username || '').toLowerCase()}`;
}

function recentFailures(key) {
  const now = Date.now();
  const list = (failures.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

function recordFailure(key) {
  const list = recentFailures(key);
  list.push(Date.now());
  failures.set(key, list);
}

setInterval(() => {
  for (const key of failures.keys()) recentFailures(key);
}, RATE_WINDOW_MS).unref();

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

// ---------- Request helpers ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, 'Request body too large'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, 'Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        const value = JSON.parse(text);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return reject(new HttpError(400, 'Body must be a JSON object'));
        }
        resolve(value);
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const headers = { Vary: 'Origin' };
  if (ALLOWED_ORIGINS.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function send(res, status, body, extraHeaders = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function validateCredentials(body) {
  const { username, password } = body;
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Username must be 3 to 32 characters: letters, numbers, _ . -');
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new HttpError(400, `Password must be at least ${MIN_PASSWORD} characters`);
  }
  return { username, password };
}

// ---------- Route handlers ----------

async function handleHealth() {
  return { ok: true, name: NAME, version: VERSION, registrationOpen: await registrationOpen() };
}

async function handleRegister(req) {
  const { username, password } = validateCredentials(await readBody(req));
  const { salt, hash } = await hashPassword(password);
  return withLock('accounts', async () => {
    const accounts = await loadAccounts();
    const open = ALLOW_REGISTRATION || Object.keys(accounts.users).length === 0;
    if (!open) throw new HttpError(403, 'Registration is closed on this server');
    if (findByUsername(accounts, username)) throw new HttpError(409, 'Username is already taken');
    const user = {
      id: crypto.randomUUID(),
      username: username.toLowerCase(),
      salt,
      hash,
      createdAt: Date.now(),
      tokens: [],
    };
    const token = issueToken(user);
    accounts.users[user.id] = user;
    await saveAccounts(accounts);
    return { status: 201, body: { token, user: publicUser(user) } };
  });
}

async function handleLogin(req) {
  const body = await readBody(req);
  const key = rateKey(req, body.username);
  if (recentFailures(key).length >= RATE_MAX_FAILS) {
    throw new HttpError(429, 'Too many failed attempts. Try again later.');
  }
  if (typeof body.username !== 'string' || typeof body.password !== 'string' || body.password.length > MAX_PASSWORD) {
    recordFailure(key);
    throw new HttpError(401, 'Wrong username or password');
  }
  const accounts = await loadAccounts();
  const user = findByUsername(accounts, body.username);
  // Run scrypt even when the user does not exist, to keep timing similar.
  const ok = user
    ? await verifyPassword(body.password, user)
    : (await scrypt(body.password, crypto.randomBytes(16)), false);
  if (!ok) {
    recordFailure(key);
    throw new HttpError(401, 'Wrong username or password');
  }
  failures.delete(key);
  return withLock('accounts', async () => {
    const fresh = await loadAccounts();
    const u = fresh.users[user.id];
    if (!u) throw new HttpError(401, 'Wrong username or password');
    const token = issueToken(u);
    await saveAccounts(fresh);
    return { token, user: publicUser(u) };
  });
}

async function handleLogout(req) {
  const { user, tokenHash } = await authenticate(req);
  await withLock('accounts', async () => {
    const accounts = await loadAccounts();
    const u = accounts.users[user.id];
    if (u) {
      u.tokens = (u.tokens || []).filter((t) => t.hash !== tokenHash);
      await saveAccounts(accounts);
    }
  });
  return { ok: true };
}

async function handleMe(req) {
  const { user } = await authenticate(req);
  return { user: publicUser(user) };
}

function validateChange(change, index) {
  const where = `changes[${index}]`;
  if (!change || typeof change !== 'object') throw new HttpError(400, `${where} must be an object`);
  if (!STORES.has(change.store)) throw new HttpError(400, `${where}.store must be templates, bills or kv`);
  if (typeof change.id !== 'string' || !change.id || change.id.length > 200) {
    throw new HttpError(400, `${where}.id must be a string of 1 to 200 characters`);
  }
  if (typeof change.updatedAt !== 'number' || !Number.isFinite(change.updatedAt)) {
    throw new HttpError(400, `${where}.updatedAt must be a number`);
  }
  const deleted = change.deleted === true;
  return {
    store: change.store,
    id: change.id,
    updatedAt: change.updatedAt,
    deleted,
    data: deleted ? null : change.data === undefined ? null : change.data,
  };
}

async function handleSync(req) {
  const { user } = await authenticate(req);
  const body = await readBody(req);
  const since = body.since === undefined ? 0 : body.since;
  if (typeof since !== 'number' || !Number.isFinite(since) || since < 0) {
    throw new HttpError(400, 'since must be a non-negative number');
  }
  const rawChanges = body.changes === undefined ? [] : body.changes;
  if (!Array.isArray(rawChanges)) throw new HttpError(400, 'changes must be an array');
  const changes = rawChanges.map(validateChange);

  const file = path.join(USERS_DIR, `${user.id}.json`);
  return withLock(`user:${user.id}`, async () => {
    const state = await readJson(file, { rev: 0, records: {} });
    let modified = false;
    const rejected = new Set();
    for (const c of changes) {
      const key = `${c.store}/${c.id}`;
      const existing = state.records[key];
      if (!existing || c.updatedAt >= existing.updatedAt) {
        state.rev += 1;
        state.records[key] = { ...c, rev: state.rev };
        modified = true;
        rejected.delete(key);
      } else {
        rejected.add(key);
      }
    }
    if (modified) await writeJsonAtomic(file, state);
    // Changes since the client's revision, plus the newer server copy of every change that
    // lost (older updatedAt). Without those, a client whose push lost would keep its own
    // version forever, because the winning record may be older than `since`.
    const outRecords = Object.values(state.records).filter((r) => r.rev > since);
    for (const key of rejected) if (state.records[key].rev <= since) outRecords.push(state.records[key]);
    const out = outRecords
      .sort((a, b) => a.rev - b.rev)
      .map(({ store, id, updatedAt, deleted, data }) => ({ store, id, updatedAt, deleted, data }));
    return { rev: state.rev, changes: out };
  });
}

const routes = {
  'GET /api/health': handleHealth,
  'POST /api/register': handleRegister,
  'POST /api/login': handleLogin,
  'POST /api/logout': handleLogout,
  'GET /api/me': handleMe,
  'POST /api/sync': handleSync,
};

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const cors = corsHeaders(req);
  let status = 500;

  try {
    if (req.method === 'OPTIONS') {
      const headers = {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '600',
      };
      if (req.headers['access-control-request-private-network'] === 'true') {
        headers['Access-Control-Allow-Private-Network'] = 'true';
      }
      status = 204;
      res.writeHead(204, headers);
      res.end();
      return;
    }

    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) {
      const known = Object.keys(routes).some((r) => r.split(' ')[1] === pathname);
      throw new HttpError(known ? 405 : 404, known ? 'Method not allowed' : 'Not found');
    }
    const result = await handler(req);
    if (result && typeof result.status === 'number' && result.body) {
      status = result.status;
      send(res, status, result.body, cors);
    } else {
      status = 200;
      send(res, status, result, cors);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      status = err.status;
      send(res, status, { error: err.message }, cors);
    } else {
      status = 500;
      console.error('Internal error:', err && err.stack ? err.stack : err);
      if (!res.headersSent) send(res, 500, { error: 'Internal server error' }, cors);
      else res.end();
    }
  } finally {
    console.log(`${new Date().toISOString()} ${req.method} ${pathname} ${status} ${Date.now() - started}ms`);
  }
});

await fs.mkdir(USERS_DIR, { recursive: true });

server.listen(PORT, HOST, () => {
  console.log(`${NAME} ${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await Promise.allSettled([...queues.values()]);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
