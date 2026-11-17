// One typeface for slides on every device.
//
// The controller and the display each lay a slide out themselves, from the
// same markdown and the same theme. A theme that asks for "Helvetica Neue",
// Arial gets Helvetica Neue on an iPad or a Mac and Arial on a Windows
// projector, and Helvetica Neue is a little wider: a table column that fits
// on one line on the projector wraps onto two on the iPad, the table grows,
// and everything under it sits lower on the iPad than on the wall. Ink is
// kept as a fraction of the slide, so a line drawn under a sentence on the
// iPad lands under empty space on the projector - right at the top of the
// slide, further and further off down the middle, and right again at the
// slide number pinned to the bottom.
//
// So wherever a deck's stylesheet starts a font list with Helvetica Neue,
// Helvetica or Arial, Podium puts its own face in front of it: Arimo, which
// has Arial's widths glyph for glyph (an open-licence font made for exactly
// that), vendored beside the other bundles. Every device then lays the slide
// out in the same face, and breaks every line in the same place. Anything
// Arimo lacks (an arrow, an emoji) still comes from the theme's own list.
//
// As with KaTeX's fonts (math-fonts.js), the faces go on the page rather than
// in the shadow root a slide is drawn in, which Chromium would ignore; and a
// slide rasterized on its own, as an SVG image, carries them as data.

export const SLIDE_FONT = 'Podium Sans';
export const SLIDE_FONT_DIR = new URL('../vendor/slide-fonts/', import.meta.url).href;

const RANGES = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};
// Text in the latin-ext range, for which an embedded copy needs those faces too.
const EXTENDED = /[Ā-˿ᴀ-ᶿḀ-ỿⱠ-Ɀ꜠-ꟿ]/;

/** Every face: [file, weight, style, subset]. */
export const SLIDE_FONT_FACES = Object.keys(RANGES).flatMap((subset) => [400, 700].flatMap((weight) => ['normal', 'italic']
  .map((style) => [`arimo-${subset}-${weight}-${style}.woff2`, weight, style, subset])));

function face([, weight, style, subset], src) {
  return `@font-face{font-family:'${SLIDE_FONT}';font-style:${style};font-weight:${weight};font-display:block;src:url('${src}') format('woff2');unicode-range:${RANGES[subset]};}`;
}

// The families a slide's own font list may start with for Podium to step in.
const ARIAL_LIKE = /^\s*(['"]?)(?:helvetica neue|helveticaneue|helvetica|arial)\1\s*(?:,|$|!)/i;
// In the `font` shorthand: everything up to the size (and line height), when
// the family list after it starts with one of those.
const SHORTHAND_FAMILY = /^([^'"]*?\d[\w.%]*(?:\s*\/\s*[\w.%+-]+)?\s+)(?=(['"]?)(?:helvetica neue|helveticaneue|helvetica|arial)\2\s*(?:,|$|!))/i;
const FONT_FACE_BLOCK =/@font-face\s*\{[^{}]*\}/gi;

function withSlideFont(list) {
  return ARIAL_LIKE.test(list) ? ` '${SLIDE_FONT}', ${list.trimStart()}` : list;
}

/**
 * A deck's stylesheet with Podium's face in front of every font list that
 * starts Helvetica Neue / Helvetica / Arial - in `font-family` and in the
 * `font` shorthand. Other lists (a theme's own web font, -apple-system, a
 * monospace for code) are left as they are, and so is any @font-face.
 */
export function sameFontCss(css) {
  const text = String(css || '');
  const faces = [];
  const held = text.replace(FONT_FACE_BLOCK, (block) => `\uE000${faces.push(block) - 1}\uE000`);
  const swapped = held
    .replace(/(font-family\s*:)([^;{}]*)/gi, (m, prop, list) => prop + withSlideFont(list))
    // font: [style] [variant] [weight] size[/line-height] family-list
    .replace(/(\bfont\s*:)([^;{}]*)/gi, (m, prop, value) => prop + value.replace(SHORTHAND_FAMILY, `$1'${SLIDE_FONT}', `));
  return swapped.replace(/\uE000(\d+)\uE000/g, (m, i) => faces[Number(i)]);
}

/** Whether a stylesheet (after sameFontCss) lays anything out in Podium's face. */
export function usesSlideFont(css) {
  return String(css || '').includes(`'${SLIDE_FONT}'`);
}

let installed = null;

/**
 * Put Podium's faces on the page, once, and start the common ones loading, so
 * a slide measured or shown a moment from now is measured in them.
 */
export function installSlideFont() {
  if (installed || typeof document === 'undefined' || !document.head) return;
  const style = document.createElement('style');
  style.dataset.podiumSlideFont = '';
  style.textContent = SLIDE_FONT_FACES.map((f) => face(f, `${SLIDE_FONT_DIR}${f[0]}`)).join('\n');
  document.head.append(style);
  installed = style;
  if (document.fonts?.load) {
    for (const spec of ['16px', 'bold 16px', 'italic 16px', 'italic bold 16px']) {
      document.fonts.load(`${spec} '${SLIDE_FONT}'`).catch(() => {});
    }
  }
}

const dataUrls = new Map();

function fontData(file) {
  if (!dataUrls.has(file)) {
    const job = fetch(`${SLIDE_FONT_DIR}${file}`)
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
 * A stylesheet for a standalone SVG image (a photo of a panel, an export):
 * when it lays text out in Podium's face, the faces come inside it as data,
 * since an SVG image loads nothing from outside itself - without them the
 * photo would fall back to Helvetica or Arial and break its lines elsewhere
 * than the slide on screen did. The latin-ext faces only come along for
 * text that needs them; a face that will not load is left out.
 */
export async function embedSlideFont(css, markup) {
  const text = String(css || '');
  if (!usesSlideFont(text)) return text;
  const wanted = SLIDE_FONT_FACES.filter(([, , , subset]) => subset === 'latin' || EXTENDED.test(String(markup || '')));
  const faces = await Promise.all(wanted.map(async (f) => {
    try { return face(f, await fontData(f[0])); } catch { return ''; }
  }));
  return `${faces.filter(Boolean).join('\n')}\n${text}`;
}
