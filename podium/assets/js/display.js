// The display: one browser tab on the classroom PC, fullscreen, showing only
// what a controller tells it to.
//
// It holds the single authoritative state, applies incoming commands, and
// broadcasts the result. Panel A's two content layers alternate between
// program and preview so that TAKE swaps which one is visible instead of
// rebuilding it - a cued video keeps its playhead and a cued page keeps its
// scroll position. A layout can split the screen into up to four panels
// (see LAYOUTS in protocol.js); B/C/D are simpler; set directly, no preview.

import {
  $, $$, el, uid, throttle, wireDangerButton, wireRevealButtons, servedBuild, createRelayLog, installOfflineShell,
  enterFullscreen, exitFullscreen, toggleFullscreen, isFullscreen, onFullscreenChange,
  safeStorageSet,
} from './util.js';
import {
  loadConfig, saveConfig, isConfigured, pairingUrl, relayTarget, resetDevice, reloadClean, DEFAULTS, pollBaseUrl, pollJoinUrl,
  viewerConfig, viewerUrl,
} from './config.js';
import { createBus } from './bus.js';
import {
  initialState, applyCommand, inkSurfaceKey, inkDigest, LAYOUTS, PANEL_COUNT, timerById, BUILD, VERSION, versionStamp,
  inkTargetKey, isHeldInkKey, heldInkCount, HELD_INK_PREFIX,
  watermarkForNewLecture, viewerState, viewChannel, stripDeckNotes,
  MUSIC_DUCK, MUSIC_DUCK_MS, MUSIC_PAUSE_MS, SET_TICK_MS, clearStaleMusic, liveInkSurfaces, inkCapturesFor, MEDIA_TYPES,
} from './protocol.js';
import { createRenderer, itemTitle, TYPES, blessMediaElements } from './renderers.js';
import { initTheme, onThemeChange, setThemeChoice, THEME_KEY } from './theme.js';
import { encodeToFit } from './store.js';
import { MAX_ASSET_CHARS, itemForStage, readPlan } from './planfile.js';
import { createCameraReceiver, createMicReceiver } from './rtc.js';
import { serverInfo } from './server.js';
import { createAssetResolver } from './assets.js';
import { deckId } from './deck.js';
import { assetRefsIn } from './deck-source.js';
import { createCaptionLog } from './caption-log.js';
import { canRecordScreen, requestScreen, createScreenRecorder } from './screen-record.js';
import { createDocReader } from './doc-reader.js';
import { createDurationProber } from './duration-probe.js';
import { makeSigningKey, importSigningKey, importVerifyKey, signText, verifyText } from './crypto.js';

const HEARTBEAT_MS = 2000;
const TELEMETRY_MS = 400;

// One-time warning that this browser stopped saving something (Issue #116) -
// most of all saveStateNow()'s crash-recovery snapshot, which is what makes a
// reload or a crash mid-lecture recoverable at all. Registered before
// anything else runs, since setup below can itself be the first write to
// fail - a listener added later would miss that report entirely
// (reportStorageFailure only ever fires once per page). It never fades like
// #hud does: there is nothing to reconnect to, the risk lasts until the tab
// closes.
window.addEventListener('podium:storage-failed', () => { $('#storage-warn').hidden = false; });

const stage = $('#stage');
const inkCanvas = $('#ink');
const blankEl = $('#blank');
const overlayEl = $('#overlay');
const watermarkEl = $('#watermark');
const watermarkImgEl = $('#watermark-img');
const watermarkTextEl = $('#watermark-text');
const laserEl = $('#laser');
const spotlightEl = $('#spotlight');
const hud = $('#hud');
const standby = $('#standby');
const setupEl = $('#setup');
const armEl = $('#arm');

// Guest View (Issue #150): view.html runs this same file as a VIEWER - the
// same renderers, ink, layouts, watermark and captions, fed from the signed
// snapshots a live display sends its view channel, never from controllers.
// Everything a viewer must not do (record, broadcast, save, answer the room,
// take keyboard shortcuts, arm) is switched off where it happens, by this.
const VIEWER = document.body.dataset.viewer === 'yes';
// Guest View's own pace for a document (Issue #240): only for a viewer.
const docReader = VIEWER ? createDocReader({ getSource: (item) => getDeckSource(item) }) : null;

let cfg = VIEWER ? viewerConfig() : await loadConfig();

// The look of this screen's own sheets - Go live, pairing, setup, standby -
// light or dark (Issue #210): the same choice as every other Podium page in
// this browser (see theme.js), outside the connection config so a change never
// needs Save or a reconnect. The stage itself is never themed: see the CSS.
// A choice made here before there was one shared choice carries over, once.
try {
  const before = localStorage.getItem('podium.display.sheetTheme');
  if (localStorage.getItem(THEME_KEY) === null && (before === 'light' || before === 'dark')) localStorage.setItem(THEME_KEY, before);
} catch { /* storage blocked: this screen follows the computer */ }
// A viewer's phone has nobody signed in to ask about.
initTheme({ apply: false, account: !VIEWER });
onThemeChange((effective, choice) => {
  document.body.dataset.sheetTheme = effective;
  if ($('#d-sheet-theme')) $('#d-sheet-theme').value = choice;
});
$('#d-sheet-theme')?.addEventListener('change', (ev) => { setThemeChoice(ev.target.value); });
let bus = null;
let state = initialState();
let cameraStream = null;
let wakeLock = null;

if (!VIEWER) restoreInk();

// Marp decks the display has the markdown for. A deck loaded from the server is
// fetched here directly; one uploaded from an iPad arrives over the bus and is
// kept so that stepping through slides needs no further traffic.
const deckStore = new Map();
const deckFetches = new Map();
const deckWanted = new Set();

function getDeckSource(item) {
  if (!item?.deckId) return null;
  if (deckStore.has(item.deckId)) return deckStore.get(item.deckId);

  if (item.src) {
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

  // Uploaded from a controller: ask whoever has it to send it over.
  deckWanted.add(item.deckId);
  bus?.send({ t: 'deck-need', id: item.deckId });
  return null;
}

// Photos that arrived inside a lecture plan (see planfile.js). Exactly the
// deck arrangement: the controller holds the bytes, this screen asks for the
// ones it does not have, and an item refers to one by `asset:<id>` rather than
// carrying it. That indirection is not incidental - the item lives in `state`,
// which is broadcast to every controller twice a second, and it is the key ink
// surfaces are addressed by. A data URL inline would make both enormous.
//
// Shared with control.js (Issue #124) - see assets.js. resolveAssets() is
// called only where an item is handed to a RENDERER, never on the way into
// `state`: resolving it any earlier would make this screen's ink surface keys
// and layer keys disagree with every controller's.
const { store: assetStore, wanted: assetWanted, want: wantAsset, resolveAssets } = createAssetResolver(() => bus);

// Issue #120: unlike control.js's own assetStore (pruned on photo-drop and on
// leaving a plan - see forgetPlanAssets/addPhoto there), this one only ever
// grew - every photo, camera still and watermark shown over a session that is
// meant to stay open for hours accumulated here with no way out.
//
// A count cap rather than a byte budget, matching the same choice control.js
// already made for its own photo strip (MAX_PHOTOS): simpler, and a data URL
// downscaled for the relay is already capped small (see MAX_ASSET_CHARS in
// planfile.js) so a count cap bounds total memory closely enough.
//
// Never evicts anything actually referenced right now - the current/cued
// item on every panel, or the watermark - even if that pushes the store
// briefly over the cap; only what nothing on screen needs any more. Losing
// something NOT currently shown is harmless either way: resolveAssets() and
// the 'asset'/'asset-need' exchange above already treat a cache miss as
// normal and just ask again, the same tolerance that makes a controller
// reloading mid-lecture work at all.
// Overridable so an e2e test can prove eviction without staging 40+ photos
// to reach it - unset in production, where this is always exactly 40.
const MAX_ASSET_ENTRIES = Number(window.__PODIUM_TEST_MAX_ASSET_ENTRIES__) || 40;

function referencedAssetIds() {
  const ids = new Set();
  const note = (item) => {
    if (item?.src?.startsWith?.('asset:')) ids.add(item.src.slice(6));
  };
  note(state.program);
  note(state.preview);
  for (const panel of state.panels) note(panel);
  // A deck's own pictures, when it keeps them in a lecture plan (Issue #226).
  for (const item of [state.program, state.preview, ...state.panels]) {
    if (item?.type !== 'deck' || !deckStore.has(item.deckId)) continue;
    for (const id of assetRefsIn(deckStore.get(item.deckId))) ids.add(id);
  }
  if (state.watermark?.image?.startsWith('asset:')) ids.add(state.watermark.image.slice(6));
  return ids;
}

function pruneAssetStore() {
  if (assetStore.size <= MAX_ASSET_ENTRIES) return;
  const keep = referencedAssetIds();
  // Map iterates oldest-inserted first, same "oldest first out" rule
  // control.js's own photo strip already uses.
  for (const id of assetStore.keys()) {
    if (assetStore.size <= MAX_ASSET_ENTRIES) break;
    if (keep.has(id)) continue;
    assetStore.delete(id);
  }
}
// A Map's size is not sensitive - this is here purely so an e2e test can
// observe eviction actually happening, the same reason the cap above is
// overridable.
window.__podiumAssetStoreSize = () => assetStore.size;

// A controller can be mid-reload when we ask, so keep asking for a while.
setInterval(() => {
  for (const id of deckWanted) {
    if (deckStore.has(id)) { deckWanted.delete(id); continue; }
    bus?.send({ t: 'deck-need', id });
  }
  for (const id of assetWanted.keys()) {
    if (assetStore.has(id)) { assetWanted.delete(id); continue; }
    wantAsset(id);
  }
  pruneAssetStore();
}, 3000);

// --- content layers, split across up to four panels ------------------------
//
// Panel A keeps the original two-layer program/preview alternation - TAKE
// swaps which one is visible instead of rebuilding it, so a cued video keeps
// its playhead and a cued page keeps its scroll position - just confined to
// its own region of the screen instead of the whole stage once a layout
// splits it. B/C/D (see LAYOUTS in protocol.js) are deliberately simpler:
// one layer each, set directly and immediately from state.panels with no
// preview to cue into first, since splitting the screen is "lay out what's
// on it", not a reveal freeze is meant to protect.

const EXTRA_PANEL_IDS = ['b', 'c', 'd'];

function makeSlot(id) {
  const slot = el('div', { class: 'panel-slot' });
  slot.dataset.panel = id;
  stage.append(slot);
  return slot;
}

const slotA = makeSlot('a');
slotA.classList.add('is-on'); // panel A is always shown, in every layout
const layers = [0, 1].map(() => {
  const node = el('div', { class: 'layer' });
  slotA.append(node);
  return { node, key: null, renderer: null };
});

const extraLayers = EXTRA_PANEL_IDS.map((id) => {
  const slot = makeSlot(id);
  const node = el('div', { class: 'layer' });
  node.dataset.role = 'program';
  slot.append(node);
  return { slot, node, key: null, renderer: null };
});

function freeLayer(layer) {
  if (soundBlocked.delete(layer.key)) broadcastSoon();
  layer.renderer?.destroy();
  layer.renderer = null;
  layer.key = null;
  layer.node.replaceChildren();
}

let cameraStatus = 'idle';

// Items on screen whose sound this browser refused to play (it wants a click
// on this page first - Safari, mostly). The controllers say so, since nobody
// is looking at the projector's own tab to find out.
const soundBlocked = new Set();

// A clip that reaches its own end, unlooped, pauses itself in the DOM but
// nothing in `state` ever hears about it - so `item.playing` stays true
// (nobody pressed pause) and the next reconcile() that comes along for any
// unrelated reason calls play() again, restarting it from wherever a fresh
// play() lands: indistinguishable from the loop nobody asked for. Marking it
// played-out here, once, the moment it actually happens, is what makes
// "stops when it's over" the default instead of "may or may not restart
// depending on what else happens to broadcast next."
function handleMediaEnded(key) {
  if (!key) return;
  const item = state.program?.key === key ? state.program
    : state.preview?.key === key ? state.preview
    : state.panels.find((p) => p?.key === key);
  if (!item || item.playing === false) return;
  item.playing = false;
  commit();
}

function mount(layer, item) {
  freeLayer(layer);
  layer.key = item.key;
  const key = item.key;
  layer.renderer = createRenderer(resolveAssets(item), {
    getTimer: (id) => timerById(state, id),
    // Only renderSet actually calls this - resolveAssets is applied to
    // everything else's item right here, but a set's own entries are nested
    // inside it, out of reach of this one call.
    resolveAssets,
    // The real thing, not a broadcast echo of it: this screen owns the
    // <audio> element, so a track-countdown item reads it directly rather
    // than waiting a heartbeat to hear its own number back.
    getMusicNow: () => ({
      hasTrack: state.music.tracks.length > 0,
      time: musicEl.currentTime || 0,
      duration: Number.isFinite(musicEl.duration) ? musicEl.duration : 0,
      queueRemaining: getQueueRemaining(),
    }),
    getStream: () => cameraStream,
    getCameraStatus: () => cameraStatus,
    getFrozen: () => state.frozen,
    getDeckSource,
    // A deck's contentAspect() only has a real answer once it finishes
    // mounting (Marp parse + fetch, genuinely slow for a real lecture deck's
    // theme and fonts). Ink applied before then was drawn against
    // contentRectFor()'s no-letterbox fallback; redoing it now that the real
    // box is known is what makes that self-correct instead of staying
    // wrong for the rest of the item's time on screen.
    onReady: () => redrawInk(true),
    // A document gliding to a new place (Issue #240): its ink goes with it.
    onScroll: () => redrawInk(),
    onEnded: () => handleMediaEnded(key),
    onSoundBlocked: (blocked) => {
      if (blocked === soundBlocked.has(key)) return;
      if (blocked) soundBlocked.add(key); else soundBlocked.delete(key);
      broadcastSoon();
    },
    getPollJoinUrl: (pollId) => pollJoinUrl(cfg, pollId),
    // Where check-in's code is asked for (Issue #256): the server this display
    // talks to, or the one that served it.
    getServerBase: () => pollBaseUrl(cfg) || new URL('/', location.href).href,
  });
  layer.node.append(layer.renderer.el);
}

function syncLayers() {
  const wanted = [
    { item: state.program, role: 'program' },
    { item: state.preview, role: 'preview' },
  ].filter((w) => w.item);

  // Match items to the layers already holding them. A layer that keeps its key
  // across a TAKE is simply relabelled, which is what preserves its state.
  const claimed = new Set();
  for (const want of wanted) {
    want.layer = layers.find((l) => l.key && l.key === want.item.key && !claimed.has(l));
    if (want.layer) claimed.add(want.layer);
  }
  for (const layer of layers) {
    if (!claimed.has(layer) && layer.key) freeLayer(layer);
  }
  for (const want of wanted) {
    if (!want.layer) {
      want.layer = layers.find((l) => !claimed.has(l));
      claimed.add(want.layer);
      mount(want.layer, want.item);
    } else {
      want.layer.renderer.update(resolveAssets(want.item));
    }
    want.layer.node.dataset.role = want.role;
  }
  for (const layer of layers) {
    if (!claimed.has(layer)) layer.node.dataset.role = 'idle';
  }

  // The master (state.volume) scales the content channel's own level
  // (state.contentVolume) rather than replacing it - the Mixer tab sets a
  // clip's level once, the bottom bar's single fader is what reaches "too
  // loud, turn it all down" without a tab switch. See musicTarget() for the
  // same relationship on the music channel.
  const audio = { volume: state.volume * state.contentVolume, muted: state.muted };
  for (const want of wanted) {
    if (want.role === 'preview') {
      // A cued clip is silent and parked, so it does not drift out of sync
      // with the moment you eventually take it.
      want.layer.renderer.reconcile({ ...resolveAssets(want.item), playing: false }, { volume: 0, muted: true });
    } else {
      want.layer.renderer.reconcile(resolveAssets(want.item), audio);
    }
  }

  // Issue #110: picture-in-picture shows exactly two of the (up to four)
  // independently staged panes - one full screen (main), one as a small
  // bordered inset - decided by role rather than by panel count the way
  // every other layout decides visibility. A pane that is neither stays
  // mounted underneath regardless, same as an unfocused tab, ready the
  // instant either role picks it - see LAYOUTS.pip's own comment for why
  // it reports 4.
  const isPip = state.layout === 'pip';
  const CORNERS = ['tl', 'tr', 'bl', 'br'];
  const applyPipRole = (slot, isMain, isInset) => {
    slot.classList.toggle('is-pip-main', isMain);
    slot.classList.toggle('is-pip-inset', isInset);
    for (const corner of CORNERS) slot.classList.toggle(`corner-${corner}`, isInset && state.pip.corner === corner);
    slot.style.width = isInset ? `${state.pip.size}%` : '';
    slot.style.height = isInset ? `${state.pip.size}%` : '';
  };

  // Panel A is always mounted (it is where the arming/standby screen itself
  // lives before anything is picked); only its visibility is new here.
  const aIsMain = isPip && state.pip.main === 'A';
  const aIsInset = isPip && state.pip.inset === 'A';
  slotA.classList.toggle('is-on', !isPip || aIsMain || aIsInset);
  applyPipRole(slotA, aIsMain, aIsInset);

  // B/C/D: only as many as the current layout actually shows.
  const panelCount = LAYOUTS[state.layout] || 1;
  const PANEL_LETTERS = ['B', 'C', 'D'];
  extraLayers.forEach((layer, i) => {
    const item = i + 1 < panelCount ? state.panels[i] : null;
    const letter = PANEL_LETTERS[i];
    const isMain = isPip && state.pip.main === letter;
    const isInset = isPip && state.pip.inset === letter;
    layer.slot.classList.toggle('is-on', !!item && (!isPip || isMain || isInset));
    applyPipRole(layer.slot, isMain, isInset);
    if (!item) { if (layer.key) freeLayer(layer); return; }
    if (layer.key !== item.key) mount(layer, item);
    else layer.renderer.update(resolveAssets(item));
    // The room's sound stays with panel A even when it is not the focused
    // one - two panels both playing audio at once would just be noise, and
    // there is no "cue" step here to decide which one meant to be heard.
    layer.renderer.reconcile(resolveAssets(item), { volume: 0, muted: true });
  });

  stage.className = `layout-${state.layout}`;
}

// Panel A's own renderer is whichever of its two layers is actually on
// screen right now.
function programRenderer() {
  return layers.find((l) => l.node.dataset.role === 'program')?.renderer;
}

// Whichever slot/renderer/item `state.focus` currently points at - what
// Next/Prev, transport, Ink, and the laser pointer all address. Panel A's
// item is never the frozen preview, matching focusedItem() in protocol.js.
function focusedPanel() {
  if (state.focus === 0) return { item: state.program, slot: slotA, renderer: programRenderer() };
  const layer = extraLayers[state.focus - 1];
  return { item: state.panels[state.focus - 1], slot: layer?.slot, renderer: layer?.renderer };
}

// --- ink overlay ------------------------------------------------------------
//
// Strokes are stored as fractions (0..1) of the CONTENT area, not the raw
// browser window: a 16:9 deck slide inside a wider or taller window is
// letterboxed, and without this an iPad's flat rectangle of a pad would not
// correspond to where the slide actually sits, letting you "draw" into the
// dead space around it. contentRectFor() below is the one place that math
// happens; the pad on the controller mirrors the same content aspect so its
// whole drawing surface really is the slide, edge to edge.

const ink = { ctx: inkCanvas.getContext('2d'), drawnKey: null, drawnStrokes: 0, drawnTail: 0 };

// Where a panel's meaningful content sits, in CSS pixels relative to the
// STAGE (not the panel itself) - the one #ink canvas covers the whole stage
// regardless of how it is split, so every panel's strokes need to land in
// its own on-screen region, not all drawn from (0,0). Letterboxed within
// that region for anything with a fixed aspect ratio; the whole region for
// everything else, which is exactly how those render.
// Where ink is drawn for a panel: its content box, or for a document the
// whole page wherever it has scrolled to (Issue #240), so the strokes stay on
// the text. The laser and the spotlight point at the screen, not the page,
// and keep using contentRectFor itself.
function inkRectFor(slot, renderer) {
  // A zoomed page or photo (Issue #262): ink is in fractions of the content,
  // so it goes wherever the zoomed content is - bigger than the panel and
  // partly off it, clipped to the panel when drawn (see slotRectFor).
  if (renderer?.viewRect && slot) {
    const zoomed = renderer.viewRect(slotRectFor(slot));
    if (zoomed) return zoomed;
  }
  const rect = contentRectFor(slot, renderer);
  return renderer?.pageRect ? renderer.pageRect(rect) : rect;
}

/** A panel's own box, in the ink canvas's coordinates. */
function slotRectFor(slot) {
  const stageBox = stage.getBoundingClientRect();
  const box = slot.getBoundingClientRect();
  return { x: box.left - stageBox.left, y: box.top - stageBox.top, w: box.width, h: box.height };
}

// Strokes on zoomed content can reach past their panel: drawn inside it only.
function clipped(ctx, slot, renderer, draw) {
  if (!renderer?.viewRect || !slot || !renderer.viewRect(slotRectFor(slot))) { draw(); return; }
  const r = slotRectFor(slot);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  try { draw(); } finally { ctx.restore(); }
}

function contentRectFor(slot, renderer) {
  if (!slot) return { x: 0, y: 0, w: 0, h: 0 };
  const stageBox = stage.getBoundingClientRect();
  const box = slot.getBoundingClientRect();
  const w = box.width;
  const h = box.height;
  const ox = box.left - stageBox.left;
  const oy = box.top - stageBox.top;
  const aspect = renderer?.contentAspect?.() ?? null;
  if (!aspect || !w || !h) return { x: ox, y: oy, w, h };
  const boxAspect = w / h;
  if (boxAspect > aspect) {
    const cw = h * aspect;
    return { x: ox + (w - cw) / 2, y: oy, w: cw, h };
  }
  const ch = w / aspect;
  return { x: ox, y: oy + (h - ch) / 2, w, h: ch };
}

// Every panel currently on screen (A always; B/C/D per the layout), each
// with its own item, slot, and mounted renderer - what both redrawInk() and
// wireState()'s telemetry lean on to treat "one panel" and "the whole
// display used to be" the same shape of problem.
function activePanels() {
  const panelCount = LAYOUTS[state.layout] || 1;
  const list = [{ item: state.program, slot: slotA, renderer: programRenderer() }];
  extraLayers.forEach((layer, i) => {
    if (i + 1 < panelCount) list.push({ item: state.panels[i], slot: layer.slot, renderer: layer.renderer });
  });
  return list;
}

// The canvas's backing store is in DEVICE pixels, so it depends on both the
// stage size and devicePixelRatio - and not everything that can invalidate
// it is an event we get told about. A window dragged from a laptop screen
// onto a projector of a different pixel density changes devicePixelRatio
// with no resize event at all, and a canvas still scaled for the old ratio
// then paints every stroke at the wrong size: on a 2x laptop driving a 1x
// projector, ink lands at double the distance from the corner, nowhere near
// the slide it was drawn on. So rather than chase every possible trigger,
// check the invariant at the one moment it has to hold - just before
// drawing. Returns true when it had to re-size, which wipes the canvas and
// means there is nothing left to incrementally append to.
function ensureInkCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const w = Math.round(stage.clientWidth * ratio);
  const h = Math.round(stage.clientHeight * ratio);
  if (inkCanvas.width === w && inkCanvas.height === h) return false;
  inkCanvas.width = w;
  inkCanvas.height = h;
  // Assigning width/height resets the context - transform included - so the
  // device-pixel scaling has to go back on afterwards, every time.
  ink.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return true;
}

function sizeInk() {
  ensureInkCanvas();
  redrawInk(true);
}

// devicePixelRatio changes do not reliably fire resize, but they DO change
// what this media query matches - it is the one signal that fires exactly
// when the ratio does. It has to be re-armed each time, since the query can
// only ask about one specific ratio.
function watchPixelRatio() {
  try {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', () => { sizeInk(); broadcastSoon(); watchPixelRatio(); }, { once: true });
  } catch { /* the check before every redraw covers it regardless */ }
}
watchPixelRatio();

// This screen is the one nobody looks at, and the one most likely to have
// been left open since before a deploy - so it states its build in Settings,
// reports it to controllers (see wireState), and checks on load whether the
// copy it is running is one the server has already replaced.
// Not on view.html, which has no Settings sheet to put it in.
if (!VIEWER) {
  $('#version-number').textContent = VERSION;
  $('#build-number').textContent = String(BUILD);
}
const displayStamp = $('#display-version-stamp');
if (displayStamp) displayStamp.textContent = versionStamp();
servedBuild().then((served) => {
  if (VIEWER || served === null || served === BUILD) return;
  $('#build-check').textContent = ` — but the server is serving build ${served}, so this page came from a cache. Reload it.`;
  $('#build-note').classList.add('is-stale');
  // Deliberately NOT setHud('error'): the HUD is the RELAY's channel, and a
  // stale page reported there reads as "Cannot reach the relay: Running build
  // 3..." - which is a lie about the network, told at exactly the moment
  // someone is trying to debug the network. Version news gets its own line.
  $('#arm-build').textContent = `This page is build ${BUILD} but the server has ${served} — reload it.`;
  $('#arm-build').hidden = false;
});

function strokePath(ctx, stroke, rect, from = 0) {
  if (stroke.pts.length < 2) return;
  ctx.save();
  if (stroke.highlighter) {
    ctx.globalAlpha = 0.35;
  }
  ctx.beginPath();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const start = Math.max(0, from - 1);
  ctx.moveTo(rect.x + stroke.pts[start][0] * rect.w, rect.y + stroke.pts[start][1] * rect.h);
  for (let i = start + 1; i < stroke.pts.length; i++) {
    ctx.lineTo(rect.x + stroke.pts[i][0] * rect.w, rect.y + stroke.pts[i][1] * rect.h);
  }
  ctx.stroke();
  ctx.restore();
}

function currentInkStrokes() {
  return state.ink.bySurface[inkSurfaceKey(state.program)]?.strokes || [];
}

// A split screen redraws every visible panel's ink in one pass rather than
// keeping the single-panel incremental "just append the new points" fast
// path working across several surfaces at once - simpler, and drawing
// during a lecture split across panels is not the same hot-loop-per-stroke
// case that optimization exists for.
function redrawSplitInk() {
  const { ctx } = ink;
  ctx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
  let any = false;
  for (const panel of activePanels()) {
    const rect = inkRectFor(panel.slot, panel.renderer);
    const strokes = state.ink.bySurface[inkSurfaceKey(panel.item)]?.strokes || [];
    clipped(ctx, panel.slot, panel.renderer, () => { for (const stroke of strokes) strokePath(ctx, stroke, rect); });
    if (strokes.length) any = true;
  }
  // This path paints panel A somewhere quite different (a quarter of the
  // screen, in a 4-panel layout) and keeps no incremental bookkeeping of its
  // own. Leaving the single-panel cache intact would let the very next
  // single-layout redraw decide nothing had changed and just append to what
  // is on screen - keeping this smaller rendering, at this smaller scale,
  // forever. Dropping the cache forces that redraw to be a full one.
  ink.drawnKey = null;
  ink.drawnStrokes = 0;
  ink.drawnTail = 0;
  inkCanvas.classList.toggle('has-ink', any);
}

// The ink rectangle's shape for every panel on screen, keyed by its surface.
/** Each panel's own shape, keyed by surface: what a zoom fills (Issue #262). */
function slotAspects() {
  const out = {};
  for (const panel of activePanels()) {
    if (!panel.item || !panel.slot) continue;
    const r = slotRectFor(panel.slot);
    if (r.w > 0 && r.h > 0) out[inkSurfaceKey(panel.item)] = Math.round((r.w / r.h) * 10000) / 10000;
  }
  return out;
}

function inkAspects() {
  const out = {};
  for (const panel of activePanels()) {
    if (!panel.item) continue;
    // The box the content shows in, not a document's whole page (its pageRect):
    // the pad is the window onto a document, and maps itself to the page.
    const rect = contentRectFor(panel.slot, panel.renderer);
    if (rect.w > 0 && rect.h > 0) out[inkSurfaceKey(panel.item)] = Math.round((rect.w / rect.h) * 10000) / 10000;
  }
  return out;
}

// Told to controllers as soon as it changes - a photo loading, a video's
// size arriving, a layout change - not at the next two-second heartbeat, so
// a pad waiting on the shape is ready almost at once.
let sentInkAspects = '';
function noteInkAspects() {
  const now = JSON.stringify([inkAspects(), slotAspects()]);
  if (now === sentInkAspects) return;
  sentInkAspects = now;
  // Ink can be redrawn while this file is still starting up, before the
  // throttled broadcaster below exists; the first heartbeat carries it then.
  try { broadcastSoon(); } catch { /* not yet */ }
}

function redrawInk(force = false) {
  noteInkAspects();
  // A canvas that had to be re-sized is a blank one: nothing to append to.
  if (ensureInkCanvas()) force = true;
  if (state.layout !== 'single') { redrawSplitInk(); return; }
  const { ctx } = ink;
  const rect = inkRectFor(slotA, programRenderer());
  const strokes = currentInkStrokes();
  const last = strokes[strokes.length - 1];
  const key = `${inkSurfaceKey(state.program)}|${rect.x.toFixed(1)}|${rect.y.toFixed(1)}|${rect.w.toFixed(1)}|${rect.h.toFixed(1)}`;

  // Appending to the stroke in progress is the common case; only redraw the
  // whole board when strokes were removed, the surface changed, or the
  // content moved (resize, or a letterboxed item changing shape).
  const appended = !force
    && key === ink.drawnKey
    && strokes.length >= ink.drawnStrokes
    && ink.drawnStrokes > 0
    && strokes.length === ink.drawnStrokes
    && !last?.highlighter;

  const renderer = programRenderer();
  if (appended && last) {
    clipped(ctx, slotA, renderer, () => strokePath(ctx, last, rect, ink.drawnTail));
  } else {
    ctx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
    clipped(ctx, slotA, renderer, () => { for (const stroke of strokes) strokePath(ctx, stroke, rect); });
  }
  ink.drawnKey = key;
  ink.drawnStrokes = strokes.length;
  ink.drawnTail = last ? last.pts.length : 0;
  inkCanvas.classList.toggle('has-ink', strokes.length > 0);
}

// --- photographing what is on screen -----------------------------------------
//
// "Take a photo of panel B" and "screenshot the whole thing" are one operation
// over different rectangles: ask each panel's renderer to paint itself into a
// canvas (see snapshot() in renderers.js), lay the real ink canvas over the
// top, and hand the result back as an ordinary photo - one the presenter can
// put straight back on screen later, or export with everything else.
//
// It happens on the DISPLAY because this is the only device that has the
// thing being photographed: the live camera frame, the deck stopped three
// bullets into a build, the ink exactly as the room saw it. A controller only
// ever mirrors those.

const PANEL_LABELS = ['A', 'B', 'C', 'D'];
const SHOT_MAX_WIDTH = 1600;

function panelAt(index) {
  if (index === 0) return { item: state.program, slot: slotA, renderer: programRenderer() };
  const layer = extraLayers[index - 1];
  return layer ? { item: state.panels[index - 1], slot: layer.slot, renderer: layer.renderer } : null;
}

function slotRect(slot) {
  const stageBox = stage.getBoundingClientRect();
  const box = slot.getBoundingClientRect();
  return { x: box.left - stageBox.left, y: box.top - stageBox.top, w: box.width, h: box.height };
}

// A panel nothing can photograph - an embedded page, a PDF in the browser's
// own viewer, a YouTube player. In a whole-screen shot the other panels are
// still worth having, so this says plainly what was in that corner rather
// than leaving a black hole or failing the whole picture.
function drawUnphotographable(ctx, rect, item) {
  ctx.fillStyle = '#14181d';
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = '#97a2b0';
  ctx.textAlign = 'center';
  const size = Math.max(9, Math.round(Math.min(rect.w, rect.h) * 0.06));
  ctx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.fillText(itemTitle(item).slice(0, 40), rect.x + rect.w / 2, rect.y + rect.h / 2 - size * 0.2);
  ctx.font = `${Math.round(size * 0.72)}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.fillText(`${TYPES[item?.type]?.label || item?.type || 'empty'} — not photographable`,
    rect.x + rect.w / 2, rect.y + rect.h / 2 + size);
  ctx.textAlign = 'start';
}

// Why a panel could not be photographed, in terms of the thing that is in it.
// "Podium cannot photograph camera" is technically true and useless; the
// presenter wants to know whether to fix something or stop trying.
function whyNot(panel) {
  const type = panel?.item?.type;
  if (type === 'camera') {
    return panel.renderer?.el?.classList?.contains('has-stream')
      ? 'the camera feed has no frame on screen yet'
      : 'the phone\'s camera has not reached this screen yet — start it on the Camera tab first';
  }
  if (type === 'deck') return 'that slide would not render on its own — a font or an image in it may be blocking it';
  if (type === 'pdf') return 'that PDF page would not render — the document may be unreadable or corrupt';
  const embedded = { web: 'an embedded web page', slides: 'an embedded slide deck', youtube: 'a YouTube player', stream: 'a live stream player' }[type];
  if (embedded) return `${embedded} cannot be photographed — a browser will not let a page read pixels out of a frame it does not own`;
  const known = { text: 'a big-text card', audio: 'an audio player' }[type];
  if (known) return `Podium cannot photograph ${known} yet`;
  return 'Podium cannot photograph what is in that panel';
}

function drawCaption(ctx, rect) {
  const text = state.overlay?.text;
  if (!state.overlay?.visible || !text) return;
  const size = Math.max(10, Math.round(rect.h * 0.055));
  const band = size * 2.4;
  const gradient = ctx.createLinearGradient(0, rect.y + rect.h - band * 1.6, 0, rect.y + rect.h);
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, 'rgba(0,0,0,0.82)');
  ctx.fillStyle = gradient;
  ctx.fillRect(rect.x, rect.y + rect.h - band * 1.6, rect.w, band * 1.6);
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.fillText(text.slice(0, 120), rect.x + rect.w * 0.05, rect.y + rect.h - size * 0.8);
}

/**
 * Photograph one panel (0-3) or the whole stage ('screen').
 *
 * Returns { dataUrl, title, width, height }, or throws with a reason worth
 * showing to whoever pressed the button.
 */
async function takeShot(target, { item: forItem } = {}) {
  ensureInkCanvas();
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  if (!stageW || !stageH) throw new Error('this screen has no size yet');
  // The ink as it is this instant, copied before anything below awaits
  // (Issue #183): a screen kept as it is left is photographed in the same
  // moment the room moves on, and by the time a slide finishes rasterizing
  // the ink layer already belongs to the next one.
  const inkNow = document.createElement('canvas');
  inkNow.width = inkCanvas.width;
  inkNow.height = inkCanvas.height;
  inkNow.getContext('2d').drawImage(inkCanvas, 0, 0);

  const wholeScreen = target === 'screen';
  const panels = wholeScreen ? activePanels() : [panelAt(target)];
  if (!panels[0]?.slot) throw new Error(`panel ${PANEL_LABELS[target] || target} is not on screen`);
  const area = wholeScreen ? { x: 0, y: 0, w: stageW, h: stageH } : slotRect(panels[0].slot);
  // A panel the current layout does not show still HAS a slot; it is just
  // display:none, which measures 0x0. Asking for one (a controller whose idea
  // of the layout is a moment out of date) should say so rather than hand back
  // a one-pixel photo.
  if (!area.w || !area.h) throw new Error(`panel ${PANEL_LABELS[target] || target} is not on screen in this layout`);

  const scale = Math.min(1, SHOT_MAX_WIDTH / area.w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(area.w * scale));
  canvas.height = Math.max(1, Math.round(area.h * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Everything below is written in stage CSS pixels - the same coordinates
  // contentRectFor() and the ink canvas already use - and this transform is
  // what maps them into whatever size this photo turned out to be.
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-area.x, -area.y);

  let painted = 0;
  for (const panel of panels) {
    if (!panel?.slot) continue;
    const rect = slotRect(panel.slot);
    let drew = false;
    try {
      drew = await (panel.renderer?.snapshot?.(ctx, rect) ?? false);
    } catch { /* a slide that would not rasterize: treated as unphotographable */ }
    if (drew) painted += 1;
    else drawUnphotographable(ctx, rect, panel.item);
  }
  if (!painted) throw new Error(whyNot(panels[0]));

  // The ink canvas covers the whole stage and already holds every visible
  // panel's strokes in their own places, so one draw puts the annotation back
  // exactly where it was drawn - no re-mapping, at any layout.
  ctx.drawImage(inkNow, 0, 0, stageW, stageH);
  drawCaption(ctx, { x: 0, y: 0, w: stageW, h: stageH });
  drawWatermark(ctx, { x: 0, y: 0, w: stageW, h: stageH });
  ctx.restore();

  // Deliberately ignores `blank`: a blanked screen is a moment of "eyes on
  // me", not what you meant to keep, and a photo of it would be a black
  // rectangle. Freeze needs no such note - a frozen panel is photographed
  // holding exactly the frame the room is looking at.

  let shrunk;
  try {
    shrunk = encodeToFit(canvas, MAX_ASSET_CHARS);
  } catch {
    // A picture or video from another site, drawn in by a renderer, taints the
    // canvas and the browser refuses to let the page read it back. Nothing can
    // be done about it from here; say which rule was hit rather than "failed".
    throw new Error('the browser will not let Podium read those pixels back — something on screen came from another site without permission to copy it');
  }
  const item = forItem || panels[0]?.item;
  // Photograph a panel, put that photo back in the panel, photograph it again:
  // without this the titles nest ("Panel A - Panel A - Whiteboard") until they
  // are unreadable. One prefix is enough to say where it came from.
  const base = itemTitle(item).replace(/^Panel [A-D] — /, '');
  const title = wholeScreen ? 'Whole screen' : `Panel ${PANEL_LABELS[target]} — ${base}`;
  return { dataUrl: shrunk.dataUrl, title, width: shrunk.width, height: shrunk.height, tooBig: shrunk.tooBig };
}

// --- keeping marked-up screens (Issues #182, #183) ---------------------------
//
// A screen with marks on it is photographed at the moment it stops being what
// the room sees: a paused video starting again (always - the marks were made
// on that frame), or, with "Save marked-up screens" on, any panel moving to
// another slide, page or item. It happens here, on the display, in the same
// instant the command arrives and before anything is redrawn - the only point
// at which the frame, the slide and the ink leaving the screen are all still
// on it. inkCapturesFor (protocol.js) decides which; takeShot does the rest.
//
// The photo goes to every controller like any other (their Photos strip) and,
// while a lecture is being recorded, is filed with it once, by this screen,
// under screens/ - never photos/, which each controller's own Keep photos
// switch governs and a session export reconciles. Except a photo of a camera
// feed or a picture: that can be a person or someone's work on paper, which
// is exactly what Keep photos exists for, so those are left to it.
const inkKept = new Map();   // surface key -> the marks last kept for it
const PRIVATE_SOURCES = new Set(['camera', 'image']);

function keepMarkedUpScreens(before) {
  if (VIEWER) return;
  const plans = inkCapturesFor(before, liveInkSurfaces(state), { autoSave: !!state.autoSaveInk, saved: inkKept });
  for (const plan of plans) {
    inkKept.set(plan.key, plan.sig);
    // Called before commit(): its synchronous part copies the frame, the
    // slide and the ink still on screen, whatever the command just changed.
    const shot = takeShot(plan.panel, { item: plan.item });
    if (plan.clearInk) {
      // Recoverable, the same way a Clear is (see the ink case in protocol.js).
      const surface = state.ink.bySurface[plan.key];
      if (surface?.strokes?.length) {
        surface.cleared = surface.strokes;
        surface.strokes = [];
      }
      inkKept.delete(plan.key);
    }
    shot.then((taken) => sendKeptScreen(plan, taken)).catch(() => { /* nothing photographable there: nothing kept */ });
  }
}

function sendKeptScreen(plan, taken) {
  const id = uid(10);
  const title = `${plan.reason === 'resume' ? 'Paused video' : 'Marked up'} — ${taken.title}`;
  const filed = !!lectureId && !PRIVATE_SOURCES.has(plan.item?.type);
  if (filed) fileKeptScreen(lectureId, id, title, taken.dataUrl);
  bus?.send({ t: 'shot', id, target: plan.panel, title, data: taken.dataUrl, tooBig: !!taken.tooBig, auto: plan.reason, filed });
}

async function fileKeptScreen(id, photoId, title, dataUrl) {
  const ext = dataUrl.startsWith('data:image/png') ? 'png' : 'jpg';
  const safe = String(title).replace(/[^a-z0-9-_ ]+/gi, '').trim().replace(/\s+/g, '-').slice(0, 48) || 'screen';
  const name = `screens/${photoId}-${safe}.${ext}`;
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await fetch(lectureUrl(id, `/files?name=${encodeURIComponent(name)}&kind=photo`), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': blob.type || `image/${ext}` }, body: blob,
    });
  } catch { /* the controllers still have it in their Photos strip */ }
}

// --- background music --------------------------------------------------------
//
// One <audio> element that is never added to the document: the room hears it,
// the projector shows nothing, and no panel is spent on it. It is driven from
// state.music (see protocol.js) exactly the way the panels are driven from
// state.program, so two controllers agree about what is playing and one that
// joins mid-lecture is caught up by the next heartbeat.
//
// Volume is ramped rather than set, everywhere. Music that starts or stops at
// full level in a quiet room is startling, and a clip that begins while music
// is playing should not have to shout over it - so a clip with its own sound
// ducks the music to a whisper and it comes back when the clip finishes.

const musicEl = new Audio();
musicEl.id = 'music';
musicEl.preload = 'auto';
// Its own element, so the room volume applies to CONTENT audio and this has a
// level of its own. Mute is the exception: that button means silence.
musicEl.volume = 0;
// In the document, but with nothing to draw: an <audio> without `controls`
// has no box at all, and `hidden` says so out loud. It is here rather than
// floating loose so that everything about this screen can be inspected the
// same way - by looking at the page.
musicEl.hidden = true;
document.body.append(musicEl);

let musicFade = null;
// Where a ramp in flight is headed. syncMusic runs on every render, so it has
// to be able to tell "the level is already on its way there" from "the level
// is wrong": without that it restarts the fade from wherever it had got to,
// every render, and a three-second fade out lasts as long as the renders do.
let musicFadeTo = -1;
let musicApplied = { src: '', playing: false, target: -1 };
let musicLastSeek = 0;

// Issue #180: one probe per track, a couple at a time - see duration-probe.js.
const { durations: trackDurations, probe: probeTrackDuration } = createDurationProber();

function getQueueRemaining() {
  const music = state.music;
  if (!music?.tracks?.length) return 0;
  const idx = Math.max(0, Math.min(music.index || 0, music.tracks.length - 1));
  const currentTrack = music.tracks[idx];
  const currentDur = (Number.isFinite(musicEl.duration) && musicEl.duration > 0 ? musicEl.duration : null)
    ?? trackDurations.get(currentTrack?.src)
    ?? (typeof currentTrack?.duration === 'number' && Number.isFinite(currentTrack.duration) ? currentTrack.duration : null);
  if (currentDur == null) return null;
  const currentTime = musicEl.currentTime || 0;
  let remaining = Math.max(0, currentDur - currentTime);
  for (let i = idx + 1; i < music.tracks.length; i++) {
    const t = music.tracks[i];
    const d = (typeof t?.duration === 'number' && Number.isFinite(t.duration) ? t.duration : null)
      ?? (trackDurations.has(t?.src) ? trackDurations.get(t?.src) : null);
    if (d == null) return null;
    remaining += d;
  }
  return remaining;
}

function rampMusic(to, ms) {
  clearInterval(musicFade);
  musicFade = null;
  const from = musicEl.volume;
  const target = Math.min(1, Math.max(0, to));
  if (ms <= 0 || Math.abs(target - from) < 0.005) {
    musicEl.volume = target;
    return Promise.resolve();
  }
  const steps = Math.max(1, Math.round(ms / 50));
  let step = 0;
  musicFadeTo = target;
  return new Promise((resolve) => {
    musicFade = setInterval(() => {
      step += 1;
      musicEl.volume = Math.min(1, Math.max(0, from + (target - from) * (step / steps)));
      if (step >= steps) { clearInterval(musicFade); musicFade = null; resolve(); }
    }, 50);
  });
}

// Anything on screen that has its own sound. Not the camera (a document
// camera sends no audio) and not a whiteboard - only the things that would
// actually be competing with the music.
function contentIsSounding() {
  return activePanels().some((panel) => {
    // A set is whichever of its entries is up now - a video in it ducks the
    // music the same as the video on its own would.
    const item = panel.item?.type === 'set' ? panel.item.entries?.[panel.item.index]?.item : panel.item;
    // A stream shown as video only is muted (Issue #175) - not competing.
    if (item?.type === 'stream' && item.show === 'video') return false;
    // A deck counts while its video slide plays (Issue #226).
    if (!MEDIA_TYPES.includes(item?.type) && item?.type !== 'deck') return false;
    return !!panel.renderer?.telemetry?.().playing;
  });
}

function musicTarget() {
  if (state.muted) return 0;
  // The same master that scales the content channel (see syncLayers) scales
  // this one too - one fader for "everything is too loud", each channel's
  // own level set once in the Mixer and mostly left alone.
  return state.music.volume * state.volume * ((contentIsSounding() || micIsSounding()) ? MUSIC_DUCK : 1);
}

// A track that will not play is the single most likely thing to go wrong the
// first time someone points this at their own server - a typo, a file that is
// not there, or an http:// URL inside an https:// page, which browsers block
// as mixed content without a word. Silence with no explanation is the worst
// possible answer, so what happened rides back to the controllers.
let musicError = '';
musicEl.addEventListener('error', () => {
  const track = state.music.tracks[state.music.index];
  const url = track?.src || '';
  musicError = /^http:\/\//i.test(url) && location.protocol === 'https:'
    ? 'that track is an http:// link inside an https:// page, which the browser blocks'
    : 'that track would not load — check the link is right and reachable from this screen';
  broadcastSoon();
});
for (const ok of ['playing', 'loadeddata']) musicEl.addEventListener(ok, () => {
  if (Number.isFinite(musicEl.duration) && musicEl.duration > 0) {
    const track = state.music.tracks[state.music.index];
    if (track?.src) trackDurations.set(track.src, musicEl.duration);
    if (musicEl.src) trackDurations.set(musicEl.src, musicEl.duration);
  }
  if (!musicError) return;
  musicError = '';
  broadcastSoon();
});

function syncMusic() {
  const music = state.music;
  if (Array.isArray(music.tracks)) {
    for (const t of music.tracks) {
      if (t?.src) probeTrackDuration(t.src);
    }
  }
  const track = music.tracks[music.index] || null;
  const src = track ? new URL(track.src, location.href).href : '';

  if (!src) {
    clearInterval(musicFade);
    musicFade = null;
    musicEl.pause();
    musicEl.removeAttribute('src');
    musicApplied = { src: '', playing: false, target: -1 };
    // Nothing queued any more, so a complaint about a track has nothing left
    // to be about.
    if (musicError) { musicError = ''; broadcastSoon(); }
    return;
  }

  const changed = src !== musicApplied.src;
  if (changed) {
    musicEl.src = src;
    musicEl.volume = 0;
    if (!music.playing) {
      clearInterval(musicFade);
      musicFade = null;
      musicFadeTo = -1;
      musicEl.pause();
    }
  }

  if ((music.seekNonce || 0) !== musicLastSeek) {
    musicLastSeek = music.seekNonce || 0;
    if (music.seekTo !== undefined && Number.isFinite(music.seekTo)) {
      const targetTime = music.seekTo;
      try {
        if (musicEl.readyState >= 1) {
          musicEl.currentTime = targetTime;
        } else {
          musicEl.addEventListener('loadedmetadata', () => {
            try { musicEl.currentTime = targetTime; } catch { /* track changed again before it loaded */ }
          }, { once: true });
        }
      } catch { /* track changed again before it loaded */ }
    }
    if (music.playing && musicFade && musicFadeTo <= 0.005) {
      clearInterval(musicFade);
      musicFade = null;
      musicFadeTo = -1;
    }
  }

  const target = musicTarget();
  // What the level will be once everything in flight has finished, which is
  // what a decision about it has to be made against.
  const heading = musicFade ? musicFadeTo : musicEl.volume;

  if (music.playing) {
    if (musicEl.paused || changed) {
      // A play() the browser refuses before Go live is not an error worth
      // showing: the click that arms this screen commits state again, which
      // brings us straight back here. Once the screen IS armed, though, the
      // browser has already granted this origin sound - a rejection at that
      // point means something is actually wrong (a revoked site permission,
      // most likely), and staying silent just leaves Play looking broken with
      // no way to tell why. The 'playing'/'loadeddata' listeners above clear
      // this the moment a play() actually succeeds.
      musicEl.play().then(() => rampMusic(target, music.fadeMs)).catch(() => {
        if (state.armed && !musicError) {
          musicError = 'the browser is blocking sound on this page — check its site permissions';
          broadcastSoon();
        }
      });
    } else if (Math.abs(target - heading) > 0.005) {
      // A duck, an un-duck, the level being dragged on the iPad - or Play
      // pressed during a fade out, which has to catch the level on its way
      // down and bring it back rather than leave it running at silence.
      rampMusic(target, MUSIC_DUCK_MS);
    }
  } else if (!musicEl.paused && !(musicFade && musicFadeTo <= 0.005)) {
    // Not already fading out: start doing so. A fade that is in flight is left
    // strictly alone - see musicFadeTo.
    const fade = music.fadeMs ?? MUSIC_PAUSE_MS;
    rampMusic(0, fade).then(() => { if (!state.music.playing) musicEl.pause(); });
  }

  musicApplied = { src, playing: music.playing, target };
}

// A track running out is the display's own observation, so it goes through
// applyCommand like anything else and is broadcast: every controller's queue
// moves on with it.
musicEl.addEventListener('ended', () => {
  if (VIEWER) return;   // the display moves the queue on; its next snapshot says so
  if (applyCommand(state, { op: 'music', action: 'next', auto: true })) {
    if (!state.music.playing) musicEl.currentTime = 0;
    commit();
  }
});

// Ducking depends on what content is doing, which nothing commits state for -
// so it is re-checked on the same beat that carries playback telemetry.
setInterval(() => {
  if (!state.music.playing) return;
  if (Math.abs(musicTarget() - musicApplied.target) > 0.005) syncMusic();
}, TELEMETRY_MS);

// --- controller mic relay: amplification (Issue #147, part 2) --------------
//
// One <audio> element per connected sender, created and torn down by the
// createMicReceiver callbacks wired up in connect() - unlike background
// music, more than one of these can be live at once (Issue #147 lets
// several controllers have a mic live together), and the browser's own
// audio output already sums whatever plays through several elements
// simultaneously, the same way a room would hear two open mics in
// reality. No separate mixing graph is needed just for that; the Mixer's
// own mic channel below sets every element's volume together, the same
// way musicEl's is set above.
//
// Recording this same audio into the session is the OTHER half of Issue
// #147, and does not touch any of this - see control.js - it runs
// entirely off the controller's own local stream, never routed through
// the display at all.

const micAudioEls = new Map();   // peerId -> <audio>

function micIsSounding() {
  return micAudioEls.size > 0;
}

function micTarget() {
  if (state.muted) return 0;
  return (state.micVolume ?? 1) * state.volume;
}

function syncMicVolumes() {
  const target = micTarget();
  for (const el of micAudioEls.values()) el.volume = target;
}

// --- laser pointer -----------------------------------------------------------
//
// Deliberately outside `state`: a live gesture, not a document. Positions
// arrive already mapped through the controller's own content-shaped preview
// of whichever panel has focus, so the same fraction lands in the same spot
// here via contentRectFor() - that panel's own letterboxed bounds, exactly
// like ink.

let laserHideTimer = null;

// Green reads better than red on a dark slide and on a photograph, blue on a
// bright one; red is the one everybody expects. Whitelisted rather than taking
// the controller's word for a colour, because this value goes into a CSS
// attribute selector and there is no reason for it to be open-ended.
const LASER_COLORS = ['red', 'green', 'blue'];

function showLaser(msg) {
  if (!msg?.on) { hideLaser(); return; }
  const { slot, renderer } = focusedPanel();
  const rect = contentRectFor(slot, renderer);
  laserEl.dataset.color = LASER_COLORS.includes(msg.color) ? msg.color : 'red';
  laserEl.style.left = `${rect.x + (Number(msg.x) || 0) * rect.w}px`;
  laserEl.style.top = `${rect.y + (Number(msg.y) || 0) * rect.h}px`;
  laserEl.classList.add('is-on');
  // A lost "stop" message (a backgrounded tab dropping the pointerup, a
  // dead connection mid-drag) should not leave a dot glowing on the
  // projector for the rest of the lecture.
  clearTimeout(laserHideTimer);
  laserHideTimer = setTimeout(hideLaser, 1500);
}

function hideLaser() {
  clearTimeout(laserHideTimer);
  laserEl.classList.remove('is-on');
}

// --- spotlight ---------------------------------------------------------------
//
// Dims the slide background with a dark backdrop while leaving a bright circular
// aperture centered on the presenter's touch. Like laser, deliberately outside
// `state`: a live gesture that auto-vanishes on release or inactivity.

let spotlightHideTimer = null;

function showSpotlight(msg) {
  if (!msg?.on) { hideSpotlight(); return; }
  const { slot, renderer } = focusedPanel();
  const rect = contentRectFor(slot, renderer);
  const px = rect.x + (Number(msg.x) || 0) * rect.w;
  const py = rect.y + (Number(msg.y) || 0) * rect.h;
  const radius = Math.max(80, Math.round(Math.min(rect.w, rect.h) * 0.18));
  spotlightEl.style.setProperty('--spotlight-x', `${px}px`);
  spotlightEl.style.setProperty('--spotlight-y', `${py}px`);
  spotlightEl.style.setProperty('--spotlight-radius', `${radius}px`);
  spotlightEl.classList.add('is-on');
  clearTimeout(spotlightHideTimer);
  spotlightHideTimer = setTimeout(hideSpotlight, 1500);
}

function hideSpotlight() {
  clearTimeout(spotlightHideTimer);
  spotlightEl.classList.remove('is-on');
}

// --- watermark ---------------------------------------------------------------
//
// A name or a logo pinned to one corner for the whole lecture, meant to end up
// IN a screen grab (see drawWatermark below) - not content, so it ignores
// freeze, survives blank deliberately (it sits ABOVE #blank in the stacking
// order - a station bug outlasts a panic-button cut to black, the same as it
// outlasts everything else on the stage), and it never takes a panel.

// Resolves the same `asset:<id>` scheme every panel item uses, but called
// from render() - every heartbeat - rather than once at mount time. Used to
// need its own copy of resolveAssets() for that (see Issue #124): the asking
// side is throttled now, in the one place both screens share it, so calling
// straight through is no longer "ask once a second for as long as a slow
// connection takes to answer".
function watermarkImageSrc(ref) {
  return resolveAssets({ src: ref || '' }).src;
}

function renderWatermark() {
  const wm = state.watermark;
  const showing = !!wm?.enabled && !!(wm.image || wm.text);
  watermarkEl.classList.toggle('is-on', showing);
  watermarkEl.classList.toggle('pos-tl', wm?.position === 'tl');
  if (!showing) return;
  const useImage = !!wm.image;
  watermarkImgEl.hidden = !useImage;
  watermarkTextEl.hidden = useImage;
  if (useImage) watermarkImgEl.src = watermarkImageSrc(wm.image);
  else watermarkTextEl.textContent = wm.text;
}

// A course's default watermark (Issue #157), handed over by the server with a
// NEW lecture (never a resumed one - see startLecture in server/lectures.js).
// watermarkForNewLecture in protocol.js decides whether it replaces what is
// there; the logo's bytes go into the same asset store as any other picture,
// so a second display or a controller that joins later asks this screen for
// them the usual way (see 'asset-need') rather than every device fetching the
// course.
function applyCourseBranding(branding) {
  const next = watermarkForNewLecture(state.watermark, branding, () => uid(10), MAX_ASSET_CHARS);
  if (!next) return false;
  if (next.asset) assetStore.set(next.asset.id, next.asset.data);
  state.watermark = next.watermark;
  return true;
}

// The whole reason this exists: composited into a shot the same way the
// caption is (see drawCaption and takeShot), so a name or logo set once
// actually ends up in a screen grab rather than only ever being something the
// room sees live.
function drawWatermark(ctx, rect) {
  const wm = state.watermark;
  if (!wm?.enabled || !(wm.image || wm.text)) return;
  const pad = Math.max(6, Math.round(rect.h * 0.02));
  const tl = wm.position === 'tl';
  if (wm.image) {
    const img = watermarkImgEl.complete && watermarkImgEl.naturalWidth ? watermarkImgEl : null;
    if (!img) return;   // still loading - the next photo after it lands will carry it
    const maxH = rect.h * 0.1;
    const maxW = rect.w * 0.22;
    const scale = Math.min(maxH / img.naturalHeight, maxW / img.naturalWidth, 1);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    const x = tl ? rect.x + pad : rect.x + rect.w - pad - w;
    const y = tl ? rect.y + pad : rect.y + rect.h - pad - h;
    ctx.drawImage(img, x, y, w, h);
    return;
  }
  const size = Math.max(10, Math.round(rect.h * 0.028));
  ctx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,.82)';
  ctx.textAlign = tl ? 'start' : 'end';
  ctx.textBaseline = tl ? 'top' : 'bottom';
  const x = tl ? rect.x + pad : rect.x + rect.w - pad;
  const y = tl ? rect.y + pad : rect.y + rect.h - pad;
  ctx.fillText(wm.text.slice(0, 120), x, y);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

// --- automated sets ----------------------------------------------------------
//
// A running set advances itself: no controller has to stay connected, let
// alone stay on the right tab, for a pre-show rotation to keep going. Ticks
// program and each of panels B/C/D independently - a set can run in more
// than one pane at once, each on its own clock - and deliberately never
// looks at `preview`: a cued item is parked exactly like a cued video is (see
// syncLayers' `playing:false` override), not secretly burning through its
// rotation while nobody can see it.
//
// `lastSeenKey` is what makes TAKE, swap and a fresh stage all "just work"
// with no special-casing in any of those commands: the first tick that finds
// a DIFFERENT item's key sitting in a slot resets that set's clock right
// there, so a set that sat cued for five minutes starts its current entry's
// timer fresh the moment it actually becomes what the room is looking at,
// rather than immediately skipping ahead to make up for lost time.
const lastSeenSetKey = new Map();   // panel index (0=A) -> item.key last ticked there

function tickSets() {
  // A viewer's sets advance when the display's do, in the next snapshot.
  if (VIEWER) return;
  let changed = false;
  const before = liveInkSurfaces(state);
  for (let panel = 0; panel < 4; panel++) {
    const item = panel === 0 ? state.program : state.panels[panel - 1];
    if (!item || item.type !== 'set') { lastSeenSetKey.delete(panel); continue; }
    if (lastSeenSetKey.get(panel) !== item.key) {
      lastSeenSetKey.set(panel, item.key);
      item.startedAt = Date.now();
      item.remainingMs = 0;
      changed = true;
      continue;
    }
    if (item.paused || !item.entries.length) continue;
    const seconds = Math.max(1, Number(item.entries[item.index]?.seconds) || 1);
    if (Date.now() - item.startedAt >= seconds * 1000) {
      if (applyCommand(state, { op: 'set', action: 'advance', panel })) changed = true;
    }
  }
  if (changed) {
    keepMarkedUpScreens(before);
    commit();
  }
}
setInterval(tickSets, SET_TICK_MS);

// --- audience polls ----------------------------------------------------------
//
// The display is the one device that fetches a poll's tally, the same
// ownership tickSets already has over a running set's clock: one source of
// truth polling the relay, broadcasting what it learns to every controller,
// rather than every controller polling independently and disagreeing. A
// controller only ever reads counts/answers/open off the broadcast state,
// same as it reads a set's current entry.
const POLL_TICK_MS = 1000;
const pollFetchInFlight = new Set();   // pollId -> true, while its own fetch is out

function pollItems() {
  return [state.program, state.preview, ...state.panels].filter((it) => it?.type === 'poll');
}

async function tickPolls() {
  const base = pollBaseUrl(cfg);
  if (!base || VIEWER) return;
  // A redisplayed poll from history carries a pollId (for a stable ink key)
  // but no token - it is a frozen snapshot of a question that finished, not a
  // live one, and has nothing on the relay left to fetch.
  // Issue #115: the relay keeps poll state only in memory (see the comment
  // over `const polls` in podium-server.js) - a restart wipes every open
  // poll, code and all. A 404 here is that, not a fluke, so it gets a flag
  // and a stop, not silence and an endless retry of a request that can only
  // ever 404 again until someone starts a brand new poll.
  for (const item of pollItems().filter((it) => it.token && !it.lost)) {
    if (pollFetchInFlight.has(item.pollId)) continue;
    pollFetchInFlight.add(item.pollId);
    const key = item.key;
    fetch(`${base}poll/${encodeURIComponent(item.pollId)}/results`, {
      headers: { authorization: `Bearer ${item.token}` },
    })
      .then((res) => {
        if (res.ok) return res.json();
        if (res.status === 404) {
          const current = pollItems().find((it) => it.key === key);
          if (current) { current.lost = true; commit(); }
        }
        return null;
      })
      .then((tally) => {
        if (!tally) return;
        // The item this key names may have moved (TAKE, a fresh stage with
        // the same pollId re-asking the question) or left the screen
        // entirely by the time this resolves - find it fresh rather than
        // trust the reference captured before the fetch went out.
        const current = pollItems().find((it) => it.key === key);
        if (!current) return;
        const changed = current.open !== tally.open || current.voters !== tally.voters
          || current.askName !== tally.askName || current.namePrompt !== tally.namePrompt
          || JSON.stringify(current.counts) !== JSON.stringify(tally.counts)
          || JSON.stringify(current.answers) !== JSON.stringify(tally.answers)
          || JSON.stringify(current.responses) !== JSON.stringify(tally.responses)
          || JSON.stringify(current.qnaFeed) !== JSON.stringify(tally.qnaFeed);
        if (!changed) return;
        current.open = tally.open !== false;
        current.closesAt = tally.closesAt;
        current.voters = tally.voters || 0;
        current.askName = !!tally.askName;
        current.namePrompt = tally.namePrompt || 'Name:';
        current.responses = tally.responses || [];
        if (current.kind === 'choice') current.counts = tally.counts || [];
        else if (current.kind === 'text') current.answers = tally.answers || [];
        else if (current.kind === 'qna') current.qnaFeed = tally.qnaFeed || [];
        commit();
      })
      .catch(() => { /* one missed tick is not worth a warning - the next one retries */ })
      .finally(() => pollFetchInFlight.delete(item.pollId));
  }
}
setInterval(tickPolls, POLL_TICK_MS);

// --- the session record ------------------------------------------------------
//
// What was on the projector, written down so it can be read back weeks later.
//
// THIS SCREEN writes it, and that is not a preference. Every message Podium
// puts on a relay is encrypted in the browser under the room passphrase, so a
// relay keeping its own log would have a pile of ciphertext and no idea what
// any of it showed. The display is the one device holding the decrypted state,
// and on a server-backed deployment it is also a signed-in page - so it is the
// only thing in the system that CAN keep this record. See server/lectures.js.
//
// Entirely optional, and silent when it is not available: a Podium served from
// GitHub Pages, a USB stick or a relay with no database never gets past the
// capabilities probe below, and nothing on this screen changes.

const RECORD_FLUSH_MS = 5000;
// At most one timeline entry per this long. Stepping through forty slides
// should leave a record of where the lecture DWELLED, not forty rows - so a
// change inside the gap replaces the one waiting rather than adding its own.
const RECORD_MIN_GAP_MS = 15000;
const RECORD_QUEUE_MAX = 200;
const RECORD_BATCH = 100;
// How often this screen tells the SERVER it is still teaching a lecture. Not
// to be confused with HEARTBEAT_MS at the top of this file, which is the
// relay's own much faster state broadcast to the controllers in the room -
// this one is a single write to the database and the thing that keeps a
// lecture out of the idle sweep.
//
// The server closes a lecture it has not heard from for its own, much longer,
// window (IDLE_MS in server/lectures.js); this only has to sit comfortably
// inside it, with room for several beats to go missing to a bad afternoon of
// classroom wifi before anybody's lecture is declared over.
const LECTURE_ALIVE_MS = 60 * 1000;

let lectureId = null;       // the lecture being written, while live
let eventQueue = [];
let flushTimer = null;
let flushPromise = null;    // the in-flight flush, so a caller can await it rather than bail
let lastSurface = null;     // the ink surface key the last entry described
let lastEventAt = 0;
let recordingSince = 0;     // when THIS lecture began recording - see snapshotInk
let heartbeatTimer = null;  // says "still here" while live - see startHeartbeat
// Set by "Clear this room's saved session": the next Go live opens its own
// record instead of resuming one this room left open. Cleared once used, so
// it governs that one Go live rather than every one after it.
let startFresh = false;
let pendingEvent = null;
let pendingTimer = null;

// What the caption bar said, one finished line at a time (Issue #158) - see
// caption-log.js for what "finished" means. Straight into the queue rather
// than through pendingEvent's gap: that gap is there to stop forty slides
// stepped through in a minute becoming forty rows, and each of these lines is
// something that was actually said, not a place the lecture passed through.
const captionLog = createCaptionLog((line) => queueEvent({
  id: uid(10), at: line.at, kind: 'caption', title: line.text.slice(0, 200),
  detail: { text: line.text, live: line.live },
}));

function noteCaption() {
  if (!lectureId || !state.armed) return;
  const bar = state.overlay;
  captionLog.observe(bar.visible ? bar.text : '', { live: bar.live });
}

// Said on the screen the room can see, rather than left to the docs: what goes
// on the projector being written down is the sort of thing people should not
// have to go looking for.
serverInfo().then((info) => {
  if (VIEWER || !info.features.includes('sessions')) return;
  const note = $('#arm-record');
  note.textContent = 'This lecture is saved to the server: what went on screen, your ink, any poll results and the text of any captions shown. Photos are kept only if a controller is set to keep them.';
  note.hidden = false;
});

const lectureUrl = (id, suffix = '') => `/api/lectures/${encodeURIComponent(id)}${suffix}`;

// --- recording the screen (Issue #132, phase 3) ------------------------------
//
// Only where an administrator has turned it on, only on a display somebody
// is standing at (never a kiosk or a viewer), and only when they choose "Go
// live and record the screen" - the browser asks them to share this tab, and
// a small badge on the screen says it is being recorded for as long as it is.
let screenRec = null;
let lastLectureId = null;   // the lecture a segment finishing after stand-down still belongs to

serverInfo().then((info) => {
  if (VIEWER || cfg.kiosk || !info.features.includes('sessions') || !info.screenVideo?.enabled || !canRecordScreen()) return;
  $('#arm-record-screen').hidden = false;
  const note = $('#arm-record');
  if (note.textContent) note.textContent += ' With “Go live and record the screen”, the screen itself is kept as video too.';
});

function showScreenBadge(text, live) {
  const badge = $('#screen-rec');
  badge.textContent = text;
  badge.classList.toggle('is-live', !!live);
  badge.hidden = !text;
}

async function uploadScreen(name, blob) {
  const id = lectureId || lastLectureId;
  if (!id) return 0;
  try {
    const res = await fetch(lectureUrl(id, `/files?name=${encodeURIComponent(name)}&kind=video`), {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'video/webm' }, body: blob,
    });
    return res.status;
  } catch { return 0; }
}

function startScreenRecording(stream) {
  screenRec?.stop();
  screenRec = createScreenRecorder({
    stream,
    device: `screen-${(bus?.clientId || 'display').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 24) || 'display'}`,
    upload: uploadScreen,
    onStop: (reason) => {
      screenRec = null;
      const why = { full: 'Screen recording stopped: this lecture has kept as much video as the server allows.',
        refused: 'Screen recording stopped: this server no longer keeps screen video.',
        ended: 'Screen recording stopped: sharing this tab was ended.' }[reason];
      showScreenBadge(why || '', false);
      if (why) setTimeout(() => { if (!screenRec) showScreenBadge('', false); }, 12000);
    },
  });
  showScreenBadge('● Recording the screen', true);
}

function stopScreenRecording() {
  screenRec?.stop();
  screenRec = null;
  showScreenBadge('', false);
}

// Straight from the click: the browser only offers to share a tab from one,
// so the request goes first, and Go live (fullscreen, sound) right after it in
// the same click. Declining the share still goes live, without the video.
function goLiveRecording() {
  let asked;
  try { asked = requestScreen(); } catch (err) { asked = Promise.reject(err); }
  goLive();
  asked.then((stream) => {
    if (!state.armed) { for (const t of stream.getTracks()) t.stop(); return; }
    startScreenRecording(stream);
  }).catch(() => {
    showScreenBadge('The screen is not being recorded - sharing was declined.', false);
    setTimeout(() => { if (!screenRec) showScreenBadge('', false); }, 8000);
  });
}

const postJson = (url, body) => fetch(url, {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// Slide and page numbers are stored 0- and 1-based respectively inside an item
// (see inkSurfaceKey); both are written here as a human would say them.
function recordDetail(item) {
  const detail = { type: item?.type || 'black' };
  if (item?.type === 'deck') detail.slide = (Number(item.slide) || 0) + 1;
  if (item?.type === 'slides') detail.slide = (Number(item.slide) || 0) + 1;
  if (item?.type === 'pdf') detail.page = Number(item.page) || 1;
  if (item?.type === 'poll' && item.pollId) detail.pollId = item.pollId;
  return detail;
}

// Go live and stand down each fire their recording half (startRecording /
// stopRecording) without the caller awaiting it - goLive() itself is not
// async, and a keyboard shortcut can trigger either at any moment. Mashed
// quickly enough, that fire-and-forget shape is a real race: a stand-down can
// run stopRecording() while a PRIOR startRecording() is still waiting on its
// POST, see lectureId as not yet set, and return having done nothing - and
// when that POST later resolves it opens a lecture nobody ever closes. Worse,
// a Go live straight after a stand-down can start drawing ink for a NEW
// lecture while the PREVIOUS stopRecording() is still awaiting its own
// flush - and fileInk() snapshots whatever state.ink holds at the moment it
// runs, so the old lecture's file can end up holding the new lecture's ink.
//
// queueRecordingTransition is the fix for both: every start and every stop
// goes through this one chain, so a transition never begins until the
// previous one - start or stop - has completely finished. Mashing the button
// just queues the transitions instead of racing them.
let recordingChain = Promise.resolve();
function queueRecordingTransition(fn) {
  recordingChain = recordingChain.then(fn, fn);
  return recordingChain;
}

async function startRecording() {
  if (lectureId) return;
  // Unattended signage (Issue #151): a kiosk auto-arms on every load - every
  // reboot, every day, for a whole semester - and none of that is a lecture.
  // Left unhandled, that is an endless pile of empty session records with
  // nothing in them. This is the flag, not the auto-arm path specifically:
  // a kiosk device that somebody manually clicks Go live on (unusual, but
  // possible) still should not record, for the same reason.
  if (cfg.kiosk) return;
  // Awaited rather than read off a flag the probe sets when it lands: Go live
  // can be clicked in the same second the page opened, and a lecture that went
  // unrecorded because of a race is exactly the kind of thing nobody would
  // notice until they went looking for it. serverInfo() only asks once.
  if (!(await serverInfo()).features.includes('sessions')) return;
  try {
    const res = await postJson('/api/lectures', { room: cfg.room, fresh: startFresh });
    startFresh = false;
    if (!res.ok) return;
    const { lecture } = await res.json();
    lectureId = lecture.id;
    lastLectureId = lecture.id;
    state.lectureId = lecture.id;
    captionLog.reset();
    lastSurface = null;
    lastEventAt = 0;
    // What snapshotInk measures "drawn during this lecture" against. Ink is
    // deliberately kept across a stand-down (surviving a reload is the whole
    // point - see "surviving a reload" below), so a board carried in from a
    // previous lecture is on screen and must stay there; it just must not be
    // filed under this lecture as though it were drawn here.
    recordingSince = lecture.resumed ? (recordingSince || Date.now()) : Date.now();
    if (!lecture.resumed) applyCourseBranding(lecture.branding);
    startHeartbeat(lecture.id);
    // Broadcast it: a controller ending a poll files the tally under this id.
    // commit() notes what is already on screen as the timeline's first entry.
    commit();
  } catch { /* no network: the lecture runs, only the record is lost */ }
}

// 404 (no such lecture) or 409 (already ended) from any lecture-scoped
// request means this id is never going to accept anything again - not a
// blip to retry through. Two ways to get here that are NOT "the room went
// quiet": the inactivity sweep closed it out from under a display that lost
// its network right as the deadline passed, or - the one this exists for -
// a SECOND display sharing the same room stood down first. Standing down is
// a local, per-machine action (see standDown/the 'e' key), never broadcast,
// so with more than one display live in a room, the other one has no way to
// know the shared lecture it was still writing to just ended.
function lectureGone(status) {
  return status === 404 || status === 409;
}

// Drops the dead id and, if this display is still armed, opens a fresh
// lecture so recording keeps going rather than silently writing into a void
// for the rest of class. Whatever was still queued for the dead id is not
// carried over by name - it simply sits in eventQueue, untagged, and rides
// out under the new id on the next flush, same as a real gap in a single
// lecture's own timeline already can. Routed through
// queueRecordingTransition so this can never race an actual E press or a
// fresh Go live landing at the same moment - see that queue's own comment
// for why racing start/stop is the failure mode it exists to prevent.
function recoverRecording(id) {
  queueRecordingTransition(async () => {
    if (lectureId !== id) return; // already moved on by the time this ran
    lectureId = null;
    state.lectureId = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    commit();
    if (!state.armed) return;
    await startRecording();
    // Nothing left over this display's own retry cadence for however long
    // this room stays on the current slide - push the backlog now instead
    // of leaving it to wait on the next surface change.
    if (lectureId && eventQueue.length) flushEvents(lectureId);
  });
}

// "Still here", on a timer, for as long as this display is live.
//
// The server closes a lecture nobody has heard from in a while, because most
// of the ways a class actually ends - a laptop shut, a tab closed, a machine
// carried out of the room - never send anything at all. Standing down is the
// precise answer and this is the backstop for when it never comes; without it
// a crashed display leaves a session open in everybody's list, looking like a
// class still in progress, until the next Go live in that room.
//
// Bound to the id it was started for rather than reading the global: a
// heartbeat that outlived its lecture would otherwise keep the WRONG one
// alive, which is the exact failure this is meant to prevent.
function startHeartbeat(id) {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (lectureId !== id) { clearInterval(heartbeatTimer); heartbeatTimer = null; return; }
    // A lost beat is ignored - the next one is a minute away - but a beat
    // that actually LANDS and comes back saying this lecture is gone is not
    // something to wait out: nothing this display posts from here on on this
    // id will ever be accepted either.
    postJson(lectureUrl(id, '/alive'), {})
      .then((res) => { if (!res.ok && lectureGone(res.status)) recoverRecording(id); })
      .catch(() => {});
  }, LECTURE_ALIVE_MS);
}

async function stopRecording() {
  // The screen stops with the lecture; its last segment still files under it
  // (see lastLectureId).
  stopScreenRecording();
  const id = lectureId;
  if (!id) return;
  // A line still on the caption bar at stand-down was still said. Written
  // while lectureId still names this lecture, so it queues like any other;
  // the flush timer that schedules is cancelled below, and the drain there
  // sends it.
  captionLog.flush();
  lectureId = null;
  state.lectureId = null;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  // Broadcast now, the same way startRecording broadcasts the id it just set
  // - standDown()'s own commit() (which sets state.armed = false) already ran
  // before this transition even started (queueRecordingTransition queues it
  // as a microtask), so without this, a controller keeps believing the just-
  // ended lecture is still the live one: state.armed correctly says the room
  // stood down, but state.lectureId does not, and a photo or poll taken in
  // the gap before the NEXT Go live can still pass a recordingNow()-style
  // check and get filed against a lecture that has already ended.
  commit();
  clearTimeout(pendingTimer);
  // A retry timer left over from an earlier failed flush in THIS lecture is
  // about to be superseded by the drain below - cancel it, rather than let it
  // fire later against whatever eventQueue and flushEvents' closure happen to
  // hold by then.
  clearTimeout(flushTimer);
  flushTimer = null;
  if (pendingEvent) { eventQueue.push(pendingEvent); pendingEvent = null; }
  // Snapshotted synchronously, before any await below - not read from
  // state.ink later, inside fileInk, once this function has already yielded.
  // queueRecordingTransition serializes the recording subsystem's own
  // start/stop calls, but goLive() flips state.armed back on (and drawing
  // along with it) the instant it runs, and nothing about this chain stops a
  // fresh Go Live from happening while this stand-down is still awaiting its
  // flush below. Reading state.ink after that await is exactly how a new
  // lecture's ink ends up filed under the old one's id.
  const inkSurfaces = snapshotInk();
  // A few immediate tries rather than flushEvents' usual scheduled retry:
  // queueRecordingTransition will not let the next Go live begin until this
  // function returns, so anything still queued after that point would only
  // ever be retried by a timer firing once a DIFFERENT lecture is already
  // live and pushing its own events into this same queue - which is how a
  // leftover batch here ends up posted under, or mixed into, the wrong
  // lecture's record. flushEvents awaits any flush already in flight (from
  // the periodic timer, running independently of this transition) rather
  // than bailing out from under it, so this genuinely waits for it to land.
  for (let attempt = 0; attempt < 3 && eventQueue.length; attempt++) {
    await flushEvents(id);
  }
  // Each of those attempts can itself reschedule flushTimer (see flushEvents)
  // if it failed - bound to `id`, which is safe on its own, but that timer
  // would still fire against the ONE global eventQueue, which a new lecture
  // may already be pushing its own events into by then. Cancel it again now
  // that the queue is genuinely empty, rather than let it post a later
  // lecture's events under this one's id.
  clearTimeout(flushTimer);
  flushTimer = null;
  // Whatever still would not go, by now, goes with this lecture rather than
  // bleeding into the next one's queue - the same trade the network-down
  // case already makes for ink and files: the record stops early, it never
  // reads as the wrong lecture's.
  eventQueue = [];
  await fileInk(id, inkSurfaces);
  try { await postJson(lectureUrl(id, '/end'), { at: Date.now() }); } catch { /* it stays open */ }
}

// What fileInk actually keeps: every surface with at least one stroke on it,
// as of right now. Pulled out so stopRecording can call this synchronously,
// before any await - see the comment there for why that timing matters.
function snapshotInk() {
  // Each value here is `{ strokes, touched }` (see touchSurface in
  // protocol.js), not a bare strokes array. Filtering on the wrapper's own
  // .length - always undefined - kept every surface out, so fileInk's
  // "nothing to file" check always won and no lecture has ever filed its
  // ink at all. That is the bug worth fixing here on its own.
  //
  // `touched` then scopes what is filed to this lecture. Ink survives a
  // stand-down on purpose, so last week's annotations on a deck reused this
  // week are still on screen - and must stay there - but filing them under
  // today's lecture would put words in its mouth. touchSurface only stamps
  // this on a real ink action, so it means "drawn on since", not "looked at".
  //
  // A surface drawn on in BOTH lectures still carries the older strokes with
  // it: the strokes themselves are not individually stamped, and splitting
  // them would need a per-lecture baseline this does not keep. The common
  // case - a board from last week nobody touched today - is scoped right.
  return Object.fromEntries(
    Object.entries(state.ink.bySurface || {})
      .filter(([key, surface]) => !isHeldInkKey(key) && surface?.strokes?.length && surface.touched >= recordingSince),
  );
}

// Ink, as strokes, at the end of the lecture.
//
// This screen is the only device that has all of it, which is why exporting a
// session has always begun by pulling it across the relay from here. Filing it
// with the lecture means the annotations survive the tab closing even when
// nobody exported - and, unlike a rasterized page, the strokes are small: a
// heavily drawn-on lecture is tens of kilobytes of JSON.
//
// It is the raw record, not the picture. Rebuilding an annotated slide needs
// the deck behind it, which is the controller's job and is what an export
// files alongside this.
//
// `surfaces` is always the caller's own snapshot (see snapshotInk and the
// comment in stopRecording on why it is taken before any await) - never
// rebuilt from state.ink here, which by the time this runs may already
// belong to a lecture that went live after this one stood down.
async function fileInk(id, surfaces) {
  if (!Object.keys(surfaces).length) return;
  const body = JSON.stringify({ room: cfg.room, savedAt: Date.now(), bySurface: surfaces });
  // The cap is the server's (16 MB); stopping short of it here means the
  // lecture keeps a smaller record rather than the server turning the whole
  // thing down over one enormous surface.
  if (body.length > 15 * 1024 * 1024) return;
  try {
    await fetch(lectureUrl(id, '/files?name=ink.json&kind=ink'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body,
    });
  } catch { /* the ink is still on this screen, and still in localStorage */ }
}

/**
 * Note what the room is looking at now, if it is something new.
 *
 * Called from commit(), so it runs on every state change there is - which is
 * why the first thing it does is the cheap comparison. The ink surface key is
 * what "something new" means here, deliberately: it already knows that slide 4
 * of a deck is a different thing from slide 5, and that re-staging the same
 * message is not.
 */
function noteSurface() {
  if (!lectureId || !state.armed) return;
  const item = state.program;
  const primaryKey = inkSurfaceKey(item);
  // A split layout can change what B, C or D show - or the layout itself -
  // with panel A untouched, and the room saw that happen; panel A's own key
  // used to be the whole timeline, which meant a lecture run entirely from a
  // split screen could go by with nothing recorded at all. The layout and
  // every active panel beyond A factor into whether this counts as new.
  const panels = activePanels();
  const key = [state.layout, primaryKey, ...panels.map((p) => inkSurfaceKey(p.item))].join('|');
  if (key === lastSurface) return;
  const opening = lastSurface === null;
  lastSurface = key;
  // Going live with nothing up yet is not a moment in the lecture. Later
  // blackouts are - "the projector went dark at 10:42" is real - so only the
  // opening one is dropped, and only when the whole screen opens black: a
  // split layout showing anything else already IS something happening.
  if (opening && state.layout === 'single' && primaryKey === 'black') return;
  // A client-generated id, sent with the event every time it is (re)posted -
  // see the client_id comment in store.js's migration. Invented once, here,
  // rather than at flush time, so a retried flush resends the SAME id for the
  // SAME event instead of minting a new one that would defeat the dedup.
  pendingEvent = {
    id: uid(10), at: Date.now(), kind: 'program', title: itemTitle(item),
    detail: {
      ...recordDetail(item),
      // Recorded alongside panel A's own detail rather than as a separate
      // event: the timeline is "what was on the projector", and on a split
      // screen that is all of it at once, not one panel at a time.
      ...(panels.length
        ? { layout: state.layout, panels: panels.map((p) => ({ title: itemTitle(p.item), ...recordDetail(p.item) })) }
        : {}),
    },
  };
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(settleSurface, Math.max(0, RECORD_MIN_GAP_MS - (Date.now() - lastEventAt)));
}

function settleSurface() {
  if (!pendingEvent || !lectureId) return;
  lastEventAt = Date.now();
  // `at` is when the item went up, not when the gap expired: the entry should
  // say when the room started looking at this, not when this code got round
  // to writing it down.
  const event = pendingEvent;
  pendingEvent = null;
  queueEvent(event);
}

/** Into the queue for the live lecture, and a flush scheduled for it. */
function queueEvent(event) {
  if (!lectureId) return;
  // Captured now rather than read again inside the flush timer's closure
  // below: by the time that timer fires, lectureId may belong to a different
  // lecture (a stand-down and a fresh Go live both change it), and this
  // entry belongs to the lecture that was live when it was queued.
  const id = lectureId;
  eventQueue.push(event);
  if (eventQueue.length > RECORD_QUEUE_MAX) {
    const dropped = eventQueue.length - RECORD_QUEUE_MAX;
    eventQueue.splice(0, dropped);
    // The network being down long enough to fill this queue is exactly the
    // kind of gap `truncated` exists to flag - but that flag is the SERVER's,
    // set when its own much larger cap is hit, and it has no way to know
    // entries never reached it at all. Silently trimming here would leave the
    // timeline reading as continuous through a gap nobody was told about, so
    // the gap gets a row of its own instead - the one thing every reader of
    // the timeline (admin.html, a downloaded session.txt) already knows how
    // to show.
    eventQueue.unshift({
      id: uid(10),
      at: eventQueue[0]?.at ?? Date.now(),
      kind: 'note',
      title: `${dropped} earlier moment${dropped === 1 ? '' : 's'} lost - the network was down long enough to fill this screen's own queue`,
      detail: {},
    });
  }
  // Bound to `id`, the lecture this entry belongs to and the one it was
  // queued for - not the mutable `lectureId`, which a stand-down clears
  // and a fresh Go live then points at a different lecture entirely before
  // this timer ever fires. See stopRecording for the other half of this: it
  // cancels this very timer on the way out, so the only way it fires is while
  // `id` is still the live lecture.
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flushEvents(id); }, RECORD_FLUSH_MS);
}

/**
 * Send whatever is queued for `id`. Awaits (rather than skips past) a flush
 * already in flight - from the periodic timer, say - so that a caller like
 * stopRecording that truly needs the queue drained before it returns is not
 * told "done" by a guard that only meant "someone else is already doing
 * this". `id` is always the lecture the CALLER intends to flush for, which
 * may no longer be the live one (stopRecording calls this after clearing
 * lectureId) - the request is addressed by id, not by whatever is live now.
 */
async function flushEvents(id) {
  if (!id || !eventQueue.length) return;
  if (flushPromise) { await flushPromise; return flushEvents(id); }
  let gone = false;
  flushPromise = (async () => {
    const batch = eventQueue.slice(0, RECORD_BATCH);
    try {
      const res = await postJson(lectureUrl(id, '/events'), { events: batch });
      // Only drop them once the server has them. A flush that fails leaves the
      // queue alone and the next one carries the same entries - which is the
      // whole reason this is a queue and not a request per slide.
      if (res.ok) eventQueue = eventQueue.slice(batch.length);
      // Not a "retry later" failure: this id will never take another event.
      // Stop rescheduling against it below and let recoverRecording open one
      // that will.
      else if (lectureGone(res.status)) gone = true;
    } catch { /* keep them */ }
  })();
  try {
    await flushPromise;
  } finally {
    flushPromise = null;
  }
  if (gone) { recoverRecording(id); return; }
  if (eventQueue.length && !flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flushEvents(id); }, RECORD_FLUSH_MS);
  }
}

// A closing tab has no time for a fetch, and the last thing that happened is
// exactly what has not been sent yet. sendBeacon is the one request a browser
// promises to finish after the page is gone; it carries same-origin cookies,
// which is what makes it authenticate at all.
function beaconEvents() {
  if (!lectureId) return;
  const events = [...eventQueue, ...(pendingEvent ? [pendingEvent] : [])].slice(0, RECORD_BATCH);
  if (!events.length) return;
  try {
    navigator.sendBeacon?.(lectureUrl(lectureId, '/events'),
      new Blob([JSON.stringify({ events })], { type: 'application/json' }));
  } catch { /* nothing more to try from a page that is leaving */ }
}

// --- rendering the rest of the chrome --------------------------------------

function render() {
  docReader?.update(state.program);
  syncMusic();
  syncMicVolumes();
  blankEl.classList.toggle('is-on', state.blank);
  overlayEl.textContent = state.overlay.text;
  overlayEl.classList.toggle('is-on', state.overlay.visible && !!state.overlay.text);
  document.body.classList.toggle('is-frozen', state.frozen);
  renderWatermark();
  syncLayers();
  redrawInk();
  updateStandby();
}

function updateStandby() {
  if (VIEWER) return;
  const noController = !bus || !bus.hasPeer('control');
  const idle = state.program?.type === 'black' && !state.preview;
  // The arming sheet owns the screen until it is dismissed.
  standby.classList.toggle('is-on', noController && idle && armEl.hidden);
}

// --- state plumbing ---------------------------------------------------------

// The full stroke history lives here; shipping every surface to every
// controller on every heartbeat would be waste. What IS worth sending is the
// surface currently on screen - full geometry, not just a count - so a second
// controller mirrors what is actually being drawn, and so a controller that
// flips back to an already-annotated slide sees the same ink the projector
// does, rather than only what it personally drew this session.
function wireState() {
  const { ink: inkState, ...rest } = state;
  // Ink and transport both address whichever panel has focus - a controller
  // drawing or scrubbing needs the FOCUSED panel's surface and shape, not
  // always panel A's, once more than one panel is on screen.
  // While frozen that is a held surface (Issue #174 - see inkTargetKey), and
  // `base` names the real one under it, so a controller can draw what is
  // already there beneath the ink it is holding back from the room.
  const key = inkTargetKey(state);
  const base = isHeldInkKey(key) ? key.slice(HELD_INK_PREFIX.length) : null;
  return {
    ...rest,
    ink: {
      color: inkState.color,
      width: inkState.width,
      surface: key,
      base,
      baseDigest: base ? inkDigest(inkState.bySurface[base]?.strokes) : null,
      // Held surfaces with strokes on them - part of the cue, so TAKE and
      // Clear cue stay armed for ink alone.
      held: heldInkCount(inkState),
      // A summary, not the strokes. This object goes out every two seconds -
      // and every 400ms while anything is playing - and the strokes of a
      // well-annotated whiteboard are hundreds of kilobytes, which is past
      // what any relay will carry. See inkDigest in protocol.js; a controller
      // that does not match asks for the surface with 'ink-pull' below.
      digest: inkDigest(inkState.bySurface[key]?.strokes),
      // Surface keys with saved strokes, so controllers know which slide thumbnails
      // or items have annotations without pulling stroke bodies.
      surfaces: Object.keys(inkState.bySurface).filter((k) => !isHeldInkKey(k) && inkState.bySurface[k]?.strokes?.length > 0),
    },
    stageAspect: stage.clientWidth && stage.clientHeight ? stage.clientWidth / stage.clientHeight : 16 / 9,
    // The shape ink lands on, per surface on screen (Issue #262): the
    // content's own box inside its panel - a portrait photo's, a video's, a
    // camera's - which a controller cannot always work out for itself (it
    // never receives the camera, and a split panel is not the stage's shape).
    inkAspects: inkAspects(),
    slotAspects: slotAspects(),
    // Guest View (Issue #150), for the controllers only - viewerState leaves
    // all three out: how many are watching, and the link and code a
    // controller can put on the projector for the room to scan.
    viewers: viewerCount,
    viewerLink: viewChannel(cfg) && cfg.viewPub ? viewerUrl(cfg, viewChannel(cfg)) : '',
    viewerCode: viewCodeLive ? cfg.viewCode : '',
    // Where the music has got to, and whether something on screen is currently
    // talking over it - both things a controller can only learn from here.
    musicNow: {
      time: musicEl.currentTime || 0,
      duration: Number.isFinite(musicEl.duration) ? musicEl.duration : 0,
      queueRemaining: getQueueRemaining(),
      ducked: state.music.playing && contentIsSounding(),
      error: musicError,
    },
    // A clip on screen this browser will not let make a sound until someone
    // clicks the projector's page.
    soundBlocked: soundBlocked.size > 0,
    // So a controller can tell you when this screen is running older code
    // than it is, rather than leaving you to diagnose it as a bug.
    build: BUILD,
  };
}

function telemetry() {
  return focusedPanel().renderer?.telemetry() || { time: 0, duration: 0, playing: false };
}

function broadcast() {
  if (VIEWER) return;
  bus?.send({ t: 'state', state: wireState(), telemetry: telemetry() });
  sendViewerState();
}

const broadcastSoon = throttle(broadcast, 60);

// --- Guest View: the projector's side (Issue #150) ---------------------------
//
// A second, separate connection - to this display's own view room, under its
// own key (see viewChannel in protocol.js) - that carries what is on the
// projector and nothing else, to anyone holding the viewer link. Viewers
// never hold the room passphrase, so nothing they send can reach the room;
// and everything sent here is signed with a key only this display holds, so
// one viewer cannot show the others something the presenter never put up.
//
// What goes out: a filtered snapshot on every broadcast (viewerState), the
// ink of every surface on screen - pushed to all viewers at once when it
// changes, rather than pulled by each, which at a lecture hall's scale is the
// difference between one message and a hundred per stroke - and answers to a
// viewer's own requests for a picture, a deck (notes stripped) or a surface.
let viewBus = null;
let viewSigner = null;
let viewerCount = 0;
const viewerInk = new Map();     // surface key -> digest viewers were last sent
const viewerInkTimers = new Map();
const VIEWER_INK_MS = 400;

/** This display's view channel, made the first time anyone asks for a viewer link. */
async function ensureViewChannel() {
  if (!cfg.viewId || !cfg.viewKey || !cfg.viewSignKey || !cfg.viewPub) {
    const signing = await makeSigningKey();
    cfg.viewId = uid(16);
    cfg.viewKey = uid(32);
    cfg.viewCode = '';
    cfg.viewSignKey = JSON.stringify(signing.privateJwk);
    cfg.viewPub = signing.publicKey;
    saveConfig(cfg);
  }
  return viewChannel(cfg);
}

async function connectView() {
  const channel = viewChannel(cfg);
  if (VIEWER || !channel || viewBus) return;
  viewSigner = await importSigningKey(JSON.parse(cfg.viewSignKey));
  viewBus = await createBus({
    cfg: { ...cfg, room: channel.room, passphrase: channel.passphrase },
    role: 'display',
    onPeers: (peers) => {
      viewerCount = peers.filter((p) => p.role === 'viewer').length;
      renderViewerCount();
      broadcastSoon();   // so the controllers' count moves too
    },
    onMessage: onViewerRequest,
  });
  sendViewerState();
}

/** Everything that goes to viewers goes through here, signed. */
async function sendToViewers(msg) {
  if (!viewBus || !viewSigner) return;
  const body = JSON.stringify(msg);
  viewBus.send({ t: 'signed', to: msg.to, body, sig: await signText(viewSigner, body) });
}

/** inkSurfaceKey -> inkDigest for every panel actually on screen. */
function onScreenSurfaces() {
  const out = {};
  for (const { item } of activePanels()) {
    const key = inkSurfaceKey(item);
    out[key] = inkDigest(state.ink.bySurface[key]?.strokes);
  }
  return out;
}

function sendViewerState() {
  if (!viewBus) return;
  // Between lectures a viewer sees nothing of what the projector last showed.
  if (!state.armed) { sendToViewers({ t: 'state', state: { armed: false } }); return; }
  const surfaces = onScreenSurfaces();
  sendToViewers({ t: 'state', state: viewerState(wireState(), surfaces), telemetry: telemetry() });
  for (const [key, digest] of Object.entries(surfaces)) {
    if (viewerInk.get(key) === digest) continue;
    viewerInk.set(key, digest);
    // Trailing, per surface: a stroke being drawn changes the digest on every
    // point, and viewers need the finished shape a moment later, not each point.
    if (!viewerInkTimers.has(key)) {
      viewerInkTimers.set(key, setTimeout(() => { viewerInkTimers.delete(key); sendInkToViewers(key); }, VIEWER_INK_MS));
    }
  }
}

function sendInkToViewers(key, to) {
  const slices = chunkStrokes(state.ink.bySurface[key]?.strokes || []);
  // A cleared board is news too - one empty slice says so.
  if (!slices.length) slices.push([]);
  slices.forEach((part, i) => sendToViewers({
    t: 'ink-surface', ...(to ? { to } : {}), surface: key, seq: i, last: i === slices.length - 1, strokes: part,
  }));
}

/** Whether `ref` is something a viewer is being shown right now. */
function onScreenForViewers(ref) {
  const shown = viewerState(wireState());
  return JSON.stringify([shown.program, shown.panels, shown.watermark]).includes(ref);
}

// A viewer asking for something. Nothing here applies a command - the view
// channel is not a way into this screen's state, only out of it - and each
// answer is limited to what the projector is showing now, so a viewer cannot
// walk the lecture's other pictures or decks by guessing ids.
function onViewerRequest(msg) {
  if (!state.armed) { if (msg.t === 'hello') sendViewerState(); return; }
  if (msg.t === 'hello' || msg.t === 'sync') { sendViewerState(); return; }
  if (msg.t === 'asset-need' && onScreenForViewers(`asset:${msg.id}`)) {
    const data = assetStore.get(msg.id);
    if (data != null) sendToViewers({ t: 'asset', to: msg.from, id: msg.id, data });
    return;
  }
  if (msg.t === 'deck-need' && onScreenForViewers(`"deckId":"${msg.id}"`)) {
    const source = deckStore.get(msg.id);
    if (typeof source === 'string') sendToViewers({ t: 'deck', to: msg.from, id: msg.id, source: stripDeckNotes(source) });
    return;
  }
  if (msg.t === 'ink-pull' && Object.hasOwn(onScreenSurfaces(), msg.surface)) sendInkToViewers(msg.surface, msg.from);
}

// The typed code (see server/view-codes.js): only where this display's relay
// is Podium's own server, since that is what answers codes. Held while live,
// touched every minute, released at stand-down - the code on the syllabus is
// kept (cfg.viewCode, asked for again next Go live), but only answers during
// class.
let viewCodeTimer = null;
let viewCodeLive = false;    // the relay answers cfg.viewCode right now
const VIEW_CODE_TOUCH_MS = 60 * 1000;

// What proves to the relay this display still holds its code - kept across a
// reload of this page (in this browser only, never in a pairing link), or a
// display reloaded mid-lecture would find its own code still taken and be
// handed a different one, breaking the one on the syllabus.
const VIEW_CODE_TOKEN_KEY = 'podium.view-code-token';
let viewCodeToken = (() => {
  if (VIEWER) return '';
  try { return localStorage.getItem(VIEW_CODE_TOKEN_KEY) || ''; } catch { return ''; }
})();
function keepViewCodeToken(token) {
  viewCodeToken = token;
  try {
    if (token) localStorage.setItem(VIEW_CODE_TOKEN_KEY, token);
    else localStorage.removeItem(VIEW_CODE_TOKEN_KEY);
  } catch { /* private mode: a reload may get a new code */ }
}

async function registerViewCode() {
  const base = pollBaseUrl(cfg);
  const channel = viewChannel(cfg);
  if (VIEWER || !base || !channel || !state.armed) return;
  try {
    const res = await fetch(`${base}view-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(viewCodeToken ? { authorization: `Bearer ${viewCodeToken}` } : {}) },
      body: JSON.stringify({ want: cfg.viewCode, link: new URL(viewerUrl(cfg, channel)).hash }),
    });
    if (!res.ok) return;
    const { code, token } = await res.json();
    keepViewCodeToken(token);
    viewCodeLive = true;
    if (code !== cfg.viewCode) { cfg.viewCode = code; saveConfig(cfg); }
    renderViewerLink();
    broadcastSoon();
  } catch { /* no code today; the QR still works */ }
  clearInterval(viewCodeTimer);
  viewCodeTimer = setInterval(async () => {
    try {
      const res = await fetch(`${base}view-code/${encodeURIComponent(cfg.viewCode)}`, {
        method: 'PUT', headers: { authorization: `Bearer ${viewCodeToken}` },
      });
      // The relay restarted, or it lapsed while this screen was asleep.
      if (res.status === 404) { keepViewCodeToken(''); registerViewCode(); }
    } catch { /* try again next minute */ }
  }, VIEW_CODE_TOUCH_MS);
}

function releaseViewCode() {
  clearInterval(viewCodeTimer);
  viewCodeTimer = null;
  viewCodeLive = false;
  const base = pollBaseUrl(cfg);
  if (!base || !viewCodeToken || !cfg.viewCode) return;
  const token = viewCodeToken;
  keepViewCodeToken('');
  fetch(`${base}view-code/${encodeURIComponent(cfg.viewCode)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${token}` },
  }).catch(() => { /* it lapses on its own within minutes */ });
}

/** A new viewer link: everyone holding the old one is out, from now. */
async function rotateViewerLink() {
  releaseViewCode();
  const old = viewBus;
  viewBus = null;
  viewSigner = null;
  viewerInk.clear();
  try { await old?.close(); } catch { /* already gone */ }
  cfg.viewId = '';
  cfg.viewKey = '';
  cfg.viewSignKey = '';
  cfg.viewPub = '';
  await ensureViewChannel();
  await connectView();
  registerViewCode();
  showPairing('view');
}

function forwardPointer(msg) {
  if (!viewBus || !state.armed) return;
  const { from, role, to, ...pointer } = msg;
  sendToViewers(pointer);
}

/** The count on the pairing sheet; controllers get theirs through wireState. */
function renderViewerCount() {
  const note = $('#pair-viewers');
  if (note) note.textContent = viewerCount ? `${viewerCount} watching now` : 'Nobody watching yet';
}

// Ink is worth surviving an accidental reload of the display mid-lecture.
// Scoped to the room so different rooms sharing a browser do not clobber each
// other, and saved on a trailing debounce so a fast stroke does not hammer
// localStorage on every point.
const INK_SAVE_MS = 1500;
let inkSaveTimer = null;

function inkStorageKey() {
  return `podium.ink.${cfg.room}`;
}

function saveInkNow() {
  clearTimeout(inkSaveTimer);
  {
    // Without `cleared`: what a Clear stashed is undoable for as long as the
    // surface is on screen, not something to carry to next term, and keeping
    // it would double what the ink of a wiped board costs on disk.
    const saved = {};
    for (const [key, surface] of Object.entries(state.ink.bySurface)) {
      saved[key] = { strokes: surface.strokes, touched: surface.touched };
    }
    safeStorageSet(localStorage, inkStorageKey(), JSON.stringify(saved));
  }
}

function saveInkSoon() {
  clearTimeout(inkSaveTimer);
  inkSaveTimer = setTimeout(saveInkNow, INK_SAVE_MS);
}

function restoreInk() {
  try {
    const saved = JSON.parse(localStorage.getItem(inkStorageKey()) || 'null');
    if (saved && typeof saved === 'object') state.ink.bySurface = saved;
  } catch { /* corrupt or absent - start with a blank slate */ }
}

// --- surviving a reload ------------------------------------------------------
//
// This screen holds the only authoritative copy of what the lecture is showing.
// Ink already survived a reload; nothing else did, so an accidental refresh on
// the classroom PC - or a browser that decided to reclaim the tab - dropped
// back to black and left the presenter re-picking everything in front of the
// room. No controller could help: they mirror this screen, they do not hold it.

const STATE_SAVE_MS = 1200;
// Long enough to cover a reload, a crash, or a machine that went to sleep
// between two classes in the same room; short enough that yesterday's lecture
// does not reappear when you open the room this morning.
const STATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
// When a controller last sent this room a command - see clearStaleMusic.
let lastCommandAt = 0;
let stateSaveTimer = null;

function stateStorageKey() {
  return `podium.state.${cfg.room}`;
}

function saveStateNow() {
  clearTimeout(stateSaveTimer);
  {
    const { program, panels, recall, layout, focus, timers, overlay, volume, contentVolume, micVolume, muted, music, watermark, autoSaveInk } = state;
    // Everywhere else, only the `asset:<id>` reference goes into state and
    // the bytes are fetched fresh from whoever still holds them (see
    // resolveAssets) - deliberately, so a photo of a student's worksheet is
    // never written to disk. A watermark logo is not that: it is meant to
    // outlive the lecture, uploaded once and left alone, so if this screen
    // is the one that holds it, its bytes are worth this exception. Without
    // it, a reload here would leave the reference intact but nothing able to
    // answer it - the one controller that uploaded it may be long gone by
    // the time this screen asks again.
    const watermarkImageData = watermark.image?.startsWith('asset:') ? assetStore.get(watermark.image.slice(6)) : undefined;
    // This is the crash-recovery net (Issue #116) - if it silently stops
    // persisting, a lecture just will not come back after a reload, and
    // nothing said so until the day it mattered.
    safeStorageSet(localStorage, stateStorageKey(), JSON.stringify({
      savedAt: Date.now(), program, panels, recall, layout, focus, timers, overlay, volume, contentVolume, micVolume, muted, watermark, watermarkImageData, autoSaveInk,
      // The queue, not the playing: a reload lands on the arming screen, and
      // music that started itself the moment someone clicked Go live would be
      // a surprise in a room that had gone quiet.
      music: { ...music, playing: false },
    }));
  }
}

function saveStateSoon() {
  clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(saveStateNow, STATE_SAVE_MS);
}

// Both saves are debounced, which leaves a window: the last thing you did
// before the tab went away is exactly the thing a debounce has not written
// yet, and that is the moment this whole mechanism exists for. A deliberate
// reload, a closed tab and a backgrounded one all announce themselves first,
// so flush on all three. A hard crash cannot be caught, and loses at most the
// second or so since the last write.
function flushPersistence() {
  if (VIEWER) return;
  saveInkNow();
  saveStateNow();
  beaconEvents();
}
window.addEventListener('pagehide', flushPersistence);

// Not for a viewer: a stranger's phone that watched one class has no use for
// Podium's offline copy of itself.
if (!VIEWER) installOfflineShell();

// What was on screen, if this tab is coming back rather than starting fresh.
// Returns the item's name for the arming screen to mention, or null.
function restoreState() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(stateStorageKey()) || 'null'); } catch { return null; }
  if (!saved || typeof saved !== 'object') return null;
  if (!Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt > STATE_MAX_AGE_MS) return null;
  if (!saved.program || saved.program.type === 'black') return null;

  state.program = saved.program;
  if (Array.isArray(saved.panels) && saved.panels.length === 3) state.panels = saved.panels;
  if (LAYOUTS[saved.layout]) state.layout = saved.layout;
  if (Number.isInteger(saved.focus) && saved.focus >= 0 && saved.focus < PANEL_COUNT) state.focus = saved.focus;
  if (Array.isArray(saved.recall) && saved.recall.length === PANEL_COUNT) state.recall = saved.recall;
  // An endsAt is an absolute moment, so a countdown restored here is still
  // telling the truth about when it runs out.
  if (Array.isArray(saved.timers) && saved.timers.length) state.timers = saved.timers;
  if (saved.overlay && typeof saved.overlay === 'object') state.overlay = saved.overlay;
  if (Number.isFinite(saved.volume)) state.volume = saved.volume;
  if (Number.isFinite(saved.contentVolume)) state.contentVolume = saved.contentVolume;
  if (Number.isFinite(saved.micVolume)) state.micVolume = saved.micVolume;
  state.muted = !!saved.muted;
  state.autoSaveInk = !!saved.autoSaveInk;
  if (saved.music && Array.isArray(saved.music.tracks)) {
    state.music = { ...state.music, ...saved.music, playing: false };
  }
  // The room was last used when this was saved: a queue restored from then
  // is judged against it, not against this page load (Issue #180).
  lastCommandAt = saved.savedAt;
  if (saved.watermark && typeof saved.watermark === 'object') {
    state.watermark = { ...state.watermark, ...saved.watermark };
    // Pre-fill assetStore with the bytes this screen already had rather than
    // asking a controller for them again - see the comment in saveStateNow.
    if (typeof saved.watermarkImageData === 'string' && state.watermark.image?.startsWith('asset:')) {
      assetStore.set(state.watermark.image.slice(6), saved.watermarkImageData);
    }
  }

  // Deliberately NOT restored: frozen, blank and the cued preview. Those are
  // "what I am doing this second", and coming back mid-gesture into a held or
  // blacked-out screen with no memory of why is worse than coming back to the
  // content itself.
  return state.program.title || state.program.type;
}

function commit() {
  // A viewer's state is the display's; all it ever does with a change is draw it.
  if (VIEWER) { render(); return; }
  state.rev++;
  render();
  broadcastSoon();
  saveInkSoon();
  saveStateSoon();
  noteSurface();
  noteCaption();
}

// Ink is the one payload that can be far larger than a relay message will
// carry, so anything that ships a whole surface ships it in slices. 90 KB of
// JSON seals to roughly 125 KB, comfortably inside the smallest cap any of the
// three transports imposes, and a single stroke cannot exceed it (points per
// stroke are capped in protocol.js).
const INK_CHUNK_BYTES = 90 * 1024;

function chunkStrokes(strokes) {
  const slices = [];
  let batch = [];
  let bytes = 0;
  for (const stroke of strokes) {
    const size = JSON.stringify(stroke).length;
    if (batch.length && bytes + size > INK_CHUNK_BYTES) { slices.push(batch); batch = []; bytes = 0; }
    batch.push(stroke);
    bytes += size;
  }
  // Always at least one slice, so an empty surface still gets an answer and
  // the asker is never left waiting on a reply that is never coming.
  slices.push(batch);
  return slices;
}

// --- connection -------------------------------------------------------------

// The relay is the one part of Podium that fails for reasons outside Podium,
// and the old readout - "Lost the relay - retrying." and nothing else - is
// unactionable: it does not say which URL, what the browser objected to, or
// how many times it has tried. Everything the transport reports is kept here
// and shown on the arming screen and in Settings, so whoever is standing at
// the machine can read the answer off the screen rather than opening a console
// on a lectern PC that may not let them open one.
const relayLog = createRelayLog();

function setHud(status, detail) {
  hud.dataset.status = status;
  relayLog.push(status, detail || '');
  // The arming sheet covers the HUD, so mirror the state onto it: you should
  // be able to see the display is on the bus before you commit the room to it.
  // Detail is carried through on every failing state, not just 'error' - an
  // 'offline' that never managed to open a socket in the first place is where
  // the useful text lives.
  // Trouble opens "Connection details" by itself (Issue #202): the relay
  // target and its log are what whoever is fixing it needs, and they should
  // not have to know to look behind a disclosure to find them. Never closed
  // again from here - someone may be reading it.
  if (['error', 'offline', 'mismatch'].includes(status) && $('#arm-details')) $('#arm-details').open = true;
  const armStatus = $('#arm-status');   // not on view.html
  if (armStatus) armStatus.textContent = {
    connecting: `Connecting to the relay…${detail ? ` (${detail})` : ''}`,
    online: 'Connected and waiting for a controller.',
    offline: `Lost the relay — retrying.${detail ? ` ${detail}` : ''}`,
    error: `Cannot reach the relay${detail ? `: ${detail}` : ''}`,
    mismatch: 'Something nearby is using a different passphrase.',
  }[status] || status;
  hud.textContent = {
    connecting: 'Connecting…',
    // A viewer's room is the view channel's random id - nothing to read out.
    online: VIEWER ? 'Watching' : `Ready · room ${cfg.room}`,
    offline: 'Reconnecting…',
    error: `Connection problem${detail ? `: ${detail}` : ''}`,
    mismatch: 'A device is using a different passphrase',
  }[status] || status;
  hud.classList.toggle('is-quiet', status === 'online');
  updateStandby();
}

let camera = null;
let mic = null;

async function connect() {
  bus = await createBus({
    cfg,
    role: 'display',
    onStatus: setHud,
    onPeers: () => { render(); },
    onMessage: (msg) => {
      if (msg.t === 'hello') { broadcast(); render(); return; }
      if (msg.t === 'deck') {
        if (!msg.id || typeof msg.source !== 'string') return;
        deckStore.set(msg.id, msg.source);
        deckWanted.delete(msg.id);
        syncLayers();
        return;
      }
      if (msg.t === 'asset-need') {
        // Usually this screen is the one asking. The exception is a controller
        // that reloaded mid-lecture, or one that joined after a photo was
        // taken: it has an `asset:<id>` on screen and no bytes for it, and
        // this is the device that has them.
        const data = assetStore.get(msg.id);
        if (data != null) bus.send({ t: 'asset', to: msg.from, id: msg.id, data });
        return;
      }
      if (msg.t === 'asset') {
        if (!msg.id || typeof msg.data !== 'string') return;
        assetStore.set(msg.id, msg.data);
        assetWanted.delete(msg.id);
        pruneAssetStore();
        syncLayers();
        // Same reason a deck redraws ink when it finishes mounting: until the
        // photo arrived, contentAspect() was answering for a 1x1 placeholder,
        // so any ink already on screen was painted against the wrong box.
        redrawInk(true);
        return;
      }
      if (msg.t === 'rtc') { camera.handle(msg); mic.handle(msg); return; }
      // A controller wanting the viewer QR (Issue #150) from a display that has
      // never made a view channel: make it, and the link goes out in wireState.
      if (msg.t === 'view-link-need') {
        ensureViewChannel().then(connectView).then(() => { registerViewCode(); broadcast(); })
          .catch(() => { /* the controller says the display did not answer */ });
        return;
      }
      if (msg.t === 'sync') { broadcast(); return; }
      // The manual, controller-driven way to end class - "Finish session &
      // save" on the Photos tab - alongside the local 'e' key and the
      // server's own inactivity close. Unlike 'e', this is broadcast: with
      // more than one display live in the room (see issue #26), it is the
      // one action that reaches every one of them together, rather than
      // ending the shared recording on whichever machine nobody happened to
      // press E on while every other display quietly outlives it - see
      // recoverRecording above for what that used to cost.
      if (msg.t === 'session-end') { standDown(); return; }
      // Passed on to Guest View as they are: pointing at something is part of
      // what the room sees.
      if (msg.t === 'laser') { showLaser(msg); forwardPointer(msg); return; }
      if (msg.t === 'spotlight') { showSpotlight(msg); forwardPointer(msg); return; }
      if (msg.t === 'ink-pull') {
        // A controller whose digest does not match this screen's: hand it the
        // surface it asked for. Addressed to that one controller rather than
        // broadcast - the others have no use for it and it is the largest
        // thing on the wire.
        const strokes = state.ink.bySurface[msg.surface]?.strokes || [];
        const slices = chunkStrokes(strokes);
        slices.forEach((part, i) => bus.send({
          t: 'ink-surface', to: msg.from, surface: msg.surface,
          seq: i, last: i === slices.length - 1, strokes: part,
        }));
        return;
      }
      if (msg.t === 'ink-need') {
        // Exporting marked-up slides: hand back every surface belonging to
        // this deck, keyed by slide index, so the controller can composite
        // ink onto its own rendering of each slide without a round trip per
        // slide. A whole deck's ink is the biggest payload in the app, so it
        // goes slide by slide, in slices, rather than as one message no relay
        // would accept.
        const prefix = `deck:${msg.deckId}:`;
        const parts = [];
        for (const [key, surface] of Object.entries(state.ink.bySurface)) {
          if (!key.startsWith(prefix)) continue;
          const slide = Number(key.slice(prefix.length));
          if (!Number.isInteger(slide) || !surface.strokes.length) continue;
          for (const slice of chunkStrokes(surface.strokes)) parts.push([slide, slice]);
        }
        if (!parts.length) parts.push(null);
        parts.forEach((part, i) => bus.send({
          t: 'ink-data', to: msg.from, deckId: msg.deckId,
          seq: i, last: i === parts.length - 1,
          bySlide: part ? { [part[0]]: part[1] } : {},
        }));
        return;
      }
      if (msg.t === 'shot-need') {
        // A photo of a panel, or of the whole screen. Broadcast rather than
        // addressed: the iPad asked, but the iPhone in the other hand should
        // end up holding the same photo.
        takeShot(msg.target === 'screen' ? 'screen' : Math.max(0, Math.min(3, Number(msg.target) || 0)))
          .then((shot) => {
            const id = `shot-${uid(8)}`;
            // Keep a copy. This screen has just made the photo; without this it
            // would render a blank pixel the moment a controller put it back up
            // and ask the room to send the 160 KB it produced itself straight
            // back to it.
            assetStore.set(id, shot.dataUrl);
            pruneAssetStore();
            bus.send({ t: 'shot', id, target: msg.target, title: shot.title, data: shot.dataUrl, tooBig: !!shot.tooBig });
          })
          .catch((err) => bus.send({ t: 'shot-failed', to: msg.from, target: msg.target, reason: err?.message || String(err) }));
        return;
      }
      if (msg.t === 'ink-every-need') {
        // Exporting a whole session: every surface that has any ink on it, not
        // just one deck's. Same slicing as the deck path above, for the same
        // reason - a term's annotation does not fit in one relay message.
        const parts = [];
        for (const [key, surface] of Object.entries(state.ink.bySurface)) {
          // Held ink (Issue #174) never went on screen - not part of the session.
          if (isHeldInkKey(key) || !surface.strokes?.length) continue;
          for (const slice of chunkStrokes(surface.strokes)) parts.push([key, slice]);
        }
        if (!parts.length) parts.push(null);
        parts.forEach((part, i) => bus.send({
          t: 'ink-every', to: msg.from,
          seq: i, last: i === parts.length - 1,
          bySurface: part ? { [part[0]]: part[1] } : {},
        }));
        return;
      }
      if (msg.t === 'cmd') {
        // Before the command, so a first "load" or one-tap track today is
        // not added to yesterday's queue (Issue #180).
        const cleared = clearStaleMusic(state, lastCommandAt, Date.now());
        lastCommandAt = Date.now();
        // Ink commands draw on a surface; they never move one away.
        const before = msg.op === 'ink' ? null : liveInkSurfaces(state);
        const applied = applyCommand(state, msg);
        if (applied && before) keepMarkedUpScreens(before);
        if (applied || cleared) commit();
      }
    },
  });

  camera = createCameraReceiver({
    bus,
    onStream: (stream) => { cameraStream = stream; syncLayers(); },
    onState: (status) => { cameraStatus = status; syncLayers(); },
  });

  mic = createMicReceiver({
    bus,
    onTrack: (peerId, stream) => {
      let el = micAudioEls.get(peerId);
      if (!el) {
        el = new Audio();
        el.className = 'mic-relay';
        el.hidden = true;
        document.body.append(el);
        micAudioEls.set(peerId, el);
      }
      el.srcObject = stream;
      el.volume = micTarget();
      el.play().catch(() => { /* same story as musicEl - a play() refused before Go live sorts itself out on the next commit */ });
    },
    onGone: (peerId) => {
      const el = micAudioEls.get(peerId);
      if (!el) return;
      el.pause();
      el.srcObject = null;
      el.remove();
      micAudioEls.delete(peerId);
    },
  });

  $('#fingerprint').textContent = bus.fingerprint;
  $('#arm-code').textContent = bus.fingerprint;
  // A display that has ever handed out a viewer link keeps its view channel
  // open from the start, so a viewer who opens the link before class sees
  // "not live yet" rather than a connection that never comes.
  if (viewChannel(cfg)) connectView().catch(() => { /* viewers will retry; the room is unaffected */ });
  setInterval(broadcast, HEARTBEAT_MS);
  setInterval(() => {
    if (telemetry().playing || state.music?.playing) broadcast();
  }, TELEMETRY_MS);
  broadcast();
}

// --- arming (the one click that unlocks sound and fullscreen) ---------------

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeLock?.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not supported, or denied - the screensaver may kick in */ }
}

document.addEventListener('visibilitychange', () => {
  if (VIEWER) return;
  if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
  if (document.hidden) flushPersistence();
});

// --- kiosk scheduling: loading a plan with no controller (Issue #152) ------
//
// A kiosk has nobody running control.js to turn a plan into stage/panel/
// layout/timer/music commands - adoptPlan() in control.js is the only place
// that logic has ever lived, sent one bus command at a time to whichever
// display is listening. adoptPlanLocally below is that same logic, ported to
// apply each command to THIS display's own `state` directly (applyCommand +
// commit, the exact pair a real bus message triggers on arrival - see the
// bus handler above) instead of sending it anywhere. Deliberately not shared
// code with control.js: that function is entangled with control-only state
// (currentPlan, deckStore/assetStore under control's own eviction rules,
// renderPlanBar, saveCurrentPlan) that has nothing to do with a kiosk, and
// pulling it apart to share the middle was worse than porting the ~120 lines
// that matter for a display with nobody driving it.
async function adoptPlanLocally(plan) {
  for (const [id, asset] of Object.entries(plan.assets || {})) assetStore.set(id, asset.data);

  for (const row of plan.items) {
    if (row.type !== 'deck' || !row.asset) continue;
    const source = plan.assets?.[row.asset]?.data;
    if (typeof source !== 'string') continue;
    const id = await deckId(source);
    deckStore.set(id, source);
    row.deckId = id;
    // adoptPlan() in control.js also pre-renders here to learn slideCount/
    // fragments - a controller's own step buttons need to know how many
    // slides a deck has before the first Next click. A kiosk has no such
    // buttons; the renderer display.js already uses for a deck arriving over
    // the bus works these out for itself the same way once it actually
    // stages one, so nothing here needs to duplicate that.
  }

  const apply = (cmd) => applyCommand(state, cmd);

  if (plan.layout && plan.layout !== 'single') apply({ op: 'layout', mode: plan.layout });
  if (plan.layout === 'pip' && plan.pip) {
    const { main, inset, corner, size } = plan.pip;
    apply({ op: 'pip', main, inset, corner, size });
  }
  if (plan.timers.length) {
    apply({ op: 'timer', action: 'define', timers: plan.timers.map((t) => ({ id: t.id, label: t.label, seconds: t.mins * 60 })) });
  }

  if (plan.autoLaunch?.enabled) {
    const isFreeze = plan.autoLaunch.initialState === 'freeze';
    const isBlank = plan.autoLaunch.initialState === 'blank';
    if (isFreeze) apply({ op: 'freeze', on: true });

    const count = LAYOUTS[plan.layout || 'single'] || 1;
    const paneKeys = ['A', 'B', 'C', 'D'].slice(0, count);

    for (let i = 0; i < paneKeys.length; i++) {
      const key = paneKeys[i];
      const p = plan.autoLaunch.panes?.[key];
      if (!p) continue;

      if (p.type === 'item' && p.itemId) {
        const item = plan.items.find((it) => it.id === p.itemId);
        if (item) {
          const staged = itemForStage(item);
          if (i === 0) apply({ op: 'stage', item: staged, where: isFreeze ? 'preview' : 'auto' });
          else apply({ op: 'panel', index: i - 1, item: staged });
        }
      } else if (p.type === 'set' && Array.isArray(p.entries) && p.entries.length) {
        const entries = [];
        for (const e of p.entries) {
          const item = plan.items.find((it) => it.id === e.itemId);
          if (!item) continue;
          entries.push({ item: itemForStage(item), seconds: e.seconds || 15 });
        }
        if (entries.length) {
          const setItem = {
            type: 'set', title: p.title || `Pane ${key} set`,
            mode: p.mode === 'random' ? 'random' : 'sequential', entries,
          };
          if (i === 0) apply({ op: 'stage', item: setItem, where: isFreeze ? 'preview' : 'auto' });
          else apply({ op: 'panel', index: i - 1, item: setItem });
        }
      }
    }

    const activeIndex = paneKeys.indexOf(plan.autoLaunch.activePane || 'A');
    apply({ op: 'focus', index: activeIndex >= 0 ? activeIndex : 0 });

    if (isBlank) apply({ op: 'blank', on: true });

    if (plan.autoLaunch.music?.playlist) {
      const musicConfig = plan.autoLaunch.music;
      let targetName = musicConfig.playlist;
      let matchedPlaylist = null;
      let matchedAudioItem = null;

      if (targetName.startsWith('item:')) {
        matchedAudioItem = plan.items.find((it) => it.id === targetName.slice(5));
      } else {
        if (targetName.startsWith('playlist:')) targetName = targetName.slice(9);
        const playlists = await loadMusicLibrary();
        matchedPlaylist = playlists.find((l) => l.name === targetName) || playlists[Number(targetName)];
        if (!matchedPlaylist) {
          matchedAudioItem = plan.items.find((it) => it.type === 'audio' && (it.id === targetName || it.title === targetName));
        }
      }

      if (matchedPlaylist) {
        apply({
          op: 'music', action: 'load', tracks: matchedPlaylist.tracks,
          name: matchedPlaylist.name, play: musicConfig.autoplay !== false,
        });
      } else if (matchedAudioItem) {
        apply({
          op: 'music', action: 'load',
          tracks: [{ src: matchedAudioItem.src, title: matchedAudioItem.title, artist: matchedAudioItem.artist }],
          name: matchedAudioItem.title || 'Audio', play: musicConfig.autoplay !== false,
        });
      }

      if (typeof musicConfig.volume === 'number') apply({ op: 'music', action: 'volume', value: musicConfig.volume });
    }

    if (plan.autoLaunch.timer?.timerId) {
      const timer = plan.timers.find((t) => t.id === plan.autoLaunch.timer.timerId);
      if (timer) apply({ op: 'timer', action: 'start', id: timer.id, seconds: timer.mins * 60, label: timer.label || '' });
    }
  }

  commit();
}

// control.js's loadPlaylists() is control-UI-bound (populates a <select>,
// mutates its own module-level list) - this is the plain fetch underneath
// it, for the one thing a kiosk plan's autoLaunch.music might need: naming a
// saved playlist by name rather than an item already sitting in the plan.
async function loadMusicLibrary() {
  try {
    const res = await fetch('content/music.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : data.playlists || [])
      .filter((list) => list && Array.isArray(list.tracks) && list.tracks.length);
  } catch {
    return [];
  }
}

// How often a kiosk asks "what should be showing right now" (Issue #152). A
// schedule is minutes, not seconds, wide - see the "not a full calendar"
// scope in the issue itself - so checking once a minute catches every
// boundary within the same minute it crosses, which is close enough for
// signage nobody is staring at a stopwatch in front of. Polling rather than
// the server pushing a change was the deliberate call here (see
// server/kiosks.js's own header comment): no new server-side bus client, and
// a kiosk that missed one tick (a reboot, a network blip) just gets the
// right answer on its next poll instead of needing to be told twice.
const KIOSK_SCHEDULE_POLL_MS = 60000;
let loadedPlanId = null;

async function checkKioskSchedule() {
  // cfg.kiosk also covers the OLDER, manually-flagged kind of kiosk (Issue
  // #151 slice 1: a real signed-in user's own device, ticked "kiosk" on its
  // own setup form) - that device has no podium_kiosk_hint cookie at all
  // (see config.js's own fromKioskSession, which checks the same thing for
  // the same reason), and asking anyway would 404 this same fetch once a
  // minute forever rather than once.
  if (!/(?:^|; )podium_kiosk_hint=1(?:;|$)/.test(document.cookie)) return;
  let resolved;
  try {
    const res = await fetch('/api/kiosks/session-plan', { credentials: 'same-origin' });
    if (!res.ok) return;
    resolved = await res.json();
  } catch {
    return; // offline, or between requests - next tick tries again
  }
  if (resolved.planId === loadedPlanId) return;
  loadedPlanId = resolved.planId;
  if (!resolved.plan) return; // nothing assigned, or it named something since deleted
  try {
    const { plan } = readPlan(JSON.stringify(resolved.plan.doc));
    await adoptPlanLocally(plan);
  } catch {
    // A plan that fails to parse or adopt is the same as one not arriving -
    // whatever was already on screen keeps showing rather than going blank.
  }
}

function startKioskScheduling() {
  checkKioskSchedule();
  setInterval(checkKioskSchedule, KIOSK_SCHEDULE_POLL_MS);
}

// An e2e test forcing one poll rather than waiting up to KIOSK_SCHEDULE_POLL_MS
// for the real interval to fire - same reasoning as window.__podiumAssetStoreSize
// above: harmless to expose, and the only way to prove a schedule switch
// without a real test just sitting there for a minute.
window.__podiumCheckKioskSchedule = checkKioskSchedule;

// Arming is only about the things a browser will not give a page without a
// gesture: sound, fullscreen and the wake lock. The display is already on the
// bus by this point, so a controller can see it - and see that it is waiting
// for this click - rather than the room looking empty.
// A one-sample silent WAV, inlined so the unlock below needs no network
// round trip. Its only job is to be something real for the browser to play.
const SILENT_CLIP = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==';

// Everything a browser will not grant a page without a gesture is ASKED FOR
// here, in the click's own turn of the event loop, before this function awaits
// anything at all. That is not style: Safari treats a request made after even
// one `await` as not coming from a user gesture and refuses it without an
// error. It is exactly how Go live stopped going fullscreen on Macs - the
// audio unlock below was awaited first, so requestFullscreen() was not called
// until the gesture was already over. The promises are collected and awaited
// afterwards, where waiting costs nothing.
//
// The order within this block is deliberate. Two separate autoplay gates
// exist and they do not unlock each other: resuming an AudioContext covers
// the Web Audio API only and does nothing for a plain <audio>/<video>
// element's own autoplay policy, which is the one that actually governs
// Waiting Music and every video/YouTube item. The only thing every engine
// honors for that is a real media element's play() from inside the gesture,
// so it goes first. Fullscreen goes last of the three because it is the one
// that SPENDS the gesture - the other two only check that there was one.
// The music's player, played from the Go live click. Silent: it is at
// level zero until a track ramps it up, and empty unless a track is queued.
// commit() right after this starts it properly if it should be playing; if
// not, it is put back where it was.
function blessMusic() {
  const empty = !musicEl.getAttribute('src');
  if (empty) musicEl.src = SILENT_CLIP;
  const wasAt = musicEl.currentTime || 0;
  return Promise.resolve(musicEl.play())
    .catch(() => { /* blocked, or a real track arrived and cut it short */ })
    .then(() => {
      if (state.music.playing) return;
      musicEl.pause();
      if (musicEl.getAttribute('src') === SILENT_CLIP) { musicEl.removeAttribute('src'); musicEl.load(); }
      else if (!empty) { try { musicEl.currentTime = wasAt; } catch { /* not loaded yet */ } }
    });
}

function goLive() {
  armEl.hidden = true;
  document.body.classList.add('is-live');
  state.armed = true;

  // Safari lets a player make a sound only once that same player has been
  // played from a click - a muted one does not count, and a player made later
  // is not covered. So the players videos and clips will use are made and
  // played here (see blessMediaElements), and so is the music's own.
  blessMediaElements(SILENT_CLIP);
  const audio = blessMusic();

  let context = Promise.resolve();
  try { context = new (window.AudioContext || window.webkitAudioContext)().resume(); } catch { /* noop */ }

  const fullscreen = enterFullscreen().catch(() => { /* the user can still press F11 */ });

  sizeInk();
  commit();
  queueRecordingTransition(startRecording);
  registerViewCode();
  return finishGoLive([audio, context, fullscreen]);
}

async function finishGoLive(pending) {
  await Promise.allSettled(pending);
  await requestWakeLock();
  sizeInk();
  commit();
}

// The way back out, without a keyboard shortcut for "quit" that a stray key
// press could hit by accident: leave fullscreen and put the arming screen up
// again, with whatever was on the projector still loaded behind it, so Go live
// picks the lecture straight back up. The controller is told (state.armed),
// so it reports "Display open - click Go live on it" rather than an absence.
async function standDown() {
  hidePairing();
  hideShortcuts();
  armEl.hidden = false;
  document.body.classList.remove('is-live');
  state.armed = false;
  // The room has been dismissed, so it goes quiet with it. Background music
  // is the one thing on this screen that keeps going with nothing visible
  // driving it: the arming screen is up, every controller's transport is for
  // a lecture that has ended, and the track just plays on. syncMusic() (via
  // commit below) fades it out rather than cutting it, and the state change
  // is broadcast, so the controllers stop showing it as playing too. Same
  // reasoning as saveStateNow's `playing: false` - music that outlives the
  // lecture is a surprise in a room that has gone quiet.
  state.music.playing = false;
  // And anything sounding on the projector itself, for the same reason: a
  // clip left running plays on behind the arming screen, and no controller
  // still shows a transport pointing at it. Paused rather than cleared, so
  // this keeps the promise above - Go live picks the lecture straight back
  // up, with the clip where the room left it rather than back at the start.
  for (const item of [state.program, ...state.panels]) {
    if (item && (MEDIA_TYPES.includes(item.type) || item.type === 'deck')) item.playing = false;
  }
  commit();
  queueRecordingTransition(stopRecording);
  releaseViewCode();
  try { await exitFullscreen(); } catch { /* already windowed */ }
}

// --- setup screen -----------------------------------------------------------


function showSetup() {
  // What was showing behind it - the live stage, or the arming screen -
  // so closing goes back there rather than reloading (Issue #201).
  setupReturnsTo = armEl.hidden && document.body.classList.contains('is-live') ? 'live' : 'arm';
  setupEl.hidden = false;
  armEl.hidden = true;
  $('#setup-close').hidden = !isConfigured(cfg);
  $('#setup-error').textContent = '';
  hidePassphrase();
  const form = $('#setup-form');
  // Filled from the saved config every time it opens, which is also what
  // throws away a half-finished edit that was closed without saving.
  for (const [key, value] of Object.entries(cfg)) {
    const field = form.elements[key];
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = !!value;
    else if (typeof value !== 'boolean') field.value = value;
  }
  onSetupTransport();
}

let setupReturnsTo = 'arm';
// Not on view.html, which has no Settings - a no-op there (Issue #200).
let hidePassphrase = () => {};

function onSetupTransport() {
  const form = $('#setup-form');
  const t = form.elements.transport.value;
  form.querySelectorAll('[data-for]').forEach((row) => {
    row.hidden = !row.dataset.for.split(' ').includes(t);
  });
}

// Closing Settings goes straight back to what was on this screen (Issue #201,
// the display's half of what #178 did for the controller). It used to reload,
// which on a projector is the worst kind of cancel: the S key opens Settings
// while LIVE, and closing it again dropped fullscreen, the relay and the
// recording, and put the room back on the arming screen mid-lecture.
function closeSetup() {
  if (!isConfigured(cfg)) return;
  // A field left focused inside a hidden sheet still takes the keyboard: the
  // shortcut handler ignores keys typed into an input, so after Escape the
  // next S, P or E would go nowhere until someone clicked the page.
  if (setupEl.contains(document.activeElement)) document.activeElement.blur();
  setupEl.hidden = true;
  $('#setup-error').textContent = '';
  armEl.hidden = setupReturnsTo === 'live';
}

function wireSetup() {
  const form = $('#setup-form');
  form.elements.transport.addEventListener('change', onSetupTransport);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    // `generated: null` because submitting this form IS the choice: the room
    // and passphrase it was pre-filled with were only a suggestion until now,
    // and isConfigured refuses a config still carrying that marker.
    const next = { ...cfg, generated: null };
    for (const key of Object.keys(DEFAULTS)) {
      const field = form.elements[key];
      if (!field) continue;
      if (field.type === 'checkbox') next[key] = field.checked;
      else if (typeof field.value === 'string') next[key] = field.value.trim();
    }
    if (!isConfigured(next)) { $('#setup-error').textContent = 'Fill in the fields for the transport you picked.'; return; }
    // Nothing this form holds changed: there is nothing to reconnect, so Save
    // is just Close - the same rule the controller's Settings follows. Only a
    // real change (a new room, relay or the kiosk switch) needs the reload
    // that reconnects with it.
    if (isConfigured(cfg) && Object.keys(DEFAULTS).every((key) => {
      const field = form.elements[key];
      return !field || String(next[key] ?? '') === String(cfg[key] ?? '');
    })) {
      closeSetup();
      return;
    }
    cfg = next;
    saveConfig(cfg);
    location.reload();
  });
}

// --- pairing ----------------------------------------------------------------

let pairTimer = null;

// guest.html is the same room, the same passphrase, and none of the cueing
// concept - a substitute handed this code can advance slides, blank the
// screen and point a laser, and cannot touch what the instructor's own
// controller has cued (see Issue #77). Reusing pairingUrl unchanged - it
// already takes a base URL - is what keeps this one function correct for
// either link instead of two near-copies to keep in sync.
async function showPairing(mode = 'full') {
  const holder = $('#pair-qr');
  let url;
  if (mode === 'view') {
    // Guest View (Issue #150): the only mode whose code does not grant control
    // - it opens this display's view channel, never the room - so it is the
    // only one allowed to stay up until someone dismisses it.
    const channel = await ensureViewChannel();
    await connectView();
    registerViewCode();
    url = viewerUrl(cfg, channel);
  } else {
    url = mode === 'guest' ? pairingUrl(cfg, new URL('guest.html', location.href)) : pairingUrl(cfg);
  }
  if (typeof window.qrcode === 'function') {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    holder.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }
  $('#pair-url').textContent = url;
  $('#pair-warn').textContent = {
    guest: 'Anyone who scans this can advance slides, blank the screen and use the laser - nothing else. It hides itself after 90 seconds.',
    view: 'Anyone who scans this can watch and listen on their own device - they cannot change anything here. It stays up until you close it.',
  }[mode] || 'Anyone who scans this can control this screen. It hides itself after 90 seconds.';
  $('#pair-mode-full').classList.toggle('is-on', mode === 'full');
  $('#pair-mode-guest').classList.toggle('is-on', mode === 'guest');
  $('#pair-mode-view').classList.toggle('is-on', mode === 'view');
  $('#pair-view').hidden = mode !== 'view';
  if (mode === 'view') { renderViewerLink(); renderViewerCount(); }
  $('#pair').hidden = false;
  clearTimeout(pairTimer);
  // A code that grants control of this screen does not stay up.
  if (mode !== 'view') pairTimer = setTimeout(hidePairing, 90000);
}

/** The typed code, when this display's relay gives them out and it is live. */
function renderViewerLink() {
  const note = $('#pair-view-code');
  if (!note) return;
  const base = pollBaseUrl(cfg);
  note.textContent = viewCodeLive && base
    ? `No camera? Go to ${base}view.html and type ${cfg.viewCode}`
    : (base ? 'A typed code appears here once this screen is live.' : '');
}

function hidePairing() {
  clearTimeout(pairTimer);
  $('#pair').hidden = true;
  $('#pair-qr').replaceChildren();
  $('#pair-url').textContent = '';
}

// --- the shortcut card ------------------------------------------------------

function showShortcuts() {
  $('#keys-fs').textContent = isFullscreen() ? 'Leave fullscreen' : 'Go fullscreen';
  $('#keys').hidden = false;
}

function hideShortcuts() {
  $('#keys').hidden = true;
}

function toggleShortcuts() {
  if ($('#keys').hidden) showShortcuts(); else hideShortcuts();
}

// --- Guest View: the viewer's side (Issue #150) -----------------------------
//
// view.html. Joins the view room with the view key from its link (never the
// room passphrase - it is not in the link), and draws what a live display
// sends there - but only what verifies against the display's public key, also
// from the link, so another viewer cannot slip it something.

let viewerVerifyKey = null;
let viewerStarted = false;
let viewerLastSync = 0;
const viewerInkParts = new Map();     // surface -> strokes assembled so far
const viewerInkAsked = new Map();     // surface -> when it was last pulled

function viewerSay(text) {
  const status = $('#viewer-status');
  if (status) status.textContent = text;
}

async function onViewerMessage(msg) {
  if (msg.t !== 'signed' || typeof msg.body !== 'string') return;
  if (!(await verifyText(viewerVerifyKey, msg.body, msg.sig))) return;
  let inner;
  try { inner = JSON.parse(msg.body); } catch { return; }
  if (inner.to && inner.to !== bus.clientId) return;
  if (inner.t === 'state') { adoptViewerState(inner.state || {}, inner.telemetry); return; }
  if (inner.t === 'ink-surface') { takeViewerInk(inner); return; }
  if (inner.t === 'deck' && inner.id && typeof inner.source === 'string') {
    deckStore.set(inner.id, inner.source);
    deckWanted.delete(inner.id);
    syncLayers();
    return;
  }
  if (inner.t === 'asset' && inner.id && typeof inner.data === 'string') {
    assetStore.set(inner.id, inner.data);
    assetWanted.delete(inner.id);
    syncLayers();
    redrawInk(true);
    return;
  }
  if (inner.t === 'laser') { showLaser(inner); return; }
  if (inner.t === 'spotlight') showSpotlight(inner);
}

function adoptViewerState(next, tele) {
  const offAir = !next.armed;
  $('#viewer-offair').hidden = !offAir || !viewerStarted;
  if (!viewerStarted) {
    viewerSay(offAir ? 'Connected - the class is not live yet. You can start now and it will appear when it is.' : 'The class is live.');
    $('#viewer-start-row').hidden = false;
  }
  if (offAir) {
    // Nothing of the last lecture lingers on a viewer's screen.
    const ink = state.ink;
    state = { ...initialState(), ink };
    state.music.playing = false;
    render();
    return;
  }
  const ink = state.ink;
  state = { ...initialState(), ...next, ink };
  // Pull the ink of anything on screen this viewer's copy disagrees with -
  // having just joined, or having missed a push - at most every few seconds.
  const now = Date.now();
  for (const [key, digest] of Object.entries(next.ink?.surfaces || {})) {
    if (inkDigest(ink.bySurface[key]?.strokes) === digest) continue;
    if (now - (viewerInkAsked.get(key) || 0) < 3000) continue;
    viewerInkAsked.set(key, now);
    bus.send({ t: 'ink-pull', surface: key });
  }
  render();
  catchUpMedia(next, tele);
}

// A viewer who joins mid-clip, or whose phone stalled, jumps to where the room
// is rather than playing its own version a minute behind. Only past a few
// seconds' drift, and not more than every few seconds, so ordinary network
// jitter never becomes a stutter.
function catchUpMedia(next, tele) {
  if (!viewerStarted || Date.now() - viewerLastSync < 5000) return;
  const renderer = focusedPanel().renderer;
  if (tele?.playing && renderer?.syncTo) {
    const here = renderer.telemetry().time || 0;
    if (Math.abs(here - tele.time) > 3) { renderer.syncTo(tele.time + 0.3); viewerLastSync = Date.now(); }
  }
  const room = next.musicNow;
  if (next.music?.playing && room && Number.isFinite(room.time) && Math.abs((musicEl.currentTime || 0) - room.time) > 3) {
    musicEl.currentTime = room.time + 0.3;
    viewerLastSync = Date.now();
  }
}

function takeViewerInk(part) {
  if (typeof part.surface !== 'string' || !Array.isArray(part.strokes)) return;
  const sofar = part.seq === 0 ? [] : (viewerInkParts.get(part.surface) || []);
  sofar.push(...part.strokes);
  if (!part.last) { viewerInkParts.set(part.surface, sofar); return; }
  viewerInkParts.delete(part.surface);
  state.ink.bySurface[part.surface] = { strokes: sofar, touched: Date.now() };
  redrawInk(true);
}

// Whatever the link or the code pointed at, turned into this page's config.
async function viewerFromCode(code) {
  const res = await fetch(`view-code/${encodeURIComponent(code.trim().toUpperCase())}`, { cache: 'no-store' });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(answer.error || 'That code did not work.');
  history.replaceState(null, '', `${location.pathname}#${answer.link}`);
  cfg = viewerConfig();
}

async function startViewer() {
  sizeInk();
  if (!viewChannelLink()) {
    // No link: the typed-code fallback, on the server that issued the code.
    viewerSay('');
    $('#viewer-code-form').hidden = false;
    await new Promise((resolve) => {
      $('#viewer-code-form').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        $('#viewer-code-error').textContent = '';
        try {
          await viewerFromCode($('#viewer-code').value);
          $('#viewer-code-form').hidden = true;
          resolve();
        } catch (err) {
          $('#viewer-code-error').textContent = err.message;
        }
      });
    });
  }
  viewerVerifyKey = await importVerifyKey(cfg.viewPub || '');
  if (!viewerVerifyKey) { viewerSay('This link is incomplete - ask for it again.'); return; }

  $('#viewer-start').addEventListener('click', () => {
    viewerStarted = true;
    $('#viewer-sheet').hidden = true;
    document.body.classList.add('is-live');
    // The one gesture a browser needs before it will play sound - the same
    // unlock Go live does on the projector, without the fullscreen, wake lock
    // or recording that come with it there.
    blessMediaElements(SILENT_CLIP);
    blessMusic();
    try { new (window.AudioContext || window.webkitAudioContext)().resume(); } catch { /* noop */ }
    $('#viewer-offair').hidden = state.armed !== false;
    bus?.send({ t: 'sync' });
    render();
  });

  // On an instance with accounts, the files on screen need a pass - see
  // viewerMayRead in server/podium-server.js. Asked for again whenever the
  // class (re)starts, since a pass lasts only as long as it is live.
  const pass = () => fetch('view-pass', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: cfg.room }),
  }).catch(() => { /* a relay that is not Podium's own server: nothing to ask */ });

  const connectOnce = async () => {
    bus = await createBus({
      cfg,
      role: 'viewer',
      onStatus: (status, detail) => {
        setHud(status, detail);
        if (status === 'online') { pass(); if (!viewerStarted) viewerSay('Connected - waiting for the display…'); }
        if (status === 'error' && !viewerStarted) viewerSay('This class is not live right now. This page keeps trying.');
      },
      onMessage: onViewerMessage,
    });
  };
  // The relay refuses a viewer until the display is in its view room (see the
  // upgrade handler in podium-server.js), so a link opened before class keeps
  // trying rather than giving up.
  for (;;) {
    try { await connectOnce(); break; } catch (err) {
      viewerSay(`Waiting for the class to go live… (${err?.message || err})`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
  setInterval(() => { if (state.armed) pass(); }, 10 * 60 * 1000);
}

/** Whether this page's link carried a view channel at all. */
function viewChannelLink() {
  return !!(cfg.room && cfg.passphrase && cfg.viewPub);
}

if (VIEWER) {
  await startViewer();
} else {
  // --- wiring -----------------------------------------------------------------

  $('#arm-button').addEventListener('click', goLive);
  $('#arm-record-screen').addEventListener('click', goLiveRecording);
  $('#arm-settings').addEventListener('click', showSetup);

  wireSetup();
  hidePassphrase = wireRevealButtons(setupEl);
  $('#setup-close').addEventListener('click', closeSetup);

  wireDangerButton($('#reset-device'), 'Clear settings & reload', async () => {
    const removed = await resetDevice();
    $('#reset-note').textContent = removed.length ? `Cleared ${removed.join(', ')}.` : 'Nothing was stored on this device.';
    reloadClean();
  });
  $('#pair-button').addEventListener('click', () => showPairing());
  $('#pair-mode-full').addEventListener('click', () => showPairing('full'));
  $('#pair-mode-guest').addEventListener('click', () => showPairing('guest'));
  $('#pair-mode-view').addEventListener('click', () => showPairing('view'));
  wireDangerButton($('#pair-view-rotate'), 'New viewer link', () => rotateViewerLink(),
    { armedLabel: 'Tap again - the old link and code stop working for everyone' });
  $('#pair-close').addEventListener('click', hidePairing);
  $('#keys-close').addEventListener('click', hideShortcuts);
  $('#standby-pair').addEventListener('click', () => showPairing());
  $('#standby-settings').addEventListener('click', showSetup);

  // Entering fullscreen (see goLive()) is the other real trigger for a stale
  // content box: requestFullscreen()'s promise is documented to settle before
  // the viewport has actually finished resizing in some browsers, so the
  // sizeInk() call right after it can run against the OLD dimensions - and if
  // no further resize happens before ink gets drawn, that stale box (and the
  // misaligned ink it produces) never self-corrects. 'resize' alone isn't a
  // reliable enough signal for this specific transition, so fullscreenchange
  // is a second, redundant trigger for the same recompute.
  window.addEventListener('resize', () => { sizeInk(); broadcastSoon(); });
  onFullscreenChange(() => {
    sizeInk();
    broadcastSoon();
    if (!$('#keys').hidden) showShortcuts();
  });
  window.addEventListener('beforeunload', () => bus?.close());

  // The display normally runs in kiosk mode with no browser chrome, and the
  // standby screen (the usual route to Settings) is hidden whenever a controller
  // is connected. These keys are the way back in mid-lecture - and `?` is the
  // one that means you do not have to remember the others.
  document.addEventListener('keydown', (ev) => {
    if (VIEWER) return;
    // Settings is a form, and this handler is on the document: without this
    // guard a room called "spare" pairs, opens Settings and stands the display
    // down while you are still typing it.
    // Escape closes Settings even from inside one of its fields - the one key
    // the guard below must not swallow (Issue #201).
    if (ev.key === 'Escape' && !setupEl.hidden) { closeSetup(); return; }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target?.tagName)) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

    switch (ev.key) {
      // Shift+/ on most layouts, but not all - accept the bare key too.
      case '?':
      case '/':
        ev.preventDefault();
        toggleShortcuts();
        break;
      case 'g':
      case 'G':
        // Only before the room has gone live: the arm screen is the one thing
        // this key does, so once it is gone there is nothing left for G to do -
        // firing goLive() again would be a harmless but pointless re-request of
        // fullscreen and the wake lock.
        if (!armEl.hidden) { ev.preventDefault(); goLive(); }
        break;
      case 'f':
      case 'F':
        ev.preventDefault();
        toggleFullscreen().catch(() => { /* the browser said no; nothing to do */ });
        break;
      case 'e':
      case 'E':
        ev.preventDefault();
        standDown();
        break;
      case 'b':
      case 'B':
        // A real navigation, not a toggle - but nothing is lost by it: the
        // pagehide listener (see flushPersistence) saves state and ink before
        // the browser leaves, the same safety net that covers a reload or a
        // crash, so coming back to this room picks up exactly where this left.
        ev.preventDefault();
        location.href = 'index.html';
        break;
      case 'p':
      case 'P':
        ev.preventDefault();
        $('#pair').hidden ? showPairing() : hidePairing();
        break;
      case 's':
      case 'S':
        ev.preventDefault();
        hidePairing();
        hideShortcuts();
        showSetup();
        break;
      case 'Escape':
        hidePairing();
        hideShortcuts();
        break;
      default:
        break;
    }
  });

  $('#room-name').textContent = cfg.room;
  $('#standby-room').textContent = cfg.room;
  $$('.relay-target').forEach((n) => { n.textContent = relayTarget(cfg); });

  // Down here rather than beside restoreInk() at the top: restoreState reads
  // consts declared further down the file, and a `const` - unlike a function
  // declaration - is not hoisted, so calling it early threw before anything else
  // on this page could run.
  const resumed = restoreState();

  // Say so rather than silently putting last lecture's slide back up: coming
  // back to content you did not expect is its own kind of surprise in front of
  // a room.
  if (resumed) {
    $('#arm-resume-what').textContent = `Picking up where this screen left off — ${resumed}.`;
    $('#arm-resume').hidden = false;
  }
  $('#arm-resume-clear').addEventListener('click', () => {
    state.program = { type: 'black', title: 'Black' };
    state.panels = [0, 1, 2].map(() => ({ type: 'black', title: 'Black' }));
    state.layout = 'single';
    state.focus = 0;
    state.overlay = { text: '', visible: false, live: false };
    $('#arm-resume').hidden = true;
    commit();
  });

  // The room's own reset: unlike "Start black instead" above (content only,
  // and only ever shown next to a genuinely resumable session), this clears
  // everything a previous session can leave behind - including the things
  // that are deliberately NOT gated by staleness because they are meant to
  // outlive an accidental reload (a watermark, ink on a slide, the music
  // queue) - and wipes both localStorage keys so a subsequent reload does not
  // bring any of it back either. Offered unconditionally: the first time this
  // room hosts a different class is exactly when "resume where I left off"
  // is the wrong default, and nothing else on this screen catches that case.
  $('#arm-fresh-session').addEventListener('click', () => {
    const fresh = initialState();
    state.program = fresh.program;
    state.panels = fresh.panels;
    state.recall = fresh.recall;
    state.layout = fresh.layout;
    state.focus = fresh.focus;
    state.overlay = fresh.overlay;
    state.timers = fresh.timers;
    state.volume = fresh.volume;
    state.contentVolume = fresh.contentVolume;
    state.micVolume = fresh.micVolume;
    state.muted = fresh.muted;
    state.music = fresh.music;
    state.watermark = fresh.watermark;
    state.ink.bySurface = {};
    try { localStorage.removeItem(stateStorageKey()); } catch { /* private mode */ }
    try { localStorage.removeItem(inkStorageKey()); } catch { /* private mode */ }
    $('#arm-resume').hidden = true;
    $('#arm-fresh-session-note').textContent = 'Cleared.';
    // And the session record with it: the next Go live opens a NEW lecture
    // rather than resuming whatever this room still had open. Clearing the
    // room's saved session and then filing the next class under the last one's
    // record would be the same mistake in a place nobody would think to look.
    startFresh = true;
    commit();
  });

  if (!isConfigured(cfg)) {
    showSetup();
  } else {
    armEl.hidden = false;
    sizeInk();
    // Everything that fails BEFORE a socket exists rejects out of createBus:
    // no Web Crypto (a page served over plain http), a transport adapter whose
    // CDN is blocked, a relay URL that is not a URL or is the wrong scheme.
    // This module uses top-level await, so an unhandled rejection here aborts
    // the REST of the module - render() below never ran, and the screen just
    // sat there looking hung instead of saying what was wrong.
    try {
      await connect();
    } catch (err) {
      setHud('error', err?.message || String(err));
    }
    // Unattended signage (Issue #151): the one thing an ordinary display always
    // requires a real click for is right here (see goLive's own comment on the
    // audio-unlock gesture) - a kiosk has nobody to click it, on the very first
    // load and again after every crash, reboot or power flicker. Run regardless
    // of whether connect() above succeeded: a kiosk's job is to keep showing
    // whatever it was showing, relay or no relay, not to sit on the arm screen
    // waiting for a controller that will never come. If the browser was not
    // actually launched with the autoplay-exempting flags the docs ask for,
    // this fails exactly the way an early manual click already does today, and
    // the existing self-heals-on-the-next-gesture fallback still applies.
    if (cfg.kiosk) { goLive(); startKioskScheduling(); }
  }
}


render();
