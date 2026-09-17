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
  $, $$, el, uid, throttle, wireDangerButton, servedBuild, createRelayLog, installOfflineShell,
  enterFullscreen, exitFullscreen, toggleFullscreen, isFullscreen, onFullscreenChange,
} from './util.js';
import { loadConfig, saveConfig, isConfigured, pairingUrl, relayTarget, resetDevice, reloadClean, DEFAULTS, pollBaseUrl, pollJoinUrl } from './config.js';
import { createBus } from './bus.js';
import {
  initialState, applyCommand, inkSurfaceKey, inkDigest, LAYOUTS, focusedItem, timerById, BUILD,
  MUSIC_DUCK, MUSIC_DUCK_MS, MUSIC_PAUSE_MS, SET_TICK_MS,
} from './protocol.js';
import { createRenderer, itemTitle, TYPES } from './renderers.js';
import { encodeToFit } from './store.js';
import { MAX_ASSET_CHARS } from './planfile.js';
import { createCameraReceiver } from './rtc.js';
import { serverInfo } from './server.js';

const HEARTBEAT_MS = 2000;
const TELEMETRY_MS = 400;

const stage = $('#stage');
const inkCanvas = $('#ink');
const blankEl = $('#blank');
const overlayEl = $('#overlay');
const watermarkEl = $('#watermark');
const watermarkImgEl = $('#watermark-img');
const watermarkTextEl = $('#watermark-text');
const laserEl = $('#laser');
const hud = $('#hud');
const standby = $('#standby');
const setupEl = $('#setup');
const armEl = $('#arm');

let cfg = await loadConfig();
let bus = null;
let state = initialState();
let cameraStream = null;
let wakeLock = null;

restoreInk();

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
const assetStore = new Map();
const assetWanted = new Set();

// A 1x1 transparent GIF: what the projector shows for the moment between an
// item going up and its photo arriving, rather than a broken-image icon.
const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Called only where an item is handed to a RENDERER, never on the way into
// `state`: resolving it any earlier would make this screen's ink surface keys
// and layer keys disagree with every controller's.
function resolveAssets(item) {
  if (!item || typeof item.src !== 'string' || !item.src.startsWith('asset:')) return item;
  const id = item.src.slice(6);
  if (assetStore.has(id)) return { ...item, src: assetStore.get(id) };
  assetWanted.add(id);
  bus?.send({ t: 'asset-need', id });
  return { ...item, src: BLANK_PIXEL };
}

// A controller can be mid-reload when we ask, so keep asking for a while.
setInterval(() => {
  for (const id of deckWanted) {
    if (deckStore.has(id)) { deckWanted.delete(id); continue; }
    bus?.send({ t: 'deck-need', id });
  }
  for (const id of assetWanted) {
    if (assetStore.has(id)) { assetWanted.delete(id); continue; }
    bus?.send({ t: 'asset-need', id });
  }
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
  layer.renderer?.destroy();
  layer.renderer = null;
  layer.key = null;
  layer.node.replaceChildren();
}

let cameraStatus = 'idle';

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
    onEnded: () => handleMediaEnded(key),
    getPollJoinUrl: (pollId) => pollJoinUrl(cfg, pollId),
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

  // B/C/D: only as many as the current layout actually shows.
  const panelCount = LAYOUTS[state.layout] || 1;
  extraLayers.forEach((layer, i) => {
    const item = i + 1 < panelCount ? state.panels[i] : null;
    layer.slot.classList.toggle('is-on', !!item);
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
$('#build-number').textContent = String(BUILD);
servedBuild().then((served) => {
  if (served === null || served === BUILD) return;
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
    const rect = contentRectFor(panel.slot, panel.renderer);
    const strokes = state.ink.bySurface[inkSurfaceKey(panel.item)]?.strokes || [];
    for (const stroke of strokes) strokePath(ctx, stroke, rect);
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

function redrawInk(force = false) {
  // A canvas that had to be re-sized is a blank one: nothing to append to.
  if (ensureInkCanvas()) force = true;
  if (state.layout !== 'single') { redrawSplitInk(); return; }
  const { ctx } = ink;
  const rect = contentRectFor(slotA, programRenderer());
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
    && strokes.length === ink.drawnStrokes;

  if (appended && last) {
    strokePath(ctx, last, rect, ink.drawnTail);
  } else {
    ctx.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
    for (const stroke of strokes) strokePath(ctx, stroke, rect);
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
  const embedded = { web: 'an embedded web page', slides: 'an embedded slide deck', pdf: 'a PDF in the browser\'s own viewer', youtube: 'a YouTube player' }[type];
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
async function takeShot(target) {
  ensureInkCanvas();
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  if (!stageW || !stageH) throw new Error('this screen has no size yet');

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
  ctx.drawImage(inkCanvas, 0, 0, stageW, stageH);
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
  const item = panels[0]?.item;
  // Photograph a panel, put that photo back in the panel, photograph it again:
  // without this the titles nest ("Panel A - Panel A - Whiteboard") until they
  // are unreadable. One prefix is enough to say where it came from.
  const base = itemTitle(item).replace(/^Panel [A-D] — /, '');
  const title = wholeScreen ? 'Whole screen' : `Panel ${PANEL_LABELS[target]} — ${base}`;
  return { dataUrl: shrunk.dataUrl, title, width: shrunk.width, height: shrunk.height, tooBig: shrunk.tooBig };
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
    if (!['video', 'audio', 'youtube'].includes(panel.item?.type)) return false;
    return !!panel.renderer?.telemetry?.().playing;
  });
}

function musicTarget() {
  if (state.muted) return 0;
  // The same master that scales the content channel (see syncLayers) scales
  // this one too - one fader for "everything is too loud", each channel's
  // own level set once in the Mixer and mostly left alone.
  return state.music.volume * state.volume * (contentIsSounding() ? MUSIC_DUCK : 1);
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
  if (!musicError) return;
  musicError = '';
  broadcastSoon();
});

function syncMusic() {
  const music = state.music;
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
  }

  const target = musicTarget();
  // What the level will be once everything in flight has finished, which is
  // what a decision about it has to be made against.
  const heading = musicFade ? musicFadeTo : musicEl.volume;

  if (music.playing) {
    if (musicEl.paused || changed) {
      // A play() the browser refuses (nobody has clicked Go live yet) is not
      // an error worth showing: the click that arms this screen commits state
      // again, which brings us straight back here.
      musicEl.play().then(() => rampMusic(target, music.fadeMs)).catch(() => {});
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
  if (applyCommand(state, { op: 'music', action: 'next', auto: true })) commit();
});

// Ducking depends on what content is doing, which nothing commits state for -
// so it is re-checked on the same beat that carries playback telemetry.
setInterval(() => {
  if (!state.music.playing) return;
  if (Math.abs(musicTarget() - musicApplied.target) > 0.005) syncMusic();
}, TELEMETRY_MS);

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

// --- watermark ---------------------------------------------------------------
//
// A name or a logo pinned to one corner for the whole lecture, meant to end up
// IN a screen grab (see drawWatermark below) - not content, so it ignores
// freeze, survives blank deliberately (it sits ABOVE #blank in the stacking
// order - a station bug outlasts a panic-button cut to black, the same as it
// outlasts everything else on the stage), and it never takes a panel.

// Resolves the same `asset:<id>` scheme every panel item uses, but called
// from render() - every heartbeat - rather than once at mount time, so it
// cannot reuse resolveAssets() as-is: that function unconditionally sends
// asset-need on every call while unresolved, which here would mean asking
// once a second for as long as a slow connection takes to answer. Piggybacks
// on the same assetWanted set and its periodic re-ask loop instead, and only
// sends the first time a given id goes unresolved.
function watermarkImageSrc(ref) {
  if (!ref || !ref.startsWith('asset:')) return ref || '';
  const id = ref.slice(6);
  if (assetStore.has(id)) return assetStore.get(id);
  if (!assetWanted.has(id)) { assetWanted.add(id); bus?.send({ t: 'asset-need', id }); }
  return BLANK_PIXEL;
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
  let changed = false;
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
  if (changed) commit();
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
  if (!base) return;
  // A redisplayed poll from history carries a pollId (for a stable ink key)
  // but no token - it is a frozen snapshot of a question that finished, not a
  // live one, and has nothing on the relay left to fetch.
  for (const item of pollItems().filter((it) => it.token)) {
    if (pollFetchInFlight.has(item.pollId)) continue;
    pollFetchInFlight.add(item.pollId);
    const key = item.key;
    fetch(`${base}poll/${encodeURIComponent(item.pollId)}/results`, {
      headers: { authorization: `Bearer ${item.token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((tally) => {
        if (!tally) return;
        // The item this key names may have moved (TAKE, a fresh stage with
        // the same pollId re-asking the question) or left the screen
        // entirely by the time this resolves - find it fresh rather than
        // trust the reference captured before the fetch went out.
        const current = pollItems().find((it) => it.key === key);
        if (!current) return;
        const changed = current.open !== tally.open || current.voters !== tally.voters
          || JSON.stringify(current.counts) !== JSON.stringify(tally.counts)
          || JSON.stringify(current.answers) !== JSON.stringify(tally.answers);
        if (!changed) return;
        current.open = !!tally.open;
        current.voters = tally.voters || 0;
        if (current.kind === 'choice') current.counts = tally.counts || [];
        else current.answers = tally.answers || [];
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

let lectureId = null;       // the lecture being written, while live
let eventQueue = [];
let flushTimer = null;
let flushing = false;
let lastSurface = null;     // the ink surface key the last entry described
let lastEventAt = 0;
let pendingEvent = null;
let pendingTimer = null;

// Said on the screen the room can see, rather than left to the docs: what goes
// on the projector being written down is the sort of thing people should not
// have to go looking for.
serverInfo().then((info) => {
  if (!info.features.includes('sessions')) return;
  const note = $('#arm-record');
  note.textContent = 'This lecture is saved to the server: what went on screen, your ink and any poll results. Photos are kept only if a controller is set to keep them.';
  note.hidden = false;
});

const lectureUrl = (id, suffix = '') => `/api/lectures/${encodeURIComponent(id)}${suffix}`;

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

async function startRecording() {
  if (lectureId) return;
  // Awaited rather than read off a flag the probe sets when it lands: Go live
  // can be clicked in the same second the page opened, and a lecture that went
  // unrecorded because of a race is exactly the kind of thing nobody would
  // notice until they went looking for it. serverInfo() only asks once.
  if (!(await serverInfo()).features.includes('sessions')) return;
  try {
    const res = await postJson('/api/lectures', { room: cfg.room });
    if (!res.ok) return;
    const { lecture } = await res.json();
    lectureId = lecture.id;
    state.lectureId = lecture.id;
    lastSurface = null;
    lastEventAt = 0;
    // Broadcast it: a controller ending a poll files the tally under this id.
    // commit() notes what is already on screen as the timeline's first entry.
    commit();
  } catch { /* no network: the lecture runs, only the record is lost */ }
}

async function stopRecording() {
  const id = lectureId;
  if (!id) return;
  lectureId = null;
  state.lectureId = null;
  clearTimeout(pendingTimer);
  if (pendingEvent) { eventQueue.push(pendingEvent); pendingEvent = null; }
  await flushEvents(id);
  await fileInk(id);
  try { await postJson(lectureUrl(id, '/end'), { at: Date.now() }); } catch { /* it stays open */ }
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
async function fileInk(id) {
  const surfaces = Object.fromEntries(
    Object.entries(state.ink.bySurface || {}).filter(([, strokes]) => strokes?.length),
  );
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
  const key = inkSurfaceKey(item);
  if (key === lastSurface) return;
  const opening = lastSurface === null;
  lastSurface = key;
  // Going live with nothing up yet is not a moment in the lecture. Later
  // blackouts are - "the projector went dark at 10:42" is real - so only the
  // opening one is dropped.
  if (opening && key === 'black') return;
  pendingEvent = { at: Date.now(), kind: 'program', title: itemTitle(item), detail: recordDetail(item) };
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(settleSurface, Math.max(0, RECORD_MIN_GAP_MS - (Date.now() - lastEventAt)));
}

function settleSurface() {
  if (!pendingEvent || !lectureId) return;
  lastEventAt = Date.now();
  // `at` is when the item went up, not when the gap expired: the entry should
  // say when the room started looking at this, not when this code got round
  // to writing it down.
  eventQueue.push(pendingEvent);
  pendingEvent = null;
  if (eventQueue.length > RECORD_QUEUE_MAX) eventQueue.splice(0, eventQueue.length - RECORD_QUEUE_MAX);
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flushEvents(lectureId); }, RECORD_FLUSH_MS);
}

async function flushEvents(id) {
  if (!id || flushing || !eventQueue.length) return;
  flushing = true;
  const batch = eventQueue.slice(0, RECORD_BATCH);
  try {
    const res = await postJson(lectureUrl(id, '/events'), { events: batch });
    // Only drop them once the server has them. A flush that fails leaves the
    // queue alone and the next one carries the same entries - which is the
    // whole reason this is a queue and not a request per slide.
    if (res.ok) eventQueue = eventQueue.slice(batch.length);
  } catch { /* keep them */ } finally {
    flushing = false;
  }
  if (eventQueue.length && !flushTimer) {
    flushTimer = setTimeout(() => { flushTimer = null; flushEvents(lectureId); }, RECORD_FLUSH_MS);
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
  syncMusic();
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
  const key = inkSurfaceKey(focusedItem(state));
  return {
    ...rest,
    ink: {
      color: inkState.color,
      width: inkState.width,
      surface: key,
      // A summary, not the strokes. This object goes out every two seconds -
      // and every 400ms while anything is playing - and the strokes of a
      // well-annotated whiteboard are hundreds of kilobytes, which is past
      // what any relay will carry. See inkDigest in protocol.js; a controller
      // that does not match asks for the surface with 'ink-pull' below.
      digest: inkDigest(inkState.bySurface[key]?.strokes),
    },
    stageAspect: stage.clientWidth && stage.clientHeight ? stage.clientWidth / stage.clientHeight : 16 / 9,
    // Where the music has got to, and whether something on screen is currently
    // talking over it - both things a controller can only learn from here.
    musicNow: {
      time: musicEl.currentTime || 0,
      duration: Number.isFinite(musicEl.duration) ? musicEl.duration : 0,
      ducked: state.music.playing && contentIsSounding(),
      error: musicError,
    },
    // So a controller can tell you when this screen is running older code
    // than it is, rather than leaving you to diagnose it as a bug.
    build: BUILD,
  };
}

function telemetry() {
  return focusedPanel().renderer?.telemetry() || { time: 0, duration: 0, playing: false };
}

function broadcast() {
  bus?.send({ t: 'state', state: wireState(), telemetry: telemetry() });
}

const broadcastSoon = throttle(broadcast, 60);

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
    try {
      // Without `cleared`: what a Clear stashed is undoable for as long as the
      // surface is on screen, not something to carry to next term, and keeping
      // it would double what the ink of a wiped board costs on disk.
      const saved = {};
      for (const [key, surface] of Object.entries(state.ink.bySurface)) {
        saved[key] = { strokes: surface.strokes, touched: surface.touched };
      }
      localStorage.setItem(inkStorageKey(), JSON.stringify(saved));
    } catch { /* quota or private mode */ }
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
let stateSaveTimer = null;

function stateStorageKey() {
  return `podium.state.${cfg.room}`;
}

function saveStateNow() {
  clearTimeout(stateSaveTimer);
  try {
    const { program, panels, layout, focus, timers, overlay, volume, contentVolume, muted, music, watermark } = state;
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
    localStorage.setItem(stateStorageKey(), JSON.stringify({
      savedAt: Date.now(), program, panels, layout, focus, timers, overlay, volume, contentVolume, muted, watermark, watermarkImageData,
      // The queue, not the playing: a reload lands on the arming screen, and
      // music that started itself the moment someone clicked Go live would be
      // a surprise in a room that had gone quiet.
      music: { ...music, playing: false },
    }));
  } catch { /* quota or private mode - the lecture just will not come back */ }
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
  saveInkNow();
  saveStateNow();
  beaconEvents();
}
window.addEventListener('pagehide', flushPersistence);

installOfflineShell();

// What was on screen, if this tab is coming back rather than starting fresh.
// Returns the item's name for the arming screen to mention, or null.
function restoreState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(stateStorageKey()) || 'null'); } catch { return null; }
  if (!saved || typeof saved !== 'object') return null;
  if (!Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt > STATE_MAX_AGE_MS) return null;
  if (!saved.program || saved.program.type === 'black') return null;

  state.program = saved.program;
  if (Array.isArray(saved.panels) && saved.panels.length === 3) state.panels = saved.panels;
  if (LAYOUTS[saved.layout]) state.layout = saved.layout;
  if (Number.isInteger(saved.focus) && saved.focus < (LAYOUTS[state.layout] || 1)) state.focus = saved.focus;
  // An endsAt is an absolute moment, so a countdown restored here is still
  // telling the truth about when it runs out.
  if (Array.isArray(saved.timers) && saved.timers.length) state.timers = saved.timers;
  if (saved.overlay && typeof saved.overlay === 'object') state.overlay = saved.overlay;
  if (Number.isFinite(saved.volume)) state.volume = saved.volume;
  if (Number.isFinite(saved.contentVolume)) state.contentVolume = saved.contentVolume;
  state.muted = !!saved.muted;
  if (saved.music && Array.isArray(saved.music.tracks)) {
    state.music = { ...state.music, ...saved.music, playing: false };
  }
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
  state.rev++;
  render();
  broadcastSoon();
  saveInkSoon();
  saveStateSoon();
  noteSurface();
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
  $('#arm-status').textContent = {
    connecting: `Connecting to the relay…${detail ? ` (${detail})` : ''}`,
    online: 'Connected and waiting for a controller.',
    offline: `Lost the relay — retrying.${detail ? ` ${detail}` : ''}`,
    error: `Cannot reach the relay${detail ? `: ${detail}` : ''}`,
    mismatch: 'Something nearby is using a different passphrase.',
  }[status] || status;
  hud.textContent = {
    connecting: 'Connecting…',
    online: `Ready · room ${cfg.room}`,
    offline: 'Reconnecting…',
    error: `Connection problem${detail ? `: ${detail}` : ''}`,
    mismatch: 'A device is using a different passphrase',
  }[status] || status;
  hud.classList.toggle('is-quiet', status === 'online');
  updateStandby();
}

let camera = null;

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
        syncLayers();
        // Same reason a deck redraws ink when it finishes mounting: until the
        // photo arrived, contentAspect() was answering for a 1x1 placeholder,
        // so any ink already on screen was painted against the wrong box.
        redrawInk(true);
        return;
      }
      if (msg.t === 'rtc') { camera.handle(msg); return; }
      if (msg.t === 'sync') { broadcast(); return; }
      if (msg.t === 'laser') { showLaser(msg); return; }
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
          if (!surface.strokes?.length) continue;
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
        if (applyCommand(state, msg)) commit();
      }
    },
  });

  camera = createCameraReceiver({
    bus,
    onStream: (stream) => { cameraStream = stream; syncLayers(); },
    onState: (status) => { cameraStatus = status; syncLayers(); },
  });

  $('#fingerprint').textContent = bus.fingerprint;
  $('#arm-code').textContent = bus.fingerprint;
  setInterval(broadcast, HEARTBEAT_MS);
  setInterval(() => {
    if (telemetry().playing) broadcast();
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
  if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
  if (document.hidden) flushPersistence();
});

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
function goLive() {
  armEl.hidden = true;
  document.body.classList.add('is-live');
  state.armed = true;

  const unlock = new Audio(SILENT_CLIP);
  unlock.muted = true;
  const audio = Promise.resolve(unlock.play())
    .then(() => unlock.pause())
    .catch(() => { /* best effort - each clip retries on the next gesture */ });

  let context = Promise.resolve();
  try { context = new (window.AudioContext || window.webkitAudioContext)().resume(); } catch { /* noop */ }

  const fullscreen = enterFullscreen().catch(() => { /* the user can still press F11 */ });

  sizeInk();
  commit();
  startRecording();
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
  commit();
  stopRecording();
  try { await exitFullscreen(); } catch { /* already windowed */ }
}

// --- setup screen -----------------------------------------------------------

let setupWired = false;

function showSetup() {
  setupEl.hidden = false;
  armEl.hidden = true;
  $('#setup-close').hidden = !isConfigured(cfg);
  const form = $('#setup-form');
  if (setupWired) return;
  setupWired = true;
  for (const [key, value] of Object.entries(cfg)) {
    const field = form.elements[key];
    if (field && typeof value !== 'boolean') field.value = value;
  }
  const onTransport = () => {
    const t = form.elements.transport.value;
    form.querySelectorAll('[data-for]').forEach((row) => {
      row.hidden = !row.dataset.for.split(' ').includes(t);
    });
  };
  form.elements.transport.addEventListener('change', onTransport);
  onTransport();

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    // `generated: null` because submitting this form IS the choice: the room
    // and passphrase it was pre-filled with were only a suggestion until now,
    // and isConfigured refuses a config still carrying that marker.
    const next = { ...cfg, generated: null };
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

// --- pairing ----------------------------------------------------------------

let pairTimer = null;

function showPairing() {
  const holder = $('#pair-qr');
  const url = pairingUrl(cfg);
  if (typeof window.qrcode === 'function') {
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    holder.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }
  $('#pair-url').textContent = url;
  $('#pair').hidden = false;
  clearTimeout(pairTimer);
  // The code grants control of this screen, so it does not stay up.
  pairTimer = setTimeout(hidePairing, 90000);
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

// --- wiring -----------------------------------------------------------------

$('#arm-button').addEventListener('click', goLive);
$('#arm-settings').addEventListener('click', showSetup);

// Reloading is the honest "cancel": it throws away half-finished edits and
// puts the page back into whatever state the saved settings describe.
$('#setup-close').addEventListener('click', reloadClean);

wireDangerButton($('#reset-device'), 'Clear settings & reload', async () => {
  const removed = await resetDevice();
  $('#reset-note').textContent = removed.length ? `Cleared ${removed.join(', ')}.` : 'Nothing was stored on this device.';
  reloadClean();
});
$('#pair-button').addEventListener('click', showPairing);
$('#pair-close').addEventListener('click', hidePairing);
$('#keys-close').addEventListener('click', hideShortcuts);
$('#standby-pair').addEventListener('click', showPairing);
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
  // Settings is a form, and this handler is on the document: without this
  // guard a room called "spare" pairs, opens Settings and stands the display
  // down while you are still typing it.
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target?.tagName)) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

  switch (ev.key) {
    case '?':
      // Shift+/ on most layouts, but not all - accept the bare key too.
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
  state.overlay = { text: '', visible: false };
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
  state.layout = fresh.layout;
  state.focus = fresh.focus;
  state.overlay = fresh.overlay;
  state.timers = fresh.timers;
  state.volume = fresh.volume;
  state.contentVolume = fresh.contentVolume;
  state.muted = fresh.muted;
  state.music = fresh.music;
  state.watermark = fresh.watermark;
  state.ink.bySurface = {};
  try { localStorage.removeItem(stateStorageKey()); } catch { /* private mode */ }
  try { localStorage.removeItem(inkStorageKey()); } catch { /* private mode */ }
  $('#arm-resume').hidden = true;
  $('#arm-fresh-session-note').textContent = 'Cleared.';
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
}

render();
