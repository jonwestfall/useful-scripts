// The controller: iPad in your hand, iPhone in your pocket. Both can be
// connected at once and stay in step, because neither holds any state - they
// send commands and render whatever the display echoes back.

import { $, $$, el, uid, fmtTime, guessItemFromUrl, throttle, wireDangerButton, servedBuild, createRelayLog, installOfflineShell, onLongPress, miniMarkdown } from './util.js';
import { loadConfig, saveConfig, isConfigured, relayTarget, resetDevice, reloadClean, DEFAULTS, pollJoinUrl, pollBaseUrl } from './config.js';
import { createBus } from './bus.js';
import { initialState, applyCommand, timerRemaining, timerById, LAYOUTS, MAX_TIMERS, focusedItem,
  inkDigest, inkDigestsAgree, applyInkAction, strokeHitTest, BUILD, VERSION, COMMIT, versionStamp, MAX_SET_ENTRIES,
  detectAndSnapShape, snapStraightLine, snapArrow, snapBox, snapEllipse } from './protocol.js';
import { createRenderer, itemTitle, TYPES } from './renderers.js';
import { createCameraSender } from './rtc.js';
import { render as renderDeckSource, deckId, frontMatterTitle, themeReport, applyFits, cssForStandaloneSlide, applyPolyfill } from './deck.js';
import { createZip } from './zip.js';
import { createPdf, renderSessionPageToJpeg, renderPollPageToJpeg } from './pdf-writer.js';
import { readPlan, itemForStage, itemLabel, assetIdOf, assetRef, MAX_ASSET_CHARS } from './planfile.js';
import { loadCurrentPlan, saveCurrentPlan, clearCurrentPlan, readFileText, downscaleImage } from './store.js';
import { mountSessionBadge, serverInfo } from './server.js';

const LIB_KEY = 'podium.library.v1';

let cfg = await loadConfig();
let bus = null;

// Does nothing unless this Podium came from a server with accounts, which is
// the whole arrangement: one set of pages, extra affordances only where the
// thing serving them can back them. Not awaited - a slow probe must not hold
// up a controller someone is standing in front of a class with.
mountSessionBadge($('#session-badge'));
let state = initialState();
let telemetry = { time: 0, duration: 0, playing: false };
let telemetryAt = Date.now();
let previewRenderer = null;
let previewKey = null;
let scrubbing = false;

// Tactile haptic feedback (navigator.vibrate) for touch and navigation (Issue #32)
let suppressHaptics = false;

function haptic(pattern = 'tick') {
  if (suppressHaptics) return;
  if (typeof presentation !== 'undefined' && presentation?.haptics === false) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    if (pattern === 'tick') {
      navigator.vibrate(15);
    } else if (pattern === 'double') {
      navigator.vibrate([10, 30, 10]);
    } else if (pattern === 'pulse') {
      navigator.vibrate(30);
    } else if (pattern === 'alert') {
      navigator.vibrate([80, 50, 80, 50, 120]);
    } else if (typeof pattern === 'number' || Array.isArray(pattern)) {
      navigator.vibrate(pattern);
    }
  } catch {
    // Graceful no-op on security restrictions or unsupported contexts
  }
}

function triggerCommandHaptic(cmd) {
  if (!cmd || typeof cmd !== 'object') return;
  switch (cmd.op) {
    case 'nav':
      haptic('tick');
      break;
    case 'freeze':
      haptic('double');
      break;
    case 'blank':
    case 'take':
      haptic('pulse');
      break;
  }
}

const send = (cmd) => {
  if (cmd?.op === 'music') {
    applyCommand(state, cmd);
    renderMusic();
    renderMixer();
  }
  checkPacingAutoStart(cmd);
  triggerCommandHaptic(cmd);
  return bus?.send({ t: 'cmd', ...cmd });
};

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
// Which entries came from the loaded plan. assetStore also holds this
// session's camera stills, which have nothing to do with any plan, so loading
// or clearing one drops exactly the plan's own photos and leaves the stills
// where they are.
let planAssetIds = new Set();

function forgetPlanAssets() {
  for (const id of planAssetIds) { assetStore.delete(id); assetsSent.delete(id); }
  planAssetIds = new Set();
}

// Items reach the display holding `asset:<id>`, not the bytes - the item is in
// `state`, which is rebroadcast twice a second and is what ink surfaces are
// keyed by. Only the local preview renderers resolve it, and only at the point
// of handing an item to one, so every key stays identical on both ends.
// A 1x1 transparent GIF, for the moment between wanting a photo and holding
// its bytes. Without it an unresolved `asset:<id>` reaches an <img> as a URL
// with a scheme no browser knows, which is a broken image and a console error
// rather than a blank.
const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
// id -> when this device last asked for it. resolveAssets() runs on every
// heartbeat, so without a note of that it would ask twice a second for as long
// as the answer took; with one it asks, waits, and asks again only if the
// display was not there to hear it.
const assetWanted = new Map();
const ASSET_ASK_MS = 3000;

function wantAsset(id) {
  const now = Date.now();
  if (now - (assetWanted.get(id) || 0) < ASSET_ASK_MS) return;
  assetWanted.set(id, now);
  bus?.send({ t: 'asset-need', id });
}

function resolveAssets(item) {
  if (!item) return item;
  const id = assetIdOf(item.src);
  if (id === null) return item;
  const data = assetStore.get(id);
  if (data) return { ...item, src: data };
  // This controller does not have the bytes: it reloaded mid-lecture, or the
  // photo was taken on the other device before this one joined. The display
  // has them - it is the one screen that holds everything on screen - so ask,
  // and show nothing rather than a broken image until it answers.
  wantAsset(id);
  return { ...item, src: BLANK_PIXEL };
}

// Requesting a deck's saved ink for export: the display holds the only full
// copy, keyed by deck+slide, so exporting asks for it rather than trying to
// reconstruct it from the one surface this device happens to be looking at.
// A whole deck's ink is the largest thing the app ever moves, so it arrives in
// slices (see chunkStrokes in display.js) and is stitched back together here.
const inkExportWaiters = new Map();
// The key the whole-session pull waits under, alongside the per-deck ones.
const ALL_INK = Symbol('all ink');

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

/**
 * Every surface the display has ink on, keyed the way inkSurfaceKey() keys
 * them - `deck:<id>:<slide>`, `whiteboard:<bg>`, `image:<src>`, and so on.
 * The display holds the only full copy; exporting a session is the one thing
 * that needs all of it at once.
 */
function requestAllInk(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const acc = { bySurface: {}, timer: null };
    const finish = () => { clearTimeout(acc.timer); inkExportWaiters.delete(ALL_INK); resolve(acc.bySurface); };
    const arm = () => { clearTimeout(acc.timer); acc.timer = setTimeout(finish, timeoutMs); };
    acc.add = (msg) => {
      for (const [key, strokes] of Object.entries(msg.bySurface || {})) {
        (acc.bySurface[key] ||= []).push(...strokes);
      }
      if (msg.last) finish();
      else arm();
    };
    arm();
    inkExportWaiters.set(ALL_INK, acc);
    bus?.send({ t: 'ink-every-need' });
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
  { title: 'We begin in…', type: 'trackend' },
];

let library = [];

// A saved custom item referencing an uploaded asset (a photo, say) needs its
// bytes to survive too, not just the asset:<id> reference - assetStore is
// memory-only, so without this a "Saved" photo tile works for exactly the
// session it was uploaded in and shows a blank screen every time after,
// forever, with nothing left anywhere holding the bytes to answer for it.
// Carried as an extra field on the way to and from localStorage only; every
// caller elsewhere in the app still sees a plain item with a plain src.
function loadCustom() {
  let items;
  try { items = JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); } catch { return []; }
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const { _assetData, ...clean } = item;
    if (_assetData && typeof clean.src === 'string' && clean.src.startsWith('asset:')) {
      assetStore.set(clean.src.slice(6), _assetData);
    }
    return clean;
  });
}

function saveCustom(items) {
  try {
    const withBytes = items.map((item) => {
      if (typeof item.src !== 'string' || !item.src.startsWith('asset:')) return item;
      const data = assetStore.get(item.src.slice(6));
      return data ? { ...item, _assetData: data } : item;
    });
    localStorage.setItem(LIB_KEY, JSON.stringify(withBytes));
  } catch { /* private mode, or enough saved photos to run into the quota */ }
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

// Uploaded to a server of your own, rather than committed to the repository.
// An ADDITIONAL source, never a replacement: content/manifest.json is still
// read, still merged, and still the only one that exists on GitHub Pages.
// Silence on any failure is deliberate - a library that cannot be reached is
// a smaller problem than a controller that will not start because of it.
async function loadServerLibrary() {
  try {
    const info = await serverInfo();
    if (!info.features.includes('library')) return [];
    const res = await fetch('/api/library', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const { items } = await res.json();
    // Bookkeeping the projector has no use for is dropped here rather than
    // being carried into the protocol state as unexplained extra keys.
    return (items || []).map(({ id, filename, bytes, createdAt, createdBy, course, ...item }) => ({
      ...item,
      // A course becomes the group heading when nothing more specific was
      // given, which is what makes the existing filter box a course filter.
      group: item.group || (course ? course.toUpperCase() : 'Library'),
      serverId: id,
    }));
  } catch {
    return [];
  }
}

async function loadLibrary() {
  let fromFile = [];
  let examplesEnabled = true;
  let builtInsConfig = null;
  const fromServer = loadServerLibrary();
  try {
    const res = await fetch(cfg.manifest, { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        fromFile = data.filter((i) => i && i.type);
      } else if (data && typeof data === 'object') {
        fromFile = (data.items || []).filter((i) => i && i.type && i.enabled !== false);
        if (typeof data.examplesEnabled === 'boolean') {
          examplesEnabled = data.examplesEnabled;
        }
        if (data.builtIns && typeof data.builtIns === 'object') {
          builtInsConfig = data.builtIns;
        }
      }
    }
  } catch { /* no manifest committed yet - built-ins and pasted links still work */ }

  if (!examplesEnabled) {
    fromFile = fromFile.filter((i) => (i.group || '').toLowerCase() !== 'working examples');
  }

  const activeBuiltIns = BUILT_INS.filter((i) => {
    if (!builtInsConfig) return true;
    const key = (i.title?.toLowerCase() === 'chalkboard') ? 'chalkboard' : (i.type || '').toLowerCase();
    return builtInsConfig[key] !== false;
  });

  library = [
    // The plan first: it is what you came to teach, and the built-ins are
    // always one scroll away.
    ...planLibraryItems(),
    ...activeBuiltIns.map((i) => ({ ...i, group: 'Quick' })),
    // Then what you put on your own server, ahead of the examples that ship
    // with Podium: one of those is Tuesday's lecture and the other is a demo.
    ...(await fromServer),
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
    // The group is in the haystack so that typing a course code narrows the
    // library to that course - the "filter, not a mode switch" the server-side
    // library was designed around (see VPS.md).
    if (filter && !`${item.title} ${item.type} ${item.group || ''} ${item.note || ''}`.toLowerCase().includes(filter)) continue;
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
      // Audio is the one type that can honestly be two different things: a
      // title card the room sees, or something playing behind everything
      // else that it never does. This is the second one, without leaving
      // the tab - the queue and the bottom bar pick it up on the next beat.
      if (item.type === 'audio' && item.src) {
        const musicBtn = el('span', {
          class: 'tile-music',
          title: 'Add to background music queue',
          onclick: (ev) => {
            ev.stopPropagation();
            send({ op: 'music', action: 'add', tracks: [{ src: item.src, title: item.title, artist: item.artist }] });
            musicBtn.textContent = '✓';
            clearTimeout(musicBtn._resetTimer);
            musicBtn._resetTimer = setTimeout(() => { musicBtn.textContent = '♪+'; }, 1400);
          },
        }, '♪+');
        tile.append(musicBtn);
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
  forgetPlanAssets();
  for (const [id, asset] of Object.entries(plan.assets || {})) {
    assetStore.set(id, asset.data);
    planAssetIds.add(id);
  }

  for (const row of plan.items) {
    if (row.type !== 'deck' || !row.asset) continue;
    const source = plan.assets?.[row.asset]?.data;
    if (typeof source !== 'string') continue;
    const id = await deckId(source);
    deckStore.set(id, source);
    row.deckId = id;
    try {
      const deck = await renderDeckSource(source, id);
      row.slideCount = deck.count;
      row.fragments = deck.fragments;
    } catch {}
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
  if (plan.autoLaunch?.enabled) {
    send({ op: 'layout', mode: plan.layout || 'single' });
  } else if (plan.layout && plan.layout !== 'single') {
    send({ op: 'layout', mode: plan.layout });
  }
  if (plan.timers.length) {
    // Ids carried through from the plan, so its countdown items name the same
    // clocks the display just created.
    send({
      op: 'timer',
      action: 'define',
      timers: plan.timers.slice(0, MAX_TIMERS).map((t) => ({ id: t.id, label: t.label, seconds: t.mins * 60 })),
    });
  }

  if (plan.autoLaunch?.enabled) {
    suppressHaptics = true;
    try {
      const isFreeze = plan.autoLaunch.initialState === 'freeze';
      const isBlank = plan.autoLaunch.initialState === 'blank';

      if (isFreeze) {
        send({ op: 'freeze', on: true });
      }

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
            if (staged.src) pushAssetIfHeld(staged.src);
            if (item.type === 'deck' && item.deckId && deckStore.has(item.deckId)) {
              bus?.send({ t: 'deck', id: item.deckId, source: deckStore.get(item.deckId) });
              if (i === 0) {
                try {
                  const deck = await renderDeckSource(deckStore.get(item.deckId), item.deckId);
                  deckGeneration++;
                  deckView = { id: item.deckId, deck };
                } catch {}
              }
            }
            if (i === 0) {
              send({ op: 'stage', item: staged, where: isFreeze ? 'preview' : 'auto' });
            } else {
              send({ op: 'panel', index: i - 1, item: staged });
            }
          }
        } else if (p.type === 'set' && Array.isArray(p.entries) && p.entries.length) {
          const entries = [];
          for (const e of p.entries) {
            const item = plan.items.find((it) => it.id === e.itemId);
            if (!item) continue;
            const staged = itemForStage(item);
            if (staged.src) pushAssetIfHeld(staged.src);
            if (item.type === 'deck' && item.deckId && deckStore.has(item.deckId)) {
              bus?.send({ t: 'deck', id: item.deckId, source: deckStore.get(item.deckId) });
            }
            entries.push({ item: staged, seconds: e.seconds || 15 });
          }
          if (entries.length) {
            const setItem = {
              type: 'set',
              title: p.title || `Pane ${key} set`,
              mode: p.mode === 'random' ? 'random' : 'sequential',
              entries,
            };
            if (i === 0) {
              send({ op: 'stage', item: setItem, where: isFreeze ? 'preview' : 'auto' });
            } else {
              send({ op: 'panel', index: i - 1, item: setItem });
            }
          }
        }
      }

      if (isBlank) {
        send({ op: 'blank', on: true });
      }

      if (plan.autoLaunch.music?.playlist) {
        const musicConfig = plan.autoLaunch.music;
        if (!playlists.length) {
          try { await loadPlaylists(); } catch {}
        }
        let targetName = musicConfig.playlist;
        let matchedPlaylist = null;
        let matchedAudioItem = null;

        if (targetName.startsWith('item:')) {
          const itemId = targetName.slice(5);
          matchedAudioItem = plan.items.find((it) => it.id === itemId);
        } else {
          if (targetName.startsWith('playlist:')) targetName = targetName.slice(9);
          matchedPlaylist = playlists.find((l) => l.name === targetName) || playlists[Number(targetName)];
          if (!matchedPlaylist) {
            matchedAudioItem = plan.items.find((it) => it.type === 'audio' && (it.id === targetName || it.title === targetName));
          }
        }

        if (matchedPlaylist) {
          send({
            op: 'music',
            action: 'load',
            tracks: matchedPlaylist.tracks,
            name: matchedPlaylist.name,
            play: musicConfig.autoplay !== false,
          });
        } else if (matchedAudioItem) {
          send({
            op: 'music',
            action: 'load',
            tracks: [{ src: matchedAudioItem.src, title: matchedAudioItem.title, artist: matchedAudioItem.artist }],
            name: matchedAudioItem.title || 'Audio',
            play: musicConfig.autoplay !== false,
          });
        }

        if (typeof musicConfig.volume === 'number') {
          send({ op: 'music', action: 'volume', value: musicConfig.volume });
        }
      }

      if (plan.autoLaunch.timer?.timerId) {
        const timer = plan.timers.find((t) => t.id === plan.autoLaunch.timer.timerId);
        if (timer) {
          send({
            op: 'timer',
            action: 'start',
            id: timer.id,
            seconds: timer.mins * 60,
            label: timer.label || '',
          });
        }
      }
    } finally {
      suppressHaptics = false;
    }
  }
}

// --- where you just were -----------------------------------------------------
//
// Picking a deck out of the Library always stages it from slide 0, so the
// commonest interruption in a lecture - a student asks something, you put up a
// photo, you go back - used to restart the deck from the beginning in front of
// everyone. Nothing anywhere kept a history.
//
// The display's own state is the right place to read one from: it carries the
// live slide, page and playhead, so a snapshot of the item you are LEAVING is
// automatically the item at the position you left it.

const RECENT_MAX = 6;
let recent = [];
let lastProgram = null;

// What makes two items "the same thing", ignoring position: going from slide 3
// to slide 4 is not leaving the deck.
function itemIdentity(item) {
  if (!item) return null;
  // A set has none of src/deckId/timerId/body/data, so every one of them
  // fell back to the same bare "set:" and looked identical to every other
  // set - which broke the point of this function twice over: two DIFFERENT
  // sets on screen one after another looked like the same thing twice (no
  // "back to" chip for the first one), and going back to a set B while set A
  // sat in Recent removed A from the strip too, matched by A's own identity.
  // `key` is unique per staged instance, which is also the right answer here
  // for a reason nothing else needed: "back to" a specific run of a set,
  // mid-rotation, is not the same as starting that same saved set over.
  if (item.type === 'set') return `set:${item.key}`;
  return `${item.type}:${item.deckId || item.src || item.timerId || item.body || item.data || ''}`;
}

function recentWhere(item) {
  if (item.type === 'set') return `${(item.index || 0) + 1} of ${item.entries?.length || 0}`;
  if (item.type === 'deck') return `slide ${(item.slide || 0) + 1}${item.slideCount ? ` of ${item.slideCount}` : ''}`;
  if (item.type === 'pdf') return `page ${item.page || 1}`;
  if (item.type === 'slides') return `slide ${(item.slide || 0) + 1}`;
  if (item.startAt) return fmtTime(item.startAt);
  return TYPES[item.type]?.label || item.type;
}

// A clip's position is in telemetry, not in the item, so it has to be folded in
// WHILE the clip is the one on screen. By the time you have left it, telemetry
// already belongs to whatever replaced it - stamping the outgoing item then
// would give it the new item's playhead.
function withPosition(item) {
  if (!item || !['video', 'audio', 'youtube'].includes(item.type)) return item;
  if (!Number.isFinite(telemetry?.time) || telemetry.time < 1) return item;
  return { ...item, startAt: Math.floor(telemetry.time) };
}

function trackRecent() {
  const leaving = lastProgram;
  // `key` is the identity protocol.js reissues on every stage, so it is
  // meaningless on the way back in for everything with a real content
  // identifier (src/deckId/...) - except a set, which has none of those and
  // whose itemIdentity() falls back to key for exactly that reason. Strip it
  // for everything else, keep it for a set, or every set collapses into one
  // shared "set:undefined" identity and Recent cannot tell any two apart.
  const { key: _k, ...now } = state.program || {};
  lastProgram = state.program ? withPosition(state.program.type === 'set' ? { ...now, key: state.program.key } : now) : null;

  if (!leaving || itemIdentity(leaving) === itemIdentity(lastProgram)) return;
  if (leaving.type === 'black' || leaving.type === 'camera') return;

  recent = [leaving, ...recent.filter((i) => itemIdentity(i) !== itemIdentity(leaving))].slice(0, RECENT_MAX);
}

function renderRecent() {
  // Never offer "back to" the thing already on screen.
  const here = itemIdentity(state.program);
  const list = recent.filter((item) => itemIdentity(item) !== here);
  $('#recent-bar').hidden = !list.length;
  $('#recent').replaceChildren(...list.map((item) => el('button', {
    class: 'recent-chip', type: 'button',
    onclick: () => pick(item),
  },
    el('span', {}, itemTitle(item)),
    el('span', { class: 'where' }, recentWhere(item)))));
}

// Sends a fully-formed item wherever it belongs right now. Panel A (focus 0)
// goes through the usual freeze/cue/take pipeline via 'stage'. A focused
// B/C/D panel has none of that - see "layout" in protocol.js's
// initialState() - so it is set directly and immediately via 'panel'
// instead, and `where` (an explicit program/preview target) does not apply.
// Push the bytes ahead of an item that refers to them, so the projector does
// not have to notice and ask. Once each: a photo is ~120 KB and re-picking
// it is common, while a display that reloaded and lost it asks for it by
// name (see 'asset-need').
function pushAssetIfHeld(src) {
  const assetId = assetIdOf(src);
  if (assetId && assetStore.has(assetId) && !assetsSent.has(assetId)) {
    if (bus?.send({ t: 'asset', id: assetId, data: assetStore.get(assetId) }) !== false) assetsSent.add(assetId);
  }
}

function stage(item, where = 'auto') {
  // Only a deck needs this: it is the only type whose pad shape depends on
  // content that has to be parsed, so it is the only one that can be picked
  // and drawn on before the pad actually knows what shape to be.
  pendingStage = item.type === 'deck' ? { panel: state.focus, deckId: item.deckId } : null;
  // group/custom/order/note/planRow are library bookkeeping; the display has no
  // use for them.
  const { group: _g, custom: _c, order: _o, note: _n, planRow: _p, ...clean } = item;
  pushAssetIfHeld(clean.src);
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
  // Building a set redirects every tap in the Library into it instead of
  // staging live - checked first, ahead of camera/deck's own special
  // handling, since this applies to a tap on absolutely anything.
  if (addToDraftSet(item)) return;
  if (item.type === 'camera') { await startCamera(where); return; }
  // A planned poll is a question, not yet a poll - it has no pollId or token
  // until something actually creates it on the relay, which is what the Polls
  // tab's composer does. Tapping it in the Library loads that composer rather
  // than trying to stage an item protocol.js would reject for missing fields.
  if (item.type === 'poll') { openPollDraftFromPlan(item); return; }
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

const trackDurations = new Map();

function probeTrackDuration(src) {
  if (!src || trackDurations.has(src)) return;
  try {
    const fullUrl = new URL(src, location.href).href;
    if (trackDurations.has(fullUrl)) {
      trackDurations.set(src, trackDurations.get(fullUrl));
      return;
    }
    const a = new Audio();
    a.preload = 'metadata';
    a.src = fullUrl;
    const onDone = (dur) => {
      trackDurations.set(src, dur);
      trackDurations.set(fullUrl, dur);
      a.removeEventListener('loadedmetadata', onLoaded);
      a.removeEventListener('error', onError);
    };
    const onLoaded = () => {
      const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
      onDone(d);
    };
    const onError = () => {
      onDone(0);
    };
    a.addEventListener('loadedmetadata', onLoaded);
    a.addEventListener('error', onError);
    setTimeout(() => {
      if (!trackDurations.has(src)) onDone(0);
    }, 4000);
  } catch {
    trackDurations.set(src, 0);
  }
}

function getQueueRemainingControl() {
  const music = state.music;
  if (!music?.tracks?.length) return 0;
  const idx = Math.max(0, Math.min(music.index || 0, music.tracks.length - 1));
  const currentTrack = music.tracks[idx];
  const currentDur = (Number.isFinite(state.musicNow?.duration) && state.musicNow.duration > 0 ? state.musicNow.duration : null)
    ?? trackDurations.get(currentTrack?.src)
    ?? (typeof currentTrack?.duration === 'number' && Number.isFinite(currentTrack.duration) ? currentTrack.duration : null);
  if (currentDur == null) return null;
  const currentTime = state.musicNow?.time || 0;
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

// What a track-countdown item's renderer reads for a live number: the
// controller has no <audio> of its own, so this is state.musicNow (the
// display's own telemetry, broadcast every heartbeat) rather than anything
// measured locally - a preview mirror, same as everything else here.
function getMusicNowPreview() {
  const queueRem = Number.isFinite(state.musicNow?.queueRemaining)
    ? state.musicNow.queueRemaining
    : getQueueRemainingControl();
  return {
    hasTrack: !!state.music?.tracks?.length,
    time: state.musicNow?.time || 0,
    duration: state.musicNow?.duration || 0,
    queueRemaining: queueRem,
  };
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
      previewRenderer = createRenderer(resolveAssets(item), { preview: true, getTimer: (id) => timerById(state, id), getMusicNow: getMusicNowPreview, getDeckSource, resolveAssets, getPollJoinUrl: (pollId) => pollJoinUrl(cfg, pollId) });
      holder.append(previewRenderer.el);
    }
  } else if (previewRenderer && item) {
    previewRenderer.update(resolveAssets(item));
    previewRenderer.reconcile({ ...item, playing: false }, { volume: 0, muted: true });
  }

  $('#preview-label').textContent = state.preview ? 'Cued' : (state.previewLayout !== null ? 'Layout cued' : 'On screen');
  $('#preview-title').textContent = itemTitle(item);
  $('#preview-pane').classList.toggle('is-cued', !!state.preview || state.previewLayout !== null);
}

// --- Marp deck panel --------------------------------------------------------

// "Now" and "Next" live previews - a confidence monitor for the deck on
// screen, declared up front since renderSlides() needs them from its first
// call; createLiveMirror itself is defined down with the ink pad, which it
// shares its "contain"-fit geometry with.
const nowMirror = createLiveMirror($('#deck-now-preview'));
const nextMirror = createLiveMirror($('#deck-next-preview'));

let gridShadow = null;
// Keyed by deck id rather than a plain "is it built" flag, so a second call
// for the SAME deck that arrives while the first is still running (the
// fire-and-forget call from the deck-view update, immediately followed by
// Export) reuses that one in-flight build instead of either racing it or
// skipping the wait entirely - see buildGrid() below.
let gridBuildId = null;
let gridBuildPromise = null;
let activeSectionFilter = null;
let lastScrolledSlideIndex = null;
let selectedChipSection = null;

function getSlideSectionIndex(sections, slideIndex) {
  if (!sections || !sections.length) return -1;
  let secIdx = -1;
  for (let k = 0; k < sections.length; k++) {
    if (sections[k].slideIndex <= slideIndex) {
      secIdx = k;
    } else {
      break;
    }
  }
  return secIdx;
}

function renderSectionChips(deck) {
  const container = $('#deck-grid-chips');
  if (!container) return;
  const sections = deck?.sections || [];
  if (!sections.length) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'deck-chip' + (activeSectionFilter === null ? ' is-active' : '');
  allBtn.dataset.section = 'all';
  allBtn.textContent = 'All';
  allBtn.addEventListener('click', () => {
    activeSectionFilter = null;
    selectedChipSection = null;
    updateChipClasses(container, 'all');
    filterGrid();
  });
  container.append(allBtn);

  sections.forEach((sec, k) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'deck-chip' + (activeSectionFilter === k ? ' is-active' : '');
    chip.dataset.section = String(k);
    chip.textContent = sec.title;
    chip.title = `Section: ${sec.title} (Slide ${sec.slideIndex + 1})`;
    chip.addEventListener('click', () => {
      if (activeSectionFilter === k) {
        // Second tap when filtered: reset back to All
        activeSectionFilter = null;
        selectedChipSection = null;
        updateChipClasses(container, 'all');
        filterGrid();
      } else if (selectedChipSection === k || activeSectionFilter !== null) {
        // Second tap on jumped chip, or switching filter while already filtered: isolate section
        activeSectionFilter = k;
        selectedChipSection = k;
        updateChipClasses(container, String(k));
        filterGrid();
        const cell = gridShadow?.querySelector(`.cell[data-index="${sec.slideIndex}"]`);
        cell?.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
      } else {
        // First tap: smoothly jump & scroll to that topic's first slide
        selectedChipSection = k;
        updateChipClasses(container, String(k));
        const cell = gridShadow?.querySelector(`.cell[data-index="${sec.slideIndex}"]`);
        cell?.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    });
    container.append(chip);
  });
}

function updateChipClasses(container, activeId) {
  if (!container) return;
  container.querySelectorAll('.deck-chip').forEach((chip) => {
    chip.classList.toggle('is-active', chip.dataset.section === activeId);
  });
}

function updateActiveSectionChip(slideIndex) {
  const container = $('#deck-grid-chips');
  if (!container || container.hidden) return;
  if (activeSectionFilter !== null) return;
  const sections = deckView?.deck?.sections;
  if (!sections?.length) return;
  const secIdx = getSlideSectionIndex(sections, slideIndex);
  const targetId = secIdx >= 0 ? String(secIdx) : 'all';
  container.querySelectorAll('.deck-chip').forEach((chip) => {
    const isActive = chip.dataset.section === targetId;
    chip.classList.toggle('is-active', isActive);
    if (isActive) {
      chip.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  });
}

function ensureGridShadow() {
  gridShadow ??= $('#deck-grid').attachShadow({ mode: 'open' });
  return gridShadow;
}

function buildGrid(deck) {
  if (gridBuildId === deck.id) return gridBuildPromise;
  gridBuildId = deck.id;
  lastScrolledSlideIndex = null;
  activeSectionFilter = null;
  selectedChipSection = null;
  gridBuildPromise = buildGridNow(deck);
  return gridBuildPromise;
}

async function buildGridNow(deck) {
  const shadow = ensureGridShadow();
  shadow.innerHTML = `<style>
    :host { display: block; }
    #grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px 8px; }
    .cell {
      display: block; cursor: pointer; background: none; border: none; padding: 0; text-align: left;
    }
    .cell[hidden] { display: none; }
    .thumb {
      position: relative; aspect-ratio: 16 / 9; overflow: hidden;
      background: #fff; border: 2px solid #2a3038; border-radius: 8px;
    }
    .cell.on .thumb { border-color: #6ea8fe; }
    /* Marpit scopes its slide CSS to div.marpit > svg > foreignObject > section,
       so each thumbnail keeps that wrapper or the slide loses all its sizing. */
    .thumb .marpit { position: absolute; inset: 0; }
    .thumb svg { display: block; width: 100%; height: 100%; }
    /* A thumbnail (and an export) shows a slide as finished, not bullet by
       bullet - the opposite of the live build, which starts with nothing
       revealed. Podium never ships a rule that hides .podium-fragment here,
       so this simply confirms that intent rather than leaning on the absence. */
    .podium-fragment { opacity: 1 !important; }
    .num {
      position: absolute; right: 3px; bottom: 3px; padding: 0 5px; border-radius: 4px;
      background: rgba(0,0,0,.65); color: #fff; font: 600 11px/1.6 system-ui, sans-serif;
    }
    .ink-badge {
      display: none;
      position: absolute; left: 3px; bottom: 3px; padding: 0 4px; border-radius: 4px;
      background: rgba(255, 209, 102, 0.95); color: #151b23; font: 700 11px/1.6 system-ui, sans-serif;
      box-shadow: 0 1px 3px rgba(0,0,0,0.5); pointer-events: none;
    }
    .cell.has-ink .ink-badge {
      display: inline-flex; align-items: center; justify-content: center;
    }
    /* A rendered thumbnail this small reads as a smear of colour, not text -
       the caption is what actually lets you find a slide by scanning, the
       same job the title attribute it replaces used to fail at on a
       touchscreen (a hover tooltip nothing here can hover). */
    .cap {
      margin-top: 4px; font-size: 12px; line-height: 1.3; color: #b7c0cc;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .cell.on .cap { color: #e7ecf2; font-weight: 600; }
  </style><style>${deck.css}</style><div id="grid"></div>`;

  const holder = document.createElement('div');
  holder.innerHTML = deck.html;
  // Thumbnails (and the PNG export, which rasterizes these very nodes) show a
  // slide shrunk exactly as much as the projector shrinks it.
  applyFits(holder, deck.fits);
  const grid = shadow.getElementById('grid');
  Array.from(holder.querySelectorAll('svg[data-marpit-svg]')).forEach((svg, i) => {
    const title = deck.titles[i] || `Slide ${i + 1}`;
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.dataset.index = String(i);
    cell.dataset.search = title.toLowerCase();
    const secIdx = getSlideSectionIndex(deck.sections, i);
    cell.dataset.section = String(secIdx);
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const marpit = document.createElement('div');
    marpit.className = 'marpit';
    marpit.append(svg);
    thumb.append(marpit);
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    const inkBadge = document.createElement('span');
    inkBadge.className = 'ink-badge';
    inkBadge.textContent = '✎';
    inkBadge.title = 'Annotated slide';
    thumb.append(num, inkBadge);
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = title;
    cell.append(thumb, cap);
    cell.addEventListener('click', () => send({ op: 'nav', dir: 'goto', value: i }));
    grid.append(cell);
  });
  renderSectionChips(deck);
  filterGrid();
  // Marp needs its own DOM polyfill for inline-SVG slides or WebKit (every
  // iPad, which is where this grid actually gets used) lays foreignObject
  // content out wrong - the exact bug renderDeck() already works around for
  // the live projector and the Now/Next mirrors. Run after the slides are
  // connected to the real document (inside this shadow root), which is what
  // the polyfill's own measurements need to be looking at.
  await applyPolyfill(shadow);
  // applyPolyfill()'s own promise resolves once it has registered its
  // Safari-detection check and started an ongoing requestAnimationFrame loop,
  // not once that check has actually run and corrected anything - the
  // correction itself lands a frame or two later (see the identical wait in
  // measureFits(), deck.js). renderDeck() can get away without this because
  // its slides stay mounted and the correction catches up unnoticed a frame
  // later; buildGrid() cannot, because Export rasterizes these exact SVGs the
  // moment this promise resolves, and an early snapshot would still bake in
  // the oversized, uncorrected layout.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function filterGrid() {
  if (!gridShadow) return;
  const filter = $('#deck-grid-filter').value.trim().toLowerCase();
  let shown = 0;
  gridShadow.querySelectorAll('.cell').forEach((cell) => {
    const textMatch = !filter || cell.dataset.search.includes(filter);
    const secIdx = Number(cell.dataset.section);
    const sectionMatch = activeSectionFilter === null || secIdx === activeSectionFilter;
    const match = textMatch && sectionMatch;
    cell.hidden = !match;
    if (match) shown += 1;
  });
  $('#deck-grid-empty').hidden = shown > 0;
}

function highlightGrid(index, deckId = (deckView.id || (focusedItem(state)?.type === 'deck' ? focusedItem(state)?.deckId : null))) {
  if (!gridShadow) return;
  const cells = gridShadow.querySelectorAll('.cell');
  const surfacesWithInk = new Set(state.ink?.surfaces || []);
  let activeCell = null;

  cells.forEach((cell) => {
    const i = Number(cell.dataset.index);
    const isOn = i === index;
    cell.classList.toggle('on', isOn);
    if (isOn) activeCell = cell;

    if (deckId) {
      const surfaceKey = `deck:${deckId}:${i}`;
      let hasStrokes = false;
      if (inkSurface === surfaceKey) {
        hasStrokes = (ink.strokes?.length || 0) > 0;
      } else {
        hasStrokes = surfacesWithInk.has(surfaceKey) || ((inkCache.get(surfaceKey)?.length || 0) > 0);
      }
      cell.classList.toggle('has-ink', hasStrokes);
    }
  });

  // Auto-scroll when the active slide changes
  if (lastScrolledSlideIndex !== index && activeCell && !activeCell.hidden) {
    const slidesPanel = $('[data-panel="slides"]');
    if (slidesPanel && !slidesPanel.hidden) {
      lastScrolledSlideIndex = index;
      activeCell.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
    }
  }

  updateActiveSectionChip(index);
}

async function ensureDeckView(item) {
  if (!item || item.type !== 'deck') {
    deckView = { id: null, deck: null };
    lastScrolledSlideIndex = null;
    activeSectionFilter = null;
    selectedChipSection = null;
    return;
  }
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
  const fragCount = (item.fragments && item.fragments[index]) || (deck?.fragments && deck.fragments[index]) || 0;
  // A slide that had to be shrunk to fit says so, rather than leaving you to
  // wonder why the type on the projector is not the size you authored.
  const fit = deck?.fits?.[index];
  const fitNote = Number.isFinite(fit) && fit < 1 ? ` · fit ${Math.round(fit * 100)}%` : '';
  $('#deck-count').textContent = fragCount
    ? `Slide ${index + 1} / ${total} · build ${step}/${fragCount}${fitNote}`
    : `Slide ${index + 1} / ${total}${fitNote}`;
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
    if (note) {
      notesEl.innerHTML = miniMarkdown(note);
    } else {
      notesEl.textContent = 'No notes on this slide.';
    }
    notesEl.classList.toggle('is-empty', !note);
  }

  // "Now" mirrors exactly what the projector shows, build step included.
  nowMirror.update(item);

  // "Next" previews the upcoming step: if the current slide has build steps
  // remaining, it shows the next build fragment on this slide so the presenter
  // knows what is about to appear. Once all fragments on the slide have been
  // revealed (or on slides with no builds), it previews the upcoming slide.
  if (step < fragCount) {
    nextMirror.update({ ...item, slide: index, step: step + 1 });
    const title = deck?.titles?.[index] ? `${index + 1}. ${deck.titles[index]}` : `Slide ${index + 1}`;
    $('#deck-next-title').textContent = `${title} · build ${step + 1}/${fragCount}`;
  } else if (index + 1 < total) {
    nextMirror.update({ ...item, slide: index + 1, step: (item.fragments && item.fragments[index + 1]) || (deck?.fragments && deck.fragments[index + 1]) || 0 });
    $('#deck-next-title').textContent = deck?.titles?.[index + 1] ? `${index + 2}. ${deck.titles[index + 1]}` : `Slide ${index + 2}`;
  } else {
    nextMirror.update(null);
    $('#deck-next-title').textContent = 'End of deck';
  }

  const problems = [deck?.themeWarning, ...themeReport.failed].filter(Boolean);
  const themeEl = $('#deck-theme');
  themeEl.textContent = problems.length ? problems[0] : (deck ? `theme: ${deck.theme}` : 'Rendering…');
  themeEl.classList.toggle('is-warning', problems.length > 0);

  if (deck) buildGrid(deck);
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

// Strokes are fractions of whatever they were drawn on, so the same handful of
// lines works for a slide, a whiteboard or a photo - only the box changes.
// Stroke widths were chosen by eye against the pad at whatever size it
// happened to be on screen, so they scale against a nominal 1280px-wide
// surface: an export at any resolution is then the same pen.
function paintStrokes(ctx, strokes, w, h) {
  const widthScale = w / 1280;
  for (const stroke of strokes || []) {
    if (!stroke.pts || stroke.pts.length < 2) continue;
    ctx.save();
    if (stroke.highlighter) {
      ctx.globalAlpha = 0.35;
    }
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(1, stroke.width * widthScale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(stroke.pts[0][0] * w, stroke.pts[0][1] * h);
    for (let i = 1; i < stroke.pts.length; i++) ctx.lineTo(stroke.pts[i][0] * w, stroke.pts[i][1] * h);
    ctx.stroke();
    ctx.restore();
  }
}

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
  // clone instead - re-scoped, because the .marpit wrapper its selectors are
  // written against does not come with it (see cssForStandaloneSlide).
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = cssForStandaloneSlide(css);
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

  paintStrokes(ctx, strokes, w, h);

  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas export was blocked (likely a cross-origin image in this deck)'))), 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

// --- exporting the whole session ---------------------------------------------
//
// One zip holding everything this lecture produced that is worth keeping:
// the photos in the strip, every deck slide that was annotated (with the ink
// on it), and every board or picture that was drawn on. The ink itself lives
// on the display - it is the only device that has all of it - so building the
// zip starts by pulling it over.
//
// Deliberately best-effort per item: a slide that will not rasterize, or a
// surface Podium cannot reconstruct (an embedded page, a camera frame that
// has long since moved on), is named in session.txt rather than failing the
// export that contains everything else.

const safeName = (text, fallback = 'item') => String(text || '')
  .replace(/[^a-z0-9-_ ]+/gi, '')
  .trim()
  .replace(/\s+/g, '-')
  .slice(0, 48)
  .toLowerCase() || fallback;

function dataUrlToBytes(dataUrl) {
  const base64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const canvasToPng = (canvas) => new Promise((resolve, reject) => {
  try {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the browser would not encode it'))), 'image/png');
  } catch (err) {
    reject(err);
  }
});

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => reject(new Error('timed out loading it')), 8000);
    const isBlob = typeof Blob !== 'undefined' && src instanceof Blob;
    const url = isBlob ? URL.createObjectURL(src) : src;
    img.onload = () => {
      clearTimeout(timer);
      if (isBlob) URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      if (isBlob) URL.revokeObjectURL(url);
      reject(new Error('it could not be loaded here'));
    };
    img.src = url;
  });
}

/**
 * A deck's slides, laid out off-screen so they can be rasterized whether or
 * not that deck is the one currently open on the Slides tab.
 */
async function mountDeckForExport(deck) {
  const host = el('div', { 'aria-hidden': 'true' });
  host.style.cssText = 'position:fixed;left:-30000px;top:0;width:1280px;visibility:hidden;pointer-events:none;z-index:-1';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>:host{display:block}svg[data-marpit-svg]{display:block;width:1280px;height:auto}</style><style>${deck.css}</style>${deck.html}`;
  document.body.append(host);
  applyFits(shadow, deck.fits);
  try { await document.fonts?.ready; } catch { /* measured in whatever face is here */ }
  return {
    svgs: Array.from(shadow.querySelectorAll('svg[data-marpit-svg]')),
    release: () => host.remove(),
  };
}

/** The markdown behind a deck id, from this device's cache or the server. */
async function deckSourceById(id) {
  if (deckStore.has(id)) return deckStore.get(id);
  if (!String(id).startsWith('src:')) return null;
  const src = String(id).slice(4);
  try {
    const res = await fetch(src, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    deckStore.set(id, text);
    return text;
  } catch {
    return null;
  }
}

// A board or a picture that was drawn on, rebuilt here: the surface key says
// what it was (see inkSurfaceKey in protocol.js), and the strokes are
// fractions of it, so the two compose exactly as they did on the wall.
async function renderInkSurface(key, strokes) {
  if (key.startsWith('whiteboard:')) {
    const bg = key.slice('whiteboard:'.length);
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bg && bg !== 'default' ? bg : '#f7f5ef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    paintStrokes(ctx, strokes, canvas.width, canvas.height);
    return { blob: await canvasToPng(canvas), name: `board-${safeName(bg, 'whiteboard')}` };
  }
  if (key.startsWith('image:')) {
    const src = key.slice('image:'.length);
    const id = assetIdOf(src);
    const url = id ? assetStore.get(id) : src;
    if (!url) throw new Error('the picture itself is not on this device');
    const img = await loadImage(url);
    const scale = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    paintStrokes(ctx, strokes, canvas.width, canvas.height);
    const photo = photos.find((p) => p.id === id);
    return { blob: await canvasToPng(canvas), name: safeName(photo?.title || src.split('/').pop(), 'picture') };
  }
  return null;   // a page, a PDF, a camera frame: nothing left to rebuild
}

let exporting = false;

async function exportSession() {
  if (exporting) return;
  exporting = true;
  const btn = $('#photo-export');
  const btnPdf = $('#photo-export-pdf');
  const status = $('#photo-export-status');
  btn.disabled = true;
  if (btnPdf) btnPdf.disabled = true;

  try {
    const { files, skipped, lines } = await collectSessionBundle(status);

    if (!files.length) {
      status.textContent = 'Nothing to export yet — take a photo, annotate something, or run a poll.';
      return;
    }

    if (skipped.length) lines.push('Not included:', ...skipped.map((line) => `  - ${line}`), '');
    lines.push(serverKeepsSessions && lastKnownLectureId
      ? (photosKept()
        ? 'This lecture is also kept on the server; the same files can be downloaded again from the Admin page.'
        : 'This lecture is also kept on the server, except its photos - this device is not set to keep them; everything else here can be downloaded again from the Admin page.')
      : 'Photos and ink are held only while the app is open; this zip is the copy that lasts.');
    files.push({ name: 'session.txt', data: new TextEncoder().encode(lines.join('\n')) });

    await fileExportWithLecture(files, status);

    status.textContent = 'Building the zip…';
    const blob = await createZip(files);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `podium-${safeName(cfg.room, 'session')}-${stamp}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    status.textContent = skipped.length
      ? `Saved ${files.length - 1} file${files.length === 2 ? '' : 's'}, with ${skipped.length} left out — see session.txt.`
      : `Saved ${files.length - 1} file${files.length === 2 ? '' : 's'}.`;
  } catch (err) {
    status.textContent = `Export failed: ${err.message}`;
  } finally {
    exporting = false;
    btn.disabled = !bus;
    if (btnPdf) btnPdf.disabled = !bus;
  }
}

async function exportSessionPdf() {
  if (exporting) return;
  exporting = true;
  const btn = $('#photo-export');
  const btnPdf = $('#photo-export-pdf');
  const status = $('#photo-export-status');
  btn.disabled = true;
  if (btnPdf) btnPdf.disabled = true;

  try {
    const { visualPages, pollRows, skipped } = await collectSessionBundle(status);
    const totalPages = visualPages.length + pollRows.length;

    if (!totalPages) {
      status.textContent = 'Nothing to export yet — take a photo, annotate something, or run a poll.';
      return;
    }

    const meta = {
      title: state.lectureTitle || cfg.title || cfg.room || 'Podium Session',
      course: cfg.course || '',
      room: cfg.room || '',
      date: new Date(),
    };

    const pages = [];
    let pageNum = 1;
    for (const item of visualPages) {
      status.textContent = `Rendering page ${pageNum} of ${totalPages}…`;
      const img = await loadImage(item.imgBlobOrData);
      const jpegPage = await renderSessionPageToJpeg(img, { ...meta, itemTitle: item.itemTitle, itemType: item.itemType, itemNote: item.itemNote }, pageNum, totalPages);
      pages.push(jpegPage);
      pageNum++;
    }

    for (const poll of pollRows) {
      status.textContent = `Rendering poll ${pageNum} of ${totalPages}…`;
      const jpegPage = await renderPollPageToJpeg(poll, meta, pageNum, totalPages);
      pages.push(jpegPage);
      pageNum++;
    }

    status.textContent = 'Building the PDF…';
    const blob = createPdf(pages, meta);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `podium-${safeName(cfg.room, 'session')}-${stamp}.pdf`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    status.textContent = skipped.length
      ? `Saved ${pages.length} page PDF, with ${skipped.length} left out.`
      : `Saved ${pages.length} page PDF.`;
  } catch (err) {
    status.textContent = `Export failed: ${err.message}`;
  } finally {
    exporting = false;
    btn.disabled = !bus;
    if (btnPdf) btnPdf.disabled = !bus;
  }
}

async function collectSessionBundle(status) {
  const files = [];
  const lines = [`Podium session — ${new Date().toLocaleString()}`, `Room: ${cfg.room}`, ''];
  const skipped = [];
  const visualPages = [];

  // 1. The photos
  if (photos.length) {
    status.textContent = 'Packing the photos…';
    lines.push(`Photos (${photos.length}):`);
    [...photos].reverse().forEach((photo) => {
      const data = assetStore.get(photo.id);
      if (!data) { skipped.push(`photo "${photo.title}" (no longer held)`); return; }
      const name = photoFileName(photo);
      files.push({ name, data: dataUrlToBytes(data) });
      visualPages.push({
        imgBlobOrData: data,
        itemTitle: photo.title || name,
        itemType: 'Photo capture',
        itemNote: new Date(photo.at).toLocaleTimeString(),
      });
      lines.push(`  ${name}  —  ${new Date(photo.at).toLocaleTimeString()}`);
    });
    lines.push('');
  }

  // 2. Everything the display has ink on
  status.textContent = 'Asking the display for your ink…';
  const bySurface = await requestAllInk();
  const surfaces = Object.entries(bySurface).filter(([, strokes]) => strokes?.length);

  if (!bus?.hasPeer('display')) {
    lines.push('The display was not connected while this was built, so no ink could be collected.', '');
    skipped.push('every annotation — the display was not connected, so its ink could not be fetched');
  }

  const deckSlides = new Map();
  const others = [];
  for (const [key, strokes] of surfaces) {
    const deckMatch = /^deck:(.+):(\d+)$/.exec(key);
    if (deckMatch) {
      const [, id, slide] = deckMatch;
      if (!deckSlides.has(id)) deckSlides.set(id, new Map());
      deckSlides.get(id).set(Number(slide), strokes);
    } else {
      others.push([key, strokes]);
    }
  }

  // 3. Annotated slides
  if (deckSlides.size) lines.push('Annotated slides:');
  for (const [id, slides] of deckSlides) {
    const source = await deckSourceById(id);
    if (source == null) {
      skipped.push(`${slides.size} annotated slide${slides.size === 1 ? '' : 's'} from a deck this device does not hold`);
      continue;
    }
    const deck = await renderDeckSource(source, id);
    const folder = `slides/${safeName(frontMatterTitle(source, 'deck'), 'deck')}`;
    const mounted = await mountDeckForExport(deck);
    try {
      for (const [index, strokes] of [...slides.entries()].sort((a, b) => a[0] - b[0])) {
        const svg = mounted.svgs[index];
        if (!svg) { skipped.push(`slide ${index + 1} of ${folder} (not in the deck any more)`); continue; }
        status.textContent = `Drawing slide ${index + 1} of ${deck.count}…`;
        try {
          const png = await rasterizeSlide(svg, deck.css, deck.aspects[index] || 16 / 9, strokes);
          const name = `${folder}/slide-${String(index + 1).padStart(2, '0')}.png`;
          files.push({ name, data: png });
          visualPages.push({
            imgBlobOrData: png,
            itemTitle: deck.titles[index] || `Slide ${index + 1}`,
            itemType: 'Annotated Slide',
            itemNote: `${folder} · slide ${index + 1}`,
          });
          lines.push(`  ${name}  —  ${deck.titles[index] || ''}`);
        } catch (err) {
          skipped.push(`slide ${index + 1} of ${folder} (${err.message})`);
        }
      }
    } finally {
      mounted.release();
    }
  }
  if (deckSlides.size) lines.push('');

  // 4. Boards and pictures
  if (others.length) lines.push('Other annotations:');
  let boardNumber = 0;
  for (const [key, strokes] of others) {
    status.textContent = 'Drawing your boards…';
    try {
      const made = await renderInkSurface(key, strokes);
      if (!made) { skipped.push(`ink on ${key} (nothing left to draw it on)`); continue; }
      boardNumber += 1;
      const name = `boards/${String(boardNumber).padStart(2, '0')}-${made.name}.png`;
      files.push({ name, data: made.blob });
      visualPages.push({
        imgBlobOrData: made.blob,
        itemTitle: made.name || 'Whiteboard',
        itemType: 'Annotated Board',
        itemNote: `${strokes.length} stroke${strokes.length === 1 ? '' : 's'}`,
      });
      lines.push(`  ${name}  —  ${strokes.length} stroke${strokes.length === 1 ? '' : 's'}`);
    } catch (err) {
      skipped.push(`ink on ${key} (${err.message})`);
    }
  }
  if (others.length) lines.push('');

  // 5. Polls
  const currentPoll = findPollItem();
  const pollRows = [...(currentPoll ? [{ ...currentPoll, endedAt: null }] : []),
    ...pollHistory.filter((row) => row.lectureId === lastKnownLectureId)];
  if (pollRows.length) {
    lines.push(`Polls (${pollRows.length}):`);
    pollRows.forEach((row, i) => {
      const name = `polls/${String(i + 1).padStart(2, '0')}-${safeName(row.question, row.pollId || 'poll')}.csv`;
      files.push({ name, data: new TextEncoder().encode(csvText(pollResultRows(row))) });
      lines.push(`  ${name}${row.endedAt ? `  —  ended ${new Date(row.endedAt).toLocaleTimeString()}` : '  —  still running when this was built'}`);
    });
    lines.push('');
  }

  return { files, visualPages, pollRows, skipped, lines };
}

// Every prefix (or exact name) an export's own bundle can ever produce - see
// the photos/, slides/, boards/ and polls/ names built above, and
// session.txt itself. Used only to decide what reconcileExportFiles may
// remove: anything outside this set (ink.json, for instance) belongs to a
// different filer entirely and reconciling an export must never touch it.
// photos/ is included here but reconcileExportFiles special-cases it further
// still - see the comment there.
const EXPORT_FILE_PREFIXES = ['photos/', 'slides/', 'boards/', 'polls/'];
const ownedByExport = (name) => name === 'session.txt' || EXPORT_FILE_PREFIXES.some((p) => name.startsWith(p));

/**
 * Send every file an export just built to the lecture the display opened.
 *
 * Sequential rather than all at once: this is a tablet on classroom Wi-Fi
 * sending several megabytes, and twenty parallel uploads is how that Wi-Fi
 * stops carrying the relay as well. Failures are counted, not thrown - the zip
 * in your hand is the copy that matters, and the server keeping fewer files
 * than it might is not a reason to fail the export.
 */
async function fileExportWithLecture(files, status) {
  // lastKnownLectureId, not recordingNow()/state.lectureId: the ordinary flow
  // is teach, stand down, THEN export, and standing down is exactly what
  // clears state.lectureId (see stopRecording in display.js). Gating this the
  // same way photos and polls are gated would mean a normal post-class export
  // never gets filed - see the comment on lastKnownLectureId above.
  const lectureId = lastKnownLectureId;
  if (!serverKeepsSessions || !lectureId) return;
  let sent = 0;
  let failed = 0;
  const keptNames = new Set(['session.txt']);
  for (const file of files) {
    // The one thing the switch on this tab governs (see filePhotoWithLecture).
    if (!photosKept() && file.name.startsWith('photos/')) continue;
    keptNames.add(file.name);
    status.textContent = `Keeping this session on the server… (${sent + 1} of ${files.length})`;
    const type = file.name.endsWith('.png') ? 'image/png'
      : file.name.endsWith('.jpg') ? 'image/jpeg'
        : file.name.endsWith('.csv') ? 'text/csv'
          : 'text/plain';
    if (await fileWithLecture(file.name, 'session', file.data, type, lectureId)) sent += 1;
    else failed += 1;
  }
  if (failed) status.textContent = `Kept ${sent} of ${sent + failed} files on the server; building the zip…`;
  await reconcileExportFiles(lectureId, keptNames, photosKept());
}

/**
 * The other half of "re-exporting replaces what an earlier one left":
 * addFile's own upsert (same lecture, same name) handles a file this export
 * still produces, but a name this export no longer produces AT ALL - a
 * photo the keep-switch has since turned off, one removed from the local
 * strip, a poll that aged out of history - has nothing to upsert onto and
 * would otherwise sit on the server forever, still downloadable, from
 * whichever earlier export DID include it. Best-effort and never allowed to
 * fail the export itself: the zip already built and handed to the teacher is
 * the copy that matters regardless of how this comes out.
 */
async function reconcileExportFiles(lectureId, keptNames, reconcilePhotos) {
  try {
    const res = await fetch(`/api/lectures/${encodeURIComponent(lectureId)}`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const { lecture } = await res.json();
    for (const existing of lecture.files || []) {
      if (keptNames.has(existing.name)) continue;
      const isPhoto = existing.name.startsWith('photos/');
      if (isPhoto) {
        // A photo is filed the instant it is taken (filePhotoWithLecture), not
        // by this export - the export only bundles whatever is still in the
        // local strip, which MAX_PHOTOS caps client-side. An older photo
        // missing from `keptNames` here can simply mean it scrolled out of
        // that cap, not that anyone asked to drop it; reconciling it away on
        // every re-export would silently undo a switch left on. Only actually
        // reconcile photos when the keep-photos switch is off for the whole
        // session, matching the per-file skip in fileExportWithLecture above.
        if (!reconcilePhotos) continue;
      } else if (!ownedByExport(existing.name)) {
        continue;
      }
      await fetch(`/api/lectures/${encodeURIComponent(lectureId)}/files?name=${encodeURIComponent(existing.name)}`,
        { method: 'DELETE', credentials: 'same-origin' }).catch(() => { /* best effort */ });
    }
  } catch { /* best effort - the zip in hand is still correct either way */ }
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
    await buildGrid(deck);
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
    if (document.activeElement !== $('#media-loop')) $('#media-loop').checked = !!item.loop;
  }

  const cued = !!state.preview || state.previewLayout !== null;
  $('#take').disabled = !cued;
  $('#take').classList.toggle('is-armed', cued);
  $('#swap').disabled = !state.preview;
  $('#clear-preview').disabled = !cued;
  $('#preview-mode').classList.toggle('is-on', state.previewMode);
  $('#mute').classList.toggle('is-on', state.muted);
  $('#mute').textContent = state.muted ? '\u{1F507}' : '\u{1F50A}';
  if (document.activeElement !== $('#volume')) $('#volume').value = state.volume;

  renderBottomSlots();

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

  checkTimerCompletions(timers);

  const ms = active ? timerRemaining(active) : 0;
  $('#timer-readout').textContent = fmtTime(Math.ceil(ms / 1000));
  $('#timer-readout').classList.toggle('is-urgent', !!active?.running && ms <= 30000);
  $('#timer-start').textContent = active?.running ? 'Pause' : ((active?.remainingMs || 0) > 0 ? 'Resume' : 'Start');
  $('#timer-add').disabled = timers.length >= MAX_TIMERS;
  // The first is what every timer item falls back to, so it is the one that
  // cannot go away.
  $('#timer-remove').hidden = timers.length <= 1 || timers[0]?.id === shownId;
}

const runningTimers = new Set();

function checkTimerCompletions(timers = state?.timers || []) {
  const now = Date.now();
  for (const timer of timers) {
    if (!timer || !timer.id) continue;
    if (timer.running) {
      const left = Math.max(0, timer.endsAt - now);
      if (left > 0) {
        runningTimers.add(timer.id);
      } else if (runningTimers.has(timer.id)) {
        runningTimers.delete(timer.id);
        haptic('alert');
      }
    } else {
      runningTimers.delete(timer.id);
    }
  }
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
  $$('.layout-btn').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.layout === state.layout);
    // Frozen and waiting on TAKE - see the 'layout' case in protocol.js.
    b.classList.toggle('is-cued', state.previewLayout !== null && b.dataset.layout === state.previewLayout);
  });
  $('#panel-promote').hidden = state.focus === 0;
  const count = LAYOUTS[state.layout] || 1;
  const picker = $('#panel-picker');
  picker.hidden = count <= 1;
  if (count <= 1) return;
  if (picker.childElementCount !== count) {
    picker.replaceChildren(...Array.from({ length: count }, (_, i) => {
      const button = el('button', {
        class: 'panel-btn',
        type: 'button',
        title: `Focus panel ${PANEL_LABELS[i]} — hold to photograph it`,
        onclick: () => send({ op: 'focus', index: i }),
      }, PANEL_LABELS[i]);
      // Tap to focus, hold to keep a photo of what is in it - ink and all.
      // The same button, because the panel you want a photo of is the one you
      // are already pointing at.
      onLongPress(button, HOLD_PANEL_MS, () => askForShot(i, `panel ${PANEL_LABELS[i]}`));
      return button;
    }));
  }
  $$('.panel-btn', picker).forEach((b, i) => b.classList.toggle('is-on', i === state.focus));
}

let mixerSliding = null;   // which fader, if any, is being dragged right now

function renderMixer() {
  const pct = (v) => `${Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 100)}%`;
  if (mixerSliding !== 'master') {
    $('#mixer-master').value = String(state.volume);
    $('#mixer-master-pct').textContent = pct(state.volume);
  }
  if (mixerSliding !== 'content') {
    $('#mixer-content').value = String(state.contentVolume ?? 1);
    $('#mixer-content-pct').textContent = pct(state.contentVolume ?? 1);
  }
  if (mixerSliding !== 'music' && !musicSliding) {
    $('#mixer-music').value = String(state.music.volume);
    $('#mixer-music-pct').textContent = pct(state.music.volume);
  }
}

// Audience polls: a normal item once staged, but composing and running one
// needs its own tab because the relay call (create/open/close/delete a poll
// row, keyed by a token this tab is the only place that ever sees) is not
// part of the stage/cue/take protocol the rest of Podium runs on. "One at a
// time" is a UX rule, not something the protocol enforces, so this tab just
// looks for whichever single poll item is staged anywhere right now.
let pollDraft = null;    // { kind, question, options } while composing, else null
let pollBusy = false;    // a relay call is in flight - disable the buttons that would race it
let pollError = '';      // composer-side validation/relay error
let pollActionError = ''; // running-poll-side relay error (close/reopen/end)
let pollEndButton = null; // the wireDangerButton handle for #poll-end, wired further down
let pollCurrentClosesAt = null;
let pollTickTimer = null;

function tickPollCountdown() {
  const cd = document.getElementById('poll-running-countdown');
  if (!cd || !pollCurrentClosesAt) return;
  const remaining = Math.max(0, Math.ceil((pollCurrentClosesAt - Date.now()) / 1000));
  cd.hidden = false;
  const m = Math.floor(remaining / 60);
  const s = String(remaining % 60).padStart(2, '0');
  cd.textContent = remaining >= 60 ? `Voting closes in ${m}:${s}` : `Voting closes in ${s} seconds`;
  cd.style.color = remaining <= 10 ? '#ff9d9d' : 'var(--dim)';
  if (remaining === 0) {
    cd.hidden = true;
    const item = findPollItem();
    if (item && item.open !== false && !pollBusy) setPollOpen(false);
  }
}

function findPollItem() {
  return [state.program, state.preview, ...state.panels].find((it) => it?.type === 'poll') || null;
}

// Polls this device has ended since the tab loaded - localStorage rather than
// the plan or the relay, because neither is the right owner: a plan is
// written in the office before any votes exist, and the relay forgets a poll
// the moment it is deleted (see endPoll). This is purely "what did *I* just
// run", the same shelf life as the Saved library.
const POLL_HISTORY_KEY = 'podium.pollHistory.v1';
const MAX_POLL_HISTORY = 20;

function loadPollHistory() {
  try {
    const rows = JSON.parse(localStorage.getItem(POLL_HISTORY_KEY) || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}
function savePollHistory() {
  try { localStorage.setItem(POLL_HISTORY_KEY, JSON.stringify(pollHistory.slice(0, MAX_POLL_HISTORY))); } catch { /* private mode, or quota */ }
}
let pollHistory = loadPollHistory();

function addToPollHistory(entry) {
  pollHistory = [{ id: uid(8), ...entry }, ...pollHistory].slice(0, MAX_POLL_HISTORY);
  savePollHistory();
  filePollWithLecture(entry);
}

// --- filing this lecture's record with the server ----------------------------
//
// Only on a Podium with a server behind it, and silent everywhere else. What
// this device holds that nothing else does - a poll's final tally, the photos
// in the strip, and the pages an export rasterizes - is sent to the lecture the
// display opened when it went live. Which lecture that is comes from
// state.lectureId, broadcast in the shared state (see protocol.js).
//
// The controller files polls rather than the display because the controller is
// what ends a poll and the only thing that ever holds the final counts, and
// photos for the same reason: they live here. Everything is best-effort and
// silent - a file that fails to send is still in the strip, still exportable,
// and still on screen, and none of it is worth interrupting a class about.
let serverKeepsSessions = false;
serverInfo().then((info) => {
  serverKeepsSessions = info.features.includes('sessions');
  renderKeepPhotos();
});

const recordingNow = () => serverKeepsSessions && !!state.lectureId;

// The lecture an export should be filed under, which is NOT always the live
// one: the ordinary flow is teach, press E to stand down, THEN find the
// export button - and standing down is exactly what sets state.lectureId back
// to null (see stopRecording in display.js). Gating the export on
// recordingNow() the way photos and polls are gated would mean a normal
// post-class export is never filed, despite every other kept file promising
// it will be. This tracks the most recent lecture this controller has seen,
// live or just-ended, and only moves on once a NEW one actually starts -
// updated from the bus's own state handler below, the one place state.lectureId
// changes.
let lastKnownLectureId = null;

// Photos are the one payload here that is somebody else's: a worksheet, a
// board mid-argument, a face at the back of the room. Podium's long-standing
// answer was that they live in memory until you press Export, so the server
// keeping them is OFF unless somebody has said otherwise - store no more than
// you have to, and let the person who knows the room decide.
//
// Two levels, because they answer different questions. Settings > Presentation
// holds the DEFAULT for this device, which is where "my lectures should keep
// their photos" belongs: decided once, in the office. The switch on the Photos
// tab is this lecture only, which is where "not this one" belongs: a guest
// speaker, a room with a camera on the students. It starts from the default and
// is forgotten on reload, so an exception never quietly becomes the rule.
//
// Either way it governs the photo filed as it is taken and the photos inside a
// filed export. Ink, poll CSVs and the rest of an export are not anyone else's
// picture and are kept whenever there is a lecture to keep them with.
let keepPhotosThisSession = null;      // null = whatever the default says
// Which lecture that override belongs to - undefined until the first check,
// so the very first lecture of a fresh page load does not itself look like a
// change. Compared against lastKnownLectureId (see syncKeepPhotosOverride
// below, and the comment on lastKnownLectureId above) rather than the live
// state.lectureId, so that an exception picked during a lecture still applies
// to the export built just after standing down from it - and gets cleared
// only once a genuinely new lecture starts.
let keepPhotosLectureId;

// "This lecture only" has to mean it: called from every reader of the
// override, not just the render loop, because the decision that matters most
// - does THIS photo get filed - happens at the moment a photo is taken, which
// is not necessarily a moment renderAll() has just run.
//
// Compared against lastKnownLectureId, deliberately NOT the live
// state.lectureId: standing down sets state.lectureId back to null, and an
// export built in the minute after standing down still has to respect the
// choice made during the lecture it is exporting (see fileExportWithLecture).
// lastKnownLectureId only moves on once a genuinely new lecture starts, which
// is the actual moment "this lecture only" should stop applying.
function syncKeepPhotosOverride() {
  if (lastKnownLectureId === keepPhotosLectureId) return;
  keepPhotosLectureId = lastKnownLectureId;
  keepPhotosThisSession = null;
}

function photosKept() {
  syncKeepPhotosOverride();
  return keepPhotosThisSession ?? presentation.keepPhotos;
}

function setKeepPhotos(on) {
  keepPhotosThisSession = !!on;
  keepPhotosLectureId = lastKnownLectureId;
  renderKeepPhotos();
}

function renderKeepPhotos() {
  const row = $('#photo-keep-row');
  if (!row) return;
  row.hidden = !serverKeepsSessions;
  $('#photo-keep').checked = photosKept();
  // Bundled here rather than given its own call site: every place that needs
  // this refreshed (serverInfo() landing, every heartbeat via renderPhotos,
  // the keep-photos checkbox handler) already calls renderKeepPhotos for the
  // row right above it, and both toggle on the same two things - whether the
  // server keeps sessions at all, and whether one is live right now.
  const finishRow = $('#finish-session-row');
  if (finishRow) {
    finishRow.hidden = !serverKeepsSessions;
    $('#finish-session-hint').hidden = !serverKeepsSessions;
    $('#finish-session').disabled = !bus || !recordingNow();
  }
}

function filePollWithLecture(entry) {
  if (!recordingNow()) return;
  fetch(`/api/lectures/${encodeURIComponent(state.lectureId)}/polls`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poll: entry }),
  }).catch(() => { /* the copy in history is the one that mattered */ });
}

/**
 * One file of the session's record. `data` is a Blob or a Uint8Array.
 *
 * `lectureId` defaults to the live one, which is right for a photo taken
 * during class - recordingNow() already refuses to file anything when there
 * is no live lecture. The export path below passes lastKnownLectureId
 * explicitly instead, because it has to keep working for a few minutes after
 * state.lectureId has already gone back to null.
 */
function fileWithLecture(name, kind, data, type, lectureId = state.lectureId) {
  if (!serverKeepsSessions || !lectureId) return Promise.resolve(false);
  return fetch(`/api/lectures/${encodeURIComponent(lectureId)}/files`
    + `?name=${encodeURIComponent(name)}&kind=${encodeURIComponent(kind)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': type },
    body: data,
  }).then((res) => res.ok).catch(() => false);
}

function filePhotoWithLecture(photo, dataUrl) {
  if (!photosKept()) return;
  fileWithLecture(photoFileName(photo), 'photo', dataUrlToBytes(dataUrl), 'image/jpeg');
}

async function pollApi(suffix, opts = {}) {
  const base = pollBaseUrl(cfg);
  if (!base) throw new Error('This relay does not run polls.');
  const res = await fetch(`${base}poll${suffix}`, opts);
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(body?.error || `poll request failed (${res.status})`);
  return body;
}

function newPollDraft() {
  pollDraft = { kind: 'choice', question: '', options: ['', ''], correct: -1 };
  pollError = '';
  pollOptionsDrawn = -1;
}

// A poll written into a lecture plan (planfile.js's PLAN_TYPES.poll) carries
// its options as one newline-separated field, since the planning page's
// field editor only knows scalar kinds - split back into the array shape the
// composer already works in.
function openPollDraftFromPlan(item) {
  const options = String(item.options || '').split('\n').map((s) => s.trim()).filter(Boolean);
  pollDraft = {
    kind: ['text', 'qna'].includes(item.kind) ? item.kind : 'choice',
    question: item.question || '',
    options: options.length ? options : ['', ''],
    correct: Number.isFinite(Number(item.correct)) ? Number(item.correct) : -1,
  };
  pollError = '';
  pollOptionsDrawn = -1;
  tab('polls');
  renderPollsPanel();
}

async function startPoll() {
  if (!pollDraft || pollBusy) return;
  const question = pollDraft.question.trim();
  if (!question) { pollError = 'Add a question first.'; renderPollsPanel(); return; }
  let correct = -1;
  const options = [];
  if (pollDraft.kind === 'choice') {
    for (let i = 0; i < pollDraft.options.length; i++) {
      const trimmed = pollDraft.options[i].trim();
      if (trimmed) {
        if (pollDraft.correct === i) correct = options.length;
        options.push(trimmed);
      }
    }
  }
  if (pollDraft.kind === 'choice' && options.length < 2) {
    pollError = 'Add at least two options.';
    renderPollsPanel();
    return;
  }
  pollBusy = true;
  pollError = '';
  renderPollsPanel();
  try {
    const created = await pollApi('', { method: 'POST' });
    await pollApi(`/${created.code}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ kind: pollDraft.kind, question, options, correct, open: true }),
    });
    stage({
      type: 'poll', title: 'Poll', pollId: created.code, token: created.token,
      kind: pollDraft.kind, question, options, correct, open: true, revealed: false,
      showUrl: presentation.showPollUrl,
    });
    pollDraft = null;
  } catch (err) {
    pollError = err.message || 'Could not start the poll.';
  } finally {
    pollBusy = false;
    renderPollsPanel();
  }
}

async function setPollOpen(open) {
  const item = findPollItem();
  if (!item || !item.token || pollBusy) return;
  pollBusy = true;
  pollActionError = '';
  renderPollsPanel();
  try {
    await pollApi(`/${item.pollId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${item.token}` },
      body: JSON.stringify({ kind: item.kind, question: item.question, options: item.options, correct: item.correct, open }),
    });
  } catch (err) {
    pollActionError = err.message || 'Could not reach the poll.';
  } finally {
    pollBusy = false;
    renderPollsPanel();
  }
}

async function setPollClosesAt(seconds) {
  const item = findPollItem();
  if (!item || !item.token || pollBusy) return;
  pollBusy = true;
  pollActionError = '';
  renderPollsPanel();
  try {
    const closesAt = Date.now() + (seconds * 1000);
    await pollApi(`/${item.pollId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${item.token}` },
      body: JSON.stringify({ kind: item.kind, question: item.question, options: item.options, correct: item.correct, open: true, closesAt }),
    });
  } catch (err) {
    pollActionError = err.message || 'Could not reach the poll.';
  } finally {
    pollBusy = false;
    renderPollsPanel();
  }
}

function togglePollReveal() {
  const item = findPollItem();
  if (!item) return;
  send({ op: 'poll', pollId: item.pollId, action: 'reveal', value: !item.revealed });
}

// Poll CSVs (this one, and the ones exportSession() folds into the session
// zip - see there) are built from the item's own counts/answers rather than
// a fresh relay fetch: tickPolls already keeps those within a second of the
// relay's own numbers for a live poll, and it is the only data a redisplayed
// (archived, token-less) poll has left at all. One code path for both.
function pollResultRows(item) {
  const rows = [['question', item.question]];
  if (item.kind === 'text') {
    const hidden = new Set(item.hiddenAnswers || []);
    rows.push(['answer', 'shown to room']);
    (item.answers || []).forEach((a, i) => rows.push([a, hidden.has(i) ? 'no' : 'yes']));
  } else {
    rows.push(['option', 'votes']);
    (item.options || []).forEach((opt, i) => rows.push([opt, String(item.counts?.[i] || 0)]));
  }
  return rows;
}

function csvText(rows) {
  return rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
}

function exportPollCsv() {
  const item = findPollItem();
  if (!item) return;
  const blob = new Blob([csvText(pollResultRows(item))], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `poll-${safeName(item.question, item.pollId)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

async function endPoll() {
  const item = findPollItem();
  if (!item) return;
  pollBusy = true;
  renderPollsPanel();
  // A redisplayed (archived) poll has no token and nothing on the relay left
  // to delete - it is already in history, and ending it again would only
  // duplicate the entry. Only a poll that actually ran gets archived.
  if (item.token) {
    addToPollHistory({
      pollId: item.pollId, kind: item.kind, question: item.question, options: item.options, correct: item.correct,
      counts: item.counts || [], answers: item.answers || [], voters: item.voters || 0,
      hiddenAnswers: item.hiddenAnswers || [], endedAt: Date.now(),
      // Which lecture this poll belongs to, so a later export - in a
      // different lecture entirely - knows not to include it. pollHistory
      // outlives any one lecture (it is the presenter's own scrollback of
      // questions to reopen, kept in localStorage), but an export's CSV
      // bundle must not.
      lectureId: lastKnownLectureId,
    });
    try {
      await pollApi(`/${item.pollId}`, { method: 'DELETE', headers: { authorization: `Bearer ${item.token}` } });
    } catch { /* relay may already be gone - clear it from the screen regardless */ }
  }
  if (state.program?.pollId === item.pollId) send({ op: 'clear', where: 'program' });
  else if (state.preview?.pollId === item.pollId) send({ op: 'clear', where: 'preview' });
  else {
    const idx = state.panels.findIndex((p) => p?.pollId === item.pollId);
    if (idx !== -1) send({ op: 'panel', index: idx, item: { type: 'black' } });
  }
  pollBusy = false;
  newPollDraft();
  renderPollsPanel();
  $('#poll-end').disabled = false;
  pollEndButton?.disarm();
}

// Reopen: the same question, asked again from zero - a new relay poll, new
// code, nothing carried over but the wording. Redisplay: the opposite - no
// new relay poll at all, just the final snapshot staged back up, frozen.
// Both would queue silently behind a poll that is currently running rather
// than refusing outright (setting pollDraft here has no visible effect while
// findPollItem() still finds something, per renderPollsPanel below), so the
// history list itself disables them then instead, to keep a tap from
// looking like a dead click.
function reopenFromHistory(row) {
  pollDraft = { kind: row.kind, question: row.question, options: row.kind === 'choice' ? [...row.options] : ['', ''], correct: Number.isFinite(Number(row.correct)) ? Number(row.correct) : -1 };
  pollError = '';
  pollOptionsDrawn = -1;
  renderPollsPanel();
}

function redisplayFromHistory(row) {
  stage({
    type: 'poll', title: 'Poll', pollId: row.pollId, token: '',
    kind: row.kind, question: row.question, options: row.options,
    open: false, revealed: true, voters: row.voters, counts: row.counts, answers: row.answers,
    hiddenAnswers: row.hiddenAnswers || [],
  });
}

let pollOptionsDrawn = -1;

// Visibility between the two halves is decided once, by renderPollsPanel,
// from whether a poll is currently staged anywhere - neither half toggles
// the other's .hidden itself, which is what let them fight over it and get
// stuck on whichever ran last (see the comment on renderPollsPanel).
function renderPollBuilder() {
  if (!pollDraft) return;
  $('#poll-kind').value = pollDraft.kind;
  if (document.activeElement !== $('#poll-question')) $('#poll-question').value = pollDraft.question;
  const showOptions = pollDraft.kind === 'choice';
  $('#poll-options').hidden = !showOptions;
  $('#poll-option-add').closest('.inline').hidden = !showOptions;
  if (showOptions && pollOptionsDrawn !== pollDraft.options.length) {
    pollOptionsDrawn = pollDraft.options.length;
    $('#poll-options').replaceChildren(...pollDraft.options.map((_, i) => {
      const letter = String.fromCharCode(65 + i);
      const isCorrect = pollDraft.correct === i;
      return el('div', { class: 'poll-option-row' },
        el('button', {
          type: 'button',
          class: `poll-chip ${isCorrect ? 'is-correct' : ''}`,
          title: isCorrect ? 'Marked as correct' : 'Mark as correct',
          onclick: () => {
            pollDraft.correct = isCorrect ? -1 : i;
            pollOptionsDrawn = -1;
            renderPollsPanel();
          },
        }, letter),
        el('input', {
          type: 'text', placeholder: `Option ${i + 1}`, maxlength: '200',
          oninput: (ev) => { pollDraft.options[i] = ev.target.value; },
        }),
        el('button', {
          type: 'button', title: 'Remove', disabled: pollDraft.options.length <= 2,
          onclick: () => {
            pollDraft.options.splice(i, 1);
            if (pollDraft.correct === i) pollDraft.correct = -1;
            else if (pollDraft.correct > i) pollDraft.correct--;
            pollOptionsDrawn = -1;
            renderPollsPanel();
          },
        }, '×')
      );
    }));
    pollDraft.options.forEach((v, i) => { $$('#poll-options input')[i].value = v; });
  }
  $('#poll-option-add').disabled = pollDraft.options.length >= 8;
  $('#poll-error').hidden = !pollError;
  $('#poll-error').textContent = pollError;
  $('#poll-start').disabled = pollBusy;
}

let pollRunningDrawn = '';

// Results render here unconditionally, live, whether or not the room has
// seen them yet - only the projector's own renderer gates on `revealed`.
// The presenter is the one person who should never have to wait for their
// own Reveal tap to find out what the room said.
function renderRunningPoll(item) {
  const archived = !item.token;
  $('#poll-running-question').textContent = item.question;
  $('#poll-running-code').textContent = item.pollId;
  const link = archived ? null : pollJoinUrl(cfg, item.pollId);
  $('#poll-copy-link').disabled = !link;
  $('#poll-copy-link').hidden = archived;
  $('#poll-toggle-open').hidden = archived;
  $('#poll-timer-btns').hidden = archived || item.open === false;
  $('#poll-running-status').textContent = archived
    ? `Redisplayed from history — ${item.voters} response${item.voters === 1 ? '' : 's'}, not accepting new votes`
    : `${item.voters} response${item.voters === 1 ? '' : 's'}${item.open === false ? ' · voting closed' : ' · voting open'}`
      + (item.revealed ? ' · shown to the room' : ' · visible to you only');
  $('#poll-toggle-open').textContent = item.open === false ? 'Reopen voting' : 'Close voting';
  $('#poll-toggle-open').disabled = pollBusy;
  
  if (item.closesAt && item.open !== false) {
    pollCurrentClosesAt = item.closesAt;
    if (!pollTickTimer) pollTickTimer = setInterval(tickPollCountdown, 1000);
    tickPollCountdown();
  } else {
    pollCurrentClosesAt = null;
    $('#poll-running-countdown').hidden = true;
    if (pollTickTimer) { clearInterval(pollTickTimer); pollTickTimer = null; }
  }
  $('#poll-toggle-reveal').textContent = item.revealed ? 'Hide from room' : 'Reveal to room';
  if (item.kind === 'text') {
    $('#poll-toggle-view').hidden = false;
    $('#poll-toggle-view').textContent = item.viewMode === 'cloud' ? 'List view' : 'Word cloud';
  } else {
    $('#poll-toggle-view').hidden = true;
  }
  $('#poll-action-error').hidden = !pollActionError;
  $('#poll-action-error').textContent = pollActionError;

  const signature = `${item.kind}:${JSON.stringify(item.counts)}:${JSON.stringify(item.answers)}:${JSON.stringify(item.hiddenAnswers)}:${JSON.stringify(item.qnaFeed)}`;
  if (signature !== pollRunningDrawn) {
    pollRunningDrawn = signature;
    const results = $('#poll-running-results');
    if (item.kind === 'text') {
      const answers = item.answers || [];
      const hidden = new Set(item.hiddenAnswers || []);
      results.replaceChildren(...(answers.length
        ? answers.map((a, i) => el('div', { class: `poll-answer-row${hidden.has(i) ? ' is-hidden' : ''}` },
            el('span', { class: 'grow' }, a),
            el('button', {
              type: 'button', class: 'poll-answer-hide',
              title: hidden.has(i) ? 'Hidden from the room — tap to show it' : 'Hide this one answer from the room',
              onclick: () => send({ op: 'poll', pollId: item.pollId, action: 'hideAnswer', index: i, value: !hidden.has(i) }),
            }, hidden.has(i) ? 'Unhide' : 'Hide')))
        : [el('div', { class: 'poll-answer-row' }, 'No answers yet')]));
    } else if (item.kind === 'qna') {
      const qnaFeed = (item.qnaFeed || []).slice().sort((a, b) => (b.upvotes?.length || 0) - (a.upvotes?.length || 0));
      results.replaceChildren(...(qnaFeed.length
        ? qnaFeed.map((q) => el('div', { class: `poll-answer-row${q.hidden ? ' is-hidden' : ''}${q.answered ? ' is-answered' : ''}${q.projected ? ' is-projected' : ''}`, style: 'flex-direction: column; align-items: stretch; gap: 8px;' },
            el('div', { style: 'display: flex; gap: 8px; font-weight: 600;' }, 
              el('span', { class: 'mono' }, `▲ ${q.upvotes?.length || 0}`),
              el('span', { class: 'grow' }, q.text)
            ),
            el('div', { style: 'display: flex; gap: 4px; justify-content: flex-end;' },
              el('button', {
                type: 'button', class: 'poll-answer-hide',
                onclick: () => sendQnaAction(item.pollId, item.token, q.id, 'projected', !q.projected),
              }, q.projected ? 'Unproject' : 'Project'),
              el('button', {
                type: 'button', class: 'poll-answer-hide',
                onclick: () => sendQnaAction(item.pollId, item.token, q.id, 'answered', !q.answered),
              }, q.answered ? 'Unanswer' : 'Mark Answered'),
              el('button', {
                type: 'button', class: 'poll-answer-hide',
                onclick: () => sendQnaAction(item.pollId, item.token, q.id, 'hidden', !q.hidden),
              }, q.hidden ? 'Unhide' : 'Hide')
            )
          ))
        : [el('div', { class: 'poll-answer-row' }, 'No questions yet')]));
    } else {
      const counts = item.counts || [];
      const max = Math.max(1, ...counts, 0);
      results.replaceChildren(...(item.options || []).map((opt, i) => {
        const count = counts[i] || 0;
        const fill = el('div', { class: 'poll-bar-fill' });
        fill.style.width = `${Math.round((count / max) * 100)}%`;
        const isCorrect = item.correct === i;
        const letter = String.fromCharCode(65 + i);
        return el('div', { class: 'poll-bar-row' },
          el('div', { class: 'poll-bar-label' }, 
            el('span', {}, isCorrect ? el('strong', { class: 'ok-text' }, `[${letter}] `) : '', opt), 
            el('span', { class: 'mono' }, String(count))
          ),
          el('div', { class: `poll-bar-track${isCorrect ? ' is-correct' : ''}` }, fill)
        );
      }));
    }
  }
}

function renderPollHistory() {
  const holder = $('#poll-history');
  const busy = !!findPollItem();
  holder.replaceChildren(...pollHistory.map((row) => {
    const summary = row.kind === 'text' ? `${row.voters} response${row.voters === 1 ? '' : 's'}` :
                    row.kind === 'qna' ? `${row.qnaFeed?.length || 0} question${row.qnaFeed?.length === 1 ? '' : 's'} (${row.voters} participant${row.voters === 1 ? '' : 's'})` :
                    `${row.voters} response${row.voters === 1 ? '' : 's'} — ${(row.options || []).map((o, i) => `${o}: ${row.counts?.[i] || 0}`).join(', ')}`;
    return el('div', { class: 'poll-history-row' },
      el('div', { class: 'poll-history-question' }, row.question || '(no question)'),
      el('div', { class: 'hint' }, summary),
      el('div', { class: 'inline' },
        el('button', {
          type: 'button', disabled: busy, title: busy ? 'End the current poll first' : 'Ask this question again, fresh',
          onclick: () => reopenFromHistory(row),
        }, 'Reopen'),
        el('button', {
          type: 'button', disabled: busy, title: busy ? 'End the current poll first' : 'Show these final results again',
          onclick: () => redisplayFromHistory(row),
        }, 'Redisplay'),
        el('button', {
          type: 'button', class: 'poll-history-del', title: 'Remove from history',
          onclick: () => { pollHistory = pollHistory.filter((r) => r.id !== row.id); savePollHistory(); renderPollHistory(); },
        }, '×')));
  }));
  $('#poll-history-empty').hidden = pollHistory.length > 0;
}

// Right after starting a poll, findPollItem() still comes up empty for a
// moment - stage() only sends the command, and this pad's own `state` does
// not have the new item until the display's broadcast echoes it back (see
// the file-header comment: neither pad holds state, both render the echo).
// Deciding show-build-or-show-running here, once, from that same lookup is
// what keeps the two halves from arguing about it below.
function renderPollsPanel() {
  $('#poll-unsupported').hidden = !!pollBaseUrl(cfg);
  const item = findPollItem();
  $('#poll-running').hidden = !item;
  $('#poll-build').hidden = !!item;
  if (item) {
    renderRunningPoll(item);
  } else {
    if (!pollDraft) newPollDraft();
    renderPollBuilder();
  }
  renderPollHistory();
}

function renderAll() {
  renderMusic();
  renderMixer();
  renderWatermarkPanel();
  renderSetsPanel();
  renderPollsPanel();
  renderPhotos();
  renderRecent();
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

const LASER_COLORS = ['red', 'green', 'blue'];
const LASER_KEY = 'podium.laser.v1';
let laserColor = 'red';
try {
  const saved = localStorage.getItem(LASER_KEY);
  if (LASER_COLORS.includes(saved)) laserColor = saved;
} catch { /* private browsing: red it is */ }

const sendLaser = throttle((x, y) => bus?.send({ t: 'laser', x, y, on: true, color: laserColor }), 40);
const sendSpotlight = throttle((x, y) => bus?.send({ t: 'spotlight', x, y, on: true }), 40);

const padLaserDot = el('div', { class: 'laser-dot' });
const padSpotlightPreview = el('div', { class: 'spotlight-preview' });
padLaserDot.dataset.color = laserColor;
padFrame.append(padLaserDot, padSpotlightPreview);

const ink = {
  drawing: false,
  erasing: false,
  pointing: null,
  strokeId: null,
  buffer: [],
  penOnly: false,
  tool: 'pen',
  color: '#ffd166',
  width: 6,
  penWidth: 6,
  highlighterWidth: 22,
  lastErasePoint: null,
  strokes: [],
};
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
      renderer = item ? createRenderer(resolveAssets(item), { preview: true, getTimer: (id) => timerById(state, id), getMusicNow: getMusicNowPreview, getDeckSource, resolveAssets, getPollJoinUrl: (pollId) => pollJoinUrl(cfg, pollId) }) : null;
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
    padMirrorRenderer = item ? createRenderer(resolveAssets(item), { preview: true, getTimer: (id) => timerById(state, id), getMusicNow: getMusicNowPreview, getDeckSource, resolveAssets, getPollJoinUrl: (pollId) => pollJoinUrl(cfg, pollId) }) : null;
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
    padCtx.save();
    if (stroke.highlighter) {
      padCtx.globalAlpha = 0.35;
    }
    padCtx.beginPath();
    padCtx.strokeStyle = stroke.color;
    padCtx.lineWidth = stroke.width;
    padCtx.lineCap = 'round';
    padCtx.lineJoin = 'round';
    padCtx.moveTo(stroke.pts[0][0] * w, stroke.pts[0][1] * h);
    for (let i = 1; i < stroke.pts.length; i++) padCtx.lineTo(stroke.pts[i][0] * w, stroke.pts[i][1] * h);
    padCtx.stroke();
    padCtx.restore();
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
  if (gridShadow && deckView.id) {
    const item = focusedItem(state);
    if (item?.type === 'deck') highlightGrid(item.slide || 0, item.deckId);
  }
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
  if (!ink.drawing && !ink.erasing) {
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
    // An undo offer belongs to the board it was made on.
    if (clearedInk.surface && clearedInk.surface !== nextSurface) offerUnclear(null, []);
    if (!$('[data-panel="ink"]').hidden) redrawPad();
  }
  if (!ink.drawing && !ink.erasing && !inkDigestsAgree(inkDigest(ink.strokes), state.ink?.digest)) requestInkSurface();
  // Resizing mid-stroke is what caused strokes to come out warped. If the
  // deck's aspect had only just become known - Marp still loading when the
  // gesture started - the frame would resize partway through it. Points
  // already captured are fractions of whatever box existed at that instant,
  // so a resize between two points of the SAME stroke leaves them meaning
  // different things once redrawn under one uniform size. Deferring the
  // resize until the stroke ends (see endStroke()) keeps every point in a
  // gesture measured against one constant box.
  if (!$('[data-panel="ink"]').hidden && !ink.drawing && !ink.erasing) sizePad();
}

const flushInk = throttle(() => {
  if (!ink.strokeId || !ink.buffer.length) return;
  send({ op: 'ink', action: 'points', id: ink.strokeId, pts: ink.buffer.splice(0) });
}, 60);

function padPoint(ev) {
  const rect = pad.getBoundingClientRect();
  return [(ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height];
}

function isHardwareEraser(ev) {
  return ev.pointerType === 'pen' && (((ev.buttons & 32) !== 0) || ev.button === 5);
}

function eraseAt(ev) {
  const rect = pad.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  const w = rect.width;
  const h = rect.height;
  if (!w || !h || !ink.strokes.length) return;

  const samplePoints = [];
  if (ink.lastErasePoint) {
    const [lx, ly] = ink.lastErasePoint;
    const dist = Math.hypot(px - lx, py - ly);
    const step = 12;
    if (dist > step) {
      const steps = Math.ceil(dist / step);
      for (let s = 1; s <= steps; s++) {
        samplePoints.push([lx + (px - lx) * (s / steps), ly + (py - ly) * (s / steps)]);
      }
    } else {
      samplePoints.push([px, py]);
    }
  } else {
    samplePoints.push([px, py]);
  }
  ink.lastErasePoint = [px, py];

  const toRemove = [];
  for (const stroke of ink.strokes) {
    for (const [sx, sy] of samplePoints) {
      if (strokeHitTest(stroke, sx, sy, w, h)) {
        toRemove.push(stroke.id);
        break;
      }
    }
  }

  if (toRemove.length) {
    const set = new Set(toRemove);
    ink.strokes = ink.strokes.filter((s) => !set.has(s.id));
    holdInk(inkSurface, ink.strokes);
    redrawPad();
    send({ op: 'ink', action: 'erase', ids: toRemove });
  }
}

// --- hold-to-straighten shape snapping (#38) ---------------------------------
const HOLD_TO_SNAP_MS = 450;
const HOLD_JITTER_RADIUS = 14;
let shapeHoldTimer = null;
let shapeHoldAnchor = null;
let currentStrokeSnapped = false;
let snappedShapeInfo = null;

const broadcastSnappedStroke = throttle((stroke) => {
  if (!stroke) return;
  send({ op: 'ink', action: 'erase', ids: [stroke.id] });
  send({
    op: 'ink',
    action: 'begin',
    id: stroke.id,
    color: stroke.color,
    width: stroke.width,
    highlighter: !!stroke.highlighter,
    pts: stroke.pts,
  });
}, 60);

function triggerHoldSnap() {
  if (!ink.drawing || !ink.strokeId || currentStrokeSnapped) return;
  const stroke = ink.strokes.find((st) => st.id === ink.strokeId);
  if (!stroke || stroke.pts.length < 2) return;

  const w = pad.clientWidth || 1000;
  const h = pad.clientHeight || 1000;
  const detected = detectAndSnapShape(stroke.pts, w, h);
  if (!detected) return;

  currentStrokeSnapped = true;
  snappedShapeInfo = {
    type: detected.type,
    origin: stroke.pts[0],
  };
  stroke.pts = detected.pts;
  ink.buffer = [];
  holdInk(inkSurface, ink.strokes);
  redrawPad();

  send({ op: 'ink', action: 'erase', ids: [stroke.id] });
  send({
    op: 'ink',
    action: 'begin',
    id: stroke.id,
    color: stroke.color,
    width: stroke.width,
    highlighter: !!stroke.highlighter,
    pts: stroke.pts,
  });

  haptic('tick');
}

pad.addEventListener('pointerdown', (ev) => {
  if (ink.penOnly && ev.pointerType !== 'pen') return;
  if (ink.tool === 'laser' || ink.tool === 'spotlight') {
    pad.setPointerCapture(ev.pointerId);
    ink.pointing = ink.tool;
    const [x, y] = padPoint(ev);
    if (ink.tool === 'laser') {
      padLaserDot.style.left = `${x * 100}%`;
      padLaserDot.style.top = `${y * 100}%`;
      padLaserDot.classList.add('is-on');
      sendLaser(x, y);
    } else {
      padSpotlightPreview.style.setProperty('--spotlight-x', `${x * 100}%`);
      padSpotlightPreview.style.setProperty('--spotlight-y', `${y * 100}%`);
      padSpotlightPreview.classList.add('is-on');
      sendSpotlight(x, y);
    }
    return;
  }
  const hardwareEraser = isHardwareEraser(ev);
  if (ink.tool === 'eraser' || hardwareEraser) {
    pad.setPointerCapture(ev.pointerId);
    ink.erasing = true;
    ink.lastErasePoint = null;
    eraseAt(ev);
    return;
  }
  pad.setPointerCapture(ev.pointerId);
  ink.drawing = true;
  ink.strokeId = uid(6);
  currentStrokeSnapped = false;
  snappedShapeInfo = null;
  const pt = padPoint(ev);
  holdInk(inkSurface, ink.strokes);
  const isHighlighter = ink.tool === 'highlighter';
  const newStroke = { id: ink.strokeId, color: ink.color, width: ink.width, pts: [pt] };
  if (isHighlighter) newStroke.highlighter = true;
  ink.strokes.push(newStroke);
  ink.buffer = [];
  send({ op: 'ink', action: 'begin', id: ink.strokeId, color: ink.color, width: ink.width, highlighter: isHighlighter, pts: [pt] });

  clearTimeout(shapeHoldTimer);
  shapeHoldAnchor = { x: ev.clientX, y: ev.clientY, time: Date.now() };
  if (presentation.snapShapes !== false) {
    shapeHoldTimer = setTimeout(triggerHoldSnap, HOLD_TO_SNAP_MS);
  }
});

pad.addEventListener('pointermove', (ev) => {
  if (ink.pointing) {
    ev.preventDefault();
    const [x, y] = padPoint(ev);
    if (ink.pointing === 'laser') {
      padLaserDot.style.left = `${x * 100}%`;
      padLaserDot.style.top = `${y * 100}%`;
      sendLaser(x, y);
    } else if (ink.pointing === 'spotlight') {
      padSpotlightPreview.style.setProperty('--spotlight-x', `${x * 100}%`);
      padSpotlightPreview.style.setProperty('--spotlight-y', `${y * 100}%`);
      sendSpotlight(x, y);
    }
    return;
  }
  if (ink.erasing) {
    ev.preventDefault();
    const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    for (const e of events) eraseAt(e);
    return;
  }
  if (!ink.drawing) return;
  ev.preventDefault();

  if (currentStrokeSnapped) {
    const stroke = ink.strokes.find((st) => st.id === ink.strokeId);
    if (!stroke) return;
    const pt = padPoint(ev);
    const w = pad.clientWidth || 1000;
    const h = pad.clientHeight || 1000;

    let updated = null;
    if (snappedShapeInfo?.type === 'line') {
      updated = snapStraightLine([snappedShapeInfo.origin, pt], w, h);
    } else if (snappedShapeInfo?.type === 'arrow') {
      updated = snapArrow([snappedShapeInfo.origin, pt], w, h);
    } else if (snappedShapeInfo?.type === 'box') {
      updated = snapBox([snappedShapeInfo.origin, pt], w, h);
    } else if (snappedShapeInfo?.type === 'ellipse') {
      updated = snapEllipse([snappedShapeInfo.origin, pt], w, h);
    }

    if (updated?.pts) {
      stroke.pts = updated.pts;
      holdInk(inkSurface, ink.strokes);
      redrawPad();
      broadcastSnappedStroke(stroke);
    }
    return;
  }

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

  if (presentation.snapShapes !== false) {
    const dist = Math.hypot(ev.clientX - (shapeHoldAnchor?.x || 0), ev.clientY - (shapeHoldAnchor?.y || 0));
    if (dist > HOLD_JITTER_RADIUS) {
      shapeHoldAnchor = { x: ev.clientX, y: ev.clientY, time: Date.now() };
      clearTimeout(shapeHoldTimer);
      shapeHoldTimer = setTimeout(triggerHoldSnap, HOLD_TO_SNAP_MS);
    }
  }
});

const endStroke = (ev) => {
  clearTimeout(shapeHoldTimer);
  shapeHoldTimer = null;

  if (ink.pointing) {
    const mode = ink.pointing;
    ink.pointing = null;
    if (mode === 'laser') {
      padLaserDot.classList.remove('is-on');
      bus?.send({ t: 'laser', on: false });
    } else {
      padSpotlightPreview.classList.remove('is-on');
      bus?.send({ t: 'spotlight', on: false });
    }
    try { pad.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    return;
  }
  if (ink.erasing) {
    ink.erasing = false;
    ink.lastErasePoint = null;
    try { pad.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    return;
  }
  if (!ink.drawing) return;
  ink.drawing = false;

  if (currentStrokeSnapped) {
    currentStrokeSnapped = false;
    snappedShapeInfo = null;
    const stroke = ink.strokes.find((st) => st.id === ink.strokeId);
    if (stroke) {
      send({ op: 'ink', action: 'erase', ids: [stroke.id] });
      send({
        op: 'ink',
        action: 'begin',
        id: stroke.id,
        color: stroke.color,
        width: stroke.width,
        highlighter: !!stroke.highlighter,
        pts: stroke.pts,
      });
    }
    ink.strokeId = null;
    try { pad.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    if (gridShadow && deckView.id) {
      const item = focusedItem(state);
      if (item?.type === 'deck') highlightGrid(item.slide || 0, item.deckId);
    }
    if (!$('[data-panel="ink"]').hidden) sizePad();
    return;
  }

  flushInk();
  send({ op: 'ink', action: 'points', id: ink.strokeId, pts: ink.buffer.splice(0) });
  ink.strokeId = null;
  try { pad.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
  if (gridShadow && deckView.id) {
    const item = focusedItem(state);
    if (item?.type === 'deck') highlightGrid(item.slide || 0, item.deckId);
  }
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
    // The live feed is peer-to-peer and a guest network can block that outright.
    // A still is not: it goes to the projector over the relay, like any other
    // photo, so it is the way out of exactly this failure.
    failed: 'Could not connect the live feed. If this is a guest network, the two devices may be blocked from reaching each other — but Take a photo still works, because a still goes by the relay instead.',
  }[status] || status;
  $('#cam-start').textContent = status === 'idle' ? 'Start camera' : 'Stop camera';
  // Anything but "off" means this device has the camera and there is a frame
  // to freeze. Notably that includes `failed` (see above), and it does not
  // require the feed to be on the projector: photographing the next page while
  // the class still looks at the last one is the point.
  $('#cam-shot').disabled = status === 'idle';
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

// --- photos kept for this session --------------------------------------------
//
// Three things end up in the same place, because they are the same thing once
// taken: a frame frozen off the document camera, a photo of one panel (its
// content with your ink burnt into it), and a shot of the whole screen. Each
// becomes an ordinary image item, so it can go straight back up in any panel,
// be annotated again on its own surface, and be exported with the rest.
//
// They live in memory for this session only. Nothing about a photo of a
// student's worksheet - or of a board you have since wiped - should be written
// to the tablet unless someone decides it should, and Export is that decision.
// The bytes travel to the projector the way a lecture plan's photos do
// (assetStore + `asset:<id>`), so they cross the relay once and the item that
// refers to them stays small enough for a heartbeat.
const MAX_PHOTOS = 24;
// How long "press and hold" means on each control. A panel letter is a
// deliberate reach; a layout button is one you might brush past, so it asks
// for a noticeably longer hold before it does something as surprising as
// photographing the room's screen.
const HOLD_PANEL_MS = 700;
const HOLD_SCREEN_MS = 1200;
let photos = [];
let photoCount = 0;
let photosDrawn = '';

// The strip shows every photo twice - once on the Camera tab, once on Photos -
// and a photo is a full-size JPEG. Handing those straight to <img> means the
// tablet decodes two dozen 1280x900 bitmaps and holds them all: a few hundred
// megabytes of nothing, on the device least able to spare it, for pictures
// drawn 132px wide. So each photo carries a small copy for the strip, and the
// full one is fetched from assetStore only when it actually goes on screen.
const THUMB_WIDTH = 260;

function makeThumb(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, THUMB_WIDTH / (img.naturalWidth || THUMB_WIDTH));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        resolve(dataUrl);   // no thumbnail is better than no photo
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// The name a photo has in the session zip, and on the server if this room is
// being recorded - so the two are the same file rather than two copies of one
// picture. Keyed by the photo's own id, which the display mints once and
// broadcasts with the shot, rather than a locally-counted sequence: a `shot`
// message reaches every controller in the room, each running its own count
// that a reload resets, so two controllers filing the SAME photo under a
// count-based name could file it twice under different names - and
// lecture_files is unique by name, so whichever write landed second would
// either collide oddly or replace the other's row outright.
const photoFileName = (photo) =>
  `photos/${photo.id}-${safeName(photo.title, 'photo')}.jpg`;

function addPhoto({ id, data, title, badge }) {
  assetStore.set(id, data);
  photoCount += 1;
  photos.unshift({ id, title, badge, at: Date.now(), thumb: data });
  filePhotoWithLecture(photos[0], data);
  // Swap in the small copy as soon as it is ready; until then the strip shows
  // the full-size one rather than an empty box.
  makeThumb(data).then((thumb) => {
    const photo = photos.find((p) => p.id === id);
    if (!photo) return;
    photo.thumb = thumb;
    photosDrawn = '';
    renderPhotos();
  });
  // Oldest first out of the strip. Whatever is already on the projector stays
  // there - the display keeps its own copy of anything it has been sent.
  for (const dropped of photos.slice(MAX_PHOTOS)) {
    assetStore.delete(dropped.id);
    assetsSent.delete(dropped.id);
  }
  photos = photos.slice(0, MAX_PHOTOS);
  photosDrawn = '';
  renderPhotos();
  return photos[0];
}

// One photo out of the app, without building the whole session zip: the
// export is the record of a lecture, this is "I want that picture now". On an
// iPad it lands in Files, from where it can go into Photos like any download.
function savePhoto(photo) {
  const data = assetStore.get(photo.id);
  if (!data) { photoNote('That photo is no longer held on this device.'); return; }
  const a = document.createElement('a');
  a.href = data;
  a.download = `${safeName(photo.title, 'photo')}.jpg`;
  document.body.append(a);
  a.click();
  a.remove();
  photoNote(`Saved ${a.download}.`);
}

function forgetPhoto(id) {
  photos = photos.filter((p) => p.id !== id);
  // Deliberately NOT pulled off the screen: discarding a thumbnail is tidying
  // the strip, not an edit to what the class is looking at.
  assetStore.delete(id);
  assetsSent.delete(id);
  photosDrawn = '';
  renderPhotos();
}

// Called from renderAll(), which runs on every heartbeat, so it rebuilds the
// strips only when they would actually look different. Rebuilding twice a
// second would throw away and re-decode two dozen data-URL <img>s for nothing.
function renderPhotos() {
  // Runs every heartbeat, which is what keeps the checkbox from silently
  // lagging behind a lecture change even when nobody has touched the Photos
  // tab since - see syncKeepPhotosOverride.
  renderKeepPhotos();
  const strips = $$('.shots');
  const empty = !photos.length;
  $$('.shots-empty').forEach((n) => { n.hidden = !empty; });
  $$('.shots-hint').forEach((n) => { n.hidden = empty; });
  // Enabled even with nothing in the strip: a session whose whole record is
  // one annotated deck is exactly what this is for. Not while one is being
  // built, though - this runs on every heartbeat, and would otherwise re-enable
  // the button half a second into an export, where a second tap starts a second
  // one that steals the first's reply from the display.
  $('#photo-export').disabled = !bus || exporting;
  if ($('#photo-export-pdf')) $('#photo-export-pdf').disabled = !bus || exporting;
  $('#photo-count').textContent = empty ? '' : `${photos.length} saved this session`;
  // The tab itself keeps the count, because a photo taken by holding a button
  // in the top bar otherwise lands somewhere you are not looking.
  $('.tab[data-tab="photos"]').dataset.count = empty ? '' : String(photos.length);
  if (empty) {
    strips.forEach((strip) => { strip.hidden = true; strip.replaceChildren(); });
    photosDrawn = '';
    return;
  }

  // Where each photo currently is, so the strip answers "which one is in B?"
  // without looking up at the wall.
  const where = new Map();
  const seat = (item, label) => {
    const id = assetIdOf(item?.src);
    if (id && !where.has(id)) where.set(id, label);
  };
  seat(state.program, PANEL_LABELS[0]);
  state.panels.forEach((item, i) => seat(item, PANEL_LABELS[i + 1]));

  const signature = photos.map((p) => `${p.id}:${where.get(p.id) || ''}:${p.thumb.length}`).join('|');
  if (signature === photosDrawn) return;
  photosDrawn = signature;

  for (const strip of strips) {
    strip.hidden = false;
    strip.replaceChildren(...photos.map((photo) => {
      const label = where.get(photo.id);
      const shot = el('button', {
        class: `shot${label ? ' is-on' : ''}`,
        type: 'button',
        title: `${photo.title} — put on screen`,
        onclick: () => stage({ type: 'image', title: photo.title, src: assetRef(photo.id) }),
      },
        el('img', { src: photo.thumb, alt: photo.title }),
        el('span', { class: 'shot-time' }, new Date(photo.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
        el('span', { class: 'shot-num' }, photo.badge));
      if (label) shot.append(el('span', { class: 'shot-where' }, label));
      shot.append(el('span', {
        class: 'shot-save',
        title: 'Save this photo to this device',
        onclick: (ev) => { ev.stopPropagation(); savePhoto(photo); },
      }, '\u2913'));
      shot.append(el('span', {
        class: 'shot-del',
        title: 'Discard this photo',
        onclick: (ev) => { ev.stopPropagation(); forgetPhoto(photo.id); },
      }, '\u00d7'));
      return shot;
    }));
  }
}

function photoNote(text) {
  const note = $('#cam-shot-note');
  note.textContent = text;
  note.hidden = !text;
  $('#photo-note').textContent = text;
  $('#photo-note').hidden = !text;
}

// --- a frame frozen off the camera feed --------------------------------------

async function takeCameraPhoto() {
  const video = $('#cam-local');
  if (!cameraSender?.active || !video.videoWidth || !video.videoHeight) {
    photoNote('Start the camera first — there is no picture to freeze yet.');
    return;
  }
  photoNote('Freezing that frame…');
  try {
    // Straight off the video element rather than through ImageCapture: the
    // iPad is the device this is for, and Safari has no ImageCapture at all.
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('this browser would not encode the frame'))), 'image/jpeg', 0.92);
    });
    // The same ladder a photo dropped into a lecture plan walks down, so a
    // still is guaranteed to fit through the relay in one message.
    const shrunk = await downscaleImage(blob, MAX_ASSET_CHARS);
    const photo = addPhoto({
      id: uid(10), data: shrunk.dataUrl,
      title: `Camera photo ${photoCount + 1}`, badge: 'Camera',
    });
    photoNote(shrunk.tooBig
      // Every rung of the ladder was still too big for one relay message. It
      // is here in the strip either way - say so rather than let it fail
      // silently on the way to the projector.
      ? `${photo.title} — ${shrunk.width}x${shrunk.height}, but bigger than a relay message carries. It may not reach the projector; try again with less in frame.`
      : `${photo.title} — ${shrunk.width}x${shrunk.height}. Tap it below to put it on screen.`);
  } catch (err) {
    photoNote(`Could not take that photo: ${err.message}`);
  }
}

// --- photographing the projector ---------------------------------------------
//
// The display does the actual painting (see takeShot there) because it is the
// only device holding the real thing - the live camera frame, the deck stopped
// mid-build, the ink as the room saw it. This end asks, and files what comes
// back. Photos are broadcast rather than addressed, so a second controller in
// your other hand ends up holding them too.

let shotPending = null;

function askForShot(target, label) {
  if (!bus) { photoNote('Not connected to the display yet.'); return; }
  clearTimeout(shotPending);
  photoNote(`Photographing ${label}…`);
  // Generous, because the display may be rasterizing a slide with a webfont on
  // it. A request that goes unanswered even so means a display running code
  // that has never heard of `shot-need`, and saying that beats a note that
  // sits there saying "photographing" forever.
  shotPending = setTimeout(() => {
    photoNote('The display did not answer. If it is running an older build, reload it.');
  }, 15000);
  bus.send({ t: 'shot-need', target });
}

// --- background music ---------------------------------------------------------
//
// The controller holds no music: the queue is in the shared state and the
// sound comes out of the display, so this is a remote for something happening
// in another room. Which also means a second controller, or one that joins
// halfway through, sees the same queue and the same track without being told.

const MUSIC_LIST = 'content/music.json';
let playlists = [];
let musicDrawn = '';

async function loadPlaylists() {
  try {
    const res = await fetch(MUSIC_LIST, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    playlists = (Array.isArray(data) ? data : data.playlists || [])
      .filter((list) => list && Array.isArray(list.tracks) && list.tracks.length);
  } catch {
    // No music.json is a perfectly good state: the tab explains how to add
    // one, and a pasted link still works without it.
    playlists = [];
  }
  const picker = $('#music-playlist');
  picker.replaceChildren(...playlists.map((list, i) => el('option', { value: String(i) }, `${list.name || `Playlist ${i + 1}`} · ${list.tracks.length}`)));
  const none = !playlists.length;
  picker.hidden = none;
  $('#music-load').hidden = none;
  $('#music-add').hidden = none;
  const autoplayWrap = $('#music-autoplay-wrap');
  if (autoplayWrap) autoplayWrap.hidden = none;
  const pauseQueueWrap = $('#music-pause-queue-wrap');
  if (pauseQueueWrap) pauseQueueWrap.hidden = none;
  const trackRow = $('#music-track-row');
  if (trackRow && none) trackRow.hidden = true;
  if (none) $('#music-note').textContent = 'No content/music.json yet — paste a link below, or add that file to keep playlists between lectures.';
}

function chosenPlaylist() {
  return playlists[Number($('#music-playlist').value) || 0] || null;
}

let loadedTracks = [];

function updateMusicTrackSelect(tracks) {
  loadedTracks = Array.isArray(tracks) ? tracks : [];
  const row = $('#music-track-row');
  const select = $('#music-track-select');
  if (!row || !select) return;
  if (!loadedTracks.length) {
    row.hidden = true;
    select.replaceChildren();
    return;
  }
  select.replaceChildren(...loadedTracks.map((t, i) => el('option', { value: String(i) },
    `${i + 1}. ${t.title || 'Track'}${t.artist ? ` — ${t.artist}` : ''}`
  )));
  select.value = '0';
  row.hidden = false;
}

let musicQuickDrawn = '';

// Whatever is in the library right now - plan items and manifest entries
// both flow through the same `library` array - is what this offers as
// one-tap background music. It reflects `library` live, so a plan loading
// or clearing is enough to change the row; no separate hook needed, since
// this redraws on the same heartbeat as everything else.
function renderMusicQuick() {
  const seen = new Set();
  const items = library.filter((item) => {
    if (item.type !== 'audio' || !item.src || seen.has(item.src)) return false;
    seen.add(item.src);
    return true;
  });
  const bar = $('#music-quick-bar');
  bar.hidden = !items.length;
  if (!items.length) return;

  const signature = items.map((i) => i.src).join('|');
  if (signature !== musicQuickDrawn) {
    musicQuickDrawn = signature;
    $('#music-quick').replaceChildren(...items.map((item) => el('button', {
      class: 'music-quick-chip', type: 'button',
      title: `Play “${item.title || itemLabel(item)}” as background music`,
      dataset: { src: item.src },
      onclick: () => send({
        op: 'music', action: 'playnow',
        track: { src: item.src, title: item.title, artist: item.artist },
      }),
    }, el('span', {}, item.title || itemLabel(item)))));
  }

  // Which chip (if any) is the one actually sounding right now - drawn fresh
  // every beat since this alone tracks state.music, not just the library.
  const current = state.music?.playing ? state.music.tracks[state.music.index]?.src : null;
  for (const chip of $('#music-quick').children) chip.classList.toggle('is-on', chip.dataset.src === current);
}

function renderMusic() {
  renderMusicQuick();
  const music = state.music || { tracks: [], index: 0, playing: false, volume: 0.6 };
  if (Array.isArray(music.tracks)) {
    for (const t of music.tracks) {
      if (t?.src) probeTrackDuration(t.src);
    }
  }
  const track = music.tracks[music.index] || null;
  const now = state.musicNow || { time: 0, duration: 0, ducked: false };

  $('#music-play').textContent = music.playing ? '⏸ Pause' : '▶ Play';
  $('#music-play').disabled = !music.tracks.length;
  for (const id of ['#music-prev', '#music-next', '#music-shuffle', '#music-clear']) $(id).disabled = !music.tracks.length;
  $('#music-fade').disabled = !music.playing;
  $('#music-countdown').disabled = !music.tracks.length;

  $('#music-title').textContent = track ? track.title : 'Nothing queued';
  const parts = [];
  if (now.error) parts.push(now.error);
  if (track?.artist) parts.push(track.artist);
  if (music.tracks.length) parts.push(`${music.index + 1} of ${music.tracks.length}${music.playlist ? ` · ${music.playlist}` : ''}`);
  if (now.ducked) parts.push('ducked while a clip plays');
  if (state.muted) parts.push('the room is muted');
  $('#music-sub').textContent = parts.join(' · ');
  $('#music-sub').classList.toggle('is-warning', !!now.error);

  const pct = now.duration ? Math.min(100, (now.time / now.duration) * 100) : 0;
  const elapsed = $('#music-elapsed');
  if (elapsed) elapsed.style.width = `${pct}%`;
  const scrub = $('#music-scrub');
  if (scrub) {
    const d = now.duration || 0;
    scrub.max = String(d);
    scrub.disabled = !d;
    if (!musicScrubbing) scrub.value = String(Math.min(now.time, d || now.time));
  }
  if (!musicScrubbing) {
    $('#music-time').textContent = fmtTime(now.time);
  }
  $('#music-length').textContent = now.duration ? fmtTime(now.duration) : '--:--';

  // The bottom bar carries quick slots, updated whenever music state changes.
  renderBottomSlots();

  if (!musicSliding) $('#music-volume').value = String(music.volume);
  const pauseQueueBox = $('#music-pause-queue');
  if (pauseQueueBox && document.activeElement !== pauseQueueBox) {
    pauseQueueBox.checked = !!music.pauseQueue;
  }

  // The queue is rebuilt only when it changes: it is redrawn from a heartbeat
  // like everything else here.
  const signature = `${music.tracks.map((t) => t.src).join('|')}::${music.index}::${music.playing}`;
  if (signature === musicDrawn) return;
  musicDrawn = signature;
  $('#music-queue').replaceChildren(...music.tracks.map((t, i) => el('button', {
    class: `music-row${i === music.index ? ' is-on' : ''}`,
    type: 'button',
    title: `${t.title}${t.artist ? ` — ${t.artist}` : ''}`,
    onclick: () => send({ op: 'music', action: 'select', index: i }),
  },
    el('span', { class: 'music-row-n' }, i === music.index && music.playing ? '♪' : String(i + 1)),
    el('span', { class: 'music-row-title' }, t.title),
    el('span', { class: 'music-row-artist' }, t.artist || ''))));
}

let musicSliding = false;
let musicScrubbing = false;

// --- automated sets -----------------------------------------------------------
//
// A rotation of items that advances itself once started - the whole engine
// lives on the display (see tickSets in display.js) and in applySetCommand
// (protocol.js), so this is purely the authoring UI plus a remote for
// whichever running set the currently focused panel holds. Saved sets are
// a device-local library, the same as your custom library items: nothing
// here is shared state until you actually START one, at which point it
// becomes a plain staged item like any other and every controller sees it.

const SET_KEY = 'podium.sets.v1';
const DEFAULT_ENTRY_SECONDS = 15;
const SET_PANEL_LABELS = ['A', 'B', 'C', 'D'];

function loadSavedSets() {
  try { return JSON.parse(localStorage.getItem(SET_KEY) || '[]'); } catch { return []; }
}
function saveSavedSets(list) {
  try { localStorage.setItem(SET_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}
let savedSets = loadSavedSets();
// The set being built or edited right now, or null. Editing works on a copy
// so cancelling a change to a saved set leaves the saved one untouched.
let draftSet = null;

function entryLabel(item) {
  return `${TYPES[item.type]?.icon || '?'} ${item.title || itemLabel(item)}`;
}

// Called first thing from pick(), for every Library tap: while a draft is
// open, taps build the set instead of going live. Returns whether it
// handled the tap at all (even when the draft was already full), which is
// what pick() uses to short-circuit its own type-specific handling.
function addToDraftSet(item) {
  if (!draftSet) return false;
  // A live camera feed cannot be "held for 20 seconds" - it would sit there
  // never having been started, since starting one is a whole WebRTC
  // handshake pick() normally runs and this path skips entirely, so it is
  // declined with a reason rather than added broken.
  if (item.type === 'camera') {
    flashSetNote('A live camera feed can’t be automated this way — add a still instead.');
    return true;
  }
  // A poll needs a relay round-trip to even become a poll (see pick()), and
  // "hold it for 20 seconds then move on" has no sensible meaning for a
  // question the room is still answering.
  if (item.type === 'poll') {
    flashSetNote('A poll isn’t automated this way — start it from the Polls tab.');
    return true;
  }
  // A Library deck tile (as opposed to one specific slide pulled from Recent,
  // which already carries slideCount) means "the deck", not one slide of it -
  // fetching, counting and expanding it into one entry per slide happens off
  // to the side so a rotation can hold a whole deck without tapping through
  // it slide by slide first.
  if (item.type === 'deck' && !item.slideCount) {
    addWholeDeckToDraft(item);
    return true;
  }
  if (draftSet.entries.length >= MAX_SET_ENTRIES) {
    $('#sets-build-hint-name').textContent = draftSet.title || 'this set';
    flashSetNote(`That set already holds the most this app allows (${MAX_SET_ENTRIES}).`);
    return true;
  }
  draftSet.entries.push({ item, seconds: DEFAULT_ENTRY_SECONDS });
  flashSetNote(`Added “${item.title || itemLabel(item)}”.`);
  renderSetsPanel();
  return true;
}

// Fetches and parses a deck exactly the way picking it normally would, then
// adds every one of its slides as its own entry, in order - a rotation
// treats a 12-slide deck as 12 items with their own durations, the same as
// if you had tapped each one from Recent, just without actually doing that.
async function addWholeDeckToDraft(item) {
  const targetSet = draftSet;
  flashSetNote(`Opening “${item.title || 'deck'}”…`);
  let deck; let source; let deckIdRef;
  try {
    deckIdRef = item.deckId || `src:${item.src}`;
    source = await getDeckSource(item.deckId ? item : { deckId: deckIdRef, src: item.src });
    if (source == null) throw new Error('could not load that deck');
    deck = await renderDeckSource(source, deckIdRef);
  } catch (err) {
    flashSetNote(`Could not open “${item.title || 'deck'}” — ${err.message}`);
    return;
  }
  // The draft could have been cancelled, saved, or swapped for a different
  // one while the fetch was in flight - add to whichever one was open then,
  // not whatever (if anything) is open now.
  if (draftSet !== targetSet) return;
  const room = MAX_SET_ENTRIES - targetSet.entries.length;
  if (room <= 0) {
    flashSetNote(`That set already holds the most this app allows (${MAX_SET_ENTRIES}).`);
    return;
  }
  const title = frontMatterTitle(source, item.title || 'Deck');
  const n = Math.min(deck.count, room);
  for (let slide = 0; slide < n; slide++) {
    targetSet.entries.push({
      // Every entry's own title names its slide, not just the deck - so the
      // builder's list (thirteen rows, one per slide) reads as thirteen
      // different things rather than the same label thirteen times over.
      item: { type: 'deck', deckId: deckIdRef, src: item.src, title: `${title} — slide ${slide + 1}/${deck.count}`, slide, slideCount: deck.count },
      seconds: DEFAULT_ENTRY_SECONDS,
    });
  }
  flashSetNote(n < deck.count
    ? `Added ${n} of ${deck.count} slides from “${title}” — the set is full.`
    : `Added all ${deck.count} slides from “${title}”.`);
  renderSetsPanel();
}

// A brief note wherever the tap actually landed - the Library tab, not the
// Sets tab the user just left - so adding five items in a row is visible
// without switching back and forth to check.
let setNoteTimer = null;
function flashSetNote(text) {
  const note = $('#sets-add-note') || (() => {
    const n = el('p', { id: 'sets-add-note', class: 'hint toast' });
    $('#library').before(n);
    return n;
  })();
  note.textContent = text;
  note.classList.add('is-on');
  clearTimeout(setNoteTimer);
  setNoteTimer = setTimeout(() => note.classList.remove('is-on'), 1600);
}

function newDraftSet() {
  draftSet = { id: uid(8), title: '', mode: 'sequential', entries: [] };
  renderSetsPanel();
}
function editDraftSet(id) {
  const found = savedSets.find((s) => s.id === id);
  if (!found) return;
  draftSet = JSON.parse(JSON.stringify(found));
  renderSetsPanel();
}
function cancelDraftSet() {
  draftSet = null;
  renderSetsPanel();
}
function saveDraftSet() {
  if (!draftSet || !draftSet.entries.length) return;
  draftSet.title = (draftSet.title || '').trim() || 'Untitled set';
  const i = savedSets.findIndex((s) => s.id === draftSet.id);
  if (i === -1) savedSets.push(draftSet); else savedSets[i] = draftSet;
  saveSavedSets(savedSets);
  draftSet = null;
  renderSetsPanel();
}
function deleteSavedSet(id) {
  savedSets = savedSets.filter((s) => s.id !== id);
  saveSavedSets(savedSets);
  renderSetsPanel();
}

// Sends the placement directly (stage for A, panel for B/C/D) rather than
// going through stage() itself: stage() decides that by reading state.focus,
// and the focus command sent alongside this one has not round-tripped back
// yet, so reading it locally here would still see the OLD focus.
function startSet(setDef, panelIndex) {
  const item = {
    type: 'set', title: setDef.title, mode: setDef.mode,
    entries: setDef.entries.map((e) => ({ item: e.item, seconds: e.seconds })),
  };
  // stage()'s own push only ever looks at the OUTER item's src, which a set
  // never has - its photos are nested inside `entries`, out of reach of
  // that one check, so every one of them needs the same push here.
  for (const e of item.entries) pushAssetIfHeld(e.item.src);
  send({ op: 'focus', index: panelIndex });
  if (panelIndex === 0) send({ op: 'stage', item, where: 'auto' });
  else send({ op: 'panel', index: panelIndex - 1, item });
}

function renderSavedSetsList() {
  const list = $('#sets-list');
  if (!savedSets.length) {
    list.replaceChildren(el('p', { class: 'empty' }, 'No saved sets yet — press "+ New set" below.'));
    return;
  }
  list.replaceChildren(...savedSets.map((setDef) => {
    const row = el('div', { class: 'set-saved-row' },
      el('div', { class: 'set-saved-info' },
        el('span', { class: 'set-saved-title' }, setDef.title || 'Untitled set'),
        el('span', { class: 'hint' }, `${setDef.mode === 'random' ? 'Random' : 'In order'} · ${setDef.entries.length} item${setDef.entries.length === 1 ? '' : 's'}`)),
      el('div', { class: 'set-saved-starts' },
        ...SET_PANEL_LABELS.map((label, i) => el('button', {
          type: 'button', class: 'set-start-btn', title: `Start on panel ${label}`,
          onclick: () => startSet(setDef, i),
        }, label))),
      el('button', { type: 'button', class: 'linkish', onclick: () => editDraftSet(setDef.id) }, 'Edit'),
      el('button', { type: 'button', class: 'linkish danger-outline', onclick: () => deleteSavedSet(setDef.id) }, 'Delete'));
    return row;
  }));
}

function renderDraftSetBuilder() {
  const build = $('#sets-build');
  build.hidden = !draftSet;
  if (!draftSet) return;
  if (document.activeElement !== $('#sets-build-name')) $('#sets-build-name').value = draftSet.title;
  $('#sets-build-mode').value = draftSet.mode;
  $('#sets-build-hint').hidden = false;
  $('#sets-build-hint-name').textContent = draftSet.title || 'this set';
  $('#sets-build-save').disabled = !draftSet.entries.length;
  // Rebuilding this list wholesale is fine between heartbeats, and has to
  // happen right after a remove/move button click (each is inside this same
  // container, so it is what document.activeElement now IS) - but not while
  // a duration field in it is mid-edit, where a rebuild would steal focus
  // out from under a still-being-typed number every second or two.
  if (document.activeElement?.tagName === 'INPUT' && $('#sets-build-entries').contains(document.activeElement)) return;
  $('#sets-build-entries').replaceChildren(...draftSet.entries.map((entry, i) => el('div', { class: 'set-row' },
    el('span', { class: 'set-row-n' }, String(i + 1)),
    el('span', { class: 'set-row-title' }, entryLabel(entry.item)),
    el('input', {
      type: 'number', min: '1', max: '3600', class: 'set-row-secs', value: String(entry.seconds),
      onchange: (ev) => { entry.seconds = Math.max(1, Math.min(3600, Math.round(Number(ev.target.value)) || DEFAULT_ENTRY_SECONDS)); },
    }),
    el('span', { class: 'hint' }, 's'),
    el('button', { type: 'button', class: 'set-row-move', title: 'Move up', disabled: i === 0,
      onclick: () => { [draftSet.entries[i - 1], draftSet.entries[i]] = [draftSet.entries[i], draftSet.entries[i - 1]]; renderSetsPanel(); } }, '↑'),
    el('button', { type: 'button', class: 'set-row-move', title: 'Move down', disabled: i === draftSet.entries.length - 1,
      onclick: () => { [draftSet.entries[i + 1], draftSet.entries[i]] = [draftSet.entries[i], draftSet.entries[i + 1]]; renderSetsPanel(); } }, '↓'),
    el('button', { type: 'button', class: 'set-row-del', title: 'Remove',
      onclick: () => { draftSet.entries.splice(i, 1); renderSetsPanel(); } }, '×'))));
}

let setsRunningDrawn = '';

function renderRunningSet() {
  const holder = $('#sets-running');
  const item = focusedItem(state);
  if (!item || item.type !== 'set') {
    holder.replaceChildren();
    setsRunningDrawn = '';
    return;
  }
  const entry = item.entries[item.index];
  const total = Math.max(1, Number(entry?.seconds) || 1) * 1000;
  const elapsed = item.paused ? total - item.remainingMs : Date.now() - item.startedAt;
  const remaining = Math.max(0, Math.ceil((total - elapsed) / 1000));

  const signature = `${item.key}:${item.entries.length}`;
  if (signature !== setsRunningDrawn) {
    setsRunningDrawn = signature;
    holder.replaceChildren(
      el('div', { class: 'set-now' },
        el('div', { id: 'set-now-title' }),
        el('div', { class: 'set-now-list', id: 'set-now-list' }),
        el('div', { class: 'set-now-transport' },
          el('button', { type: 'button', id: 'set-now-prev' }, '⏮'),
          el('button', { type: 'button', id: 'set-now-pause' }, '⏸'),
          el('button', { type: 'button', id: 'set-now-next' }, '⏭'))));
    // Each broadcast replaces `state` wholesale (see the message handler
    // near the bottom of this file), so `item` itself goes stale the moment
    // the next heartbeat arrives - these buttons are built once per
    // signature but clicked arbitrarily later, so each has to look up the
    // CURRENT item fresh rather than close over this one.
    const current = () => focusedItem(state);
    $('#set-now-prev').addEventListener('click', () => {
      const it = current();
      if (it) send({ op: 'set', action: 'select', index: (it.index - 1 + it.entries.length) % it.entries.length });
    });
    $('#set-now-next').addEventListener('click', () => {
      const it = current();
      if (it) send({ op: 'set', action: 'select', index: (it.index + 1) % it.entries.length });
    });
    $('#set-now-pause').addEventListener('click', () => {
      const it = current();
      if (it) send({ op: 'set', action: it.paused ? 'resume' : 'pause' });
    });
    $('#set-now-list').replaceChildren(...item.entries.map((e, i) => el('button', {
      type: 'button', class: 'set-row', onclick: () => send({ op: 'set', action: 'select', index: i }),
    }, el('span', { class: 'set-row-n' }, String(i + 1)), el('span', { class: 'set-row-title' }, entryLabel(e.item)))));
  }
  $('#set-now-title').textContent = `${item.title || 'Automated set'} — ${item.index + 1} of ${item.entries.length} · ${item.paused ? 'paused' : `${remaining}s left`}`;
  $('#set-now-pause').textContent = item.paused ? '▶' : '⏸';
  $$('#set-now-list .set-row').forEach((row, i) => row.classList.toggle('is-on', i === item.index));
}

function renderSetsPanel() {
  renderSavedSetsList();
  renderDraftSetBuilder();
  renderRunningSet();
}

$('#sets-new').addEventListener('click', newDraftSet);
// Written straight into the draft on every change, not just read at Save:
// renderSetsPanel() runs on every heartbeat and syncs this input FROM
// draftSet.title (so a second device editing the same... well, a draft is
// local, but the pattern is shared with everything else that heartbeat-
// redraws), and without this a typed name surviving only in the DOM would
// be overwritten the moment the field loses focus - switching to the
// Library to add items included.
$('#sets-build-name').addEventListener('input', () => { if (draftSet) draftSet.title = $('#sets-build-name').value; });
$('#sets-build-mode').addEventListener('change', () => { if (draftSet) draftSet.mode = $('#sets-build-mode').value === 'random' ? 'random' : 'sequential'; });
$('#sets-build-save').addEventListener('click', saveDraftSet);
$('#sets-build-cancel').addEventListener('click', cancelDraftSet);
$('#sets-build-add').addEventListener('click', () => {
  document.querySelector('.tab[data-tab="library"]').click();
});

// --- connection -------------------------------------------------------------

let relayStatus = 'connecting';
let waitingSince = Date.now();
const relayLog = createRelayLog();
// Fires at most once per page-load, the moment a display first shows up -
// never again from a later reconnect, so a Wi-Fi blip mid-lecture does not
// blank the room. See the Presentation tab's own explanation of this.
let blankSentThisLoad = false;

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

  // Guarded on `bus` itself, not just `display`: onPeers can in principle
  // fire before connect() finishes assigning the module-level `bus` this
  // file's own send() reads, and a skipped send here should retry on the
  // next heartbeat rather than being marked done and silently never sent.
  if (display && bus && !blankSentThisLoad) {
    blankSentThisLoad = true;
    if (presentation.blankOnConnect) send({ op: 'blank', on: true });
  }

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
        // See lastKnownLectureId above: captured here, the one place
        // state.lectureId changes, so it survives the display clearing it at
        // stand-down and only moves on once a genuinely new lecture starts.
        if (state.lectureId) lastKnownLectureId = state.lectureId;
        telemetry = msg.telemetry || telemetry;
        telemetryAt = Date.now();
        trackRecent();
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
      if (msg.t === 'asset') {
        // An answer to resolveAssets() asking for a photo this device does not
        // hold. Everything showing it re-renders on the next heartbeat.
        if (!msg.id || typeof msg.data !== 'string' || !assetWanted.has(msg.id)) return;
        assetStore.set(msg.id, msg.data);
        assetWanted.delete(msg.id);
        previewKey = null;   // force the mirrors to rebuild against real bytes
        renderAll();
        return;
      }
      if (msg.t === 'ink-data') {
        inkExportWaiters.get(msg.deckId)?.add(msg);
        return;
      }
      if (msg.t === 'ink-every') {
        inkExportWaiters.get(ALL_INK)?.add(msg);
        return;
      }
      if (msg.t === 'shot') {
        // Broadcast by the display, so this arrives on every controller in the
        // room - including the one that did not ask for it, which is the point.
        if (!msg.id || typeof msg.data !== 'string') return;
        clearTimeout(shotPending);
        const photo = addPhoto({
          id: msg.id, data: msg.data,
          title: msg.title || 'Photo',
          badge: msg.target === 'screen' ? 'Screen' : `Panel ${PANEL_LABELS[msg.target] || '?'}`,
        });
        photoNote(msg.tooBig
          ? `${photo.title} — saved, but bigger than a relay message carries, so putting it back on screen may not work.`
          : `${photo.title} — saved. Tap it to put it on screen.`);
        return;
      }
      if (msg.t === 'shot-failed') {
        clearTimeout(shotPending);
        photoNote(`Could not photograph that: ${msg.reason || 'the display did not say why'}.`);
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
  const dualPane = document.body.classList.contains('dual-pane');
  $$('.tab:not(#dual-pane-toggle)').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === name));
  $$('.panel').forEach((p) => {
    if (dualPane && p.dataset.panel === 'slides') {
      p.hidden = false;
    } else {
      p.hidden = p.dataset.panel !== name;
    }
  });
  if (dualPane) {
    document.body.classList.toggle('dual-secondary', name !== 'slides');
  }
  // The list of lectures on the server is asked for again every time the tab
  // carrying it is opened. Reading it once at startup would mean a lecture
  // sent from the desk five minutes ago was invisible here until a reload -
  // and reloading the controller mid-lecture is exactly what nobody wants to
  // discover they have to do.
  // The plan controls live in Library, not Settings - a lecture plan is
  // content, not configuration. Its list of what is on the server is asked for
  // again every time that tab opens, because reading it once at startup would
  // mean a lecture sent from the desk five minutes ago stayed invisible until
  // a reload, and reloading the controller mid-lecture is exactly what nobody
  // wants to find out they have to do.
  if (name === 'library' && !$('#plan-server').hidden) refreshServerPlans();
  // Every panel shares one scrolling container (.panels), so a tab switch
  // alone does not reset it - scrolled halfway down a long Library before
  // tapping Ink lands the Ink tab starting from that same halfway point,
  // and Ink's own content is tall enough that fitBox() then measures the
  // pad against a viewport rect shifted up off the top of the screen. A
  // fresh tab starts scrolled to its own top, always.
  $('.panels').scrollTop = 0;
  // A box measured while its panel is [hidden] gets 0x0 back from
  // getBoundingClientRect() and fitBox() quietly declines to size anything
  // from that, so every "contain"-fit surface needs a nudge the moment its
  // panel actually has a size to fit into - it would otherwise sit blank
  // until whatever periodic update happens to land next.
  if (name === 'ink') { syncInkFromState(); applyInkPreferences(); sizePad(); }
  if (name === 'slides') {
    lastScrolledSlideIndex = null;
    renderSlides();
  }
}

$$('.tab:not(#dual-pane-toggle)').forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab)));

const savedDual = localStorage.getItem('podium.ui.dualPane') === '1';
if (savedDual) {
  document.body.classList.add('dual-pane');
  $('#dual-pane-toggle').classList.add('is-on');
}

$('#dual-pane-toggle').addEventListener('click', () => {
  const isDual = document.body.classList.toggle('dual-pane');
  $('#dual-pane-toggle').classList.toggle('is-on', isDual);
  localStorage.setItem('podium.ui.dualPane', isDual ? '1' : '0');
  const activeTab = document.querySelector('.tab.is-on:not(#dual-pane-toggle)');
  if (activeTab) tab(activeTab.dataset.tab);
  window.dispatchEvent(new Event('resize'));
});

$$('.layout-btn').forEach((b) => {
  b.addEventListener('click', () => send({ op: 'layout', mode: b.dataset.layout }));
  b.title = `${b.title || ''} — hold to photograph the whole screen`.replace(/^ — /, '');
  // Held longer than a panel letter, deliberately: this one is reached for by
  // accident far more easily, and taking a screenshot instead of splitting the
  // screen mid-lecture would be a genuine surprise.
  onLongPress(b, HOLD_SCREEN_MS, () => askForShot('screen', 'the whole screen'));
});
// Composes two commands that already know how to cue themselves while
// frozen (stage() via stageTarget, layout via its own freeze check in
// protocol.js) rather than being its own special case: staging the
// focused panel's content into A, sent directly rather than through
// stage() itself - stage() would route by the CURRENT focus (still B/C/D
// here) and re-stage it right back into the panel it is leaving.
$('#panel-promote').addEventListener('click', () => {
  if (state.focus === 0) return;
  const item = state.panels[state.focus - 1];
  if (!item) return;
  const { key: _k, ...clean } = item;
  pushAssetIfHeld(clean.src);
  send({ op: 'stage', item: clean, where: 'auto' });
  send({ op: 'layout', mode: 'single' });
  send({ op: 'focus', index: 0 });
});

// Per device, like every other preference on this page - hiding the cue bar
// says nothing about the room, and does not stop Take/Swap/Clear cue from
// working, only from being reachable until it is shown again.
const PREVIEW_HIDDEN_KEY = 'podium.previewHidden.v1';
let previewHidden = false;
try { previewHidden = localStorage.getItem(PREVIEW_HIDDEN_KEY) === '1'; } catch { /* private browsing: shown it is */ }

function applyPreviewVisibility() {
  $('.workspace').classList.toggle('no-preview', previewHidden);
  $('#preview-toggle').textContent = previewHidden ? '⟩ Show cue bar' : '⟨ Hide cue bar';
  $('#preview-toggle').title = previewHidden
    ? 'Show the cue bar (Take/Swap/Clear cue)'
    : 'Hide the cue bar for more room to see slides';
}
applyPreviewVisibility();
$('#preview-toggle').addEventListener('click', () => {
  previewHidden = !previewHidden;
  try { localStorage.setItem(PREVIEW_HIDDEN_KEY, previewHidden ? '1' : '0'); } catch { /* nothing to do */ }
  applyPreviewVisibility();
});

$('#take').addEventListener('click', () => send({ op: 'take' }));
$('#swap').addEventListener('click', () => send({ op: 'swap' }));
$('#preview-mode').addEventListener('click', () => send({ op: 'previewMode' }));
$('#clear-preview').addEventListener('click', () => send({ op: 'clear', where: 'preview' }));
$('#mute').addEventListener('click', () => send({ op: 'mute' }));
$('#volume').addEventListener('input', (ev) => send({ op: 'volume', value: Number(ev.target.value) }));

// Three faders, one meaning each - see the Mixer tab's own explanation and
// the comment on contentVolume in protocol.js. mixerSliding stops the next
// broadcast's echo from yanking a fader out from under a still-moving thumb,
// the same reason musicSliding and scrubbing already exist.
$('#mixer-master').addEventListener('input', (ev) => {
  mixerSliding = 'master';
  send({ op: 'volume', value: Number(ev.target.value) });
});
$('#mixer-master').addEventListener('change', () => { mixerSliding = null; });
$('#mixer-content').addEventListener('input', (ev) => {
  mixerSliding = 'content';
  send({ op: 'contentVolume', value: Number(ev.target.value) });
});
$('#mixer-content').addEventListener('change', () => { mixerSliding = null; });
$('#mixer-music').addEventListener('input', (ev) => {
  mixerSliding = 'music';
  sendMusicVolume(Number(ev.target.value));
});
$('#mixer-music').addEventListener('change', () => { mixerSliding = null; });

$('#play-pause').addEventListener('click', () => send({ op: 'media', action: 'toggle' }));
$('#back10').addEventListener('click', () => send({ op: 'media', action: 'nudge', value: -10 }));
$('#fwd10').addEventListener('click', () => send({ op: 'media', action: 'nudge', value: 10 }));
$('#restart-media').addEventListener('click', () => send({ op: 'media', action: 'restart' }));
$('#media-loop').addEventListener('change', (ev) => send({ op: 'media', action: 'setLoop', value: ev.target.checked }));

$('#poll-kind').addEventListener('change', (ev) => {
  if (!pollDraft) return;
  pollDraft.kind = ['text', 'qna'].includes(ev.target.value) ? ev.target.value : 'choice';
  renderPollsPanel();
});
$('#poll-question').addEventListener('input', (ev) => { if (pollDraft) pollDraft.question = ev.target.value; });
$('#poll-option-add').addEventListener('click', () => {
  if (!pollDraft || pollDraft.options.length >= 8) return;
  pollDraft.options.push('');
  pollOptionsDrawn = -1;
  renderPollsPanel();
});
$('#poll-build').addEventListener('submit', (ev) => { ev.preventDefault(); startPoll(); });
$('#poll-copy-link').addEventListener('click', async () => {
  const item = findPollItem();
  const link = item && pollJoinUrl(cfg, item.pollId);
  if (!link) return;
  const button = $('#poll-copy-link');
  try {
    await navigator.clipboard.writeText(link);
    button.textContent = 'Copied!';
  } catch {
    button.textContent = link;
  }
  setTimeout(() => { button.textContent = 'Copy join link'; }, 2000);
});
$('#poll-toggle-open').addEventListener('click', () => {
  const item = findPollItem();
  if (item) setPollOpen(item.open === false);
});
$('#poll-timer-30').addEventListener('click', () => setPollClosesAt(30));
$('#poll-timer-60').addEventListener('click', () => setPollClosesAt(60));
$('#poll-timer-120').addEventListener('click', () => setPollClosesAt(120));
$('#poll-toggle-reveal').addEventListener('click', togglePollReveal);
$('#poll-toggle-view')?.addEventListener('click', () => {
  const item = findPollItem();
  if (item && item.kind === 'text') {
    send({ op: 'poll', pollId: item.pollId, action: 'viewMode', value: item.viewMode === 'cloud' ? 'list' : 'cloud' });
  }
});
$('#poll-export').addEventListener('click', exportPollCsv);
// wireDangerButton leaves a button disabled after a successful action - right
// for the settings reset it was written for, wrong here: a session with
// history and Redisplay/Reopen expects to end more than one poll, and a
// button stuck reading "Clearing…" would silently break the second one.
pollEndButton = wireDangerButton($('#poll-end'), 'End poll', endPoll);
$('#scrub').addEventListener('pointerdown', () => { scrubbing = true; });
$('#scrub').addEventListener('change', (ev) => {
  scrubbing = false;
  send({ op: 'media', action: 'seek', value: Number(ev.target.value) });
});
$('#deck-prev').addEventListener('click', () => send({ op: 'nav', dir: 'prev' }));
$('#deck-next').addEventListener('click', () => send({ op: 'nav', dir: 'next' }));
$('#deck-export').addEventListener('click', exportDeck);
$('#deck-grid-filter').addEventListener('input', filterGrid);

// How the Now/Next row splits its width - 50/50 by default, but not always
// the more useful split: leaning on Now to actually read a dense slide, or
// on Next when Now is one you already know cold. Per device, like the laser
// colour - it says nothing about what is on screen.
const SPLIT_KEY = 'podium.confidenceSplit.v1';
const SPLITS = { even: '50 / 50', now: '75 / 25', next: '25 / 75' };
const SPLIT_ORDER = ['even', 'now', 'next'];
let confidenceSplit = 'even';
try {
  const saved = localStorage.getItem(SPLIT_KEY);
  if (SPLITS[saved]) confidenceSplit = saved;
} catch { /* private browsing: even it is */ }

function applyConfidenceSplit() {
  $('.confidence-row').dataset.split = confidenceSplit;
  $('#confidence-split').textContent = SPLITS[confidenceSplit];
}
applyConfidenceSplit();
$('#confidence-split').addEventListener('click', () => {
  confidenceSplit = SPLIT_ORDER[(SPLIT_ORDER.indexOf(confidenceSplit) + 1) % SPLIT_ORDER.length];
  try { localStorage.setItem(SPLIT_KEY, confidenceSplit); } catch { /* nothing to do */ }
  applyConfidenceSplit();
});

// --- laser pointer -----------------------------------------------------------
//
// Drag on the "Now" preview and a dot follows your finger on the projector,
// mapped through the same content-shaped box the mirror already fits itself
// to. Deliberately not part of `state`: it is a live gesture, not a document
// - no undo, no persistence, no broadcast to reconcile, just raw position
// messages the display renders directly and forgets.

$('#deck-markup').addEventListener('click', () => tab('ink'));

let laserActive = false;
let spotlightActive = false;
const laserDot = el('div', { class: 'laser-dot' });
const spotlightPreview = el('div', { class: 'spotlight-preview' });
$('#deck-now-preview').append(laserDot, spotlightPreview);

function setLaserColor(color) {
  laserColor = LASER_COLORS.includes(color) ? color : 'red';
  try { localStorage.setItem(LASER_KEY, laserColor); } catch { /* nothing to do */ }
  laserDot.dataset.color = laserColor;
  padLaserDot.dataset.color = laserColor;
  // The button wears the colour too, so you can tell at a glance what the
  // class is about to see without pressing it first.
  $('#deck-laser').dataset.color = laserColor;
  $$('.laser-swatch').forEach((b) => b.classList.toggle('is-on', b.dataset.color === laserColor));
}

function setLaserActive(on) {
  if (on && spotlightActive) setSpotlightActive(false);
  laserActive = on;
  $('#deck-laser').classList.toggle('is-on', on);
  nowMirror.frame.classList.toggle('laser-armed', on);
  if (!on) { laserDot.classList.remove('is-on'); bus?.send({ t: 'laser', on: false }); }
  renderBottomSlots();
}

function setSpotlightActive(on) {
  if (on && laserActive) setLaserActive(false);
  spotlightActive = on;
  $('#deck-spotlight')?.classList.toggle('is-on', on);
  nowMirror.frame.classList.toggle('spotlight-armed', on);
  if (!on) { spotlightPreview.classList.remove('is-on'); bus?.send({ t: 'spotlight', on: false }); }
  renderBottomSlots();
}

$('#deck-laser').addEventListener('click', () => setLaserActive(!laserActive));
$('#deck-spotlight')?.addEventListener('click', () => setSpotlightActive(!spotlightActive));
$$('.laser-swatch').forEach((b) => b.addEventListener('click', () => {
  setLaserColor(b.dataset.color);
  // Picking a colour mid-drag would otherwise leave the old one on the wall
  // until the next move; nudge the display so it changes immediately.
  if (pointerDragging === 'laser') sendLaser(...lastLaserPoint);
}));
setLaserColor(laserColor);

function laserPoint(ev) {
  const rect = nowMirror.frame.getBoundingClientRect();
  return [(ev.clientX - rect.left) / rect.width, (ev.clientY - rect.top) / rect.height];
}

let pointerDragging = null;
let lastLaserPoint = [0.5, 0.5];

nowMirror.frame.addEventListener('pointerdown', (ev) => {
  if (!laserActive && !spotlightActive) return;
  const mode = laserActive ? 'laser' : 'spotlight';
  pointerDragging = mode;
  nowMirror.frame.setPointerCapture(ev.pointerId);
  const [x, y] = laserPoint(ev);
  if (mode === 'laser') {
    lastLaserPoint = [x, y];
    laserDot.style.left = `${x * 100}%`;
    laserDot.style.top = `${y * 100}%`;
    laserDot.classList.add('is-on');
    sendLaser(x, y);
  } else {
    spotlightPreview.style.setProperty('--spotlight-x', `${x * 100}%`);
    spotlightPreview.style.setProperty('--spotlight-y', `${y * 100}%`);
    spotlightPreview.classList.add('is-on');
    sendSpotlight(x, y);
  }
});
nowMirror.frame.addEventListener('pointermove', (ev) => {
  if (!pointerDragging) return;
  ev.preventDefault();
  const [x, y] = laserPoint(ev);
  if (pointerDragging === 'laser') {
    lastLaserPoint = [x, y];
    laserDot.style.left = `${x * 100}%`;
    laserDot.style.top = `${y * 100}%`;
    sendLaser(x, y);
  } else {
    spotlightPreview.style.setProperty('--spotlight-x', `${x * 100}%`);
    spotlightPreview.style.setProperty('--spotlight-y', `${y * 100}%`);
    sendSpotlight(x, y);
  }
});
const endPointerDrag = (ev) => {
  if (!pointerDragging) return;
  const mode = pointerDragging;
  pointerDragging = null;
  if (mode === 'laser') {
    laserDot.classList.remove('is-on');
    bus?.send({ t: 'laser', on: false });
  } else {
    spotlightPreview.classList.remove('is-on');
    bus?.send({ t: 'spotlight', on: false });
  }
  try { nowMirror.frame.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
};
nowMirror.frame.addEventListener('pointerup', endPointerDrag);
nowMirror.frame.addEventListener('pointercancel', endPointerDrag);

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

// A photo already on the device, not one reachable by URL - the meme you
// have saved, the screenshot you just took, a student's work photographed
// earlier and dropped into Files. Same asset pipeline as everything else
// that starts as a local file (the watermark logo, a plan's photo field):
// downscale to fit one relay message, hand it an id, stage the reference.
$('#photo-upload').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  $('#photo-upload-note').textContent = `Resizing ${file.name}…`;
  try {
    const shrunk = await downscaleImage(file, MAX_ASSET_CHARS);
    const id = uid(10);
    assetStore.set(id, shrunk.dataUrl);
    const item = { type: 'image', src: assetRef(id), fit: 'contain', title: file.name.replace(/\.[^.]+$/, '') || 'Photo' };
    if ($('#photo-upload-save').checked) {
      saveCustom([...loadCustom(), item]);
      loadLibrary();
    }
    stage(item);
    $('#photo-upload-note').textContent = shrunk.tooBig
      ? `“${file.name}” is still large after resizing and may not reach the projector reliably.`
      : '';
  } catch (err) {
    $('#photo-upload-note').textContent = `That did not load: ${err.message}`;
  }
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

// --- watermark ---------------------------------------------------------------
//
// A name or logo pinned to one corner for the whole lecture, not content - so
// it is set here once rather than picked and lost the next time the screen
// changes. Text and image are independent fields: typing new text does not
// erase an uploaded logo (Remove image is its own button), and the display
// shows whichever one is actually set, image first.

function renderWatermarkPanel() {
  const wm = state.watermark || { enabled: false, text: '', image: '', position: 'br' };
  if (document.activeElement !== $('#watermark-position')) $('#watermark-position').value = wm.position === 'tl' ? 'tl' : 'br';
  $('#watermark-hide').disabled = !wm.enabled;
  $('#watermark-image-clear').hidden = !wm.image;
  const parts = [wm.enabled ? 'showing' : 'hidden'];
  if (wm.image) parts.push('a logo');
  else if (wm.text) parts.push(`“${wm.text}”`);
  else parts.push('nothing set yet');
  $('#watermark-note').textContent = parts.join(' · ');
}

$('#watermark-position').addEventListener('change', () => send({ op: 'watermark', position: $('#watermark-position').value }));
$('#watermark-hide').addEventListener('click', () => send({ op: 'watermark', enabled: false }));
$('#watermark-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = $('#watermark-text').value.trim();
  if (!text) return;
  send({ op: 'watermark', text, enabled: true });
});
$('#watermark-image').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  $('#watermark-note').textContent = `Resizing ${file.name}…`;
  try {
    // PNG rather than the photo ladder's JPEG: a logo's transparent
    // background needs an alpha channel, or it comes out as a black box in
    // the corner. Small dimensions and a single-entry `qualities` (PNG
    // ignores it) keep this from wastefully re-encoding four times over.
    const shrunk = await downscaleImage(file, MAX_ASSET_CHARS, { widths: [480, 320, 200, 120], qualities: [1], mime: 'image/png' });
    const id = uid(10);
    assetStore.set(id, shrunk.dataUrl);
    send({ op: 'watermark', image: assetRef(id), enabled: true });
  } catch (err) {
    $('#watermark-note').textContent = `That did not load: ${err.message}`;
  }
});
$('#watermark-image-clear').addEventListener('click', () => send({ op: 'watermark', image: '' }));

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
// Clearing the board is one tap, because it is a frequent and deliberate move
// mid-lecture. What makes an accidental one survivable is that the display
// keeps what it wiped (see 'restore' in protocol.js) and this offers it back
// for a few seconds - rather than taxing every intentional Clear with a
// confirmation.
const UNCLEAR_MS = 15000;
let unclearTimer = null;
let clearedInk = { surface: null, strokes: [] };

function offerUnclear(surface, strokes) {
  clearedInk = { surface, strokes };
  const button = $('#ink-unclear');
  button.hidden = !strokes.length;
  clearTimeout(unclearTimer);
  if (strokes.length) unclearTimer = setTimeout(() => { button.hidden = true; }, UNCLEAR_MS);
}

$('#ink-clear').addEventListener('click', () => {
  offerUnclear(inkSurface, ink.strokes);
  // Through holdInk, not a bare assignment: the cache holds the array by
  // reference, so replacing it here would leave the old strokes cached and
  // bring them back the moment you flipped away and back again.
  holdInk(inkSurface, []);
  redrawPad();
  send({ op: 'ink', action: 'clear' });
});

$('#ink-unclear').addEventListener('click', () => {
  const { surface, strokes } = clearedInk;
  if (surface !== inkSurface || !strokes.length) { $('#ink-unclear').hidden = true; return; }
  // The display puts its own copy back; this only has to catch up locally.
  send({ op: 'ink', action: 'restore' });
  holdInk(surface, strokes);
  redrawPad();
  offerUnclear(null, []);
});
function setInkTool(tool) {
  if (ink.pointing) {
    if (ink.pointing === 'laser') {
      padLaserDot.classList.remove('is-on');
      bus?.send({ t: 'laser', on: false });
    } else if (ink.pointing === 'spotlight') {
      padSpotlightPreview.classList.remove('is-on');
      bus?.send({ t: 'spotlight', on: false });
    }
    ink.pointing = null;
  }
  ink.tool = tool;
  $$('.ink-tool-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.tool === tool));
  pad.classList.toggle('is-eraser', tool === 'eraser');
  pad.classList.toggle('is-laser', tool === 'laser');
  pad.classList.toggle('is-spotlight', tool === 'spotlight');
  const slider = $('#ink-width');
  if (tool === 'pen') {
    ink.width = ink.penWidth;
    if (slider) slider.value = ink.penWidth;
  } else if (tool === 'highlighter') {
    ink.width = ink.highlighterWidth;
    if (slider) slider.value = ink.highlighterWidth;
  }
}

$$('.ink-tool-btn').forEach((b) => b.addEventListener('click', () => {
  setInkTool(b.dataset.tool);
}));

$('#ink-pen-only').addEventListener('change', (ev) => { ink.penOnly = ev.target.checked; });
$('#ink-width').addEventListener('input', (ev) => {
  const val = Number(ev.target.value);
  ink.width = val;
  if (ink.tool === 'highlighter') ink.highlighterWidth = val;
  else if (ink.tool === 'pen') ink.penWidth = val;
});
$$('.swatch:not(.swatch-picker)').forEach((b) => b.addEventListener('click', () => {
  ink.color = b.dataset.color;
  $$('.swatch:not(.swatch-picker)').forEach((s) => s.classList.toggle('is-on', s === b));
  $('#ink-picker-label')?.classList.remove('is-on');
  if (ink.tool === 'eraser' || ink.tool === 'laser' || ink.tool === 'spotlight') setInkTool('pen');
}));

const INK_CUSTOM_COLOR_KEY = 'podium.ink_custom_color.v1';
let customInkColor = '#a371f7';
try {
  const savedColor = localStorage.getItem(INK_CUSTOM_COLOR_KEY);
  if (savedColor && /^#[0-9a-fA-F]{6}$/.test(savedColor)) customInkColor = savedColor;
} catch { /* private browsing */ }

const inkColorPicker = $('#ink-color-picker');
const inkPickerLabel = $('#ink-picker-label');
if (inkColorPicker && inkPickerLabel) {
  inkColorPicker.value = customInkColor;
  inkPickerLabel.style.setProperty('--custom-color', customInkColor);

  const onCustomColor = (color) => {
    customInkColor = color;
    ink.color = color;
    inkPickerLabel.style.setProperty('--custom-color', color);
    $$('.swatch:not(.swatch-picker)').forEach((s) => s.classList.remove('is-on'));
    inkPickerLabel.classList.add('is-on');
    try { localStorage.setItem(INK_CUSTOM_COLOR_KEY, color); } catch { /* quota / private */ }
    if (ink.tool === 'eraser' || ink.tool === 'laser' || ink.tool === 'spotlight') setInkTool('pen');
  };

  inkColorPicker.addEventListener('input', (ev) => onCustomColor(ev.target.value));
  inkColorPicker.addEventListener('change', (ev) => onCustomColor(ev.target.value));
}

$('#cam-start').addEventListener('click', async () => {
  if (cameraSender?.active) { await cameraSender.stop(); return; }
  await startCamera();
});
$('#cam-shot').addEventListener('click', takeCameraPhoto);
// --- music wiring ------------------------------------------------------------

$('#music-load').addEventListener('click', () => {
  const list = chosenPlaylist();
  if (!list) return;
  const play = !!$('#music-autoplay')?.checked;
  const pauseQueue = !!$('#music-pause-queue')?.checked;
  send({ op: 'music', action: 'load', tracks: list.tracks, name: list.name, play, pauseQueue });
  $('#music-note').textContent = play
    ? `Playing “${list.name}” — ${list.tracks.length} track${list.tracks.length === 1 ? '' : 's'}.`
    : `Loaded “${list.name}” — ${list.tracks.length} track${list.tracks.length === 1 ? '' : 's'}.`;
  updateMusicTrackSelect(list.tracks);
});
$('#music-add').addEventListener('click', () => {
  const list = chosenPlaylist();
  if (!list) return;
  send({ op: 'music', action: 'add', tracks: list.tracks });
  $('#music-note').textContent = `Added “${list.name}” to the end of the queue.`;
  updateMusicTrackSelect(list.tracks);
});
$('#music-track-play').addEventListener('click', () => {
  const idx = Number($('#music-track-select').value) || 0;
  const track = loadedTracks[idx];
  if (!track) return;
  const queueIdx = state.music?.tracks?.findIndex((t) => t.src === track.src);
  if (queueIdx !== -1 && queueIdx !== undefined) {
    send({ op: 'music', action: 'select', index: queueIdx, play: true });
  } else {
    send({ op: 'music', action: 'playnow', track });
  }
  $('#music-note').textContent = `Playing “${track.title || 'Track'}”.`;
});
$('#music-track-add').addEventListener('click', () => {
  const idx = Number($('#music-track-select').value) || 0;
  const track = loadedTracks[idx];
  if (!track) return;
  send({ op: 'music', action: 'add', tracks: [{ src: track.src, title: track.title, artist: track.artist }] });
  $('#music-note').textContent = `Added “${track.title || 'Track'}” to the end of the queue.`;
});
$('#music-url-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const src = $('#music-url').value.trim();
  if (!src) return;
  // The last path segment, without the query string a signed or cache-busted
  // URL carries and without the extension: "sonata.mp3?token=…" is "sonata".
  const title = decodeURIComponent((src.split('/').pop() || 'Track').split(/[?#]/)[0]).replace(/\.[a-z0-9]+$/i, '') || 'Track';
  send({ op: 'music', action: 'add', tracks: [{ src, title }] });
  $('#music-url').value = '';
  $('#music-note').textContent = `Queued “${title}”. It plays from wherever it is hosted; the display fetches it directly.`;
});
$('#music-play').addEventListener('click', () => send({ op: 'music', action: 'toggle' }));
$('#music-prev').addEventListener('click', () => send({ op: 'music', action: 'prev' }));
$('#music-next').addEventListener('click', () => send({ op: 'music', action: 'next' }));
$('#music-fade').addEventListener('click', () => send({ op: 'music', action: 'fadeout' }));
$('#music-shuffle').addEventListener('click', () => send({ op: 'music', action: 'shuffle' }));
$('#music-clear').addEventListener('click', () => send({ op: 'music', action: 'clear' }));

const musicScrub = $('#music-scrub');
if (musicScrub) {
  musicScrub.addEventListener('pointerdown', () => { musicScrubbing = true; });
  musicScrub.addEventListener('input', (ev) => {
    musicScrubbing = true;
    $('#music-time').textContent = fmtTime(Number(ev.target.value));
  });
  musicScrub.addEventListener('change', (ev) => {
    musicScrubbing = false;
    const time = Number(ev.target.value);
    if (state.musicNow) state.musicNow.time = time;
    send({ op: 'music', action: 'seek', time, play: true });
  });
  musicScrub.addEventListener('pointerup', () => {
    setTimeout(() => { musicScrubbing = false; }, 50);
  });
  musicScrub.addEventListener('pointercancel', () => {
    musicScrubbing = false;
    renderMusic();
  });
}
// A panel, staged like anything else from the Library - see stage() - so it
// goes through the usual freeze/cue/take pipeline rather than jumping
// straight to the screen. Its own number comes from the queue, not from
// anything this click needs to know.
const COUNTDOWN_TEXT_KEY = 'podium.countdownText';
const DEFAULT_COUNTDOWN_TEXT = 'We begin in…';

function getCountdownText() {
  try {
    return localStorage.getItem(COUNTDOWN_TEXT_KEY) || DEFAULT_COUNTDOWN_TEXT;
  } catch {
    return DEFAULT_COUNTDOWN_TEXT;
  }
}

function setCountdownText(val) {
  const text = (val || '').trim() || DEFAULT_COUNTDOWN_TEXT;
  try {
    localStorage.setItem(COUNTDOWN_TEXT_KEY, text);
  } catch {}
  updateCountdownButton();
  return text;
}

function updateCountdownButton() {
  const btn = $('#music-countdown');
  if (btn) btn.textContent = `⏳ Show “${getCountdownText()}” on screen`;
}

function openCountdownModal() {
  const modal = $('#modal-countdown');
  const input = $('#input-countdown-text');
  if (!modal || !input) return;
  input.value = getCountdownText();
  modal.hidden = false;
  input.focus();
  input.select();
}

function closeCountdownModal() {
  const modal = $('#modal-countdown');
  if (modal) modal.hidden = true;
}

$('#music-edit-countdown')?.addEventListener('click', openCountdownModal);
$('#modal-countdown-cancel')?.addEventListener('click', closeCountdownModal);

$('#modal-countdown')?.addEventListener('click', (ev) => {
  if (ev.target === $('#modal-countdown')) {
    closeCountdownModal();
  }
});

$('#form-countdown-text')?.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('#input-countdown-text');
  setCountdownText(input?.value);
  closeCountdownModal();
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    const modal = $('#modal-countdown');
    if (modal && !modal.hidden) {
      closeCountdownModal();
    }
  }
});

const COUNTDOWN_QUEUE_KEY = 'podium.countdownQueue';

function isCountdownQueue() {
  try {
    return localStorage.getItem(COUNTDOWN_QUEUE_KEY) === 'true';
  } catch {
    return false;
  }
}

function setCountdownQueue(val) {
  try {
    localStorage.setItem(COUNTDOWN_QUEUE_KEY, val ? 'true' : 'false');
  } catch {}
}

const countdownQueueBox = $('#music-countdown-queue');
if (countdownQueueBox) {
  countdownQueueBox.checked = isCountdownQueue();
  countdownQueueBox.addEventListener('change', (ev) => {
    const untilQueue = ev.target.checked;
    setCountdownQueue(untilQueue);
    if (state.program?.type === 'trackend') {
      stage({ ...state.program, untilQueue });
    } else if (state.preview?.type === 'trackend') {
      stage({ ...state.preview, untilQueue });
    }
  });
}

$('#music-countdown').addEventListener('click', () => stage({
  type: 'trackend',
  title: getCountdownText(),
  untilQueue: $('#music-countdown-queue')?.checked || false,
}));
updateCountdownButton();
// Throttled like the room volume: dragging a slider should not put sixty
// commands a second on the relay.
const sendMusicVolume = throttle((value) => send({ op: 'music', action: 'volume', value }), 120);
$('#music-volume').addEventListener('input', (ev) => { musicSliding = true; sendMusicVolume(Number(ev.target.value)); });
$('#music-volume').addEventListener('change', () => { musicSliding = false; });
$('#music-pause-queue')?.addEventListener('change', (ev) => {
  send({ op: 'music', action: 'pauseQueue', value: ev.target.checked });
});

$('#photo-export').addEventListener('click', exportSession);
$('#photo-export-pdf')?.addEventListener('click', exportSessionPdf);
$('#photo-keep').addEventListener('change', (ev) => setKeepPhotos(ev.target.checked));
// Two taps, like every other irreversible button here. Clearing the strip
// costs nothing that is on screen - the display keeps what it was sent - but
// it does throw away the only copy of anything not yet exported.
wireDangerButton($('#photo-clear'), 'Discard every photo', () => {
  const n = photos.length;
  for (const photo of [...photos]) forgetPhoto(photo.id);
  photoNote(n ? `Discarded ${n} photo${n === 1 ? '' : 's'}. What is on screen stays there.` : 'Nothing to discard.');
}, { armedLabel: 'Tap again to discard' });
// Broadcast rather than a request this controller waits on an answer for -
// same as 'laser' and the other one-way signals in this file. There is no
// per-display acknowledgement to show, so the status line says what was
// sent, not what happened; standDown() on the far end is what actually ends
// each display's own recording, and it is more than best-effort silent about
// that the way an ordinary stand-down already is.
wireDangerButton($('#finish-session'), 'Finish session & save', () => {
  bus?.send({ t: 'session-end' });
  $('#finish-session-status').textContent = 'Sent - every display in this room is ending its session and saving.';
}, { armedLabel: 'Tap again to finish and save' });
$('#photo-panel').addEventListener('click', () => askForShot(state.focus, `panel ${PANEL_LABELS[state.focus]}`));
$('#photo-screen').addEventListener('click', () => askForShot('screen', 'the whole screen'));
// Saving what you have just drawn, from where you drew it. The same thing
// holding the panel letter does - this is just the button you are already
// looking at when the annotation is finished.
$('#ink-save').addEventListener('click', () => {
  tab('photos');
  askForShot(state.focus, `panel ${PANEL_LABELS[state.focus]}`);
});
$('#cam-flip').addEventListener('click', async () => {
  facing = facing === 'environment' ? 'user' : 'environment';
  if (cameraSender?.active) await cameraSender.start({ facingMode: facing });
});

// A Magic Keyboard or a clicker paired to the iPad should just work.
document.addEventListener('keydown', (ev) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
  // Cmd/Ctrl+P is print and Cmd/Ctrl+F is find. Taking a photo of the
  // projector when someone asked the browser to print is worse than doing
  // nothing, so a modified key is not ours.
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

  // Blank and freeze apply to whatever is on screen, so they come first. They
  // used to sit behind the "is this paged content" guard below, which meant B
  // did nothing on a photo or a video - exactly when you reach for it.
  if (ev.key === 'b' || ev.key === 'B') { ev.preventDefault(); send({ op: 'blank' }); return; }
  if (ev.key === 'f' || ev.key === 'F') { ev.preventDefault(); send({ op: 'freeze' }); return; }
  // P photographs the focused panel and Shift+P the whole screen: the same two
  // things holding a button in the top bar does, for whoever is driving from a
  // Magic Keyboard rather than by hand. Like blank and freeze, it applies to
  // whatever is up, so it sits above the "has pages" guard below.
  if (ev.key === 'p' || ev.key === 'P') {
    ev.preventDefault();
    if (ev.shiftKey) askForShot('screen', 'the whole screen');
    else askForShot(state.focus, `panel ${PANEL_LABELS[state.focus]}`);
    return;
  }

  // When focused on the Ink tab, switch tools quickly
  if (!$('[data-panel="ink"]')?.hidden) {
    if (ev.key === '1') { ev.preventDefault(); setInkTool('pen'); return; }
    if (ev.key === '2') { ev.preventDefault(); setInkTool('highlighter'); return; }
    if (ev.key === '3') { ev.preventDefault(); setInkTool('eraser'); return; }
    if (ev.key === '4') { ev.preventDefault(); setInkTool('laser'); return; }
    if (ev.key === '5') { ev.preventDefault(); setInkTool('spotlight'); return; }
    if (ev.key === 'e' || ev.key === 'E') { ev.preventDefault(); setInkTool('eraser'); return; }
    if (ev.key === 'h' || ev.key === 'H') { ev.preventDefault(); setInkTool('highlighter'); return; }
    if (ev.key === 'l' || ev.key === 'L') { ev.preventDefault(); setInkTool('laser'); return; }
    if (ev.key === 's' || ev.key === 'S') { ev.preventDefault(); setInkTool('spotlight'); return; }
  }

  // When focused on the Slides tab, toggle laser or spotlight pointer modes
  if (!$('[data-panel="slides"]')?.hidden) {
    if (ev.key === 'l' || ev.key === 'L') { ev.preventDefault(); setLaserActive(!laserActive); return; }
    if (ev.key === 's' || ev.key === 'S') { ev.preventDefault(); setSpotlightActive(!spotlightActive); return; }
  }

  // Paging, on the other hand, only means something on something with pages.
  if (!['pdf', 'slides', 'web', 'deck'].includes(focusedItem(state)?.type)) return;
  if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ') { ev.preventDefault(); send({ op: 'nav', dir: 'next' }); }
  if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); send({ op: 'nav', dir: 'prev' }); }
});

window.addEventListener('resize', () => { if (!$('[data-panel="ink"]').hidden && !ink.drawing) sizePad(); });
window.addEventListener('beforeunload', () => bus?.close());

installOfflineShell();
setInterval(() => { renderNow(); renderTimers(); renderConnection(); renderClockAndPacing(); }, 250);

// Is this tab itself the stale one? Reloading a page that a cache is still
// answering for can leave you reloading forever without moving, so the
// button below bypasses it explicitly rather than hoping.
// Stated in Settings whether or not anything is wrong with it, because the
// commonest reason to want it is a bug report rather than a stale cache, and
// until now this page was the one that never said. The display has had its
// own line in Settings all along; this is the same line, in the same place,
// on the device actually in your hand.
$('#control-version').textContent = VERSION;
$('#control-build-number').textContent = String(BUILD);
const versionTag = $('#control-version-tag');
if (versionTag) versionTag.textContent = versionStamp();
servedBuild().then((served) => {
  if (served === null || served === BUILD) return;
  $('#update-detail').textContent = `Running build ${BUILD}; the server is serving build ${served}.`;
  $('#update-banner').hidden = false;
  $('#control-build-check').textContent = ` — but the server is serving build ${served}, so this page came from a cache. Reload it.`;
  $('#control-build').classList.add('is-stale');
});
$('#update-reload').addEventListener('click', () => {
  // A cache-busting query on the page URL forces the HTML - and with it the
  // module graph hanging off it - to come from the server rather than from
  // whatever this browser decided to keep.
  const url = new URL(location.href);
  url.searchParams.set('fresh', Date.now().toString(36));
  location.replace(url);
});

// --- presentation preferences -------------------------------------------------
//
// Per device, like previewHidden and confidenceSplit above - none of this is
// room state, so none of it goes through send()/state. Grouped into one
// object rather than three loose keys because this is the one place in the
// app where "device preferences" has grown into its own settings surface
// (the Presentation tab) rather than a single quick-access toggle.
const PRESENTATION_KEY = 'podium.presentation.v1';
const PRESENTATION_DEFAULTS = {
  theme: 'dark',
  showPollUrl: true,
  blankOnConnect: true,
  keepAwake: true,
  haptics: true,
  keepPhotos: false,
  lectureDuration: 0,
  pacingAutoStart: true,
  bottomSlot1: 'music',
  bottomSlot2: 'play',
  bottomSlots: ['music', 'play', 'freeze', 'blank', 'none', 'none', 'none', 'none'],
  inkScrollGutter: false,
  inkControlsTop: false,
  snapShapes: true,
};
function loadPresentation() {
  try {
    const saved = JSON.parse(localStorage.getItem(PRESENTATION_KEY) || '{}');
    const merged = { ...PRESENTATION_DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    if (!['dark', 'light', 'auto'].includes(merged.theme)) merged.theme = 'dark';
    if (merged.haptics === undefined) merged.haptics = true;
    if (merged.snapShapes === undefined) merged.snapShapes = true;
    if (!Array.isArray(merged.bottomSlots) || merged.bottomSlots.length !== 8) {
      merged.bottomSlots = [
        merged.bottomSlot1 || 'music',
        merged.bottomSlot2 || 'play',
        'freeze',
        'blank',
        'none',
        'none',
        'none',
        'none',
      ];
    }
    return merged;
  } catch { return { ...PRESENTATION_DEFAULTS }; }
}
function savePresentation() {
  try { localStorage.setItem(PRESENTATION_KEY, JSON.stringify(presentation)); } catch { /* private mode, or quota */ }
}
let presentation = loadPresentation();

function getBottomSlots() {
  if (Array.isArray(presentation.bottomSlots) && presentation.bottomSlots.length === 8) {
    return presentation.bottomSlots;
  }
  return [
    presentation.bottomSlot1 || 'music',
    presentation.bottomSlot2 || 'play',
    'freeze',
    'blank',
    'none',
    'none',
    'none',
    'none',
  ];
}

function applyInkPreferences() {
  const inkPanel = $('[data-panel="ink"]');
  if (inkPanel) {
    inkPanel.classList.toggle('pad-gutter', !!presentation.inkScrollGutter);
    inkPanel.classList.toggle('controls-top', !!presentation.inkControlsTop);
  }
  if (!$('[data-panel="ink"]')?.hidden && !ink.drawing && !ink.pointing) {
    sizePad();
  }
}
applyInkPreferences();

// Lecture pacing state (survives reloads mid-lecture)
const PACING_KEY = 'podium.pacing.v1';
function loadPacingState() {
  try {
    const saved = JSON.parse(localStorage.getItem(PACING_KEY) || 'null');
    if (saved && typeof saved.startedAt === 'number') return saved;
  } catch { /* private mode */ }
  return { startedAt: null };
}
function savePacingState(pacing) {
  try {
    if (pacing && pacing.startedAt) {
      localStorage.setItem(PACING_KEY, JSON.stringify(pacing));
    } else {
      localStorage.removeItem(PACING_KEY);
    }
  } catch { /* private mode */ }
}
let pacingState = loadPacingState();

function startPacingTimer() {
  pacingState = { startedAt: Date.now() };
  savePacingState(pacingState);
  renderClockAndPacing();
}

function resetPacingTimer() {
  pacingState = { startedAt: null };
  savePacingState(pacingState);
  renderClockAndPacing();
}

function checkPacingAutoStart(cmd) {
  if (!presentation.pacingAutoStart || !presentation.lectureDuration || pacingState.startedAt) return;
  const isNav = cmd?.op === 'nav';
  const isUnblank = cmd?.op === 'blank' && (cmd.on === false || (cmd.on === undefined && state.blank));
  if (isNav || isUnblank) {
    startPacingTimer();
  }
}

function renderClockAndPacing() {
  const clockEl = $('#topbar-clock');
  if (clockEl) {
    clockEl.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  const pacingBtn = $('#topbar-pacing');
  const pacingLabel = $('#topbar-pacing-label');
  const pacingBar = $('#topbar-pacing-bar');
  if (!pacingBtn || !pacingLabel || !pacingBar) return;

  const dur = Number(presentation.lectureDuration) || 0;
  if (dur <= 0) {
    pacingBtn.hidden = true;
    return;
  }
  pacingBtn.hidden = false;

  if (!pacingState.startedAt) {
    pacingBtn.classList.remove('is-running', 'is-near-end', 'is-overtime');
    pacingLabel.textContent = `▶ Start (${dur}m)`;
    pacingBar.style.width = '0%';
    pacingBtn.title = 'Start lecture pacing timer';
    return;
  }

  const elapsedSec = Math.max(0, Math.floor((Date.now() - pacingState.startedAt) / 1000));
  const totalSec = dur * 60;
  pacingBtn.classList.add('is-running');

  if (elapsedSec < totalSec) {
    const nearEnd = elapsedSec >= totalSec * 0.85;
    pacingBtn.classList.toggle('is-near-end', nearEnd);
    pacingBtn.classList.remove('is-overtime');
    const pct = Math.min(100, Math.round((elapsedSec / totalSec) * 100));
    pacingBar.style.width = `${pct}%`;
    pacingLabel.textContent = `${fmtTime(elapsedSec)} / ${dur}m`;
    pacingBtn.title = `Lecture pacing: ${fmtTime(elapsedSec)} elapsed of ${dur}m (tap to reset)`;
  } else {
    pacingBtn.classList.remove('is-near-end');
    pacingBtn.classList.add('is-overtime');
    const overSec = elapsedSec - totalSec;
    pacingBar.style.width = '100%';
    pacingLabel.textContent = `+${fmtTime(overSec)} (${dur}m)`;
    pacingBtn.title = `Lecture pacing: ${fmtTime(overSec)} overtime (tap to reset)`;
  }
}
renderClockAndPacing();

function renderSlotButton(btn, slotType) {
  if (!btn) return;
  btn.dataset.slotAction = slotType || 'none';
  btn.disabled = false;
  btn.classList.remove('is-on', 'is-armed');

  switch (slotType) {
    case 'music': {
      const music = state.music || { tracks: [], playing: false };
      btn.hidden = !music.tracks?.length;
      btn.textContent = music.playing ? '♪ ⏸' : '♪ ▶';
      btn.title = music.playing ? 'Pause background music' : 'Play background music';
      btn.classList.toggle('is-on', !!music.playing);
      break;
    }

    case 'play': {
      const item = focusedItem(state);
      const isMedia = ['video', 'audio', 'youtube'].includes(item?.type);
      btn.hidden = !isMedia;
      btn.textContent = telemetry.playing ? '⏸' : '▶';
      btn.title = telemetry.playing ? 'Pause media' : 'Play media';
      btn.classList.toggle('is-on', telemetry.playing);
      break;
    }

    case 'freeze':
      btn.hidden = false;
      btn.textContent = state.frozen ? 'Frozen' : 'Freeze';
      btn.title = state.frozen ? 'Unfreeze presentation' : 'Freeze presentation (holds screen)';
      btn.classList.toggle('is-on', !!state.frozen);
      break;

    case 'blank':
      btn.hidden = false;
      btn.textContent = state.blank ? 'Blanked' : 'Blank';
      btn.title = state.blank ? 'Unblank presentation' : 'Blank presentation (black screen)';
      btn.classList.toggle('is-on', !!state.blank);
      break;

    case 'take': {
      const cued = !!state.preview || state.previewLayout !== null;
      btn.hidden = false;
      btn.disabled = !cued;
      btn.textContent = 'TAKE';
      btn.title = cued ? 'Take cued item to live display' : 'No item cued';
      btn.classList.toggle('is-armed', cued);
      break;
    }

    case 'clear': {
      const cued = !!state.preview || state.previewLayout !== null;
      btn.hidden = false;
      btn.disabled = !cued;
      btn.textContent = '✕ Clear';
      btn.title = cued ? 'Clear cued preview' : 'No item cued';
      break;
    }

    case 'whiteboard': {
      btn.hidden = false;
      const isWb = focusedItem(state)?.type === 'whiteboard';
      btn.textContent = '✎';
      btn.title = 'Quick whiteboard';
      btn.classList.toggle('is-on', isWb);
      break;
    }

    case 'laser':
      btn.hidden = false;
      btn.textContent = '🔦';
      btn.title = 'Toggle laser pointer';
      btn.classList.toggle('is-on', laserActive);
      break;

    case 'spotlight':
      btn.hidden = false;
      btn.textContent = '🔆';
      btn.title = 'Toggle spotlight mode';
      btn.classList.toggle('is-on', spotlightActive);
      break;

    case 'timer': {
      btn.hidden = false;
      const timer = currentTimer();
      btn.textContent = timer?.running ? '⏱ ⏸' : '⏱ ▶';
      btn.title = timer?.running ? 'Pause timer' : 'Start / resume timer';
      btn.classList.toggle('is-on', !!timer?.running);
      break;
    }

    case 'next': {
      const item = focusedItem(state);
      const isPaged = ['pdf', 'slides', 'web', 'deck'].includes(item?.type);
      btn.hidden = false;
      btn.disabled = !isPaged;
      btn.textContent = '→';
      btn.title = 'Next slide / page';
      break;
    }

    case 'prev': {
      const item = focusedItem(state);
      const isPaged = ['pdf', 'slides', 'web', 'deck'].includes(item?.type);
      btn.hidden = false;
      btn.disabled = !isPaged;
      btn.textContent = '←';
      btn.title = 'Previous slide / page';
      break;
    }

    case 'none':
    default:
      btn.hidden = true;
      btn.textContent = '';
      btn.title = '';
      break;
  }
}

function renderBottomSlots() {
  const slots = getBottomSlots();
  const slotElements = [
    $('#bar-music'),
    $('#bar-play'),
    $('#freeze'),
    $('#blank'),
    $('#bar-slot-5'),
    $('#bar-slot-6'),
    $('#bar-slot-7'),
    $('#bar-slot-8'),
  ];

  let visibleActiveCount = 0;
  slots.forEach((slotType, idx) => {
    const btn = slotElements[idx];
    if (!btn) return;
    renderSlotButton(btn, slotType);

    if (!btn.hidden) {
      visibleActiveCount += 1;
      btn.classList.toggle('mobile-overflow', visibleActiveCount > 4);
    } else {
      btn.classList.remove('mobile-overflow');
    }
  });
}

function executeSlotAction(type) {
  switch (type) {
    case 'music':
      send({ op: 'music', action: 'toggle' });
      break;

    case 'play':
      send({ op: 'media', action: 'toggle' });
      break;

    case 'freeze':
      send({ op: 'freeze' });
      break;

    case 'blank':
      send({ op: 'blank' });
      break;

    case 'take':
      send({ op: 'take' });
      break;

    case 'clear':
      send({ op: 'clear', where: 'preview' });
      break;

    case 'whiteboard':
      stage({ title: 'Whiteboard', type: 'whiteboard', bg: '#f7f5ef' });
      break;

    case 'laser':
      setLaserActive(!laserActive);
      break;

    case 'spotlight':
      setSpotlightActive(!spotlightActive);
      break;

    case 'timer': {
      const timer = currentTimer();
      const id = timer?.id;
      if (timer?.running) {
        send({ op: 'timer', action: 'pause', id });
      } else if ((timer?.remainingMs || 0) > 0) {
        send({ op: 'timer', action: 'resume', id });
      } else {
        const mins = Number($('#timer-mins')?.value) || 5;
        send({ op: 'timer', action: 'start', id, seconds: mins * 60, label: timer?.label || `${mins}m` });
      }
      break;
    }

    case 'next':
      send({ op: 'nav', dir: 'next' });
      break;

    case 'prev':
      send({ op: 'nav', dir: 'prev' });
      break;
  }
}

// Route bottom slot buttons to their configured actions
$('.bottombar')?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.bar-slot');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.slotAction;
  if (action && action !== 'none') {
    executeSlotAction(action);
  }
});

renderBottomSlots();

// Keeping this device awake is a live effect, not just a stored preference -
// toggling it in Settings has to take hold immediately, and a lock has to be
// re-requested on return from the background the same way display.js already
// does for the projector (a backgrounded tab silently drops any lock it held).
let wakeLock = null;
async function applyWakeLock() {
  if (!presentation.keepAwake) {
    // Cleared here rather than left to the sentinel's own 'release' event:
    // that event is what notices an OS-initiated release, but the moment a
    // release we asked for ourselves should already read as "not held" -
    // waiting on the event round-trip would leave a re-check moments later
    // (see the change listener below) finding a stale, already-releasing
    // wakeLock and quietly skipping the fresh request it owes.
    const current = wakeLock;
    wakeLock = null;
    await current?.release();
    return;
  }
  if (wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeLock?.addEventListener('release', () => { wakeLock = null; });
  } catch { /* not supported, or denied - the device may dim on its own */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') applyWakeLock(); });
applyWakeLock();

function applyTheme() {
  const theme = presentation.theme || 'dark';
  let effective = theme;
  if (theme === 'auto') {
    effective = (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = effective;
  document.body.dataset.theme = effective;
}
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (presentation.theme === 'auto') applyTheme();
  });
}
applyTheme();

function settingsTab(name) {
  $$('#setup .settings-tabs .tab').forEach((b) => b.classList.toggle('is-on', b.dataset.settingsTab === name));
  $$('#setup [data-settings-panel]').forEach((p) => { p.hidden = p.dataset.settingsPanel !== name; });
}
$$('#setup .settings-tabs .tab').forEach((b) => b.addEventListener('click', () => settingsTab(b.dataset.settingsTab)));

$('#pref-theme')?.addEventListener('change', (ev) => {
  presentation.theme = ev.target.value;
  savePresentation();
  applyTheme();
});
$('#pref-poll-url').addEventListener('change', (ev) => { presentation.showPollUrl = ev.target.checked; savePresentation(); });
$('#pref-blank-on-connect').addEventListener('change', (ev) => { presentation.blankOnConnect = ev.target.checked; savePresentation(); });
$('#pref-keep-awake').addEventListener('change', (ev) => { presentation.keepAwake = ev.target.checked; savePresentation(); applyWakeLock(); });
$('#pref-haptics')?.addEventListener('change', (ev) => {
  presentation.haptics = ev.target.checked;
  savePresentation();
  if (presentation.haptics) haptic('tick');
});
// Changing the default takes effect now as well as next time: turning it on in
// Settings and finding the Photos tab still unticked would read as a bug.
$('#pref-keep-photos').addEventListener('change', (ev) => {
  presentation.keepPhotos = ev.target.checked;
  savePresentation();
  keepPhotosThisSession = null;
  renderKeepPhotos();
});

$('#pref-lecture-duration').addEventListener('change', (ev) => {
  const val = ev.target.value;
  if (val === 'custom') {
    $('#pref-lecture-duration-custom').hidden = false;
    $('#pref-lecture-duration-custom').value = presentation.lectureDuration || 50;
    presentation.lectureDuration = Number($('#pref-lecture-duration-custom').value) || 50;
    $('#pref-lecture-duration-custom').focus();
  } else {
    $('#pref-lecture-duration-custom').hidden = true;
    presentation.lectureDuration = Number(val);
  }
  savePresentation();
  renderClockAndPacing();
});

$('#pref-lecture-duration-custom').addEventListener('input', (ev) => {
  const parsed = parseInt(ev.target.value, 10);
  if (!Number.isNaN(parsed) && parsed > 0) {
    presentation.lectureDuration = Math.min(360, parsed);
    savePresentation();
    renderClockAndPacing();
  }
});

$('#pref-pacing-autostart').addEventListener('change', (ev) => {
  presentation.pacingAutoStart = ev.target.checked;
  savePresentation();
});

for (let i = 1; i <= 8; i++) {
  $(`#pref-bottom-slot-${i}`)?.addEventListener('change', (ev) => {
    presentation.bottomSlots = getBottomSlots().slice();
    presentation.bottomSlots[i - 1] = ev.target.value;
    presentation.bottomSlot1 = presentation.bottomSlots[0];
    presentation.bottomSlot2 = presentation.bottomSlots[1];
    savePresentation();
    renderBottomSlots();
  });
}

$('#pref-ink-scroll-gutter')?.addEventListener('change', (ev) => {
  presentation.inkScrollGutter = ev.target.checked;
  savePresentation();
  applyInkPreferences();
});

$('#pref-ink-controls-top')?.addEventListener('change', (ev) => {
  presentation.inkControlsTop = ev.target.checked;
  savePresentation();
  applyInkPreferences();
});

$('#pref-snap-shapes')?.addEventListener('change', (ev) => {
  presentation.snapShapes = ev.target.checked;
  savePresentation();
});

$('#topbar-pacing')?.addEventListener('click', () => {
  if (!pacingState.startedAt) {
    startPacingTimer();
  } else {
    if (confirm('Reset lecture pacing timer?')) {
      resetPacingTimer();
    }
  }
});

// --- setup ------------------------------------------------------------------

function showSetup() {
  $('#setup').hidden = false;
  $('#app').hidden = true;
  $('#setup-close').hidden = !isConfigured(cfg);
  settingsTab('connection');
  const prefTheme = $('#pref-theme');
  if (prefTheme) prefTheme.value = presentation.theme || 'dark';
  $('#pref-poll-url').checked = presentation.showPollUrl;
  $('#pref-blank-on-connect').checked = presentation.blankOnConnect;
  $('#pref-keep-awake').checked = presentation.keepAwake;
  const prefHaptics = $('#pref-haptics');
  if (prefHaptics) prefHaptics.checked = presentation.haptics !== false;
  const unsuppHaptics = $('#pref-haptics-unsupported');
  if (unsuppHaptics) unsuppHaptics.hidden = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  $('#pref-keep-photos').checked = presentation.keepPhotos;
  const dur = presentation.lectureDuration || 0;
  const stdPresets = ['0', '30', '45', '50', '60', '75', '90'];
  if (stdPresets.includes(String(dur))) {
    $('#pref-lecture-duration').value = String(dur);
    $('#pref-lecture-duration-custom').hidden = true;
  } else {
    $('#pref-lecture-duration').value = 'custom';
    $('#pref-lecture-duration-custom').hidden = false;
    $('#pref-lecture-duration-custom').value = dur;
  }
  $('#pref-pacing-autostart').checked = presentation.pacingAutoStart !== false;
  const currentSlots = getBottomSlots();
  for (let i = 1; i <= 8; i++) {
    const el = $(`#pref-bottom-slot-${i}`);
    if (el) el.value = currentSlots[i - 1] || 'none';
  }
  $('#pref-bottom-slot-1').value = presentation.bottomSlot1 || currentSlots[0] || 'music';
  $('#pref-bottom-slot-2').value = presentation.bottomSlot2 || currentSlots[1] || 'play';
  const prefGutter = $('#pref-ink-scroll-gutter');
  if (prefGutter) prefGutter.checked = !!presentation.inkScrollGutter;
  const prefTop = $('#pref-ink-controls-top');
  if (prefTop) prefTop.checked = !!presentation.inkControlsTop;
  const prefSnap = $('#pref-snap-shapes');
  if (prefSnap) prefSnap.checked = presentation.snapShapes !== false;
  renderKeepPhotos();
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

  // More than one course on this server has settings this account may use, so
  // nothing was adopted automatically (loadConfig only does that when there is
  // exactly one and no choice to make). Offer them: each button fills the form
  // in, leaving the person to look at it and press Save, rather than silently
  // re-pointing a controller at a room.
  const courses = cfg.serverCourses || [];
  $('#setup-courses').hidden = courses.length < 2;
  $('#setup-course-buttons').replaceChildren(...courses.map((course) => el('button', {
    type: 'button',
    onclick: () => {
      for (const [key, value] of Object.entries(course.settings)) {
        const field = form.elements[key];
        if (field) field.value = value;
      }
      onTransport();
      $('#setup-error').textContent = `Filled in from ${course.title}. Check it and save.`;
    },
  }, course.title || course.course)));
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

// The same thing without the file: a lecture built at the desk and sent to the
// server is already here. Absent a server, none of this appears and the file
// picker above is the whole story.
async function refreshServerPlans() {
  try {
    const res = await fetch('/api/plans', { credentials: 'same-origin' });
    if (!res.ok) return;
    const { plans } = await res.json();
    const pick = $('#plan-server-pick');
    pick.replaceChildren(...(plans || []).map((row) => el('option', { value: String(row.id) },
      [row.title, row.course && `(${row.course})`].filter(Boolean).join(' '))));
    if (!(plans || []).length) pick.append(el('option', { value: '' }, 'Nothing saved yet'));
  } catch { /* the file picker above is unaffected */ }
}

$('#plan-server-open').addEventListener('click', async () => {
  const id = $('#plan-server-pick').value;
  if (!id) return;
  $('#plan-note').textContent = 'Opening…';
  try {
    const res = await fetch(`/api/plans/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'that did not open');
    const doc = body.plan.doc;
    const { plan, warnings } = readPlan(typeof doc === 'string' ? doc : JSON.stringify(doc));
    await adoptPlan(plan);
    await loadLibrary();
    tab('library');
    $('#plan-note').textContent = warnings.length
      ? `Loaded “${plan.title}”, with ${warnings.length} problem${warnings.length === 1 ? '' : 's'}: ${warnings.join(' ')}`
      : `Loaded “${plan.title}”.`;
  } catch (err) {
    $('#plan-note').textContent = `That lecture did not open: ${err.message}`;
  }
});

serverInfo().then((info) => {
  if (!info.features.includes('plans')) return;
  $('#plan-server').hidden = false;
  refreshServerPlans();
});

$('#plan-clear').addEventListener('click', async () => {
  currentPlan = null;
  forgetPlanAssets();
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
  await loadPlaylists();
  tab('library');
  renderAll();
}

async function sendQnaAction(pollId, token, id, type, value) {
  try {
    await pollApi(`/${pollId}/qna-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id, type, value }),
    });
  } catch (err) {
    pollActionError = err.message || 'Failed to update question.';
    renderPolls();
  }
}
