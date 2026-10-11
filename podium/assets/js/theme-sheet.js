// A Marp theme's cheat sheet: what a deck written in it can use, read from
// the theme's own CSS. No DOM here - theme-sheet-ui.js draws it, with a
// sample slide for each class.
//
//   classes     the slide classes it styles (`<!-- _class: lead -->`), each
//               with the comment written just above its first rule, if any -
//               and those it gets from a Marp theme it imports
//   variables   its custom properties (--brand: #00753e), colours marked
//   fonts       the font families it names
//   sizes       its @size presets, besides Marp's 16:9 and 4:3
//   about       the first comment in the file, as its description
//
// And DIRECTIVES: what any deck can say, whatever its theme.

/** What Marp's own themes offer (they are not CSS files Podium can read). */
export const BUILT_IN_SHEETS = {
  default: {
    about: 'Marp’s plain theme: dark text on white, GitHub-style typography.',
    classes: [{ name: 'invert', about: 'Light text on a dark background.' }],
  },
  gaia: {
    about: 'Marp’s Gaia: warm cream and slate, larger type, a lead layout for title slides.',
    classes: [
      { name: 'lead', about: 'Centred, for a title or section slide.' },
      { name: 'invert', about: 'Light text on a dark background.' },
      { name: 'gaia', about: 'Gaia’s own colour scheme: cream on slate blue.' },
    ],
  },
  uncover: {
    about: 'Marp’s Uncover: minimal, centred, with big type.',
    classes: [{ name: 'invert', about: 'Light text on a dark background.' }],
  },
};

/** What any deck can say, whatever its theme: Marp's directives and Podium's own. */
export const DIRECTIVES = [
  { name: 'theme', example: 'theme: gaia', about: 'The theme, in the front matter.' },
  { name: '_class', example: '<!-- _class: lead -->', about: 'One slide in one of the theme’s classes; without the _ it applies from this slide on.' },
  { name: 'paginate', example: 'paginate: true', about: 'Page numbers; <!-- _paginate: false --> leaves one slide without.' },
  { name: 'header / footer', example: 'footer: PSY 415 · Week 3', about: 'A line at the top or bottom of every slide.' },
  { name: 'backgroundColor', example: '<!-- _backgroundColor: #fff4e5 -->', about: 'One slide’s background; color sets its text.' },
  { name: 'backgroundImage', example: '![bg](picture.jpg)', about: 'A picture as the background; ![bg left](…) puts it beside the text.' },
  { name: 'size', example: 'size: 4:3', about: 'The slide shape: 16:9 (the default), 4:3, or a size the theme defines.' },
  { name: 'build', example: '<!-- _class: build -->', about: 'Podium: reveal this slide’s bullets one at a time.' },
  { name: '_video', example: '<!-- _video: /media/…/clip.mp4 -->', about: 'Podium: make this a video slide.' },
  { name: 'mermaidTheme', example: '<!-- _mermaidTheme: dark -->', about: 'Podium: the look of ```mermaid diagrams.' },
];

const COMMENT = /\/\*([\s\S]*?)\*\//g;
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-z]+)$/i;
const NOT_CLASSES = new Set(['marpit']);

/** Plain text from a CSS comment: no stars or rules of dashes, one paragraph. */
function commentText(raw) {
  return raw.split('\n')
    .map((l) => l.replace(/^\s*\*+\s?/, '').trim())
    .filter((l) => l && !/^[-=*_\s]+$/.test(l))
    .join(' ')
    .replace(/\s*-{3,}\s*/g, ' ')
    .trim();
}

/**
 * The cheat sheet for a theme's CSS. `builtIns` is BUILT_IN_SHEETS, passed in
 * so a theme that imports one of Marp's lists the classes it inherits.
 */
export function analyzeTheme(css, builtIns = BUILT_IN_SHEETS) {
  const text = String(css || '');
  const name = /@theme\s+([\w-]+)/.exec(text)?.[1] || '';
  const imports = [...text.matchAll(/@import\s+(?:url\()?['"]?([\w-]+)['"]?\)?\s*;/g)].map((m) => m[1]);

  // The description: the first comment that is not just the @theme line.
  let about = '';
  for (const m of text.matchAll(COMMENT)) {
    const t = commentText(m[1].replace(/@theme\s+[\w-]+/, '').replace(/@size[^\n]*/g, ''));
    if (t) { about = t; break; }
  }

  const classes = new Map();
  // Each class, with the comment right above its first rule as its description.
  // Everything between one rule and the next is that rule's preamble: its
  // last comment, if it has one, is what the author wrote about it.
  for (const m of text.matchAll(/([^{}]*)\{/g)) {
    const comments = [...m[1].matchAll(COMMENT)];
    const note = comments.length ? commentText(comments[comments.length - 1][1]) : '';
    const selector = m[1].replace(COMMENT, '');
    for (const c of selector.matchAll(/section\.([A-Za-z][\w-]*)/g)) {
      const cls = c[1];
      if (NOT_CLASSES.has(cls)) continue;
      if (!classes.has(cls)) classes.set(cls, { name: cls, about: note, from: '' });
      else if (!classes.get(cls).about && note) classes.get(cls).about = note;
    }
  }
  for (const base of imports) {
    for (const inherited of builtIns[base]?.classes || []) {
      if (!classes.has(inherited.name)) classes.set(inherited.name, { ...inherited, from: base });
    }
  }

  const stripped = text.replace(COMMENT, '');
  const variables = [];
  const seenVars = new Set();
  for (const m of stripped.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
    if (seenVars.has(m[1])) continue;
    seenVars.add(m[1]);
    const value = m[2].trim();
    variables.push({ name: m[1], value, color: COLOR.test(value) && !/^(inherit|initial|none|auto|transparent)$/i.test(value) && !/^\d/.test(value) });
  }
  const fonts = [...new Set([...stripped.matchAll(/font-family\s*:\s*([^;}]+)/g)].map((m) => m[1].trim()))];
  const sizes = [...text.matchAll(/@size\s+([\w:-]+)\s+(\d+px)\s+(\d+px)/g)].map((m) => ({ name: m[1], width: m[2], height: m[3] }));

  return { name, imports, about, classes: [...classes.values()], variables, fonts, sizes };
}

/** A Marp built-in's sheet, in the same shape as analyzeTheme's. */
export function builtInSheet(name) {
  const known = BUILT_IN_SHEETS[name];
  if (!known) return null;
  return { name, imports: [], about: known.about, classes: known.classes.map((c) => ({ ...c, from: '' })), variables: [], fonts: [], sizes: [] };
}

/** A deck of sample slides for a sheet: the theme as it is, then one slide per class. */
export function sampleDeck(sheet) {
  const slide = (title, cls) => `${cls ? `<!-- _class: ${cls} -->\n\n` : ''}# ${title}\n\n- A first point, with **bold** and a [link](https://example.edu)\n- A second point\n\n> A quotation, as this theme sets it\n`;
  return [`---\nmarp: true\ntheme: ${sheet.name || 'default'}\npaginate: true\n---\n`,
    slide('The theme as it is', ''),
    ...sheet.classes.map((c) => slide(c.name, c.name)),
  ].join('\n---\n\n').replace('---\n\n# The theme', '# The theme');
}

// --- quick settings ------------------------------------------------------------------
//
// Admin's quick settings write a theme's main colours and font as one marked
// block at the end of its CSS, so they win over what comes before, and read
// them back from it next time. Everything else in the theme stays as written.

const QUICK_START = '/* podium:quick-settings - written by Admin’s quick settings; change them there */';
const QUICK_END = '/* /podium:quick-settings */';
const QUICK_BLOCK = /\n*\/\* podium:quick-settings[^*]*\*\/[\s\S]*?\/\* \/podium:quick-settings \*\/\n*/;

/** Fonts offered by name; anything else is kept as typed. */
export const QUICK_FONTS = [
  ['', 'As the theme sets it'],
  ['system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', 'System sans-serif'],
  ['"Helvetica Neue", Arial, sans-serif', 'Helvetica / Arial'],
  ['Georgia, "Times New Roman", serif', 'Serif (Georgia)'],
  ['"Atkinson Hyperlegible", Verdana, sans-serif', 'Hyperlegible (Verdana)'],
  ['ui-monospace, Menlo, Consolas, monospace', 'Monospace'],
];

const HEX = /^#[0-9a-f]{6}$/i;

/** The quick settings a theme's CSS holds: { bg, fg, heading, accent, font }, or null. */
export function readQuickSettings(css) {
  const block = QUICK_BLOCK.exec(String(css || ''))?.[0];
  if (!block) return null;
  const grab = (re) => re.exec(block)?.[1]?.trim() || '';
  return {
    bg: grab(/section\s*\{[^}]*?background-color:\s*([^;]+);/),
    fg: grab(/section\s*\{[^}]*?[^-]color:\s*([^;]+);/),
    font: grab(/section\s*\{[^}]*?font-family:\s*([^;]+);/),
    heading: grab(/section h1, section h2, section h3\s*\{[^}]*?color:\s*([^;]+);/),
    accent: grab(/section a, section strong\s*\{[^}]*?color:\s*([^;]+);/),
  };
}

/**
 * `css` with its quick-settings block set to `values` (or removed, when none
 * is set). Colours must be #rrggbb; a font is a CSS font list without braces
 * or semicolons. Anything else is left out rather than written.
 */
export function writeQuickSettings(css, values = {}) {
  const base = String(css || '').replace(QUICK_BLOCK, '\n').replace(/\s*$/, '\n');
  const colour = (v) => (HEX.test(String(v || '')) ? String(v).toLowerCase() : '');
  const font = String(values.font || '').replace(/[{};<>]/g, '').trim();
  const section = [
    colour(values.bg) && `  background-color: ${colour(values.bg)};`,
    colour(values.fg) && `  color: ${colour(values.fg)};`,
    font && `  font-family: ${font};`,
  ].filter(Boolean);
  const rules = [];
  if (section.length) rules.push(`section {\n${section.join('\n')}\n}`);
  if (colour(values.heading)) rules.push(`section h1, section h2, section h3 {\n  color: ${colour(values.heading)};\n}`);
  if (colour(values.accent)) rules.push(`section a, section strong {\n  color: ${colour(values.accent)};\n}`);
  if (!rules.length) return base;
  return `${base}\n${QUICK_START}\n${rules.join('\n')}\n${QUICK_END}\n`;
}
