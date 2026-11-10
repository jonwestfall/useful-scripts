// KaTeX's fonts, for math in decks and documents.
//
// KaTeX draws some symbols from its own fonts alone. The slash through ≠
// (\neq, \notin, ...) is a separate glyph in KaTeX_Main laid over "=", so
// without that font a slide reads "a = b" where it says "a ≠ b", and other
// symbols come out as empty boxes. Two things kept the fonts from arriving:
//
// - Marp's stylesheet pointed them at a CDN, which a projector on a closed
//   network, an offline kiosk or a guest's phone behind a firewall cannot
//   reach. They are vendored instead, beside the other bundles.
// - A slide is drawn inside a shadow root, and Chromium does not load a font
//   whose @font-face is declared in one. Font families are shared with the
//   page, though, so the faces are put on the page itself (installMathFonts),
//   and every shadow root on it can use them.
//
// A slide rasterized on its own - a photo of the panel, an export - is an SVG
// image, which can load nothing at all from outside it, so for those the
// fonts travel inside it as data (embedMathFonts).

/** Where the vendored fonts are, as an absolute address. */
export const MATH_FONT_DIR = new URL('../vendor/katex-fonts/', import.meta.url).href;

const FACE = /@font-face\s*\{[^{}]*?font-family\s*:\s*['"]?KaTeX_[^{}]*\}/g;
const FONT_FILE = /KaTeX_[\w-]+?\.woff2/;

/** The KaTeX @font-face rules in a stylesheet. */
export function mathFontFaces(css) {
  return String(css || '').match(FACE) || [];
}

/** A stylesheet whose KaTeX fonts come from here rather than wherever it said. */
export function localMathCss(css) {
  return String(css || '').replace(/url\((['"]?)(?:[^'")]*\/)?(KaTeX_[\w-]+\.(?:woff2|woff|ttf))\1\)/g, (m, q, file) => `url('${MATH_FONT_DIR}${file}')`);
}

// Each face reads from the woff2 file alone: every browser Podium runs in
// reads woff2, and only those are vendored.
function woff2Face(face, url) {
  return face.replace(/src\s*:[^;}]*/, `src:url('${url}') format('woff2')`);
}

let installed = null;

/**
 * Put the KaTeX faces a stylesheet declares on the page, once, and start them
 * loading - so math in any shadow root on the page has its fonts, and a slide
 * measured or shown a moment from now is measured in them. A stylesheet with
 * no math in it does nothing.
 */
export function installMathFonts(css) {
  if (installed || typeof document === 'undefined' || !document.head) return;
  const faces = mathFontFaces(css);
  if (!faces.length) return;
  const style = document.createElement('style');
  style.dataset.podiumMathFonts = '';
  style.textContent = faces.map((face) => {
    const file = FONT_FILE.exec(face)?.[0];
    return file ? woff2Face(face, `${MATH_FONT_DIR}${file}`) : face;
  }).join('\n');
  document.head.append(style);
  installed = style;
  // Fetched now, rather than when the first symbol needs one: KaTeX's faces
  // block text until they arrive, and that should not happen on the wall.
  if (document.fonts?.forEach) {
    document.fonts.forEach((font) => {
      if (/^['"]?KaTeX_/.test(font.family) && font.status === 'unloaded') font.load().catch(() => {});
    });
  }
}

const dataUrls = new Map();

function fontData(file) {
  if (!dataUrls.has(file)) {
    const job = fetch(`${MATH_FONT_DIR}${file}`)
      .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((buf) => {
        const bytes = new Uint8Array(buf);
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return `data:font/woff2;base64,${btoa(text)}`;
      });
    job.catch(() => dataUrls.delete(file));
    dataUrls.set(file, job);
  }
  return dataUrls.get(file);
}

/**
 * A stylesheet for a standalone SVG image: when `markup` has math in it, its
 * KaTeX faces carry their fonts as data; when it has none, they are dropped,
 * so a slide without math does not carry them for nothing. A font that will
 * not load leaves its face as it was.
 */
export async function embedMathFonts(css, markup) {
  const text = String(css || '');
  const faces = mathFontFaces(text);
  if (!faces.length) return text;
  if (!/class="[^"]*\bkatex\b/.test(String(markup || ''))) return text.replace(FACE, '');
  const swaps = await Promise.all(faces.map(async (face) => {
    const file = FONT_FILE.exec(face)?.[0];
    if (!file) return face;
    try { return woff2Face(face, await fontData(file)); } catch { return face; }
  }));
  let i = 0;
  return text.replace(FACE, () => swaps[i++]);
}
