#!/usr/bin/env node
/*
 * Moread sync server + static host.
 * Zero dependencies, single JSON database. See README for deployment notes.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const scryptAsync = promisify(crypto.scrypt);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = '1.0.0';
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_PROGRESS = 2000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.epub': 'application/epub+zip',
  '.woff2': 'font/woff2',
};

const STATIC_ALLOW = [
  /^\/index\.html$/,
  /^\/manifest\.webmanifest$/,
  /^\/sw\.js$/,
  /^\/favicon\.svg$/,
  /^\/js\/[a-z0-9._-]+$/i,
  /^\/assets\/[a-z0-9._/-]+$/i,
  /^\/icons\/[a-z0-9._-]+$/i,
];

const SETTING_KEYS = [
  'themeId', 'customBg', 'customText', 'fontFamily', 'fontSize', 'lineHeight',
  'letterSpacing', 'pagePad', 'maxWidth', 'paragraphSpacing', 'textIndent',
  'justify', 'mode', 'pageAnimation', 'updatedAt',
];

let db = null;
let writeChain = Promise.resolve();
const loginAttempts = new Map();
const gzipCache = new Map();

/* ----------------------------- utilities ------------------------------- */

const now = () => Date.now();
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function clientIP(req) {
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimit(ip, bucket, limit, windowMs) {
  const key = `${bucket}:${ip}`;
  const current = now();
  const item = loginAttempts.get(key);
  if (!item || item.resetAt <= current) {
    loginAttempts.set(key, { count: 1, resetAt: current + windowMs });
    return true;
  }
  item.count += 1;
  if (item.count > limit) return false;
  return true;
}

setInterval(() => {
  const current = now();
  for (const [key, item] of loginAttempts) {
    if (item.resetAt <= current) loginAttempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

function json(res, status, data, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...corsHeaders(),
    ...extraHeaders,
  });
  res.end(body);
}

function fail(res, status, message, code = 'error') {
  json(res, status, { error: { message, code } });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (type && !type.includes('application/json')) {
      reject(Object.assign(new Error('请求必须使用 JSON'), { status: 415 }));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求内容过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON 格式不正确'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/* -------------------------------- auth --------------------------------- */

function validateUsername(value) {
  const username = String(value || '').trim();
  if (!/^[\p{L}\p{N}_-]{2,24}$/u.test(username)) {
    throw Object.assign(new Error('用户名需为 2–24 个字母、数字、下划线或汉字'), { status: 400 });
  }
  return username;
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 6 || password.length > 128) {
    throw Object.assign(new Error('密码长度需为 6–128 位'), { status: 400 });
  }
  return password;
}

async function passwordHash(password, salt) {
  const derived = await scryptAsync(password, salt, 64);
  return Buffer.from(derived).toString('hex');
}

async function issueToken(userKey) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.tokens[sha256(token)] = {
    userKey,
    createdAt: now(),
    expiresAt: now() + TOKEN_TTL,
  };
  await saveDb();
  return token;
}

function publicUser(user) {
  return { username: user.username, createdAt: user.createdAt };
}

async function authenticate(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const tokenHash = sha256(match[1]);
  const token = db.tokens[tokenHash];
  if (!token) return null;
  if (token.expiresAt <= now()) {
    delete db.tokens[tokenHash];
    return null;
  }
  const user = db.users[token.userKey];
  if (!user) return null;
  return { user, userKey: token.userKey, tokenHash };
}

/* ----------------------------- validation ------------------------------- */

function clampNumber(value, min, max, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function sanitizeProgressRecord(input) {
  if (!input || typeof input !== 'object') return null;
  const hash = cleanText(input.hash, 128).toLowerCase();
  if (!/^[a-f0-9]{16,128}$/.test(hash)) return null;
  return {
    hash,
    title: cleanText(input.title, 200),
    author: cleanText(input.author, 120),
    chapterIndex: Math.floor(clampNumber(input.chapterIndex, 0, 1000000, 0)),
    chapterTitle: cleanText(input.chapterTitle, 160),
    chapterCount: Math.floor(clampNumber(input.chapterCount, 1, 1000000, 1)),
    pageIndex: Math.floor(clampNumber(input.pageIndex, 0, 1000000, 0)),
    pageCount: Math.floor(clampNumber(input.pageCount, 1, 1000000, 1)),
    chapterRatio: clampNumber(input.chapterRatio, 0, 1, 0),
    scrollRatio: clampNumber(input.scrollRatio, 0, 1, 0),
    percent: clampNumber(input.percent, 0, 100, 0),
    finished: Boolean(input.finished),
    readingTime: clampNumber(input.readingTime, 0, 1000000000000, 0),
    updatedAt: clampNumber(input.updatedAt, 0, now() + 86400000, 0),
  };
}

function sanitizeSettings(input) {
  if (!input || typeof input !== 'object') return null;
  const out = {};
  for (const key of SETTING_KEYS) {
    const value = input[key];
    if (key === 'updatedAt') {
      out.updatedAt = clampNumber(value, 0, now() + 86400000, 0);
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number') {
      out[key] = clampNumber(value, -10000, 10000, 0);
    } else if (typeof value === 'string') {
      out[key] = cleanText(value, 80);
    }
  }
  out.updatedAt = out.updatedAt || 0;
  return out;
}

function mergeProgress(serverRecords = [], incoming = []) {
  const map = new Map();
  for (const record of serverRecords) {
    const clean = sanitizeProgressRecord(record);
    if (clean) map.set(clean.hash, clean);
  }
  for (const record of incoming.slice(0, MAX_PROGRESS)) {
    const clean = sanitizeProgressRecord(record);
    if (!clean) continue;
    const existing = map.get(clean.hash);
    if (!existing || clean.updatedAt > existing.updatedAt) map.set(clean.hash, clean);
  }
  return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PROGRESS);
}

/* ------------------------------ database -------------------------------- */

async function loadDb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.users !== 'object') throw new Error('bad shape');
    parsed.tokens = parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {};
    return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      const backup = `${DB_PATH}.corrupt-${now()}`;
      try {
        await fs.rename(DB_PATH, backup);
        console.error(`[moread] 数据库读取失败，已备份到 ${backup}`);
      } catch {
        console.error('[moread] 数据库读取失败:', error.message);
      }
    }
    return { version: 1, users: {}, tokens: {}, createdAt: now() };
  }
}

function saveDb() {
  const snapshot = JSON.stringify(db);
  writeChain = writeChain
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const temp = `${DB_PATH}.tmp-${process.pid}`;
      await fs.writeFile(temp, snapshot, { mode: 0o600 });
      await fs.rename(temp, DB_PATH);
    })
    .catch((error) => {
      console.error('[moread] 写入数据库失败:', error.message);
      throw error;
    });
  return writeChain;
}

function pruneTokens() {
  const current = now();
  let changed = false;
  for (const [key, token] of Object.entries(db.tokens)) {
    if (!token || token.expiresAt <= current) {
      delete db.tokens[key];
      changed = true;
    }
  }
  return changed;
}

/* ------------------------------ API routes ------------------------------ */

async function handleApi(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    json(res, 200, { ok: true, name: 'Moread Sync', version: VERSION, time: now() });
    return;
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    if (!rateLimit(clientIP(req), 'register', 8, 60 * 60 * 1000)) {
      fail(res, 429, '注册尝试过于频繁，请稍后再试', 'rate_limited');
      return;
    }
    const body = await readJson(req);
    const username = validateUsername(body.username);
    const password = validatePassword(body.password);
    const key = sha256(`user:${username.toLowerCase()}`);
    if (db.users[key]) {
      fail(res, 409, '这个用户名已经被注册了', 'username_taken');
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await passwordHash(password, salt);
    const user = {
      username,
      salt,
      passwordHash: hash,
      createdAt: now(),
      data: { progress: [], settings: null, updatedAt: 0 },
    };
    db.users[key] = user;
    await saveDb();
    const token = await issueToken(key);
    json(res, 201, { token, user: publicUser(user), serverTime: now() });
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!rateLimit(clientIP(req), 'login', 20, 15 * 60 * 1000)) {
      fail(res, 429, '登录尝试过于频繁，请稍后再试', 'rate_limited');
      return;
    }
    const body = await readJson(req);
    const username = cleanText(body.username, 64);
    const password = String(body.password || '');
    if (!username || !password) {
      fail(res, 400, '请输入用户名和密码', 'invalid_credentials');
      return;
    }
    const key = sha256(`user:${username.toLowerCase()}`);
    const user = db.users[key];
    if (!user) {
      // Equalize response time a little against user enumeration.
      await passwordHash(password, '00000000000000000000000000000000');
      fail(res, 401, '用户名或密码不正确', 'invalid_credentials');
      return;
    }
    const hash = await passwordHash(password, user.salt);
    const expected = Buffer.from(user.passwordHash, 'hex');
    const actual = Buffer.from(hash, 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      fail(res, 401, '用户名或密码不正确', 'invalid_credentials');
      return;
    }
    const token = await issueToken(key);
    json(res, 200, { token, user: publicUser(user), serverTime: now() });
    return;
  }

  const auth = await authenticate(req);
  if (!auth) {
    fail(res, 401, '登录已过期，请重新登录', 'unauthorized');
    return;
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    json(res, 200, {
      user: publicUser(auth.user),
      data: {
        updatedAt: auth.user.data.updatedAt || 0,
        progressCount: auth.user.data.progress?.length || 0,
      },
      serverTime: now(),
    });
    return;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    delete db.tokens[auth.tokenHash];
    await saveDb();
    json(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/sync' && req.method === 'GET') {
    json(res, 200, {
      progress: auth.user.data.progress || [],
      settings: auth.user.data.settings || null,
      updatedAt: auth.user.data.updatedAt || 0,
      serverTime: now(),
    });
    return;
  }

  if (pathname === '/api/sync' && req.method === 'POST') {
    const body = await readJson(req);
    const incoming = Array.isArray(body.progress) ? body.progress.slice(0, MAX_PROGRESS) : [];
    const incomingSettings = sanitizeSettings(body.settings);
    const oldData = auth.user.data || {};
    const merged = mergeProgress(oldData.progress || [], incoming);
    let settings = oldData.settings || null;
    if (incomingSettings && (!settings || incomingSettings.updatedAt > (settings.updatedAt || 0))) {
      settings = incomingSettings;
    }
    auth.user.data = {
      progress: merged,
      settings,
      updatedAt: now(),
    };
    await saveDb();
    json(res, 200, {
      progress: merged,
      settings,
      updatedAt: auth.user.data.updatedAt,
      serverTime: now(),
    });
    return;
  }

  fail(res, 404, '接口不存在', 'not_found');
}

/* ---------------------------- static assets ----------------------------- */

function allowedStatic(pathname) {
  if (pathname.includes('\0')) return false;
  return STATIC_ALLOW.some((pattern) => pattern.test(pathname));
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  if (decoded === '/') decoded = '/index.html';
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Forbidden');
    return;
  }
  if (!allowedStatic(decoded)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not found');
    return;
  }

  const filePath = path.resolve(ROOT, `.${decoded}`);
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let stats;
  try {
    stats = await fs.stat(filePath);
    if (!stats.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  const cacheControl = /\.(?:png|webp|svg|ico|woff2)$/i.test(filePath)
    ? 'public, max-age=604800'
    : 'no-cache';

  const baseHeaders = {
    'Content-Type': type,
    'Cache-Control': cacheControl,
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https: http:",
      "font-src 'self' data:",
      "connect-src 'self' https: http:",
      "media-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, baseHeaders);
    res.end();
    return;
  }

  let data;
  try {
    data = await fs.readFile(filePath);
  } catch {
    res.writeHead(500);
    res.end('Unable to read file');
    return;
  }

  const compressible = /^(?:text\/|application\/(?:json|javascript|manifest\+json)|image\/svg)/.test(type);
  const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
  let payload = data;
  let encoding = '';
  if (compressible && acceptsGzip && data.length > 1024) {
    const cacheKey = `${filePath}:${stats.mtimeMs}:${data.length}`;
    let compressed = gzipCache.get(cacheKey);
    if (!compressed) {
      compressed = zlib.gzipSync(data, { level: 6 });
      gzipCache.set(cacheKey, compressed);
      if (gzipCache.size > 64) gzipCache.delete(gzipCache.keys().next().value);
    }
    payload = compressed;
    encoding = 'gzip';
  }

  const headers = {
    ...baseHeaders,
    'Content-Length': payload.length,
    ...(encoding ? { 'Content-Encoding': encoding, Vary: 'Accept-Encoding' } : {}),
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else res.end(payload);
}

/* -------------------------------- server -------------------------------- */

const server = http.createServer(async (req, res) => {
  const started = now();
  let pathname = '/';
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        await handleApi(req, res, pathname);
      } else {
        await handleApi(req, res, pathname);
      }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }
    await serveStatic(req, res, pathname);
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error('[moread] request error:', error);
    if (!res.headersSent) {
      fail(res, status, error.message || '服务器内部错误', status === 500 ? 'internal_error' : 'request_error');
    } else {
      res.end();
    }
  } finally {
    if (process.env.LOG_REQUESTS === '1') {
      console.log(`${req.method} ${pathname} ${res.statusCode} ${now() - started}ms`);
    }
  }
});

function lanURLs() {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`http://${entry.address}:${PORT}`);
      }
    }
  }
  return urls;
}

async function start() {
  db = await loadDb();
  if (pruneTokens()) await saveDb();
  await saveDb();
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  Moread 阅读器已启动');
    console.log(`  本机:   http://localhost:${PORT}`);
    for (const url of lanURLs()) console.log(`  局域网: ${url}`);
    console.log(`  数据:   ${DATA_DIR}`);
    console.log('');
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[moread] 收到 ${signal}，正在保存并退出…`);
  server.close();
  try {
    await writeChain;
    await saveDb();
  } catch {
    /* logged already */
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((error) => {
  console.error('[moread] 启动失败:', error);
  process.exit(1);
});
