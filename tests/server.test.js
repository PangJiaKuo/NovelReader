import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PORT = 43117;
const BASE = `http://127.0.0.1:${PORT}`;
const USERNAME = 'reader_test';
const PASSWORD = 'Moread123';
const root = path.resolve(import.meta.dirname, '..');
let dataDir;
let child;
let token;
let health;

async function waitForHealth() {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 12000) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw lastError || new Error('server did not start');
}

async function api(pathname, { method = 'GET', body, auth } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { response, payload };
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moread-test-'));
  child = spawn(process.execPath, ['server/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      LOG_REQUESTS: '0',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  health = await waitForHealth();
});

after(async () => {
  if (child && !child.killed) {
    child.kill();
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
  }
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

test('health endpoint identifies the sync service', () => {
  assert.equal(health.ok, true);
  assert.equal(health.name, 'Moread Sync');
  assert.match(health.version, /^\d+\.\d+\.\d+$/);
});

test('registration issues a token and rejects duplicates', async () => {
  const first = await api('/api/auth/register', {
    method: 'POST',
    body: { username: USERNAME, password: PASSWORD },
  });
  assert.equal(first.response.status, 201);
  assert.ok(first.payload.token);
  assert.equal(first.payload.user.username, USERNAME);
  token = first.payload.token;

  const duplicate = await api('/api/auth/register', {
    method: 'POST',
    body: { username: USERNAME, password: PASSWORD },
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.payload.error.code, 'username_taken');
});

test('invalid registration input is rejected', async () => {
  const shortPassword = await api('/api/auth/register', {
    method: 'POST',
    body: { username: 'reader_two', password: '123' },
  });
  assert.equal(shortPassword.response.status, 400);
  assert.match(shortPassword.payload.error.message, /密码/);
});

test('sync requires authentication', async () => {
  const { response } = await api('/api/sync');
  assert.equal(response.status, 401);
});

test('sync stores full page position and settings', async () => {
  const now = Date.now();
  const hash = 'a'.repeat(64);
  const { response, payload } = await api('/api/sync', {
    method: 'POST',
    auth: token,
    body: {
      progress: [{
        hash,
        title: '山寺的灯',
        author: '拾页书坊',
        chapterIndex: 1,
        chapterTitle: '第二章 守灯人',
        chapterCount: 8,
        pageIndex: 2,
        pageCount: 4,
        chapterRatio: 0.5,
        scrollRatio: 0,
        percent: 42.5,
        finished: false,
        readingTime: 120000,
        updatedAt: now,
      }],
      settings: {
        themeId: 'paper',
        fontFamily: 'serif',
        fontSize: 20,
        lineHeight: 1.9,
        mode: 'paged',
        updatedAt: now,
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(payload.progress.length, 1);
  assert.equal(payload.progress[0].chapterRatio, 0.5);
  assert.equal(payload.progress[0].pageCount, 4);
  assert.equal(payload.progress[0].chapterCount, 8);
  assert.equal(payload.progress[0].pageIndex, 2);
  assert.equal(payload.settings.fontSize, 20);
  assert.equal(payload.settings.mode, 'paged');
});

test('sync merges newest progress and settings, and ignores older data', async () => {
  const now = Date.now();
  const hash = 'a'.repeat(64);
  const newer = await api('/api/sync', {
    method: 'POST',
    auth: token,
    body: {
      progress: [{
        hash,
        title: '山寺的灯',
        chapterIndex: 2,
        chapterTitle: '第三章 旧信',
        chapterCount: 8,
        pageIndex: 3,
        pageCount: 5,
        chapterRatio: 0.75,
        percent: 55,
        finished: false,
        updatedAt: now + 5000,
      }],
      settings: { themeId: 'night', fontFamily: 'kai', fontSize: 22, mode: 'paged', updatedAt: now + 5000 },
    },
  });
  assert.equal(newer.payload.progress[0].percent, 55);
  assert.equal(newer.payload.progress[0].chapterRatio, 0.75);
  assert.equal(newer.payload.settings.fontSize, 22);

  const older = await api('/api/sync', {
    method: 'POST',
    auth: token,
    body: {
      progress: [{
        hash,
        title: '山寺的灯',
        chapterIndex: 0,
        chapterCount: 8,
        pageIndex: 0,
        pageCount: 3,
        chapterRatio: 0,
        percent: 1,
        updatedAt: now - 5000,
      }],
      settings: { themeId: 'paper', fontFamily: 'serif', fontSize: 14, updatedAt: now - 5000 },
    },
  });
  assert.equal(older.payload.progress[0].percent, 55);
  assert.equal(older.payload.progress[0].chapterRatio, 0.75);
  assert.equal(older.payload.settings.fontSize, 22);
});

test('login validates credentials and logout revokes the token', async () => {
  const wrong = await api('/api/auth/login', {
    method: 'POST',
    body: { username: USERNAME, password: 'wrong-password' },
  });
  assert.equal(wrong.response.status, 401);
  assert.equal(wrong.payload.error.code, 'invalid_credentials');

  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { username: USERNAME, password: PASSWORD },
  });
  assert.equal(login.response.status, 200);
  const loginToken = login.payload.token;

  const me = await api('/api/auth/me', { auth: loginToken });
  assert.equal(me.response.status, 200);
  assert.equal(me.payload.user.username, USERNAME);

  const logout = await api('/api/auth/logout', { method: 'POST', auth: loginToken });
  assert.equal(logout.response.status, 200);

  const afterLogout = await api('/api/auth/me', { auth: loginToken });
  assert.equal(afterLogout.response.status, 401);
});

test('static host serves the app with security headers', async () => {
  const response = await fetch(`${BASE}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const html = await response.text();
  assert.match(html, /墨阅 · 私人阅读空间/);
});
