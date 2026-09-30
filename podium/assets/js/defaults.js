// Saved controller defaults (Issue #173).
//
// A few Music, Mixer and Say-tab controls are set the same way at the start of
// nearly every lecture. Settings -> Presentation -> "Start every lecture with"
// lets this device remember them, and they are applied:
//
//   - once when the controller is opened in a new tab and first finds a
//     display - the same moment "Black out the screen when this controller
//     connects" fires, for the same reasons (never on a reconnect, a reload,
//     or closing Settings); and
//   - again after any lecture plan is loaded, so they win over a plan's own
//     music settings; and
//   - for whatever was changed, when Settings closes (Issue #178) - see
//     changedDefaultCommands. Auto-play and the caption box, which nothing
//     else keeps, are also set from them on every load of the page.
//
// Every default is opt-in. A music switch left on "Plan / as is" and an unset
// mixer or watermark change nothing, so a device that never opens this section
// behaves exactly as it always has - including a plan's own Auto-play and
// music level.
//
// What each one does when set:
//   Auto-play, End of queue, Countdown text - this controller's own Music tab
//     controls (they are read when you load a playlist or put up "We begin
//     in…"); Auto-play also overrides a plan's auto-launched music.
//   Pause Queue, Mixer levels - room state, sent to the display.
//   Caption - pre-filled in the Say tab, never shown until you press Show.
//   Watermark - put up, unless the presenter already set one of their own in
//     this lecture. A course's default watermark (Issue #157) is not the
//     presenter's own, so this one replaces it; nor is one an earlier default
//     put up (marked fromDefault), so a changed default replaces that too.
//
// Per device, like the rest of Settings -> Presentation: nothing here is
// shared with other controllers or written into the room.

export const DEFAULTS_KEY = 'podium.defaults.v1';

export const EMPTY_DEFAULTS = Object.freeze({
  music: { autoplay: null, pauseQueue: null, untilQueue: null, countdownText: '' },
  mixer: { enabled: false, master: 0.8, content: 1, music: 0.6, mic: 1 },
  caption: '',
  watermark: { enabled: false, text: '', position: 'br', imageId: '', imageData: '' },
});

const tri = (v) => (v === true || v === false ? v : null);
const level = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

/** Whatever was stored (or nothing), made into a complete, valid defaults object. */
export function normalizeDefaults(raw, maxImageChars = 200000) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const music = src.music && typeof src.music === 'object' ? src.music : {};
  const mixer = src.mixer && typeof src.mixer === 'object' ? src.mixer : {};
  const wm = src.watermark && typeof src.watermark === 'object' ? src.watermark : {};
  const base = EMPTY_DEFAULTS;
  const imageData = typeof wm.imageData === 'string' && wm.imageData.startsWith('data:image/')
    && wm.imageData.length <= maxImageChars ? wm.imageData : '';
  return {
    music: {
      autoplay: tri(music.autoplay),
      pauseQueue: tri(music.pauseQueue),
      untilQueue: tri(music.untilQueue),
      countdownText: String(music.countdownText || '').slice(0, 80),
    },
    mixer: {
      enabled: !!mixer.enabled,
      master: level(mixer.master, base.mixer.master),
      content: level(mixer.content, base.mixer.content),
      music: level(mixer.music, base.mixer.music),
      mic: level(mixer.mic, base.mixer.mic),
    },
    caption: String(src.caption || '').slice(0, 200),
    watermark: {
      enabled: !!wm.enabled,
      text: String(wm.text || '').slice(0, 120),
      position: wm.position === 'tl' ? 'tl' : 'br',
      imageId: imageData ? String(wm.imageId || '').slice(0, 40) : '',
      imageData,
    },
  };
}

export function loadDefaults(storage = globalThis.localStorage) {
  try { return normalizeDefaults(JSON.parse(storage.getItem(DEFAULTS_KEY) || 'null')); }
  catch { return normalizeDefaults(null); }
}

/** True when a saved default watermark has anything to show. */
export function watermarkDefaultReady(defaults) {
  const wm = defaults?.watermark;
  return !!(wm?.enabled && (wm.text || (wm.imageId && wm.imageData)));
}

/**
 * The room commands a set of defaults turns into, given the room's state as
 * this controller last heard it. Pure, so the rules are testable without a
 * display: the caller sends these (and, for a logo, puts its bytes in the
 * asset store under `imageId` first - see `assetRef`).
 *
 * @param {object} defaults - normalizeDefaults() output
 * @param {object} state - the room's state
 * @param {object} opts
 * @param {Function} opts.assetRef - id -> the `asset:<id>` reference items carry
 * @param {boolean} [opts.afterPlan] - applying after a plan loaded rather than
 *   on first connect. The watermark is left alone then: plans never set one,
 *   and re-asserting it on every plan load would put back one the presenter
 *   deliberately took down earlier in the same lecture.
 * @returns {object[]}
 */
export function defaultCommands(defaults, state, { assetRef, afterPlan = false } = {}) {
  const d = normalizeDefaults(defaults);
  const out = [];
  if (d.music.pauseQueue !== null) out.push({ op: 'music', action: 'pauseQueue', value: d.music.pauseQueue });
  if (d.mixer.enabled) {
    out.push({ op: 'volume', value: d.mixer.master });
    out.push({ op: 'contentVolume', value: d.mixer.content });
    out.push({ op: 'music', action: 'volume', value: d.mixer.music });
    out.push({ op: 'micVolume', value: d.mixer.mic });
  }
  if (!afterPlan && watermarkDefaultReady(d) && !presenterOwnsWatermark(state)) {
    out.push(watermarkCommand(d, assetRef));
  }
  return out;
}

// The presenter's own watermark for this lecture wins. A course default
// (fromCourse) is not the presenter's own, and neither is one a saved default
// put up (fromDefault, Issue #178): the display keeps its watermark from one
// lecture to the next, so without that flag the default put up last week
// counted as "the presenter's own" this week and a changed default never
// reached the screen again.
function presenterOwnsWatermark(state) {
  const current = state?.watermark || {};
  return !!(current.enabled && !current.fromCourse && !current.fromDefault && (current.text || current.image));
}

function watermarkCommand(d, assetRef) {
  const image = d.watermark.imageId && d.watermark.imageData && assetRef ? assetRef(d.watermark.imageId) : '';
  return { op: 'watermark', text: d.watermark.text, image, position: d.watermark.position, enabled: true, fromDefault: true };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Which defaults differ between two sets (Issue #178). Settings no longer
 * reloads the controller when it closes, so what was changed in it is applied
 * then - just those parts, not the whole set again.
 */
export function defaultsDelta(before, after) {
  const a = normalizeDefaults(before, Infinity);
  const b = normalizeDefaults(after, Infinity);
  const delta = {
    autoplay: a.music.autoplay !== b.music.autoplay,
    pauseQueue: a.music.pauseQueue !== b.music.pauseQueue,
    untilQueue: a.music.untilQueue !== b.music.untilQueue,
    countdownText: a.music.countdownText !== b.music.countdownText,
    mixer: !same(a.mixer, b.mixer),
    caption: a.caption !== b.caption,
    watermark: !same(a.watermark, b.watermark),
  };
  delta.any = Object.values(delta).some(Boolean);
  return delta;
}

/**
 * The room commands for defaults changed in Settings mid-lecture (Issue #178).
 * Only what changed, and only what the new value asks for: switching a music
 * default back to "Plan / as is" or the mixer off leaves the room as it is.
 *
 * The watermark follows the first-connect rule - the presenter's own wins -
 * with one addition: turning the default watermark off takes down the one it
 * put up, and nothing else.
 */
export function changedDefaultCommands(before, after, state, { assetRef } = {}) {
  const a = normalizeDefaults(before, Infinity);
  const d = normalizeDefaults(after, Infinity);
  const delta = defaultsDelta(a, d);
  const out = [];
  if (delta.pauseQueue && d.music.pauseQueue !== null) out.push({ op: 'music', action: 'pauseQueue', value: d.music.pauseQueue });
  if (delta.mixer && d.mixer.enabled) {
    out.push({ op: 'volume', value: d.mixer.master });
    out.push({ op: 'contentVolume', value: d.mixer.content });
    out.push({ op: 'music', action: 'volume', value: d.mixer.music });
    out.push({ op: 'micVolume', value: d.mixer.mic });
  }
  if (delta.watermark) {
    const current = state?.watermark || {};
    if (watermarkDefaultReady(d)) {
      if (!presenterOwnsWatermark(state)) out.push(watermarkCommand(d, assetRef));
    } else if (current.enabled && current.fromDefault) {
      out.push({ op: 'watermark', enabled: false });
    }
  }
  return out;
}

/**
 * The Settings -> Presentation section that edits the defaults.
 *
 * @param {object} deps
 * @param {Function} deps.$ - control.js's querySelector helper
 * @param {Function} deps.uid - random id generator, for a newly chosen logo
 * @param {Function} deps.downscaleImage - shrinks an uploaded file to a data URL
 * @param {number} deps.MAX_ASSET_CHARS - the cap every uploaded asset is held to
 * @param {Function} deps.save - (defaults) => void, persists them
 * @param {Function} deps.getState - () => the room's state, for "use what is set now"
 * @param {Function} deps.getMusicTab - () => { autoplay, untilQueue, countdownText }
 *   as the Music tab currently has them, for "use what is set now"
 */
export function createDefaultsPanel({ $, uid, downscaleImage, MAX_ASSET_CHARS, save, getState, getMusicTab, initial }) {
  let d = normalizeDefaults(initial, MAX_ASSET_CHARS);
  const triValue = (v) => (v === null ? '' : v ? 'on' : 'off');
  const readTri = (value) => (value === 'on' ? true : value === 'off' ? false : null);
  const pct = (v) => `${Math.round(v * 100)}%`;

  function commit() {
    d = normalizeDefaults(d, MAX_ASSET_CHARS);
    save(d);
    render();
  }

  function render() {
    $('#def-autoplay').value = triValue(d.music.autoplay);
    $('#def-pause-queue').value = triValue(d.music.pauseQueue);
    $('#def-until-queue').value = triValue(d.music.untilQueue);
    if (document.activeElement !== $('#def-countdown-text')) $('#def-countdown-text').value = d.music.countdownText;
    $('#def-mixer-on').checked = d.mixer.enabled;
    for (const ch of ['master', 'content', 'music', 'mic']) {
      $(`#def-mix-${ch}`).value = String(d.mixer[ch]);
      $(`#def-mix-${ch}-pct`).textContent = pct(d.mixer[ch]);
      $(`#def-mix-${ch}`).disabled = !d.mixer.enabled;
    }
    if (document.activeElement !== $('#def-caption')) $('#def-caption').value = d.caption;
    $('#def-wm-on').checked = d.watermark.enabled;
    if (document.activeElement !== $('#def-wm-text')) $('#def-wm-text').value = d.watermark.text;
    $('#def-wm-position').value = d.watermark.position;
    $('#def-wm-image-clear').hidden = !d.watermark.imageData;
    const thumb = $('#def-wm-thumb');
    thumb.hidden = !d.watermark.imageData;
    if (d.watermark.imageData) thumb.src = d.watermark.imageData;
    else thumb.removeAttribute('src');
  }

  $('#def-autoplay').addEventListener('change', (ev) => { d.music.autoplay = readTri(ev.target.value); commit(); });
  $('#def-pause-queue').addEventListener('change', (ev) => { d.music.pauseQueue = readTri(ev.target.value); commit(); });
  $('#def-until-queue').addEventListener('change', (ev) => { d.music.untilQueue = readTri(ev.target.value); commit(); });
  // Text boxes save as they are typed, not on 'change' (Issue #178): 'change'
  // waits for the box to lose focus, and tapping Close on a tablet does not
  // always take it away first - which is how a typed watermark was lost.
  $('#def-countdown-text').addEventListener('input', (ev) => { d.music.countdownText = ev.target.value.trim(); commit(); });
  $('#def-mixer-on').addEventListener('change', (ev) => { d.mixer.enabled = ev.target.checked; commit(); });
  for (const ch of ['master', 'content', 'music', 'mic']) {
    $(`#def-mix-${ch}`).addEventListener('input', (ev) => { $(`#def-mix-${ch}-pct`).textContent = pct(Number(ev.target.value)); });
    $(`#def-mix-${ch}`).addEventListener('change', (ev) => { d.mixer[ch] = Number(ev.target.value); commit(); });
  }
  $('#def-caption').addEventListener('input', (ev) => { d.caption = ev.target.value.trim(); commit(); });
  $('#def-wm-on').addEventListener('change', (ev) => { d.watermark.enabled = ev.target.checked; commit(); });
  // Giving a watermark its first text or logo ticks "Put up my watermark" as
  // well (Issue #178): typing one in and finding it never went up, because a
  // separate box was left unticked, reads as the setting not working. Only the
  // first time - one ticked off on purpose stays off while it is edited.
  const firstWatermark = () => !d.watermark.text && !d.watermark.imageData;
  $('#def-wm-text').addEventListener('input', (ev) => {
    const text = ev.target.value.trim();
    if (text && firstWatermark()) d.watermark.enabled = true;
    d.watermark.text = text;
    commit();
  });
  $('#def-wm-position').addEventListener('change', (ev) => { d.watermark.position = ev.target.value; commit(); });
  $('#def-wm-image').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    const note = $('#def-note');
    note.textContent = `Resizing ${file.name}…`;
    try {
      // The same PNG ladder the Say tab's own logo upload uses, so
      // transparency survives and it fits a relay message.
      const shrunk = await downscaleImage(file, MAX_ASSET_CHARS, { widths: [480, 320, 200, 120], qualities: [1], mime: 'image/png' });
      if (firstWatermark()) d.watermark.enabled = true;
      d.watermark.imageData = shrunk.dataUrl;
      d.watermark.imageId = `wmdef-${uid(8)}`;
      note.textContent = 'Logo saved as your default.';
      commit();
    } catch (err) {
      note.textContent = `That did not load: ${err.message}`;
    }
  });
  $('#def-wm-image-clear').addEventListener('click', () => {
    d.watermark.imageData = '';
    d.watermark.imageId = '';
    commit();
  });

  // "Use what is set now": copy the live Mixer levels, and this tab's own
  // Music switches, rather than making anyone set every slider twice.
  $('#def-mixer-capture').addEventListener('click', () => {
    const s = getState();
    d.mixer = {
      enabled: true,
      master: s.volume ?? d.mixer.master,
      content: s.contentVolume ?? d.mixer.content,
      music: s.music?.volume ?? d.mixer.music,
      mic: s.micVolume ?? d.mixer.mic,
    };
    $('#def-note').textContent = 'Saved the Mixer levels as they are now.';
    commit();
  });
  $('#def-music-capture').addEventListener('click', () => {
    const m = getMusicTab();
    const s = getState();
    d.music = {
      autoplay: !!m.autoplay,
      pauseQueue: !!s.music?.pauseQueue,
      untilQueue: !!m.untilQueue,
      countdownText: m.countdownText || '',
    };
    $('#def-note').textContent = 'Saved the Music tab’s switches as they are now.';
    commit();
  });
  $('#def-clear-all').addEventListener('click', () => {
    d = normalizeDefaults(null);
    $('#def-note').textContent = 'Cleared. Nothing is applied at the start of a lecture.';
    commit();
  });

  render();
  return { render, get: () => d };
}
