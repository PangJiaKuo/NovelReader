/* Library shell, import flow, dialogs, PWA install and cloud sync wiring. */

import { Reader } from './reader.js';
import { ImportError, importBookFile, importSampleBook } from './importer.js';
import {
  deleteBook,
  getBook,
  listBooksWithProgress,
  resetBookProgress,
} from './store.js';
import {
  accountLabel,
  changeServer,
  checkServer,
  getAutoSync,
  getServer,
  isLoggedIn,
  loadCloudState,
  login,
  logout,
  normalizeServer,
  register,
  setAutoSync,
  syncNow,
} from './cloud.js';
import { estimateReadingMinutes } from './settings.js';
import {
  clamp,
  debounce,
  escapeHTML,
  formatCount,
  formatDuration,
  isEditable,
  timeAgo,
} from './util.js';
import { confirmDialog, toast } from './ui.js';

const SUPPORTED_EXT = /\.(epub|txt|text|md|markdown|html?|xhtml)$/i;
const AUTO_SYNC_DELAY = 18000;
const AUTO_SYNC_INTERVAL = 5 * 60 * 1000;

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  books: [],
  ready: false,
  filter: 'all',
  query: '',
  sort: 'recent',
  activeBookId: null,
  openingBookId: null,
  importing: false,
  syncBusy: false,
  authBusy: false,
  authMode: 'login',
  serverCheckToken: 0,
  deferredInstall: null,
  autoSyncTimer: null,
  serverState: 'idle',
};

const el = {};
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
let reader = null;

/* ------------------------------ small helpers ----------------------------- */

function cacheDom() {
  const ids = [
    'libraryView', 'libraryStats', 'continueCard', 'continueCover', 'continueTitle',
    'continueMeta', 'continueProgressFill', 'librarySearch', 'filterChips', 'librarySort',
    'bookGrid', 'noResults', 'clearFilters', 'emptyLibrary', 'helpButton', 'installBtn',
    'syncButton', 'syncButtonLabel', 'importButton', 'emptyImportBtn', 'sampleBtn',
    'footerHelp', 'fileInput', 'dropOverlay', 'importOverlay', 'importTitle',
    'importMessage', 'importProgressFill', 'importHint', 'syncDialog', 'syncServerDot',
    'syncServerStatus', 'syncRecheck', 'syncLoggedOut', 'syncLoggedIn', 'syncAuthForm',
    'syncUsername', 'syncPassword', 'syncConfirmRow', 'syncConfirm', 'syncAuthError',
    'syncAuthSubmit', 'syncAuthSubmitLabel', 'syncAvatar', 'syncUsernameLabel',
    'syncAccountServer', 'syncLastAt', 'syncBookCount', 'syncNowBtn', 'syncLogoutBtn',
    'syncAutoToggle', 'syncAccountError', 'syncServerInput', 'syncServerSave',
    'bookDialog', 'bookDialogCover', 'bookDialogTitle', 'bookDialogAuthor',
    'bookDialogMeta', 'bookDialogProgressText', 'bookDialogProgressFill',
    'bookDialogContinue', 'bookDialogRestart', 'bookDialogDelete', 'helpDialog',
    'readerView',
  ];
  for (const id of ids) el[id] = document.getElementById(id);
  el.importTrack = $('.import-track');
  el.authModeButtons = Array.from(document.querySelectorAll('[data-auth-mode]'));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${Math.max(1, Math.round(size))} B`;
}

function safePercent(progress) {
  if (!progress) return 0;
  return clamp(Number(progress.percent) || 0, 0, 100);
}

function isFinished(book) {
  return Boolean(book.progress) && safePercent(book.progress) >= 99.5;
}

function isReading(book) {
  const percent = safePercent(book.progress);
  return Boolean(book.progress) && percent > 0.5 && percent < 99.5;
}

function prettyServer(value) {
  return String(value || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function showDialog(dialog) {
  if (!dialog) return;
  if (dialog.open) return;
  try {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  } catch {
    dialog.setAttribute('open', '');
  }
}

function hideDialog(dialog) {
  if (!dialog) return;
  try {
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  } catch {
    dialog.removeAttribute('open');
  }
}

/* ------------------------------ book covers ------------------------------- */

function coverHTML(book) {
  const title = escapeHTML(truncate(book.title || '未命名书籍', 64));
  const author = escapeHTML(truncate(book.author || '佚名', 24));
  if (book.cover) {
    return `<span class="book-cover has-image"><img src="${escapeHTML(book.cover)}" alt="" loading="lazy" draggable="false"><span class="cover-sheen"></span></span>`;
  }
  const tone = ((Number(book.tone) || 0) % 6 + 6) % 6;
  return `<span class="book-cover has-art tone-${tone}">
    <span class="cover-art-frame" aria-hidden="true"></span>
    <span class="cover-art-body">
      <span class="cover-kicker">MOREAD · ${escapeHTML(book.format || 'BOOK')}</span>
      <span class="cover-title">${title}</span>
      <span class="cover-rule" aria-hidden="true"></span>
      <span class="cover-author">${author}</span>
    </span>
  </span>`;
}

function statusText(book) {
  const progress = book.progress;
  if (!progress) return `${formatCount(book.chars)} 字 · 未开始`;
  if (isFinished(book)) return `已读完 · ${timeAgo(progress.updatedAt)}`;
  if (isReading(book)) return `已读 ${Math.floor(safePercent(progress))}% · ${timeAgo(progress.updatedAt)}`;
  return `${formatCount(book.chars)} 字 · 未开始`;
}

function progressMarkup(book) {
  const percent = safePercent(book.progress);
  if (!book.progress || percent <= 0.5) return '';
  return `<span class="cover-progress" aria-hidden="true"><span style="width:${percent.toFixed(1)}%"></span></span>
    <span class="cover-progress-label">${isFinished(book) ? '读完' : `${Math.floor(percent)}%`}</span>`;
}

/* ------------------------------- library UI ------------------------------- */

function sortBooks(books) {
  const list = [...books];
  if (state.sort === 'title') {
    list.sort((a, b) => collator.compare(a.title || '', b.title || ''));
    return list;
  }
  if (state.sort === 'added') {
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return list;
  }
  list.sort((a, b) => {
    const aTime = a.progress?.updatedAt || a.updatedAt || a.createdAt || 0;
    const bTime = b.progress?.updatedAt || b.updatedAt || b.createdAt || 0;
    return bTime - aTime;
  });
  return list;
}

function currentBooks() {
  const query = state.query.trim().toLowerCase();
  return sortBooks(state.books.filter((book) => {
    if (query) {
      const haystack = `${book.title || ''} ${book.author || ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (state.filter === 'reading') return isReading(book);
    if (state.filter === 'unread') return !book.progress || safePercent(book.progress) <= 0.5;
    if (state.filter === 'finished') return isFinished(book);
    return true;
  }));
}

function updateLibraryStats() {
  if (!el.libraryStats) return;
  if (!state.ready) {
    el.libraryStats.textContent = '正在整理书架…';
    return;
  }
  if (!state.books.length) {
    el.libraryStats.textContent = '书架空着，等你放上第一本书';
    return;
  }
  const reading = state.books.filter(isReading).length;
  const finished = state.books.filter(isFinished).length;
  const readingMs = state.books.reduce((sum, book) => sum + (Number(book.progress?.readingTime) || 0), 0);
  const parts = [`共 ${state.books.length} 本`];
  if (reading) parts.push(`${reading} 本在读`);
  if (finished) parts.push(`${finished} 本读完`);
  if (readingMs >= 60000) parts.push(`累计阅读 ${formatDuration(readingMs)}`);
  el.libraryStats.textContent = parts.join(' · ');
}

function updateContinueCard() {
  if (!el.continueCard) return;
  if (!state.books.length) {
    el.continueCard.hidden = true;
    return;
  }
  const withProgress = state.books
    .filter((book) => book.progress)
    .sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0));
  const book = withProgress[0] || sortBooks(state.books)[0];
  if (!book) {
    el.continueCard.hidden = true;
    return;
  }
  const progress = book.progress;
  const percent = safePercent(progress);
  el.continueCard.hidden = false;
  el.continueCard.dataset.bookId = book.id;
  el.continueCover.innerHTML = coverHTML(book);
  el.continueTitle.textContent = book.title || '未命名书籍';
  if (progress && percent > 0.5) {
    const chapter = progress.chapterTitle || (progress.chapterIndex >= 0 ? `第 ${progress.chapterIndex + 1} 章` : '');
    const bits = [chapter, isFinished(book) ? '已读完' : `${Math.floor(percent)}%`];
    if (progress.updatedAt) bits.push(timeAgo(progress.updatedAt));
    el.continueMeta.textContent = bits.filter(Boolean).join(' · ');
  } else {
    el.continueMeta.textContent = `${book.chapterCount || 0} 章 · ${formatCount(book.chars)} 字 · 刚刚加入`;
  }
  el.continueProgressFill.style.width = `${progress ? percent : 0}%`;
}

function cardMarkup(book) {
  const id = escapeHTML(book.id);
  const title = escapeHTML(book.title || '未命名书籍');
  const author = escapeHTML(book.author || '佚名');
  const label = escapeHTML(`阅读《${book.title || '未命名书籍'}》`);
  return `<article class="book-card" data-book-id="${id}">
    <div class="book-cover-wrap">
      <button type="button" class="book-cover-button" data-open-book="${id}" aria-label="${label}">
        ${coverHTML(book)}
      </button>
      ${progressMarkup(book)}
      <button type="button" class="book-more" data-book-menu="${id}" aria-label="管理《${title}》">
        <svg class="icon"><use href="#icon-more"></use></svg>
      </button>
    </div>
    <div class="book-card-body">
      <h3 class="book-card-title"><button type="button" data-open-book="${id}" title="${title}">${title}</button></h3>
      <p class="book-card-author">${author}</p>
      <p class="book-card-status">${escapeHTML(statusText(book))}</p>
    </div>
  </article>`;
}

function renderBooks() {
  if (!el.bookGrid) return;
  if (!state.ready) {
    el.bookGrid.innerHTML = Array.from({ length: 6 }, () => `<div class="book-card skeleton-card" aria-hidden="true">
      <div class="skeleton-cover"></div>
      <div class="skeleton-line skeleton-title"></div>
      <div class="skeleton-line skeleton-author"></div>
      <div class="skeleton-line skeleton-meta"></div>
    </div>`).join('');
    if (el.emptyLibrary) el.emptyLibrary.hidden = true;
    if (el.noResults) el.noResults.hidden = true;
    return;
  }

  const books = currentBooks();
  el.bookGrid.innerHTML = books.map(cardMarkup).join('');
  const hasBooks = state.books.length > 0;
  const hasFilters = Boolean(state.query.trim()) || state.filter !== 'all';
  if (el.emptyLibrary) el.emptyLibrary.hidden = hasBooks;
  if (el.noResults) el.noResults.hidden = !(hasBooks && hasFilters && !books.length);
  if (el.filterChips) {
    el.filterChips.querySelectorAll('[data-filter]').forEach((button) => {
      const active = button.dataset.filter === state.filter;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }
  if (el.librarySearch && el.librarySearch.value !== state.query) el.librarySearch.value = state.query;
  if (el.librarySort && el.librarySort.value !== state.sort) el.librarySort.value = state.sort;
}

function renderLibrary() {
  updateLibraryStats();
  updateContinueCard();
  renderBooks();
}

async function refreshLibrary({ quiet = false } = {}) {
  try {
    const books = await listBooksWithProgress();
    state.books = books;
    state.ready = true;
    renderLibrary();
  } catch (error) {
    console.error(error);
    state.ready = true;
    if (!quiet) toast(`读取书架失败：${error.message || '数据库不可用'}`, { type: 'error', duration: 6000 });
    updateLibraryStats();
    renderBooks();
  }
}

/* ------------------------------- book dialogs ----------------------------- */

function renderBookDialog(book) {
  if (!book) return;
  const progress = book.progress;
  const percent = safePercent(progress);
  el.bookDialogTitle.textContent = book.title || '未命名书籍';
  el.bookDialogAuthor.textContent = book.author || '佚名';
  el.bookDialogCover.innerHTML = coverHTML(book);
  const meta = [
    book.format || '文档',
    `${book.chapterCount || 0} 章`,
    `${formatCount(book.chars)} 字`,
    `约 ${formatDuration(estimateReadingMinutes(book.chars) * 60000, true)}`,
  ];
  el.bookDialogMeta.innerHTML = meta
    .map((item, index) => `${index ? '<span class="meta-sep" aria-hidden="true">·</span>' : ''}<span>${escapeHTML(item)}</span>`)
    .join('');

  if (!progress) {
    el.bookDialogProgressText.textContent = '还没有读过这本书';
    el.bookDialogProgressFill.style.width = '0%';
    el.bookDialogContinue.textContent = '开始阅读';
    el.bookDialogRestart.hidden = true;
  } else if (isFinished(book)) {
    el.bookDialogProgressText.textContent = `已经读完 · ${timeAgo(progress.updatedAt)}`;
    el.bookDialogProgressFill.style.width = '100%';
    el.bookDialogContinue.textContent = '继续阅读';
    el.bookDialogRestart.hidden = false;
  } else {
    el.bookDialogProgressText.textContent = `已读 ${Math.floor(percent)}%${progress.chapterTitle ? ` · ${progress.chapterTitle}` : ''}`;
    el.bookDialogProgressFill.style.width = `${percent}%`;
    el.bookDialogContinue.textContent = '继续阅读';
    el.bookDialogRestart.hidden = false;
  }
}

function openBookDialog(bookId) {
  const book = state.books.find((item) => item.id === bookId);
  if (!book) {
    toast('这本书已经不在书架上了', { type: 'error' });
    return;
  }
  state.activeBookId = bookId;
  renderBookDialog(book);
  showDialog(el.bookDialog);
  requestAnimationFrame(() => el.bookDialogContinue?.focus({ preventScroll: true }));
}

async function openBook(bookId) {
  if (!bookId || !reader || reader.isOpen || state.openingBookId) return;
  let book = state.books.find((item) => item.id === bookId);
  state.openingBookId = bookId;
  try {
    if (!book) book = await getBook(bookId);
    if (!book) {
      toast('没有找到这本书，可能已经被删除', { type: 'error' });
      return;
    }
    await reader.open(book);
  } catch (error) {
    console.error(error);
    toast(`打开书籍失败：${error.message || '未知错误'}`, { type: 'error', duration: 6000 });
    if (reader.isOpen) await reader.close().catch(() => {});
  } finally {
    state.openingBookId = null;
  }
}

async function restartActiveBook() {
  const book = state.books.find((item) => item.id === state.activeBookId);
  if (!book) return;
  const confirmed = await confirmDialog({
    title: '从头开始阅读？',
    message: `《${book.title}》的阅读位置和书签会被清除。云端进度也会在下次同步时更新。`,
    confirmText: '从头开始',
  });
  if (!confirmed) return;
  try {
    const zero = await resetBookProgress(book.id);
    book.progress = zero;
    renderLibrary();
    hideDialog(el.bookDialog);
    toast('已回到第一页');
    await wait(160);
    openBook(book.id);
  } catch (error) {
    toast(`重置进度失败：${error.message || '未知错误'}`, { type: 'error' });
  }
}

async function deleteActiveBook() {
  const book = state.books.find((item) => item.id === state.activeBookId);
  if (!book) return;
  const confirmed = await confirmDialog({
    title: '从书架删除？',
    message: `《${book.title}》的本地文件、阅读进度和书签都会被删除，此操作无法撤销。云端进度记录不会同步删除。`,
    confirmText: '删除',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await deleteBook(book.id);
    state.books = state.books.filter((item) => item.id !== book.id);
    state.activeBookId = null;
    renderLibrary();
    hideDialog(el.bookDialog);
    toast(`已删除《${book.title}》`);
  } catch (error) {
    toast(`删除失败：${error.message || '未知错误'}`, { type: 'error' });
  }
}

/* ------------------------------- import flow ------------------------------ */

function unsupportedReason(file) {
  const name = String(file?.name || '').toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (ext === 'pdf' || file?.type === 'application/pdf') {
    return '暂不支持 PDF，请导入 EPUB / TXT / HTML / Markdown';
  }
  if (['mobi', 'azw', 'azw3'].includes(ext)) {
    return '暂不支持 MOBI / AZW3，请先转换为 EPUB';
  }
  if (!SUPPORTED_EXT.test(name) && !file?.type?.startsWith('text/') && file?.type !== 'application/epub+zip') {
    return '仅支持 EPUB、TXT、HTML 和 Markdown 文件';
  }
  return '';
}

function setImportProgress(value) {
  const track = el.importTrack;
  if (!track || !el.importProgressFill) return;
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    track.classList.add('is-indeterminate');
    el.importProgressFill.style.width = '';
  } else {
    track.classList.remove('is-indeterminate');
    el.importProgressFill.style.width = `${clamp(Number(value) * 100, 2, 100).toFixed(1)}%`;
  }
}

function showImportOverlay({ title = '正在导入', message = '正在读取文件…', hint = '' } = {}) {
  el.importTitle.textContent = title;
  el.importMessage.textContent = message;
  el.importHint.textContent = hint;
  setImportProgress(null);
  el.importOverlay.hidden = false;
  requestAnimationFrame(() => el.importOverlay.classList.add('is-visible'));
}

async function hideImportOverlay() {
  el.importOverlay.classList.remove('is-visible');
  await wait(220);
  el.importOverlay.hidden = true;
}

function importProgressHandler(file, index, total) {
  return ({ message, progress, stage }) => {
    el.importTitle.textContent = total > 1 ? `正在导入 ${index + 1} / ${total}` : '正在导入';
    if (message) el.importMessage.textContent = message;
    el.importHint.textContent = `${file.name} · ${fileSize(file.size)}${stage === 'saving' ? ' · 文件只保存在本机' : ''}`;
    if (Number.isFinite(Number(progress)) && Number(progress) > 0) setImportProgress(Number(progress));
    else if (stage === 'saving') setImportProgress(0.96);
    else setImportProgress(null);
  };
}

async function handleFiles(fileList) {
  if (reader?.isOpen) {
    toast('请先返回书架，再导入新书');
    return;
  }
  if (state.importing) {
    toast('正在导入，请稍候…');
    return;
  }
  const files = Array.from(fileList || []);
  if (!files.length) return;

  state.importing = true;
  const imported = [];
  const duplicates = [];
  const failures = [];

  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const reason = unsupportedReason(file);
      if (reason) {
        failures.push(`${file.name}：${reason}`);
        continue;
      }
      showImportOverlay({
        title: files.length > 1 ? `正在导入 ${index + 1} / ${files.length}` : '正在导入',
        message: '正在读取文件…',
        hint: `${file.name} · ${fileSize(file.size)}`,
      });
      try {
        const result = await importBookFile(file, {
          onProgress: importProgressHandler(file, index, files.length),
        });
        if (result.duplicate) duplicates.push(result.book);
        else imported.push(result.book);
      } catch (error) {
        console.error('导入失败', file.name, error);
        failures.push(`${file.name}：${error instanceof ImportError || error?.message ? error.message : '导入失败'}`);
      }
    }

    await refreshLibrary({ quiet: true });

    if (imported.length === 1 && files.length === 1 && !duplicates.length && !failures.length) {
      const book = imported[0];
      setImportProgress(1);
      el.importTitle.textContent = '已加入书架';
      el.importMessage.textContent = `《${book.title}》`;
      el.importHint.textContent = `${book.chapterCount} 章 · 自动识别完成`;
      await wait(520);
      await hideImportOverlay();
      openBook(book.id);
    } else {
      await hideImportOverlay();
      if (imported.length) {
        const extra = [];
        if (duplicates.length) extra.push(`${duplicates.length} 本已在书架`);
        if (failures.length) extra.push(`${failures.length} 个文件失败`);
        toast(`成功导入 ${imported.length} 本书${extra.length ? ` · ${extra.join(' · ')}` : ''}`, { type: 'success' });
      } else if (duplicates.length && !failures.length) {
        toast(duplicates.length === 1 ? `《${duplicates[0].title}》已经在书架里了` : `${duplicates.length} 本书已经在书架里了`);
      }
      if (failures.length) {
        toast(failures[0], { type: 'error', duration: 6200 });
      }
    }
  } finally {
    state.importing = false;
    if (!el.importOverlay.hidden && !el.importOverlay.classList.contains('is-visible')) {
      el.importOverlay.hidden = true;
    }
    el.fileInput.value = '';
  }
}

async function importSample() {
  if (state.importing) {
    toast('正在导入，请稍候…');
    return;
  }
  state.importing = true;
  showImportOverlay({
    title: '正在准备示例书',
    message: '正在排版章节…',
    hint: '《山寺的灯》 · 内置示例',
  });
  setImportProgress(0.2);
  try {
    const result = await importSampleBook({
      onProgress: ({ message, progress }) => {
        if (message) el.importMessage.textContent = message;
        if (Number.isFinite(Number(progress)) && Number(progress) > 0) setImportProgress(progress);
      },
    });
    await refreshLibrary({ quiet: true });
    if (result.duplicate) {
      await hideImportOverlay();
      toast('示例书已经在书架里了，正在为你打开');
      await openBook(result.book.id);
    } else {
      setImportProgress(1);
      el.importTitle.textContent = '示例书已就绪';
      el.importMessage.textContent = `《${result.book.title}》`;
      el.importHint.textContent = `${result.book.chapterCount} 章 · 自动识别完成`;
      await wait(460);
      await hideImportOverlay();
      openBook(result.book.id);
    }
  } catch (error) {
    console.error(error);
    await hideImportOverlay();
    toast(`示例书导入失败：${error.message || '未知错误'}`, { type: 'error' });
  } finally {
    state.importing = false;
  }
}

/* -------------------------------- cloud sync ------------------------------ */

function refreshSyncIndicators() {
  if (!el.syncButton) return;
  const session = loadCloudState().session;
  const online = navigator.onLine;
  el.syncButton.classList.toggle('is-signed-in', Boolean(session));
  el.syncButton.classList.toggle('is-offline', Boolean(session) && !online);
  el.syncButton.classList.toggle('is-syncing', state.syncBusy);
  if (el.syncButtonLabel) {
    el.syncButtonLabel.textContent = state.syncBusy
      ? '同步中…'
      : session
        ? accountLabel()
        : '登录同步';
  }
  el.syncButton.title = session
    ? `云端同步 · ${session.username} · ${prettyServer(session.server)}${online ? '' : ' · 当前离线'}`
    : '登录后可在设备之间同步阅读进度';
  const dot = el.syncButton.querySelector('.sync-dot');
  if (dot) {
    dot.classList.toggle('is-on', Boolean(session) && online && !state.syncBusy);
    dot.classList.toggle('is-warn', (Boolean(session) && !online) || state.syncBusy);
  }
}

function setAuthMode(mode, { resetError = true } = {}) {
  state.authMode = mode === 'register' ? 'register' : 'login';
  const registerMode = state.authMode === 'register';
  el.authModeButtons.forEach((button) => {
    const active = button.dataset.authMode === state.authMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (el.syncConfirmRow) el.syncConfirmRow.hidden = !registerMode;
  if (el.syncAuthSubmitLabel) el.syncAuthSubmitLabel.textContent = registerMode ? '创建并登录' : '登录';
  if (el.syncPassword) el.syncPassword.autocomplete = registerMode ? 'new-password' : 'current-password';
  if (resetError && el.syncAuthError) {
    el.syncAuthError.hidden = true;
    el.syncAuthError.textContent = '';
  }
}

function setAuthError(message) {
  if (!el.syncAuthError) return;
  el.syncAuthError.textContent = message || '';
  el.syncAuthError.hidden = !message;
}

function setAccountError(message) {
  if (!el.syncAccountError) return;
  el.syncAccountError.textContent = message || '';
  el.syncAccountError.hidden = !message;
}

function setServerStatus(kind, message) {
  state.serverState = kind;
  if (el.syncServerStatus) el.syncServerStatus.textContent = message;
  if (el.syncServerDot) {
    el.syncServerDot.classList.toggle('is-pending', kind === 'pending');
    el.syncServerDot.classList.toggle('is-ok', kind === 'ok');
    el.syncServerDot.classList.toggle('is-error', kind === 'error');
  }
}

function renderSyncDialog() {
  const cloud = loadCloudState();
  const session = cloud.session;
  const loggedIn = Boolean(session);
  if (el.syncLoggedOut) el.syncLoggedOut.hidden = loggedIn;
  if (el.syncLoggedIn) el.syncLoggedIn.hidden = !loggedIn;
  if (el.syncBookCount) {
    const count = state.books.filter((book) => book.progress).length;
    el.syncBookCount.textContent = `${count} 本阅读进度`;
  }
  if (el.syncLastAt) {
    el.syncLastAt.textContent = cloud.lastSyncAt ? `${timeAgo(cloud.lastSyncAt)}同步` : '从未同步';
  }
  if (loggedIn) {
    if (el.syncAvatar) el.syncAvatar.textContent = (session.username || '墨').slice(0, 1).toUpperCase();
    if (el.syncUsernameLabel) el.syncUsernameLabel.textContent = session.username;
    if (el.syncAccountServer) el.syncAccountServer.textContent = prettyServer(session.server);
    if (el.syncAutoToggle) {
      el.syncAutoToggle.classList.toggle('is-on', cloud.autoSync);
      el.syncAutoToggle.setAttribute('aria-checked', String(cloud.autoSync));
    }
    if (el.syncNowBtn) {
      el.syncNowBtn.disabled = state.syncBusy;
      el.syncNowBtn.textContent = state.syncBusy ? '正在同步…' : '立即同步';
    }
    if (el.syncServerInput) el.syncServerInput.value = session.server;
  } else {
    if (el.syncServerInput && !el.syncServerInput.value) {
      el.syncServerInput.value = getServer() || (location.protocol.startsWith('http') ? location.origin : '');
    }
    setAuthMode(state.authMode, { resetError: false });
    if (el.syncAuthSubmit) el.syncAuthSubmit.disabled = state.authBusy;
    if (el.syncAuthSubmitLabel) {
      el.syncAuthSubmitLabel.textContent = state.authBusy
        ? (state.authMode === 'register' ? '正在创建…' : '正在登录…')
        : (state.authMode === 'register' ? '创建并登录' : '登录');
    }
  }
  refreshSyncIndicators();
}

async function checkSyncServer() {
  if (!el.syncServerInput) return;
  const raw = el.syncServerInput.value.trim() || getServer();
  const token = ++state.serverCheckToken;
  if (el.syncRecheck) el.syncRecheck.disabled = true;
  if (!navigator.onLine) {
    setServerStatus('error', '当前离线，无法连接同步服务');
    if (el.syncRecheck) el.syncRecheck.disabled = false;
    return;
  }
  if (!raw) {
    setServerStatus('error', '请先填写同步服务器地址');
    if (el.syncRecheck) el.syncRecheck.disabled = false;
    return;
  }
  setServerStatus('pending', '正在连接同步服务…');
  const result = await checkServer(raw);
  if (token !== state.serverCheckToken) return;
  if (result.ok) {
    setServerStatus('ok', `同步服务已连接${result.version ? ` · v${result.version}` : ''}`);
  } else {
    setServerStatus('error', result.error || '无法连接同步服务');
  }
  if (el.syncRecheck) el.syncRecheck.disabled = false;
}

function clearAutoSyncTimer() {
  if (state.autoSyncTimer) clearTimeout(state.autoSyncTimer);
  state.autoSyncTimer = null;
}

function scheduleAutoSync(delay = AUTO_SYNC_DELAY) {
  clearAutoSyncTimer();
  if (!isLoggedIn() || !getAutoSync()) return;
  state.autoSyncTimer = setTimeout(() => {
    state.autoSyncTimer = null;
    if (navigator.onLine && !document.hidden) performSync({ quiet: true });
  }, Math.max(2000, delay));
}

async function performSync({ quiet = true } = {}) {
  if (!isLoggedIn()) {
    if (!quiet) openSyncDialog();
    return { ok: false };
  }
  if (!navigator.onLine) {
    refreshSyncIndicators();
    if (!quiet) {
      toast('当前处于离线状态，本地阅读不受影响', { type: 'error' });
      setAccountError('离线状态下无法同步，联网后会自动重试。');
    }
    return { ok: false };
  }
  state.syncBusy = true;
  setAccountError('');
  refreshSyncIndicators();
  renderSyncDialog();
  try {
    const result = await syncNow({ quiet });
    state.lastSyncAt = result.lastSyncAt;
    if (result.applied) await refreshLibrary({ quiet: true });
    if (result.settingsUpdated && !reader?.isOpen) {
      toast('阅读排版已从云端更新，下次打开书籍时生效', { type: 'success' });
    }
    if (!quiet) {
      if (result.applied || result.pending) {
        const notes = [];
        if (result.applied) notes.push(`恢复 ${result.applied} 本阅读进度`);
        if (result.pending) notes.push(`${result.pending} 本待导入`);
        toast(`同步完成 · ${notes.join(' · ')}`, { type: 'success' });
      } else {
        toast('同步完成，所有设备都是最新进度', { type: 'success' });
      }
    }
    setAccountError('');
    return { ok: true, result };
  } catch (error) {
    console.warn('同步失败', error);
    const unauthorized = error?.status === 401 || error?.code === 'unauthorized' || error?.code === 'not_logged_in';
    if (unauthorized) {
      refreshSyncIndicators();
      renderSyncDialog();
      toast('登录已过期，请重新登录云端账号', { type: 'error' });
    } else {
      if (!quiet) setAccountError(error.message || '同步失败，请稍后重试');
      if (!quiet) toast(error.message || '同步失败，请稍后重试', { type: 'error' });
    }
    return { ok: false, error };
  } finally {
    state.syncBusy = false;
    refreshSyncIndicators();
    renderSyncDialog();
    if (isLoggedIn() && getAutoSync()) scheduleAutoSync();
  }
}

function openSyncDialog() {
  renderSyncDialog();
  showDialog(el.syncDialog);
  checkSyncServer();
  if (!isLoggedIn()) {
    requestAnimationFrame(() => el.syncUsername?.focus({ preventScroll: true }));
  }
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (state.authBusy) return;
  const username = el.syncUsername.value.trim();
  const password = el.syncPassword.value;
  const confirm = el.syncConfirm.value;
  const server = el.syncServerInput.value.trim() || getServer();
  const registerMode = state.authMode === 'register';

  if (!username) {
    setAuthError('请输入用户名');
    el.syncUsername.focus();
    return;
  }
  if (username.length < 2 || username.length > 24) {
    setAuthError('用户名需为 2–24 个字符');
    el.syncUsername.focus();
    return;
  }
  if (password.length < 6) {
    setAuthError('密码至少需要 6 位');
    el.syncPassword.focus();
    return;
  }
  if (registerMode && password !== confirm) {
    setAuthError('两次输入的密码不一致');
    el.syncConfirm.focus();
    return;
  }

  state.authBusy = true;
  setAuthError('');
  if (el.syncAuthSubmit) el.syncAuthSubmit.disabled = true;
  if (el.syncAuthSubmitLabel) el.syncAuthSubmitLabel.textContent = registerMode ? '正在创建…' : '正在登录…';
  try {
    const session = registerMode
      ? await register({ username, password, server })
      : await login({ username, password, server });
    el.syncPassword.value = '';
    el.syncConfirm.value = '';
    state.authMode = 'login';
    toast(`已登录，${session.username}`, { type: 'success' });
    renderSyncDialog();
    await performSync({ quiet: false });
  } catch (error) {
    setAuthError(error.message || '登录失败，请稍后重试');
  } finally {
    state.authBusy = false;
    if (el.syncAuthSubmit) el.syncAuthSubmit.disabled = false;
    renderSyncDialog();
  }
}

async function handleServerSave() {
  let normalized;
  try {
    normalized = normalizeServer(el.syncServerInput.value);
  } catch (error) {
    toast(error.message || '服务器地址格式不正确', { type: 'error' });
    el.syncServerInput.focus();
    return;
  }
  const current = loadCloudState().session;
  if (current && current.server !== normalized) {
    const confirmed = await confirmDialog({
      title: '切换同步服务器？',
      message: '切换后需要在新服务器上重新登录，本地书架和进度不会丢失。',
      confirmText: '切换',
    });
    if (!confirmed) return;
  }
  await changeServer(normalized);
  renderSyncDialog();
  setServerStatus('pending', '正在连接同步服务…');
  toast(isLoggedIn() ? '服务器地址已保存' : '服务器地址已保存，请登录或注册');
  checkSyncServer();
}

async function handleLogout() {
  const confirmed = await confirmDialog({
    title: '退出云端账号？',
    message: '本地书籍与阅读进度会保留，但此后不会再自动同步，直到重新登录。',
    confirmText: '退出登录',
  });
  if (!confirmed) return;
  clearAutoSyncTimer();
  await logout();
  renderSyncDialog();
  setAccountError('');
  setServerStatus('idle', '已退出账号');
  toast('已退出云端账号');
}

/* ---------------------------------- PWA ---------------------------------- */

function setupInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredInstall = event;
    if (el.installBtn) {
      el.installBtn.hidden = false;
      el.installBtn.title = '安装墨阅到桌面';
    }
  });

  window.addEventListener('appinstalled', () => {
    state.deferredInstall = null;
    if (el.installBtn) el.installBtn.hidden = true;
    toast('墨阅已安装到桌面', { type: 'success' });
  });

  el.installBtn?.addEventListener('click', async () => {
    if (!state.deferredInstall) return;
    const prompt = state.deferredInstall;
    state.deferredInstall = null;
    el.installBtn.hidden = true;
    prompt.prompt();
    try {
      const choice = await prompt.userChoice;
      if (choice?.outcome === 'accepted') toast('正在安装墨阅…', { type: 'success' });
      else toast('随时可以通过浏览器菜单安装到桌面');
    } catch {
      /* the browser may dismiss the prompt */
    }
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            toast('墨阅有新版本，下次打开时自动使用离线缓存', { duration: 5000 });
          }
        });
      });
    } catch (error) {
      console.warn('Service worker 注册失败', error);
    }
  });
}

/* ------------------------------- event wiring ----------------------------- */

function bindLibraryEvents() {
  el.bookGrid?.addEventListener('click', (event) => {
    const menu = event.target.closest('[data-book-menu]');
    if (menu) {
      event.preventDefault();
      openBookDialog(menu.dataset.bookMenu);
      return;
    }
    const open = event.target.closest('[data-open-book]');
    if (open) {
      event.preventDefault();
      openBook(open.dataset.openBook);
    }
  });

  el.continueCard?.addEventListener('click', () => {
    const id = el.continueCard.dataset.bookId;
    if (id) openBook(id);
  });

  el.importButton?.addEventListener('click', () => el.fileInput.click());
  el.emptyImportBtn?.addEventListener('click', () => el.fileInput.click());
  el.sampleBtn?.addEventListener('click', importSample);

  el.fileInput?.addEventListener('change', () => {
    if (el.fileInput.files?.length) handleFiles(el.fileInput.files);
  });

  el.filterChips?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    renderBooks();
  });

  el.librarySort?.addEventListener('change', () => {
    state.sort = el.librarySort.value;
    renderBooks();
  });

  el.librarySearch?.addEventListener('input', () => {
    state.query = el.librarySearch.value;
    renderBooks();
  });

  el.clearFilters?.addEventListener('click', () => {
    state.query = '';
    state.filter = 'all';
    if (el.librarySearch) el.librarySearch.value = '';
    renderBooks();
    el.librarySearch?.focus();
  });

  el.syncButton?.addEventListener('click', openSyncDialog);
  el.helpButton?.addEventListener('click', () => showDialog(el.helpDialog));
  el.footerHelp?.addEventListener('click', () => showDialog(el.helpDialog));

  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => hideDialog(button.closest('dialog')));
  });
  [el.syncDialog, el.bookDialog, el.helpDialog].forEach((dialog) => {
    dialog?.addEventListener('click', (event) => {
      if (event.target === dialog) hideDialog(dialog);
    });
  });
}

function bindSyncEvents() {
  el.authModeButtons.forEach((button) => {
    button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
  });
  el.syncAuthForm?.addEventListener('submit', handleAuthSubmit);
  el.syncRecheck?.addEventListener('click', checkSyncServer);
  el.syncServerSave?.addEventListener('click', handleServerSave);
  el.syncServerInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleServerSave();
    }
  });
  el.syncNowBtn?.addEventListener('click', () => performSync({ quiet: false }));
  el.syncLogoutBtn?.addEventListener('click', handleLogout);
  el.syncAutoToggle?.addEventListener('click', () => {
    const enabled = !getAutoSync();
    setAutoSync(enabled);
    renderSyncDialog();
    if (enabled) {
      toast('已开启自动同步', { type: 'success' });
      scheduleAutoSync(1500);
    } else {
      toast('已关闭自动同步');
      clearAutoSyncTimer();
    }
  });
  el.bookDialogContinue?.addEventListener('click', () => {
    const id = state.activeBookId;
    hideDialog(el.bookDialog);
    if (id) openBook(id);
  });
  el.bookDialogRestart?.addEventListener('click', restartActiveBook);
  el.bookDialogDelete?.addEventListener('click', deleteActiveBook);
}

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    if (reader?.isOpen) return;
    if (document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && event.target === el.librarySearch) {
      if (state.query) {
        state.query = '';
        el.librarySearch.value = '';
        renderBooks();
      } else {
        el.librarySearch.blur();
      }
      event.preventDefault();
      return;
    }
    if (isEditable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === '/') {
      event.preventDefault();
      el.librarySearch?.focus();
      el.librarySearch?.select();
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      showDialog(el.helpDialog);
    }
  });
}

function bindDropZone() {
  let depth = 0;
  const showsFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragenter', (event) => {
    if (!showsFiles(event)) return;
    event.preventDefault();
    depth += 1;
    if (el.dropOverlay && !reader?.isOpen) el.dropOverlay.hidden = false;
  });
  document.addEventListener('dragover', (event) => {
    if (!showsFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    event.preventDefault();
    depth = Math.max(0, depth - 1);
    if (!depth && el.dropOverlay) el.dropOverlay.hidden = true;
  });
  document.addEventListener('drop', (event) => {
    if (!showsFiles(event)) return;
    event.preventDefault();
    depth = 0;
    if (el.dropOverlay) el.dropOverlay.hidden = true;
    if (event.dataTransfer?.files?.length) handleFiles(event.dataTransfer.files);
  });
  window.addEventListener('dragend', () => {
    depth = 0;
    if (el.dropOverlay) el.dropOverlay.hidden = true;
  });
}

function bindNetworkEvents() {
  const update = () => {
    document.body.classList.toggle('is-offline', !navigator.onLine);
    refreshSyncIndicators();
  };
  window.addEventListener('online', () => {
    update();
    toast('网络已恢复', { type: 'success' });
    if (isLoggedIn() && getAutoSync()) scheduleAutoSync(1200);
  });
  window.addEventListener('offline', () => {
    update();
    toast('网络已断开，阅读和本地进度保存不受影响');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (isLoggedIn() && getAutoSync()) {
      const last = loadCloudState().lastSyncAt || 0;
      if (Date.now() - last > AUTO_SYNC_INTERVAL) performSync({ quiet: true });
    }
  });
  setInterval(() => {
    if (document.hidden || !navigator.onLine) return;
    if (!isLoggedIn() || !getAutoSync()) return;
    const last = loadCloudState().lastSyncAt || 0;
    if (Date.now() - last > AUTO_SYNC_INTERVAL) performSync({ quiet: true });
  }, AUTO_SYNC_INTERVAL);
  update();
}

function initReader() {
  reader = new Reader(el.readerView, {
    onClose: async (book) => {
      await refreshLibrary({ quiet: true });
      const id = book?.id || '';
      const target = id ? el.bookGrid?.querySelector(`[data-open-book="${id}"]`) : null;
      (target || el.continueCard || el.librarySearch)?.focus?.({ preventScroll: true });
      if (isLoggedIn() && getAutoSync()) scheduleAutoSync(4000);
    },
    onProgressSaved: (progress) => {
      const book = state.books.find((item) => item.id === progress.bookId);
      if (book) {
        book.progress = progress;
        updateContinueCard();
        updateLibraryStats();
      }
      if (isLoggedIn() && getAutoSync()) scheduleAutoSync();
    },
    onHelp: () => showDialog(el.helpDialog),
  });

  setupNativeBackButton();

  window.addEventListener('moread:progress', () => {
    if (isLoggedIn() && getAutoSync()) scheduleAutoSync();
  });
  window.addEventListener('moread:cloud', () => {
    refreshSyncIndicators();
    if (el.syncDialog?.open) renderSyncDialog();
  });
}

function setupNativeBackButton() {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.() || typeof capacitor.registerPlugin !== 'function') return;
  try {
    const App = capacitor.registerPlugin('App');
    if (!App?.addListener) return;
    const ready = App.addListener('backButton', () => {
      const dialog = document.querySelector('dialog[open]');
      if (dialog) {
        hideDialog(dialog);
        return;
      }
      if (reader?.isOpen && reader.handleNativeBack()) return;
      Promise.resolve(App.minimizeApp?.()).catch(() => {});
    });
    Promise.resolve(ready).catch(() => {});
  } catch (error) {
    console.warn('原生返回键不可用', error);
  }
}

async function init() {
  cacheDom();
  bindLibraryEvents();
  bindSyncEvents();
  bindKeyboard();
  bindDropZone();
  bindNetworkEvents();
  setupInstall();
  registerServiceWorker();
  initReader();
  setAuthMode('login');
  renderLibrary();
  await refreshLibrary();
  refreshSyncIndicators();

  if (!state.books.length && 'requestIdleCallback' in window) {
    requestIdleCallback(() => {
      // Warm up IndexedDB connections and the sample parser only when idle.
      listBooksWithProgress().catch(() => {});
    }, { timeout: 3000 });
  }

  if (isLoggedIn() && getAutoSync()) {
    const last = loadCloudState().lastSyncAt || 0;
    if (Date.now() - last > AUTO_SYNC_INTERVAL) scheduleAutoSync(2600);
  }
}

init().catch((error) => {
  console.error(error);
  toast(`应用初始化失败：${error.message || '未知错误'}`, { type: 'error', duration: 8000 });
});
