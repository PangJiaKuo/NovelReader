import { escapeHTML } from './util.js';

/** Number characters commonly used in Chinese chapter headings. */
const NUM = '0-9０-９零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟';
const CHAPTER_RE = new RegExp(
  `^第\\s*[${NUM}]+\\s*[章节卷回集部篇折]` +
  `(?:\\s*[：:·.、\\-—－]?\\s*\\S[^\\n]{0,48})?$`,
);
const VOLUME_RE = new RegExp(
  `^(?:卷\\s*[${NUM}]+|第\\s*[${NUM}]+\\s*卷)(?:\\s*[：:·.、\\-—－]?\\s*\\S[^\\n]{0,48})?$`,
);
const SPECIAL_RE = new RegExp(
  '^(?:序|序章|序言|自序|前言|引子|楔子|后记|尾声|终章|结局|大结局|' +
  '番外(?:篇)?(?:\\s*[0-9零〇一二三四五六七八九十百]+)?|完本感言|作者的话|' +
  '内容简介|Prologue|Epilogue|Introduction|Afterword|Interlude)' +
  '(?:\\s*[：:·.、\\-—－]?\\s*\\S[^\\n]{0,40})?$',
  'i',
);
const EN_CHAPTER_RE = /^(?:chapter|ch\.?|part|book)\s+(?:\d{1,4}|[ivxlcdm]{1,8})(?:\s*[:.\-—]\s*|\s+)?[^\n]{0,60}$/i;

/**
 * Returns a cleaned chapter title when the whole line looks like a chapter
 * heading, otherwise null. Kept intentionally conservative to avoid turning
 * ordinary prose into chapters.
 */
export function detectChapterTitle(line) {
  if (typeof line !== 'string') return null;
  let title = line.replace(/^\uFEFF/, '').trim();
  if (!title || title.length > 64) return null;

  // Unwrap decorative wrappers: 【第一章 回山】 / [Chapter 2]
  const wrapped = title.match(/^[【\[（(]\s*(.+?)\s*[】\]）)]$/);
  if (wrapped) title = wrapped[1].trim();
  if (!title) return null;

  // Some TXT files prefix headings with "正文".
  title = title.replace(/^正文\s*[:：·.\-—]?\s*/, '').trim();
  if (!title) return null;

  if (title.length > 56) return null;

  // A heading is one short line, not a sentence.
  if (/[。！？!?；;]\s*$/.test(title)) return null;
  const sentenceMarks = (title.match(/[。！？!?]/g) || []).length;
  if (sentenceMarks > 1) return null;
  if (title.length > 28 && /[，,]/.test(title) && /[。！？!?]/.test(title)) return null;

  const matches =
    CHAPTER_RE.test(title) ||
    VOLUME_RE.test(title) ||
    SPECIAL_RE.test(title) ||
    EN_CHAPTER_RE.test(title);
  if (!matches) return null;

  // Normalize full-width spaces between number and title.
  return title.replace(/\s+/g, ' ').replace(/^第\s+/, '第').replace(/\s+章/, '章');
}

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\n{3,}/g, '\n\n');
}

export function countChars(text) {
  return String(text ?? '').replace(/\s+/g, '').length;
}

/** Split text into paragraph-sized units without losing content. */
function paragraphUnits(text) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  let units;
  if (source.includes('\n')) {
    units = source.split(/\n+/);
  } else {
    // A single enormous line: break on sentence punctuation.
    units = source.match(/[^。！？!?…；;]{1,400}[。！？!?…；;]*|[^。！？!?…；;]+$/g) || [source];
  }
  return units.map((unit) => unit.trim()).filter(Boolean);
}

function hardSplit(unit, max) {
  if (unit.length <= max) return [unit];
  const parts = [];
  let rest = unit;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (const mark of ['。', '！', '？', '；', '，', '、', ' ', '\n']) {
      cut = Math.max(cut, window.lastIndexOf(mark));
    }
    if (cut < max * 0.4) cut = max;
    else cut += 1;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Split long text into balanced parts at paragraph boundaries. */
export function splitByLength(text, maxChars = 45000) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  if (source.length <= maxChars) return [source];

  const units = paragraphUnits(source);
  const chunks = [];
  let buffer = '';
  for (const rawUnit of units) {
    for (const unit of hardSplit(rawUnit, Math.max(2000, maxChars - 200))) {
      const candidate = buffer ? `${buffer}\n\n${unit}` : unit;
      if (candidate.length > maxChars && buffer) {
        chunks.push(buffer);
        buffer = unit;
      } else {
        buffer = candidate;
      }
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks.length ? chunks : [source];
}

/**
 * Parse a plain-text novel. Returns [{ title, text, synthetic }] where `text`
 * is the chapter body. Headings are removed from the body and rendered by the
 * reader instead.
 */
export function splitTextIntoChapters(text, { maxChars = 45000, segmentSize = 24000 } = {}) {
  const source = normalizeText(text);
  if (!source.trim()) return [];

  const headings = [];
  let offset = 0;
  for (const line of source.split('\n')) {
    const title = detectChapterTitle(line);
    if (title) {
      headings.push({ title, start: offset, contentStart: offset + line.length + 1 });
    }
    offset += line.length + 1;
  }

  if (headings.length === 0) {
    const parts = splitByLength(source, segmentSize);
    return parts.map((part, index) => ({
      title: parts.length > 1 ? `第 ${index + 1} 节` : '全文',
      text: part.trim(),
      synthetic: true,
    }));
  }

  const chapters = [];
  const prefix = source.slice(0, headings[0].start).trim();
  if (countChars(prefix) > 0) {
    chapters.push({ title: '前言', text: prefix, synthetic: true });
  }

  headings.forEach((heading, index) => {
    const end = index + 1 < headings.length ? headings[index + 1].start : source.length;
    const body = source.slice(heading.contentStart, end).trim();
    const parts = splitByLength(body, maxChars);
    if (parts.length === 0) {
      chapters.push({ title: heading.title, text: '', synthetic: false });
      return;
    }
    parts.forEach((part, partIndex) => {
      chapters.push({
        title: partIndex === 0 ? heading.title : `${heading.title}（续 ${partIndex + 1}）`,
        text: part.trim(),
        synthetic: false,
      });
    });
  });

  return chapters;
}

const HR_RE = /^(?:[*\-_=·•—]\s*){3,}$/;

/**
 * Convert plain text into safe reader HTML. Blank-line separated text becomes
 * paragraphs; otherwise one line is one paragraph.
 */
export function textToHtml(text) {
  const source = normalizeText(text).trim();
  if (!source) return '';

  const blocks = /\n\s*\n/.test(source)
    ? source.split(/\n\s*\n/)
    : source.split('\n');

  const html = [];
  for (const rawBlock of blocks) {
    const block = rawBlock.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
    if (!block) continue;
    if (HR_RE.test(block.replace(/\s+/g, ''))) {
      html.push('<hr>');
      continue;
    }
    const escaped = escapeHTML(block).replace(/\n/g, '<br>');
    html.push(`<p>${escaped}</p>`);
  }
  return html.join('\n');
}

export function chapterHeading(title) {
  return `<h2 class="chapter-heading">${escapeHTML(title)}</h2>`;
}

/* --------------------------------------------------------------------------
 * Minimal, safe Markdown support
 * ------------------------------------------------------------------------ */

export function splitMarkdownIntoChapters(text, { maxChars = 45000 } = {}) {
  const source = normalizeText(text);
  if (!source.trim()) return [];
  const lines = source.split('\n');
  const sections = [];
  let current = { title: null, lines: [] };
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const match = !inFence && line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (match) {
      if (current.lines.some((l) => l.trim())) sections.push(current);
      current = { title: match[2].trim(), lines: [], level: match[1].length };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.some((l) => l.trim()) || current.title) sections.push(current);

  if (!sections.some((section) => section.title)) {
    const chunks = splitByLength(source, maxChars);
    return chunks.map((chunk, index) => ({
      title: chunks.length > 1 ? `第 ${index + 1} 节` : '全文',
      markdown: chunk,
    }));
  }

  const result = [];
  sections.forEach((section, index) => {
    const body = section.lines.join('\n').trim();
    const title = section.title || (index === 0 ? '前言' : `第 ${index} 节`);
    const chunks = splitByLength(body, maxChars);
    if (!chunks.length) {
      result.push({ title, markdown: '' });
    } else {
      chunks.forEach((chunk, partIndex) => {
        result.push({
          title: partIndex === 0 ? title : `${title}（续 ${partIndex + 1}）`,
          markdown: chunk,
        });
      });
    }
  });
  return result;
}

function safeURL(url) {
  const value = String(url || '').trim();
  if (/^(?:https?:|mailto:)/i.test(value)) return value;
  return null;
}

function inlineMarkdown(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[\s（(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      const safe = safeURL(url.replace(/&amp;/g, '&'));
      return safe ? `<a href="${escapeHTML(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
    });
}

export function markdownToHtml(markdown) {
  const source = normalizeText(markdown).trim();
  if (!source) return '';
  const lines = source.split('\n');
  const out = [];
  let paragraph = [];
  let listType = null;
  let inFence = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const inner = paragraph
      .map((line) => inlineMarkdown(escapeHTML(line.replace(/^[\s\u3000]+/, ''))))
      .join('<br>');
    out.push(`<p>${inner}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        out.push(`<pre><code>${escapeHTML(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inFence = false;
      } else {
        flushParagraph();
        flushList();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(6, heading[1].length + 1);
      out.push(`<h${level}>${inlineMarkdown(escapeHTML(heading[2]))}</h${level}>`);
      continue;
    }
    if (/^\s*(?:[-*_])\s*(?:[-*_]\s*){2,}$/.test(line)) {
      flushParagraph();
      flushList();
      out.push('<hr>');
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      out.push(`<blockquote>${inlineMarkdown(escapeHTML(quote[1]))}</blockquote>`);
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushParagraph();
      const wanted = ul ? 'ul' : 'ol';
      if (listType !== wanted) {
        flushList();
        listType = wanted;
        out.push(`<${wanted}>`);
      }
      out.push(`<li>${inlineMarkdown(escapeHTML((ul || ol)[1]))}</li>`);
      continue;
    }
    flushList();
    paragraph.push(line);
  }

  if (inFence && codeLines.length) out.push(`<pre><code>${escapeHTML(codeLines.join('\n'))}</code></pre>`);
  flushParagraph();
  flushList();
  return out.join('\n');
}

export function htmlToPlainText(html) {
  if (typeof DOMParser === 'undefined') {
    return String(html ?? '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|h[1-6]|li|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return (doc.body.innerText || doc.body.textContent || '').trim();
}
