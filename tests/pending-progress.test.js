import test from 'node:test';
import assert from 'node:assert/strict';

import { progressFromPending } from '../js/importer.js';

const pending = {
  hash: 'abc',
  chapterIndex: 2,
  chapterTitle: '第二章 长夜',
  chapterCount: 4,
  pageIndex: 2,
  pageCount: 5,
  chapterRatio: 0.5,
  scrollRatio: 0.45,
  percent: 63,
  finished: false,
  readingTime: 90000,
  updatedAt: 1700000000000,
};

test('progressFromPending preserves the exact cloud page position', () => {
  const progress = progressFromPending(pending, 'book-1', 4, 1);
  assert.deepEqual(progress, {
    bookId: 'book-1',
    chapterIndex: 2,
    chapterTitle: '第二章 长夜',
    chapterCount: 4,
    pageIndex: 2,
    pageCount: 5,
    pageRatio: 0.5,
    chapterRatio: 0.5,
    scrollRatio: 0.45,
    percent: 63,
    finished: false,
    readingTime: 90000,
    updatedAt: 1700000000000,
    fromCloud: true,
  });
});

test('progressFromPending derives the ratio and clamps out-of-range values', () => {
  const progress = progressFromPending({
    chapterIndex: 99,
    pageIndex: 9,
    pageCount: 4,
    chapterRatio: 4,
    scrollRatio: -1,
    percent: 180,
    updatedAt: 0,
  }, 'book-2', 3, 1234);
  assert.equal(progress.chapterIndex, 2);
  assert.equal(progress.pageIndex, 3);
  assert.equal(progress.pageCount, 4);
  assert.equal(progress.chapterRatio, 1);
  assert.equal(progress.pageRatio, 1);
  assert.equal(progress.scrollRatio, 0);
  assert.equal(progress.percent, 100);
  assert.equal(progress.updatedAt, 1234);
  assert.equal(progress.chapterCount, 3);
  assert.equal(progress.finished, false);
});

test('progressFromPending derives chapterRatio from pageIndex when absent', () => {
  const progress = progressFromPending({
    pageIndex: 2,
    pageCount: 5,
  }, 'book-3', 2, 1);
  assert.equal(progress.chapterRatio, 0.5);
  assert.equal(progress.pageRatio, 0.5);
  assert.equal(progress.pageIndex, 2);
  assert.equal(progress.chapterCount, 2);
});
