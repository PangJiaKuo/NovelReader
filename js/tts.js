/* System speech-engine bridge, narration text extraction and voice helpers. */

export const MAX_SPEECH_CHUNK = 120;
const PREFS_KEY = 'moread:tts';

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const BOUNDARY_RE = /[。！？!?；;…\n]|\.(?=\s|$)/g;
const CLOSERS = /[”’"」』）)\]】》]/;
const SPLIT_POINT_RE = /[，,、：:；;\s]/;

export const DEFAULT_TTS_PREFS = Object.freeze({
  voiceURI: '',
  rate: 1,
});

export function clampSpeechRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return DEFAULT_TTS_PREFS.rate;
  return Math.min(2, Math.max(0.5, Math.round(rate * 20) / 20));
}

export function loadTtsPreferences() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    return {
      voiceURI: typeof parsed.voiceURI === 'string' ? parsed.voiceURI : '',
      rate: clampSpeechRate(parsed.rate),
    };
  } catch {
    return { ...DEFAULT_TTS_PREFS };
  }
}

export function saveTtsPreferences(patch = {}) {
  const next = {
    ...loadTtsPreferences(),
    ...patch,
  };
  next.rate = clampSpeechRate(next.rate);
  next.voiceURI = typeof next.voiceURI === 'string' ? next.voiceURI : '';
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* private mode can reject storage */
  }
  return next;
}

export function hasCjkText(text) {
  return CJK_RE.test(String(text || ''));
}

export function inferSpeechLanguage(text) {
  return hasCjkText(text) ? 'zh-CN' : 'en-US';
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function pushSpeechChunk(text, from, to, chunks) {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  if (start >= end) return;
  let cut = end;
  if (cut > start && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
  if (cut <= start) cut = end;
  const normalized = text.slice(start, cut).replace(/\s+/g, ' ').trim();
  if (normalized) chunks.push({ text: normalized, start, end: cut });
}

function splitLongSpan(text, start, end, limit, chunks) {
  let from = start;
  while (end - from > limit) {
    const hard = from + limit;
    let cut = -1;
    const floor = from + Math.max(18, Math.floor(limit * 0.55));
    for (let index = hard; index > floor; index -= 1) {
      if (SPLIT_POINT_RE.test(text[index - 1])) {
        cut = index;
        break;
      }
    }
    if (cut <= from) cut = hard;
    if (cut > from && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
    if (cut <= from) cut = hard;
    pushSpeechChunk(text, from, cut, chunks);
    from = cut;
    while (from < end && /\s/.test(text[from])) from += 1;
  }
  if (end > from) pushSpeechChunk(text, from, end, chunks);
}

/**
 * Split chapter text into sentence-ish chunks that native and web speech engines
 * can speak reliably. Offsets always point into the original text.
 */
export function splitSpeechText(text, maxLength = MAX_SPEECH_CHUNK) {
  if (typeof text !== 'string' || !text) return [];
  const limit = Math.max(24, Math.round(Number(maxLength) || MAX_SPEECH_CHUNK));
  const chunks = [];
  const spans = [];
  const boundary = new RegExp(BOUNDARY_RE.source, 'g');
  let segmentStart = 0;
  let match;
  while ((match = boundary.exec(text))) {
    let end = boundary.lastIndex;
    while (end < text.length && CLOSERS.test(text[end])) end += 1;
    spans.push([segmentStart, end]);
    segmentStart = end;
  }
  if (segmentStart < text.length) spans.push([segmentStart, text.length]);
  if (!spans.length) spans.push([0, text.length]);

  for (const [rawStart, rawEnd] of spans) {
    let start = rawStart;
    let end = rawEnd;
    while (start < end && /\s/.test(text[start])) start += 1;
    while (end > start && /\s/.test(text[end - 1])) end -= 1;
    if (start >= end) continue;
    splitLongSpan(text, start, end, limit, chunks);
  }
  return chunks;
}

/**
 * Collect readable text from a rendered chapter while remembering which text
 * node every character belongs to. The ranges let the reader follow the
 * current sentence visually without wrapping text nodes and disturbing layout.
 */
export function collectNarrationText(root) {
  if (!root || typeof document === 'undefined') return { text: '', segments: [] };
  const segments = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script, style, noscript, svg, canvas, .chapter-end')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let text = '';
  let lastBlock = null;
  let node = walker.nextNode();
  while (node) {
    const block = node.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, figcaption, td, th, dt, dd') || root;
    if (lastBlock && block !== lastBlock && text && !/\n$/.test(text)) text += '\n';
    lastBlock = block;
    const raw = node.nodeValue || '';
    if (raw) {
      const start = text.length;
      text += raw;
      segments.push({ node, start, end: start + raw.length });
    }
    node = walker.nextNode();
  }
  return { text, segments };
}

function segmentForStart(segments, offset) {
  for (const segment of segments) {
    if (segment.end > offset) {
      if (offset < segment.start) return { segment, offset: 0 };
      return { segment, offset: Math.min(segment.end, Math.max(0, offset - segment.start)) };
    }
  }
  return null;
}

function segmentForEnd(segments, offset) {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment.end >= offset && segment.start < offset) {
      return { segment, offset: Math.min(segment.end - segment.start, Math.max(0, offset - segment.start)) };
    }
  }
  return null;
}

function rangeForOffsets(segments, start, end) {
  if (!segments.length || !(end > start)) return null;
  const startPoint = segmentForStart(segments, start);
  const endPoint = segmentForEnd(segments, end);
  if (!startPoint || !endPoint) return null;
  const nodeStart = startPoint.segment.node;
  const nodeEnd = endPoint.segment.node;
  if (!nodeStart?.isConnected || !nodeEnd?.isConnected) return null;
  try {
    const range = nodeStart.ownerDocument.createRange();
    range.setStart(nodeStart, clampOffset(startPoint.offset, nodeStart.nodeValue?.length || 0));
    range.setEnd(nodeEnd, clampOffset(endPoint.offset, nodeEnd.nodeValue?.length || 0));
    return range;
  } catch {
    return null;
  }
}

function clampOffset(value, max) {
  return Math.min(Math.max(0, value), Math.max(0, max));
}

export function buildNarrationScript(root, maxLength = MAX_SPEECH_CHUNK) {
  const { text, segments } = collectNarrationText(root);
  if (!text.trim()) return { chunks: [], textLength: 0, sourceLength: text.length };
  const chunks = splitSpeechText(text, maxLength).map((chunk) => ({
    ...chunk,
    range: rangeForOffsets(segments, chunk.start, chunk.end),
  }));
  return { chunks, textLength: text.length, sourceLength: text.length };
}

export function languageLabel(lang) {
  const tag = String(lang || '').replace('_', '-');
  if (!tag) return '未知语言';
  try {
    const [base, region] = tag.split('-');
    const display = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
    const regionDisplay = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
    const language = display.of(base) || base;
    const area = region ? regionDisplay.of(region) : '';
    return area ? `${language}（${area}）` : language;
  } catch {
    return tag;
  }
}

export function normalizeVoices(rawVoices, { native = false } = {}) {
  const seen = new Set();
  const voices = [];
  (Array.isArray(rawVoices) ? rawVoices : []).forEach((voice, index) => {
    if (!voice || typeof voice !== 'object') return;
    const name = String(voice.name || '').trim();
    const lang = String(voice.lang || '').trim();
    const voiceURI = String(voice.voiceURI || name || `${lang}-${index}`).trim();
    const key = `${voiceURI}|${lang}`;
    if (!voiceURI || seen.has(key)) return;
    seen.add(key);
    voices.push({
      name,
      lang,
      voiceURI,
      localService: voice.localService !== false,
      default: Boolean(voice.default),
      _native: native,
      _nativeIndex: native ? index : null,
      _raw: voice,
    });
  });
  return voices.sort((a, b) => {
    const aZh = /^(?:zh|cmn|yue)/i.test(a.lang);
    const bZh = /^(?:zh|cmn|yue)/i.test(b.lang);
    if (aZh !== bZh) return aZh ? -1 : 1;
    return `${a.name}${a.lang}`.localeCompare(`${b.name}${b.lang}`, 'zh-Hans');
  });
}

export function findVoice(voices, voiceURI) {
  if (!voiceURI) return null;
  return voices.find((voice) => voice.voiceURI === voiceURI)
    || voices.find((voice) => voice.name === voiceURI)
    || null;
}

export function voiceOptionLabel(voice, { duplicateCount = 1, ordinal = 1 } = {}) {
  const language = languageLabel(voice.lang);
  let label = voice._native ? language : (voice.name || language);
  if (!voice.localService) label += ' · 在线';
  if (duplicateCount > 1) label += ` · 音色 ${ordinal}`;
  return label;
}

function usablePlugin(plugin) {
  return Boolean(plugin && typeof plugin.speak === 'function' && typeof plugin.stop === 'function');
}

function nativePlugin() {
  if (typeof window === 'undefined') return null;
  const capacitor = window.Capacitor;
  if (!capacitor) return null;
  if (typeof capacitor.isNativePlatform === 'function' && !capacitor.isNativePlatform()) return null;

  // Capacitor's Android bridge injects callable proxies into Capacitor.Plugins
  // before the page scripts run. It does not expose registerPlugin() unless
  // @capacitor/core is packaged with the app, so check the injected proxy first.
  const injected = capacitor.Plugins?.TextToSpeech;
  if (usablePlugin(injected)) return injected;

  if (typeof capacitor.registerPlugin === 'function') {
    if (typeof capacitor.isPluginAvailable === 'function' && !capacitor.isPluginAvailable('TextToSpeech')) return null;
    try {
      const plugin = capacitor.registerPlugin('TextToSpeech');
      if (usablePlugin(plugin)) return plugin;
    } catch {
      /* fall back to the Web Speech API */
    }
  }
  return null;
}

function hasWebSpeech() {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function describeSpeechError(error) {
  const raw = String(error?.message || error?.error || error || '');
  if (/language.*not supported|not supported.*language/i.test(raw)) {
    return '当前语音引擎不支持该语言。请安装中文语音包，或在“音色”中选择其他语音。';
  }
  if (/not yet initialized|not available|unavailable/i.test(raw)) {
    return '系统语音引擎尚未就绪或不可用。请确认手机已启用“文字转语音”引擎后重试。';
  }
  if (/failed to read text/i.test(raw)) return '系统语音引擎朗读失败，请检查语音引擎和语音包是否正常。';
  if (/not-allowed|not allowed|user gesture/i.test(raw)) return '当前浏览器阻止了朗读，请再次点击播放。';
  if (/network/i.test(raw)) return '该音色需要网络，请选择离线音色或检查网络。';
  if (/interrupted|canceled|cancelled|aborted/i.test(raw)) return '朗读已停止。';
  return raw ? `朗读失败：${raw}` : '朗读失败，请检查系统语音设置。';
}

/**
 * Thin, cancellable bridge over Android/iOS TextToSpeech or Web Speech.
 * speak() resolves with { status: 'done' | 'cancelled' | 'error', error? }.
 */
export class SystemSpeech {
  constructor({ onVoicesChanged } = {}) {
    this.onVoicesChanged = onVoicesChanged || (() => {});
    this.isNativeApp = typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform?.());
    this.plugin = nativePlugin();
    this.kind = this.plugin ? 'native' : (hasWebSpeech() ? 'web' : 'none');
    this.voices = [];
    this.voicesLoaded = false;
    this.voicesError = '';
    this.request = 0;
    this.activeCancel = null;
    this.utterance = null;
    this.synth = this.kind === 'web' ? window.speechSynthesis : null;
    this.voiceListener = null;
    if (this.kind === 'web') {
      this.voiceListener = () => {
        this.voices = normalizeVoices(this.synth.getVoices());
        this.voicesLoaded = true;
        this.onVoicesChanged(this.voices);
      };
      try {
        this.synth.addEventListener?.('voiceschanged', this.voiceListener);
      } catch {
        /* older engines do not expose the event */
      }
      const initial = this.synth.getVoices();
      if (initial.length) {
        this.voices = normalizeVoices(initial);
        this.voicesLoaded = true;
      }
    }
  }

  get supported() {
    return this.kind !== 'none';
  }

  get engineName() {
    if (this.kind === 'native') return '手机系统语音引擎';
    if (this.kind === 'web') return '浏览器系统语音引擎';
    return '系统语音引擎';
  }

  get unsupportedMessage() {
    if (this.isNativeApp) {
      return '未检测到可用的系统语音引擎。请到“设置 → 辅助功能 → 无障碍 → 文本转语音”启用语音引擎后重试。';
    }
    return '当前浏览器不支持系统语音朗读。Android 手机请安装墨阅 APK，或改用 Chrome / Edge 浏览器。';
  }

  async loadVoices({ force = false } = {}) {
    if (this.kind === 'none') {
      this.voicesError = this.unsupportedMessage;
      return { voices: [], error: this.voicesError };
    }
    if (this.voicesLoaded && !force) {
      return { voices: this.voices, error: this.voicesError };
    }
    if (this.kind === 'web') {
      let raw = [];
      try {
        raw = this.synth.getVoices();
      } catch {
        raw = [];
      }
      if (!raw.length) {
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            this.synth.removeEventListener?.('voiceschanged', finish);
            resolve();
          };
          this.synth.addEventListener?.('voiceschanged', finish, { once: true });
          setTimeout(finish, 1400);
        });
        raw = this.synth.getVoices();
      }
      this.voices = normalizeVoices(raw);
      this.voicesLoaded = true;
      this.voicesError = raw.length ? '' : '未读取到系统音色，将使用系统默认音色。';
      return { voices: this.voices, error: this.voicesError };
    }

    if (force) this.voicesLoaded = false;
    let lastError = null;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      try {
        const result = await this.plugin.getSupportedVoices();
        const raw = Array.isArray(result?.voices) ? result.voices : [];
        // Some Android engines return an empty list while initialization is still
        // in progress. Give them a few short retries before accepting the default.
        if (!raw.length && attempt < 2) {
          await wait(260 + attempt * 180);
          continue;
        }
        this.voices = normalizeVoices(raw, { native: true });
        this.voicesLoaded = true;
        this.voicesError = raw.length ? '' : '系统语音引擎没有返回音色，将使用系统默认音色。';
        return { voices: this.voices, error: this.voicesError };
      } catch (error) {
        lastError = error;
        await wait(220 + attempt * 70);
      }
    }
    this.voicesError = describeSpeechError(lastError);
    return { voices: this.voices, error: this.voicesError };
  }

  selectVoice(voiceURI) {
    return findVoice(this.voices, voiceURI);
  }

  /**
   * Read one chunk. The promise settles when the engine finishes, or when stop()
   * is called even if the native plugin never resolves a stopped utterance.
   */
  async speak(text, { rate = 1, voiceURI = '' } = {}) {
    if (!this.supported || !String(text || '').trim()) {
      return { status: 'error', error: new Error('暂无可朗读的文字。') };
    }
    if (this.activeCancel) this.stop();
    const request = ++this.request;
    const voice = this.selectVoice(voiceURI);
    const speechRate = clampSpeechRate(rate);
    const payloadText = String(text).slice(0, 4000);

    if (this.kind === 'native') {
      const options = {
        text: payloadText,
        lang: voice?.lang || inferSpeechLanguage(payloadText),
        rate: speechRate,
        pitch: 1,
        volume: 1,
      };
      if (voice && voice._nativeIndex !== null && voice._nativeIndex >= 0) {
        options.voice = voice._nativeIndex;
      }
      let cancel = null;
      const cancelled = new Promise((resolve) => {
        cancel = () => resolve({ status: 'cancelled' });
        this.activeCancel = cancel;
      });
      const done = (async () => {
        let lastError = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (request !== this.request) return { status: 'cancelled' };
          try {
            await this.plugin.speak(options);
            return { status: 'done' };
          } catch (error) {
            lastError = error;
            const message = String(error?.message || error || '');
            const notReady = /not yet initialized|not available|unavailable/i.test(message);
            if (!notReady || attempt === 3) break;
            await wait(300 + attempt * 250);
          }
        }
        return { status: 'error', error: lastError };
      })();
      const result = await Promise.race([done, cancelled]);
      if (this.activeCancel === cancel) this.activeCancel = null;
      if (result.status !== 'cancelled' && request !== this.request) return { status: 'cancelled' };
      return result;
    }

    const synth = this.synth;
    let utterance;
    try {
      utterance = new window.SpeechSynthesisUtterance(payloadText);
    } catch (error) {
      return { status: 'error', error };
    }
    if (voice?._raw) utterance.voice = voice._raw;
    utterance.lang = voice?.lang || inferSpeechLanguage(payloadText);
    utterance.rate = speechRate;
    utterance.pitch = 1;
    utterance.volume = 1;
    this.utterance = utterance;

    let cancel = null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (this.utterance === utterance) this.utterance = null;
        if (this.activeCancel === cancel) this.activeCancel = null;
        resolve(result);
      };
      cancel = () => {
        try { synth.cancel(); } catch { /* ignore */ }
        finish({ status: 'cancelled' });
      };
      this.activeCancel = cancel;
      utterance.onend = () => finish({ status: 'done' });
      utterance.onerror = (event) => {
        const reason = String(event?.error || '');
        if (/cancel|interrupt|abort/i.test(reason)) finish({ status: 'cancelled' });
        else finish({ status: 'error', error: event });
      };
      try {
        synth.speak(utterance);
      } catch (error) {
        finish({ status: 'error', error });
      }
    });
  }

  stop() {
    this.request += 1;
    const cancel = this.activeCancel;
    this.activeCancel = null;
    if (cancel) {
      try { cancel(); } catch { /* ignore */ }
    }
    if (this.kind === 'native') {
      Promise.resolve(this.plugin.stop()).catch(() => {});
    } else if (this.kind === 'web') {
      try { this.synth.cancel(); } catch { /* ignore */ }
    }
    this.utterance = null;
  }

  dispose() {
    this.stop();
    if (this.kind === 'web' && this.voiceListener) {
      try { this.synth.removeEventListener?.('voiceschanged', this.voiceListener); } catch { /* ignore */ }
    }
    this.voiceListener = null;
  }
}
