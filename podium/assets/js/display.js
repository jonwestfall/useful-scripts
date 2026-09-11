// The display: one browser tab on the classroom PC, fullscreen, showing only
// what a controller tells it to.
//
// It holds the single authoritative state, applies incoming commands, and
// broadcasts the result. Two content layers alternate between program and
// preview so that TAKE swaps which one is visible instead of rebuilding it -
// a cued video keeps its playhead and a cued page keeps its scroll position.

import { $, el, throttle } from './util.js';
import { loadConfig, saveConfig, isConfigured, pairingUrl, DEFAULTS } from './config.js';
import { createBus } from './bus.js';
import { initialState, applyCommand } from './protocol.js';
import { createRenderer } from './renderers.js';
import { createCameraReceiver } from './rtc.js';

const HEARTBEAT_MS = 2000;
const TELEMETRY_MS = 400;

const stage = $('#stage');
const inkCanvas = $('#ink');
const blankEl = $('#blank');
const overlayEl = $('#overlay');
const hud = $('#hud');
const standby = $('#standby');
const setupEl = $('#setup');
const armEl = $('#arm');

let cfg = await loadConfig();
let bus = null;
let state = initialState();
let cameraStream = null;
let wakeLock = null;

// --- two interchangeable content layers ------------------------------------

const layers = [0, 1].map(() => {
  const node = el('div', { class: 'layer' });
  stage.append(node);
  return { node, key: null, renderer: null };
});

function freeLayer(layer) {
  layer.renderer?.destroy();
  layer.renderer = null;
  layer.key = null;
  layer.node.replaceChildren();
}

function mount(layer, item) {
  freeLayer(layer);
  layer.key = item.key;
  layer.renderer = createRenderer(item, {
    getTimer: () => state.timer,
    getStream: () => cameraStream,
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
}

// --- ink overlay ------------------------------------------------------------

const ink = { ctx: inkCanvas.getContext('2d'), drawnStrokes: 0, drawnTail: 0 };

function sizeInk() {
  const ratio = window.devicePixelRatio || 1;
  inkCanvas.width = Math.round(stage.clientWidth * ratio);
  inkCanvas.height = Math.round(stage.clientHeight * ratio);
  ink.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  redrawInk(true);
}

function strokePath(ctx, stroke, w, h, from = 0) {
  if (stroke.pts.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const start = Math.max(0, from - 1);
  ctx.moveTo(stroke.pts[start][0] * w, stroke.pts[start][1] * h);
  for (let i = start + 1; i < stroke.pts.length; i++) {
    ctx.lineTo(stroke.pts[i][0] * w, stroke.pts[i][1] * h);
  }
  ctx.stroke();
}

function redrawInk(force = false) {
  const { ctx } = ink;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const strokes = state.ink.strokes;
  const last = strokes[strokes.length - 1];

  // Appending to the stroke in progress is the common case; only redraw the
  // whole board when strokes were removed or the canvas was resized.
  const appended = !force
    && strokes.length >= ink.drawnStrokes
    && ink.drawnStrokes > 0
    && strokes.length === ink.drawnStrokes;

  if (appended && last) {
    strokePath(ctx, last, w, h, ink.drawnTail);
  } else {
    ctx.clearRect(0, 0, w, h);
    for (const stroke of strokes) strokePath(ctx, stroke, w, h);
  }
  ink.drawnStrokes = strokes.length;
  ink.drawnTail = last ? last.pts.length : 0;
  inkCanvas.classList.toggle('has-ink', strokes.length > 0);
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

// Ink strokes stay on the display. Controllers draw their own pad locally, so
// shipping the full stroke list back to them every heartbeat would be waste.
function wireState() {
  const { ink: inkState, ...rest } = state;
  return { ...rest, ink: { color: inkState.color, width: inkState.width, count: inkState.strokes.length } };
}

function telemetry() {
  const programLayer = layers.find((l) => l.node.dataset.role === 'program');
  return programLayer?.renderer?.telemetry() || { time: 0, duration: 0, playing: false };
}

function broadcast() {
  bus?.send({ t: 'state', state: wireState(), telemetry: telemetry() });
}

const broadcastSoon = throttle(broadcast, 60);

function commit() {
  state.rev++;
  render();
  broadcastSoon();
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
      if (msg.t === 'rtc') { camera.handle(msg); return; }
      if (msg.t === 'sync') { broadcast(); return; }
      if (msg.t === 'cmd') {
        if (applyCommand(state, msg)) commit();
      }
    },
  });

  camera = createCameraReceiver({
    bus,
    onStream: (stream) => { cameraStream = stream; syncLayers(); },
    onState: () => syncLayers(),
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
async function goLive() {
  armEl.hidden = true;
  document.body.classList.add('is-live');
  state.armed = true;
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* user can press F11 */ }
  await requestWakeLock();
  // Resuming an AudioContext inside the click is what buys us autoplay later.
  try { await new (window.AudioContext || window.webkitAudioContext)().resume(); } catch { /* noop */ }
  sizeInk();
  commit();
}

// --- setup screen -----------------------------------------------------------

let setupWired = false;

function showSetup() {
  setupEl.hidden = false;
  armEl.hidden = true;
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
$('#pair-button').addEventListener('click', showPairing);
$('#pair-close').addEventListener('click', hidePairing);
$('#standby-pair').addEventListener('click', showPairing);
$('#standby-settings').addEventListener('click', showSetup);

window.addEventListener('resize', sizeInk);
window.addEventListener('beforeunload', () => bus?.close());

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'p' || ev.key === 'P') { $('#pair').hidden ? showPairing() : hidePairing(); }
  if (ev.key === 'Escape') hidePairing();
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
