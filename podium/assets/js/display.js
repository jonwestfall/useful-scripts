// The display: one browser tab on the classroom PC, fullscreen, showing only
// what a controller tells it to.
//
// It holds the single authoritative state, applies incoming commands, and
// broadcasts the result. Panel A's two content layers alternate between
// program and preview so that TAKE swaps which one is visible instead of
// rebuilding it - a cued video keeps its playhead and a cued page keeps its
// scroll position. A layout can split the screen into up to four panels
// (see LAYOUTS in protocol.js); B/C/D are simpler; set directly, no preview.

import { $, el, throttle, wireDangerButton } from './util.js';
import { loadConfig, saveConfig, isConfigured, pairingUrl, resetDevice, reloadClean, DEFAULTS } from './config.js';
import { createBus } from './bus.js';
import { initialState, applyCommand, inkSurfaceKey, LAYOUTS, focusedItem } from './protocol.js';
import { createRenderer } from './renderers.js';
import { createCameraReceiver } from './rtc.js';

const HEARTBEAT_MS = 2000;
const TELEMETRY_MS = 400;

const stage = $('#stage');
const inkCanvas = $('#ink');
const blankEl = $('#blank');
const overlayEl = $('#overlay');
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

// A controller can be mid-reload when we ask, so keep asking for a while.
setInterval(() => {
  for (const id of deckWanted) {
    if (deckStore.has(id)) { deckWanted.delete(id); continue; }
    bus?.send({ t: 'deck-need', id });
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

function mount(layer, item) {
  freeLayer(layer);
  layer.key = item.key;
  layer.renderer = createRenderer(item, {
    getTimer: () => state.timer,
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
      want.layer.renderer.update(want.item);
    }
    want.layer.node.dataset.role = want.role;
  }
  for (const layer of layers) {
    if (!claimed.has(layer)) layer.node.dataset.role = 'idle';
  }

  const audio = { volume: state.volume, muted: state.muted };
  for (const want of wanted) {
    if (want.role === 'preview') {
      // A cued clip is silent and parked, so it does not drift out of sync
      // with the moment you eventually take it.
      want.layer.renderer.reconcile({ ...want.item, playing: false }, { volume: 0, muted: true });
    } else {
      want.layer.renderer.reconcile(want.item, audio);
    }
  }

  // B/C/D: only as many as the current layout actually shows.
  const panelCount = LAYOUTS[state.layout] || 1;
  extraLayers.forEach((layer, i) => {
    const item = i + 1 < panelCount ? state.panels[i] : null;
    layer.slot.classList.toggle('is-on', !!item);
    if (!item) { if (layer.key) freeLayer(layer); return; }
    if (layer.key !== item.key) mount(layer, item);
    else layer.renderer.update(item);
    // The room's sound stays with panel A even when it is not the focused
    // one - two panels both playing audio at once would just be noise, and
    // there is no "cue" step here to decide which one meant to be heard.
    layer.renderer.reconcile(item, { volume: 0, muted: true });
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

// --- laser pointer -----------------------------------------------------------
//
// Deliberately outside `state`: a live gesture, not a document. Positions
// arrive already mapped through the controller's own content-shaped preview
// of whichever panel has focus, so the same fraction lands in the same spot
// here via contentRectFor() - that panel's own letterboxed bounds, exactly
// like ink.

let laserHideTimer = null;

function showLaser(msg) {
  if (!msg?.on) { hideLaser(); return; }
  const { slot, renderer } = focusedPanel();
  const rect = contentRectFor(slot, renderer);
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

// --- rendering the rest of the chrome --------------------------------------

function render() {
  blankEl.classList.toggle('is-on', state.blank);
  overlayEl.textContent = state.overlay.text;
  overlayEl.classList.toggle('is-on', state.overlay.visible && !!state.overlay.text);
  document.body.classList.toggle('is-frozen', state.frozen);
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
      strokes: inkState.bySurface[key]?.strokes || [],
    },
    stageAspect: stage.clientWidth && stage.clientHeight ? stage.clientWidth / stage.clientHeight : 16 / 9,
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

function saveInkSoon() {
  clearTimeout(inkSaveTimer);
  inkSaveTimer = setTimeout(() => {
    try { localStorage.setItem(inkStorageKey(), JSON.stringify(state.ink.bySurface)); } catch { /* quota or private mode */ }
  }, INK_SAVE_MS);
}

function restoreInk() {
  try {
    const saved = JSON.parse(localStorage.getItem(inkStorageKey()) || 'null');
    if (saved && typeof saved === 'object') state.ink.bySurface = saved;
  } catch { /* corrupt or absent - start with a blank slate */ }
}

function commit() {
  state.rev++;
  render();
  broadcastSoon();
  saveInkSoon();
}

// --- connection -------------------------------------------------------------

function setHud(status, detail) {
  hud.dataset.status = status;
  // The arming sheet covers the HUD, so mirror the state onto it: you should
  // be able to see the display is on the bus before you commit the room to it.
  $('#arm-status').textContent = {
    connecting: 'Connecting to the relay…',
    online: 'Connected and waiting for a controller.',
    offline: 'Lost the relay — retrying.',
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
      if (msg.t === 'rtc') { camera.handle(msg); return; }
      if (msg.t === 'sync') { broadcast(); return; }
      if (msg.t === 'laser') { showLaser(msg); return; }
      if (msg.t === 'ink-need') {
        // Exporting marked-up slides: hand back every surface belonging to
        // this deck, keyed by slide index, so the controller can composite
        // ink onto its own rendering of each slide without a round trip per
        // slide.
        const prefix = `deck:${msg.deckId}:`;
        const bySlide = {};
        for (const [key, surface] of Object.entries(state.ink.bySurface)) {
          if (!key.startsWith(prefix)) continue;
          const slide = Number(key.slice(prefix.length));
          if (Number.isInteger(slide) && surface.strokes.length) bySlide[slide] = surface.strokes;
        }
        bus.send({ t: 'ink-data', deckId: msg.deckId, bySlide });
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
});

// Arming is only about the things a browser will not give a page without a
// gesture: sound, fullscreen and the wake lock. The display is already on the
// bus by this point, so a controller can see it - and see that it is waiting
// for this click - rather than the room looking empty.
// A one-sample silent WAV, inlined so the unlock below needs no network
// round trip. Its only job is to be something real for the browser to play.
const SILENT_CLIP = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==';

async function goLive() {
  armEl.hidden = true;
  document.body.classList.add('is-live');
  state.armed = true;

  // Two separate autoplay gates exist, and they do not unlock each other:
  // resuming an AudioContext (below) only covers the Web Audio API: it does
  // nothing for a plain <audio>/<video> element's own autoplay policy, which
  // is the one that actually governs Waiting Music and every video/YouTube
  // item. Safari in particular enforces that gate strictly and separately.
  // The one thing every engine reliably honors is an actual media element's
  // play() called synchronously inside the click - so that happens first,
  // before anything else gets a chance to spend this gesture.
  try {
    const unlock = new Audio(SILENT_CLIP);
    unlock.muted = true;
    await unlock.play();
    unlock.pause();
  } catch { /* best effort - the per-clip retry-on-next-gesture below covers the rest */ }

  try { await new (window.AudioContext || window.webkitAudioContext)().resume(); } catch { /* noop */ }
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* user can press F11 */ }
  await requestWakeLock();
  sizeInk();
  commit();
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
document.addEventListener('fullscreenchange', () => { sizeInk(); broadcastSoon(); });
window.addEventListener('beforeunload', () => bus?.close());

// The display normally runs in kiosk mode with no browser chrome, and the
// standby screen (the usual route to Settings) is hidden whenever a controller
// is connected. These keys are the way back in mid-lecture.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'p' || ev.key === 'P') { $('#pair').hidden ? showPairing() : hidePairing(); }
  if (ev.key === 's' || ev.key === 'S') { hidePairing(); showSetup(); }
  if (ev.key === 'Escape') { hidePairing(); }
});

$('#room-name').textContent = cfg.room;
$('#standby-room').textContent = cfg.room;

if (!isConfigured(cfg)) {
  showSetup();
} else {
  armEl.hidden = false;
  sizeInk();
  await connect();
}

render();
