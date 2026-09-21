// A lecture plan: the running order, the timers and the media you built in your
// office, packed into one file you can carry to the iPad.
//
// The Saved library in control.html lives in localStorage, which never leaves
// the device that made it - so a plan prepared on a desktop would be invisible
// on the tablet you actually teach from. A plan is therefore a plain JSON
// document, self-contained: uploaded slides travel as their markdown, uploaded
// photos as data URLs, and nothing in a plan points at a file that has to be
// deployed alongside it before the plan will work. Download it in the office,
// AirDrop or iCloud it over, load it on the iPad.
//
// Nothing in here touches the DOM or storage, so it is testable on its own -
// see test/plan.test.mjs.

import { uid } from './util.js';
import { MAX_TIMERS } from './protocol.js';

export const PLAN_VERSION = 1;

// Big enough for a real lecture's worth of photos, small enough that a
// mistyped file (or a malicious one) cannot wedge the tablet parsing it.
export const MAX_PLAN_BYTES = 24 * 1024 * 1024;

// Per asset, in data-URL characters. Every asset has to survive one hop over
// the relay to reach the projector, and the relay caps a message at 256 KB:
// the envelope is the JSON, encrypted and then base64'd, so it lands at about
// 1.33x whatever goes in. 160 KB of data URL is ~120 KB of image - the same
// budget uploaded decks already get - and leaves room for the envelope.
export const MAX_ASSET_CHARS = 160 * 1024;

// The types a plan can hold, and the fields each one needs. The editor in
// plan.js is generated from this, so a type gains a field in exactly one place.
// `asset: true` marks a field whose value may be an `asset:<id>` reference into
// the plan's own asset table rather than a path on your server.
export const PLAN_TYPES = {
  deck: {
    label: 'Marp deck', icon: '\u{1F4D6}',
    blurb: 'Markdown slides. Upload a .md file, or point at one already on your server.',
    fields: [
      { key: 'asset', label: 'Slides file', kind: 'upload', accept: '.md,.markdown,text/markdown', asset: true,
        hint: 'The markdown travels inside the plan, so it works on the iPad with nothing deployed.' },
      { key: 'src', label: 'or a path on the server', kind: 'text', placeholder: 'content/decks/week3.md' },
    ],
  },
  image: {
    label: 'Photo', icon: '\u{1F5BC}',
    blurb: 'A picture on the projector. Uploads are resized to fit through the relay, or choose one on your server.',
    fields: [
      { key: 'src', label: 'Photo', kind: 'image', asset: true },
      { key: 'path', label: 'or path on server', kind: 'text', placeholder: 'content/photos/diagram.png' },
      { key: 'fit', label: 'Fit', kind: 'select', def: 'contain',
        options: [['contain', 'Fit inside (letterbox)'], ['cover', 'Fill the screen (crop)']] },
    ],
  },
  text: {
    label: 'Text sign', icon: 'T',
    blurb: 'Big words on the screen: a title card, "Back in 5", an instruction to a group.',
    fields: [
      { key: 'body', label: 'What it says', kind: 'textarea', placeholder: '**Group work**\nCompare your two coding schemes',
        hint: '**bold**, *italic*, `code`. Line breaks are kept.' },
      { key: 'size', label: 'Size', kind: 'select', def: 'l',
        options: [['s', 'Small'], ['m', 'Medium'], ['l', 'Large'], ['xl', 'Huge']] },
      { key: 'align', label: 'Align', kind: 'select', def: 'center',
        options: [['center', 'Centred'], ['left', 'Left']] },
      { key: 'bg', label: 'Background', kind: 'color', def: '' },
    ],
  },
  timer: {
    label: 'Countdown', icon: '⏱',
    blurb: 'One of this lecture\u2019s countdowns, on the projector. Start it from the Timer tab once it is up.',
    fields: [
      // Which clock, not how long: the length lives on the timer itself (see
      // Timers, under the running order), so two items can show the same
      // countdown and a split screen can show two different ones at once.
      { key: 'timerId', label: 'Which countdown', kind: 'timer-pick',
        hint: 'Defined under Timers. A lecture can have up to four, each running independently.' },
      { key: 'label', label: 'Label, if that countdown has none', kind: 'text', placeholder: 'Group work' },
    ],
  },
  qr: {
    label: 'QR code', icon: '⌗',
    blurb: 'A link the class can scan off the projector.',
    fields: [
      { key: 'data', label: 'Link or text', kind: 'text', placeholder: 'https://example.edu/psy3010' },
      { key: 'caption', label: 'Caption', kind: 'text', placeholder: 'Today’s reading' },
    ],
  },
  youtube: {
    label: 'YouTube', icon: '▶',
    blurb: 'Paste the watch URL; the id and start time are read out of it.',
    fields: [
      { key: 'videoId', label: 'Video id or URL', kind: 'text', placeholder: 'https://youtu.be/ZMLzP1VCANo' },
      { key: 'startAt', label: 'Start at (seconds)', kind: 'number', def: 0, min: 0, max: 86400 },
    ],
  },
  pdf: {
    label: 'PDF', icon: '\u{1F4C4}',
    blurb: 'A handout or a figure, by path on your server.',
    fields: [
      { key: 'src', label: 'Path or URL', kind: 'text', placeholder: 'content/handouts/ch4.pdf' },
      { key: 'page', label: 'Open at page', kind: 'number', def: 1, min: 1, max: 9999 },
    ],
  },
  video: {
    label: 'Video', icon: '▶',
    blurb: 'A clip on your server. Too big to carry inside a plan, so this one is a path.',
    fields: [{ key: 'src', label: 'Path or URL', kind: 'text', placeholder: 'content/video/reaction.mp4' }],
  },
  audio: {
    label: 'Audio', icon: '♪',
    blurb: 'Waiting music, or a clip to play with the screen black.',
    fields: [
      { key: 'src', label: 'Path or URL', kind: 'text', placeholder: 'content/audio/waiting-music.wav' },
      { key: 'artist', label: 'Credit', kind: 'text', placeholder: 'Who made it' },
      { key: 'loop', label: 'Loop', kind: 'check', def: false },
    ],
  },
  slides: {
    label: 'HTML slides', icon: '\u{1F4D1}',
    blurb: 'A deck that is already a web page (Reveal, Slidev, an exported Keynote).',
    fields: [{ key: 'src', label: 'Path or URL', kind: 'text', placeholder: 'content/slides/week1/index.html' }],
  },
  web: {
    label: 'Web page', icon: '\u{1F310}',
    blurb: 'Any page. Some sites refuse to be framed; check it here before class.',
    fields: [{ key: 'src', label: 'URL', kind: 'text', placeholder: 'https://example.edu/demo' }],
  },
  whiteboard: {
    label: 'Whiteboard', icon: '✎',
    blurb: 'A blank surface to draw on from the iPad.',
    fields: [{ key: 'bg', label: 'Background', kind: 'color', def: '#f7f5ef' }],
  },
  black: { label: 'Black', icon: '●', blurb: 'Nothing on screen. The polite way to pause.', fields: [] },
  camera: { label: 'Phone camera', icon: '\u{1F4F7}', blurb: 'Your phone’s camera on the projector, for a document or a demo.', fields: [] },
  poll: {
    label: 'Poll', icon: '\u{1F4CA}',
    blurb: 'A question the room answers on their own phones. Write it now; starting it - creating the actual join code on the relay - happens from the Polls tab in class.',
    fields: [
      { key: 'kind', label: 'Type', kind: 'select', def: 'choice',
        options: [['choice', 'Multiple choice'], ['text', 'Short answer']] },
      { key: 'question', label: 'Question', kind: 'textarea', placeholder: 'Which bias is this?' },
      { key: 'options', label: 'Options', kind: 'poll-options',
        hint: 'Ignored for a short-answer poll.' },
      { key: 'correct', kind: 'number', def: -1, hidden: true },
    ],
  },
};

export const PLANNABLE = Object.keys(PLAN_TYPES);

export function assetRef(id) { return `asset:${id}`; }
export function isAssetRef(value) { return typeof value === 'string' && value.startsWith('asset:'); }
export function assetIdOf(value) { return isAssetRef(value) ? value.slice(6) : null; }

export function emptyAutoLaunch() {
  return {
    enabled: false,
    initialState: 'live',
    panes: { A: null, B: null, C: null, D: null },
    music: { playlist: '', autoplay: true, volume: 0.5 },
    timer: { timerId: '' },
  };
}

export function emptyPlan(title = 'Untitled lecture') {
  const now = Date.now();
  return {
    podium: 'plan',
    v: PLAN_VERSION,
    id: uid(10),
    title,
    course: '',
    notes: '',
    created: now,
    updated: now,
    layout: 'single',
    items: [],
    timers: [],
    assets: {},
    autoLaunch: emptyAutoLaunch(),
  };
}

// A new item, with every field of its type defaulted, so the editor never has
// to reason about undefined and a half-filled item is still renderable.
export function newItem(type) {
  const spec = PLAN_TYPES[type];
  if (!spec) throw new Error(`unknown item type: ${type}`);
  const item = { id: uid(8), type, title: '', note: '' };
  for (const field of spec.fields) {
    if (field.def !== undefined) item[field.key] = field.def;
  }
  return item;
}

// What the display and the controller actually need: the library/protocol item,
// with the planner's own bookkeeping (its row id, the prep note) left behind.
// A deck's `asset` becomes a deckId at import time - see adoptPlan in control.js
// - so it is carried through rather than stripped.
export function itemForStage(item) {
  const { id: _id, note: _note, ...rest } = item;
  if (rest.type === 'image' && !rest.src && rest.path) {
    rest.src = rest.path;
  }
  return rest;
}

// `plan` is optional: on the controller there is no plan object to hand in,
// and a countdown there falls back to the label it carries.
export function itemLabel(item, plan = null) {
  if (item.title) return item.title;
  const spec = PLAN_TYPES[item.type];
  if (item.type === 'text' && item.body) return item.body.replace(/[*`#]/g, '').split('\n')[0].slice(0, 40);
  if (item.type === 'timer') {
    const timer = plan?.timers?.find((t) => t.id === item.timerId) || plan?.timers?.[0] || null;
    const name = timer?.label || item.label || '';
    if (timer) return `${timer.mins} min${name ? ` — ${name}` : ''}`;
    return name || 'Countdown';
  }
  if (item.type === 'qr' && item.caption) return item.caption;
  if (item.type === 'poll' && item.question) return item.question.split('\n')[0].slice(0, 60);
  if (item.type === 'image' && item.path && !item.src) return item.path.split('/').pop();
  if (typeof item.src === 'string' && item.src && !isAssetRef(item.src)) return item.src.split('/').pop();
  return spec?.label || item.type;
}

// Every asset id a plan's items actually reference. Anything in plan.assets
// that is not in here is dead weight from an item you deleted.
export function referencedAssets(plan) {
  const used = new Set();
  for (const item of plan.items || []) {
    for (const field of PLAN_TYPES[item.type]?.fields || []) {
      if (!field.asset) continue;
      const id = field.key === 'asset' ? item.asset : assetIdOf(item[field.key]);
      if (id) used.add(id);
    }
  }
  return used;
}

export function pruneAssets(plan) {
  const used = referencedAssets(plan);
  const assets = {};
  for (const [id, asset] of Object.entries(plan.assets || {})) {
    if (used.has(id)) assets[id] = asset;
  }
  return { ...plan, assets };
}

export function planBytes(plan) {
  // Measured on the exact bytes planToJson writes, indentation included, so the
  // number on screen is the size of the file you are about to carry rather than
  // a smaller number that is technically about the same data.
  return new TextEncoder().encode(planToJson(plan)).length;
}

export function planFileName(plan) {
  const stem = (plan.title || 'lecture').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lecture';
  return `${stem}.podium.json`;
}

export function planToJson(plan) {
  return JSON.stringify(pruneAssets({ ...plan, v: PLAN_VERSION, podium: 'plan' }), null, 2);
}

// A plan is a file that arrived from somewhere else, which makes its `src`
// values the one genuinely untrusted thing in it: they end up in an <img> or an
// <iframe> on a projector. A relative path (no scheme at all) is the common
// case and fine; anything with a scheme has to be http or https. This is what
// keeps `javascript:` out of a page nobody is standing in front of.
function safeSrc(value) {
  if (!value || isAssetRef(value)) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return true;
  return /^https?:/i.test(value);
}

const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v, def, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/**
 * Read a plan that came from outside this device - a file picker, another
 * machine, a copy edited by hand. Everything is rebuilt field by field against
 * PLAN_TYPES rather than trusted: an unknown type, a field that belongs to a
 * different type, or an asset nothing references is dropped, and the caller is
 * told what was dropped rather than left to wonder why an item vanished.
 *
 * Throws only for input that is not a plan at all. A plan with three bad items
 * and forty good ones should still load - it is ten minutes before class.
 */
export function readPlan(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_PLAN_BYTES) throw new Error('That file is too big to be a lecture plan.');
    try { data = JSON.parse(raw); } catch { throw new Error('That file is not a lecture plan (it is not even JSON).'); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('That file is not a lecture plan.');
  if (data.podium !== 'plan') throw new Error('That file is not a Podium lecture plan.');
  if (Number(data.v) > PLAN_VERSION) {
    throw new Error(`That plan was written by a newer Podium (plan format ${data.v}, this one reads ${PLAN_VERSION}). Update this device.`);
  }

  const warnings = [];
  const assets = {};
  for (const [id, asset] of Object.entries(data.assets && typeof data.assets === 'object' ? data.assets : {})) {
    const value = typeof asset?.data === 'string' ? asset.data : null;
    if (!value) { warnings.push(`Asset ${id} had no data and was dropped.`); continue; }
    if (value.length > MAX_ASSET_CHARS * 2) { warnings.push(`"${str(asset.name, 60) || id}" is too big to send to a projector and was dropped.`); continue; }
    assets[id] = { name: str(asset.name, 120), mime: str(asset.mime, 100), data: value };
  }

  // Before the items, because a countdown item names one of these.
  const timers = [];
  for (const raw3 of Array.isArray(data.timers) ? data.timers : []) {
    // A preset with no length is not a preset - clamping it up to one minute
    // would put a button on the tablet that nobody meant to be there.
    const asked = Number(raw3?.mins);
    if (!Number.isFinite(asked) || asked < 1) continue;
    // No more than the display can hold, so a plan cannot promise a clock that
    // will never exist.
    if (timers.length >= MAX_TIMERS) break;
    timers.push({ id: str(raw3.id, 40) || uid(6), label: str(raw3.label, 60), mins: Math.min(180, Math.round(asked)) });
  }

  const items = [];
  for (const raw2 of Array.isArray(data.items) ? data.items : []) {
    const spec = PLAN_TYPES[raw2?.type];
    if (!spec) { warnings.push(`An item of unknown kind "${str(raw2?.type, 30)}" was dropped.`); continue; }
    const item = { id: str(raw2.id, 40) || uid(8), type: raw2.type, title: str(raw2.title, 200), note: str(raw2.note, 2000) };
    for (const field of spec.fields) {
      const value = raw2[field.key];
      if (field.kind === 'number') item[field.key] = num(value, field.def ?? 0, field.min ?? 0, field.max ?? 1e9);
      else if (field.kind === 'check') item[field.key] = !!value;
      else if (field.kind === 'select') item[field.key] = field.options.some(([v]) => v === value) ? value : field.def;
      else if (field.kind === 'textarea') item[field.key] = str(value, 4000);
      else if (field.kind === 'timer-pick') item[field.key] = str(value, 40);
      else item[field.key] = str(value, 100000);
    }
    // A countdown pointing at a timer this plan does not define would come up
    // as somebody else's clock; fall it back to the first, which is what an
    // item with no id means anyway.
    if (item.type === 'timer' && item.timerId && !timers.some((t) => t.id === item.timerId)) {
      warnings.push(`"${itemLabel(item)}" pointed at a countdown this plan does not define; it will show the first one.`);
      item.timerId = '';
    }
    if (typeof item.src === 'string' && !safeSrc(item.src)) {
      warnings.push(`"${itemLabel(item)}" pointed at ${item.src.split(':')[0]}: — only http, https and paths on your own server are allowed.`);
      item.src = '';
    }
    // An item pointing at an asset the file does not contain would fail
    // silently on the projector, which is the worst place to find out.
    for (const field of spec.fields) {
      if (!field.asset) continue;
      const id = field.key === 'asset' ? item.asset : assetIdOf(item[field.key]);
      if (id && !assets[id]) {
        warnings.push(`"${itemLabel(item)}" refers to a file the plan does not contain; that file is missing.`);
        item[field.key] = '';
      }
    }
    items.push(item);
  }

  // Auto-launch on plan load (Issue #52)
  const rawAuto = (data.autoLaunch && typeof data.autoLaunch === 'object') ? data.autoLaunch : null;
  const autoLaunch = emptyAutoLaunch();
  if (rawAuto) {
    autoLaunch.enabled = !!rawAuto.enabled;
    autoLaunch.initialState = ['live', 'freeze', 'blank'].includes(rawAuto.initialState) ? rawAuto.initialState : 'live';

    const rawPanes = (rawAuto.panes && typeof rawAuto.panes === 'object') ? rawAuto.panes : {};
    for (const key of ['A', 'B', 'C', 'D']) {
      const p = rawPanes[key];
      if (!p || typeof p !== 'object') {
        autoLaunch.panes[key] = null;
        continue;
      }
      if (p.type === 'item' || p.itemId) {
        const itemId = str(p.itemId || p.id, 40);
        if (itemId && items.some((i) => i.id === itemId)) {
          autoLaunch.panes[key] = { type: 'item', itemId };
        } else {
          if (itemId) warnings.push(`Auto-launch pane ${key} referenced a missing item and was cleared.`);
          autoLaunch.panes[key] = null;
        }
      } else if (p.type === 'set') {
        const rawEntries = Array.isArray(p.entries) ? p.entries : [];
        const entries = [];
        for (const e of rawEntries) {
          const itemId = str(e?.itemId || e?.id, 40);
          if (itemId && items.some((i) => i.id === itemId)) {
            entries.push({
              itemId,
              seconds: Math.max(1, Math.min(3600, Math.round(Number(e?.seconds)) || 15)),
            });
          }
        }
        if (entries.length) {
          autoLaunch.panes[key] = {
            type: 'set',
            title: str(p.title, 100) || 'Automated set',
            mode: p.mode === 'random' ? 'random' : 'sequential',
            entries,
          };
        } else {
          if (rawEntries.length) warnings.push(`Auto-launch pane ${key} set had no valid items and was cleared.`);
          autoLaunch.panes[key] = null;
        }
      } else {
        autoLaunch.panes[key] = null;
      }
    }

    if (rawAuto.music && typeof rawAuto.music === 'object') {
      autoLaunch.music = {
        playlist: str(rawAuto.music.playlist, 200),
        autoplay: rawAuto.music.autoplay !== false,
        volume: num(rawAuto.music.volume, 0.5, 0, 1),
      };
    }

    if (rawAuto.timer && typeof rawAuto.timer === 'object') {
      const timerId = str(rawAuto.timer.timerId, 40);
      if (timerId && !timers.some((t) => t.id === timerId)) {
        warnings.push(`Auto-launch countdown pointed at a timer this plan does not define and was cleared.`);
        autoLaunch.timer = { timerId: '' };
      } else {
        autoLaunch.timer = { timerId };
      }
    }
  }

  const plan = {
    podium: 'plan',
    v: PLAN_VERSION,
    id: str(data.id, 40) || uid(10),
    title: str(data.title, 200) || 'Untitled lecture',
    course: str(data.course, 120),
    notes: str(data.notes, 4000),
    created: Number(data.created) || Date.now(),
    updated: Number(data.updated) || Date.now(),
    layout: ['single', '2h', '2v', '3', '4'].includes(data.layout) ? data.layout : 'single',
    items,
    timers,
    assets,
    autoLaunch,
  };
  return { plan: pruneAssets(plan), warnings };
}
