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
    slideCount: deck.count,
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
// staged, so library clicks go through here.
async function pick(item, where = 'auto') {
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
  $('#deck-count').textContent = `Slide ${index + 1} / ${total}`;
  $('#deck-prev').disabled = index === 0;
  $('#deck-next').disabled = index >= total - 1;

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

const pad = $('#pad');
const padCtx = pad.getContext('2d');
const ink = { drawing: false, strokeId: null, buffer: [], penOnly: false, color: '#ffd166', width: 6, strokes: [] };

function sizePad() {
  const ratio = window.devicePixelRatio || 1;
  const rect = pad.getBoundingClientRect();
  pad.width = Math.max(1, Math.round(rect.width * ratio));
  pad.height = Math.max(1, Math.round(rect.height * ratio));
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
        renderAll();
        renderConnection();
        return;
      }
      if (msg.t === 'deck-need') {
        const source = deckStore.get(msg.id);
        if (source != null) bus.send({ t: 'deck', id: msg.id, source });
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
  if (name === 'ink') sizePad();
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
  try {
    await cameraSender.start({ facingMode: facing });
    stage({ type: 'camera', title: 'Phone camera' });
  } catch (err) {
    setCameraState('failed');
    $('#cam-status').textContent = `Camera unavailable: ${err.message}`;
  }
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
