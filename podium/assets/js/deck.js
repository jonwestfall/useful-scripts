// Marp decks.
//
// Both the display and the controller render the same markdown with the same
// renderer, so the slide on the projector and the one in your preview are the
// same object, and the presenter notes on your iPad belong to the slide the
// class is actually looking at.
//
// The Marp bundle is ~1 MB and is only fetched the first time a deck is used.

const MARP_URL = new URL('../vendor/marp.esm.js', import.meta.url).href;
const THEMES_MANIFEST = 'marp-themes/themes.json';

// Raw HTML in markdown is allowed, but only as layout. This is what makes the
// theme's `.columns` / `.callout` helpers work without letting a stray <script>
// in a downloaded deck run on the projector.
const HTML_ALLOWLIST = {
  div: ['class', 'style', 'id'],
  span: ['class', 'style'],
  p: ['class', 'style'],
  section: ['class', 'style'],
  figure: ['class'], figcaption: ['class'],
  blockquote: ['class'], pre: ['class'], code: ['class'],
  h1: ['class'], h2: ['class'], h3: ['class'], h4: ['class'], h5: ['class'], h6: ['class'],
  ul: ['class'], ol: ['class', 'start'], li: ['class'],
  table: ['class'], thead: [], tbody: [], tfoot: [], tr: ['class'],
  th: ['class', 'colspan', 'rowspan', 'align'], td: ['class', 'colspan', 'rowspan', 'align'],
  a: ['href', 'title', 'target', 'rel', 'class'],
  img: ['src', 'alt', 'title', 'width', 'height', 'class', 'style'],
  b: [], i: [], em: [], strong: [], u: [], s: [], small: [], mark: [],
  sup: [], sub: [], kbd: [], abbr: ['title'], br: [], hr: ['class'],
};

let enginePromise = null;
export const themeReport = { loaded: [], failed: [] };

// Shared with every place a deck gets rendered (the live display, the
// controller's cue preview, its slide thumbnails) so a build behaves the same
// wherever it shows up: hidden until its step, then a gentle fade in place -
// PowerPoint's "appear" animation, not a jump that reflows the rest of the
// bullets.
export const FRAGMENT_CSS = `
  .podium-fragment { opacity: 0; transition: opacity .35s ease; }
  .podium-fragment.is-shown { opacity: 1; }
`;

async function loadEngine() {
  const { Marp, browser } = await import(/* @vite-ignore */ MARP_URL);

  // Register every theme in marp-themes/. A broken one is reported rather than
  // taking the whole deck down with it.
  let files = [];
  try {
    const res = await fetch(THEMES_MANIFEST, { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      files = Array.isArray(data) ? data : data.themes || [];
    }
  } catch { /* no themes folder is fine - built-ins still work */ }

  const themeCss = [];
  for (const file of files) {
    try {
      const res = await fetch(`marp-themes/${file}`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      themeCss.push([file, await res.text()]);
    } catch (err) {
      themeReport.failed.push(`${file}: ${err.message}`);
    }
  }

  return { Marp, browser, themeCss };
}

function engine() {
  enginePromise ??= loadEngine();
  return enginePromise;
}

// A fresh Marp instance per render: themeSet and directive state are stateful,
// and one deck's front matter should never leak into the next.
async function createMarp() {
  const { Marp, themeCss } = await engine();
  const marp = new Marp({ inlineSVG: true, html: HTML_ALLOWLIST, math: 'katex' });
  for (const [file, css] of themeCss) {
    try {
      marp.themeSet.add(css);
      if (!themeReport.loaded.includes(file)) themeReport.loaded.push(file);
    } catch (err) {
      const note = `${file}: ${err.message}`;
      if (!themeReport.failed.includes(note)) themeReport.failed.push(note);
    }
  }
  return marp;
}

export async function applyPolyfill(root) {
  const { browser } = await engine();
  try { return browser(root); } catch { return null; }
}

/** Stable id for a deck's content, so the same file is only shipped once. */
export async function deckId(source) {
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

const cache = new Map();

function outline(root) {
  return Array.from(root.querySelectorAll('svg[data-marpit-svg] section')).map((section, i) => {
    const heading = section.querySelector('h1, h2, h3, h4');
    const text = (heading?.textContent || section.textContent || '').trim().replace(/\s+/g, ' ');
    return text.slice(0, 70) || `Slide ${i + 1}`;
  });
}

// Marp itself has no concept of a PowerPoint-style "build" (each `---` is one
// static slide) - this is Podium's own convention layered on top. Opt a slide
// in with `<!-- _class: build -->`; every bullet on it (and any element you
// mark yourself with `<span class="build">…</span>` or similar raw HTML,
// wherever it is) then arrives one at a time as Next is pressed, instead of
// the whole slide appearing at once.
//
// Marks each fragment with a numbered data attribute (read by the deck
// renderer to decide what is visible at a given step) and returns how many
// fragments each slide has, so the protocol layer can drive Next/Previous
// through the build before it moves to the next slide.
function markFragments(root) {
  const fragments = [];
  const sections = root.querySelectorAll('svg[data-marpit-svg] section');
  sections.forEach((section) => {
    const explicit = Array.from(section.querySelectorAll('.build, [data-build]'));
    // Auto-build: opting a slide in without hand-marking anything treats each
    // top-level bullet as one step, which is what most decks actually want.
    const candidates = explicit.length
      ? explicit
      : (section.classList.contains('build') ? Array.from(section.querySelectorAll('li')) : []);
    candidates.forEach((node, i) => {
      node.classList.add('podium-fragment');
      node.dataset.podiumFragment = String(i + 1);
    });
    fragments.push(candidates.length);
  });
  return fragments;
}

/**
 * Render markdown into slides. Cached by content, so flipping back and forth
 * between decks does not re-parse anything.
 */
export async function render(source, id) {
  const key = id || await deckId(source);
  if (cache.has(key)) return cache.get(key);

  const marp = await createMarp();
  const { html, css, comments } = marp.render(source);

  // Parse once, mutate in place to mark fragments, then re-serialize. Marp's
  // html is one wrapping <div class="marpit"> holding every slide's <svg>.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.querySelector('.marpit') || doc.body;
  const fragments = markFragments(root);
  const titles = outline(root);
  // The aspect ratio baked into each slide's own SVG viewBox - read once here
  // so the controller can shape its ink pad to match a slide exactly without
  // touching the DOM itself.
  const aspects = Array.from(root.querySelectorAll('svg[data-marpit-svg]')).map((svg) => {
    const box = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
    return box.length === 4 && box[2] > 0 && box[3] > 0 ? box[2] / box[3] : 16 / 9;
  });
  const finalHtml = root.outerHTML;

  // A deck naming a theme that was never installed falls back to the default
  // silently, which is a maddening thing to discover from the back of a lecture
  // hall. Say so instead.
  const wanted = frontMatterValue(source, 'theme');
  const themeWarning = wanted && !marp.themeSet.has(wanted)
    ? `Theme "${wanted}" is not installed. Put its .css in marp-themes/ and list it in marp-themes/themes.json. Using the default theme.`
    : null;

  const result = {
    id: key,
    html: finalHtml,
    css,
    theme: wanted && marp.themeSet.has(wanted) ? wanted : 'default',
    themeWarning,
    // Marpit hands back one array of comments per slide; directive comments
    // like `<!-- _class: lead -->` are consumed as directives and never appear
    // here, so what is left is genuinely presenter notes.
    notes: comments.map((list) => (list || []).join('\n\n').trim()),
    titles,
    fragments,
    aspects,
    count: titles.length,
  };
  cache.set(key, result);
  return result;
}

function frontMatterValue(source, key) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  const line = fm && new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(fm[1]);
  return line ? line[1].trim().replace(/^["']|["']$/g, '') : null;
}

export function frontMatterTitle(source, fallback = 'Deck') {
  const line = frontMatterValue(source, 'title');
  if (line) return line;
  const heading = /^#{1,2}\s+(.+)$/m.exec(source.replace(/^---[\s\S]*?---/, ''));
  if (heading) return heading[1].replace(/[*_`]/g, '').trim().slice(0, 60);
  return fallback;
}
