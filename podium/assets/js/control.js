// The controller: iPad in your hand, iPhone in your pocket. Both can be
// connected at once and stay in step, because neither holds any state - they
// send commands and render whatever the display echoes back.

import { $, $$, el, uid, fmtTime, guessItemFromUrl, throttle, wireDangerButton } from './util.js';
import { loadConfig, saveConfig, isConfigured, resetDevice, reloadClean, DEFAULTS } from './config.js';
import { createBus } from './bus.js';
import { initialState, timerRemaining } from './protocol.js';
import { createRenderer, itemTitle, TYPES } from './renderers.js';
import { createCameraSender } from './rtc.js';
import { render as renderDeckSource, deckId, frontMatterTitle, themeReport } from './deck.js';
import { createZip } from './zip.js';

const LIB_KEY = 'podium.library.v1';

let cfg = await loadConfig();
let bus = null;
let state = initialState();
let telemetry = { time: 0, duration: 0, playing: false };
let telemetryAt = Date.now();
let previewRenderer = null;
let previewKey = null;
let scrubbing = false;

const send = (cmd) => bus?.send({ t: 'cmd', ...cmd });

// Decks this controller holds the markdown for. An uploaded deck lives only
// here and on whichever display asked for it; a deck with a src is fetched
// from the server by both ends independently.
const MAX_DECK_BYTES = 120 * 1024;
const deckStore = new Map();
const deckFetches = new Map();
let deckView = { id: null, deck: null };
let deckGeneration = 0;

// Requesting a deck's saved ink for export: the display holds the only full
// copy, keyed by deck+slide, so exporting asks for it rather than trying to
// have reconstructed it locally from the lightweight "current slide only"
// stream that keeps the pad in sync during a normal lecture.
const inkExportWaiters = new Map();
function requestInkData(targetDeckId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { inkExportWaiters.delete(targetDeckId); resolve({}); }, timeoutMs);
    inkExportWaiters.set(targetDeckId, (bySlide) => { clearTimeout(timer); resolve(bySlide); });
    bus?.send({ t: 'ink-need', deckId: targetDeckId });
  });
}

function getDeckSource(item) {
  if (!item?.deckId) return null;
  if (deckStore.has(item.deckId)) return deckStore.get(item.deckId);
  if (!item.src) return null;
  if (!deckFetches.has(item.deckId)) {
    deckFetches.set(item.deckId, fetch(item.src, { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`${item.src} — HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => { deckStore.set(item.deckId, text); return text; }));
  }
  return deckFetches.get(item.deckId);
}

async function stageDeck({ source, name, src }) {
  const id = src ? `src:${src}` : await deckId(source);
  deckStore.set(id, source);
  const deck = await renderDeckSource(source, id);
  // Hand it to the display up front rather than making it ask.
  if (!src) bus?.send({ t: 'deck', id, source });
  stage({
    type: 'deck',
    title: frontMatterTitle(source, name || 'Deck'),
    deckId: id,
    src,
    slide: 0,
    step: 0,
    slideCount: deck.count,
    fragments: deck.fragments,
  });
  return deck;
}

// --- library ----------------------------------------------------------------

const BUILT_INS = [
  { title: 'Black', type: 'black' },
  { title: 'Whiteboard', type: 'whiteboard', bg: '#f7f5ef' },
  { title: 'Chalkboard', type: 'whiteboard', bg: '#12261f' },
  { title: 'Phone camera', type: 'camera' },
  { title: 'Timer', type: 'timer' },
];

let library = [];

function loadCustom() {
  try { return JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); } catch { return []; }
}

function saveCustom(items) {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(items)); } catch { /* private mode */ }
}

async function loadLibrary() {
  let fromFile = [];
  try {
    const res = await fetch(cfg.manifest, { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      fromFile = (Array.isArray(data) ? data : data.items || []).filter((i) => i && i.type);
    }
  } catch { /* no manifest committed yet - built-ins and pasted links still work */ }
  library = [
    ...BUILT_INS.map((i) => ({ ...i, group: 'Quick' })),
    ...fromFile.map((i) => ({ ...i, group: i.group || 'Library' })),
    ...loadCustom().map((i) => ({ ...i, group: 'Saved', custom: true })),
  ];
  renderLibrary();
}

function renderLibrary() {
  const filter = $('#lib-filter').value.trim().toLowerCase();
  const grid = $('#library');
  grid.replaceChildren();
  const groups = new Map();
  for (const item of library) {
    if (filter && !`${item.title} ${item.type}`.toLowerCase().includes(filter)) continue;
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  for (const [name, items] of groups) {
    grid.append(el('h3', { class: 'group' }, name));
    const row = el('div', { class: 'tiles' });
    for (const item of items) {
      const tile = el('button', {
        class: 'tile',
        type: 'button',
        onclick: () => pick(item),
      },
        el('span', { class: 'tile-icon' }, TYPES[item.type]?.icon || '?'),
        el('span', { class: 'tile-title' }, item.title || TYPES[item.type]?.label || item.type),
        el('span', { class: 'tile-type' }, TYPES[item.type]?.label || item.type));
      if (item.custom) {
        tile.append(el('span', {
          class: 'tile-del',
          title: 'Remove from saved',
          onclick: (ev) => {
            ev.stopPropagation();
            saveCustom(loadCustom().filter((i) => i.title !== item.title || i.src !== item.src));
            loadLibrary();
          },
        }, '×'));
      }
      row.append(tile);
    }
    grid.append(row);
  }
  if (!grid.children.length) grid.append(el('p', { class: 'empty' }, 'Nothing matches.'));
}

function stage(item, where = 'auto') {
  // group/custom are library bookkeeping; the display has no use for them.
  const { group: _group, custom: _custom, ...clean } = item;
  send({ op: 'stage', item: clean, where });
}

// A deck picked from the library needs fetching and counting before it can be
// staged, so library clicks go through here. Camera is similar: the "Phone
// camera" tile in the library used to just stage the type without ever
// requesting the camera or opening the WebRTC connection, which left the
// display saying "waiting" forever - picking it now actually starts the feed,
// the same as the button on the Camera tab.
async function pick(item, where = 'auto') {
  if (item.type === 'camera') { await startCamera(where); return; }
  if (item.type !== 'deck' || item.slideCount) { stage(item, where); return; }
  const note = $('#deck-file-note');
  note.textContent = `Loading ${item.title || 'deck'}…`;
  try {
    const source = await getDeckSource({ deckId: `src:${item.src}`, src: item.src });
    await stageDeck({ source, name: item.title, src: item.src });
    note.textContent = '';
  } catch (err) {
    note.textContent = `Could not open that deck: ${err.message}`;
  }
}

// --- preview pane -----------------------------------------------------------

function renderPreview() {
  const item = state.preview || state.program;
  const holder = $('#preview-stage');
  const key = item?.key || null;

  if (key !== previewKey) {
    previewRenderer?.destroy();
    previewRenderer = null;
    holder.replaceChildren();
    previewKey = key;
    if (item) {
      previewRenderer = createRenderer(item, { preview: true, getTimer: () => state.timer, getDeckSource });
      holder.append(previewRenderer.el);
    }
  } else if (previewRenderer && item) {
    previewRenderer.update(item);
    previewRenderer.reconcile({ ...item, playing: false }, { volume: 0, muted: true });
  }

  $('#preview-label').textContent = state.preview ? 'Cued' : 'On screen';
  $('#preview-title').textContent = itemTitle(item);
  $('#preview-pane').classList.toggle('is-cued', !!state.preview);
}

// --- Marp deck panel --------------------------------------------------------

let gridShadow = null;
let gridDeckId = null;

function ensureGridShadow() {
  gridShadow ??= $('#deck-grid').attachShadow({ mode: 'open' });
  return gridShadow;
}

function buildGrid(deck) {
  const shadow = ensureGridShadow();
  shadow.innerHTML = `<style>
    :host { display: block; }
    #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
    .cell {
      position: relative; aspect-ratio: 16 / 9; overflow: hidden; cursor: pointer;
      background: #fff; border: 2px solid #2a3038; border-radius: 8px; padding: 0;
    }
    .cell.on { border-color: #6ea8fe; }
    /* Marpit scopes its slide CSS to div.marpit > svg > foreignObject > section,
       so each thumbnail keeps that wrapper or the slide loses all its sizing. */
    .cell .marpit { position: absolute; inset: 0; }
    .cell svg { display: block; width: 100%; height: 100%; }
    /* A thumbnail (and an export) shows a slide as finished, not bullet by
       bullet - the opposite of the live build, which starts with nothing
       revealed. Podium never ships a rule that hides .podium-fragment here,
       so this simply confirms that intent rather than leaning on the absence. */
    .podium-fragment { opacity: 1 !important; }
    .num {
      position: absolute; right: 3px; bottom: 3px; padding: 0 5px; border-radius: 4px;
      background: rgba(0,0,0,.65); color: #fff; font: 600 11px/1.6 system-ui, sans-serif;
    }
  </style><style>${deck.css}</style><div id="grid"></div>`;

  const holder = document.createElement('div');
  holder.innerHTML = deck.html;
  const grid = shadow.getElementById('grid');
  Array.from(holder.querySelectorAll('svg[data-marpit-svg]')).forEach((svg, i) => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.dataset.index = String(i);
    cell.title = deck.titles[i] || `Slide ${i + 1}`;
    const marpit = document.createElement('div');
    marpit.className = 'marpit';
    marpit.append(svg);
    cell.append(marpit);
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    cell.append(num);
    cell.addEventListener('click', () => send({ op: 'nav', dir: 'goto', value: i }));
    grid.append(cell);
  });
  gridDeckId = deck.id;
}

function highlightGrid(index) {
  if (!gridShadow) return;
  gridShadow.querySelectorAll('.cell').forEach((cell) => {
    cell.classList.toggle('on', Number(cell.dataset.index) === index);
  });
}

async function ensureDeckView(item) {
  if (!item || item.type !== 'deck') { deckView = { id: null, deck: null }; return; }
  if (deckView.id === item.deckId) return;
  const mine = ++deckGeneration;
  let source;
  try {
    source = await getDeckSource(item);
  } catch {
    source = null;
  }
  if (source == null || mine !== deckGeneration) return;
  try {
    const deck = await renderDeckSource(source, item.deckId);
    if (mine !== deckGeneration) return;
    deckView = { id: item.deckId, deck };
    renderSlides();
  } catch (err) {
    $('#deck-notes').textContent = `Marp could not render this deck: ${err.message}`;
  }
}

function renderSlides() {
  const item = state.program?.type === 'deck' ? state.program : null;
  $('#deck-none').hidden = !!item;
  $('#deck-live').hidden = !item;
  if (!item) return;

  $('#deck-title').textContent = itemTitle(item);
  const deck = deckView.id === item.deckId ? deckView.deck : null;
  const total = deck?.count || item.slideCount || 1;
  const index = Math.min(total - 1, Math.max(0, item.slide || 0));
  const step = item.step || 0;
  const fragCount = (item.fragments && item.fragments[index]) || 0;
  $('#deck-count').textContent = fragCount
    ? `Slide ${index + 1} / ${total} · build ${step}/${fragCount}`
    : `Slide ${index + 1} / ${total}`;
  // A slide mid-build still has Next/Previous left to do even at slide 0 or
  // the very last slide, so the ends of a build - not just of the deck -
  // decide when the buttons actually go grey.
  $('#deck-prev').disabled = index === 0 && step === 0;
  $('#deck-next').disabled = index >= total - 1 && step >= fragCount;

  const notesEl = $('#deck-notes');
  if (!deck) {
    notesEl.textContent = 'Loading deck…';
    notesEl.classList.add('is-empty');
  } else {
    const note = deck.notes[index] || '';
    notesEl.textContent = note || 'No notes on this slide.';
    notesEl.classList.toggle('is-empty', !note);
  }

  const upcoming = deck?.titles?.[index + 1];
  $('#deck-next-up').textContent = upcoming ? `${index + 2}. ${upcoming}` : 'End of deck.';

  const problems = [deck?.themeWarning, ...themeReport.failed].filter(Boolean);
  const themeEl = $('#deck-theme');
  themeEl.textContent = problems.length ? problems[0] : (deck ? `theme: ${deck.theme}` : 'Rendering…');
  themeEl.classList.toggle('is-warning', problems.length > 0);

  if (deck && gridDeckId !== deck.id) buildGrid(deck);
  highlightGrid(index);
  $('#deck-export').disabled = !deck;
}

// --- exporting marked-up slides ----------------------------------------------
//
// Rasterizes each slide (already laid out in the thumbnail grid, so fonts and
// layout are exactly as shown) to a PNG, draws that slide's saved ink on top,
// and hands the class a .zip. Best-effort: a remote font or a cross-origin
// image the browser refuses to bake into a canvas fails that ONE slide with a
// clear reason rather than aborting the whole export.

const RASTER_HEIGHT = 1080;

async function rasterizeSlide(svgLive, css, aspect, strokes) {
  const w = Math.round(RASTER_HEIGHT * aspect);
  const h = RASTER_HEIGHT;

  const clone = svgLive.cloneNode(true);
  clone.classList.remove('podium-on');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const box = (clone.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
  if (box.length === 4) { clone.setAttribute('width', String(box[2])); clone.setAttribute('height', String(box[3])); }
  // The theme's CSS lives on a sibling <style> in the grid's shadow root; a
  // standalone SVG document has no access to that, so it travels inside the
  // clone instead.
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = css;
  clone.insertBefore(style, clone.firstChild);
  clone.querySelectorAll('.podium-fragment').forEach((n) => n.classList.add('is-shown'));

  const xml = new XMLSerializer().serializeToString(clone);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;

  const img = new Image();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out (a remote font or image may be blocking it)')), 8000);
    img.onload = () => { clearTimeout(timer); resolve(); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('the browser could not rasterize this slide')); };
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  // Stroke widths were chosen by eye against the pad at whatever size it
  // happened to be on screen; scale them against a nominal 1280px-wide slide
  // so a export at any resolution still looks like the same pen.
  const widthScale = w / 1280;
  for (const stroke of strokes) {
    if (!stroke.pts || stroke.pts.length < 2) continue;
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(1, stroke.width * widthScale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(stroke.pts[0][0] * w, stroke.pts[0][1] * h);
    for (let i = 1; i < stroke.pts.length; i++) ctx.lineTo(stroke.pts[i][0] * w, stroke.pts[i][1] * h);
    ctx.stroke();
  }

  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas export was blocked (likely a cross-origin image in this deck)'))), 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

async function exportDeck() {
  const item = state.program;
  if (!item || item.type !== 'deck') return;
  const btn = $('#deck-export');
  const status = $('#deck-export-status');
  btn.disabled = true;
  try {
    status.textContent = 'Preparing…';
    let deck = deckView.id === item.deckId ? deckView.deck : null;
    if (!deck) {
      const source = await getDeckSource(item);
      if (source == null) throw new Error('This deck’s markdown is not available on this device.');
      deck = await renderDeckSource(source, item.deckId);
    }
    if (gridDeckId !== deck.id) buildGrid(deck);
    const svgs = Array.from(ensureGridShadow().querySelectorAll('.cell svg[data-marpit-svg]'));
    if (!svgs.length) throw new Error('This deck has no slides to export.');

    status.textContent = 'Asking the display for saved ink…';
    const bySlide = await requestInkData(item.deckId);

    const files = [];
    const failures = [];
    for (let i = 0; i < svgs.length; i++) {
      status.textContent = `Rendering slide ${i + 1} of ${svgs.length}…`;
      try {
        const png = await rasterizeSlide(svgs[i], deck.css, deck.aspects[i] || 16 / 9, bySlide[i] || []);
        files.push({ name: `slide-${String(i + 1).padStart(2, '0')}.png`, data: png });
      } catch (err) {
        failures.push(`slide ${i + 1} (${err.message})`);
      }
    }
    if (!files.length) throw new Error(`Could not render any slide - ${failures[0] || 'unknown error'}.`);

    const manifest = deck.titles
      .map((t, i) => `${i + 1}. ${t}${bySlide[i]?.length ? '  [annotated]' : ''}`)
      .concat(failures.length ? ['', 'Skipped:', ...failures.map((f) => `- ${f}`)] : [])
      .join('\n');
    files.push({ name: 'slides.txt', data: new TextEncoder().encode(manifest) });

    status.textContent = 'Building the zip…';
    const zipBlob = await createZip(files);
    const safeTitle = (item.title || 'deck').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'deck';

    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipBlob);
    a.download = `${safeTitle}-annotated.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);

    status.textContent = failures.length
      ? `Saved with ${failures.length} slide${failures.length > 1 ? 's' : ''} skipped - see slides.txt.`
      : `Saved ${files.length - 1} slides.`;
  } catch (err) {
    status.textContent = `Export failed: ${err.message}`;
  } finally {
    btn.disabled = !(deckView.deck && state.program?.type === 'deck');
  }
}

// --- transport / now playing ------------------------------------------------

function currentTime() {
  if (scrubbing) return Number($('#scrub').value);
  if (!telemetry.playing) return telemetry.time;
  return telemetry.time + (Date.now() - telemetryAt) / 1000;
}

function renderNow() {
  const item = state.program;
  const type = item?.type;
  const isMedia = ['video', 'audio', 'youtube'].includes(type);
  const isPaged = ['pdf', 'slides', 'web', 'deck'].includes(type);

  $('#now-title').textContent = itemTitle(item);
  $('#now-type').textContent = TYPES[type]?.label || type || '';
  $('#transport').hidden = !isMedia;
  $('#paging').hidden = !isPaged;
  // Pause is the thing you reach for mid-sentence, so it also lives on the bar
  // that is visible from every tab.
  $('#bar-play').hidden = !isMedia;
  $('#bar-play').textContent = telemetry.playing ? '⏸' : '▶';
  $('#page-label').textContent = type === 'pdf'
    ? `Page ${item.page || 1}`
    : (type === 'deck' ? `Slide ${(item.slide || 0) + 1} / ${item.slideCount || 1}` : 'Slide');

  if (isMedia) {
    const t = currentTime();
    const d = telemetry.duration || 0;
    $('#play-pause').textContent = telemetry.playing ? '⏸' : '▶';
    $('#time-now').textContent = fmtTime(t);
    $('#time-total').textContent = d ? fmtTime(d) : '--:--';
    const scrub = $('#scrub');
    scrub.max = d || 0;
    scrub.disabled = !d;
    if (!scrubbing) scrub.value = Math.min(t, d || t);
  }

  $('#freeze').classList.toggle('is-on', state.frozen);
  $('#freeze').textContent = state.frozen ? 'Frozen' : 'Freeze';
  $('#blank').classList.toggle('is-on', state.blank);
  $('#take').disabled = !state.preview;
  $('#take').classList.toggle('is-armed', !!state.preview);
  $('#swap').disabled = !state.preview;
  $('#clear-preview').disabled = !state.preview;
  $('#preview-mode').classList.toggle('is-on', state.previewMode);
  $('#mute').classList.toggle('is-on', state.muted);
  $('#mute').textContent = state.muted ? '\u{1F507}' : '\u{1F50A}';
  if (document.activeElement !== $('#volume')) $('#volume').value = state.volume;

  document.body.classList.toggle('is-frozen', state.frozen);
}

function renderTimer() {
  const ms = timerRemaining(state.timer);
  $('#timer-readout').textContent = fmtTime(Math.ceil(ms / 1000));
  $('#timer-readout').classList.toggle('is-urgent', state.timer.running && ms <= 30000);
  $('#timer-start').textContent = state.timer.running ? 'Pause' : (state.timer.remainingMs > 0 ? 'Resume' : 'Start');
}

function renderAll() {
  renderPreview();
  renderNow();
  renderTimer();
  renderSlides();
  ensureDeckView(state.program);
}

// --- ink pad ----------------------------------------------------------------
//
// The pad's drawable area is shaped to match the actual content (a deck
// slide's own aspect ratio, or the display's window shape for full-bleed
// content like a whiteboard) rather than a fixed 16:9 guess. Coordinates
// captured on it are fractions (0..1) of that shape, exactly what the display
// expects, so the whole pad IS the drawable slide - there is no dead margin
// to accidentally draw into. Zoom is a pure CSS transform on #pad-frame; the
// canvas's own pixel grid never changes, so pointer capture (which reads the
// canvas's on-screen, post-transform box) stays correct at any zoom level
// with no extra coordinate math.

const padViewport = $('#pad-viewport');
const padFrame = $('#pad-frame');
const pad = $('#pad');
const padCtx = pad.getContext('2d');
const ink = { drawing: false, strokeId: null, buffer: [], penOnly: false, color: '#ffd166', width: 6, strokes: [] };
let inkSurface = null;
let zoom = 1;
let panX = 0;
let panY = 0;
// The frame's own (unscaled) box, in viewport pixels - CSS `aspect-ratio`
// cannot win against the `inset: 0` an absolutely-positioned element would
// otherwise need, so it is fit and centered here instead, the same
// "contain" math the display uses to letterbox a slide.
let frameW = 0;
let frameH = 0;

const ZOOM_MAX = 4;
const ZOOM_STEP = 1.6;

function computeContentAspect() {
  const item = state.program;
  if (item?.type === 'deck' && deckView.id === item.deckId && deckView.deck?.aspects?.length) {
    const idx = Math.min(deckView.deck.aspects.length - 1, Math.max(0, item.slide || 0));
    return deckView.deck.aspects[idx] || 16 / 9;
  }
  return state.stageAspect || 16 / 9;
}

function fitFrame() {
  const vp = padViewport.getBoundingClientRect();
  if (!vp.width || !vp.height) return;
  const aspect = computeContentAspect();
  let w = vp.width;
  let h = w / aspect;
  if (h > vp.height) { h = vp.height; w = h * aspect; }
  frameW = w;
  frameH = h;
  padFrame.style.width = `${w}px`;
  padFrame.style.height = `${h}px`;
  padFrame.style.left = `${(vp.width - w) / 2}px`;
  padFrame.style.top = `${(vp.height - h) / 2}px`;
}

function applyPadTransform() {
  padFrame.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
}

function clampPan() {
  // transform-origin is the frame's own top-left corner, so it only ever
  // grows down and to the right as it scales; panning just brings that
  // excess back into view, never past either edge.
  const maxX = frameW * (zoom - 1);
  const maxY = frameH * (zoom - 1);
  panX = Math.min(0, Math.max(-maxX, panX));
  panY = Math.min(0, Math.max(-maxY, panY));
}

function setZoom(next) {
  // transform-origin is the frame's top-left, so changing scale with the pan
  // left untouched drifts whatever was in view down and to the right - after
  // a couple of taps the visible middle of the slide has scrolled off into
  // the clipped area. Re-aim the pan so the point currently at the viewport's
  // center stays there, the same anchor a pinch gesture would use.
  const vp = padViewport.getBoundingClientRect();
  const cx = vp.width / 2;
  const cy = vp.height / 2;
  const localX = (cx - panX) / zoom;
  const localY = (cy - panY) / zoom;
  zoom = Math.min(ZOOM_MAX, Math.max(1, next));
  if (zoom === 1) { panX = 0; panY = 0; }
  else { panX = cx - localX * zoom; panY = cy - localY * zoom; }
  clampPan();
  applyPadTransform();
  $('#ink-zoom-level').textContent = `${zoom.toFixed(zoom % 1 ? 1 : 0)}×`;
  $$('.pan-btn').forEach((b) => { b.disabled = zoom === 1; });
}

function pan(dx, dy) {
  if (zoom === 1) return;
  panX += dx;
  panY += dy;
  clampPan();
  applyPadTransform();
}

// The canvas's backing-store resolution is sized off the frame's UNSCALED
// box; zoom is purely a visual transform on top and never touches this, so
// the fraction-based drawing math in redrawPad()/padPoint() is the same at
// any zoom level.
function sizePad() {
  fitFrame();
  clampPan();
  applyPadTransform();
  const ratio = window.devicePixelRatio || 1;
  pad.width = Math.max(1, Math.round(frameW * ratio));
  pad.height = Math.max(1, Math.round(frameH * ratio));
  padCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  redrawPad();
}

function redrawPad() {
  const w = pad.clientWidth;
  const h = pad.clientHeight;
  padCtx.clearRect(0, 0, w, h);
  for (const stroke of ink.strokes) {
    if (stroke.pts.length < 2) continue;
    padCtx.beginPath();
    padCtx.strokeStyle = stroke.color;
    padCtx.lineWidth = stroke.width;
    padCtx.lineCap = 'round';
    padCtx.lineJoin = 'round';
    padCtx.moveTo(stroke.pts[0][0] * w, stroke.pts[0][1] * h);
    for (let i = 1; i < stroke.pts.length; i++) padCtx.lineTo(stroke.pts[i][0] * w, stroke.pts[i][1] * h);
    padCtx.stroke();
  }
}

// Whichever surface (whiteboard, or this one slide) is currently on screen,
// mirrored from the display's authoritative copy - this is what makes ink
// restore when you flip back to an already-annotated slide, and what keeps a
// second controller's pad in step.
function syncInkFromState() {
  const nextSurface = state.ink?.surface ?? null;
  const changedSurface = nextSurface !== inkSurface;
  inkSurface = nextSurface;
  // Never clobber a stroke this device is actively drawing mid-gesture.
  if (!ink.drawing || changedSurface) {
    ink.strokes = (state.ink?.strokes || []).map((s) => ({ ...s, pts: s.pts.map((p) => [p[0], p[1]]) }));
    if (!$('[data-panel="ink"]').hidden) redrawPad();
  }
  if (!$('[data-panel="ink"]').hidden) sizePad();
}

const flushInk = throttle(() => {
  if (!ink.strokeId || !ink.buffer.length) return;
  send({ op: 'ink', action: 'points', id: ink.strokeId, pts: ink.buffer.splice(0) });
}, 60);

function padPoint(ev) {
  const rect = pad.getBoundingClientRect();
  return [(ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height];
}

pad.addEventListener('pointerdown', (ev) => {
  if (ink.penOnly && ev.pointerType !== 'pen') return;
  pad.setPointerCapture(ev.pointerId);
  ink.drawing = true;
  ink.strokeId = uid(6);
  const pt = padPoint(ev);
  ink.strokes.push({ id: ink.strokeId, color: ink.color, width: ink.width, pts: [pt] });
  ink.buffer = [];
  send({ op: 'ink', action: 'begin', id: ink.strokeId, color: ink.color, width: ink.width, pts: [pt] });
});

pad.addEventListener('pointermove', (ev) => {
  if (!ink.drawing) return;
  ev.preventDefault();
  // Coalesced events keep an Apple Pencil line smooth without flooding the bus.
  const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
  const stroke = ink.strokes[ink.strokes.length - 1];
  for (const e of events) {
    const pt = padPoint(e);
    stroke.pts.push(pt);
    ink.buffer.push(pt);
  }
  redrawPad();
  flushInk();
});

const endStroke = (ev) => {
  if (!ink.drawing) return;
  ink.drawing = false;
  flushInk();
  send({ op: 'ink', action: 'points', id: ink.strokeId, pts: ink.buffer.splice(0) });
  ink.strokeId = null;
  try { pad.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
};
pad.addEventListener('pointerup', endStroke);
pad.addEventListener('pointercancel', endStroke);
pad.addEventListener('touchstart', (ev) => ev.preventDefault(), { passive: false });

$('#ink-zoom-in').addEventListener('click', () => setZoom(zoom * ZOOM_STEP));
$('#ink-zoom-out').addEventListener('click', () => setZoom(zoom / ZOOM_STEP));
$('#ink-zoom-reset').addEventListener('click', () => setZoom(1));
const PAN_STEP = 80;
$('#pan-up').addEventListener('click', () => pan(0, PAN_STEP));
$('#pan-down').addEventListener('click', () => pan(0, -PAN_STEP));
$('#pan-left').addEventListener('click', () => pan(PAN_STEP, 0));
$('#pan-right').addEventListener('click', () => pan(-PAN_STEP, 0));

// --- camera -----------------------------------------------------------------

let cameraSender = null;
let facing = 'environment';

function setCameraState(status) {
  $('#cam-status').textContent = {
    idle: 'Off',
    requesting: 'Asking for camera permission…',
    connecting: 'Connecting to the display…',
    live: 'Live on the display',
    failed: 'Could not connect. If this is a guest network, the two devices may be blocked from reaching each other.',
  }[status] || status;
  $('#cam-start').textContent = status === 'idle' ? 'Start camera' : 'Stop camera';
}

// Shared by the Camera tab's button and the "Phone camera" library tile, so
// either path actually asks for the camera and opens the connection rather
// than just putting the (empty) camera type on screen.
async function startCamera(where = 'auto') {
  if (cameraSender?.active) { stage({ type: 'camera', title: 'Phone camera' }, where); return; }
  try {
    await cameraSender.start({ facingMode: facing });
    stage({ type: 'camera', title: 'Phone camera' }, where);
  } catch (err) {
    setCameraState('failed');
    $('#cam-status').textContent = `Camera unavailable: ${err.message}`;
    tab('camera');
  }
}

// --- connection -------------------------------------------------------------

let relayStatus = 'connecting';
let waitingSince = Date.now();

function setStatus(status, detail) {
  relayStatus = status;
  const bar = $('#status');
  bar.dataset.status = status;
  // "Connected" here means the relay, not the display - the two are separate
  // problems and conflating them is what makes a silent room baffling.
  bar.textContent = {
    connecting: 'Connecting…',
    online: 'Relay OK',
    offline: 'Reconnecting…',
    error: `Relay problem${detail ? `: ${detail}` : ''}`,
    mismatch: 'Wrong passphrase somewhere',
  }[status] || status;
  renderConnection();
}

function renderConnection() {
  const peers = bus?.peers() || [];
  const display = peers.find((p) => p.role === 'display');
  const others = peers.filter((p) => p.role === 'control');

  let label;
  if (!display) label = 'No display connected';
  else if (state.armed === false) label = 'Display open — click “Go live” on it';
  else label = `Display connected${display.rtt ? ` · ${display.rtt} ms` : ''}`;

  $('#display-state').textContent = label;
  $('#display-state').classList.toggle('is-bad', !display);
  $('#peer-count').textContent = others.length ? `+${others.length} other controller${others.length > 1 ? 's' : ''}` : '';

  if (display) waitingSince = Date.now();

  // Give it a few seconds before crying wolf: a display that is simply slow to
  // join should not throw a banner at you mid-lecture.
  const stranded = relayStatus === 'online' && !display && Date.now() - waitingSince > 6000;
  const help = $('#link-help');
  help.hidden = !(stranded || relayStatus === 'mismatch');
  help.classList.toggle('is-mismatch', relayStatus === 'mismatch');
  $('#help-room').textContent = cfg.room;
  $('#help-code').textContent = bus?.fingerprint || '····';
}

async function connect() {
  bus = await createBus({
    cfg,
    role: 'control',
    onStatus: setStatus,
    onPeers: renderConnection,
    onMessage: (msg) => {
      if (msg.t === 'state') {
        state = { ...state, ...msg.state };
        telemetry = msg.telemetry || telemetry;
        telemetryAt = Date.now();
        syncInkFromState();
        renderAll();
        renderConnection();
        return;
      }
      if (msg.t === 'deck-need') {
        const source = deckStore.get(msg.id);
        if (source != null) bus.send({ t: 'deck', id: msg.id, source });
        return;
      }
      if (msg.t === 'ink-data') {
        inkExportWaiters.get(msg.deckId)?.(msg.bySlide || {});
        inkExportWaiters.delete(msg.deckId);
        return;
      }
      if (msg.t === 'rtc') cameraSender?.handle(msg);
    },
  });

  cameraSender = createCameraSender({
    bus,
    onState: setCameraState,
    onLocalStream: (stream) => {
      const video = $('#cam-local');
      video.srcObject = stream;
      if (stream) video.play().catch(() => {});
      $('#cam-local').hidden = !stream;
    },
  });

  $('#fingerprint').textContent = bus.fingerprint;
  $('#room-name').textContent = cfg.room;
  bus.send({ t: 'sync' });
  waitingSince = Date.now();
  renderConnection();
}

// --- wiring -----------------------------------------------------------------

function tab(name) {
  $$('.tab').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === name));
  $$('.panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
  if (name === 'ink') { syncInkFromState(); sizePad(); }
}

$$('.tab').forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab)));

$('#freeze').addEventListener('click', () => send({ op: 'freeze' }));
$('#blank').addEventListener('click', () => send({ op: 'blank' }));
$('#take').addEventListener('click', () => send({ op: 'take' }));
$('#swap').addEventListener('click', () => send({ op: 'swap' }));
$('#preview-mode').addEventListener('click', () => send({ op: 'previewMode' }));
$('#clear-preview').addEventListener('click', () => send({ op: 'clear', where: 'preview' }));
$('#mute').addEventListener('click', () => send({ op: 'mute' }));
$('#volume').addEventListener('input', (ev) => send({ op: 'volume', value: Number(ev.target.value) }));

$('#play-pause').addEventListener('click', () => send({ op: 'media', action: 'toggle' }));
$('#bar-play').addEventListener('click', () => send({ op: 'media', action: 'toggle' }));
$('#back10').addEventListener('click', () => send({ op: 'media', action: 'nudge', value: -10 }));
$('#fwd10').addEventListener('click', () => send({ op: 'media', action: 'nudge', value: 10 }));
$('#scrub').addEventListener('pointerdown', () => { scrubbing = true; });
$('#scrub').addEventListener('change', (ev) => {
  scrubbing = false;
  send({ op: 'media', action: 'seek', value: Number(ev.target.value) });
});
$('#deck-prev').addEventListener('click', () => send({ op: 'nav', dir: 'prev' }));
$('#deck-next').addEventListener('click', () => send({ op: 'nav', dir: 'next' }));
$('#deck-export').addEventListener('click', exportDeck);

$('#deck-file').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  const note = $('#deck-file-note');
  ev.target.value = '';
  if (!file) return;
  note.textContent = `Reading ${file.name}…`;
  try {
    const source = await file.text();
    const bytes = new TextEncoder().encode(source).length;
    if (bytes > MAX_DECK_BYTES) {
      note.textContent = `That deck is ${Math.round(bytes / 1024)} KB — too big to send over the air. `
        + 'Put it in podium/content/decks/ and add it to content/manifest.json instead.';
      return;
    }
    const deck = await stageDeck({ source, name: file.name.replace(/\.(md|markdown|txt)$/i, '') });
    note.textContent = `${file.name} — ${deck.count} slides`;
    tab('slides');
  } catch (err) {
    note.textContent = `Could not open that file: ${err.message}`;
  }
});

$('#prev-page').addEventListener('click', () => send({ op: 'nav', dir: 'prev' }));
$('#next-page').addEventListener('click', () => send({ op: 'nav', dir: 'next' }));

$('#lib-filter').addEventListener('input', renderLibrary);
$('#url-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('#url-input');
  const item = guessItemFromUrl(input.value);
  if (!item) return;
  if ($('#url-save').checked) {
    saveCustom([...loadCustom(), item]);
    loadLibrary();
  }
  stage(item);
  input.value = '';
});

$('#text-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  stage({ type: 'text', title: 'Message', body: $('#text-body').value, size: $('#text-size').value });
});
$('#qr-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  stage({ type: 'qr', title: 'QR', data: $('#qr-data').value, caption: $('#qr-caption').value });
});
$('#overlay-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  send({ op: 'overlay', text: $('#overlay-text').value, visible: true });
});
$('#overlay-hide').addEventListener('click', () => send({ op: 'overlay', visible: false }));

$('#timer-start').addEventListener('click', () => {
  if (state.timer.running) send({ op: 'timer', action: 'pause' });
  else if (state.timer.remainingMs > 0) send({ op: 'timer', action: 'resume' });
  else send({ op: 'timer', action: 'start', seconds: Number($('#timer-mins').value) * 60, label: $('#timer-label').value });
});
$('#timer-stop').addEventListener('click', () => send({ op: 'timer', action: 'stop' }));
$$('.timer-preset').forEach((b) => b.addEventListener('click', () => {
  $('#timer-mins').value = b.dataset.mins;
  send({ op: 'timer', action: 'start', seconds: Number(b.dataset.mins) * 60, label: $('#timer-label').value });
  stage({ type: 'timer', title: 'Timer' });
}));

$('#ink-undo').addEventListener('click', () => {
  ink.strokes.pop();
  redrawPad();
  send({ op: 'ink', action: 'undo' });
});
$('#ink-clear').addEventListener('click', () => {
  ink.strokes = [];
  redrawPad();
  send({ op: 'ink', action: 'clear' });
});
$('#ink-pen-only').addEventListener('change', (ev) => { ink.penOnly = ev.target.checked; });
$('#ink-width').addEventListener('input', (ev) => { ink.width = Number(ev.target.value); });
$$('.swatch').forEach((b) => b.addEventListener('click', () => {
  ink.color = b.dataset.color;
  $$('.swatch').forEach((s) => s.classList.toggle('is-on', s === b));
}));

$('#cam-start').addEventListener('click', async () => {
  if (cameraSender?.active) { await cameraSender.stop(); return; }
  await startCamera();
});
$('#cam-flip').addEventListener('click', async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  if (cameraSender?.active) await cameraSender.start({ facingMode: facing });
});

// A Magic Keyboard or a clicker paired to the iPad should just work.
document.addEventListener('keydown', (ev) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
  const paged = ['pdf', 'slides', 'web', 'deck'].includes(state.program?.type);
  if (!paged) return;
  if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ') { ev.preventDefault(); send({ op: 'nav', dir: 'next' }); }
  if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); send({ op: 'nav', dir: 'prev' }); }
  if (ev.key === 'b' || ev.key === 'B') { ev.preventDefault(); send({ op: 'blank' }); }
  if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); send({ op: 'freeze' }); }
});

window.addEventListener('resize', () => { if (!$('[data-panel="ink"]').hidden) sizePad(); });
window.addEventListener('beforeunload', () => bus?.close());
setInterval(() => { renderNow(); renderTimer(); renderConnection(); }, 250);

// --- setup ------------------------------------------------------------------

function showSetup() {
  $('#setup').hidden = false;
  $('#app').hidden = true;
  $('#setup-close').hidden = !isConfigured(cfg);
  const form = $('#setup-form');
  for (const [key, value] of Object.entries(cfg)) {
    const field = form.elements[key];
    if (field && typeof value !== 'boolean') field.value = value;
  }
  const onTransport = () => {
    const t = form.elements.transport.value;
    form.querySelectorAll('[data-for]').forEach((row) => { row.hidden = !row.dataset.for.split(' ').includes(t); });
  };
  form.elements.transport.addEventListener('change', onTransport);
  onTransport();
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const next = { ...cfg };
    for (const key of Object.keys(DEFAULTS)) {
      const field = form.elements[key];
      if (field && typeof field.value === 'string') next[key] = field.value.trim();
    }
    if (!isConfigured(next)) { $('#setup-error').textContent = 'Fill in the fields for the transport you picked.'; return; }
    cfg = next;
    saveConfig(cfg);
    location.reload();
  });
}

$('#open-settings').addEventListener('click', showSetup);

// Reloading is the honest "cancel": it throws away half-finished edits and
// puts the page back into whatever state the saved settings describe.
$('#setup-close').addEventListener('click', reloadClean);

wireDangerButton($('#reset-device'), 'Clear settings & reload', async () => {
  const removed = await resetDevice();
  $('#reset-note').textContent = removed.length ? `Cleared ${removed.join(', ')}.` : 'Nothing was stored on this device.';
  reloadClean();
});

if (!isConfigured(cfg)) {
  showSetup();
} else {
  $('#app').hidden = false;
  await connect();
  await loadLibrary();
  tab('library');
  renderAll();
}
