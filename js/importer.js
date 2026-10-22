/* File import pipeline: sniff, parse, normalize and persist books. */

import {
  countChars,
  chapterHeading,
  htmlToPlainText,
  markdownToHtml,
  normalizeText,
  splitMarkdownIntoChapters,
  splitTextIntoChapters,
  textToHtml,
} from './chapters.js';
import { parseEpub, decodeTextBuffer } from './epub.js';
import {
  deletePendingProgress,
  getBook,
  getPendingProgress,
  saveBookWithChapters,
  saveProgress,
} from './store.js';
import {
  detectFileKind,
  normalizeWhitespace,
  sha256Hex,
  stripExtension,
  delay,
} from './util.js';
import { SAMPLE_BOOK } from './sample.js';

const MAX_FILE_BYTES = 120 * 1024 * 1024;
const MAX_COVER_SIDE = 720;

export class ImportError extends Error {
  constructor(message, code = 'import_failed') {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

function titleFromFilename(name) {
  return stripExtension(name).replace(/[_]+/g, ' ').trim().slice(0, 200) || '未命名书籍';
}

function cleanTitle(value, fallback) {
  const title = normalizeWhitespace(value || '');
  if (!title) return fallback;
  return title.slice(0, 200);
}

function toneFor(seed) {
  let hash = 0;
  for (const char of String(seed)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return hash % 6;
}

function textMetadata(source) {
  const lines = source.split('\n');
  let title = '';
  let author = '';
  const remove = new Set();
  const limit = Math.min(lines.length, 16);
  for (let i = 0; i < limit; i += 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let match = raw.match(/^(?:书名| title)\s*[:：]\s*(.{1,100})$/i);
    if (match) {
      title = match[1].trim();
      remove.add(i);
      continue;
    }
    match = raw.match(/^(?:作者|作\s*者|author)\s*[:：]\s*(.{1,80})$/i);
    if (match) {
      author = match[1].trim();
      remove.add(i);
      continue;
    }
    match = raw.match(/^《(.{1,80})》$/);
    if (match && i <= 4) {
      title = match[1].trim();
      remove.add(i);
      continue;
    }
  }
  let text = source;
  if (remove.size) {
    text = lines.filter((_, index) => !remove.has(index)).join('\n').replace(/^\s*\n/, '');
  }
  return {
    title: title.slice(0, 200),
    author: author.slice(0, 100),
    text,
  };
}

function formatLabel(kind) {
  return {
    epub: 'EPUB',
    txt: 'TXT',
    html: 'HTML',
    md: 'Markdown',
  }[kind] || '文档';
}

/* ----------------------------- cover art -------------------------------- */

function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) throw new Error('无效的图片数据');
  const mime = match[1] || 'application/octet-stream';
  if (match[2]) {
    const binary = atob(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([new TextEncoder().encode(decodeURIComponent(match[3]))], { type: mime });
}

async function prepareCover(dataUrl) {
  if (!dataUrl) return '';
  if (dataUrl.length > 4 * 1024 * 1024) return '';
  try {
    const blob = dataUrlToBlob(dataUrl);
    let bitmap;
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(blob);
    } else {
      bitmap = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = dataUrl;
      });
    }
    const width = bitmap.width || bitmap.naturalWidth;
    const height = bitmap.height || bitmap.naturalHeight;
    if (!width || !height) return '';
    const scale = Math.min(1, MAX_COVER_SIDE / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#f6f1e6';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (typeof bitmap.close === 'function') bitmap.close();
    const webp = canvas.toDataURL('image/webp', 0.82);
    if (webp.startsWith('data:image/webp')) return webp;
    return canvas.toDataURL('image/jpeg', 0.84);
  } catch {
    return dataUrl.length < 1.5 * 1024 * 1024 ? dataUrl : '';
  }
}

/* -------------------------- HTML sanitizing ----------------------------- */

const HTML_BLOCKED = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'video', 'audio', 'source', 'track', 'canvas', 'svg', 'math', 'noscript',
  'template', 'frame', 'frameset', 'link', 'meta', 'base', 'nav', 'footer',
]);

const HTML_ALLOWED_ATTRS = new Set([
  'id', 'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'dir', 'lang',
  'start', 'reversed', 'type',
]);

function sanitizeDocument(doc) {
  if (!doc?.body) return;
  doc.body.querySelectorAll(Array.from(HTML_BLOCKED).join(',')).forEach((el) => el.remove());
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((node) => node.remove());

  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    if (HTML_BLOCKED.has(el.localName)) {
      el.remove();
      continue;
    }
    for (const attribute of Array.from(el.attributes)) {
      if (!HTML_ALLOWED_ATTRS.has(attribute.name)) el.removeAttribute(attribute.name);
    }
    if (el.localName === 'a') {
      const href = el.getAttribute('href') || '';
      if (!href || href.startsWith('#')) continue;
      if (/^(?:https?:|mailto:)/i.test(href)) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      } else {
        el.removeAttribute('href');
      }
    }
    if (el.localName === 'img') {
      const src = el.getAttribute('src') || '';
      if (!/^(?:data:image\/|https?:)/i.test(src)) {
        el.remove();
        continue;
      }
      el.setAttribute('loading', 'lazy');
      el.setAttribute('referrerpolicy', 'no-referrer');
      el.setAttribute('alt', el.getAttribute('alt') || '图片');
    }
  }
}

function parseHtmlSource(source, filename) {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const rawTitle = normalizeWhitespace(doc.title || '');
  sanitizeDocument(doc);
  const fallbackTitle = titleFromFilename(filename);
  const headings = Array.from(doc.body?.querySelectorAll('h1,h2,h3') || [])
    .filter((heading) => normalizeWhitespace(heading.textContent));
  const bookTitle = cleanTitle(rawTitle || headings[0]?.textContent, fallbackTitle);
  const chapters = [];
  const body = doc.body;
  if (!body) return { title: bookTitle, chapters: [] };

  const makeFragmentHtml = (range) => {
    const holder = doc.createElement('div');
    holder.append(range.cloneContents());
    return { html: holder.innerHTML.trim(), text: normalizeWhitespace(holder.textContent), hasImage: Boolean(holder.querySelector('img')) };
  };

  const pushChapter = (title, range, preamble = false) => {
    const content = makeFragmentHtml(range);
    const text = content.text;
    if (!text && !content.hasImage) return;
    if (preamble && text.length < 12 && !content.hasImage) return;
    chapters.push({
      title: normalizeWhitespace(title || `第 ${chapters.length + 1} 章`).slice(0, 120) || `第 ${chapters.length + 1} 章`,
      html: content.html,
      text,
      chars: countChars(text),
    });
  };

  if (!headings.length) {
    const range = doc.createRange();
    range.selectNodeContents(body);
    pushChapter(bookTitle, range);
  } else {
    if (headings.length) {
      const preambleRange = doc.createRange();
      preambleRange.selectNodeContents(body);
      preambleRange.setEndBefore(headings[0]);
      pushChapter('前言', preambleRange, true);
    }
    headings.forEach((heading, index) => {
      const range = doc.createRange();
      range.setStartBefore(heading);
      if (index + 1 < headings.length) range.setEndBefore(headings[index + 1]);
      else {
        range.setStartBefore(heading);
        range.setEnd(body, body.childNodes.length);
      }
      pushChapter(heading.textContent, range);
    });
  }

  if (!chapters.length) throw new ImportError('这个 HTML 文件里没有可阅读的文字');
  return { title: bookTitle, chapters };
}

/* ------------------------------ text/MD --------------------------------- */

function parseTextSource(source, filename, kind) {
  const meta = textMetadata(source);
  const fallback = titleFromFilename(filename);
  const title = cleanTitle(meta.title, fallback);
  const author = meta.author || '';
  const text = normalizeText(meta.text);
  let chapters;

  if (kind === 'md') {
    const sections = splitMarkdownIntoChapters(text);
    chapters = sections.map((section) => {
      const bodyHtml = markdownToHtml(section.markdown);
      const fullHtml = `${chapterHeading(section.title)}${bodyHtml}`;
      const plain = htmlToPlainText(bodyHtml) || section.title;
      return {
        title: section.title,
        html: fullHtml,
        text: plain,
        chars: countChars(plain),
      };
    });
  } else {
    chapters = splitTextIntoChapters(text).map((chapter) => ({
      title: chapter.title,
      html: `${chapterHeading(chapter.title)}${textToHtml(chapter.text)}`,
      text: chapter.text,
      chars: countChars(chapter.text),
    }));
  }

  chapters = chapters.filter((chapter) => chapter.html || chapter.text);
  if (!chapters.length) throw new ImportError('文件内容为空');
  return { title, author, chapters };
}

/* ------------------------------ pipeline -------------------------------- */

export function progressFromPending(pending, bookId, chapterCount, fallbackUpdatedAt) {
  const chapterLimit = Math.max(1, Number(chapterCount) || 1);
  const pageCount = Math.max(1, Number(pending.pageCount) || 1);
  const pageIndex = Math.min(pageCount - 1, Math.max(0, Number(pending.pageIndex) || 0));
  const rawRatio = Number(pending.chapterRatio ?? pending.pageRatio);
  const chapterRatio = Number.isFinite(rawRatio)
    ? Math.max(0, Math.min(1, rawRatio))
    : pageCount > 1 ? pageIndex / (pageCount - 1) : 0;
  return {
    bookId,
    chapterIndex: Math.min(chapterLimit - 1, Math.max(0, Number(pending.chapterIndex) || 0)),
    chapterTitle: pending.chapterTitle || '',
    chapterCount: chapterLimit,
    pageIndex,
    pageCount,
    pageRatio: chapterRatio,
    chapterRatio,
    scrollRatio: Math.max(0, Math.min(1, Number(pending.scrollRatio) || 0)),
    percent: Math.max(0, Math.min(100, Number(pending.percent) || 0)),
    finished: Boolean(pending.finished),
    readingTime: Math.max(0, Number(pending.readingTime) || 0),
    updatedAt: Number(pending.updatedAt) || fallbackUpdatedAt,
    fromCloud: true,
  };
}

async function analyzeFile(file, { onProgress } = {}) {
  if (!file || !file.size) throw new ImportError('文件为空');
  if (file.size > MAX_FILE_BYTES) throw new ImportError('文件过大（最大支持 120MB）');

  onProgress?.({ stage: 'reading', message: '正在读取文件…' });
  const buffer = await file.arrayBuffer();
  let kind = detectFileKind(file);
  const head = new Uint8Array(buffer.slice(0, 8));
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    kind = 'epub';
  } else if (String.fromCharCode(...head.slice(0, 4)) === '%PDF') {
    throw new ImportError('暂不支持 PDF，请导入 EPUB / TXT / HTML / Markdown 文件', 'unsupported');
  }
  if (kind === 'unknown') {
    const textStart = decodeTextBuffer(new Uint8Array(buffer.slice(0, 2048))).toLowerCase();
    if (textStart.includes('<html') || textStart.includes('<!doctype html')) kind = 'html';
    else kind = 'txt';
  }
  if (['mobi', 'azw', 'azw3'].includes(String(file.name).split('.').pop().toLowerCase())) {
    throw new ImportError('暂不支持 MOBI / AZW3，请先转换为 EPUB 后导入', 'unsupported');
  }

  const hash = await sha256Hex(buffer);
  onProgress?.({ stage: 'parsing', message: kind === 'epub' ? '正在解析 EPUB…' : '正在识别章节…' });
  let parsed;

  if (kind === 'epub') {
    parsed = await parseEpub(buffer, file.name, {
      onProgress: ({ current, total }) => {
        onProgress?.({
          stage: 'parsing',
          message: `正在解析 EPUB  ${current} / ${total}`,
          progress: total ? current / total : 0,
        });
      },
    });
  } else {
    const source = decodeTextBuffer(new Uint8Array(buffer));
    if (!source.trim()) throw new ImportError('文件内容为空');
    if (kind === 'html') {
      parsed = parseHtmlSource(source, file.name);
    } else {
      parsed = parseTextSource(source, file.name, kind);
    }
  }

  if (!parsed.chapters?.length) throw new ImportError('没有找到可阅读的章节');
  await delay(0);

  const chapters = parsed.chapters;
  const totalChars = chapters.reduce((sum, chapter) => sum + (chapter.chars || 0), 0);
  const title = cleanTitle(parsed.title, titleFromFilename(file.name));
  const author = normalizeWhitespace(parsed.author || '').slice(0, 120);
  const cover = await prepareCover(parsed.cover || '');
  const now = Date.now();

  const book = {
    id: hash,
    title,
    author,
    description: (parsed.description || '').slice(0, 2000),
    language: parsed.language || '',
    format: formatLabel(kind),
    sourceName: file.name,
    size: file.size,
    cover,
    tone: toneFor(title + author),
    createdAt: now,
    updatedAt: now,
    chapterCount: chapters.length,
    chars: totalChars,
    chaptersMeta: chapters.map((chapter) => ({ title: chapter.title, chars: chapter.chars || 0 })),
  };

  onProgress?.({ stage: 'saving', message: '正在写入书架…' });
  await saveBookWithChapters(book, chapters);

  // Restore cloud reading progress for this book if it arrived before the file.
  const pending = await getPendingProgress(hash);
  if (pending) {
    await saveProgress(progressFromPending(pending, hash, chapters.length, now));
    await deletePendingProgress(hash);
  }

  return { book, hash, duplicate: false };
}

export async function importBookFile(file, options = {}) {
  if (!file) throw new ImportError('没有选择文件');
  const buffer = await file.arrayBuffer();
  const hash = await sha256Hex(buffer);
  const existing = await getBook(hash);
  if (existing) {
    const pending = await getPendingProgress(hash);
    if (pending) {
      await saveProgress(progressFromPending(pending, hash, existing.chapterCount, Date.now()));
      await deletePendingProgress(hash);
    }
    return { book: existing, hash, duplicate: true };
  }

  // Re-read is avoided by handing the buffer through a lightweight File-like
  // object only when the browser supports File construction.
  const proxy = new File([buffer], file.name, { type: file.type || '' });
  return analyzeFile(proxy, options);
}

export async function importSampleBook({ onProgress } = {}) {
  const file = new File([SAMPLE_BOOK.text], SAMPLE_BOOK.filename, { type: 'text/plain' });
  return importBookFile(file, { onProgress });
}

export async function removeSampleFlag() {
  // Reserved for future library tips; intentionally a no-op.
}

export { toneFor };
