// QR codes in decks and documents: a ```qr block holding a link is drawn as
// the QR code for it - on the projector, in every preview and thumbnail, in
// Guest View and in a PDF - the same way a ```mermaid block is drawn as its
// diagram (deck-mermaid.js). Changing the link in the markdown changes the
// code; there is no picture file to keep in step with it.
//
//   ```qr
//   https://example.edu/survey
//   size: large
//   ```
//
// The first line is what the code holds; `size:` (small, medium or large) is
// optional. The code is always black on white with its quiet margin, whatever
// the slide's colours, because that is what a phone's camera reads reliably.
// It is a link too, where a link can be followed (a PDF, Quick Look).
//
// The generator (vendor/qrcode.js, a classic script) is loaded only by a deck
// that has one, the way Mermaid's bundle is.

const QR_URL = new URL('../vendor/qrcode.js', import.meta.url).href;

/** Slide pixels across, by size. A slide is 1280 wide. */
export const QR_SIZES = { small: 200, medium: 300, large: 440 };
export const DEFAULT_QR_SIZE = 'medium';

export const QR_CSS = `
.podium-qr-link { display: inline-block; line-height: 0; }
img.podium-qr { display: block; margin: 0.4em auto; max-width: 100%; height: auto; image-rendering: pixelated; }
.podium-qr-error { border: 2px dashed #c0392b; color: #c0392b; padding: 0.5em; font-size: 0.6em; white-space: pre-wrap; }
`;

/** What a ```qr block says: { data, size }. */
export function parseQrBlock(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let size = DEFAULT_QR_SIZE;
  const rest = [];
  for (const line of lines) {
    const m = /^size\s*:\s*(\w+)$/i.exec(line);
    if (m && QR_SIZES[m[1].toLowerCase()]) size = m[1].toLowerCase();
    else rest.push(line);
  }
  return { data: rest[0] || '', size };
}

/** A link a QR code may also be clicked as: http(s) or mailto only. */
export const followable = (data) => (/^(https?:|mailto:)/i.test(data) ? data : '');

/** The ```qr block for `data`. */
export function qrFence(data, size = DEFAULT_QR_SIZE) {
  const clean = String(data || '').replace(/[\r\n]+/g, ' ').trim();
  return `\`\`\`qr\n${clean}\n${size && size !== DEFAULT_QR_SIZE ? `size: ${size}\n` : ''}\`\`\`\n`;
}

/**
 * The markdown the editor's Link button puts in: the link as text (unless
 * `text` is false) and its QR code (unless `qr` is false).
 */
export function linkMarkdown({ url, label = '', text = true, qr = true, size = DEFAULT_QR_SIZE }) {
  const clean = String(url || '').trim();
  if (!clean) return '';
  const name = String(label || '').replace(/[[\]\n]/g, ' ').trim();
  const parts = [];
  if (text) parts.push(name ? `[${name}](${clean.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})` : `<${clean}>`);
  if (qr) parts.push(qrFence(clean, size));
  return `${parts.join('\n\n').replace(/\n+$/, '')}\n`;
}

let libPromise = null;

function loadLibrary() {
  if (typeof globalThis.qrcode === 'function') return Promise.resolve(globalThis.qrcode);
  libPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = QR_URL;
    script.onload = () => (typeof globalThis.qrcode === 'function' ? resolve(globalThis.qrcode) : reject(new Error('it did not load')));
    script.onerror = () => reject(new Error('it did not load'));
    document.head.append(script);
  }).catch((err) => {
    libPromise = null;
    throw err;
  });
  return libPromise;
}

/** The QR code for `data` as an SVG string, or throws if it will not fit in one. */
export function qrSvgFor(qrcode, data) {
  const qr = qrcode(0, 'M');
  qr.addData(data);
  qr.make();
  return qr.createSvgTag({ cellSize: 8, margin: 4 });
}

/** The QR code for `data` as an SVG string, for a preview; '' if it cannot be made. */
export async function qrPreview(data) {
  if (!data) return '';
  try { return qrSvgFor(await loadLibrary(), data); } catch { return ''; }
}

function errorBox(doc, text, message) {
  const box = doc.createElement('div');
  box.className = 'podium-qr-error';
  box.textContent = `QR code: ${message}\n${text.trim()}`;
  return box;
}

/**
 * Draw every ```qr block under `root` as its QR code. Returns one entry per
 * block, in order: { data, size, error }.
 */
export async function drawQrCodes(root) {
  const blocks = Array.from(root.querySelectorAll('pre > code.language-qr'));
  if (!blocks.length || typeof document === 'undefined') return [];
  let qrcode = null;
  let loadError = '';
  try { qrcode = await loadLibrary(); } catch (err) { loadError = `Podium could not load its QR code maker (${err.message}).`; }
  const out = [];
  for (const code of blocks) {
    const pre = code.parentElement;
    const text = code.textContent || '';
    const { data, size } = parseQrBlock(text);
    const doc = root.ownerDocument;
    let error = loadError;
    let svg = '';
    if (!error && !data) error = 'there is no link in it. Put the address on its first line.';
    if (!error) {
      try { svg = qrSvgFor(qrcode, data); } catch { error = 'that is too long for a QR code. Use a shorter link.'; }
    }
    if (error) {
      pre.replaceWith(errorBox(doc, text, error));
    } else {
      const img = doc.createElement('img');
      img.className = 'podium-qr';
      img.alt = `QR code: ${data}`;
      img.setAttribute('src', `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      img.setAttribute('width', String(QR_SIZES[size]));
      img.setAttribute('height', String(QR_SIZES[size]));
      const href = followable(data);
      if (href) {
        const a = doc.createElement('a');
        a.className = 'podium-qr-link';
        a.setAttribute('href', href);
        // Never in place of the page showing it (the editor, Quick Look).
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
        a.append(img);
        pre.replaceWith(a);
      } else {
        pre.replaceWith(img);
      }
    }
    out.push({ data, size, error: error || null });
  }
  return out;
}
