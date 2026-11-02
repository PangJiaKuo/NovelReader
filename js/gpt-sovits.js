/* GPT-SoVITS external TTS adapter: synthesis, model switching and playback. */

import {
  clampSpeechRate,
  gsvConfigIssue,
  normalizeGsvConfig,
  resolveGsvTextLang,
} from './tts.js';

const MAX_CACHE_ENTRIES = 8;
const DEFAULT_TEST_TIMEOUT = 120;

export class GsvSpeechError extends Error {
  constructor(message, { status = 0, detail = '', cause = null } = {}) {
    super(message);
    this.name = 'GsvSpeechError';
    this.userMessage = message;
    this.status = status;
    this.detail = detail;
    if (cause) this.cause = cause;
  }
}

function isNativeApp() {
  return typeof window !== 'undefined' && Boolean(window.Capacitor?.isNativePlatform?.());
}

function isMixedContent(apiBaseUrl) {
  if (typeof location === 'undefined' || location.protocol !== 'https:') return false;
  if (!/^http:\/\//i.test(apiBaseUrl)) return false;
  return !isNativeApp();
}

function joinUrl(base, path) {
  const cleanBase = String(base || '').replace(/\/+$/, '');
  const cleanPath = String(path || '');
  return `${cleanBase}${cleanPath.startsWith('/') ? cleanPath : `/${cleanPath}`}`;
}

function endpointPrefix(endpoint) {
  return endpoint === '/api/v2/tts' ? '/api/v2' : '';
}

function configSignature(config) {
  return [
    config.apiBaseUrl,
    config.apiMode,
    config.refAudioPath,
    config.promptText,
    config.promptLang,
    config.textLang,
    config.compatPlayback ? 'compat' : 'standard',
    config.gptModelPath,
    config.sovitsModelPath,
  ].join('\u0001');
}

export function gsvEndpointCandidates(apiBaseUrl, apiMode = 'auto', cachedEndpoint = '') {
  if (apiMode === 'gsv') return ['/tts'];
  if (apiMode === 'neko') return ['/api/v2/tts'];
  const preferred = /:9881(?:$|[/?#])/i.test(String(apiBaseUrl || ''))
    ? ['/api/v2/tts', '/tts']
    : ['/tts', '/api/v2/tts'];
  if (!cachedEndpoint) return preferred;
  return [cachedEndpoint, ...preferred.filter((endpoint) => endpoint !== cachedEndpoint)];
}

export function buildGsvRequest(text, config, rate = 1) {
  const normalized = normalizeGsvConfig(config);
  return {
    text: String(text || ''),
    text_lang: resolveGsvTextLang(normalized, text),
    ref_audio_path: normalized.refAudioPath,
    prompt_text: normalized.promptText,
    prompt_lang: normalized.promptLang,
    text_split_method: 'cut5',
    batch_size: 1,
    media_type: 'wav',
    streaming_mode: false,
    speed_factor: clampSpeechRate(rate),
    top_k: 15,
    top_p: 1,
    temperature: 1,
    repetition_penalty: 1.35,
    sample_steps: 32,
    super_sampling: false,
    parallel_infer: true,
    seed: -1,
  };
}

/**
 * Build a GET /tts URL for the compatibility player. Media elements can load
 * cross-origin audio without CORS headers, which lets an APK talk to a stock
 * GPT-SoVITS server that has no CORSMiddleware.
 */
export function buildGsvCompatUrl(text, config, rate = 1) {
  const normalized = normalizeGsvConfig(config);
  const payload = buildGsvRequest(text, normalized, rate);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  return `${joinUrl(normalized.apiBaseUrl, '/tts')}?${params.toString()}`;
}

function errorDetail(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim().slice(0, 500);
  if (Array.isArray(payload)) {
    return payload.map((item) => errorDetail(item)).filter(Boolean).join('；').slice(0, 500);
  }
  if (typeof payload !== 'object') return '';
  const value = payload.message || payload.detail || payload.error || payload.Exception || payload.exception;
  if (value) return errorDetail(value);
  const first = Object.values(payload).find((item) => typeof item === 'string' && item.trim());
  return first ? String(first).trim().slice(0, 500) : '';
}

async function readResponseDetail(response) {
  try {
    const body = await response.text();
    if (!body) return '';
    try {
      return errorDetail(JSON.parse(body)) || body.trim().slice(0, 500);
    } catch {
      return body.trim().slice(0, 500);
    }
  } catch {
    return '';
  }
}

function httpErrorMessage(status, detail = '') {
  const tail = detail ? `服务端返回：${detail}` : '';
  if (status === 400 || status === 422) {
    return `请求参数被 GPT-SoVITS 拒绝（${status}）。请检查参考音频路径、参考文本和语言设置。${tail}`;
  }
  if (status === 404 || status === 405) {
    return `接口路径不存在（${status}）。请检查 API 地址，或在“模型与高级设置 → 接口格式”中切换 /tts 与 /api/v2/tts。${tail}`;
  }
  if (status === 401 || status === 403) {
    return `GPT-SoVITS 服务拒绝访问（${status}）。请确认服务端没有开启额外的访问限制。${tail}`;
  }
  if (status === 408 || status === 504) {
    return `GPT-SoVITS 合成超时（${status}）。可以调高“超时”或缩短单次朗读文本。${tail}`;
  }
  if (status >= 500) {
    return `GPT-SoVITS 服务内部错误（${status}）。请检查服务端日志和模型是否正常加载。${tail}`;
  }
  return `语音合成失败（${status}）。${tail}`;
}

function networkErrorMessage(apiBaseUrl, error) {
  if (isMixedContent(apiBaseUrl)) {
    return '当前页面是 HTTPS，浏览器会拦截 HTTP 的 GPT-SoVITS 请求。请改用 Android APK，或给 GPT-SoVITS 配置 HTTPS 反向代理。';
  }
  const raw = String(error?.message || error || '');
  if (/blocked by cors|failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return '无法连接 GPT-SoVITS 服务。请检查 API 地址、服务器是否在线，并确认服务端允许跨域（CORS）。';
  }
  return '无法连接 GPT-SoVITS 服务。请检查 API 地址、网络和服务器状态。';
}

function compatAudioErrorMessage(audio) {
  const code = Number(audio?.error?.code) || 0;
  if (code === 1) return '兼容播放已中止。';
  if (code === 2) return '兼容播放网络中断。请检查 GPT-SoVITS 服务是否在线。';
  if (code === 3) return '兼容播放无法解码服务器返回的音频。请确认服务端输出的是 WAV。';
  if (code === 4) {
    return '兼容播放无法读取服务器返回的音频。常见原因是接口路径、参考音频路径或模型配置错误；兼容模式无法读取具体 HTTP 状态，请查看服务端日志。';
  }
  return '兼容播放失败。请检查服务器状态、参考音频路径和接口格式。';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutSeconds, parentSignal) {
  const controller = new AbortController();
  const timeout = Math.max(1, Number(timeoutSeconds) || 60);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout * 1000);
  const forwardAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    return response;
  } catch (error) {
    if (parentSignal?.aborted) throw new GsvSpeechError('朗读已停止。', { cause: error });
    if (timedOut) {
      throw new GsvSpeechError(`GPT-SoVITS 请求超时（${timeout} 秒）。可以调高超时时间或缩短单次文本。`, { cause: error });
    }
    if (error instanceof GsvSpeechError) throw error;
    throw new GsvSpeechError(networkErrorMessage(url, error), { cause: error });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener?.('abort', forwardAbort);
  }
}

function base64ToArrayBuffer(value) {
  const raw = String(value || '').replace(/^data:[^;]+;base64,/i, '');
  if (!raw) throw new GsvSpeechError('服务端返回了空音频。');
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

/**
 * External GPT-SoVITS speech engine. The reader can swap this in for
 * SystemSpeech without changing the narration loop: speak() resolves with
 * { status: 'done' | 'cancelled' | 'error' }.
 */
export class GptSoVitsSpeech {
  constructor({ getConfig } = {}) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.request = 0;
    this.activeController = null;
    this.activeCancel = null;
    this.prefetchControllers = new Set();
    this.audioContext = null;
    this.source = null;
    this.cache = new Map();
    this.compatCache = new Map();
    this.compatAudio = null;
    this.endpointCache = null;
    this.modelKey = '';
    this.modelGpt = '';
    this.modelSovits = '';
    this.voices = [];
    this.voicesLoaded = true;
    this.voicesError = '';
  }

  get config() {
    return normalizeGsvConfig(this.getConfig());
  }

  get supported() {
    return !gsvConfigIssue(this.config);
  }

  get engineName() {
    return 'GPT-SoVITS';
  }

  get unsupportedMessage() {
    return gsvConfigIssue(this.config) || 'GPT-SoVITS 尚未配置。';
  }

  get needsVoices() {
    return false;
  }

  async loadVoices() {
    return { voices: [], error: '' };
  }

  selectVoice() {
    return null;
  }

  onConfigChanged() {
    this.cache.clear();
    this.endpointCache = null;
    this.resetModels();
    this.stop();
    this.clearCompatCache();
  }

  resetModels() {
    this.modelKey = '';
    this.modelGpt = '';
    this.modelSovits = '';
  }

  unlock() {
    if (this.config.compatPlayback) return;
    try {
      const context = this.ensureAudioContext();
      if (context.state === 'suspended') context.resume().catch(() => {});
    } catch {
      /* audio context is created lazily during playback too */
    }
  }

  ensureAudioContext() {
    if (this.audioContext) return this.audioContext;
    const AudioContextClass = typeof window !== 'undefined'
      ? (window.AudioContext || window.webkitAudioContext)
      : null;
    if (!AudioContextClass) {
      throw new GsvSpeechError('当前环境不支持音频播放，请改用支持 Web Audio 的浏览器或安装 APK。');
    }
    this.audioContext = new AudioContextClass();
    return this.audioContext;
  }

  cacheKey(text, rate) {
    return `${configSignature(this.config)}\u0002${clampSpeechRate(rate)}\u0002${text}`;
  }

  trimCache() {
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    while (this.compatCache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.compatCache.keys().next().value;
      const task = this.compatCache.get(oldest);
      this.compatCache.delete(oldest);
      task?.then((audio) => {
        if (audio !== this.compatAudio) this.releaseCompatAudio(audio);
      }).catch(() => {});
    }
  }

  /**
   * Synthesize the next sentence in the background while the current sentence
   * is playing. Failures are dropped; speak() will retry and surface the error.
   */
  prefetch(text, { rate = 1 } = {}) {
    if (!text || !this.supported) return;
    const key = this.cacheKey(text, rate);
    const compat = this.config.compatPlayback;
    const cache = compat ? this.compatCache : this.cache;
    if (cache.has(key)) return;
    const controller = new AbortController();
    this.prefetchControllers.add(controller);
    const task = (compat
      ? this.fetchCompatAudio(text, rate, controller.signal)
      : this.fetchAndDecode(text, rate, controller.signal))
      .catch((error) => {
        cache.delete(key);
        throw error;
      })
      .finally(() => {
        this.prefetchControllers.delete(controller);
      });
    task.catch(() => {});
    cache.set(key, task);
    this.trimCache();
  }

  getAudio(text, rate, signal) {
    const key = this.cacheKey(text, rate);
    const compat = this.config.compatPlayback;
    const cache = compat ? this.compatCache : this.cache;
    let task = cache.get(key);
    if (!task) {
      task = (compat
        ? this.fetchCompatAudio(text, rate, signal)
        : this.fetchAndDecode(text, rate, signal))
        .catch((error) => {
          cache.delete(key);
          throw error;
        });
      cache.set(key, task);
      this.trimCache();
    }
    return task;
  }

  async speak(text, { rate = 1, onStart } = {}) {
    if (!this.supported) {
      return { status: 'error', error: new GsvSpeechError(this.unsupportedMessage) };
    }
    if (!String(text || '').trim()) {
      return { status: 'error', error: new GsvSpeechError('暂无可朗读的文字。') };
    }
    if (this.activeCancel) this.stop();
    const request = ++this.request;
    const controller = new AbortController();
    this.activeController = controller;
    const compat = this.config.compatPlayback;
    try {
      const audio = await this.getAudio(String(text), rate, controller.signal);
      if (request !== this.request || controller.signal.aborted) return { status: 'cancelled' };
      const result = compat
        ? await this.playCompatAudio(audio, onStart, controller.signal)
        : await this.playBuffer(audio, onStart, controller.signal);
      if (request !== this.request) return { status: 'cancelled' };
      return result;
    } catch (error) {
      if (request !== this.request || controller.signal.aborted) return { status: 'cancelled' };
      return { status: 'error', error };
    } finally {
      if (this.activeController === controller) this.activeController = null;
    }
  }

  async fetchAndDecode(text, rate, signal) {
    const config = this.config;
    const issue = gsvConfigIssue(config);
    if (issue) throw new GsvSpeechError(issue);
    if (isMixedContent(config.apiBaseUrl)) {
      throw new GsvSpeechError(
        '当前页面是 HTTPS，浏览器会拦截 HTTP 的 GPT-SoVITS 请求。请改用 Android APK，或给 GPT-SoVITS 配置 HTTPS 反向代理。',
      );
    }

    const candidates = gsvEndpointCandidates(
      config.apiBaseUrl,
      config.apiMode,
      this.endpointCache?.base === config.apiBaseUrl ? this.endpointCache.endpoint : '',
    );
    const payload = buildGsvRequest(text, config, rate);
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const endpoint = candidates[index];
      try {
        await this.ensureModels(config, endpoint, signal);
        const response = await fetchWithTimeout(
          joinUrl(config.apiBaseUrl, endpoint),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          config.timeout,
          signal,
        );
        if (!response.ok) {
          const detail = await readResponseDetail(response);
          throw new GsvSpeechError(httpErrorMessage(response.status, detail), {
            status: response.status,
            detail,
          });
        }
        const buffer = await this.decodeResponse(response, config, signal);
        this.endpointCache = { base: config.apiBaseUrl, endpoint };
        return buffer;
      } catch (error) {
        lastError = error;
        const canRetry = config.apiMode === 'auto'
          && error instanceof GsvSpeechError
          && (error.status === 404 || error.status === 405)
          && index < candidates.length - 1;
        if (!canRetry) throw error;
      }
    }
    throw lastError || new GsvSpeechError('语音合成失败，请检查 GPT-SoVITS 服务。');
  }

  async fetchCompatAudio(text, rate, signal) {
    const config = this.config;
    const issue = gsvConfigIssue(config);
    if (issue) throw new GsvSpeechError(issue);
    if (isMixedContent(config.apiBaseUrl)) {
      throw new GsvSpeechError(
        '当前页面是 HTTPS，浏览器会拦截 HTTP 的 GPT-SoVITS 请求。请改用 Android APK，或给 GPT-SoVITS 配置 HTTPS 反向代理。',
      );
    }
    if (typeof Audio !== 'function') {
      throw new GsvSpeechError('当前环境不支持音频元素播放，请安装 Android APK 或使用支持音频的浏览器。');
    }
    if (signal?.aborted) throw new GsvSpeechError('朗读已停止。');

    const audio = new Audio();
    audio.preload = 'auto';
    audio.src = buildGsvCompatUrl(text, config, rate);
    const timeout = Math.max(1, Number(config.timeout) || 60);
    let timer = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', onReady);
        audio.removeEventListener('canplay', onReady);
        audio.removeEventListener('error', onError);
        signal?.removeEventListener?.('abort', onAbort);
      };
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          this.releaseCompatAudio(audio);
          reject(error);
        } else {
          resolve(value);
        }
      };
      const onReady = () => finish(audio);
      const onError = () => finish(null, new GsvSpeechError(compatAudioErrorMessage(audio)));
      const onAbort = () => finish(null, new GsvSpeechError('朗读已停止。'));

      audio.addEventListener('loadedmetadata', onReady, { once: true });
      audio.addEventListener('canplay', onReady, { once: true });
      audio.addEventListener('error', onError, { once: true });
      signal?.addEventListener?.('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        finish(null, new GsvSpeechError(
          `GPT-SoVITS 请求超时（${timeout} 秒）。可以调高超时时间或缩短单次文本。`,
        ));
      }, timeout * 1000);
      try {
        audio.load();
      } catch (error) {
        finish(null, new GsvSpeechError('兼容播放无法加载音频，请检查服务器地址。', { cause: error }));
      }
    });
  }

  async playCompatAudio(audio, onStart, signal) {
    if (signal?.aborted) return { status: 'cancelled' };
    this.compatAudio = audio;
    return new Promise((resolve) => {
      let settled = false;
      let started = false;
      const cleanup = () => {
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('error', onError);
        signal?.removeEventListener?.('abort', cancel);
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (this.compatAudio === audio) this.compatAudio = null;
        if (this.activeCancel === cancel) this.activeCancel = null;
        resolve(result);
      };
      const cancel = () => {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {
          /* already stopped */
        }
        finish({ status: 'cancelled' });
      };
      const onEnded = () => finish({ status: 'done' });
      const onError = () => finish({
        status: 'error',
        error: new GsvSpeechError(compatAudioErrorMessage(audio)),
      });
      const markStarted = () => {
        if (settled || started) return;
        started = true;
        try {
          onStart?.();
        } catch {
          /* prefetch is an optimization and must not interrupt playback */
        }
      };

      this.activeCancel = cancel;
      signal?.addEventListener?.('abort', cancel, { once: true });
      audio.addEventListener('ended', onEnded, { once: true });
      audio.addEventListener('error', onError, { once: true });
      try {
        audio.currentTime = 0;
      } catch {
        /* metadata may not be available yet */
      }
      let playPromise = null;
      try {
        playPromise = audio.play();
      } catch (error) {
        finish({
          status: 'error',
          error: new GsvSpeechError('兼容播放无法开始，请再次点击朗读。', { cause: error }),
        });
        return;
      }
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(markStarted).catch((error) => {
          if (settled) return;
          if (error?.name === 'AbortError') {
            finish({ status: 'cancelled' });
            return;
          }
          const message = error?.name === 'NotAllowedError'
            ? '浏览器阻止了音频播放，请再次点击朗读。'
            : '兼容播放无法开始，请检查服务器返回的音频格式。';
          finish({ status: 'error', error: new GsvSpeechError(message, { cause: error }) });
        });
      } else {
        markStarted();
      }
    });
  }

  releaseCompatAudio(audio) {
    if (!audio) return;
    try {
      audio.pause();
    } catch {
      /* already stopped */
    }
    try {
      audio.removeAttribute('src');
      audio.load();
    } catch {
      /* ignore cleanup failures */
    }
  }

  clearCompatCache() {
    const tasks = Array.from(this.compatCache.values());
    this.compatCache.clear();
    for (const task of tasks) {
      task?.then((audio) => {
        if (audio !== this.compatAudio) this.releaseCompatAudio(audio);
      }).catch(() => {});
    }
    if (this.compatAudio) {
      try {
        this.compatAudio.pause();
      } catch {
        /* ignore */
      }
      this.compatAudio = null;
    }
  }

  async ensureModels(config, endpoint, signal) {
    const gpt = config.gptModelPath;
    const sovits = config.sovitsModelPath;
    if (!gpt && !sovits) return;
    const key = [
      config.apiBaseUrl,
      endpoint,
      gpt,
      sovits,
    ].join('\u0001');
    if (this.modelKey !== key) {
      this.modelKey = key;
      this.modelGpt = '';
      this.modelSovits = '';
    }
    const prefix = endpointPrefix(endpoint);
    if (gpt && this.modelGpt !== gpt) {
      await this.switchModel(
        joinUrl(config.apiBaseUrl, `${prefix}/set_gpt_weights`),
        gpt,
        config,
        signal,
      );
      this.modelGpt = gpt;
    }
    if (sovits && this.modelSovits !== sovits) {
      await this.switchModel(
        joinUrl(config.apiBaseUrl, `${prefix}/set_sovits_weights`),
        sovits,
        config,
        signal,
      );
      this.modelSovits = sovits;
    }
  }

  async switchModel(url, weightsPath, config, signal) {
    const response = await fetchWithTimeout(
      `${url}?weights_path=${encodeURIComponent(weightsPath)}`,
      { method: 'GET' },
      Math.max(Number(config.timeout) || DEFAULT_TEST_TIMEOUT, DEFAULT_TEST_TIMEOUT),
      signal,
    );
    if (!response.ok) {
      const detail = await readResponseDetail(response);
      throw new GsvSpeechError(
        `切换 GPT-SoVITS 模型失败（${response.status}）。请确认模型路径在服务器上存在且可读。${detail ? `服务端返回：${detail}` : ''}`,
        { status: response.status, detail },
      );
    }
    // Give the inference worker a moment to release the previous weights before
    // the synthesis request arrives, especially on CPU-only deployments.
    await sleep(120);
  }

  async decodeResponse(response, config, signal) {
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new GsvSpeechError('GPT-SoVITS 返回了无法解析的 JSON。', { cause: error });
      }
      const encoded = payload?.audio || payload?.audio_base64 || payload?.data;
      if (typeof encoded === 'string') {
        return this.decodeAudio(base64ToArrayBuffer(encoded));
      }
      const remote = payload?.url || payload?.audio_url;
      if (typeof remote === 'string' && remote) {
        const audioResponse = await fetchWithTimeout(
          /^https?:\/\//i.test(remote) ? remote : joinUrl(config.apiBaseUrl, remote),
          { method: 'GET' },
          config.timeout,
          signal,
        );
        if (!audioResponse.ok) {
          throw new GsvSpeechError(`下载合成音频失败（${audioResponse.status}）。`);
        }
        return this.decodeAudio(await audioResponse.arrayBuffer());
      }
      const filename = payload?.filename || payload?.file;
      if (typeof filename === 'string' && filename) {
        for (const path of [`/audio/${encodeURIComponent(filename)}`, `/${filename.replace(/^\/+/, '')}`]) {
          try {
            const audioResponse = await fetchWithTimeout(
              joinUrl(config.apiBaseUrl, path),
              { method: 'GET' },
              config.timeout,
              signal,
            );
            if (audioResponse.ok) return this.decodeAudio(await audioResponse.arrayBuffer());
          } catch {
            /* try the next common audio path */
          }
        }
      }
      throw new GsvSpeechError(
        errorDetail(payload) || 'GPT-SoVITS 返回了 JSON，但没有可播放的音频数据。',
      );
    }
    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer.byteLength) throw new GsvSpeechError('GPT-SoVITS 返回了空音频。');
    return this.decodeAudio(arrayBuffer);
  }

  async decodeAudio(arrayBuffer) {
    const context = this.ensureAudioContext();
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (buffer) => {
          if (settled) return;
          settled = true;
          resolve(buffer);
        };
        const fail = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
        const maybe = context.decodeAudioData(arrayBuffer, finish, fail);
        if (maybe && typeof maybe.then === 'function') maybe.then(finish, fail);
      });
    } catch (error) {
      throw new GsvSpeechError(
        '无法解码 GPT-SoVITS 返回的音频。请确认服务端输出的是 WAV 或常见音频格式。',
        { cause: error },
      );
    }
  }

  async playBuffer(buffer, onStart, signal) {
    const context = this.ensureAudioContext();
    if (signal?.aborted) return { status: 'cancelled' };
    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        /* report a clearer error below */
      }
    }
    if (signal?.aborted) return { status: 'cancelled' };
    if (context.state !== 'running') {
      throw new GsvSpeechError('浏览器阻止了音频播放，请再次点击朗读。');
    }
    return new Promise((resolve) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      this.source = source;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (this.source === source) this.source = null;
        if (this.activeCancel === cancel) this.activeCancel = null;
        resolve(result);
      };
      const cancel = () => {
        try { source.stop(); } catch { /* already stopped */ }
        finish({ status: 'cancelled' });
      };
      this.activeCancel = cancel;
      source.onended = () => finish({ status: 'done' });
      try {
        source.start();
      } catch (error) {
        finish({
          status: 'error',
          error: new GsvSpeechError('音频播放失败，请再次点击朗读。', { cause: error }),
        });
        return;
      }
      try {
        onStart?.();
      } catch {
        /* prefetch is an optimization and must not interrupt playback */
      }
    });
  }

  stop() {
    this.request += 1;
    const controller = this.activeController;
    this.activeController = null;
    if (controller) controller.abort();
    for (const pending of this.prefetchControllers) pending.abort();
    this.prefetchControllers.clear();
    const cancel = this.activeCancel;
    this.activeCancel = null;
    if (cancel) {
      try { cancel(); } catch { /* ignore */ }
    }
    if (this.source) {
      try { this.source.stop(); } catch { /* ignore */ }
      this.source = null;
    }
    if (this.compatAudio) {
      try { this.compatAudio.pause(); } catch { /* ignore */ }
      this.compatAudio = null;
    }
  }

  dispose() {
    this.stop();
    this.cache.clear();
    this.clearCompatCache();
    this.prefetchControllers.clear();
    if (this.audioContext) {
      try { this.audioContext.close(); } catch { /* ignore */ }
    }
    this.audioContext = null;
  }
}
