import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGsvRequest,
  GptSoVitsSpeech,
  GsvSpeechError,
  gsvEndpointCandidates,
} from '../js/gpt-sovits.js';
import {
  gsvConfigIssue,
  normalizeGsvConfig,
  resolveGsvTextLang,
} from '../js/tts.js';

test('normalizeGsvConfig trims paths, normalizes the base URL and clamps timeout', () => {
  const config = normalizeGsvConfig({
    apiBaseUrl: '  http://100.68.97.6:9881///  ',
    apiMode: 'NEKO',
    refAudioPath: '  /workspace/default_audio/voice.wav  ',
    promptText: '  こんにちは。  ',
    promptLang: 'JA',
    textLang: 'bad-value',
    timeout: 2,
    gptModelPath: ' /models/gpt.ckpt ',
    sovitsModelPath: ' /models/sovits.pth ',
  });

  assert.equal(config.apiBaseUrl, 'http://100.68.97.6:9881');
  assert.equal(config.apiMode, 'neko');
  assert.equal(config.refAudioPath, '/workspace/default_audio/voice.wav');
  assert.equal(config.promptText, 'こんにちは。');
  assert.equal(config.promptLang, 'ja');
  assert.equal(config.textLang, 'auto');
  assert.equal(config.timeout, 5);
  assert.equal(config.gptModelPath, '/models/gpt.ckpt');
  assert.equal(config.sovitsModelPath, '/models/sovits.pth');
});

test('normalizeGsvConfig adds a scheme to a bare server address', () => {
  const config = normalizeGsvConfig({ apiBaseUrl: '100.68.97.6:9881' });
  assert.equal(config.apiBaseUrl, 'http://100.68.97.6:9881');
});

test('gsvConfigIssue explains the first missing required field', () => {
  assert.match(gsvConfigIssue({}), /API 地址/);
  assert.match(gsvConfigIssue({ apiBaseUrl: 'http://host:9881' }), /参考音频/);
  assert.match(
    gsvConfigIssue({ apiBaseUrl: 'http://host:9881', refAudioPath: '/voice.wav' }),
    /参考音频里说的原话/,
  );
  assert.equal(
    gsvConfigIssue({
      apiBaseUrl: 'http://host:9881',
      refAudioPath: '/voice.wav',
      promptText: '测试参考文本',
    }),
    '',
  );
});

test('gsvConfigIssue rejects malformed API URLs', () => {
  assert.match(gsvConfigIssue({ apiBaseUrl: 'http://' }), /格式不正确/);
  assert.match(gsvConfigIssue({ apiBaseUrl: 'http:// bad host:9881' }), /格式不正确/);
  assert.equal(
    gsvConfigIssue({
      apiBaseUrl: 'https://tts.example.com/gsv',
      refAudioPath: '/voice.wav',
      promptText: '参考文本',
    }),
    '',
  );
});

test('resolveGsvTextLang infers language unless the user forces one', () => {
  assert.equal(resolveGsvTextLang({ textLang: 'auto' }, '这是中文。'), 'zh');
  assert.equal(resolveGsvTextLang({ textLang: 'auto' }, 'これは日本語です。'), 'ja');
  assert.equal(resolveGsvTextLang({ textLang: 'auto' }, '안녕하세요.'), 'ko');
  assert.equal(resolveGsvTextLang({ textLang: 'auto' }, 'Hello there.'), 'en');
  assert.equal(resolveGsvTextLang({ textLang: 'all_zh' }, 'これは日本語です。'), 'all_zh');
});

test('buildGsvRequest generates the GPT-SoVITS v2 payload', () => {
  const payload = buildGsvRequest('这是正文。', {
    apiBaseUrl: 'http://host:9881',
    refAudioPath: '/voice.wav',
    promptText: '参考文本',
    promptLang: 'ja',
    textLang: 'auto',
  }, 1.25);

  assert.equal(payload.text, '这是正文。');
  assert.equal(payload.text_lang, 'zh');
  assert.equal(payload.ref_audio_path, '/voice.wav');
  assert.equal(payload.prompt_text, '参考文本');
  assert.equal(payload.prompt_lang, 'ja');
  assert.equal(payload.text_split_method, 'cut5');
  assert.equal(payload.media_type, 'wav');
  assert.equal(payload.streaming_mode, false);
  assert.equal(payload.speed_factor, 1.25);
});

test('gsvEndpointCandidates prefers api_neko on port 9881 and supports overrides', () => {
  assert.deepEqual(gsvEndpointCandidates('http://host:9881', 'auto'), ['/api/v2/tts', '/tts']);
  assert.deepEqual(gsvEndpointCandidates('http://host:9880', 'auto'), ['/tts', '/api/v2/tts']);
  assert.deepEqual(gsvEndpointCandidates('http://host:9881', 'gsv'), ['/tts']);
  assert.deepEqual(gsvEndpointCandidates('http://host:9881', 'neko'), ['/api/v2/tts']);
  assert.deepEqual(
    gsvEndpointCandidates('http://host:9881', 'auto', '/tts'),
    ['/tts', '/api/v2/tts'],
  );
});

test('GptSoVitsSpeech reports configuration state without network access', () => {
  let config = {};
  const speech = new GptSoVitsSpeech({ getConfig: () => config });
  assert.equal(speech.supported, false);
  assert.match(speech.unsupportedMessage, /API 地址/);

  config = {
    apiBaseUrl: 'http://host:9881',
    refAudioPath: '/voice.wav',
    promptText: '参考文本',
  };
  assert.equal(speech.supported, true);
  assert.equal(speech.engineName, 'GPT-SoVITS');
  speech.dispose();
});

test('GsvSpeechError exposes a friendly user message', () => {
  const error = new GsvSpeechError('无法连接 GPT-SoVITS 服务。', { status: 404 });
  assert.equal(error.name, 'GsvSpeechError');
  assert.equal(error.status, 404);
  assert.equal(error.userMessage, '无法连接 GPT-SoVITS 服务。');
});
