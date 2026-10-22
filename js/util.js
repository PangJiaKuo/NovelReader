/* Small shared helpers. No dependencies. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function debounce(fn, wait = 200) {
  let timer = null;
  let lastArgs = null;
  const wrapped = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  wrapped.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      if (lastArgs) fn(...lastArgs);
    }
  };
  return wrapped;
}

export function throttle(fn, wait = 100) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      clearTimeout(timer);
      timer = null;
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn(...args);
      }, remaining);
    }
  };
}

export const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
export const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

export async function sha256Hex(data) {
  let buffer;
  if (typeof data === 'string') buffer = new TextEncoder().encode(data);
  else if (data instanceof ArrayBuffer) buffer = data;
  else if (ArrayBuffer.isView(data)) buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  else if (typeof Blob !== 'undefined' && data instanceof Blob) buffer = await data.arrayBuffer();
  else buffer = new TextEncoder().encode(String(data));
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 100000000) return `${trimZero(n / 100000000)} 亿`;
  if (n >= 10000) return `${trimZero(n / 10000)} 万`;
  return new Intl.NumberFormat('zh-CN').format(n);
}

function trimZero(n) {
  return (n >= 10 ? n.toFixed(0) : n.toFixed(1)).replace(/\.0$/, '');
}

export function timeAgo(timestamp) {
  if (!timestamp) return '';
  const then = Number(timestamp);
  const diff = Math.max(0, Date.now() - then);
  const minute = 60000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return sameYear
    ? `${date.getMonth() + 1} 月 ${date.getDate()} 日`
    : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatDuration(ms, short = false) {
  const minutes = Math.round((Number(ms) || 0) / 60000);
  if (minutes < 1) return short ? '<1 分钟' : '不足 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (short || rest === 0) return `${hours} 小时${rest && !short ? ` ${rest} 分钟` : ''}`;
  return `${hours} 小时 ${rest} 分钟`;
}

export function formatDate(timestamp) {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function isEditable(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function isCoarsePointer() {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
}

export function safeJSONParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function uid(prefix = 'id') {
  const random = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function detectFileKind(file) {
  const name = (file?.name || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (ext === 'epub' || file?.type === 'application/epub+zip') return 'epub';
  if (['txt', 'text', 'log', 'md', 'markdown', 'html', 'htm', 'xhtml'].includes(ext)) {
    if (ext === 'md' || ext === 'markdown') return 'md';
    if (['html', 'htm', 'xhtml'].includes(ext)) return 'html';
    return 'txt';
  }
  if (file?.type?.startsWith('text/')) return 'txt';
  if (file?.type === 'application/xhtml+xml') return 'html';
  return name ? 'unknown' : 'txt';
}

export function stripExtension(filename = '') {
  return filename.replace(/\.[^.]+$/, '');
}

export function composeTitle(title, author) {
  return author ? `${title} · ${author}` : title;
}

export function supportsDialog() {
  return typeof HTMLDialogElement !== 'undefined' && typeof HTMLDialogElement.prototype.showModal === 'function';
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
