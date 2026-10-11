// How a poll looks on the projector: light or dark, or in the colours of one
// of the Marp themes this Podium has, and which colours its results are drawn
// in. No DOM here: the colours are worked out where the poll is composed (the
// controller or the planner - see poll-look-theme.js for reading a theme) and
// carried in the poll item itself, so the display, Guest View and a replay
// all draw the same thing without loading a theme of their own.
//
//   look = {
//     mode:    'dark' | 'light' | 'theme',
//     theme:   the Marp theme's name, for mode 'theme',
//     colors:  { bg, fg, accent, extras: [...] } read from that theme,
//     palette: 'accent' | 'primary' | 'rainbow' | 'soft' | 'shades' | 'theme',
//   }
//
// Whatever the theme says, the colours used are adjusted until they read
// against the background: text at 4.5:1, bars and large words at 3:1.

export const LOOK_MODES = [
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['theme', 'A slide theme’s colours'],
];

export const PALETTES = [
  ['accent', 'One colour'],
  ['primary', 'Primary colours'],
  ['rainbow', 'Rainbow'],
  ['soft', 'Soft'],
  ['shades', 'Shades of one colour'],
  ['theme', 'The theme’s colours'],
];

const PRESETS = {
  dark: { bg: '#0a0d12', fg: '#f2f4f7', accent: '#4da3ff', extras: [] },
  light: { bg: '#f7f8fa', fg: '#111827', accent: '#1f5fcc', extras: [] },
};

const SETS = {
  primary: ['#d62828', '#1e5bd6', '#f2c500', '#1f9d55'],
  rainbow: ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#3949ab', '#8e24aa'],
  soft: ['#f4a6a6', '#f9d29d', '#fbe7a1', '#b5e4ca', '#a7c7e7', '#cdb4db', '#f7c6d9'],
};

// --- colour arithmetic ----------------------------------------------------------

const RGB = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/;
const SRGB = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/;
const alphaOf = (text) => (text === undefined ? 1 : text.endsWith('%') ? parseFloat(text) / 100 : parseFloat(text));

/** A CSS colour (#rgb, #rrggbb, rgb(), rgba(), color(srgb …)) as {r, g, b, a}, or null. */
export function parseColor(text) {
  const s = String(text || '').trim();
  const m = RGB.exec(s);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: alphaOf(m[4]) };
  const c = SRGB.exec(s);
  if (c) return { r: c[1] * 255, g: c[2] * 255, b: c[3] * 255, a: alphaOf(c[4]) };
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  return null;
}

export const toHex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 });
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

function channel(v) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
/** WCAG relative luminance, 0-1. */
export const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
/** WCAG contrast ratio between two colours, 1-21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `color`, moved toward black or white (whichever the background is not)
 * just far enough to reach `ratio` against `bg`.
 */
export function readable(color, bg, ratio) {
  if (contrast(color, bg) >= ratio) return color;
  // Toward whichever of black and white the background is further from: on a
  // mid grey only black can reach 7:1, though the grey is "dark" by eye.
  const target = contrast(BLACK, bg) >= contrast(WHITE, bg) ? BLACK : WHITE;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const next = mix(color, target, t);
    if (contrast(next, bg) >= ratio) return next;
  }
  return target;
}

const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const hexOr = (v, fallback) => (isHex(v) ? v.toLowerCase() : fallback);
const pick = (v, list, def) => (list.some(([k]) => k === v) ? v : def);

/** A look as a poll item may carry it, whatever it was handed. */
export function normalizeLook(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = pick(raw.mode, LOOK_MODES, 'dark');
  const look = { mode, palette: pick(raw.palette, PALETTES, 'accent') };
  if (mode === 'theme') {
    const c = raw.colors && typeof raw.colors === 'object' ? raw.colors : {};
    if (!isHex(c.bg) || !isHex(c.fg)) return { mode: 'dark', palette: look.palette };
    look.theme = String(raw.theme || '').slice(0, 60);
    look.colors = {
      bg: c.bg.toLowerCase(),
      fg: c.fg.toLowerCase(),
      accent: hexOr(c.accent, c.fg.toLowerCase()),
      extras: (Array.isArray(c.extras) ? c.extras : []).filter(isHex).map((x) => x.toLowerCase()).slice(0, 8),
    };
  }
  return look;
}

/** The base colours of a look: { bg, fg, accent, extras } as hex. */
function baseOf(look) {
  if (look?.mode === 'theme' && look.colors) return look.colors;
  return PRESETS[look?.mode === 'light' ? 'light' : 'dark'];
}

/**
 * The colours a poll is drawn in, all readable on its background:
 *   { bg, fg, dim, accent, track, card, ok, palette: [...] }
 */
export function lookColors(rawLook) {
  const look = normalizeLook(rawLook) || { mode: 'dark', palette: 'accent' };
  const base = baseOf(look);
  const bg = parseColor(base.bg);
  const fg = readable(parseColor(base.fg) || WHITE, bg, 7);
  // Dark in the sense that matters here: light text reads better on it.
  const dark = contrast(WHITE, bg) > contrast(BLACK, bg);
  const accent = readable(parseColor(base.accent) || fg, bg, 3);
  const dim = readable(mix(fg, bg, 0.35), bg, 4.5);
  const track = mix(fg, bg, dark ? 0.86 : 0.9);
  const card = mix(fg, bg, dark ? 0.9 : 0.95);
  const ok = readable(parseColor(dark ? '#3fb950' : '#13804f'), bg, 3);

  let source;
  switch (look.palette) {
    case 'primary': source = SETS.primary; break;
    case 'rainbow': source = SETS.rainbow; break;
    case 'soft': source = SETS.soft; break;
    // Away from the background, so every shade still stands out on it.
    case 'shades': source = [0, 0.2, 0.38, 0.54, 0.68].map((t) => toHex(mix(accent, dark ? WHITE : BLACK, t))); break;
    case 'theme': source = [base.accent, ...(base.extras || [])]; break;
    default: source = [toHex(accent)];
  }
  const palette = [];
  for (const hex of source) {
    const c = parseColor(hex);
    if (!c) continue;
    const out = toHex(readable(c, bg, 3));
    if (!palette.includes(out)) palette.push(out);
  }
  // A theme with only one colour of its own still gets a few to tell bars apart.
  if (look.palette === 'theme' && palette.length < 3) {
    for (const t of [0.3, 0.55]) {
      const extra = toHex(readable(mix(accent, dark ? WHITE : BLACK, t), bg, 3));
      if (!palette.includes(extra)) palette.push(extra);
    }
  }
  if (!palette.length) palette.push(toHex(accent));
  return {
    bg: toHex(bg), fg: toHex(fg), dim: toHex(dim), accent: toHex(accent),
    track: toHex(track), card: toHex(card), ok: toHex(ok), dark, palette,
  };
}

/** The CSS custom properties a poll's renderer sets, from its look. */
export function lookVars(look) {
  const c = lookColors(look);
  return {
    '--poll-bg': c.bg, '--poll-fg': c.fg, '--poll-dim': c.dim, '--poll-accent': c.accent,
    '--poll-track': c.track, '--poll-card': c.card, '--poll-ok': c.ok,
  };
}

/**
 * A theme's colours, as read from a slide in it (see poll-look-theme.js):
 * the slide's background (a gradient's colours averaged), its text, and the
 * colours its headings, links and emphasis use, distinct ones only.
 */
export function colorsFromSlide({ background, backgroundImage, color, heading, subheading, link, strong, highlight } = {}) {
  let bg = parseColor(background);
  if (!bg || bg.a < 0.5) {
    const stops = [];
    const re = new RegExp(`${RGB.source}|${SRGB.source}|#[0-9a-f]{6}\\b`, 'gi');
    for (const m of String(backgroundImage || '').matchAll(re)) {
      const c = parseColor(m[0]);
      if (c && c.a > 0.5) stops.push(c);
    }
    bg = stops.length
      ? stops.reduce((t, c) => ({ r: t.r + c.r / stops.length, g: t.g + c.g / stops.length, b: t.b + c.b / stops.length, a: 1 }), { r: 0, g: 0, b: 0, a: 1 })
      : WHITE;
  }
  const fg = parseColor(color) || (luminance(bg) < 0.4 ? WHITE : BLACK);
  const near = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 40;
  const own = [];
  for (const text of [heading, highlight, link, subheading, strong]) {
    const c = parseColor(text);
    if (!c || c.a < 0.5 || near(c, fg) || near(c, bg) || own.some((o) => near(o, c))) continue;
    own.push(c);
  }
  return {
    bg: toHex(bg),
    fg: toHex(fg),
    accent: toHex(own[0] || fg),
    extras: own.slice(1).map(toHex),
  };
}
