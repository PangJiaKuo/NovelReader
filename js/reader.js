/* The reading engine: pagination, typography, TOC, bookmarks and search. */

import {
  addBookmark,
  getBookmarks,
  getChapter,
  getChapters,
  getProgress,
  removeBookmark,
  saveProgress,
} from './store.js';
import {
  applyReaderSettings,
  DEFAULT_SETTINGS,
  FONT_CHOICES,
  loadSettings,
  sanitizeSettings,
  THEMES,
  updateSettings,
} from './settings.js';
import {
  clamp,
  debounce,
  delay,
  isEditable,
  nextFrame,
  normalizeWhitespace,
  uid,
} from './util.js';
import { confirmDialog, toast } from './ui.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const PAGE_GAP = 80;
const BASE_TITLE = '墨阅 · 私人阅读空间';

export class Reader {
  constructor(root, { onClose, onProgressSaved, onHelp } = {}) {
    this.root = root;
    this.onClose = onClose || (() => {});
    this.onProgressSaved = onProgressSaved || (() => {});
    this.onHelp = onHelp || (() => {});

    this.isOpen = false;
    this.closing = false;
    this.book = null;
    this.chaptersMeta = [];
    this.chapterCount = 0;
    this.totalChars = 0;
    this.chapterOffsets = [];
    this.progress = null;
    this.settings = loadSettings();
    this.chapterIndex = 0;
    this.chapter = null;
    this.chapterCache = new Map();
    this.pageCount = 1;
    this.pageIndex = 0;
    this.pageWidth = 0;
    this.columnGap = PAGE_GAP;
    this.readingTime = 0;
    this.lastReadingTick = 0;
    this.clock = null;
    this.renderToken = 0;
    this.isLoading = false;
    this.activePanel = null;
    this.panelTab = 'toc';
    this.bookmarks = [];
    this.chromeHidden = false;
    this.searchCorpus = null;
    this.searchToken = 0;
    this.searchQuery = '';
    this.suppressClickUntil = 0;
    this.touchStart = null;
    this.pointerType = 'mouse';
    this.wheelLock = 0;
    this.preloadTimer = null;
    this.finishedNotified = false;
    this.completed = false;
    this.loadingTimer = null;

    this.progressSaveDebounced = debounce(() => this.flushProgress(), 500);
    this.settingsSaveDebounced = debounce(() => {
      if (!this.isOpen) return;
      this.settings = updateSettings(this.settings, {}, { notify: false });
    }, 250);
    this.reflowDebounced = debounce(() => this.reflowPreservingPosition(), 140);
    this.scrollUpdateDebounced = debounce(() => this.updateProgressUI(), 100);
    this.searchDebounced = debounce(() => this.runSearch(this.dom.searchInput.value), 260);

    this.cacheDom();
    this.page = this.dom.page;
    this.content = this.dom.content;
    this.viewport = this.dom.viewport;
    this.buildAppearanceControls();
    this.bindEvents();
  }

  cacheDom() {
    const ids = {
      viewport: 'readerViewport',
      page: 'readerPage',
      content: 'readerContent',
      chapterEnd: 'chapterEnd',
      chapterEndNext: 'chapterEndNext',
      top: 'readerTop',
      bottom: 'readerBottom',
      back: 'readerBack',
      bookTitle: 'readerBookTitle',
      chapterLabel: 'readerChapterLabel',
      pageLabel: 'readerPageLabel',
      percent: 'readerPercent',
      progressFill: 'readerProgressFill',
      pagePrev: 'pagePrev',
      pageNext: 'pageNext',
      loading: 'readerLoading',
      loadingText: 'readerLoadingText',
      hiddenHint: 'readerHiddenHint',
      tocBtn: 'readerTocBtn',
      tocBtnBottom: 'readerTocBottom',
      searchBtn: 'readerSearchBtn',
      bookmarkBtn: 'readerBookmarkBtn',
      settingsBtn: 'readerSettingsBtn',
      settingsBtnBottom: 'readerSettingsBottom',
      fullscreenBtn: 'readerFullscreenBtn',
      tocPanel: 'tocPanel',
      settingsPanel: 'settingsPanel',
      scrim: 'panelScrim',
      tocList: 'tocList',
      tocFilter: 'tocFilter',
      tocFilterRow: 'tocFilterRow',
      tocFooter: 'tocFooter',
      tocTabs: 'tocTabs',
      bookmarkList: 'bookmarkList',
      bookmarkAddBtn: 'bookmarkAddBtn',
      searchOverlay: 'searchOverlay',
      searchInput: 'searchInput',
      searchResults: 'searchResults',
      searchStatus: 'searchStatus',
      searchClose: 'searchClose',
      searchClear: 'searchClear',
      themeGrid: 'themeGrid',
      fontGrid: 'fontGrid',
      fontSizeRange: 'fontSizeRange',
      fontSizeValue: 'fontSizeValue',
      fontSizeMinus: 'fontSizeMinus',
      fontSizePlus: 'fontSizePlus',
      lineHeightRange: 'lineHeightRange',
      lineHeightValue: 'lineHeightValue',
      letterSpacingRange: 'letterSpacingRange',
      letterSpacingValue: 'letterSpacingValue',
      pagePadRange: 'pagePadRange',
      pagePadValue: 'pagePadValue',
      maxWidthRange: 'maxWidthRange',
      maxWidthValue: 'maxWidthValue',
      maxWidthRow: 'maxWidthRow',
      paragraphSpacingRange: 'paragraphSpacingRange',
      paragraphSpacingValue: 'paragraphSpacingValue',
      customBgInput: 'customBgInput',
      customTextInput: 'customTextInput',
      modePaged: 'modePaged',
      modeScroll: 'modeScroll',
      toggleIndent: 'toggleIndent',
      toggleJustify: 'toggleJustify',
      toggleAnimation: 'toggleAnimation',
      resetAppearance: 'resetAppearance',
      helpBtn: 'readerHelpBtn',
    };
    this.dom = {};
    for (const [key, id] of Object.entries(ids)) {
      this.dom[key] = document.getElementById(id);
    }
  }

  buildAppearanceControls() {
    const themeGrid = this.dom.themeGrid;
    if (themeGrid) {
      themeGrid.replaceChildren();
      for (const theme of THEMES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'theme-option';
        button.dataset.theme = theme.id;
        button.title = theme.name;
        const dot = document.createElement('span');
        dot.className = 'theme-swatch';
        if (theme.id === 'custom') {
          dot.style.background = 'linear-gradient(135deg, var(--reader-bg) 48%, var(--reader-text) 52%)';
          dot.style.borderColor = 'color-mix(in srgb, var(--reader-text) 30%, transparent)';
        } else {
          dot.style.background = theme.bg;
          dot.style.borderColor = theme.isDark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.12)';
          dot.style.color = theme.text;
          dot.textContent = '文';
        }
        const label = document.createElement('span');
        label.textContent = theme.name;
        button.append(dot, label);
        themeGrid.append(button);
      }
    }

    const fontGrid = this.dom.fontGrid;
    if (fontGrid) {
      fontGrid.replaceChildren();
      for (const font of FONT_CHOICES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'font-option';
        button.dataset.font = font.id;
        button.style.fontFamily = font.stack;
        button.title = font.name;
        button.textContent = font.sample;
        const label = document.createElement('span');
        label.textContent = font.name;
        label.style.fontFamily = 'var(--ui-font)';
        button.append(label);
        fontGrid.append(button);
      }
    }
  }

  bindEvents() {
    const { dom } = this;
    dom.back?.addEventListener('click', () => this.close());
    dom.tocBtn?.addEventListener('click', () => this.togglePanel('toc'));
    dom.tocBtnBottom?.addEventListener('click', () => this.togglePanel('toc'));
    dom.settingsBtn?.addEventListener('click', () => this.togglePanel('settings'));
    dom.settingsBtnBottom?.addEventListener('click', () => this.togglePanel('settings'));
    dom.searchBtn?.addEventListener('click', () => this.openSearch());
    dom.bookmarkBtn?.addEventListener('click', () => this.toggleBookmark());
    dom.fullscreenBtn?.addEventListener('click', () => this.toggleFullscreen());
    dom.hiddenHint?.addEventListener('click', () => this.setChromeHidden(false));
    dom.scrim?.addEventListener('click', () => this.closePanels());
    dom.chapterEndNext?.addEventListener('click', () => this.goToChapter(this.chapterIndex + 1));
    dom.bookmarkAddBtn?.addEventListener('click', () => this.toggleBookmark(true));

    $$('[data-close-panel]', this.root).forEach((button) => {
      button.addEventListener('click', () => this.closePanels());
    });

    dom.pagePrev?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.prevAction();
    });
    dom.pageNext?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.nextAction();
    });

    this.dom.viewport?.addEventListener('click', (event) => this.handleTap(event));
    this.dom.viewport?.addEventListener('wheel', (event) => this.handleWheel(event), { passive: true });
    this.dom.viewport?.addEventListener('pointerdown', (event) => {
      this.pointerType = event.pointerType || 'mouse';
    });
    this.dom.viewport?.addEventListener('touchstart', (event) => this.handleTouchStart(event), { passive: true });
    this.dom.viewport?.addEventListener('touchend', (event) => this.handleTouchEnd(event), { passive: true });
    this.dom.page?.addEventListener('scroll', () => {
      if (!this.isOpen || this.settings.mode !== 'scroll') return;
      if (this.completed) {
        const max = Math.max(0, this.page.scrollHeight - this.page.clientHeight);
        if (max - this.page.scrollTop > 2) this.completed = false;
      }
      this.scrollUpdateDebounced();
      this.scheduleSave();
    });
    this.dom.content?.addEventListener('click', (event) => this.handleContentClick(event));

    dom.tocTabs?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-panel-tab]');
      if (button) this.setPanelTab(button.dataset.panelTab);
    });
    dom.tocFilter?.addEventListener('input', () => this.filterToc());
    dom.tocList?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-chapter-index]');
      if (!button) return;
      const index = Number(button.dataset.chapterIndex);
      this.closePanels();
      this.goToChapter(index);
    });

    dom.bookmarkList?.addEventListener('click', async (event) => {
      const deleteButton = event.target.closest('[data-delete-bookmark]');
      if (deleteButton) {
        event.stopPropagation();
        await this.deleteBookmark(deleteButton.dataset.deleteBookmark);
        return;
      }
      const jump = event.target.closest('[data-bookmark-id]');
      if (!jump) return;
      const bookmark = this.bookmarks.find((item) => item.id === jump.dataset.bookmarkId);
      if (!bookmark) return;
      this.closePanels();
      this.goToChapter(bookmark.chapterIndex, { ratio: bookmark.chapterRatio });
    });

    dom.searchClose?.addEventListener('click', () => this.closeSearch());
    dom.searchClear?.addEventListener('click', () => {
      dom.searchInput.value = '';
      dom.searchInput.focus();
      this.runSearch('');
    });
    dom.searchOverlay?.addEventListener('click', (event) => {
      if (event.target === dom.searchOverlay) this.closeSearch();
    });
    dom.searchInput?.addEventListener('input', () => this.searchDebounced());
    dom.searchInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeSearch();
      } else if (event.key === 'Enter') {
        const first = dom.searchResults?.querySelector('[data-search-index]');
        if (first) first.click();
      }
    });
    dom.searchResults?.addEventListener('click', (event) => {
      const item = event.target.closest('[data-search-index]');
      if (!item) return;
      const index = Number(item.dataset.searchIndex);
      const occurrence = Number(item.dataset.searchOccurrence) || 0;
      const query = this.searchQuery;
      this.closeSearch();
      this.goToChapter(index, { query, occurrence });
    });

    dom.settingsPanel?.addEventListener('click', (event) => this.handleAppearanceClick(event));
    dom.settingsPanel?.addEventListener('input', (event) => this.handleAppearanceInput(event));
    dom.helpBtn?.addEventListener('click', () => this.onHelp());
    dom.resetAppearance?.addEventListener('click', () => this.resetAppearanceSettings());

    document.addEventListener('keydown', (event) => this.handleKeydown(event));
    document.addEventListener('visibilitychange', () => {
      if (!this.isOpen) return;
      if (document.hidden) {
        this.accrueReadingTime();
        this.lastReadingTick = 0;
        this.flushProgress();
      } else {
        this.lastReadingTick = Date.now();
      }
    });
    window.addEventListener('pagehide', () => {
      if (!this.isOpen) return;
      this.accrueReadingTime();
      this.flushProgress();
    });
    window.addEventListener('beforeunload', () => {
      if (!this.isOpen) return;
      this.accrueReadingTime();
      this.flushProgress();
    });
    document.addEventListener('fullscreenchange', () => {
      if (!this.isOpen) return;
      const active = Boolean(document.fullscreenElement);
      this.dom.fullscreenBtn?.classList.toggle('is-active', active);
      if (active) this.setChromeHidden(true);
      else this.setChromeHidden(false);
    });
    window.addEventListener('resize', () => this.reflowDebounced());
    window.addEventListener('moread:settings', (event) => {
      if (!this.isOpen || !event.detail) return;
      const next = sanitizeSettings(event.detail);
      if (next.updatedAt <= this.settings.updatedAt + 500) return;
      const previousMode = this.settings.mode;
      const ratio = this.currentRatio();
      this.settings = next;
      applyReaderSettings(this.root, this.settings);
      this.syncAppearanceControls();
      if (previousMode !== next.mode) this.applyModeWithRatio(ratio);
      else this.reflowDebounced();
      toast('阅读设置已从云端更新');
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.reflowDebounced());
      this.resizeObserver.observe(this.dom.viewport);
    }

    this.dom.tocPanel?.querySelectorAll('[data-panel-tab]').forEach((button) => {
      button.setAttribute('aria-selected', button.classList.contains('is-active') ? 'true' : 'false');
    });
  }

  /* ------------------------------ opening ------------------------------ */

  async open(book) {
    if (!book) return;
    this.isOpen = true;
    this.closing = false;
    this.book = book;
    this.progress = await getProgress(book.id).catch((error) => {
      console.warn('读取阅读进度失败', error);
      return null;
    });
    this.bookmarks = await getBookmarks(book.id).catch((error) => {
      console.warn('读取书签失败', error);
      return [];
    });

    this.chapterCache.clear();
    this.searchCorpus = null;
    this.chapter = null;
    this.chapterIndex = 0;
    this.pageCount = 1;
    this.pageIndex = 0;
    this.searchedQuery = '';
    this.searchQuery = '';
    this.searchCorpus = null;
    this.finishedNotified = Boolean(this.progress?.finished);
    this.completed = Boolean(this.progress?.finished);

    this.settings = loadSettings();
    this.chapterCount = Math.max(1, book.chapterCount || book.chaptersMeta?.length || 1);
    this.chaptersMeta = Array.isArray(book.chaptersMeta) && book.chaptersMeta.length
      ? book.chaptersMeta
      : Array.from({ length: this.chapterCount }, (_, index) => ({ title: `第 ${index + 1} 章`, chars: 0 }));
    this.chapterCount = this.chaptersMeta.length;
    this.buildChapterOffsets();

    this.readingTime = Math.max(0, Number(this.progress?.readingTime) || 0);
    this.lastReadingTick = Date.now();
    this.finishedNotified = Boolean(this.progress?.finished);

    applyReaderSettings(this.root, this.settings);
    this.syncAppearanceControls();
    this.root.hidden = false;
    this.root.setAttribute('aria-hidden', 'false');
    this.root.classList.add('is-visible');
    const appShell = document.getElementById('app');
    if (appShell) {
      appShell.inert = true;
    }
    this.root.scrollLeft = 0;
    document.body.classList.add('reader-open');
    this.dom.bookTitle.textContent = book.title || '未命名书籍';
    this.dom.chapterLabel.textContent = '';
    this.updateModeUI();
    this.closePanels(true);
    this.closeSearch(true);
    this.setChromeHidden(false);

    const startChapter = clamp(Number(this.progress?.chapterIndex) || 0, 0, this.chapterCount - 1);
    const startRatio = this.restoreRatio(this.progress, startChapter);
    this.root.classList.add('is-visible');
    await nextFrame();
    await nextFrame();
    await this.renderChapter(startChapter, { ratio: startRatio, initial: true });
    this.startClock();
    this.dom.viewport?.focus({ preventScroll: true });
  }

  async close() {
    if (!this.isOpen || this.closing) return;
    this.closing = true;
    this.settingsSaveDebounced.flush?.();
    this.accrueReadingTime();
    this.progressSaveDebounced.cancel();
    await this.flushProgress({ force: true });
    this.stopClock();
    this.renderToken += 1;
    this.searchToken += 1;
    this.closePanels(true);
    this.closeSearch(true);
    this.isOpen = false;
    this.root.classList.remove('is-visible');
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /* ignore */ }
    }
    document.body.classList.remove('reader-open');
    const activeElement = document.activeElement;
    if (activeElement && this.root.contains(activeElement) && typeof activeElement.blur === 'function') {
      activeElement.blur();
    }
    this.root.setAttribute('aria-hidden', 'true');
    const appShell = document.getElementById('app');
    if (appShell) {
      appShell.inert = false;
    }
    const finishedBook = this.book;
    setTimeout(() => {
      if (!this.isOpen) this.root.hidden = true;
    }, 180);
    this.root.hidden = false;
    this.closing = false;
    document.title = BASE_TITLE;
    this.onClose(finishedBook);
  }

  restoreRatio(progress, chapterIndex) {
    if (!progress || Number(progress.chapterIndex) !== chapterIndex) return 0;
    if (Number.isFinite(Number(progress.chapterRatio))) {
      return clamp(Number(progress.chapterRatio), 0, 1);
    }
    if (Number.isFinite(Number(progress.pageRatio)) && Number.isFinite(Number(progress.pageCount)) && progress.pageCount > 0) {
      return clamp(Number(progress.pageRatio), 0, 1);
    }
    if (Number.isFinite(Number(progress.scrollRatio))) {
      return clamp(Number(progress.scrollRatio), 0, 1);
    }
    return 0;
  }

  buildChapterOffsets() {
    this.chapterOffsets = [0];
    let total = 0;
    for (const meta of this.chaptersMeta) {
      total += Math.max(0, Number(meta.chars) || 0);
      this.chapterOffsets.push(total);
    }
    this.totalChars = Math.max(total, Number(this.book?.chars) || 0);
  }

  startClock() {
    this.stopClock();
    this.clock = setInterval(() => {
      if (!this.isOpen || document.hidden) return;
      this.accrueReadingTime();
      this.scheduleSave(200);
    }, 30000);
  }

  stopClock() {
    if (this.clock) clearInterval(this.clock);
    this.clock = null;
    if (this.preloadTimer) clearTimeout(this.preloadTimer);
    this.preloadTimer = null;
  }

  accrueReadingTime() {
    if (!this.lastReadingTick) {
      this.lastReadingTick = Date.now();
      return;
    }
    const delta = Date.now() - this.lastReadingTick;
    this.lastReadingTick = Date.now();
    if (delta > 0 && delta < 120000) this.readingTime += delta;
  }

  /* ----------------------------- rendering ----------------------------- */

  chapterMeta(index) {
    return this.chaptersMeta[index] || { title: `第 ${index + 1} 章`, chars: 0 };
  }

  async getChapterRecord(index) {
    if (this.chapterCache.has(index)) {
      const cached = this.chapterCache.get(index);
      this.chapterCache.delete(index);
      this.chapterCache.set(index, cached);
      return cached;
    }
    const chapter = await getChapter(this.book.id, index);
    if (!chapter) throw new Error('章节内容不存在，文件可能已损坏');
    this.chapterCache.set(index, chapter);
    while (this.chapterCache.size > 6) {
      const oldest = this.chapterCache.keys().next().value;
      if (oldest === this.chapterIndex) break;
      this.chapterCache.delete(oldest);
    }
    return chapter;
  }

  async renderChapter(index, options = {}) {
    if (!this.isOpen || !this.book) return;
    index = clamp(index, 0, this.chapterCount - 1);
    if (!options.initial) this.completed = false;
    this.setLoading(true, '正在翻开这一章…');
    const token = ++this.renderToken;
    const meta = this.chapterMeta(index);
    this.dom.chapterLabel.textContent = meta.title || '';

    let chapter;
    try {
      chapter = await this.getChapterRecord(index);
    } catch (error) {
      if (token !== this.renderToken) return;
      this.setLoading(false);
      toast(error.message || '章节加载失败', { type: 'error' });
      if (!this.chapter) {
        this.content.innerHTML = '<div class="reader-error"><p>无法加载这一章。</p><p>请返回书架重试。</p></div>';
      }
      return;
    }
    if (token !== this.renderToken || !this.isOpen) return;

    this.chapterIndex = index;
    this.chapter = chapter;
    this.pageIndex = 0;
    this.pageCount = 1;
    this.content.style.transition = 'none';
    this.content.style.transform = 'translate3d(0, 0, 0)';
    this.page.scrollTop = 0;
    this.dom.chapterLabel.textContent = chapter.title || meta.title;
    this.updateChapterUI();
    this.content.innerHTML = chapter.html || '<p class="empty-chapter">（本章暂无内容）</p>';
    this.content.querySelectorAll('img').forEach((img) => {
      img.loading = 'eager';
      img.decoding = 'async';
    });

    await this.waitForContent(token);
    if (token !== this.renderToken || !this.isOpen) return;

    if (this.settings.mode === 'paged') {
      this.paginate();
    } else {
      await nextFrame();
    }

    let targetRatio = clamp(Number(options.ratio) || 0, 0, 1);
    if (options.position === 'end') targetRatio = 1;
    else if (options.position === 'start') targetRatio = 0;

    if (this.settings.mode === 'paged') {
      this.setPage(Math.round(targetRatio * (this.pageCount - 1)), {
        animate: false,
        silent: true,
        save: false,
      });
    } else {
      await this.setScrollRatio(targetRatio, { end: options.position === 'end' });
    }

    if (options.anchor) {
      await this.goToAnchor(options.anchor, { animate: false });
    } else if (options.query) {
      await this.locateText(options.query, Number(options.occurrence) || 0);
    }

    if (token !== this.renderToken) return;
    this.setLoading(false);
    this.updateProgressUI();
    this.scheduleSave();
    this.preloadAround(index);
    if (options.initial) this.root.classList.add('is-visible');
  }

  async waitForContent(token) {
    const images = Array.from(this.content.querySelectorAll('img'));
    const pending = images
      .filter((image) => !image.complete)
      .map((image) => new Promise((resolve) => {
        const done = () => {
          image.removeEventListener('load', done);
          image.removeEventListener('error', done);
          resolve();
        };
        image.addEventListener('load', done, { once: true });
        image.addEventListener('error', done, { once: true });
      }));
    await Promise.race([Promise.all(pending), delay(2200)]);
    if (typeof document.fonts?.ready?.then === 'function') {
      await Promise.race([document.fonts.ready, delay(700)]);
    }
    await nextFrame();
    await nextFrame();
  }

  updateChapterUI() {
    const meta = this.chapterMeta(this.chapterIndex);
    this.dom.chapterLabel.textContent = this.chapter?.title || meta.title;
    const nextMeta = this.chaptersMeta[this.chapterIndex + 1];
    if (this.dom.chapterEndNext) {
      this.dom.chapterEndNext.disabled = !nextMeta;
      this.dom.chapterEndNext.textContent = nextMeta ? '继续下一章' : '全书完';
    }
    this.dom.chapterEnd?.classList.toggle('is-last', !nextMeta);
    this.root.setAttribute('data-chapter-mode', this.settings.mode);
    this.documentTitle();
    this.updateBookmarkButton();
    this.dom.viewport?.setAttribute('aria-label', `${this.book?.title || ''} ${meta.title || ''} 阅读区`);
  }

  documentTitle() {
    if (!this.book) return;
    const title = this.chapter?.title || this.chapterMeta(this.chapterIndex).title;
    document.title = `${title} · ${this.book.title} · 墨阅`;
  }

  paginate() {
    if (!this.content || this.settings.mode !== 'paged') return;
    this.content.style.transition = 'none';
    this.content.style.transform = 'translate3d(0, 0, 0)';
    // Each CSS column must be exactly one page wide. Measure the content box
    // first, then pin the column width before reading scrollWidth.
    const width = Math.max(1, this.content.clientWidth);
    this.content.style.columnWidth = `${width}px`;
    this.content.style.columnGap = `${PAGE_GAP}px`;
    // Force column layout before measuring.
    void this.content.offsetWidth;
    const styles = getComputedStyle(this.content);
    const gap = Number.parseFloat(styles.columnGap) || PAGE_GAP;
    const scrollWidth = Math.max(width, this.content.scrollWidth);
    const pages = Math.max(1, Math.round((scrollWidth + gap) / (width + gap)));
    this.pageWidth = width;
    this.columnGap = gap;
    this.pageCount = pages;
    this.pageIndex = clamp(this.pageIndex, 0, pages - 1);
    this.applyPageTransform(false);
  }

  applyPageTransform(animate = false) {
    if (!this.content) return;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const useAnimation = animate && this.settings.pageAnimation && !reduceMotion;
    this.content.style.transition = useAnimation
      ? 'transform .3s cubic-bezier(.22, .61, .36, 1)'
      : 'none';
    const offset = this.pageIndex * (this.pageWidth + this.columnGap);
    this.content.style.transform = `translate3d(${-offset}px, 0, 0)`;
  }

  setPage(index, { animate = false, silent = false, save = true } = {}) {
    const next = clamp(index, 0, Math.max(0, this.pageCount - 1));
    const changed = next !== this.pageIndex;
    if (this.completed && next < this.pageCount - 1) this.completed = false;
    this.pageIndex = next;
    this.applyPageTransform(animate);
    if (!silent) this.updateProgressUI();
    if (save && (changed || !silent)) this.scheduleSave();
    return changed;
  }

  pageForElement(element) {
    if (!element) return this.pageIndex;
    const contentRect = this.content.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const relativeX = rect.left - contentRect.left;
    const page = Math.round(relativeX / (this.pageWidth + this.columnGap));
    return clamp(page, 0, this.pageCount - 1);
  }

  findAnchor(anchor) {
    if (!anchor) return null;
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(anchor) : anchor.replace(/"/g, '\\"');
    try {
      const found = this.content.querySelector(`#${escaped}`);
      if (found) return found;
    } catch {
      /* fall through */
    }
    return Array.from(this.content.querySelectorAll('[id]')).find((el) => el.id === anchor) || null;
  }

  async goToAnchor(anchor, { animate = false } = {}) {
    const element = this.findAnchor(anchor);
    if (!element) return false;
    await nextFrame();
    if (this.settings.mode === 'paged') {
      this.setPage(this.pageForElement(element), { animate });
    } else {
      element.scrollIntoView({ block: 'start' });
      this.page.scrollTop = Math.max(0, this.page.scrollTop - 24);
      this.updateProgressUI();
      this.scheduleSave();
    }
    this.flashElement(element);
    return true;
  }

  flashElement(element) {
    if (!element) return;
    element.classList.add('reader-target-flash');
    setTimeout(() => element.classList.remove('reader-target-flash'), 1600);
  }

  async goToChapter(index, options = {}) {
    if (!this.isOpen) return;
    if (!Number.isFinite(Number(index))) return;
    const target = clamp(Math.round(Number(index)), 0, this.chapterCount - 1);
    if (target === this.chapterIndex && this.chapter && !this.isLoading) {
      if (options.query) {
        await this.locateText(options.query, Number(options.occurrence) || 0);
      } else if (options.anchor) {
        await this.goToAnchor(options.anchor);
      } else if (Number.isFinite(Number(options.ratio))) {
        this.jumpToRatio(Number(options.ratio));
      } else if (options.position === 'end') {
        if (this.settings.mode === 'paged') this.setPage(this.pageCount - 1, { animate: false });
        else this.setScrollRatio(1, { end: true });
      } else {
        if (this.settings.mode === 'paged') this.setPage(0, { animate: false });
        else this.setScrollRatio(0);
      }
      this.scheduleSave();
      return;
    }
    await this.renderChapter(target, options);
  }

  jumpToRatio(ratio) {
    ratio = clamp(Number(ratio) || 0, 0, 1);
    if (this.settings.mode === 'paged') {
      this.setPage(Math.round(ratio * (this.pageCount - 1)), { animate: false });
    } else {
      this.setScrollRatio(ratio);
    }
  }

  nextAction() {
    if (!this.isOpen || this.isLoading) return;
    if (this.settings.mode === 'paged' && this.pageIndex < this.pageCount - 1) {
      this.setPage(this.pageIndex + 1, { animate: true });
      return;
    }
    if (this.chapterIndex < this.chapterCount - 1) {
      this.goToChapter(this.chapterIndex + 1, { position: 'start' });
      return;
    }
    this.completed = true;
    this.updateProgressUI();
    if (!this.finishedNotified) {
      this.finishedNotified = true;
      toast('已经是最后一页了，全书完。', { type: 'success' });
    }
    this.flushProgress();
  }

  prevAction() {
    if (!this.isOpen || this.isLoading) return;
    if (this.settings.mode === 'paged' && this.pageIndex > 0) {
      this.setPage(this.pageIndex - 1, { animate: true });
      return;
    }
    if (this.chapterIndex > 0) {
      this.goToChapter(this.chapterIndex - 1, { position: 'end' });
      return;
    }
    if (this.settings.mode === 'paged' && this.pageIndex === 0) {
      toast('已经是第一页了');
    } else if (this.settings.mode === 'scroll' && this.page.scrollTop <= 0) {
      toast('已经是第一页了');
    }
  }

  async setScrollRatio(ratio, { end = false } = {}) {
    if (this.settings.mode !== 'scroll') return;
    if (this.completed && clamp(ratio, 0, 1) < 0.999) this.completed = false;
    await nextFrame();
    const max = Math.max(0, this.page.scrollHeight - this.page.clientHeight);
    this.page.scrollTop = end ? max : clamp(ratio, 0, 1) * max;
    this.updateProgressUI();
  }

  scrollRatio() {
    const max = Math.max(0, this.page.scrollHeight - this.page.clientHeight);
    if (max <= 2) return this.completed ? 1 : 0;
    return clamp(this.page.scrollTop / max, 0, 1);
  }

  chapterProgressFraction() {
    if (this.settings.mode === 'paged') {
      if (this.pageCount <= 1) return this.completed ? 1 : 0;
      return clamp(this.pageIndex / (this.pageCount - 1), 0, 1);
    }
    return this.scrollRatio();
  }

  chapterRatioForSave() {
    if (this.settings.mode === 'paged') {
      if (this.pageCount <= 1) return this.completed ? 1 : 0;
      return clamp(this.pageIndex / (this.pageCount - 1), 0, 1);
    }
    return this.scrollRatio();
  }

  computePercent() {
    if (!this.chapterCount) return 0;
    const fraction = this.chapterProgressFraction();
    if (!this.totalChars) {
      return clamp(((this.chapterIndex + fraction) / this.chapterCount) * 100, 0, 100);
    }
    const before = this.chapterOffsets[this.chapterIndex] || 0;
    const chars = Math.max(0, (this.chapterOffsets[this.chapterIndex + 1] || before) - before);
    return clamp(((before + chars * fraction) / this.totalChars) * 100, 0, 100);
  }

  updateProgressUI() {
    if (!this.isOpen) return;
    const percent = this.computePercent();
    if (this.dom.progressFill) this.dom.progressFill.style.width = `${percent.toFixed(2)}%`;
    if (this.dom.percent) this.dom.percent.textContent = `${Math.floor(percent)}%`;
    if (this.dom.pageLabel) {
      if (this.settings.mode === 'paged') {
        this.dom.pageLabel.textContent = `${this.chapterIndex + 1}/${this.chapterCount} 章 · ${this.pageIndex + 1}/${this.pageCount} 页`;
      } else {
        this.dom.pageLabel.textContent = `${this.chapterIndex + 1}/${this.chapterCount} 章 · 本章 ${Math.round(this.scrollRatio() * 100)}%`;
      }
    }
    this.updateTocActive();
    this.updateBookmarkButton();
    this.documentTitle();
  }

  setLoading(visible, message) {
    this.isLoading = visible;
    if (visible) {
      if (this.dom.loadingText && message) this.dom.loadingText.textContent = message;
      clearTimeout(this.loadingTimer);
      this.loadingTimer = setTimeout(() => {
        if (this.isLoading) this.dom.loading?.classList.add('is-visible');
      }, 120);
    } else {
      clearTimeout(this.loadingTimer);
      this.dom.loading?.classList.remove('is-visible');
    }
  }

  scheduleSave() {
    if (!this.isOpen || !this.chapter) return;
    this.accrueReadingTime();
    this.progressSaveDebounced();
    this.settingsSaveDebounced();
  }

  buildProgress() {
    const percent = this.completed ? 100 : this.computePercent();
    const chapterRatio = this.completed ? 1 : this.chapterRatioForSave();
    return {
      bookId: this.book.id,
      chapterIndex: this.chapterIndex,
      chapterTitle: this.chapter?.title || this.chapterMeta(this.chapterIndex).title,
      chapterCount: this.chapterCount,
      pageIndex: this.pageIndex,
      pageCount: this.pageCount,
      pageRatio: this.settings.mode === 'paged' ? chapterRatio : 0,
      scrollRatio: this.settings.mode === 'scroll' ? chapterRatio : 0,
      chapterRatio,
      percent,
      finished: this.completed || percent >= 99.5,
      readingTime: Math.round(this.readingTime),
      updatedAt: Date.now(),
      fromCloud: false,
    };
  }

  async flushProgress({ force = false } = {}) {
    if (!this.book) return;
    if (!this.chapter && !force) return;
    if (!this.chapter) return;
    this.accrueReadingTime();
    const progress = this.buildProgress();
    this.progress = progress;
    try {
      await saveProgress(progress);
      this.onProgressSaved?.(progress, this.book);
      window.dispatchEvent(new CustomEvent('moread:progress', { detail: { bookId: this.book.id, progress } }));
    } catch (error) {
      console.warn('保存阅读进度失败', error);
    }
  }

  /* -------------------------- layout changes --------------------------- */

  currentRatio() {
    if (this.settings.mode === 'paged') {
      return this.pageCount > 1 ? this.pageIndex / (this.pageCount - 1) : 0;
    }
    return this.scrollRatio();
  }

  reflowPreservingPosition() {
    if (!this.isOpen || !this.chapter || this.isLoading) return;
    if (this.settings.mode === 'paged') {
      const ratio = this.currentRatio();
      this.paginate();
      this.setPage(Math.round(ratio * (this.pageCount - 1)), { animate: false, silent: true, save: false });
      this.updateProgressUI();
      this.scheduleSave();
    } else {
      const ratio = this.scrollRatio();
      requestAnimationFrame(() => {
        this.setScrollRatio(ratio);
        this.updateProgressUI();
      });
    }
  }

  async applyModeWithRatio(ratio) {
    this.content.style.transition = 'none';
    this.content.style.transform = 'translate3d(0, 0, 0)';
    this.page.scrollTop = 0;
    this.updateModeUI();
    await nextFrame();
    await nextFrame();
    if (this.settings.mode === 'paged') {
      this.paginate();
      this.setPage(Math.round(clamp(ratio, 0, 1) * (this.pageCount - 1)), {
        animate: false,
        silent: true,
        save: false,
      });
    } else {
      await this.setScrollRatio(ratio);
    }
    this.updateProgressUI();
    this.scheduleSave();
  }

  updateModeUI() {
    const scroll = this.settings.mode === 'scroll';
    this.root.dataset.mode = this.settings.mode;
    if (scroll && this.content) {
      this.content.style.columnWidth = '';
      this.content.style.columnGap = '';
      this.content.style.transition = 'none';
      this.content.style.transform = 'none';
    }
    if (this.dom.chapterEnd) this.dom.chapterEnd.hidden = !scroll;
    if (this.dom.maxWidthRow) this.dom.maxWidthRow.hidden = !scroll;
    this.dom.pagePrev?.setAttribute('title', scroll ? '上一章' : '上一页');
    this.dom.pageNext?.setAttribute('title', scroll ? '下一章' : '下一页');
    this.dom.pagePrev?.setAttribute('aria-label', scroll ? '上一章' : '上一页');
    this.dom.pageNext?.setAttribute('aria-label', scroll ? '下一章' : '下一页');
    this.dom.modePaged?.classList.toggle('is-active', !scroll);
    this.dom.modeScroll?.classList.toggle('is-active', scroll);
    this.dom.modePaged?.setAttribute('aria-pressed', String(!scroll));
    this.dom.modeScroll?.setAttribute('aria-pressed', String(scroll));
    this.updateChapterUI();
  }

  preloadAround(index) {
    if (this.preloadTimer) clearTimeout(this.preloadTimer);
    this.preloadTimer = setTimeout(async () => {
      if (!this.isOpen) return;
      for (const neighbor of [index + 1, index - 1]) {
        if (neighbor < 0 || neighbor >= this.chapterCount || this.chapterCache.has(neighbor)) continue;
        try {
          const chapter = await getChapter(this.book.id, neighbor);
          if (chapter) this.chapterCache.set(neighbor, chapter);
        } catch {
          /* non-critical */
        }
      }
    }, 700);
  }

  /* ----------------------------- panels / TOC --------------------------- */

  togglePanel(name) {
    if (this.activePanel === name) this.closePanels();
    else this.openPanel(name);
  }

  openPanel(name) {
    if (!this.isOpen) return;
    this.closeSearch(true);
    this.root.scrollLeft = 0;
    this.activePanel = name;
    const toc = this.dom.tocPanel;
    const settings = this.dom.settingsPanel;
    toc?.classList.toggle('is-open', name === 'toc');
    settings?.classList.toggle('is-open', name === 'settings');
    toc?.setAttribute('aria-hidden', String(name !== 'toc'));
    settings?.setAttribute('aria-hidden', String(name !== 'settings'));
    this.dom.tocBtn?.setAttribute('aria-expanded', String(name === 'toc'));
    this.dom.tocBtnBottom?.setAttribute('aria-expanded', String(name === 'toc'));
    this.dom.settingsBtn?.setAttribute('aria-expanded', String(name === 'settings'));
    this.dom.settingsBtnBottom?.setAttribute('aria-expanded', String(name === 'settings'));
    this.dom.scrim?.classList.add('is-visible');
    this.root.classList.add('panel-open');
    if (name === 'toc') {
      if (!this.dom.tocList?.children.length) this.renderToc();
      this.setPanelTab(this.panelTab);
      requestAnimationFrame(() => {
        toc?.focus({ preventScroll: true });
        this.updateTocActive(true);
      });
    } else if (name === 'settings') {
      this.syncAppearanceControls();
      requestAnimationFrame(() => settings?.focus({ preventScroll: true }));
    }
  }

  closePanels(immediate = false) {
    this.dom.tocPanel?.classList.remove('is-open');
    this.dom.settingsPanel?.classList.remove('is-open');
    this.dom.tocPanel?.setAttribute('aria-hidden', 'true');
    this.dom.settingsPanel?.setAttribute('aria-hidden', 'true');
    this.dom.tocBtn?.setAttribute('aria-expanded', 'false');
    this.dom.tocBtnBottom?.setAttribute('aria-expanded', 'false');
    this.dom.settingsBtn?.setAttribute('aria-expanded', 'false');
    this.dom.settingsBtnBottom?.setAttribute('aria-expanded', 'false');
    this.dom.scrim?.classList.remove('is-visible');
    this.root.classList.remove('panel-open');
    this.activePanel = null;
    if (!immediate && this.isOpen) {
      requestAnimationFrame(() => this.dom.viewport?.focus({ preventScroll: true }));
    }
  }

  setPanelTab(tab) {
    if (tab !== 'toc' && tab !== 'bookmarks') return;
    this.panelTab = tab;
    this.dom.tocTabs?.querySelectorAll('[data-panel-tab]').forEach((button) => {
      const active = button.dataset.panelTab === tab;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    if (this.dom.tocList) this.dom.tocList.hidden = tab !== 'toc';
    if (this.dom.bookmarkList) this.dom.bookmarkList.hidden = tab !== 'bookmarks';
    if (this.dom.tocFilterRow) this.dom.tocFilterRow.hidden = tab !== 'toc';
    if (this.dom.bookmarkAddBtn) this.dom.bookmarkAddBtn.hidden = tab !== 'bookmarks';
    if (tab === 'bookmarks') this.renderBookmarks();
    else this.filterToc();
    this.updatePanelFooter();
    this.updateTocActive();
  }

  updatePanelFooter() {
    if (!this.dom.tocFooter) return;
    if (this.panelTab === 'bookmarks') {
      this.dom.tocFooter.textContent = `${this.bookmarks.length} 个书签`;
    } else {
      const visible = this.dom.tocList
        ? $$('.toc-item', this.dom.tocList).filter((item) => !item.hidden).length
        : this.chapterCount;
      this.dom.tocFooter.textContent = visible === this.chapterCount
        ? `共 ${this.chapterCount} 章 · 自动识别`
        : `找到 ${visible} 章`;
    }
  }

  renderToc() {
    if (!this.dom.tocList) return;
    const fragment = document.createDocumentFragment();
    this.chaptersMeta.forEach((meta, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toc-item';
      button.dataset.chapterIndex = String(index);
      const number = document.createElement('span');
      number.className = 'toc-index';
      number.textContent = String(index + 1).padStart(2, '0');
      const title = document.createElement('span');
      title.className = 'toc-title';
      title.textContent = meta.title || `第 ${index + 1} 章`;
      button.append(number, title);
      if (index === this.chapterIndex) {
        button.classList.add('is-active');
        button.setAttribute('aria-current', 'location');
      }
      fragment.append(button);
    });
    this.dom.tocList.replaceChildren(fragment);
    this.dom.tocList.scrollTop = 0;
    this.updatePanelFooter();
  }

  filterToc() {
    if (!this.dom.tocList) return;
    const query = normalizeWhitespace(this.dom.tocFilter?.value || '').toLowerCase();
    const items = $$('.toc-item', this.dom.tocList);
    items.forEach((item) => {
      const title = normalizeWhitespace($('.toc-title', item)?.textContent || '').toLowerCase();
      item.hidden = Boolean(query) && !title.includes(query);
    });
    this.updatePanelFooter();
  }

  updateTocActive(scroll = false) {
    if (!this.dom.tocList) return;
    const previous = $('.toc-item.is-active', this.dom.tocList);
    if (previous) {
      previous.classList.remove('is-active');
      previous.removeAttribute('aria-current');
    }
    const active = $(`.toc-item[data-chapter-index="${this.chapterIndex}"]`, this.dom.tocList);
    if (active) {
      active.classList.add('is-active');
      active.setAttribute('aria-current', 'location');
      if (scroll && this.activePanel === 'toc' && this.panelTab === 'toc') {
        active.scrollIntoView({ block: 'center' });
      } else if (!scroll && this.activePanel === 'toc') {
        active.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  renderBookmarks() {
    if (!this.dom.bookmarkList) return;
    const fragment = document.createDocumentFragment();
    if (!this.bookmarks.length) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.innerHTML = '<p>还没有书签。</p><p class="muted">读到喜欢的地方，点顶部的书签按钮留个记号。</p>';
      fragment.append(empty);
    }
    for (const bookmark of this.bookmarks) {
      const item = document.createElement('div');
      item.className = 'bookmark-item';
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'bookmark-jump';
      jump.dataset.bookmarkId = bookmark.id;
      const top = document.createElement('span');
      top.className = 'bookmark-top';
      const chapter = document.createElement('span');
      chapter.className = 'bookmark-chapter';
      chapter.textContent = bookmark.chapterTitle || this.chapterMeta(bookmark.chapterIndex).title;
      const percent = document.createElement('span');
      percent.className = 'bookmark-percent';
      percent.textContent = `${Math.floor(Number(bookmark.percent) || 0)}%`;
      top.append(chapter, percent);
      const excerpt = document.createElement('span');
      excerpt.className = 'bookmark-excerpt';
      excerpt.textContent = bookmark.excerpt || '（没有摘录）';
      const meta = document.createElement('span');
      meta.className = 'bookmark-meta';
      meta.textContent = new Date(bookmark.createdAt || Date.now()).toLocaleDateString('zh-CN');
      jump.append(top, excerpt, meta);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'bookmark-delete';
      remove.dataset.deleteBookmark = bookmark.id;
      remove.title = '删除书签';
      remove.setAttribute('aria-label', '删除书签');
      remove.textContent = '×';
      item.append(jump, remove);
      fragment.append(item);
    }
    this.dom.bookmarkList.replaceChildren(fragment);
    this.updatePanelFooter();
  }

  bookmarkForCurrent() {
    if (!this.chapter) return null;
    const ratio = this.chapterRatioForSave();
    return this.bookmarks.find((bookmark) => {
      if (Number(bookmark.chapterIndex) !== this.chapterIndex) return false;
      const saved = Number(bookmark.chapterRatio ?? bookmark.pageRatio ?? 0);
      return Math.abs(saved - ratio) <= 0.015;
    }) || null;
  }

  updateBookmarkButton() {
    if (!this.dom.bookmarkBtn) return;
    const bookmark = this.chapter ? this.bookmarkForCurrent() : null;
    this.dom.bookmarkBtn.classList.toggle('is-active', Boolean(bookmark));
    this.dom.bookmarkBtn.setAttribute('aria-pressed', String(Boolean(bookmark)));
    this.dom.bookmarkBtn.title = bookmark ? '移除此页书签 (B)' : '添加书签 (B)';
  }

  async toggleBookmark(forceAdd = false) {
    if (!this.isOpen || !this.chapter) return;
    const existing = this.bookmarkForCurrent();
    if (existing && !forceAdd) {
      await this.deleteBookmark(existing.id);
      return;
    }
    if (existing) {
      toast('这一页已经有书签了');
      return;
    }
    const bookmark = {
      id: uid('bm'),
      bookId: this.book.id,
      chapterIndex: this.chapterIndex,
      chapterTitle: this.chapter.title,
      chapterRatio: this.chapterRatioForSave(),
      pageRatio: this.pageIndex / Math.max(1, this.pageCount - 1),
      pageIndex: this.pageIndex,
      pageCount: this.pageCount,
      scrollRatio: this.settings.mode === 'scroll' ? this.scrollRatio() : 0,
      percent: this.computePercent(),
      excerpt: this.captureExcerpt(),
      createdAt: Date.now(),
    };
    try {
      await addBookmark(bookmark);
      this.bookmarks.unshift(bookmark);
      this.updateBookmarkButton();
      if (this.activePanel === 'toc' && this.panelTab === 'bookmarks') this.renderBookmarks();
      toast('书签已保存', { type: 'success' });
    } catch {
      toast('保存书签失败', { type: 'error' });
    }
  }

  async deleteBookmark(id) {
    const bookmark = this.bookmarks.find((item) => item.id === id);
    if (!bookmark) return;
    try {
      await removeBookmark(id);
      this.bookmarks = this.bookmarks.filter((item) => item.id !== id);
      this.updateBookmarkButton();
      if (this.activePanel === 'toc' && this.panelTab === 'bookmarks') this.renderBookmarks();
      toast('已删除书签');
    } catch {
      toast('删除书签失败', { type: 'error' });
    }
  }

  captureExcerpt() {
    if (!this.chapter) return '';
    const pageRect = this.page.getBoundingClientRect();
    const blocks = Array.from(this.content.querySelectorAll('p, li, blockquote, h1, h2, h3, pre'));
    let text = '';
    for (const block of blocks) {
      const rect = block.getBoundingClientRect();
      const horizontal = rect.right > pageRect.left + 12 && rect.left < pageRect.right - 12;
      const vertical = rect.bottom > pageRect.top + 24 && rect.top < pageRect.bottom - 24;
      const visible = this.settings.mode === 'paged' ? horizontal : horizontal && vertical;
      if (!visible) continue;
      const value = normalizeWhitespace(block.textContent);
      if (!value) continue;
      text += `${text ? ' ' : ''}${value}`;
      if (text.length >= 150) break;
    }
    if (!text) text = this.chapter.text || '';
    return normalizeWhitespace(text).slice(0, 170);
  }

  /* ---------------------------- appearance ------------------------------ */

  syncAppearanceControls() {
    const settings = this.settings;
    $$('.theme-option', this.dom.themeGrid).forEach((button) => {
      const active = button.dataset.theme === settings.themeId;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    $$('.font-option', this.dom.fontGrid).forEach((button) => {
      const active = button.dataset.font === settings.fontFamily;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    const rangeData = [
      ['fontSizeRange', 'fontSizeValue', settings.fontSize, (v) => `${v} px`],
      ['lineHeightRange', 'lineHeightValue', settings.lineHeight, (v) => Number(v).toFixed(1)],
      ['letterSpacingRange', 'letterSpacingValue', settings.letterSpacing, (v) => `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(1)} px`],
      ['pagePadRange', 'pagePadValue', settings.pagePad, (v) => `${v} px`],
      ['maxWidthRange', 'maxWidthValue', settings.maxWidth, (v) => `${v} px`],
      ['paragraphSpacingRange', 'paragraphSpacingValue', settings.paragraphSpacing, (v) => `${Number(v).toFixed(1)} ×`],
    ];
    for (const [inputId, outputId, value, format] of rangeData) {
      const input = this.dom[inputId];
      const output = this.dom[outputId];
      if (input && document.activeElement !== input) input.value = String(value);
      if (output) output.textContent = format(value);
    }

    if (this.dom.customBgInput && document.activeElement !== this.dom.customBgInput) {
      this.dom.customBgInput.value = settings.customBg;
    }
    if (this.dom.customTextInput && document.activeElement !== this.dom.customTextInput) {
      this.dom.customTextInput.value = settings.customText;
    }
    this.dom.customBgInput?.closest('.custom-colors')?.classList.toggle('is-active', settings.themeId === 'custom');

    this.dom.modePaged?.classList.toggle('is-active', settings.mode === 'paged');
    this.dom.modeScroll?.classList.toggle('is-active', settings.mode === 'scroll');
    this.dom.modePaged?.setAttribute('aria-pressed', String(settings.mode === 'paged'));
    this.dom.modeScroll?.setAttribute('aria-pressed', String(settings.mode === 'scroll'));

    this.dom.toggleIndent?.classList.toggle('is-on', settings.textIndent);
    this.dom.toggleIndent?.setAttribute('aria-checked', String(settings.textIndent));
    this.dom.toggleJustify?.classList.toggle('is-on', settings.justify);
    this.dom.toggleJustify?.setAttribute('aria-checked', String(settings.justify));
    this.dom.toggleAnimation?.classList.toggle('is-on', settings.pageAnimation);
    this.dom.toggleAnimation?.setAttribute('aria-checked', String(settings.pageAnimation));

    if (this.dom.maxWidthRow) this.dom.maxWidthRow.hidden = settings.mode !== 'scroll';
  }

  applySettingPatch(patch, { live = false, reflow = false } = {}) {
    const previousMode = this.settings.mode;
    const previousRatio = this.currentRatio();
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    applyReaderSettings(this.root, this.settings);
    this.syncAppearanceControls();
    if (previousMode !== this.settings.mode) {
      this.applyModeWithRatio(previousRatio);
      this.updateChapterUI();
    } else if (reflow) {
      this.reflowDebounced();
    }
    if (live) this.settingsSaveDebounced();
    else this.settings = updateSettings(this.settings, {}, { notify: false });
  }

  handleAppearanceClick(event) {
    const theme = event.target.closest('.theme-option[data-theme]');
    if (theme) {
      this.applySettingPatch({ themeId: theme.dataset.theme });
      return;
    }
    const font = event.target.closest('.font-option[data-font]');
    if (font) {
      this.applySettingPatch({ fontFamily: font.dataset.font }, { reflow: true });
      return;
    }
    const mode = event.target.closest('.segmented [data-mode]');
    if (mode) {
      if (mode.dataset.mode === this.settings.mode) return;
      this.applySettingPatch({ mode: mode.dataset.mode });
      return;
    }
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const key = toggle.dataset.toggle;
      const next = !this.settings[key];
      this.applySettingPatch({ [key]: next }, { reflow: key !== 'pageAnimation' });
      return;
    }
    if (event.target.closest('#fontSizeMinus')) {
      this.applySettingPatch({ fontSize: this.settings.fontSize - 1 }, { reflow: true });
      return;
    }
    if (event.target.closest('#fontSizePlus')) {
      this.applySettingPatch({ fontSize: this.settings.fontSize + 1 }, { reflow: true });
    }
  }

  handleAppearanceInput(event) {
    const input = event.target;
    if (input.matches('[data-range]')) {
      const key = input.dataset.range;
      const value = Number(input.value);
      this.applySettingPatch({ [key]: value }, { live: true, reflow: true });
      return;
    }
    if (input === this.dom.customBgInput) {
      this.applySettingPatch({ themeId: 'custom', customBg: input.value }, { live: true });
      return;
    }
    if (input === this.dom.customTextInput) {
      this.applySettingPatch({ themeId: 'custom', customText: input.value }, { live: true });
    }
  }

  async resetAppearanceSettings() {
    const confirmed = await confirmDialog({
      title: '恢复默认排版',
      message: '会重置主题、字体、字号和间距，但不会影响书签与阅读进度。',
      confirmText: '恢复默认',
    });
    if (!confirmed) return;
    const previousMode = this.settings.mode;
    const previousRatio = this.currentRatio();
    this.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, updatedAt: Date.now() });
    applyReaderSettings(this.root, this.settings);
    this.settings = updateSettings(this.settings, {}, { notify: false });
    this.syncAppearanceControls();
    if (previousMode !== this.settings.mode) await this.applyModeWithRatio(previousRatio);
    else this.reflowDebounced();
    toast('已恢复默认排版');
  }

  /* ------------------------------- search ------------------------------- */

  openSearch() {
    if (!this.isOpen || !this.dom.searchOverlay) return;
    this.closePanels(true);
    this.dom.searchOverlay.hidden = false;
    this.dom.searchOverlay.setAttribute('aria-hidden', 'false');
    this.dom.searchBtn?.setAttribute('aria-expanded', 'true');
    this.root.classList.add('search-open');
    this.dom.searchInput.value = this.searchQuery || '';
    if (this.searchQuery) this.runSearch(this.searchQuery);
    else this.showSearchHint();
    requestAnimationFrame(() => {
      this.dom.searchInput?.focus();
      this.dom.searchInput?.select();
    });
  }

  closeSearch(immediate = false) {
    if (!this.dom.searchOverlay) return;
    this.searchToken += 1;
    this.searchDebounced.cancel();
    this.dom.searchOverlay.hidden = true;
    this.dom.searchOverlay.setAttribute('aria-hidden', 'true');
    this.dom.searchBtn?.setAttribute('aria-expanded', 'false');
    this.root.classList.remove('search-open');
    if (!immediate && this.isOpen) {
      requestAnimationFrame(() => this.dom.viewport?.focus({ preventScroll: true }));
    }
  }

  showSearchHint() {
    if (!this.dom.searchResults) return;
    const hint = document.createElement('div');
    hint.className = 'search-empty';
    hint.innerHTML = '<p>搜索整本书的内容</p><p class="muted">输入人物、地名或一句话中的关键词。</p>';
    this.dom.searchResults.replaceChildren(hint);
    if (this.dom.searchStatus) this.dom.searchStatus.textContent = '全书搜索';
  }

  async ensureSearchCorpus() {
    if (this.searchCorpus) return this.searchCorpus;
    const records = await getChapters(this.book.id);
    const corpus = Array.from({ length: this.chapterCount }, (_, index) => ({ text: '' }));
    for (const record of records) {
      if (record.index >= 0 && record.index < corpus.length) {
        corpus[record.index] = { text: record.text || '' };
      }
    }
    this.searchCorpus = corpus;
    return corpus;
  }

  async runSearch(rawQuery) {
    if (!this.isOpen || !this.book) return;
    const query = normalizeWhitespace(rawQuery).slice(0, 80);
    this.searchQuery = query;
    this.searchToken += 1;
    const token = this.searchToken;
    if (!query) {
      this.showSearchHint();
      return;
    }
    if (!this.dom.searchResults || !this.dom.searchStatus) return;
    this.dom.searchStatus.textContent = '正在检索全书…';
    const loading = document.createElement('div');
    loading.className = 'search-empty search-loading';
    loading.innerHTML = '<span class="spinner"></span><p>正在检索…</p>';
    this.dom.searchResults.replaceChildren(loading);

    let corpus;
    try {
      corpus = await this.ensureSearchCorpus();
    } catch {
      if (token === this.searchToken) {
        this.dom.searchStatus.textContent = '无法读取章节内容';
        this.dom.searchResults.textContent = '';
      }
      return;
    }
    if (token !== this.searchToken) return;

    const lower = query.toLowerCase();
    const hits = [];
    const maxHits = 80;
    let truncated = false;

    for (let index = 0; index < corpus.length; index += 1) {
      const text = corpus[index].text || '';
      if (!text) continue;
      const haystack = text.toLowerCase();
      let from = 0;
      let perChapter = 0;
      while (perChapter < 6) {
        const found = haystack.indexOf(lower, from);
        if (found < 0) break;
        hits.push({ index, occurrence: perChapter, text, found, length: query.length });
        perChapter += 1;
        from = found + Math.max(1, lower.length);
        if (hits.length >= maxHits) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
      if (index % 60 === 59) {
        await delay(0);
        if (token !== this.searchToken) return;
      }
    }

    if (token !== this.searchToken) return;
    this.dom.searchStatus.textContent = hits.length
      ? `${hits.length}${truncated ? '+' : ''} 处结果${truncated ? ' · 仅显示前 80 条' : ''}`
      : '没有找到匹配内容';
    const fragment = document.createDocumentFragment();
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.innerHTML = '<p>没有找到匹配内容</p><p class="muted">试试更短的关键词，或换一种说法。</p>';
      fragment.append(empty);
    }
    for (const hit of hits) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-result';
      button.dataset.searchIndex = String(hit.index);
      button.dataset.searchOccurrence = String(hit.occurrence);
      const head = document.createElement('span');
      head.className = 'search-result-chapter';
      head.textContent = this.chapterMeta(hit.index).title || `第 ${hit.index + 1} 章`;
      const snip = document.createElement('span');
      snip.className = 'search-result-text';
      snip.append(this.buildSnippet(hit.text, hit.found, hit.length, query));
      button.append(head, snip);
      fragment.append(button);
    }
    this.dom.searchResults.replaceChildren(fragment);
    this.dom.searchResults.scrollTop = 0;
  }

  buildSnippet(text, found, length, query) {
    const windowBefore = 34;
    const windowAfter = 56;
    let start = Math.max(0, found - windowBefore);
    let end = Math.min(text.length, found + length + windowAfter);
    // Do not begin in the middle of a surrogate pair.
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start += 1;
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
    const before = text.slice(start, found);
    const match = text.slice(found, found + length);
    const after = text.slice(found + length, end);
    const fragment = document.createDocumentFragment();
    if (start > 0) fragment.append(document.createTextNode('…'));
    fragment.append(document.createTextNode(before));
    const mark = document.createElement('mark');
    mark.textContent = match;
    fragment.append(mark);
    fragment.append(document.createTextNode(after));
    if (end < text.length) fragment.append(document.createTextNode('…'));
    return fragment;
  }

  removeSearchHighlights() {
    this.content?.querySelectorAll('mark.reader-search-hit').forEach((mark) => {
      mark.replaceWith(...mark.childNodes);
    });
    this.content?.normalize();
  }

  async locateText(query, occurrence = 0) {
    query = normalizeWhitespace(query);
    if (!query || !this.chapter) return false;
    this.removeSearchHighlights();
    const lower = query.toLowerCase();
    let seen = 0;
    let targetNode = null;
    let targetOffset = 0;
    let targetLength = query.length;

    const searchTerms = [query];
    const firstWord = query.split(/\s+/)[0];
    if (firstWord && firstWord !== query) searchTerms.push(firstWord);

    for (const term of searchTerms) {
      const termLower = term.toLowerCase();
      seen = 0;
      const walker = document.createTreeWalker(this.content, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (!node.nodeValue?.trim() || node.parentElement?.closest('script,style'))
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
      });
      let node;
      while ((node = walker.nextNode())) {
        const value = node.nodeValue.toLowerCase();
        let from = 0;
        while (true) {
          const found = value.indexOf(termLower, from);
          if (found < 0) break;
          if (seen === occurrence) {
            targetNode = node;
            targetOffset = found;
            targetLength = term.length;
            break;
          }
          seen += 1;
          from = found + Math.max(1, termLower.length);
        }
        if (targetNode) break;
      }
      if (targetNode) break;
    }

    if (!targetNode) {
      toast('已跳到这一章，但没有精确定位到关键词');
      return false;
    }

    const range = document.createRange();
    range.setStart(targetNode, targetOffset);
    range.setEnd(targetNode, targetOffset + targetLength);
    const mark = document.createElement('mark');
    mark.className = 'reader-search-hit';
    try {
      range.surroundContents(mark);
    } catch {
      return false;
    }
    await nextFrame();
    if (this.settings.mode === 'paged') {
      this.setPage(this.pageForElement(mark), { animate: false });
    } else {
      mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
      this.updateProgressUI();
      this.scheduleSave();
    }
    setTimeout(() => {
      if (mark.isConnected) mark.replaceWith(...mark.childNodes);
      this.content?.normalize();
    }, 6000);
    return true;
  }

  /* ---------------------------- interactions ---------------------------- */

  setChromeHidden(hidden) {
    this.chromeHidden = Boolean(hidden);
    this.root.classList.toggle('chrome-hidden', this.chromeHidden);
    if (this.dom.hiddenHint) {
      this.dom.hiddenHint.setAttribute('aria-hidden', String(!this.chromeHidden));
      this.dom.hiddenHint.tabIndex = this.chromeHidden ? 0 : -1;
    }
  }

  toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
      return;
    }
    if (this.root.requestFullscreen) {
      this.root.requestFullscreen().catch(() => {
        this.setChromeHidden(true);
        toast('已进入沉浸模式，轻点页面中央可显示工具栏');
      });
    } else {
      this.setChromeHidden(true);
      toast('已进入沉浸模式，轻点页面中央可显示工具栏');
    }
  }

  handleTap(event) {
    if (!this.isOpen || this.isLoading) return;
    if (Date.now() < this.suppressClickUntil) return;
    if (event.detail === 0) return;
    const target = event.target;
    if (target.closest('a, button, input, select, textarea, .reader-loading, .chapter-end, .page-edge')) return;
    if (window.getSelection()?.toString()) return;
    const rect = this.dom.viewport.getBoundingClientRect();
    const x = (event.clientX - rect.left) / Math.max(1, rect.width);
    const touch = this.pointerType === 'touch' || this.pointerType === 'pen';
    if (this.settings.mode === 'paged') {
      if (x < 0.23) {
        this.prevAction();
        return;
      }
      if (x > 0.77) {
        this.nextAction();
        return;
      }
    }
    if (touch) {
      this.setChromeHidden(!this.chromeHidden);
    }
  }

  handleContentClick(event) {
    const anchor = event.target.closest('a');
    if (!anchor) return;
    if (anchor.dataset.chapter !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      const index = Number(anchor.dataset.chapter);
      const targetAnchor = anchor.dataset.anchor || '';
      this.goToChapter(index, { anchor: targetAnchor });
      return;
    }
    const href = anchor.getAttribute('href') || '';
    if (href.startsWith('#')) {
      event.preventDefault();
      event.stopPropagation();
      let anchorName = href.slice(1);
      try { anchorName = decodeURIComponent(anchorName); } catch { /* raw */ }
      this.goToAnchor(anchorName);
      return;
    }
    if (href) event.stopPropagation();
  }

  handleWheel(event) {
    if (!this.isOpen || this.isLoading) return;
    if (this.settings.mode !== 'paged') return;
    if (this.activePanel || !this.dom.searchOverlay?.hidden) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (Math.abs(delta) < 18) return;
    const now = Date.now();
    if (now < this.wheelLock) return;
    this.wheelLock = now + 420;
    if (delta > 0) this.nextAction();
    else this.prevAction();
  }

  handleTouchStart(event) {
    if (event.touches?.length !== 1) {
      this.touchStart = null;
      return;
    }
    const touch = event.touches[0];
    this.touchStart = { x: touch.clientX, y: touch.clientY, at: Date.now() };
  }

  handleTouchEnd(event) {
    const start = this.touchStart;
    this.touchStart = null;
    if (!start || !event.changedTouches?.length) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const elapsed = Date.now() - start.at;
    if (elapsed > 900 || Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
    this.suppressClickUntil = Date.now() + 380;
    if (dx < 0) this.nextAction();
    else this.prevAction();
  }

  handleKeydown(event) {
    if (!this.isOpen) return;
    if (event.key === 'Escape') {
      if (this.activePanel) {
        event.preventDefault();
        this.closePanels();
        return;
      }
      if (!this.dom.searchOverlay?.hidden) {
        event.preventDefault();
        this.closeSearch();
        return;
      }
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
        return;
      }
      if (this.chromeHidden) {
        event.preventDefault();
        this.setChromeHidden(false);
        return;
      }
      event.preventDefault();
      this.close();
      return;
    }
    if (!this.dom.searchOverlay?.hidden) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      this.openSearch();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditable(event.target)) return;

    const key = event.key;
    const lower = key.toLowerCase();
    if (key === '?' || (key === '/' && event.shiftKey)) {
      event.preventDefault();
      this.onHelp();
      return;
    }
    if (key === '/') {
      event.preventDefault();
      this.openSearch();
      return;
    }
    if (lower === 't') {
      event.preventDefault();
      this.togglePanel('toc');
      return;
    }
    if (lower === 'd') {
      event.preventDefault();
      this.togglePanel('settings');
      return;
    }
    if (lower === 'b') {
      event.preventDefault();
      this.toggleBookmark();
      return;
    }
    if (lower === 'f') {
      event.preventDefault();
      this.toggleFullscreen();
      return;
    }
    if (lower === 'h') {
      event.preventDefault();
      this.setChromeHidden(!this.chromeHidden);
      return;
    }
    if (key === '+' || key === '=') {
      event.preventDefault();
      this.applySettingPatch({ fontSize: this.settings.fontSize + 1 }, { reflow: true });
      return;
    }
    if (key === '-' || key === '_') {
      event.preventDefault();
      this.applySettingPatch({ fontSize: this.settings.fontSize - 1 }, { reflow: true });
      return;
    }
    if (this.activePanel) return;
    // Leave navigation keys alone while a toolbar / dialog control is focused.
    if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea, [contenteditable="true"]')) return;

    if (this.settings.mode === 'paged') {
      if (['ArrowLeft', 'ArrowUp', 'PageUp', 'k', 'K'].includes(key)) {
        event.preventDefault();
        this.prevAction();
      } else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'j', 'J'].includes(key)) {
        event.preventDefault();
        this.nextAction();
      } else if (key === 'Home') {
        event.preventDefault();
        this.setPage(0);
      } else if (key === 'End') {
        event.preventDefault();
        this.setPage(this.pageCount - 1);
      }
    } else {
      const step = Math.max(80, this.page.clientHeight * 0.86);
      const maxScroll = Math.max(0, this.page.scrollHeight - this.page.clientHeight);
      if (['PageDown', ' ', 'ArrowDown'].includes(key)) {
        event.preventDefault();
        if (this.page.scrollTop >= maxScroll - 2) {
          this.nextAction();
        } else {
          this.page.scrollTop = Math.min(maxScroll, this.page.scrollTop + step);
        }
      } else if (['PageUp', 'ArrowUp'].includes(key)) {
        event.preventDefault();
        if (this.page.scrollTop <= 2) {
          this.prevAction();
        } else {
          this.page.scrollTop = Math.max(0, this.page.scrollTop - step);
        }
      } else if (key === 'ArrowLeft') {
        event.preventDefault();
        this.prevAction();
      } else if (key === 'ArrowRight') {
        event.preventDefault();
        this.nextAction();
      } else if (key === 'Home') {
        event.preventDefault();
        this.page.scrollTop = 0;
      } else if (key === 'End') {
        event.preventDefault();
        this.page.scrollTop = this.page.scrollHeight;
      }
    }
  }
}

