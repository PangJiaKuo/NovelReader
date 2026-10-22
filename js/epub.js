/* ZIP reader + EPUB 2/3 parser, dependency free. */

import { normalizeWhitespace, stripExtension } from './util.js';

/* ------------------------------- ZIP ----------------------------------- */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function normalizeZipName(name) {
  return String(name)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

export class ZipArchive {
  constructor(buffer, entries) {
    this.buffer = buffer;
    this.entries = entries;
    this.lowerMap = new Map();
    for (const name of entries.keys()) {
      const lower = name.toLowerCase();
      if (!this.lowerMap.has(lower)) this.lowerMap.set(lower, name);
    }
  }

  static async open(buffer) {
    if (!(buffer instanceof ArrayBuffer)) throw new Error('ZIP 数据无效');
    const view = new DataView(buffer);
    let eocd = -1;
    const min = Math.max(0, buffer.byteLength - 22 - 0xffff);
    for (let i = buffer.byteLength - 22; i >= min; i -= 1) {
      if (view.getUint32(i, true) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 EPUB 文件（未找到 ZIP 目录）');

    const count = view.getUint16(eocd + 10, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (count === 0xffff || centralOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式的 EPUB');
    }

    const decoder = new TextDecoder('utf-8');
    const entries = new Map();
    let pointer = centralOffset;
    for (let i = 0; i < count; i += 1) {
      if (pointer + 46 > buffer.byteLength || view.getUint32(pointer, true) !== CENTRAL_SIG) break;
      const flags = view.getUint16(pointer + 8, true);
      const method = view.getUint16(pointer + 10, true);
      const compressedSize = view.getUint32(pointer + 20, true);
      const uncompressedSize = view.getUint32(pointer + 24, true);
      const nameLength = view.getUint16(pointer + 28, true);
      const extraLength = view.getUint16(pointer + 30, true);
      const commentLength = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      const nameBytes = new Uint8Array(buffer, pointer + 46, nameLength);
      const name = normalizeZipName(decoder.decode(nameBytes));
      entries.set(name, {
        name,
        flags,
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
      });
      pointer += 46 + nameLength + extraLength + commentLength;
    }

    if (entries.size === 0) throw new Error('EPUB 文件为空或已损坏');
    return new ZipArchive(buffer, entries);
  }

  has(path) {
    return this._resolveName(path) !== null;
  }

  _resolveName(path) {
    const normalized = normalizeZipName(path);
    if (this.entries.has(normalized)) return normalized;
    let decoded = normalized;
    try {
      decoded = normalizeZipName(decodeURIComponent(normalized));
      if (this.entries.has(decoded)) return decoded;
    } catch {
      /* keep raw */
    }
    const lower = decoded.toLowerCase();
    return this.lowerMap.get(lower) || null;
  }

  async bytes(path) {
    const name = this._resolveName(path);
    if (!name) return null;
    const entry = this.entries.get(name);
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`EPUB 使用了不支持的压缩方式（${entry.method}）`);
    }
    if (entry.flags & 1) throw new Error('暂不支持加密的 EPUB');

    const view = new DataView(this.buffer);
    if (view.getUint32(entry.localOffset, true) !== LOCAL_SIG) {
      throw new Error('EPUB 压缩包结构损坏');
    }
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    if (start + entry.compressedSize > this.buffer.byteLength) {
      throw new Error('EPUB 条目越界或已损坏');
    }
    const compressed = this.buffer.slice(start, start + entry.compressedSize);
    if (entry.method === 0) return new Uint8Array(compressed);

    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持解压 EPUB，请更换现代浏览器');
    }
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const inflated = await new Response(stream).arrayBuffer();
    return new Uint8Array(inflated);
  }

  async text(path) {
    const bytes = await this.bytes(path);
    return bytes ? decodeTextBuffer(bytes) : null;
  }

  names() {
    return Array.from(this.entries.keys());
  }
}

export function decodeTextBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

/* --------------------------- XML / paths ------------------------------- */

const XML_NS = {
  opf: 'http://www.idpf.org/2007/opf',
  dc: 'http://purl.org/dc/elements/1.1/',
  xhtml: 'http://www.w3.org/1999/xhtml',
  ncx: 'http://www.daisy.org/z3986/2005/ncx/',
  ops: 'http://www.idpf.org/2007/ops',
};

function elementsByLocalName(root, name) {
  if (!root) return [];
  const wanted = name.toLowerCase();
  const nodes = root.getElementsByTagNameNS
    ? Array.from(root.getElementsByTagNameNS('*', name))
    : Array.from(root.getElementsByTagName(name));
  if (nodes.length) return nodes;
  return Array.from(root.getElementsByTagName('*')).filter(
    (node) => (node.localName || node.nodeName.split(':').pop() || '').toLowerCase() === wanted,
  );
}

function firstByLocalName(root, name) {
  return elementsByLocalName(root, name)[0] || null;
}

function parseXml(text, label) {
  if (typeof DOMParser === 'undefined') throw new Error('当前环境不支持 XML 解析');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.querySelector('parsererror');
  if (error) throw new Error(`${label} 解析失败，EPUB 文件可能已损坏`);
  return doc;
}

export function normalizePath(input) {
  const raw = String(input || '').replace(/\\/g, '/').replace(/[?#].*$/, '');
  const parts = raw.split('/');
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function safeDecode(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function resolveHref(baseFile, href) {
  const raw = String(href || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  let clean = raw.replace(/[?#].*$/, '');
  if (!clean) return '';
  clean = safeDecode(clean);
  if (clean.startsWith('/')) return normalizePath(clean);
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return '';
  const base = baseFile.includes('/') ? baseFile.slice(0, baseFile.lastIndexOf('/') + 1) : '';
  return normalizePath(base + clean);
}

function hrefAnchor(href) {
  const match = String(href || '').match(/#(.+)$/);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function dirname(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function attr(el, name) {
  const value = el.getAttribute(name);
  return value == null ? '' : value;
}

function bytesToDataURL(bytes, mime) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`;
}

const IMAGE_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

function mimeForPath(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  return IMAGE_MIME[ext] || '';
}

/* ----------------------------- EPUB parse ------------------------------- */

/**
 * Parse an EPUB into { title, author, description, language, cover, chapters }.
 * Chapter HTML is sanitized, images are inlined as data URLs, and internal
 * links are rewritten for the reader.
 */
export async function parseEpub(buffer, filename = '', { onProgress } = {}) {
  const zip = await ZipArchive.open(buffer);
  let opfPath = '';

  const containerText = await zip.text('META-INF/container.xml');
  if (containerText) {
    const containerDoc = parseXml(containerText, 'container.xml');
    const rootfile = firstByLocalName(containerDoc, 'rootfile');
    opfPath = rootfile ? attr(rootfile, 'full-path') : '';
  }
  if (!opfPath || !zip.has(opfPath)) {
    opfPath = zip.names().find((name) => name.toLowerCase().endsWith('.opf')) || '';
  }
  if (!opfPath) throw new Error('EPUB 中缺少 OPF 内容清单');

  const opfText = await zip.text(opfPath);
  if (!opfText) throw new Error('无法读取 EPUB 内容清单');
  const opf = parseXml(opfText, 'OPF');

  const metadataEl = firstByLocalName(opf, 'metadata');
  const readMeta = (tag) => {
    const el = metadataEl ? elementsByLocalName(metadataEl, tag)[0] : null;
    return el ? normalizeWhitespace(el.textContent) : '';
  };

  let title = readMeta('title');
  if (!title) title = stripExtension(filename) || '未命名书籍';
  const author = readMeta('creator');
  const description = readMeta('description');
  const language = readMeta('language');

  const manifest = new Map();
  for (const item of elementsByLocalName(opf, 'item')) {
    const id = attr(item, 'id');
    if (id) {
      manifest.set(id, {
        id,
        href: attr(item, 'href'),
        mediaType: attr(item, 'media-type').toLowerCase(),
        properties: attr(item, 'properties').toLowerCase(),
      });
    }
  }

  const spineEl = firstByLocalName(opf, 'spine');
  const spineRefs = spineEl ? elementsByLocalName(spineEl, 'itemref') : [];
  const spine = [];
  for (const ref of spineRefs) {
    if ((attr(ref, 'linear') || 'yes').toLowerCase() === 'no') continue;
    const item = manifest.get(attr(ref, 'idref'));
    if (!item) continue;
    const path = resolveHref(opfPath, item.href);
    if (!path) continue;
    const media = item.mediaType;
    if (media && !/xhtml|html|xml/.test(media)) continue;
    spine.push({ path, item });
  }

  if (!spine.length) {
    // Fall back to every XHTML manifest item in order.
    for (const item of manifest.values()) {
      if (/xhtml|html/.test(item.mediaType)) {
        spine.push({ path: resolveHref(opfPath, item.href), item });
      }
    }
  }
  if (!spine.length) throw new Error('EPUB 中没有可阅读的章节');

  // Normalize paths consistently and build a lookup for internal links.
  for (const chapter of spine) chapter.path = normalizePath(chapter.path);
  const spineIndexByPath = new Map();
  spine.forEach((chapter, index) => {
    if (!spineIndexByPath.has(chapter.path)) spineIndexByPath.set(chapter.path, index);
    const decoded = normalizePath(safeDecode(chapter.path));
    if (!spineIndexByPath.has(decoded)) spineIndexByPath.set(decoded, index);
  });

  // Navigation / TOC.
  const navItem = Array.from(manifest.values()).find(
    (item) => item.properties.split(/\s+/).includes('nav'),
  ) || Array.from(manifest.values()).find(
    (item) => /xhtml/.test(item.mediaType) && /(?:^|\/)(?:nav|toc|contents)\.x?html?$/i.test(item.href),
  );
  const ncxId = spineEl ? attr(spineEl, 'toc') : '';
  const ncxItem = (ncxId && manifest.get(ncxId)) || Array.from(manifest.values()).find(
    (item) => item.mediaType.includes('dtbncx'),
  );

  let tocEntries = [];
  if (navItem) {
    const navPath = resolveHref(opfPath, navItem.href);
    try {
      const navText = await zip.text(navPath);
      if (navText) tocEntries = parseNav(navText, navPath);
    } catch {
      /* fall back to NCX */
    }
  }
  if (!tocEntries.length && ncxItem) {
    const ncxPath = resolveHref(opfPath, ncxItem.href);
    try {
      const ncxText = await zip.text(ncxPath);
      if (ncxText) tocEntries = parseNcx(ncxText, ncxPath);
    } catch {
      /* no toc, derive from headings */
    }
  }

  const titleByPath = new Map();
  for (const entry of tocEntries) {
    if (entry.path && !titleByPath.has(entry.path)) titleByPath.set(entry.path, entry.title);
  }

  const cover = await extractCover(zip, opf, metadataEl, manifest, opfPath);
  const navPath = navItem ? resolveHref(opfPath, navItem.href) : '';

  const chapters = [];
  let processed = 0;
  for (let index = 0; index < spine.length; index += 1) {
    const spineItem = spine[index];
    if (navPath && spineItem.path === navPath) continue;
    if (!zip.has(spineItem.path)) continue;
    const raw = await zip.text(spineItem.path);
    if (!raw) continue;

    const sanitized = await sanitizeEpubDocument(raw, {
      path: spineItem.path,
      zip,
      spineIndexByPath,
      chapterIndex: chapters.length,
    });

    if (!sanitized.text && !sanitized.hasImage) continue;
    if (
      chapters.length === 0 &&
      sanitized.text.length < 4 &&
      sanitized.hasImage &&
      !titleByPath.has(spineItem.path)
    ) {
      // Likely a cover-only page; the real cover is already shown in the library.
      continue;
    }

    let chapterTitle = titleByPath.get(spineItem.path);
    if (!chapterTitle) chapterTitle = sanitized.titleCandidate;
    if (!chapterTitle) chapterTitle = `第 ${chapters.length + 1} 章`;
    chapterTitle = normalizeWhitespace(chapterTitle).slice(0, 120);

    chapters.push({
      title: chapterTitle,
      html: sanitized.html,
      text: sanitized.text,
      chars: sanitized.text.replace(/\s+/g, '').length,
    });

    processed += 1;
    if (onProgress && processed % 5 === 0) {
      onProgress({ current: index + 1, total: spine.length });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (!chapters.length) throw new Error('EPUB 中没有可显示的章节内容');
  if (onProgress) onProgress({ current: spine.length, total: spine.length });

  return {
    title: title.slice(0, 200),
    author: author.slice(0, 120),
    description: description.slice(0, 2000),
    language,
    cover,
    chapters,
  };
}

function parseNav(navText, navPath) {
  const doc = parseXml(navText, 'EPUB 导航');
  const navs = elementsByLocalName(doc, 'nav');
  let tocNav = navs.find((nav) => {
    const type = nav.getAttributeNS(XML_NS.ops, 'type') || nav.getAttribute('epub:type') || '';
    return type.split(/\s+/).includes('toc');
  });
  if (!tocNav) tocNav = navs[0];
  if (!tocNav) return [];

  const entries = [];
  const anchors = elementsByLocalName(tocNav, 'a');
  for (const anchor of anchors) {
    const title = normalizeWhitespace(anchor.textContent);
    if (!title) continue;
    const href = attr(anchor, 'href');
    const path = resolveHref(navPath, href);
    if (!path) continue;
    entries.push({ title, path, anchor: hrefAnchor(href) });
  }
  return entries;
}

function parseNcx(ncxText, ncxPath) {
  const doc = parseXml(ncxText, 'NCX 目录');
  const entries = [];
  for (const navPoint of elementsByLocalName(doc, 'navPoint')) {
    const label = firstByLocalName(navPoint, 'navLabel');
    const title = label ? normalizeWhitespace(firstByLocalName(label, 'text')?.textContent || '') : '';
    const content = firstByLocalName(navPoint, 'content');
    const src = content ? attr(content, 'src') : '';
    const path = resolveHref(ncxPath, src);
    if (title && path) entries.push({ title, path, anchor: hrefAnchor(src) });
  }
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.path}#${entry.anchor}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function extractCover(zip, opf, metadataEl, manifest, opfPath) {
  let coverId = '';
  if (metadataEl) {
    const metaEls = elementsByLocalName(metadataEl, 'meta');
    for (const meta of metaEls) {
      if (attr(meta, 'name').toLowerCase() === 'cover') {
        coverId = attr(meta, 'content');
        break;
      }
    }
  }

  let item = coverId ? manifest.get(coverId) : null;
  if (!item) {
    item = Array.from(manifest.values()).find((entry) => entry.properties.split(/\s+/).includes('cover-image'));
  }
  if (!item) {
    item = Array.from(manifest.values()).find(
      (entry) => entry.mediaType.startsWith('image/') && /cover|front/i.test(`${entry.id} ${entry.href}`),
    );
  }

  let path = item ? resolveHref(opfPath, item.href) : '';
  if (!path) {
    path = zip.names().find((name) => /(^|\/)cover[^/]*\.(?:jpe?g|png|gif|webp|svg)$/i.test(name)) || '';
  }
  if (!path) return '';
  const bytes = await zip.bytes(path);
  if (!bytes) return '';
  const mime = item?.mediaType || mimeForPath(path) || 'image/jpeg';
  if (!mime.startsWith('image/')) return '';
  return bytesToDataURL(bytes, mime);
}

/* ------------------------- EPUB HTML sanitizing ------------------------- */

const BLOCKED_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button',
  'link', 'meta', 'base', 'video', 'audio', 'source', 'track', 'canvas',
  'svg', 'math', 'noscript', 'template', 'frame', 'frameset',
]);

const ALLOWED_ATTRS = new Set([
  'id', 'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'dir', 'lang',
  'data-chapter', 'data-anchor',
]);

/**
 * Convert one EPUB document into reader-safe HTML.
 * Images are inlined; internal links carry data-chapter/data-anchor.
 */
export async function sanitizeEpubDocument(source, { path, zip, spineIndexByPath, chapterIndex = 0 }) {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const body = doc.body;
  if (!body) return { html: '', text: '', titleCandidate: '', hasImage: false };

  body.querySelectorAll('script,style,iframe,object,embed,form,input,button,link,meta,base,video,audio,source,track,canvas,noscript,template,svg').forEach((el) => el.remove());

  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((node) => node.remove());

  let hasImage = false;
  const images = Array.from(body.querySelectorAll('img'));
  for (const img of images) {
    const src = attr(img, 'src');
    const alt = attr(img, 'alt') || '图片';
    if (!src) {
      img.remove();
      continue;
    }
    if (/^data:image\//i.test(src)) {
      if (src.length <= 6 * 1024 * 1024) hasImage = true;
      else img.remove();
      continue;
    }
    const imagePath = resolveHref(path, src);
    const bytes = imagePath ? await zip.bytes(imagePath) : null;
    if (!bytes || bytes.length > 8 * 1024 * 1024) {
      img.remove();
      continue;
    }
    const mime = mimeForPath(imagePath) || 'image/jpeg';
    img.setAttribute('src', bytesToDataURL(bytes, mime));
    img.setAttribute('alt', alt);
    img.removeAttribute('width');
    img.removeAttribute('height');
    hasImage = true;
  }

  // Internal links become in-app chapter jumps.
  for (const anchor of Array.from(body.querySelectorAll('a'))) {
    const href = attr(anchor, 'href');
    if (!href || href.startsWith('#')) continue;
    if (/^(?:https?:|mailto:)/i.test(href)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      continue;
    }
    const targetPath = resolveHref(path, href);
    const targetIndex = targetPath ? spineIndexByPath.get(targetPath) : undefined;
    if (targetIndex !== undefined) {
      anchor.setAttribute('href', '#');
      anchor.setAttribute('data-chapter', String(targetIndex));
      const targetAnchor = hrefAnchor(href);
      if (targetAnchor) anchor.setAttribute('data-anchor', targetAnchor);
    } else {
      anchor.removeAttribute('href');
    }
  }

  const titleCandidate = normalizeWhitespace(
    (body.querySelector('h1,h2,h3')?.textContent || '').slice(0, 120),
  );

  // Strip everything not useful for reading. This also removes book-specific
  // colors so the reader theme always wins.
  for (const el of Array.from(body.querySelectorAll('*'))) {
    if (BLOCKED_TAGS.has(el.localName)) {
      el.remove();
      continue;
    }
    for (const attribute of Array.from(el.attributes)) {
      if (!ALLOWED_ATTRS.has(attribute.name)) el.removeAttribute(attribute.name);
    }
  }

  body.querySelectorAll('img').forEach((img) => {
    if (!img.getAttribute('alt')) img.setAttribute('alt', '图片');
  });

  const html = body.innerHTML.trim();
  const textClone = body.cloneNode(true);
  textClone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  textClone.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,li,tr,blockquote,section,article,figure,figcaption,pre,hr')
    .forEach((block) => block.append('\n'));
  const text = (textClone.textContent || '').replace(/\s+/g, ' ').trim();
  return { html, text, titleCandidate, hasImage };
}
