/* Cloud account + progress sync client. */

import { applySyncedProgress, listBooksWithProgress } from './store.js';
import { loadSettings, sanitizeSettings, setSyncedSettings } from './settings.js';

const STORAGE_KEY = 'moread.cloud.v1';
const DEFAULT_TIMEOUT = 15000;

export class CloudError extends Error {
  constructor(message, { status = 0, code = 'cloud_error' } = {}) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.code = code;
  }
}

function defaultServer() {
  if (typeof location === 'undefined') return '';
  if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
  return '';
}

export function normalizeServer(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new CloudError('请填写同步服务器地址');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CloudError('服务器地址格式不正确，例如 https://read.example.com');
  }
  if (!/^https?:$/.test(url.protocol)) throw new CloudError('服务器地址必须以 http:// 或 https:// 开头');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function loadCloudState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const session = parsed.session && parsed.session.token
      ? {
        token: String(parsed.session.token),
        username: String(parsed.session.username || ''),
        server: String(parsed.session.server || defaultServer()).replace(/\/+$/, ''),
        loginAt: Number(parsed.session.loginAt) || 0,
      }
      : null;
    return {
      session,
      autoSync: parsed.autoSync !== false,
      lastSyncAt: Number(parsed.lastSyncAt) || 0,
      serverHint: String(parsed.serverHint || defaultServer()).replace(/\/+$/, ''),
    };
  } catch {
    return { session: null, autoSync: true, lastSyncAt: 0, serverHint: defaultServer() };
  }
}

export function saveCloudState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota errors */
  }
  try {
    window.dispatchEvent(new CustomEvent('moread:cloud', { detail: state }));
  } catch {
    /* ignore */
  }
}

export function updateCloudState(patch) {
  const next = { ...loadCloudState(), ...patch };
  saveCloudState(next);
  return next;
}

export function setSession(session) {
  const state = loadCloudState();
  state.session = session;
  saveCloudState(state);
  return state;
}

export function clearSession() {
  const state = loadCloudState();
  state.session = null;
  state.lastSyncAt = 0;
  saveCloudState(state);
  return state;
}

export function getServer() {
  const state = loadCloudState();
  return state.session?.server || state.serverHint || defaultServer();
}

function resolveBase(server) {
  const candidate = server || getServer() || defaultServer();
  if (!candidate) throw new CloudError('还没有配置同步服务器');
  return normalizeServer(candidate);
}

async function request(path, { server, method = 'GET', body, token, timeout = DEFAULT_TIMEOUT } = {}) {
  const base = resolveBase(server);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new CloudError('连接服务器超时，请检查网络或服务器地址');
    throw new CloudError('无法连接同步服务器，请确认服务已启动');
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  const type = response.headers.get('content-type') || '';
  try {
    payload = type.includes('application/json') ? await response.json() : await response.text();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload && typeof payload === 'object' ? payload.error : null;
    const message = (detail && (detail.message || detail)) || (typeof payload === 'string' ? payload : '') || `请求失败（${response.status}）`;
    throw new CloudError(String(message), {
      status: response.status,
      code: (detail && detail.code) || `http_${response.status}`,
    });
  }
  return payload;
}

export async function checkServer(server, timeout = 4000) {
  try {
    const data = await request('/api/health', { server, timeout });
    return { ok: true, version: data?.version || '', server: resolveBase(server) };
  } catch (error) {
    return { ok: false, error: error.message || '服务器不可用', server: server || '' };
  }
}

function requireSession() {
  const state = loadCloudState();
  if (!state.session?.token) throw new CloudError('请先登录云端账号', { code: 'not_logged_in' });
  return state.session;
}

export async function register({ username, password, server }) {
  const base = resolveBase(server);
  const data = await request('/api/auth/register', {
    server: base,
    method: 'POST',
    body: { username, password },
    timeout: 20000,
  });
  const session = {
    token: data.token,
    username: data.user?.username || username,
    server: base,
    loginAt: Date.now(),
  };
  const state = loadCloudState();
  state.session = session;
  state.serverHint = base;
  saveCloudState(state);
  return session;
}

export async function login({ username, password, server }) {
  const base = resolveBase(server);
  const data = await request('/api/auth/login', {
    server: base,
    method: 'POST',
    body: { username, password },
    timeout: 20000,
  });
  const session = {
    token: data.token,
    username: data.user?.username || username,
    server: base,
    loginAt: Date.now(),
  };
  const state = loadCloudState();
  state.session = session;
  state.serverHint = base;
  saveCloudState(state);
  return session;
}

export async function logout() {
  const state = loadCloudState();
  const session = state.session;
  if (session?.token) {
    try {
      await request('/api/auth/logout', { method: 'POST', token: session.token, server: session.server, timeout: 5000 });
    } catch {
      /* local logout still succeeds */
    }
  }
  clearSession();
}

export async function fetchMe() {
  const session = requireSession();
  try {
    const data = await request('/api/auth/me', { token: session.token, server: session.server, timeout: 8000 });
    return data.user;
  } catch (error) {
    if (error.status === 401) clearSession();
    throw error;
  }
}

function toCloudRecord(progress, book) {
  const chapterRatio = Math.max(0, Math.min(1, Number(progress.chapterRatio) || 0));
  return {
    hash: progress.bookId,
    title: (book?.title || progress.chapterTitle || '').slice(0, 200),
    author: (book?.author || '').slice(0, 120),
    chapterIndex: Math.max(0, Number(progress.chapterIndex) || 0),
    chapterTitle: (progress.chapterTitle || '').slice(0, 160),
    chapterCount: Math.max(1, Number(progress.chapterCount || book?.chapterCount) || 1),
    pageIndex: Math.max(0, Number(progress.pageIndex) || 0),
    pageCount: Math.max(1, Number(progress.pageCount) || 1),
    chapterRatio,
    scrollRatio: Math.max(0, Math.min(1, Number(progress.scrollRatio) || 0)),
    percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
    finished: Boolean(progress.finished),
    readingTime: Math.max(0, Number(progress.readingTime) || 0),
    updatedAt: Number(progress.updatedAt) || Date.now(),
  };
}

let activeSync = null;

/**
 * Push local progress + settings and receive the merged cloud state.
 * Concurrent callers share the same in-flight request.
 */
export async function syncNow({ quiet = false } = {}) {
  if (activeSync) return activeSync;
  const session = requireSession();
  activeSync = (async () => {
    const books = await listBooksWithProgress();
    const bookMap = new Map(books.map((book) => [book.id, book]));
    const progress = books
      .filter((book) => book.progress)
      .map((book) => toCloudRecord(book.progress, bookMap.get(book.id)));
    const localSettings = loadSettings();

    let response;
    try {
      response = await request('/api/sync', {
        method: 'POST',
        token: session.token,
        server: session.server,
        timeout: 25000,
        body: {
          progress,
          settings: localSettings,
          clientTime: Date.now(),
        },
      });
    } catch (error) {
      if (error.status === 401) {
        clearSession();
        throw new CloudError('登录已过期，请重新登录', { status: 401, code: 'unauthorized' });
      }
      throw error;
    }

    const remoteProgress = Array.isArray(response?.progress) ? response.progress : [];
    const { applied, pending } = await applySyncedProgress(remoteProgress);

    let settingsUpdated = false;
    if (response?.settings && typeof response.settings === 'object') {
      const remoteSettings = sanitizeSettings(response.settings);
      if (remoteSettings.updatedAt > localSettings.updatedAt + 500) {
        setSyncedSettings(remoteSettings);
        settingsUpdated = true;
      }
    }

    const now = Date.now();
    const state = loadCloudState();
    state.lastSyncAt = now;
    if (state.session) {
      state.session = { ...state.session, token: session.token, username: session.username, server: session.server };
    }
    saveCloudState(state);

    return {
      applied,
      pending,
      settingsUpdated,
      total: remoteProgress.length,
      lastSyncAt: now,
      quiet,
    };
  })();

  try {
    return await activeSync;
  } finally {
    activeSync = null;
  }
}

export function setAutoSync(enabled) {
  const state = loadCloudState();
  state.autoSync = Boolean(enabled);
  saveCloudState(state);
  return state.autoSync;
}

export function getAutoSync() {
  return loadCloudState().autoSync;
}

export function isLoggedIn() {
  return Boolean(loadCloudState().session?.token);
}

export function accountLabel() {
  return loadCloudState().session?.username || '';
}

export async function changeServer(server) {
  const normalized = normalizeServer(server);
  const state = loadCloudState();
  if (state.session && state.session.server !== normalized) {
    state.session = null;
  }
  state.serverHint = normalized;
  saveCloudState(state);
  return normalized;
}

export function defaultSyncServer() {
  return defaultServer();
}
