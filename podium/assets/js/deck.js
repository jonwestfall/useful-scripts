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

/**
 * A deck's CSS, re-pointed for a slide that has been lifted out on its own.
 *
 * Marpit scopes every rule it emits to `div.marpit > svg > foreignObject >
 * section ...`. That wrapper cannot exist around the ROOT element of a
 * standalone SVG document, which is exactly what rasterizing one slide
 * produces - so every one of those selectors misses, and the slide comes out
 * as unstyled black-on-transparent text: invisible against a dark backdrop,
 * and nothing like the slide on the wall. Dropping the wrapper from the front
 * of the chain re-points the rules at the root <svg>, which is the element
 * that is actually there.
 *
 * Everything that rasterizes a slide goes through here: the photo of a panel
 * (see snapshot() in renderers.js) and the marked-up slide export.
 */
export function cssForStandaloneSlide(css) {
  return String(css || '').replace(/div\.marpit\s*>\s*/g, '');
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

// --- fitting a slide into its own box ---------------------------------------
//
// Marp gives every slide the same fixed box - 1280x720 for 16:9 - and hides
// whatever does not fit inside it. A slide with one paragraph too many does not
// scroll and does not complain: it simply loses its last bullets off the bottom
// edge, and you find that out standing in front of the class. Podium shrinks
// that slide until it fits instead.
//
// The mechanism is the one Marp already uses to put a 1280px slide on any
// screen. Each slide is an <svg> whose viewBox is scaled to whatever box it is
// given, so growing the viewBox (with the foreignObject and section inside it)
// by 1/scale, while leaving the type at its authored pixel size, means the same
// slide at the same size on screen with smaller text and more room - "shrink
// text on overflow", done by the renderer rather than by hand.
//
// It is deliberately NOT a CSS transform on the <section>: Marp's own Safari
// polyfill (see applyPolyfill) rewrites that one property every animation
// frame, so anything Podium put there would survive about 16 milliseconds.

const FIT_MIN = 0.55;      // never shrink type past this - unreadable is not "fits"
const FIT_SLACK = 1;       // px: sub-pixel overflow is not overflow
const FIT_STEPS = 5;       // shrink passes before giving up
const FIT_REFINE = 4;      // halvings used to give size back afterwards
const FIT_WAIT_MS = 1200;  // cap on waiting for webfonts/images before measuring

/** The slide's authored box, remembered so a re-fit is not measured against a fit. */
function slideBox(svg) {
  if (!svg.dataset.podiumBox) {
    const box = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
    const ok = box.length === 4 && box[2] > 0 && box[3] > 0;
    svg.dataset.podiumBox = ok ? `${box[2]} ${box[3]}` : '1280 720';
  }
  const [w, h] = svg.dataset.podiumBox.split(' ').map(Number);
  return { w, h };
}

/** The <section> holding the slide's content (not an advanced background's). */
function contentSection(svg) {
  for (const fo of svg.children) {
    if (fo.tagName !== 'foreignObject') continue;
    for (const sec of fo.children) {
      if (sec.tagName !== 'SECTION') continue;
      if (sec.dataset.marpitAdvancedBackground === 'background') continue;
      return sec;
    }
  }
  return null;
}

/**
 * Resize one slide's SVG user space. `scale` is how big its type ends up
 * relative to what the theme asked for, so 1 restores the authored slide and
 * 0.8 is "everything at 80%, with 25% more room to put it in".
 */
function setSlideScale(svg, scale) {
  const base = slideBox(svg);
  const w = Math.round(base.w / scale * 100) / 100;
  const h = Math.round(base.h / scale * 100) / 100;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  for (const fo of svg.children) {
    if (fo.tagName !== 'foreignObject') continue;
    fo.setAttribute('width', String(w));
    fo.setAttribute('height', String(h));
    for (const sec of fo.children) {
      if (sec.tagName !== 'SECTION') continue;
      sec.style.width = `${w}px`;
      sec.style.height = `${h}px`;
    }
  }
  if (scale < 1) svg.dataset.podiumFit = scale.toFixed(3);
  else delete svg.dataset.podiumFit;
}

/** Apply scales measured earlier (see measureFits) to a fresh copy of a deck. */
export function applyFits(root, fits) {
  if (!fits?.length) return;
  Array.from(root.querySelectorAll('svg[data-marpit-svg]')).forEach((svg, i) => {
    const scale = fits[i];
    if (Number.isFinite(scale) && scale > 0 && scale < 1) setSlideScale(svg, scale);
  });
}

/**
 * How much taller than its box this slide's content is, in slide pixels.
 * Null means the slide is not laid out (a display:none thumbnail, a deck in a
 * hidden tab), where there is nothing to measure and nothing to conclude.
 */
function overflowOf(section) {
  const rect = section.getBoundingClientRect();
  const drawn = section.offsetHeight;
  if (!drawn || !rect.height) return null;
  // The slide is inside an <svg>, so what is on screen is some scale of the
  // layout pixels every other number here is in. Measure it rather than
  // assuming it: in a thumbnail the same slide is a twentieth of the size.
  const scale = rect.height / drawn;

  let top = Infinity;
  let bottom = -Infinity;
  for (const child of section.children) {
    const style = getComputedStyle(child);
    // Footers, headers and the page number are placed against the slide edge
    // and are not what pushes content off it.
    if (style.position === 'absolute' || style.position === 'fixed' || style.display === 'none') continue;
    const box = child.getBoundingClientRect();
    if (!box.width && !box.height) continue;
    top = Math.min(top, (box.top - rect.top) / scale);
    bottom = Math.max(bottom, (box.bottom - rect.top) / scale);
  }

  let need = section.scrollHeight;
  if (Number.isFinite(top)) {
    const style = getComputedStyle(section);
    const pad = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    // Two measures, because neither covers both kinds of slide on its own:
    // scrollHeight cannot see what a vertically centred slide (the theme's
    // `lead` and `big-idea` classes are flex-centred) pushes off the TOP, and
    // the extent of the children misses the last one's bottom margin.
    need = Math.max(need, (bottom - top) + pad);
  }
  return need - section.clientHeight;
}

/** Largest scale at which this slide's content fits its box. */
function fitOne(svg, section) {
  setSlideScale(svg, 1);
  let over = overflowOf(section);
  if (over === null) return null;
  if (over <= FIT_SLACK) return 1;

  // Growing the box also widens every line, so the first guess - grow it by
  // exactly the fraction the content overflows by - usually overshoots and
  // leaves the slide fitting with room to spare. Hence the refinement after.
  let scale = 1;
  let fails = 1;
  for (let i = 0; i < FIT_STEPS && over > FIT_SLACK && scale > FIT_MIN; i++) {
    const room = section.clientHeight;
    fails = scale;
    scale = Math.max(FIT_MIN, scale * room / (room + over));
    setSlideScale(svg, scale);
    over = overflowOf(section);
  }
  if (over > FIT_SLACK) return scale;  // as small as Podium is willing to go

  let fits = scale;
  for (let i = 0; i < FIT_REFINE && fails - fits > 0.005; i++) {
    const mid = (fits + fails) / 2;
    setSlideScale(svg, mid);
    if (overflowOf(section) <= FIT_SLACK) fits = mid; else fails = mid;
  }
  setSlideScale(svg, fits);
  return fits;
}

/** Webfonts and images change how tall text is, so measure after they land. */
async function contentSettled(root) {
  const waits = [];
  if (document.fonts?.ready) waits.push(document.fonts.ready);
  for (const img of root.querySelectorAll('img')) {
    if (img.complete) continue;
    waits.push(new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }));
  }
  if (!waits.length) return;
  // A lecture hall with no route to the font CDN must not hold the deck up: a
  // font that never arrives is measured in whatever face the box is using now.
  await Promise.race([
    Promise.all(waits),
    new Promise((resolve) => setTimeout(resolve, FIT_WAIT_MS)),
  ]);
}

/**
 * Measure every slide's fit once, in a hidden copy of the deck.
 *
 * It happens here, at render time, rather than in each place a deck is shown,
 * because measuring needs a laid-out slide and most of those places do not have
 * one: the thumbnail grid is built while its tab is closed, the PNG export
 * rasterizes slides that were never on screen, and the projector must not be
 * seen reflowing a slide it has already put up. One measurement, cached with
 * the deck, applied everywhere.
 */
async function measureFits(html, css) {
  if (typeof document === 'undefined' || !document.body) return [];
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  // Off-screen and invisible, but still laid out - `display: none` would make
  // every measurement below zero.
  host.style.cssText = 'position:fixed;left:-30000px;top:0;width:1280px;visibility:hidden;pointer-events:none;z-index:-1';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host { display: block; }
    svg[data-marpit-svg] { display: block; width: 1280px; height: auto; }
  </style><style>${css}</style>${html}`;
  document.body.append(host);
  try {
    await contentSettled(shadow);
    return Array.from(shadow.querySelectorAll('svg[data-marpit-svg]')).map((svg) => {
      const section = contentSection(svg);
      // `<!-- _class: nofit -->` on a slide (or `class: nofit` on the deck) is
      // the way to say "leave my slide alone, I meant it to be cropped".
      if (!section || section.classList.contains('nofit')) return 1;
      const scale = fitOne(svg, section);
      return Number.isFinite(scale) ? scale : 1;
    });
  } catch {
    return [];  // a deck that renders is worth showing even if fitting failed
  } finally {
    host.remove();
  }
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

  // Measured here, once, and carried with the deck: see measureFits.
  const fits = await measureFits(finalHtml, css);

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
    // One scale per slide: 1 for a slide that fits its box as authored, less
    // for one whose content would otherwise run off the bottom. Apply with
    // applyFits() wherever the deck's html is mounted.
    fits,
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
