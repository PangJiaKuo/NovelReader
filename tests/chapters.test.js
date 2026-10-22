import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chapterHeading,
  detectChapterTitle,
  splitTextIntoChapters,
  splitMarkdownIntoChapters,
  markdownToHtml,
  textToHtml,
  countChars,
} from '../js/chapters.js';

test('detectChapterTitle recognizes common Chinese and English headings', () => {
  assert.equal(detectChapterTitle('第一章 雨落山门'), '第一章 雨落山门');
  assert.equal(detectChapterTitle('  第 12 章：旧信  '), '第12章：旧信');
  assert.equal(detectChapterTitle('【序章 一盏灯】'), '序章 一盏灯');
  assert.equal(detectChapterTitle('Chapter 3 - The Letter'), 'Chapter 3 - The Letter');
  assert.equal(detectChapterTitle('卷三 风雪归人'), '卷三 风雪归人');
});

test('detectChapterTitle rejects ordinary prose and long lines', () => {
  assert.equal(detectChapterTitle('第一章的雨下了一整夜，他没有睡。'), null);
  assert.equal(detectChapterTitle('这是普通的一行正文，不是章节标题。'), null);
  assert.equal(detectChapterTitle('第一章 ' + '很长'.repeat(40)), null);
  assert.equal(detectChapterTitle(''), null);
});

test('splitTextIntoChapters keeps headings and bodies together', () => {
  const text = `前言部分。

第一章 雨落山门

沈砚在一个雨天走进山寺。

第二章 守灯人

老人守着一盏灯。

后记

故事到这里结束。`;
  const chapters = splitTextIntoChapters(text);
  assert.deepEqual(chapters.map((chapter) => chapter.title), [
    '前言',
    '第一章 雨落山门',
    '第二章 守灯人',
    '后记',
  ]);
  assert.match(chapters[1].text, /沈砚/);
  assert.equal(chapters[0].synthetic, true);
  assert.equal(chapters[1].synthetic, false);
});

test('splitTextIntoChapters creates synthetic sections when no headings exist', () => {
  const chapters = splitTextIntoChapters('只有一段没有章节标题的正文。');
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, '全文');
  assert.equal(chapters[0].synthetic, true);
  assert.equal(splitTextIntoChapters('   ').length, 0);
});

test('splitTextIntoChapters splits oversized chapters without losing text', () => {
  const body = '长'.repeat(240) + '\n\n' + '短'.repeat(240);
  const chapters = splitTextIntoChapters(`第一章 长章\n\n${body}`, { maxChars: 300 });
  assert.ok(chapters.length >= 2);
  assert.match(chapters[1].title, /续 2/);
  assert.equal(chapters.map((chapter) => chapter.text).join('').replace(/\s/g, ''), body.replace(/\s/g, ''));
});

test('textToHtml escapes markup and splits paragraphs', () => {
  const html = textToHtml('第一段 <script>alert(1)</script>\n\n第二段 & 结尾');
  assert.match(html, /^<p>第一段 &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
  assert.match(html, /<p>第二段 &amp; 结尾<\/p>$/);
  assert.equal(countChars(' 一 二\n三 '), 3);
});

test('markdown headings become chapters and dangerous links are removed', () => {
  const chapters = splitMarkdownIntoChapters(`# 第一章 雨

正文 **加粗** 与 *斜体*。

## 第二章 灯

[安全链接](https://example.com) [危险链接](javascript:alert(1))`);
  assert.deepEqual(chapters.map((chapter) => chapter.title), ['第一章 雨', '第二章 灯']);
  const first = chapterHeading(chapters[0].title) + markdownToHtml(chapters[0].markdown);
  assert.match(first, /<h2[^>]*>第一章 雨<\/h2>/);
  assert.match(first, /<strong>加粗<\/strong>/);
  assert.match(first, /<em>斜体<\/em>/);
  const second = markdownToHtml(chapters[1].markdown);
  assert.match(second, /href="https:\/\/example.com"/);
  assert.doesNotMatch(second, /javascript:/);
});

test('markdownToHtml escapes raw HTML', () => {
  const html = markdownToHtml('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});
