// A deck out of Podium and back in (Issue #226): a .zip of the markdown with
// its pictures and videos beside it, and a PDF of its slides.
//
// The .zip is the shape every Marp tool expects of a deck kept on disk - the
// .md, and a media/ folder its pictures are referred to by relative path - so
// a deck taken out of the library opens as it was in Marp for VS Code, and
// one made there comes in through "Open a .md or .zip file". Coming in, each
// picture goes into the library (as deck media) and the markdown is pointed
// at it there.
//
// The PDF is each slide fully built, as the room sees it, one page each - for
// handouts and for posting after class.
//
// A ```mermaid diagram (Issue #235) goes out as both: its code stays in the
// markdown, which is what Podium draws it from, and a picture of it as
// Podium drew it goes beside it in media/diagrams/ (an .svg and a .png),
// named in a comment after the code - for a Marp tool that cannot draw
// diagrams, and for anyone who wants the picture itself. Coming back in, the
// pictures and their comments are left behind: the code is the diagram.

import { createZip, readZip } from './zip.js';
import { createPdf } from './pdf-writer.js';
import { applyFits, cssForStandaloneSlide, FRAGMENT_CSS } from './deck.js';
import { svgToImage } from './renderers.js';
import { parseDeck, mermaidFences } from './deck-source.js';

const DIAGRAM_DIR = 'media/diagrams/';
// A picture-of-a-diagram comment that an export wrote, on a line of its own.
const DIAGRAM_NOTE = /^[ \t]*<!--\s*diagram:\s*media\/diagrams\/[^\s>]*\s*-->[ \t]*(?:\r?\n|$)/gm;

/** The markdown with every picture-of-a-diagram comment an export added taken out. */
export function stripDiagramNotes(md) {
  return String(md).replace(DIAGRAM_NOTE, '');
}

/**
 * Name a picture after each ```mermaid block, in a comment on the line after
 * it: `names[k]` for the k-th block in the deck (null for none). An earlier
 * export's comments are replaced, not added to.
 */
export function noteDiagramPictures(md, names) {
  const text = stripDiagramNotes(md);
  const fences = mermaidFences(text);
  let out = '';
  let at = 0;
  fences.forEach((fence, k) => {
    if (fence.end === null || !names[k]) return;
    out += text.slice(at, fence.end);
    // A block that is the last thing in the file may have no newline of its own.
    if (!/\n$/.test(out)) out += '\n';
    out += `<!-- diagram: ${names[k]} -->\n`;
    at = fence.end;
  });
  return out + text.slice(at);
}

/** A diagram's SVG as a PNG, at twice its drawn size so it stays sharp on a slide. */
async function diagramPng({ svg, width, height }) {
  const img = new Image();
  img.decoding = 'sync';
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * 2));
  canvas.height = Math.max(1, Math.round(height * 2));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no PNG'))), 'image/png'));
}

/** Every picture and video a deck points at, once each, in order. */
export function mediaRefs(md) {
  const refs = [];
  for (const slide of parseDeck(md).slides) {
    for (const m of slide.media) refs.push(m.src);
    if (slide.video) refs.push(slide.video.src);
  }
  return [...new Set(refs.filter(Boolean))];
}

/**
 * Point every use of `from` in the markdown at `to`. Only whole addresses:
 * inside ( ), quotes, or after a directive's colon - never the same letters
 * inside a sentence.
 */
export function replaceRef(md, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(md).replace(new RegExp(`(?<=[("'\\s:<])${escaped}(?=[)"'\\s>]|$)`, 'gm'), () => to);
}

function baseName(src) {
  const path = String(src).split(/[?#]/)[0];
  try { return decodeURIComponent(path.split('/').pop() || 'file'); } catch { return path.split('/').pop() || 'file'; }
}

/**
 * The deck and the files it points at, as a .zip. Addresses this page can
 * fetch (the library, plan pictures as data, anything on this server) are
 * packed under media/ and the markdown pointed there; anything on another
 * site is left as its address.
 *
 * @param {string} md
 * @param {object} opts
 * @param {string} opts.name - the .md file's name in the zip
 * @param {(src: string) => string|null} [opts.resolve] - a fetchable address for `src` (e.g. an asset: picture's data URL)
 * @param {object[]} [opts.diagrams] - the deck's diagrams as render() in deck.js drew them, in order
 * @returns {Promise<{blob: Blob, packed: number, skipped: string[], diagrams: number}>}
 */
export async function exportZip(md, { name = 'deck.md', resolve = () => null, diagrams = [] } = {}) {
  let text = stripDiagramNotes(md);
  const files = [];
  const used = new Set();
  const skipped = [];
  for (const src of mediaRefs(text)) {
    const url = resolve(src) || (/^\/(?!\/)/.test(src) ? src : null);
    if (!url) { if (!/^https?:/i.test(src)) skipped.push(src); continue; }
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      let file = baseName(src);
      if (/^asset:/.test(src)) file = `${src.slice(6)}.${(blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')}`;
      for (let n = 2; used.has(file); n++) file = file.replace(/(\.\w+)?$/, (ext) => `-${n}${ext || ''}`);
      used.add(file);
      files.push({ name: `media/${file}`, data: blob });
      text = replaceRef(text, src, `media/${file}`);
    } catch {
      skipped.push(src);
    }
  }
  const packed = files.length;
  // Each diagram as Podium drew it. Only named in the markdown when the
  // blocks there are the ones that were drawn, one for one.
  const names = [];
  for (const d of diagrams) {
    if (!d?.picture) { names.push(null); continue; }
    const base = `${DIAGRAM_DIR}slide-${d.slide + 1}-${d.nth + 1}`;
    files.push({ name: `${base}.svg`, data: new Blob([d.picture.svg], { type: 'image/svg+xml' }) });
    try {
      files.push({ name: `${base}.png`, data: await diagramPng(d.picture) });
      names.push(`${base}.png`);
    } catch {
      names.push(`${base}.svg`);
    }
  }
  if (names.some(Boolean) && mermaidFences(text).length === diagrams.length) text = noteDiagramPictures(text, names);
  const blob = await createZip([{ name, data: text }, ...files]);
  return { blob, packed, skipped, diagrams: names.filter(Boolean).length };
}

/**
 * A deck's .zip, opened: its markdown (the shallowest .md in it) and the
 * files its relative addresses point at.
 *
 * @param {Blob} file
 * @returns {Promise<{name: string, markdown: string, media: {ref: string, name: string, blob: Blob}[], missing: string[]}>}
 */
export async function readDeckZip(file) {
  const entries = await readZip(file);
  const decks = entries.filter((e) => /\.(md|markdown)$/i.test(e.name) && !/(^|\/)(__MACOSX|\.)/.test(e.name))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.localeCompare(b.name));
  if (!decks.length) throw new Error('there is no .md deck in that .zip');
  const deck = decks[0];
  // The diagrams' pictures (see exportZip) are not brought in: Podium draws
  // a diagram from its code, so their comments go and the files stay behind.
  const markdown = stripDiagramNotes(new TextDecoder().decode(await deck.read()));
  const dir = deck.name.includes('/') ? deck.name.slice(0, deck.name.lastIndexOf('/') + 1) : '';
  const byName = new Map(entries.map((e) => [e.name, e]));
  const media = [];
  const missing = [];
  for (const ref of mediaRefs(markdown)) {
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) continue;     // an address, not a file beside it
    const path = normalise(`${dir}${decodeSafe(ref)}`);
    const entry = path && byName.get(path);
    if (!entry) { missing.push(ref); continue; }
    const type = TYPES[(path.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
    media.push({ ref, name: path.split('/').pop(), blob: new Blob([await entry.read()], { type }) });
  }
  return { name: deck.name.split('/').pop(), markdown, media, missing };
}

const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' };

function decodeSafe(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** `a/./b/../c.png` -> `a/c.png`; null for a path that climbs out of the zip. */
function normalise(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}

// --- PDF -------------------------------------------------------------------------

const PAGE_WIDTH = 1920;

async function dataUrlOf(url, cache) {
  if (/^data:/i.test(url)) return url;
  if (!cache.has(url)) {
    cache.set(url, fetch(url, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => (blob ? new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      }) : null))
      .catch(() => null));
  }
  return cache.get(url);
}

// A slide drawn as an <img> of its SVG cannot fetch anything - a picture by
// address simply does not appear. So every picture in it is swapped for its
// bytes first.
async function inlinePictures(svg, cache) {
  for (const img of svg.querySelectorAll('img[src]')) {
    const data = await dataUrlOf(new URL(img.getAttribute('src'), location.href).href, cache);
    if (data) img.setAttribute('src', data);
  }
  for (const node of svg.querySelectorAll('[style*="url("]')) {
    const style = node.getAttribute('style');
    const urls = [...style.matchAll(/url\((["']?)(.*?)\1\)/g)].map((m) => m[2]).filter((u) => !/^data:/i.test(u));
    let next = style;
    for (const url of urls) {
      const data = await dataUrlOf(new URL(url.replace(/&quot;/g, ''), location.href).href, cache);
      if (data) next = next.split(url).join(data);
    }
    if (next !== style) node.setAttribute('style', next);
  }
}

/**
 * Every slide of a rendered deck (deck.js's render()), fully built, as a PDF.
 *
 * @param {object} rendered - what deck.js's render() returns
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<Blob>}
 */
export async function exportPdf(rendered, { title = 'Deck', onProgress = () => {} } = {}) {
  const holder = document.createElement('div');
  holder.innerHTML = rendered.html;
  applyFits(holder, rendered.fits);
  const css = `${cssForStandaloneSlide(rendered.css)}\n${FRAGMENT_CSS}\n.podium-fragment { opacity: 1 !important; transform: none !important; }`;
  const slides = Array.from(holder.querySelectorAll('svg[data-marpit-svg]'));
  const cache = new Map();
  const pages = [];
  for (const [i, svg] of slides.entries()) {
    const box = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
    const aspect = box.length === 4 && box[3] > 0 ? box[2] / box[3] : 16 / 9;
    const width = PAGE_WIDTH;
    const height = Math.round(width / aspect);
    await inlinePictures(svg, cache);
    const img = await svgToImage(svg, css, width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    pages.push({ width, height, data: new Uint8Array(await blob.arrayBuffer()) });
    onProgress(i + 1, slides.length);
  }
  return createPdf(pages, { title });
}

// --- a document as a PDF (Issue #240) --------------------------------------------
//
// The one long page broken into printable ones - US Letter's shape, at the
// page's own width - and broken between blocks (paragraphs, lists, tables,
// pictures), never through a line of text. A block taller than a whole page
// is the one thing that is cut, at the page's edge.

const DOC_WIDTH = 1280;
const DOC_PAGE_HEIGHT = Math.round(DOC_WIDTH * 11 / 8.5);
const DOC_MARGIN = 56;

/** Where to break a page of the given height laid out in blocks [{top, bottom}]. */
export function docPageBreaks(blocks, total, pageHeight = DOC_PAGE_HEIGHT - DOC_MARGIN * 2) {
  const breaks = [];
  let start = 0;
  while (start < total - 1) {
    const limit = start + pageHeight;
    if (limit >= total) { breaks.push([start, total]); break; }
    let end = start;
    for (const b of blocks) {
      if (b.bottom <= limit && b.bottom > end) end = b.bottom;
    }
    // Nothing fits whole (a block taller than a page): cut at the edge.
    if (end <= start) end = limit;
    breaks.push([start, end]);
    start = end;
  }
  return breaks.length ? breaks : [[0, Math.max(1, total)]];
}

export async function exportDocPdf(rendered, { title = 'Document', onProgress = () => {} } = {}) {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-30000px;top:0;width:${DOC_WIDTH}px;visibility:hidden`;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${rendered.css}</style>${rendered.html}`;
  document.body.append(host);
  try {
    const page = shadow.querySelector('.podium-doc');
    const cache = new Map();
    await inlinePictures(page, cache);
    await Promise.all(Array.from(page.querySelectorAll('img')).map((img) => (img.complete ? null : new Promise((done) => {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }))));
    const top = page.getBoundingClientRect().top;
    const blocks = Array.from(page.children).map((node) => {
      const r = node.getBoundingClientRect();
      return { top: r.top - top, bottom: r.bottom - top };
    });
    const total = Math.ceil(page.getBoundingClientRect().height);
    const background = getComputedStyle(page).backgroundColor || '#fff';
    const html = page.outerHTML;
    const breaks = docPageBreaks(blocks, total);
    const pages = [];
    const scale = 1.5;
    for (const [i, [from, to]] of breaks.entries()) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 ${from} ${DOC_WIDTH} ${to - from}`);
      const fo = document.createElementNS(ns, 'foreignObject');
      fo.setAttribute('width', String(DOC_WIDTH));
      fo.setAttribute('height', String(total));
      const holder = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      holder.innerHTML = html;
      fo.append(holder);
      svg.append(fo);
      const width = Math.round(DOC_WIDTH * scale);
      const sliceHeight = Math.round((to - from) * scale);
      const img = await svgToImage(svg, rendered.css, width, sliceHeight);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = Math.round(DOC_PAGE_HEIGHT * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, Math.round(DOC_MARGIN * scale), width, sliceHeight);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      pages.push({ width: canvas.width, height: canvas.height, data: new Uint8Array(await blob.arrayBuffer()) });
      onProgress(i + 1, breaks.length);
    }
    return createPdf(pages, { title });
  } finally {
    host.remove();
  }
}
