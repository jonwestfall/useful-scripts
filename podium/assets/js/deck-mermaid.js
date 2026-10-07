// Mermaid diagrams in decks (Issue #235).
//
// A ```mermaid code block is drawn as the diagram it describes - on the
// projector, in every preview and thumbnail, in Guest View and in a PDF -
// with nothing fetched from anywhere: the Mermaid bundle (5 MB) is vendored
// like Marp's, and only loaded by a deck that has a diagram in it.
//
// Each diagram becomes an <img> of its SVG rather than live SVG in the slide.
// A picture runs no script and can reach nothing, whatever the markdown says,
// and everything that already copes with pictures - fitting, the slide photo,
// PDF export, Marp's own Safari polyfill - copes with a diagram for free.
//
// Its theme, first match wins:
//   1. what the diagram says itself, at its top - `%%{init: {"theme": "forest"}}%%`
//      or a `config: theme:` front matter, Mermaid's own two ways;
//   2. the slide's mermaidTheme directive (see deck-source.js);
//   3. the deck: colours, type and dark-or-light read from the slide itself.

import { MERMAID_THEMES } from './deck-source.js';

const MERMAID_URL = new URL('../vendor/mermaid.esm.js', import.meta.url).href;

const MIN_HEIGHT = 120;     // slide px: a diagram is never squeezed smaller than this to fit
const BASE_FONT = 16;       // what Mermaid lays text out at; scaled to the slide's type
const CACHE_LIMIT = 200;

let enginePromise = null;
const drawn = new Map();    // config + text -> {svg, width, height} | {error}
let queue = Promise.resolve();

// Same retry as Marp's (see importMarp in deck.js, Issue #221): a module that
// failed once is remembered as failed under its URL, so ask under a new one.
async function importMermaid() {
  try {
    return await import(/* @vite-ignore */ MERMAID_URL);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return import(/* @vite-ignore */ `${MERMAID_URL}?retry=${Date.now()}`);
  }
}

function engine() {
  enginePromise ??= importMermaid().then((mod) => {
    const mermaid = mod.default;
    // Never go looking for .mermaid elements on the page by itself.
    mermaid.startOnLoad = false;
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    return mermaid;
  }).catch((err) => {
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

// --- the deck's look --------------------------------------------------------------

const RGB = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/;
const SRGB = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/;
const alphaOf = (text) => (text === undefined ? 1 : text.endsWith('%') ? parseFloat(text) / 100 : parseFloat(text));

function parseColor(text) {
  const m = RGB.exec(String(text || ''));
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: alphaOf(m[4]) };
  const c = SRGB.exec(String(text || ''));
  if (c) return { r: c[1] * 255, g: c[2] * 255, b: c[3] * 255, a: alphaOf(c[4]) };
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text || '').trim());
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  return null;
}

const sameColor = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 24;

// What is behind the diagram: the slide's colour, or - for a theme that
// paints its slides with a gradient - the gradient's colours, averaged.
function backgroundOf(look) {
  const solid = parseColor(look.background);
  if (solid && solid.a > 0.5) return solid;
  const stops = [];
  const re = new RegExp(`${RGB.source}|${SRGB.source}`, 'g');
  for (const m of String(look.backgroundImage || '').matchAll(re)) {
    const c = parseColor(m[0]);
    if (c && c.a > 0.5) stops.push(c);
  }
  if (!stops.length) return { r: 255, g: 255, b: 255, a: 1 };
  const sum = stops.reduce((t, c) => ({ r: t.r + c.r, g: t.g + c.g, b: t.b + c.b }), { r: 0, g: 0, b: 0 });
  return { r: sum.r / stops.length, g: sum.g / stops.length, b: sum.b / stops.length, a: 1 };
}

const toHex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 });
const luminance = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

/**
 * How Mermaid should be set up for a diagram on a slide that looks like
 * `look` (see slideLooks), with `wanted` its mermaidTheme directive if any.
 * Exported for the tests.
 */
export function diagramConfig(look = {}, wanted = '') {
  const background = backgroundOf(look);
  const dark = luminance(background) < 0.45;
  const fg = parseColor(look.color) || (dark ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 1 });
  // A heading in its own colour is the theme's accent (a course's brand
  // colour, say); otherwise the theme's highlight colour, if it names one.
  const heading = parseColor(look.heading);
  const accent = (heading && !sameColor(heading, fg) ? heading : null) || parseColor(look.highlight) || fg;
  const fontFamily = String(look.fontFamily || '').trim() || undefined;

  let theme;
  if (MERMAID_THEMES.includes(wanted)) theme = wanted;
  // Gaia, uncover and themes built on them name their colours; a diagram in
  // those colours looks like part of the slide rather than pasted onto it.
  else if (parseColor(look.highlight)) theme = 'base';
  else theme = dark ? 'dark' : 'default';

  const config = {
    startOnLoad: false,
    securityLevel: 'strict',
    theme,
    suppressErrorRendering: true,
  };
  if (fontFamily) config.fontFamily = fontFamily;
  if (theme === 'base') {
    config.themeVariables = {
      darkMode: dark,
      background: toHex(background),
      primaryColor: toHex(mix(background, accent, dark ? 0.35 : 0.18)),
      primaryBorderColor: toHex(accent),
      primaryTextColor: toHex(fg),
      secondaryColor: toHex(mix(background, accent, dark ? 0.2 : 0.08)),
      tertiaryColor: toHex(mix(background, fg, 0.06)),
      lineColor: toHex(fg),
      textColor: toHex(fg),
      ...palette(accent, dark),
      ...(fontFamily ? { fontFamily } : {}),
    };
  } else if (fontFamily) {
    config.themeVariables = { fontFamily };
  }
  return config;
}

function toHsl({ r, g, b }) {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: h * 60, s, l };
}

function fromHsl({ h, s, l }) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a: 1 };
}

// The colours Mermaid gives a diagram's parts one by one - a mindmap's
// branches, a pie's slices, a timeline's sections. Mermaid's own, worked out
// from one colour, come out near-black on a dark slide and too alike to tell
// apart on a pale one; these go round the colour wheel from the accent.
function palette(accent, dark) {
  const { h, s } = toHsl(accent);
  const sat = Math.max(0.45, Math.min(0.75, s || 0.55));
  const out = {};
  for (let i = 0; i < 12; i++) {
    const hue = (h + i * 137.5) % 360;      // the golden angle: neighbours never alike
    const fill = fromHsl({ h: hue, s: sat, l: dark ? 0.36 : 0.78 });
    const slice = fromHsl({ h: hue, s: sat, l: dark ? 0.45 : 0.62 });
    out[`cScale${i}`] = toHex(fill);
    out[`cScaleLabel${i}`] = dark ? '#ffffff' : '#1a1a1a';
    out[`pie${i + 1}`] = toHex(slice);
  }
  return out;
}

/**
 * What each slide with a diagram looks like - its colours, type, size, and
 * the room left on it for diagrams - read off the slides laid out with the
 * deck's CSS in a hidden copy (the same way measureFits in deck.js measures).
 */
async function slideLooks(root, css, slides, wanted) {
  const looks = new Map();
  if (typeof document === 'undefined' || !document.body) return looks;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-30000px;top:0;width:1280px;visibility:hidden;pointer-events:none;z-index:-1';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host { display: block; }
    svg[data-marpit-svg] { display: block; width: 1280px; height: auto; }
  </style><style>${css}</style>${root.outerHTML}`;
  document.body.append(host);
  try {
    const copies = slides(shadow);
    for (const index of wanted) {
      const section = copies[index];
      if (!section) continue;
      const style = getComputedStyle(section);
      const heading = section.querySelector('h1, h2, h3');
      looks.set(index, {
        background: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        color: style.color,
        highlight: resolvedColor(section, '--color-highlight'),
        heading: heading ? getComputedStyle(heading).color : '',
        fontFamily: style.fontFamily,
        fontSize: parseFloat(style.fontSize) || BASE_FONT,
        room: roomFor(section, style),
      });
    }
  } finally {
    host.remove();
  }
  return looks;
}

// A theme's colour variable as a colour: gaia's are written `light-dark(…)`,
// which only a property that takes a colour turns into one.
function resolvedColor(section, name) {
  if (!getComputedStyle(section).getPropertyValue(name).trim()) return '';
  const probe = section.ownerDocument.createElement('span');
  probe.style.cssText = `position:absolute;color:var(${name})`;
  section.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

// The height a slide has left for its diagrams: its content box less
// everything else on it, shared between the diagrams. A diagram inside
// something else (a .columns layout) gets the whole box and is left to fit.
function roomFor(section, style) {
  const box = section.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
  let others = 0;
  let diagrams = 0;
  for (const child of section.children) {
    const cs = getComputedStyle(child);
    if (cs.position === 'absolute' || cs.position === 'fixed' || cs.display === 'none') continue;
    if (child.matches('pre') && child.querySelector(':scope > code.language-mermaid')) {
      diagrams++;
      others += (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
      continue;
    }
    others += child.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  }
  if (!diagrams) return Math.max(MIN_HEIGHT, box);
  return Math.max(MIN_HEIGHT, Math.floor((box - others) / diagrams));
}

// --- drawing ----------------------------------------------------------------------

let nextId = 0;

/** One diagram, as standalone SVG text and its size - or why it could not be drawn. */
async function drawOne(mermaid, text, config) {
  const key = `${JSON.stringify(config)}\n${text}`;
  if (drawn.has(key)) return drawn.get(key);
  // Mermaid's settings are one global; two decks drawing at once must not
  // swap themes halfway through each other.
  const run = queue.then(async () => {
    mermaid.initialize(config);
    const id = `podium-mermaid-${++nextId}`;
    try {
      const { svg } = await mermaid.render(id, text);
      return standalone(svg);
    } catch (err) {
      return { error: describeError(err, text) };
    } finally {
      // A failed render can leave its scratch element behind.
      document.getElementById(`d${id}`)?.remove();
      document.getElementById(id)?.remove();
    }
  });
  queue = run.catch(() => {});
  const result = await run;
  if (drawn.size >= CACHE_LIMIT) drawn.delete(drawn.keys().next().value);
  drawn.set(key, result);
  return result;
}

// Mermaid's SVG, made into a file a picture can show: well-formed XML (the
// HTML parser is forgiving where an <img> is not), sized by its own viewBox,
// and transparent so the slide shows through.
function standalone(svgText) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${svgText}`, 'text/html');
  const svg = doc.querySelector('svg');
  if (!svg) return { error: { message: 'Mermaid drew nothing for this diagram.', line: 0 } };
  const box = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const width = box.length === 4 && box[2] > 0 ? box[2] : parseFloat(svg.getAttribute('width')) || 300;
  const height = box.length === 4 && box[3] > 0 ? box[3] : parseFloat(svg.getAttribute('height')) || 150;
  svg.removeAttribute('style');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return { svg: new XMLSerializer().serializeToString(svg), width, height };
}

/** Mermaid's complaint, made short enough for a slide, with the line it is about if it says. */
export function describeError(err, text = '') {
  const raw = String(err?.message || err?.str || err || 'This is not a diagram Mermaid knows how to draw.');
  const line = Number(/\bline (\d+)/i.exec(raw)?.[1]) || 0;
  const lines = raw.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  let message = lines[0] || raw;
  const expecting = lines.find((l) => /^Expecting /.test(l));
  if (expecting) message += ` ${expecting.length > 160 ? `${expecting.slice(0, 157)}...` : expecting}`;
  if (/No diagram type detected/i.test(raw)) {
    message = text.trim()
      ? 'Mermaid does not recognise the first line as a kind of diagram (flowchart, sequenceDiagram, classDiagram, gantt, pie, mindmap...).'
      : 'This diagram is empty.';
  }
  return { message: message.slice(0, 400), line };
}

function diagramType(text) {
  for (const l of String(text).split('\n')) {
    const t = l.trim();
    if (!t || t.startsWith('%%') || t === '---') continue;
    if (/^[\w-]+\s*:/.test(t) && !/^\w+Diagram/.test(t)) continue;   // a config line
    return t.split(/\s+/)[0];
  }
  return '';
}

function errorBox(doc, text, error) {
  const box = doc.createElement('div');
  box.className = 'podium-diagram-error';
  box.setAttribute('role', 'note');
  const title = doc.createElement('strong');
  const kind = diagramType(text);
  title.textContent = kind ? `This diagram (${kind}) could not be drawn` : 'This diagram could not be drawn';
  const said = doc.createElement('span');
  said.textContent = error.message;
  box.append(title, said);
  return box;
}

export const DIAGRAM_CSS = `
  img.podium-diagram { display: block; margin: 0.4em auto; max-width: 100%; width: auto; height: auto; }
  .podium-diagram-error {
    display: block; margin: 0.4em 0; padding: 0.5em 0.75em; border-radius: 6px;
    border: 2px solid #c62828; background: #fdecea; color: #7f1d1d;
    font-size: 0.6em; line-height: 1.35; text-align: left;
  }
  .podium-diagram-error strong { display: block; margin-bottom: 0.2em; }
  .podium-diagram-error span { white-space: pre-wrap; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.9em; }
`;

/**
 * Draw every ```mermaid block in a rendered deck in place (render() in
 * deck.js, before it measures anything). `slides(root)` is each slide's own
 * <section>, by index.
 *
 * @returns {Promise<{slide: number, nth: number, theme: string, error: {message: string, line: number}|null,
 *   picture: {svg: string, width: number, height: number}|null}[]>} - picture is the diagram as drawn, for an export
 */
export async function drawDiagrams(root, css, slides) {
  const blocks = Array.from(root.querySelectorAll('pre > code.language-mermaid'));
  if (!blocks.length || typeof document === 'undefined') return [];
  const sections = slides(root);
  const slideOf = (node) => sections.findIndex((s) => s.contains(node));
  const where = blocks.map((code) => slideOf(code));
  const looks = await slideLooks(root, css, slides, [...new Set(where.filter((i) => i >= 0))]);

  let mermaid = null;
  let loadError = null;
  try {
    mermaid = await engine();
  } catch (err) {
    loadError = { message: `Podium could not load its diagram drawing (${err?.message || err}). It will try again.`, line: 0, retry: true };
  }

  const out = [];
  const seen = new Map();
  for (const [i, code] of blocks.entries()) {
    const pre = code.parentElement;
    const slide = where[i];
    const nth = seen.get(slide) || 0;
    seen.set(slide, nth + 1);
    const text = code.textContent || '';
    const look = looks.get(slide) || {};
    const config = diagramConfig(look, sections[slide]?.dataset.mermaidTheme || '');
    const result = loadError ? { error: loadError } : await drawOne(mermaid, text, config);
    let picture = null;
    if (result.error) {
      pre.replaceWith(errorBox(root.ownerDocument, text, result.error));
    } else {
      const scale = Math.max(1, (look.fontSize || BASE_FONT) / BASE_FONT);
      const img = root.ownerDocument.createElement('img');
      img.className = 'podium-diagram';
      img.alt = `Diagram: ${diagramType(text) || 'Mermaid'}`;
      // Drawn at the slide's type size rather than Mermaid's 16px, so a
      // diagram's labels read like the rest of the slide.
      const width = Math.round(result.width * scale);
      const height = Math.round(result.height * scale);
      const sized = result.svg
        .replace(/^(<svg\b[^>]*?)\swidth="[^"]*"/, `$1 width="${width}"`)
        .replace(/^(<svg\b[^>]*?)\sheight="[^"]*"/, `$1 height="${height}"`);
      img.setAttribute('src', `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`);
      img.setAttribute('width', String(width));
      img.setAttribute('height', String(height));
      if (look.room) img.setAttribute('style', `max-height: ${look.room}px`);
      pre.replaceWith(img);
      picture = { svg: sized, width, height };
    }
    out.push({ slide, nth, theme: config.theme, error: result.error || null, picture });
  }
  return out;
}
