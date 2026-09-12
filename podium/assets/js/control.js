// The controller: iPad in your hand, iPhone in your pocket. Both can be
// connected at once and stay in step, because neither holds any state - they
// send commands and render whatever the display echoes back.

import { $, $$, el, uid, fmtTime, guessItemFromUrl, throttle, wireDangerButton, servedBuild, createRelayLog } from './util.js';
import { loadConfig, saveConfig, isConfigured, relayTarget, resetDevice, reloadClean, DEFAULTS } from './config.js';
import { createBus } from './bus.js';
import { initialState, timerRemaining, timerById, LAYOUTS, MAX_TIMERS, focusedItem,
  inkDigest, inkDigestsAgree, applyInkAction, BUILD } from './protocol.js';
import { createRenderer, itemTitle, TYPES } from './renderers.js';
import { createCameraSender } from './rtc.js';
import { render as renderDeckSource, deckId, frontMatterTitle, themeReport } from './deck.js';
import { createZip } from './zip.js';
import { readPlan, itemForStage, itemLabel, assetIdOf } from './planfile.js';
import { loadCurrentPlan, saveCurrentPlan, clearCurrentPlan, readFileText } from './store.js';

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
// The panel most recently sent a deck pick, and the id it should end up
// showing, until state's own echo confirms it actually landed - see
// deckAspectPending() below. Closes the one race deckView alone cannot:
// state is the display's word, arriving over the network, so there is
// always a beat between sending a pick and it actually taking effect here -
// normally sub-frame, but real on a loaded machine or a laggier transport
// (Supabase, MQTT). Without this, the pad would briefly go on sizing itself
// for whatever WAS on that panel a moment ago. `deckId: true` means "in
// flight, real id not known yet" (see pick()). Tracks only the most recent
// pick - picking into two different panels in the same instant is not a
// case worth a map for, and the worst it costs is a moment longer showing
// "not ready yet" on whichever one loses that race.
let pendingStage = null;

// A loaded lecture plan (see planfile.js): its running order becomes the top of
// the Library, its saved timers become the Timer tab's presets, and the photos
// it carries are served to the projector on demand, exactly as an uploaded deck
// is. Kept in IndexedDB rather than localStorage because a plan carries images.
let currentPlan = null;
const assetStore = new Map();
// Which of them this controller has already pushed to the room, so re-picking
// a photo does not re-send it.
const assetsSent = new Set();

// Items reach the display holding `asset:<id>`, not the bytes - the item is in
// `state`, which is rebroadcast twice a second and is what ink surfaces are
// keyed by. Only the local preview renderers resolve it, and only at the point
// of handing an item to one, so every key stays identical on both ends.
function resolveAssets(item) {
  if (!item) return item;
  const id = assetIdOf(item.src);
  if (id === null) return item;
  const data = assetStore.get(id);
  return data ? { ...item, src: data } : item;
}

// Requesting a deck's saved ink for export: the display holds the only full
// copy, keyed by deck+slide, so exporting asks for it rather than trying to
// reconstruct it from the one surface this device happens to be looking at.
// A whole deck's ink is the largest thing the app ever moves, so it arrives in
// slices (see chunkStrokes in display.js) and is stitched back together here.
const inkExportWaiters = new Map();
function requestInkData(targetDeckId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const acc = { bySlide: {}, timer: null };
    const finish = () => { clearTimeout(acc.timer); inkExportWaiters.delete(targetDeckId); resolve(acc.bySlide); };
    // The timeout is per SLICE, not for the whole transfer: a deck with a
    // term's annotation on it can legitimately take several messages, and a
    // fixed overall deadline would truncate the big exports rather than the
    // broken ones.
    const arm = () => { clearTimeout(acc.timer); acc.timer = setTimeout(finish, timeoutMs); };
    acc.add = (msg) => {
      for (const [slide, strokes] of Object.entries(msg.bySlide || {})) {
        (acc.bySlide[slide] ||= []).push(...strokes);
      }
      if (msg.last) finish();
      else arm();
    };
    arm();
    inkExportWaiters.set(targetDeckId, acc);
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
  // Populate deckView with the SAME parse used to stage it, rather than
  // leaving ensureDeckView() to redundantly re-fetch and re-render it a
  // second time once the display's broadcast echoes state.program back.
  // That second, independent parse is what used to leave a real window -
  // over a second for a deck with a real theme's fonts - where the ink pad
  // did not yet know this slide's own aspect ratio and sized itself against
  // the display's raw window shape instead. A stroke drawn in that window
  // is fractions of the WRONG box, baked in permanently: no later
  // correction can fix a point already this shape's guess. Right for the
  // common case (staging a deck from this controller's own library); the
  // rarer paths - a second controller syncing to a deck already on screen,
  // an uploaded deck echoed from elsewhere - still go through
  // ensureDeckView(), which now also nudges the pad once it resolves.
  deckGeneration++;
  deckView = { id, deck };
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

// The running order, as library items. Numbered, because the whole point of a
// plan is that it is a sequence: "we are on 4" is the useful thing to know when
// you glance down mid-sentence.
function planLibraryItems() {
  if (!currentPlan) return [];
  return currentPlan.items.map((row, i) => ({
    ...itemForStage(row),
    group: currentPlan.title || 'Lecture plan',
    order: i + 1,
    note: row.note || '',
    planRow: row.id,
  }));
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
    // The plan first: it is what you came to teach, and the built-ins are
    // always one scroll away.
    ...planLibraryItems(),
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
    if (filter && !`${item.title} ${item.type} ${item.note || ''}`.toLowerCase().includes(filter)) continue;
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
        el('span', { class: 'tile-title' }, item.title || itemLabel(item)),
        el('span', { class: 'tile-type' }, TYPES[item.type]?.label || item.type));
      if (item.order) tile.prepend(el('span', { class: 'tile-order' }, String(item.order)));
      // The note you wrote in the office, where you will actually see it:
      // on the tile, not behind a hover a tablet cannot do.
      if (item.note) tile.append(el('span', { class: 'tile-note' }, item.note));
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

// --- lecture plans ----------------------------------------------------------

const DEFAULT_TIMER_PRESETS = [1, 2, 5, 10, 15].map((mins) => ({ mins, label: '' }));

function renderTimerPresets() {
  const presets = currentPlan?.timers?.length ? currentPlan.timers : DEFAULT_TIMER_PRESETS;
  $('#timer-presets').replaceChildren(...presets.map((preset) => el('button', {
    class: 'timer-preset',
    type: 'button',
    dataset: { mins: String(preset.mins), label: preset.label || '' },
  }, preset.label ? `${preset.label} · ${preset.mins}m` : `${preset.mins}m`)));
}

function renderPlanBar() {
  const badge = $('#plan-name');
  badge.hidden = !currentPlan;
  badge.textContent = currentPlan ? `\u{1F4CB} ${currentPlan.title}` : '';
  $('#plan-clear').hidden = !currentPlan;
  // Sits in a row of controls, so it says something only when there is
  // something to say.
  $('#plan-note').textContent = currentPlan
    ? `Loaded “${currentPlan.title}” — ${currentPlan.items.length} item${currentPlan.items.length === 1 ? '' : 's'}, ${currentPlan.timers.length} timer${currentPlan.timers.length === 1 ? '' : 's'}.`
    : '';
}

/**
 * Take on a plan built elsewhere. Everything a plan carries has to be turned
 * into the shapes the rest of the controller already speaks, up front rather
 * than at the moment something is tapped: an uploaded deck becomes an entry in
 * deckStore under the hash of its markdown - identical to a deck dropped on
 * this device - and its photos become entries in assetStore, ready to answer
 * the projector. The alternative, resolving lazily on the first tap, puts a
 * fetch and a hash in front of the one action that has to be instant.
 */
async function adoptPlan(plan, { persist = true, applyToDisplay = true } = {}) {
  assetStore.clear();
  assetsSent.clear();
  for (const [id, asset] of Object.entries(plan.assets || {})) assetStore.set(id, asset.data);

  for (const row of plan.items) {
    if (row.type !== 'deck' || !row.asset) continue;
    const source = plan.assets?.[row.asset]?.data;
    if (typeof source !== 'string') continue;
    const id = await deckId(source);
    deckStore.set(id, source);
    row.deckId = id;
  }

  currentPlan = plan;
  if (persist) {
    try { await saveCurrentPlan(plan); } catch { /* private browsing: it just will not survive a reload */ }
  }
  renderPlanBar();
  renderTimerPresets();
  // A plan that lays the screen out, or names this lecture's countdowns, says
  // so - but only when you deliberately load it. Doing either on every page
  // restore would yank the projector around, and reset a running clock, every
  // time the tablet woke up mid-lecture.
  if (!applyToDisplay) return;
  if (plan.layout && plan.layout !== 'single') send({ op: 'layout', mode: plan.layout });
  if (plan.timers.length) {
    // Ids carried through from the plan, so its countdown items name the same
    // clocks the display just created.
    send({
      op: 'timer',
      action: 'define',
      timers: plan.timers.slice(0, MAX_TIMERS).map((t) => ({ id: t.id, label: t.label, seconds: t.mins * 60 })),
    });
  }
}

// Sends a fully-formed item wherever it belongs right now. Panel A (focus 0)
// goes through the usual freeze/cue/take pipeline via 'stage'. A focused
// B/C/D panel has none of that - see "layout" in protocol.js's
// initialState() - so it is set directly and immediately via 'panel'
// instead, and `where` (an explicit program/preview target) does not apply.
function stage(item, where = 'auto') {
  // Only a deck needs this: it is the only type whose pad shape depends on
  // content that has to be parsed, so it is the only one that can be picked
  // and drawn on before the pad actually knows what shape to be.
  pendingStage = item.type === 'deck' ? { panel: state.focus, deckId: item.deckId } : null;
  // group/custom/order/note/planRow are library bookkeeping; the display has no
  // use for them.
  const { group: _g, custom: _c, order: _o, note: _n, planRow: _p, ...clean } = item;
  // Same courtesy the deck path extends: push the bytes ahead of the item that
  // refers to them, so the projector does not have to notice and ask. Once
  // each: a photo is ~120 KB and re-picking it is common, while a display that
  // reloaded and lost it asks for it by name (see 'asset-need').
  const assetId = assetIdOf(clean.src);
  if (assetId && assetStore.has(assetId) && !assetsSent.has(assetId)) {
    if (bus?.send({ t: 'asset', id: assetId, data: assetStore.get(assetId) }) !== false) assetsSent.add(assetId);
  }
  if (state.focus === 0) send({ op: 'stage', item: clean, where });
  else send({ op: 'panel', index: state.focus - 1, item: clean });
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
  // A click handler can't be awaited by whatever dispatched it, so the
  // moment this returns control (at the first await below), the pad's own
  // sizing logic could already be asked to run again - well before
  // stageDeck() gets far enough to call stage() and set pendingStage itself.
  // Mark intent to pick a deck right here, synchronously, so that gap does
  // not exist: deckId `true` stands for "in flight, real id not known yet"
  // until stage() replaces it with the actual one. Captures the panel this
  // click targeted, not whatever has focus by the time it resolves.
  const panel = state.focus;
  pendingStage = { panel, deckId: true };
  const note = $('#deck-file-note');
  note.textContent = `Loading ${item.title || 'deck'}…`;
  try {
    // An uploaded deck (from a lecture plan, or dropped on this device) is
    // already in deckStore under its content hash; a library deck is fetched
    // by path. getDeckSource handles both, given the right reference.
    const source = await getDeckSource(item.deckId ? item : { deckId: `src:${item.src}`, src: item.src });
    await stageDeck({ source, name: item.title, src: item.src });
    note.textContent = '';
  } catch (err) {
    if (pendingStage?.panel === panel && pendingStage.deckId === true) pendingStage = null;
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
      previewRenderer = createRenderer(resolveAssets(item), { preview: true, getTimer: (id) => timerById(state, id), getDeckSource });
      holder.append(previewRenderer.el);
    }
  } else if (previewRenderer && item) {
    previewRenderer.update(resolveAssets(item));
    previewRenderer.reconcile({ ...item, playing: false }, { volume: 0, muted: true });
  }

  $('#preview-label').textContent = state.preview ? 'Cued' : 'On screen';
  $('#preview-title').textContent = itemTitle(item);
  $('#preview-pane').classList.toggle('is-cued', !!state.preview);
}

// --- Marp deck panel --------------------------------------------------------

// "Now" and "Next" live previews - a confidence monitor for the deck on
// screen, declared up front since renderSlides() needs them from its first
// call; createLiveMirror itself is defined down with the ink pad, which it
// shares its "contain"-fit geometry with.
const nowMirror = createLiveMirror($('#deck-now-preview'));
const nextMirror = createLiveMirror($('#deck-next-preview'));

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
    // The deck's real aspect just became known - if the Ink tab is already
    // open (a second controller joining mid-deck, or an uploaded deck echoed
    // from elsewhere), the pad was sized against the fallback stage shape
    // until now and needs to catch up, the same as after a resize.
    if (!$('[data-panel="ink"]').hidden && !ink.drawing) sizePad();
  } catch (err) {
    $('#deck-notes').textContent = `Marp could not render this deck: ${err.message}`;
  }
}

function renderSlides() {
  const item = focusedItem(state)?.type === 'deck' ? focusedItem(state) : null;
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

  // "Now" mirrors exactly what the projector shows, build step included.
  // "Next" is always shown fully built - you are looking ahead to what is
  // coming, not rehearsing its reveal.
  nowMirror.update(item);
  if (index + 1 < total) {
    nextMirror.update({ ...item, slide: index + 1, step: (item.fragments && item.fragments[index + 1]) || 0 });
    $('#deck-next-title').textContent = deck?.titles?.[index + 1] ? `${index + 2}. ${deck.titles[index + 1]}` : `Slide ${index + 2}`;
  } else {
    nextMirror.update(null);
    $('#deck-next-title').textContent = 'End of deck';
  }

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
  const item = focusedItem(state);
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
    btn.disabled = !(deckView.deck && focusedItem(state)?.type === 'deck');
  }
}

// --- transport / now playing ------------------------------------------------

function currentTime() {
  if (scrubbing) return Number($('#scrub').value);
  if (!telemetry.playing) return telemetry.time;
  return telemetry.time + (Date.now() - telemetryAt) / 1000;
}

function renderNow() {
  const item = focusedItem(state);
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

// Which of the countdowns the controls below the chips are driving. Held as an
// id rather than an index so a timer being removed elsewhere cannot silently
// re-point it at a different one; timerById falls back to the first.
let currentTimerId = null;
let timerChipsKey = '';

const currentTimer = () => timerById(state, currentTimerId);

function renderTimers() {
  const timers = state.timers || [];
  const active = currentTimer();
  // Deliberately NOT written back into currentTimerId. Adding a timer names it
  // here and selects it a beat before the display's echo carries it back, and
  // a render landing in that gap would "correct" the selection to the first
  // timer - so the next tap on Start would pause THAT one instead of starting
  // the one you just made. The selection is what you asked for; the fallback
  // is only for what is drawn.
  const shownId = timers.some((t) => t.id === currentTimerId) ? currentTimerId : timers[0]?.id;

  // The chips are rebuilt only when the SET changes. This runs four times a
  // second; replacing the buttons that often would eat taps that land between
  // a render and the tap finishing.
  const row = $('#timer-chips');
  const key = `${timers.map((t) => `${t.id}\u0000${t.label}`).join('|')}#${shownId}`;
  if (key !== timerChipsKey) {
    timerChipsKey = key;
    row.replaceChildren(...timers.map((timer, i) => el('button', {
      class: `timer-chip${timer.id === shownId ? ' is-on' : ''}`,
      type: 'button',
      dataset: { id: timer.id },
      onclick: () => { currentTimerId = timer.id; syncTimerFields(); renderTimers(); },
    },
      el('span', { class: 'timer-chip-name' }, timer.label || `Timer ${i + 1}`),
      el('span', { class: 'timer-chip-time' }, '0:00'))));
  }

  // ...while the times themselves are text updates, every tick.
  timers.forEach((timer, i) => {
    const chip = row.children[i];
    if (!chip) return;
    const left = timerRemaining(timer);
    chip.querySelector('.timer-chip-time').textContent = fmtTime(Math.ceil(left / 1000));
    chip.classList.toggle('is-running', timer.running);
    chip.classList.toggle('is-urgent', timer.running && left > 0 && left <= 30000);
  });

  const ms = active ? timerRemaining(active) : 0;
  $('#timer-readout').textContent = fmtTime(Math.ceil(ms / 1000));
  $('#timer-readout').classList.toggle('is-urgent', !!active?.running && ms <= 30000);
  $('#timer-start').textContent = active?.running ? 'Pause' : ((active?.remainingMs || 0) > 0 ? 'Resume' : 'Start');
  $('#timer-add').disabled = timers.length >= MAX_TIMERS;
  // The first is what every timer item falls back to, so it is the one that
  // cannot go away.
  $('#timer-remove').hidden = timers.length <= 1 || timers[0]?.id === shownId;
}

// Only on selection, never on a tick: copying a running clock into the minutes
// box four times a second would fight whatever you were typing there.
function syncTimerFields() {
  const timer = currentTimer();
  if (!timer) return;
  $('#timer-label').value = timer.label || '';
  const seconds = Math.round(timerRemaining(timer) / 1000);
  if (seconds > 0) $('#timer-mins').value = String(Math.max(1, Math.round(seconds / 60)));
}

const PANEL_LABELS = ['A', 'B', 'C', 'D'];

// The layout picker mirrors state.layout; the panel picker (A/B/C/D) only
// appears once there is more than one to choose between, and shows which
// one Library taps, deck nav, transport, and Ink currently address.
function renderLayoutBar() {
  $$('.layout-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.layout === state.layout));
  const count = LAYOUTS[state.layout] || 1;
  const picker = $('#panel-picker');
  picker.hidden = count <= 1;
  if (count <= 1) return;
  if (picker.childElementCount !== count) {
    picker.replaceChildren(...Array.from({ length: count }, (_, i) => el('button', {
      class: 'panel-btn',
      type: 'button',
      onclick: () => send({ op: 'focus', index: i }),
    }, PANEL_LABELS[i])));
  }
  $$('.panel-btn', picker).forEach((b, i) => b.classList.toggle('is-on', i === state.focus));
}

function renderAll() {
  renderPreview();
  renderNow();
  renderTimers();
  renderSlides();
  renderLayoutBar();
  ensureDeckView(focusedItem(state));
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
const padMirror = $('#pad-mirror');
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

// Any deck slide's own aspect ratio (from its viewBox, via deckView's already-
// rendered copy), falling back to the display's own window shape for content
// with no fixed shape of its own (a whiteboard fills whatever window it is
// on). Takes an explicit item so it can also answer for a slide that is not
// the one currently on screen - "Next", in the Slides tab.
function contentAspectFor(item) {
  if (item?.type === 'deck' && deckView.id === item.deckId && deckView.deck?.aspects?.length) {
    const idx = Math.min(deckView.deck.aspects.length - 1, Math.max(0, item.slide || 0));
    return deckView.deck.aspects[idx] || 16 / 9;
  }
  return state.stageAspect || 16 / 9;
}

const computeContentAspect = () => contentAspectFor(focusedItem(state));

// The "contain" fit math the display itself uses to letterbox a slide: sizes
// and centers `frame` inside `viewport` to the given aspect ratio. Shared by
// the ink pad and by every live content mirror (see createLiveMirror), so a
// slide always looks - and, on the pad, captures pointer input - in correct
// proportion no matter how the container around it is shaped.
function fitBox(viewport, frame, aspect) {
  const vp = viewport.getBoundingClientRect();
  if (!vp.width || !vp.height) return { w: 0, h: 0 };
  let w = vp.width;
  let h = w / aspect;
  if (h > vp.height) { h = vp.height; w = h * aspect; }
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
  frame.style.left = `${(vp.width - w) / 2}px`;
  frame.style.top = `${(vp.height - h) / 2}px`;
  return { w, h };
}

// A deck item whose real aspect is not known yet - deckView is still mid-
// parse for it, a redundant second render the pad needs even though the
// slide is already staging elsewhere - must not let the pad size itself
// against a guess (the display's raw window shape). A stroke drawn against
// the wrong-shaped box is fractions of the wrong box forever: once sent,
// there is no later correction that can fix a point already measured
// against the wrong guess. Simplest fix is to not let one happen: the pad
// refuses pointer input until the real shape is known (see below); the live
// mirror behind it keeps showing Marp's own "Loading deck…" status in the
// meantime, so the pad does not look broken, just not ready yet.
function deckAspectPending(panel, item) {
  // The item echoed back for this panel is the display's word on what it
  // actually put there - until it confirms the deck we just told it to
  // show, that echo is still describing whatever was there before, and
  // going by it would size the pad for the WRONG item, not merely an
  // unready one. deckId `true` means a pick just started and does not have
  // a real deckId to compare against yet.
  if (pendingStage && pendingStage.panel === panel) {
    if (pendingStage.deckId === true) return true;
    if (item?.type === 'deck' && item.deckId === pendingStage.deckId) pendingStage = null;
    else return true;
  }
  return item?.type === 'deck' && deckView.id !== item.deckId;
}

function fitFrame() {
  const pending = deckAspectPending(state.focus, focusedItem(state));
  pad.classList.toggle('is-pending', pending);
  if (pending) return;
  const { w, h } = fitBox(padViewport, padFrame, computeContentAspect());
  frameW = w;
  frameH = h;
}

// A live, read-only rendering of an item - the actual slide, whiteboard
// color, or camera feed - shaped to its own content box. Used as the
// background you draw on top of in the Ink tab (so you can see what you are
// marking up) and as the "Now" / "Next" preview in the Slides tab. Distinct
// from `previewRenderer` (the small on-screen/cued thumbnail at the top of
// the app), which always mirrors program-or-preview rather than an arbitrary
// item like a synthesized "next slide".
function createLiveMirror(container) {
  container.replaceChildren();
  const viewport = el('div', { class: 'mirror-viewport' });
  const frame = el('div', { class: 'mirror-frame' });
  viewport.append(frame);
  container.append(viewport);
  let renderer = null;
  let mountedKey = null;

  // Regrouping by type+source (not the item's own one-shot `.key`, which is
  // fresh on every stage) is what lets update() hand the same mounted deck a
  // new slide/step without a full remount.
  const identity = (item) => (item ? `${item.type}:${item.deckId || item.src || ''}` : null);

  function update(item) {
    fitBox(viewport, frame, contentAspectFor(item));
    const key = identity(item);
    if (key !== mountedKey) {
      renderer?.destroy();
      frame.replaceChildren();
      mountedKey = key;
      renderer = item ? createRenderer(resolveAssets(item), { preview: true, getTimer: (id) => timerById(state, id), getDeckSource }) : null;
      if (renderer) frame.append(renderer.el);
    } else {
      renderer?.update(resolveAssets(item));
    }
  }

  function destroy() {
    renderer?.destroy();
    container.replaceChildren();
  }

  return { viewport, frame, update, destroy };
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
  updatePadMirror();
}

// A read-only mirror of whatever ink is currently drawing on top of, filling
// #pad-frame exactly (which sizePad already keeps fit to the content's own
// shape) - so annotating a slide means seeing the slide, not a blank sheet.
let padMirrorRenderer = null;
let padMirrorKey = null;
let showMirror = true;

function updatePadMirror() {
  const item = focusedItem(state);
  const key = item ? `${item.type}:${item.deckId || item.src || ''}` : null;
  if (key !== padMirrorKey) {
    padMirrorRenderer?.destroy();
    padMirror.replaceChildren();
    padMirrorKey = key;
    padMirrorRenderer = item ? createRenderer(resolveAssets(item), { preview: true, getTimer: (id) => timerById(state, id), getDeckSource }) : null;
    if (padMirrorRenderer) padMirror.append(padMirrorRenderer.el);
  } else {
    padMirrorRenderer?.update(resolveAssets(item));
  }
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
// kept in step with the display's authoritative copy - this is what makes ink
// restore when you flip back to an already-annotated slide, and what keeps a
// second controller's pad showing the same marks as the first.
//
// Surfaces this device has already seen, so flipping back to slide 4 draws its
// ink immediately rather than blanking until a request comes back. The digest
// in the next heartbeat confirms what is held or corrects it, which makes this
// an optimistic cache: worst case is one frame of slightly stale ink on a
// surface someone else has edited since.
const INK_CACHE_MAX = 60;
const inkCache = new Map();

function holdInk(surface, strokes) {
  ink.strokes = strokes;
  if (!surface) return;
  // Re-inserted so the Map's own insertion order is a least-recently-used list.
  inkCache.delete(surface);
  inkCache.set(surface, strokes);
  while (inkCache.size > INK_CACHE_MAX) inkCache.delete(inkCache.keys().next().value);
}

// An outstanding request for a surface's strokes, and the slices arriving in
// answer to it. See requestInkSurface below.
let inkPull = { surface: null, at: 0, parts: [] };

// The heartbeat carries only a summary of the current surface's ink (see
// inkDigest in protocol.js) - the strokes themselves were hundreds of
// kilobytes on a busy whiteboard, going out every two seconds, and no relay
// would carry that. This device normally stays in step without asking: it
// applies its own strokes as it draws them and its peers' as they arrive. Ask
// only when the summary says it has actually fallen behind - joining
// mid-lecture, switching to a surface it has never seen, or a dropped message.
function requestInkSurface() {
  if (!inkSurface || !bus) return;
  // One request in flight at a time, retried rather than repeated: an answer
  // can take several messages, and asking again mid-transfer would only start
  // the same transfer over.
  if (inkPull.surface === inkSurface && Date.now() - inkPull.at < 3000) return;
  inkPull = { surface: inkSurface, at: Date.now(), parts: [] };
  bus.send({ t: 'ink-pull', surface: inkSurface });
}

function receiveInkSurface(msg) {
  if (msg.surface !== inkPull.surface || msg.surface !== inkSurface) return;   // stale answer
  inkPull.parts.push(...(msg.strokes || []));
  if (!msg.last) return;
  // Never clobber a stroke this device is in the middle of drawing; the next
  // heartbeat will notice the difference and ask again.
  if (!ink.drawing) {
    holdInk(msg.surface, inkPull.parts);
    if (!$('[data-panel="ink"]').hidden) redrawPad();
  }
  inkPull = { surface: null, at: 0, parts: [] };
}

function syncInkFromState() {
  const nextSurface = state.ink?.surface ?? null;
  const changedSurface = nextSurface !== inkSurface;
  inkSurface = nextSurface;
  if (changedSurface) {
    // A different slide, board or panel. Whatever was held belongs to the old
    // one, so show what this device already has for the new one - nothing, if
    // it has never seen it - and let the digest below settle it.
    holdInk(nextSurface, inkCache.get(nextSurface) || []);
    inkPull = { surface: null, at: 0, parts: [] };
    if (!$('[data-panel="ink"]').hidden) redrawPad();
  }
  if (!ink.drawing && !inkDigestsAgree(inkDigest(ink.strokes), state.ink?.digest)) requestInkSurface();
  // Resizing mid-stroke is what caused strokes to come out warped. If the
  // deck's aspect had only just become known - Marp still loading when the
  // gesture started - the frame would resize partway through it. Points
  // already captured are fractions of whatever box existed at that instant,
  // so a resize between two points of the SAME stroke leaves them meaning
  // different things once redrawn under one uniform size. Deferring the
  // resize until the stroke ends (see endStroke()) keeps every point in a
  // gesture measured against one constant box.
  if (!$('[data-panel="ink"]').hidden && !ink.drawing) sizePad();
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
  holdInk(inkSurface, ink.strokes);
  ink.strokes.push({ id: ink.strokeId, color: ink.color, width: ink.width, pts: [pt] });
  ink.buffer = [];
  send({ op: 'ink', action: 'begin', id: ink.strokeId, color: ink.color, width: ink.width, pts: [pt] });
});

pad.addEventListener('pointermove', (ev) => {
  if (!ink.drawing) return;
  ev.preventDefault();
  // Coalesced events keep an Apple Pencil line smooth without flooding the bus.
  const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
  // By id, not by position. A second controller's strokes now arrive live and
  // are appended to this same list, so "the last stroke" is no longer reliably
  // the one this finger is drawing - taking it would splice your points onto
  // the end of someone else's line.
  const stroke = ink.strokes.find((st) => st.id === ink.strokeId);
  if (!stroke) return;
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
  // Catch up on any resize that was deliberately deferred while that stroke
  // was in progress, now that there is a safe moment to apply it.
  if (!$('[data-panel="ink"]').hidden) sizePad();
};
pad.addEventListener('pointerup', endStroke);
pad.addEventListener('pointercancel', endStroke);
pad.addEventListener('touchstart', (ev) => ev.preventDefault(), { passive: false });

$('#ink-zoom-in').addEventListener('click', () => setZoom(zoom * ZOOM_STEP));
$('#ink-zoom-out').addEventListener('click', () => setZoom(zoom / ZOOM_STEP));
$('#ink-zoom-reset').addEventListener('click', () => setZoom(1));
$('#ink-toggle-mirror').addEventListener('click', (ev) => {
  showMirror = !showMirror;
  padMirror.classList.toggle('is-hidden', !showMirror);
  ev.currentTarget.classList.toggle('is-on', showMirror);
  ev.currentTarget.textContent = showMirror ? 'Showing slide' : 'Slide hidden';
});
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
const relayLog = createRelayLog();

function setStatus(status, detail) {
  relayStatus = status;
  relayLog.push(status, detail || '');
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
  // The status bar has room for two words. The panel below it has room for the
  // URL and the close code, which is what you actually need at the moment the
  // relay will not come up.
  const trouble = status === 'error' || status === 'offline';
  $('#relay-help').hidden = !trouble;
  $('#relay-help-why').textContent = detail || 'No detail was reported.';
  renderConnection();
}

function renderConnection() {
  const peers = bus?.peers() || [];
  const display = peers.find((p) => p.role === 'display');
  const others = peers.filter((p) => p.role === 'control');

  // A display still serving an older copy of the app - a browser that never
  // revalidated the page, or a machine whose projector tab has been open
  // since before you deployed - misbehaves in ways that look like bugs
  // rather than like a stale page. Say which it is.
  //
  // A display old enough to predate this check reports no build at all, and
  // the first version of this read that as "nothing to complain about" -
  // staying silent for precisely the case it was written for. Missing is not
  // "fine", it is the oldest answer there is.
  const theirs = Number.isFinite(state.build) ? state.build : null;
  const mismatch = display && theirs !== BUILD;

  let label;
  if (!display) label = 'No display connected';
  else if (theirs === null) label = `Display is running code older than build ${BUILD} — reload it`;
  else if (theirs < BUILD) label = `Display is on build ${theirs}, this is build ${BUILD} — reload the display`;
  else if (theirs > BUILD) label = `Display is on build ${theirs}, this is build ${BUILD} — reload THIS device`;
  else if (state.armed === false) label = 'Display open — click “Go live” on it';
  else label = `Display connected${display.rtt ? ` · ${display.rtt} ms` : ''} · build ${BUILD}`;

  $('#display-state').textContent = label;
  $('#display-state').classList.toggle('is-bad', !display || !!mismatch);
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
      if (msg.t === 'asset-need') {
        const data = assetStore.get(msg.id);
        if (data != null) bus.send({ t: 'asset', id: msg.id, data });
        return;
      }
      if (msg.t === 'ink-data') {
        inkExportWaiters.get(msg.deckId)?.add(msg);
        return;
      }
      if (msg.t === 'ink-surface') { receiveInkSurface(msg); return; }
      // Another controller's ink, straight off the bus. Every peer already
      // receives these; ignoring them used to mean a second device only saw
      // the first one's strokes when the next heartbeat carried them, up to
      // two seconds later. Now the heartbeat carries no strokes at all, so
      // following the commands is also what keeps the two in step.
      if (msg.t === 'cmd' && msg.op === 'ink') {
        if (applyInkAction(ink.strokes, msg, { color: ink.color, width: ink.width })
          && !$('[data-panel="ink"]').hidden) redrawPad();
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
  // A box measured while its panel is [hidden] gets 0x0 back from
  // getBoundingClientRect() and fitBox() quietly declines to size anything
  // from that, so every "contain"-fit surface needs a nudge the moment its
  // panel actually has a size to fit into - it would otherwise sit blank
  // until whatever periodic update happens to land next.
  if (name === 'ink') { syncInkFromState(); sizePad(); }
  if (name === 'slides') renderSlides();
}

$$('.tab').forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab)));

$('#freeze').addEventListener('click', () => send({ op: 'freeze' }));
$('#blank').addEventListener('click', () => send({ op: 'blank' }));

$$('.layout-btn').forEach((b) => b.addEventListener('click', () => send({ op: 'layout', mode: b.dataset.layout })));
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

// --- laser pointer -----------------------------------------------------------
//
// Drag on the "Now" preview and a dot follows your finger on the projector,
// mapped through the same content-shaped box the mirror already fits itself
// to. Deliberately not part of `state`: it is a live gesture, not a document
// - no undo, no persistence, no broadcast to reconcile, just raw position
// messages the display renders directly and forgets.

$('#deck-markup').addEventListener('click', () => tab('ink'));

let laserActive = false;
const laserDot = el('div', { class: 'laser-dot' });
$('#deck-now-preview').append(laserDot);

// Red vanishes into a dark slide or a photograph and green vanishes into a
// green one, so the colour is the presenter's to pick and worth remembering:
// whoever needs green today needs it for the whole course. Per device, like
// every other preference here - it says nothing about the room.
const LASER_COLORS = ['red', 'green', 'blue'];
const LASER_KEY = 'podium.laser.v1';
let laserColor = 'red';
try {
  const saved = localStorage.getItem(LASER_KEY);
  if (LASER_COLORS.includes(saved)) laserColor = saved;
} catch { /* private browsing: red it is */ }

function setLaserColor(color) {
  laserColor = LASER_COLORS.includes(color) ? color : 'red';
  try { localStorage.setItem(LASER_KEY, laserColor); } catch { /* nothing to do */ }
  laserDot.dataset.color = laserColor;
  // The button wears the colour too, so you can tell at a glance what the
  // class is about to see without pressing it first.
  $('#deck-laser').dataset.color = laserColor;
  $$('.laser-swatch').forEach((b) => b.classList.toggle('is-on', b.dataset.color === laserColor));
}

function setLaserActive(on) {
  laserActive = on;
  $('#deck-laser').classList.toggle('is-on', on);
  nowMirror.frame.classList.toggle('laser-armed', on);
  if (!on) { laserDot.classList.remove('is-on'); bus?.send({ t: 'laser', on: false }); }
}
$('#deck-laser').addEventListener('click', () => setLaserActive(!laserActive));
$$('.laser-swatch').forEach((b) => b.addEventListener('click', () => {
  setLaserColor(b.dataset.color);
  // Picking a colour mid-drag would otherwise leave the old one on the wall
  // until the next move; nudge the display so it changes immediately.
  if (laserDragging) sendLaser(...lastLaserPoint);
}));
setLaserColor(laserColor);

function laserPoint(ev) {
  const rect = nowMirror.frame.getBoundingClientRect();
  return [(ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height];
}

const sendLaser = throttle((x, y) => bus?.send({ t: 'laser', x, y, on: true, color: laserColor }), 40);
let laserDragging = false;
let lastLaserPoint = [0.5, 0.5];

nowMirror.frame.addEventListener('pointerdown', (ev) => {
  if (!laserActive) return;
  laserDragging = true;
  nowMirror.frame.setPointerCapture(ev.pointerId);
  const [x, y] = laserPoint(ev);
  lastLaserPoint = [x, y];
  laserDot.style.left = `${x * 100}%`;
  laserDot.style.top = `${y * 100}%`;
  laserDot.classList.add('is-on');
  sendLaser(x, y);
});
nowMirror.frame.addEventListener('pointermove', (ev) => {
  if (!laserDragging) return;
  ev.preventDefault();
  const [x, y] = laserPoint(ev);
  lastLaserPoint = [x, y];
  laserDot.style.left = `${x * 100}%`;
  laserDot.style.top = `${y * 100}%`;
  sendLaser(x, y);
});
const endLaserDrag = (ev) => {
  if (!laserDragging) return;
  laserDragging = false;
  laserDot.classList.remove('is-on');
  bus?.send({ t: 'laser', on: false });
  try { nowMirror.frame.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
};
nowMirror.frame.addEventListener('pointerup', endLaserDrag);
nowMirror.frame.addEventListener('pointercancel', endLaserDrag);

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
  const timer = currentTimer();
  const id = timer?.id;
  if (timer?.running) send({ op: 'timer', action: 'pause', id });
  else if ((timer?.remainingMs || 0) > 0) send({ op: 'timer', action: 'resume', id });
  else send({ op: 'timer', action: 'start', id, seconds: Number($('#timer-mins').value) * 60, label: $('#timer-label').value });
});
$('#timer-stop').addEventListener('click', () => send({ op: 'timer', action: 'stop', id: currentTimer()?.id }));

$('#timer-show').addEventListener('click', () => {
  const timer = currentTimer();
  // Carries the id, so this panel keeps showing THIS clock even once another
  // is selected here - which is the whole point of having more than one.
  stage({ type: 'timer', title: timer?.label || 'Timer', timerId: timer?.id, label: timer?.label || '' });
});

$('#timer-add').addEventListener('click', () => {
  if ((state.timers?.length || 0) >= MAX_TIMERS) return;
  // Named here rather than on the display, so this controller can select the
  // new timer immediately instead of waiting a round trip to learn its id.
  const id = `t${uid(6)}`;
  currentTimerId = id;
  send({ op: 'timer', action: 'add', id, label: $('#timer-label').value, seconds: Number($('#timer-mins').value) * 60 });
});

$('#timer-remove').addEventListener('click', () => {
  const id = currentTimer()?.id;
  if (!id || state.timers?.[0]?.id === id) return;
  send({ op: 'timer', action: 'remove', id });
  currentTimerId = state.timers?.[0]?.id || null;
});
// Delegated: a loaded plan replaces these buttons with its own saved timers,
// so binding the ones in the markup would leave the plan's dead.
$('#timer-presets').addEventListener('click', (ev) => {
  const b = ev.target.closest('.timer-preset');
  if (!b) return;
  $('#timer-mins').value = b.dataset.mins;
  if (b.dataset.label) $('#timer-label').value = b.dataset.label;
  const timer = currentTimer();
  send({ op: 'timer', action: 'start', id: timer?.id, seconds: Number(b.dataset.mins) * 60, label: b.dataset.label || $('#timer-label').value });
  stage({ type: 'timer', title: b.dataset.label || 'Timer', timerId: timer?.id, label: b.dataset.label || '' });
});

$('#ink-undo').addEventListener('click', () => {
  ink.strokes.pop();
  redrawPad();
  send({ op: 'ink', action: 'undo' });
});
$('#ink-clear').addEventListener('click', () => {
  // Through holdInk, not a bare assignment: the cache holds the array by
  // reference, so replacing it here would leave the old strokes cached and
  // bring them back the moment you flipped away and back again.
  holdInk(inkSurface, []);
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
  const paged = ['pdf', 'slides', 'web', 'deck'].includes(focusedItem(state)?.type);
  if (!paged) return;
  if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ') { ev.preventDefault(); send({ op: 'nav', dir: 'next' }); }
  if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); send({ op: 'nav', dir: 'prev' }); }
  if (ev.key === 'b' || ev.key === 'B') { ev.preventDefault(); send({ op: 'blank' }); }
  if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); send({ op: 'freeze' }); }
});

window.addEventListener('resize', () => { if (!$('[data-panel="ink"]').hidden && !ink.drawing) sizePad(); });
window.addEventListener('beforeunload', () => bus?.close());
setInterval(() => { renderNow(); renderTimers(); renderConnection(); }, 250);

// Is this tab itself the stale one? Reloading a page that a cache is still
// answering for can leave you reloading forever without moving, so the
// button below bypasses it explicitly rather than hoping.
servedBuild().then((served) => {
  if (served === null || served === BUILD) return;
  $('#update-detail').textContent = `Running build ${BUILD}; the server is serving build ${served}.`;
  $('#update-banner').hidden = false;
});
$('#update-reload').addEventListener('click', () => {
  // A cache-busting query on the page URL forces the HTML - and with it the
  // module graph hanging off it - to come from the server rather than from
  // whatever this browser decided to keep.
  const url = new URL(location.href);
  url.searchParams.set('fresh', Date.now().toString(36));
  location.replace(url);
});

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

$('#plan-file').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  // Cleared so picking the same file twice in a row still fires a change.
  ev.target.value = '';
  if (!file) return;
  $('#plan-note').textContent = `Reading ${file.name}…`;
  try {
    const { plan, warnings } = readPlan(await readFileText(file));
    await adoptPlan(plan);
    await loadLibrary();
    tab('library');
    // A plan that half-loaded is worse than one that did not: say what was
    // dropped, here, rather than letting a missing photo surface on the wall.
    if (warnings.length) {
      $('#plan-note').textContent = `Loaded “${plan.title}”, with ${warnings.length} problem${warnings.length === 1 ? '' : 's'}: ${warnings.join(' ')}`;
    }
  } catch (err) {
    $('#plan-note').textContent = `That file did not load: ${err.message}`;
  }
});

$('#plan-clear').addEventListener('click', async () => {
  currentPlan = null;
  assetStore.clear();
  assetsSent.clear();
  try { await clearCurrentPlan(); } catch { /* nothing was stored */ }
  renderPlanBar();
  renderTimerPresets();
  await loadLibrary();
});

if (!isConfigured(cfg)) {
  showSetup();
} else {
  $('#app').hidden = false;
  $$('.relay-target').forEach((n) => { n.textContent = relayTarget(cfg); });
  // A createBus that rejects - no Web Crypto over plain http, a blocked CDN for
  // the transport adapter, a relay URL that is not a URL - used to take the
  // rest of this module with it (top-level await), so the library never loaded
  // and the controller came up as a blank frame with no explanation. Say what
  // happened and carry on: everything below still works offline.
  try {
    await connect();
  } catch (err) {
    setStatus('error', err?.message || String(err));
  }
  // A plan loaded before class survives a reload: the tablet is the device most
  // likely to be locked, picked up and reopened in the middle of a lecture, and
  // losing the running order at that moment would be the worst time for it.
  // Restored without applying its layout - see adoptPlan.
  try {
    const saved = await loadCurrentPlan();
    if (saved) await adoptPlan(saved, { persist: false, applyToDisplay: false });
  } catch { /* no IndexedDB (Safari private browsing): the Library still works */ }
  renderPlanBar();
  renderTimerPresets();
  await loadLibrary();
  tab('library');
  renderAll();
}
