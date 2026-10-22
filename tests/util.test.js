import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  detectFileKind,
  escapeHTML,
  formatCount,
  formatDuration,
  normalizeWhitespace,
  sha256Hex,
  stripExtension,
} from '../js/util.js';

test('escapeHTML escapes all five reserved characters', () => {
  assert.equal(escapeHTML(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHTML(null), '');
});

test('clamp and normalizeWhitespace handle edge values', () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-2, 0, 3), 0);
  assert.equal(normalizeWhitespace('  一\n 二\t三  '), '一 二 三');
});

test('formatCount uses Chinese units', () => {
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(10000), '1 万');
  assert.equal(formatCount(12345), '1.2 万');
  assert.equal(formatCount(120000000), '1.2 亿');
});

test('formatDuration reports minutes and hours', () => {
  assert.equal(formatDuration(10000), '不足 1 分钟');
  assert.equal(formatDuration(10000, true), '<1 分钟');
  assert.equal(formatDuration(13 * 60000), '13 分钟');
  assert.equal(formatDuration(90 * 60000), '1 小时 30 分钟');
  assert.equal(formatDuration(120 * 60000, true), '2 小时');
});

test('detectFileKind handles supported formats and unknown files', () => {
  assert.equal(detectFileKind({ name: '书.EPUB', type: '' }), 'epub');
  assert.equal(detectFileKind({ name: '笔记.md', type: '' }), 'md');
  assert.equal(detectFileKind({ name: '页面.xhtml', type: '' }), 'html');
  assert.equal(detectFileKind({ name: '小说.txt', type: 'text/plain' }), 'txt');
  assert.equal(detectFileKind({ name: '报告.pdf', type: 'application/pdf' }), 'unknown');
  assert.equal(detectFileKind({ name: '', type: 'text/plain' }), 'txt');
});

test('stripExtension removes only the final extension', () => {
  assert.equal(stripExtension('灯.第一部.txt'), '灯.第一部');
  assert.equal(stripExtension('README'), 'README');
});

test('sha256Hex is stable for strings and typed arrays', async () => {
  const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(await sha256Hex('abc'), expected);
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), expected);
});
