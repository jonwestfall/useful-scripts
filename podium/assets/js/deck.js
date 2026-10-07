// Marp decks.
//
// Both the display and the controller render the same markdown with the same
// renderer, so the slide on the projector and the one in your preview are the
// same object, and the presenter notes on your iPad belong to the slide the
// class is actually looking at.
//
// The Marp bundle is ~1 MB and is only fetched the first time a deck is used;
// Mermaid's (for diagrams, see deck-mermaid.js) only by a deck with a diagram.

import { PODIUM_DIRECTIVES, MERMAID_DIRECTIVE, parseDeck, ASSET_REF } from './deck-source.js';
import { drawDiagrams, DIAGRAM_CSS } from './deck-mermaid.js';

// What an `asset:` picture this device has not been given is drawn as (Issue
// #226) - the same blank as assets.js's, rather than an address no browser
// can load. Whoever shows a deck swaps in the real ones first.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

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

export const MATH_CSS = `
  /* KaTeX math wrapping for Marp slides */
  div.marpit > svg > foreignObject > section .katex,
  section .katex {
    white-space: normal;
  }
  div.marpit > svg > foreignObject > section .katex > .katex-html,
  section .katex > .katex-html {
    white-space: normal;
  }
  div.marpit > svg > foreignObject > section .katex .base,
  section .katex .base {
    display: inline-block;
    white-space: nowrap;
    max-width: 100%;
  }
  div.marpit > svg > foreignObject > section .katex .text,
  section .katex .text {
    overflow-wrap: break-word;
  }
  div.marpit > svg > foreignObject > section .katex-display,
  section .katex-display {
    display: block;
    margin: 0.8em 0;
    max-width: 100%;
    text-align: center;
  }
  div.marpit > svg > foreignObject > section .katex-display > .katex,
  section .katex-display > .katex {
    display: block;
    text-align: center;
    white-space: normal !important;
  }
  div.marpit > svg > foreignObject > section .katex-display > .katex > .katex-html,
  section .katex-display > .katex > .katex-html {
    display: flex !important;
    flex-wrap: wrap !important;
    justify-content: center !important;
    align-items: baseline !important;
    max-width: 100% !important;
    white-space: normal !important;
    row-gap: 0.35em;
  }
  div.marpit > svg > foreignObject > section .katex-display.fleqn > .katex > .katex-html,
  section .katex-display.fleqn > .katex > .katex-html {
    justify-content: flex-start !important;
  }
`;

// The 1.1 MB bundle is the one big download a deck needs, and on a classroom
// iPad it can lose a race with a video streaming on the same Wi-Fi (Issue
// #221: "Importing a module script failed"). A browser then remembers that
// failure under the module's URL for the life of the page - WebKit does - so
// asking again under the same URL fails again without even trying. The retry
// asks under a fresh one; the service worker answers either from its cache.
async function importMarp() {
  try {
    return await import(/* @vite-ignore */ MARP_URL);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return import(/* @vite-ignore */ `${MARP_URL}?retry=${Date.now()}`);
  }
}

async function loadEngine() {
  const { Marp, browser } = await importMarp();

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

// A failed load is not kept (Issue #221): it used to be, so one bad download
// left every deck saying "could not render" until the page was reloaded, however
// many times it was picked again. The next call simply tries again; whatever
// retries on its own (a re-render on every state broadcast) spaces itself out -
// see DECK_RETRY_MS in control.js and the deck renderer in renderers.js.
function engine() {
  enginePromise ??= loadEngine().catch((err) => {
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

/**
 * Teach a Marp instance the mermaidTheme directive (Issue #235). Marp works
 * out which slides it reaches - the whole deck, from a slide on, one slide -
 * and each one's <section> is marked data-mermaid-theme for deck-mermaid.js
 * to read. (Marpit only writes a data- attribute itself for directives it
 * knew of when it was made, hence the rule.)
 */
export function markMermaidTheme(marp) {
  marp.customDirectives.local[MERMAID_DIRECTIVE] = (value) => ({ [MERMAID_DIRECTIVE]: value });
  marp.use((md) => {
    md.core.ruler.after('marpit_directives_apply', 'podium_mermaid_theme', (state) => {
      for (const token of state.tokens) {
        const value = token.type === 'marpit_slide_open' && token.meta?.marpitDirectives?.[MERMAID_DIRECTIVE];
        if (value) token.attrSet('data-mermaid-theme', String(value));
      }
    });
  });
  return marp;
}

// A fresh Marp instance per render: themeSet and directive state are stateful,
// and one deck's front matter should never leak into the next.
async function createMarp() {
  const { Marp, themeCss } = await engine();
  const marp = new Marp({ inlineSVG: true, html: HTML_ALLOWLIST, math: 'katex' });
  // Podium's own directives (a video slide, Issue #226): known to Marp so the
  // comment holding one is a directive rather than a presenter note. They
  // change nothing Marp draws - render() reads them back out below.
  for (const key of PODIUM_DIRECTIVES) marp.customDirectives.local[key] = () => ({});
  markMermaidTheme(marp);
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

/**
 * The id of a deck that lives at an address (the server library, content/decks):
 * the address plus a hash of what it holds right now (Issue #226). The deck
 * editor can change what is at an address, and every cache keyed by a deck id -
 * the renders here, each device's deckStore, the ink surfaces - must then see
 * a different deck, not a stale copy of the old one. Unchanged text keeps the
 * same id, so ink drawn on it earlier in a lecture is still there.
 */
export async function srcDeckId(src, source) {
  return `src:${src}#v=${await deckId(source)}`;
}

/**
 * Where a deck at this address lives on the server, so whatever offers to
 * edit it can save it back to the same place:
 *   {kind: 'library', id}   a library deck's stable address
 *   {kind: 'version', sha}  a library file by its content address - an older
 *                           way to point at a library deck, still in plans
 *                           and manifests made before the deck editor
 *   {kind: 'content', name} content/decks/<name>, with or without a leading /
 *   {kind: 'other'}         anything else: a file, another site
 */
export function deckLocation(src) {
  let path = String(src || '').trim().split(/[?#]/)[0];
  const here = typeof location === 'object' ? location.origin : '';
  if (here && path.startsWith(here)) path = path.slice(here.length);
  let m;
  if ((m = /^\/media\/deck\/(\d+)\//.exec(path))) return { kind: 'library', id: m[1] };
  if ((m = /^\/media\/([0-9a-f]{64})\/[^/]+\.(?:md|markdown)$/i.exec(path))) return { kind: 'version', sha: m[1].toLowerCase() };
  if ((m = /^\/?content\/decks\/([^/]+\.(?:md|markdown))$/i.exec(path))) {
    try { return { kind: 'content', name: decodeURIComponent(m[1]) }; } catch { return { kind: 'content', name: m[1] }; }
  }
  return { kind: 'other' };
}

/** The address inside a srcDeckId (or an older plain `src:` id), or null. */
export function srcOfDeckId(id) {
  const text = String(id || '');
  if (!text.startsWith('src:')) return null;
  const rest = text.slice(4);
  const at = rest.lastIndexOf('#v=');
  return at === -1 ? rest : rest.slice(0, at);
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
  const scale = rect.height / drawn;

  let top = Infinity;
  let bottom = -Infinity;
  let left = Infinity;
  let right = -Infinity;
  for (const child of section.children) {
    const style = getComputedStyle(child);
    // Footers, headers and the page number are placed against the slide edge
    // and are not what pushes content off it.
    if (style.position === 'absolute' || style.position === 'fixed' || style.display === 'none') continue;
    const box = child.getBoundingClientRect();
    if (!box.width && !box.height) continue;
    top = Math.min(top, (box.top - rect.top) / scale);
    bottom = Math.max(bottom, (box.bottom - rect.top) / scale);
    left = Math.min(left, (box.left - rect.left) / scale);
    right = Math.max(right, (box.right - rect.left) / scale);
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
  const overV = need - section.clientHeight;

  let overH = 0;
  if (Number.isFinite(left) && Number.isFinite(right) && section.clientWidth > 0) {
    const style = getComputedStyle(section);
    const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const needW = Math.max(section.scrollWidth, (right - left) + padX);
    if (needW > section.clientWidth) {
      // Slide viewBox scales uniformly (both w and h by 1/scale).
      // Translate horizontal overflow into equivalent vertical overflow:
      overH = (needW - section.clientWidth) * (section.clientHeight / section.clientWidth);
    }
  }

  return Math.max(overV, overH);
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
  let polyfill;
  try {
    // Same polyfill applyFits' real callers apply before ever measuring
    // anything (see renderDeck in renderers.js) - without it, Safari lays
    // foreignObject content out by its own, more permissive rules, so a
    // scale measured here against THAT layout can be too generous once the
    // real render corrects it with this same polyfill afterward: text that
    // fit the unfixed measurement overflows, silently, past wherever it is
    // that clips a slide's box. Chrome never needed the polyfill in the
    // first place, so this mismatch is invisible there - which is exactly
    // why it reads as "the iPad cuts this off and the projector does not."
    polyfill = await applyPolyfill(shadow);
    // applyPolyfill's own promise resolves once it has registered its
    // Safari-detection check and started an ongoing requestAnimationFrame
    // loop, not once that check has actually run and corrected anything -
    // the correction itself lands a frame or two later, asynchronously.
    // Two frames is what it takes to be safely on the other side of that,
    // the same margin any "wait for an observer's first pass" needs.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
    // The polyfill's own correction loop runs on requestAnimationFrame for
    // as long as it thinks there is a target worth correcting - it has no
    // idea this host is about to be thrown away, so left running it is one
    // more rAF callback forever, per deck ever measured. cleanup() is its
    // own way of saying "stop".
    polyfill?.cleanup?.();
    host.remove();
  }
}

const cache = new Map();

/**
 * Drop one render from the cache. Everywhere else a deck is rendered a few
 * times a lecture and keeping them is the point; the deck editor (Issue #226)
 * renders a new version every time typing pauses, and lets go of the last.
 */
export function forgetDeck(id) {
  cache.delete(id);
}

/**
 * Each slide's own <section>, one per slide. Not every section in the deck: a
 * slide with a `![bg …]` picture is drawn as three (Marp's "advanced
 * backgrounds" - the picture, the content, and a pseudo layer for
 * pagination), and counting those as slides gave such a deck extra slides,
 * shifted every later slide's title and build, and lost the end of the deck.
 */
function slideSections(root) {
  return Array.from(root.querySelectorAll('svg[data-marpit-svg]'))
    .map((svg) => contentSection(svg) || svg.querySelector('section'))
    .filter(Boolean);
}

export function parseSections(root) {
  const sections = [];
  slideSections(root).forEach((section, i) => {
    const heading = section.querySelector('h1, h2');
    if (heading) {
      const text = (heading.textContent || '').trim().replace(/\s+/g, ' ');
      if (text) {
        sections.push({
          title: text.slice(0, 60),
          slideIndex: i,
          level: heading.tagName.toLowerCase() === 'h1' ? 1 : 2,
        });
      }
    }
  });
  return sections;
}

function outline(root) {
  return slideSections(root).map((section, i) => {
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
  // Per slide, for the planning page (Issue #177): the slide's own classes
  // and how its build was found, so a presenter can check the directive did
  // what they meant before class rather than in front of it.
  const builds = [];
  slideSections(root).forEach((section) => {
    const explicit = Array.from(section.querySelectorAll('.build, [data-build]'));
    const buildClass = section.classList.contains('build');
    // Auto-build: opting a slide in without hand-marking anything treats each
    // top-level bullet as one step, which is what most decks actually want.
    const candidates = explicit.length
      ? explicit
      : (buildClass ? Array.from(section.querySelectorAll('li')) : []);
    candidates.forEach((node, i) => {
      node.classList.add('podium-fragment');
      node.dataset.podiumFragment = String(i + 1);
    });
    fragments.push(candidates.length);
    builds.push({
      classes: Array.from(section.classList),
      mode: explicit.length ? 'marked' : buildClass ? (candidates.length ? 'bullets' : 'empty') : '',
      steps: candidates.length,
    });
  });
  return { fragments, builds };
}

// True when `a` is `b`, or one insertion, deletion, substitution or swap of
// two neighbouring letters away from it - "Build", "bulid", "builds", "buld".
function oneEditFrom(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (x, y) => a.slice(x) === b.slice(y);
  return rest(i + 1, i + 1) || rest(i + 1, i) || rest(i, i + 1)
    || (a[i] === b[i + 1] && a[i + 1] === b[i] && rest(i + 2, i + 2));
}

/**
 * One slide's build, in words, for the planning page's preview (Issue #177).
 * `build` is one entry of render()'s `builds`. Returns { text, warn } - warn
 * when the slide looks like it was meant to build and will not.
 */
export function describeBuild(build) {
  if (!build) return { text: '', warn: false };
  const n = build.steps;
  const steps = `${n} step${n === 1 ? '' : 's'}, one per Next`;
  if (build.mode === 'bullets') return { text: `Builds its bullets one at a time (_class: build) - ${steps}.`, warn: false };
  if (build.mode === 'marked') return { text: `Builds the parts marked class="build" - ${steps}.`, warn: false };
  if (build.mode === 'empty') {
    return {
      text: 'Has _class: build but nothing to reveal: a build reveals list bullets, or elements marked class="build".',
      warn: true,
    };
  }
  // Classes are case-sensitive, and Marp takes any name without complaint.
  const nearMiss = (build.classes || []).find((c) => c !== 'build' && oneEditFrom(c.toLowerCase(), 'build'));
  if (nearMiss) return { text: `Has the class "${nearMiss}", which is not a build - it has to be exactly _class: build.`, warn: true };
  return { text: 'No build - everything on this slide appears at once. Add <!-- _class: build --> after its --- to reveal bullets one at a time.', warn: false };
}

/**
 * Render markdown into slides. Cached by content, so flipping back and forth
 * between decks does not re-parse anything.
 */
export async function render(source, id) {
  const key = id || await deckId(source);
  if (cache.has(key)) return cache.get(key);

  const marp = await createMarp();
  const { html, css, comments } = marp.render(source.includes('asset:') ? source.replace(ASSET_REF, BLANK) : source);

  // Parse once, mutate in place to mark fragments, then re-serialize. Marp's
  // html is one wrapping <div class="marpit"> holding every slide's <svg>.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.querySelector('.marpit') || doc.body;
  const combinedCss = `${css}\n${MATH_CSS}\n${DIAGRAM_CSS}`;
  // ```mermaid blocks drawn as diagrams (Issue #235), first: they change
  // what fits, and a slide's title is never a diagram's source text.
  const diagrams = await drawDiagrams(root, combinedCss, slideSections);
  const { fragments, builds } = markFragments(root);
  const titles = outline(root);
  const sections = parseSections(root);
  // The aspect ratio baked into each slide's own SVG viewBox - read once here
  // so the controller can shape its ink pad to match a slide exactly without
  // touching the DOM itself.
  const aspects = Array.from(root.querySelectorAll('svg[data-marpit-svg]')).map((svg) => {
    const box = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
    return box.length === 4 && box[2] > 0 && box[3] > 0 ? box[2] / box[3] : 16 / 9;
  });
  // Strip single-line auto-scaling attributes from math blocks so equations
  // wrap naturally rather than attempting to scale on a single line.
  root.querySelectorAll('.katex-display[is="marp-span"], .katex-display[data-auto-scaling]').forEach((node) => {
    node.removeAttribute('is');
    node.removeAttribute('data-auto-scaling');
  });

  const finalHtml = root.outerHTML;

  // Measured here, once, and carried with the deck: see measureFits.
  const fits = await measureFits(finalHtml, combinedCss);

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
    css: combinedCss,
    theme: wanted && marp.themeSet.has(wanted) ? wanted : 'default',
    themeWarning,
    // Marpit hands back one array of comments per slide; directive comments
    // like `<!-- _class: lead -->` are consumed as directives and never appear
    // here, so what is left is genuinely presenter notes.
    notes: comments.map((list) => (list || []).join('\n\n').trim()),
    titles,
    sections,
    fragments,
    builds,
    aspects,
    // One scale per slide: 1 for a slide that fits its box as authored, less
    // for one whose content would otherwise run off the bottom. Apply with
    // applyFits() wherever the deck's html is mounted.
    fits,
    count: titles.length,
    // A video slide's video, or null, per slide (Issue #226). Read from the
    // markdown, whose slides are Marp's slides (see deck-source.js) - except
    // in a headingDivider deck, which splits where the markdown does not say,
    // so has none.
    videos: videosOf(source, titles.length),
    // Each ```mermaid block (Issue #235): its slide, which one on that slide,
    // the theme it was drawn in, and why it could not be drawn if it was not.
    diagrams,
  };
  // A deck drawn while the diagram bundle would not load is shown with that
  // said where each diagram goes, but not kept: the next render tries again.
  if (!diagrams.some((d) => d.error?.retry)) cache.set(key, result);
  return result;
}

function videosOf(source, count) {
  const deck = parseDeck(source);
  if (deck.headingDivider || deck.slides.length !== count) return Array(count).fill(null);
  return deck.slides.map((slide) => slide.video);
}

/** The slides of a rendered deck that are video slides, by index. */
export function videoSlides(deck) {
  return (deck?.videos || []).flatMap((video, i) => (video ? [i] : []));
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
