import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampSpeechRate,
  inferSpeechLanguage,
  normalizeVoices,
  splitSpeechText,
  SystemSpeech,
} from '../js/tts.js';

test('splitSpeechText keeps sentence punctuation and source offsets', () => {
  const text = '第一句。第二句！还有第三句？';
  const chunks = splitSpeechText(text);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['第一句。', '第二句！', '还有第三句？']);
  for (const chunk of chunks) {
    assert.equal(text.slice(chunk.start, chunk.end), chunk.text);
  }
});

test('splitSpeechText includes trailing Chinese quotes in a sentence', () => {
  const text = '他说：“好。”然后走了。';
  const chunks = splitSpeechText(text);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['他说：“好。”', '然后走了。']);
});

test('splitSpeechText trims surrounding whitespace without losing offsets', () => {
  const text = '  第一句。\n\n  第二句。  ';
  const chunks = splitSpeechText(text);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['第一句。', '第二句。']);
  for (const chunk of chunks) {
    assert.equal(text.slice(chunk.start, chunk.end).trim(), chunk.text);
  }
});

test('splitSpeechText breaks long unpunctuated text into speakable pieces', () => {
  const text = '啊'.repeat(300);
  const chunks = splitSpeechText(text, 120);
  assert.deepEqual(chunks.map((chunk) => chunk.text.length), [120, 120, 60]);
  assert.equal(chunks.map((chunk) => chunk.text).join(''), text);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[1].start, chunks[0].end);
  assert.equal(chunks[2].start, chunks[1].end);
  assert.equal(chunks[2].end, text.length);
});

test('splitSpeechText handles English sentence boundaries', () => {
  const text = 'Hello world. Next line.';
  const chunks = splitSpeechText(text);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ['Hello world.', 'Next line.']);
});

test('speech rate and language helpers are defensive', () => {
  assert.equal(clampSpeechRate(undefined), 1);
  assert.equal(clampSpeechRate(0.1), 0.5);
  assert.equal(clampSpeechRate(4), 2);
  assert.equal(clampSpeechRate(1.234), 1.25);
  assert.equal(inferSpeechLanguage('这是一段中文。'), 'zh-CN');
  assert.equal(inferSpeechLanguage('This is English.'), 'en-US');
});

test('normalizeVoices sorts for display but keeps native indices', () => {
  const raw = [
    { name: 'English', lang: 'en-US', voiceURI: 'en-voice', localService: true },
    { name: 'Chinese 1', lang: 'zh-CN', voiceURI: 'zh-voice-1', localService: true },
    { name: 'Chinese 2', lang: 'zh-CN', voiceURI: 'zh-voice-2', localService: false },
  ];
  const voices = normalizeVoices(raw, { native: true });
  assert.deepEqual(voices.map((voice) => voice.voiceURI), ['zh-voice-1', 'zh-voice-2', 'en-voice']);
  assert.equal(voices[0]._nativeIndex, 1);
  assert.equal(voices[1]._nativeIndex, 2);
  assert.equal(voices[2]._nativeIndex, 0);
});

test('SystemSpeech speaks through the native plugin with the selected voice index', async () => {
  const calls = [];
  let spoken = null;
  const plugin = {
    async getSupportedVoices() {
      return {
        voices: [
          { name: 'English', lang: 'en-US', voiceURI: 'en-voice' },
          { name: 'Chinese 1', lang: 'zh-CN', voiceURI: 'zh-voice-1' },
          { name: 'Chinese 2', lang: 'zh-CN', voiceURI: 'zh-voice-2' },
        ],
      };
    },
    speak(options) {
      calls.push(options);
      spoken = options;
      return Promise.resolve();
    },
    stop() {
      return Promise.resolve();
    },
  };
  globalThis.window = {
    Capacitor: {
      isNativePlatform: () => true,
      isPluginAvailable: () => true,
      registerPlugin: (name) => {
        assert.equal(name, 'TextToSpeech');
        return plugin;
      },
    },
  };

  try {
    const speech = new SystemSpeech();
    assert.equal(speech.kind, 'native');
    const loaded = await speech.loadVoices();
    assert.equal(loaded.voices.length, 3);
    const result = await speech.speak('测试一句话。', { rate: 1.2, voiceURI: 'zh-voice-2' });
    assert.equal(result.status, 'done');
    assert.equal(calls.length, 1);
    assert.equal(spoken.voice, 2);
    assert.equal(spoken.lang, 'zh-CN');
    assert.equal(spoken.rate, 1.2);
    speech.dispose();
  } finally {
    delete globalThis.window;
  }
});

test('SystemSpeech ignores an unavailable native plugin and uses the web engine', () => {
  let registered = false;
  class FakeUtterance {
    constructor(text) {
      this.text = text;
    }
  }
  globalThis.window = {
    Capacitor: {
      isNativePlatform: () => true,
      isPluginAvailable: (name) => {
        assert.equal(name, 'TextToSpeech');
        return false;
      },
      registerPlugin: () => {
        registered = true;
        throw new Error('should not register');
      },
    },
    speechSynthesis: {
      getVoices: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      speak: () => {},
      cancel: () => {},
    },
    SpeechSynthesisUtterance: FakeUtterance,
  };

  try {
    const speech = new SystemSpeech();
    assert.equal(speech.kind, 'web');
    assert.equal(registered, false);
    speech.dispose();
  } finally {
    delete globalThis.window;
  }
});

test('SystemSpeech stop cancels a pending native utterance', async () => {
  let stopped = false;
  const plugin = {
    async getSupportedVoices() {
      return { voices: [{ name: 'Chinese', lang: 'zh-CN', voiceURI: 'zh' }] };
    },
    speak() {
      return new Promise(() => {});
    },
    stop() {
      stopped = true;
      return Promise.resolve();
    },
  };
  globalThis.window = {
    Capacitor: {
      isNativePlatform: () => true,
      isPluginAvailable: () => true,
      registerPlugin: () => plugin,
    },
  };

  try {
    const speech = new SystemSpeech();
    await speech.loadVoices();
    const pending = speech.speak('很长的一段话。', { voiceURI: 'zh' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    speech.stop();
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(stopped, true);
    speech.dispose();
  } finally {
    delete globalThis.window;
  }
});
