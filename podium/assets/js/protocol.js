// The shared state document and the rules for changing it.
//
// The display owns exactly one state object. Controllers never mutate anything
// locally: they send commands, the display applies them here and broadcasts the
// result, and every controller renders from that echo. Two controllers stay in
// sync for free, and a controller that joins mid-lecture is caught up by the
// next heartbeat.
//
// This is also what makes FREEZE trivial. The display only ever changes when a
// command tells it to, so "hold what is on screen" is just routing incoming
// content to `preview` instead of `program`.

// Bumped on every release. The display and the controller are separate
// devices loading their own copy of this file from your server, so one of
// them can easily be running last week's code - a browser that never
// revalidated the page, or a machine whose projector tab has been open
// since before you deployed. That does not look like a stale page; it looks
// like a bug, and it has cost real debugging time twice over.
//
// A plain increasing integer rather than a date, so "which of these two is
// behind" is answerable rather than merely "these differ". Three things
// compare against it: each page checks itself against the copy the server is
// serving right now (see servedBuild in util.js), the controller checks the
// display's, and both show it on screen so you can read it off directly.
import { ZOOM_MAX } from './zoom.js';

export const BUILD = 116;

// The release this is, as a person would say it out loud - what goes in a bug
// report, what an administrator answers when asked what they are running.
// BUILD above answers a different question, and the two are not
// interchangeable: BUILD says "is this tab's copy of the code the same one
// the server is handing out", which needs to change on every deploy and is
// meaningless to anybody not chasing a stale cache. VERSION says "which
// release of Podium is this", and moves only when there is something worth
// calling a new release.
//
// Kept here, beside BUILD, because this is already the file every page and
// the server itself read for the build (see servedBuild in util.js and
// SERVED_BUILD in podium-server.js) - a second file to hold a version string
// is a second file to forget to bump.
export const VERSION = '1.2';
export const COMMIT = '33dcf2d';

export function versionStamp() {
  return `v${VERSION} · build ${BUILD}${COMMIT ? ` · ${COMMIT}` : ''}`;
}

export const BLACK = { type: 'black', title: 'Black' };

// Panels A-D: program plus state.panels' three.
export const PANEL_COUNT = 4;

// How many panels each layout actually shows - panel A (state.program) is
// always the first of them; B/C/D come from state.panels[0..2].
export const LAYOUTS = {
  single: 1,
  '2h': 2,   // side by side
  '2v': 2,   // top and bottom
  3: 3,      // A large on one side, B/C stacked on the other
  4: 4,      // A/B/C/D tiled 2x2
  // Picture-in-picture (Issue #110): one pane full screen, another as a
  // small bordered inset over a corner of it - which two, out of the same
  // up-to-four independently staged panes every other layout already
  // offers, is state.pip's own choice (see initialState), not fixed by
  // position the way B/C/D are under every other layout. 4, not 2: a pane
  // not currently chosen as main or inset stays staged and reachable
  // (still addressable by focus, still ready the instant PiP picks it),
  // the same as an unfocused tab rather than emptied out.
  pip: 4,
};

export const MAX_TIMERS = 4;

// Background music. A queue longer than this is a library, not a lecture's
// worth of music, and the whole queue rides in every heartbeat.
export const MAX_TRACKS = 100;
export const MUSIC_FADE_IN_MS = 2500;
export const MUSIC_FADE_OUT_MS = 3000;
// A pause is a different gesture from a fade: it should feel like pressing a
// button, not like a decision. Short enough to read as immediate, long enough
// not to click.
export const MUSIC_PAUSE_MS = 400;
// What the music drops to while a clip with its own sound is on screen:
// a fifth of its level, under the clip but still there.
export const MUSIC_DUCK = 0.2;
export const MUSIC_DUCK_MS = 600;

// An automated set that rotates on its own: a QR code, a photo, a text sign,
// each held for its own number of seconds, sequential or shuffled. Modelled
// as an item like any other - staged onto a panel with `stage`/`panel` the
// normal way - so freeze/cue/take and B/C/D's direct-set both already work
// for it without a line of special-casing. Only advancing itself, and the
// handful of things you do to a running one (jump, pause, resume), are new.
export const MAX_SET_ENTRIES = 50;
export const SET_TICK_MS = 500;

// A picture deck's slide count cap (Issue #106): generous for a real lecture,
// and a bound on how much every state broadcast has to carry.
export const MAX_IMAGEDECK_SLIDES = 500;

let timerSeq = 1;

export function newTimer(id, label = '', seconds = 0) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  return {
    id: id || `t${++timerSeq}`,
    label: String(label || '').slice(0, 80),
    running: false,
    endsAt: 0,
    remainingMs: ms,
    mode: 'countdown',
  };
}

/**
 * The timer an item (or a command) is talking about.
 *
 * Falls back to the first rather than to nothing: an item that predates
 * multiple timers, or one created by tapping "Timer" in the library, carries no
 * id at all, and "the countdown" is what the presenter means by it.
 */
export function timerById(state, id) {
  if (!state?.timers?.length) return null;
  return (id && state.timers.find((t) => t.id === id)) || state.timers[0];
}

export function initialState() {
  return {
    rev: 0,
    armed: false,          // has someone clicked "Go live" on the display yet
    // The id of the session record this lecture is being written into, on a
    // server-backed deployment, and null everywhere else - which is every
    // other way of running Podium, so nothing may depend on it existing. The
    // display owns it (it is the device that starts and ends a lecture) and
    // broadcasts it here so that a controller ending a poll knows which
    // lecture the tally belongs under. See server/lectures.js.
    lectureId: null,
    program: { ...BLACK },
    preview: null,
    // The layout's own cue, on the same principle as preview above: while
    // frozen, a layout change is a change to what the room is about to see
    // (fewer or differently-arranged panels), not to what it is looking at
    // right now, so it waits for TAKE exactly like a content pick does.
    previewLayout: null,
    frozen: false,          // hold the program layer; new picks land in preview
    blank: false,           // hard cut to black, keeps program loaded underneath
    // Issue #183: photograph a marked-up screen as it is left (see
    // inkCapturesFor). Room state rather than a device preference because the
    // display is the one that has to do it, at the instant it switches away.
    autoSaveInk: false,
    previewMode: false,     // always cue before going live, even when not frozen
    // `volume` is the room's master fader - it scales BOTH channels below it
    // together (see musicTarget() and syncLayers() in display.js), the one
    // knob for "everything is too loud" that needs no tab switch to reach.
    // `contentVolume` is the Mixer's own per-channel level for whatever is
    // playing on a panel (a video, audio, YouTube) - music has the same kind
    // of channel level already, in `music.volume` below, unrelated to this
    // one. A channel at 1 and the master at 0.5 sounds the same as a channel
    // at 0.5 and the master at 1 - the master is what one slider on the
    // bottom bar can reach without a tab switch, the channels are what the
    // Mixer tab is for setting once and mostly leaving alone.
    volume: 0.8,
    contentVolume: 1,
    // A controller's own mic (Issue #147), amplified through the display -
    // its own channel for the same reason content and music have theirs,
    // set once in the Mixer and mostly left alone. Every connected mic
    // shares this one level; there is no per-presenter fader.
    micVolume: 1,
    muted: false,
    // `live` is true while a device's speech recognition is actively
    // feeding this bar (Issue #79) - see the 'caption' op below. It rides
    // along with text/visible rather than living apart from them so a
    // display reload restores it (see restoreState in display.js) and
    // caption updates keep being honored afterward, exactly like the rest
    // of what that restore preserves.
    overlay: { text: '', visible: false, live: false },
    // More than one countdown, because a class often has more than one clock
    // running: eight minutes of group work inside a ninety-minute session, a
    // five-minute break with its own end. Each is independent, and a `timer`
    // item names which one it shows (see timerById), so two panels can show two
    // different clocks at once. The first always exists - "the timer" with no
    // further thought is the common case and must not need setting up.
    timers: [newTimer('t1')],
    // Ink is scoped per "surface" (see inkSurfaceKey) rather than one global
    // sheet: a whiteboard keeps its own drawing, each deck slide keeps its own,
    // and switching to something else (a timer, a message) shows a blank
    // surface instead of carrying old strokes onto unrelated content.
    ink: { color: '#ffd166', width: 6, bySurface: {} },
    telemetry: { time: 0, duration: 0, playing: false },
    // Splitting the screen (project slides + a countdown + instructions, say)
    // is deliberately a separate, simpler world from panel A's freeze/cue/
    // take: B/C/D are set directly and immediately, with no preview to cue
    // into first - you are laying out a screen, not revealing something at
    // a moment the class is watching. `layout` picks how many of them show
    // and how they are arranged (see LAYOUTS); `panels` holds B/C/D's own
    // content, same shape as `program`. `focus` (0=A, 1=B, 2=C, 3=D) is
    // which one Next/Prev, thumbnails, transport, and Ink currently address -
    // shared state so every controller agrees on which panel a bare "Next"
    // means, the same reason program/preview are shared rather than local.
    layout: 'single',
    panels: [{ ...BLACK }, { ...BLACK }, { ...BLACK }],
    focus: 0,
    // Music is deliberately NOT a panel. What plays before class is not
    // content the room is looking at - it is a thing the room can hear while
    // the screen shows whatever it shows - so it lives beside the panels
    // rather than in one, survives every pick, freeze and blank, and never
    // puts anything on the projector. `fadeMs` is how long the display should
    // take over the next change in `playing`: a quick dip for a pause, three
    // unhurried seconds for the "class is starting" fade.
    music: { tracks: [], index: 0, playing: false, volume: 0.6, fadeMs: MUSIC_FADE_OUT_MS, playlist: '', pauseQueue: false, seekTo: 0, seekNonce: 0 },
    // A name or a logo pinned to one corner for the whole lecture - the thing
    // that should be IN a screen grab, not something you pick and lose the
    // next time you change what is on screen. So it lives beside program and
    // panels rather than inside any of them, the same reason music does.
    // `fromCourse` (Issue #157): this is the course's default, put here by the
    // display when a new lecture started - not something the presenter chose.
    // The next new lecture replaces a course default with ITS course's one,
    // and never touches a watermark the presenter set (see applyCourseBranding
    // in display.js). `fromDefault` (Issue #178): put here by a controller's
    // saved "Start every lecture with" default, which is not the presenter's
    // own either - a changed default replaces it.
    watermark: { enabled: false, text: '', image: '', position: 'br', fromCourse: false, fromDefault: false },
    // Picture-in-picture's own configuration (Issue #110) - independent of
    // `layout` the same way watermark is independent of what is on screen,
    // so switching away from the 'pip' layout and back does not lose the
    // choice. `main`/`inset` are 'A'-'D', always two DIFFERENT panes (see
    // the 'pip' case below); `corner` is where the inset sits; `size` is
    // its side length as a percentage of the stage, in each dimension.
    pip: { main: 'A', inset: 'B', corner: 'tr', size: 20 },
    // The deck each panel (A-D) last showed, once something else replaced it
    // (Issue #216) - so the Slides tab can keep it up for reference while a
    // video plays, and put it back at the slide you left. Cleared when that
    // panel gets a different deck (or the same one again), and with the
    // session; see rememberDecks below.
    recall: [null, null, null, null],
  };
}

// The item `focus` currently points at - state.program for focus 0 (never
// the frozen preview: ink/nav/transport all address what is actually on
// screen, exactly like today when there is only one panel), or state.panels
// for 1/2/3. Returns null for an out-of-range focus rather than throwing, so
// a stale focus from a layout that has since shrunk fails safe.
/**
 * Whether panel `index` (0=A .. 3=D) is part of what the room sees in the
 * current layout. Picture-in-picture shows only its main and inset panes.
 */
export function panelOnScreen(state, index) {
  if (state.layout === 'pip') return [state.pip?.main, state.pip?.inset].includes('ABCD'[index]);
  return index < (LAYOUTS[state.layout] || 1);
}

export function focusedItem(state) {
  if (state.focus === 0) return state.program;
  return state.panels[state.focus - 1] || null;
}

// What the controller's own views and tools address (Issue #174): the cued
// item while panel A is frozen with something cued, otherwise whatever has
// focus. Freeze is "hold what the room sees", not "stop working" - the Slides
// tab, deck navigation and the ink pad follow the cue so a deck opened while
// frozen can actually be looked at, paged through and marked up before TAKE.
// Media transport deliberately keeps using focusedItem: the room already hears
// whatever is playing, frozen or not (see resolveVisualTarget).
export function workingItem(state) {
  if (state.focus === 0 && state.frozen && state.preview) return state.preview;
  return focusedItem(state);
}

// --- held ink (Issue #174) ---------------------------------------------------
//
// Ink drawn on panel A while frozen is held like the cue: kept on a surface of
// its own, keyed HELD_INK_PREFIX + the real surface, which nothing on the
// display ever renders (the projector, a second display and Guest View all
// draw inkSurfaceKey(item), never a held key). TAKE merges every held surface
// into its real one, so the room sees it all at once; Clear cue throws it
// away. Unfreezing without TAKE leaves it waiting, exactly like a cued item.
// B/C/D are never frozen (see 'panel' below), so their ink stays live.
export const HELD_INK_PREFIX = 'held:';
export const isHeldInkKey = (key) => typeof key === 'string' && key.startsWith(HELD_INK_PREFIX);

/** The ink surface the next stroke lands on. */
export function inkTargetKey(state) {
  const key = inkSurfaceKey(workingItem(state));
  return state.focus === 0 && state.frozen ? HELD_INK_PREFIX + key : key;
}

/** How many held surfaces actually have strokes waiting on them. */
export function heldInkCount(ink) {
  let n = 0;
  for (const [key, surface] of Object.entries(ink?.bySurface || {})) {
    if (isHeldInkKey(key) && surface?.strokes?.length) n += 1;
  }
  return n;
}

function commitHeldInk(ink) {
  for (const key of Object.keys(ink.bySurface)) {
    if (!isHeldInkKey(key)) continue;
    const held = ink.bySurface[key];
    delete ink.bySurface[key];
    if (!held?.strokes?.length) continue;
    const surface = touchSurface(ink, key.slice(HELD_INK_PREFIX.length));
    surface.strokes.push(...held.strokes);
    if (surface.strokes.length > MAX_STROKES_PER_SURFACE) {
      surface.strokes.splice(0, surface.strokes.length - MAX_STROKES_PER_SURFACE);
    }
  }
}

function discardHeldInk(ink) {
  for (const key of Object.keys(ink.bySurface)) if (isHeldInkKey(key)) delete ink.bySurface[key];
}

// Where a newly picked item should land.
export function stageTarget(state, where = 'auto') {
  if (where === 'program' || where === 'preview') return where;
  return state.frozen || state.previewMode ? 'preview' : 'program';
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

// Every staged item gets an identity. The display keeps two content layers and
// matches them to the program/preview items by key, so TAKE is a change of
// which layer is on screen rather than a rebuild - the cued iframe or video
// keeps the exact scroll position and playhead you set up in preview.
let keySeq = 0;
const nextKey = () => `k${Date.now().toString(36)}${(keySeq++).toString(36)}`;

// --- live streams (Issue #175) -----------------------------------------------
//
// A stream item names a Twitch channel or a YouTube live broadcast (a video
// id, or a channel id whose current broadcast is shown), and how much of it
// the room gets: 'both', 'video' (always muted) or 'audio' (the player keeps
// playing behind a card that says what is on). Anything a presenter might
// paste is accepted and read here, once, so a plan item, a manifest tile and
// a pasted link all end up as the same few fields.
export const STREAM_SHOWS = ['both', 'video', 'audio'];
const TWITCH_RESERVED = new Set(['videos', 'directory', 'p', 'settings', 'downloads', 'jobs', 'search', 'login', 'signup', 'subscriptions', 'inventory', 'wallet']);

/**
 * Read a stream out of whatever was typed or pasted.
 * @param {string} raw - a URL, or a bare Twitch channel / YouTube id
 * @param {string} [platform] - 'twitch' | 'youtube', to read a bare name
 * @returns {{platform: string, channel?: string, videoId?: string}|null}
 */
export function parseStreamSource(raw, platform = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  const twitch = text.match(/^(?:https?:\/\/)?(?:www\.|m\.|player\.)?twitch\.tv\/(?:popout\/)?([A-Za-z0-9_]{2,25})(?:[/?#]|$)/i);
  if (twitch && !TWITCH_RESERVED.has(twitch[1].toLowerCase())) return { platform: 'twitch', channel: twitch[1].toLowerCase() };
  const channelParam = text.match(/^(?:https?:\/\/)?player\.twitch\.tv\/\?(?:.*&)?channel=([A-Za-z0-9_]{2,25})/i);
  if (channelParam) return { platform: 'twitch', channel: channelParam[1].toLowerCase() };
  const ytChannel = text.match(/youtube\.com\/(?:channel\/|embed\/live_stream\?channel=)(UC[\w-]{22})/);
  if (ytChannel) return { platform: 'youtube', channel: ytChannel[1] };
  const ytVideo = text.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|embed\/)|youtu\.be\/)([\w-]{11})(?![\w-])/);
  if (ytVideo) return { platform: 'youtube', videoId: ytVideo[1] };
  if (/^UC[\w-]{22}$/.test(text)) return { platform: 'youtube', channel: text };
  if (platform === 'youtube' && /^[\w-]{11}$/.test(text)) return { platform: 'youtube', videoId: text };
  if (platform !== 'youtube' && /^[A-Za-z0-9_]{2,25}$/.test(text)) return { platform: 'twitch', channel: text.toLowerCase() };
  return null;
}

/** "twitch.tv/name" or "YouTube Live", for titles and cards. */
export function streamLabel(item) {
  if (item?.platform === 'twitch') return `twitch.tv/${item.channel || '?'}`;
  return 'YouTube Live';
}

// --- markdown documents (Issue #240) --------------------------------------------
//
// A document is laid out at one fixed width and scaled to every screen, so a
// position in it - `at`, the y of the top of what the room sees - is in the
// page's own pixels and means the same on the display, a controller's mirror
// and a Quick Look tab. One screenful is 16:9 of that width; Next and Previous
// move most of one. See doc.js for the page itself.
export const DOC_WIDTH = 1280;
export const DOC_VIEW = 720;
export const DOC_STEP = 0.85;
const MAX_DOC_HEIGHT = 2000000;

/** The furthest a document can be scrolled: its last screenful. */
export const docMaxAt = (height) => Math.max(0, Math.round((Number(height) || 0) - DOC_VIEW));

/** A position, held to the page. */
export const clampDocAt = (at, height) => Math.min(docMaxAt(height), Math.max(0, Math.round(Number(at) || 0)));

function normalizeItem(item) {
  if (!item || typeof item !== 'object' || !item.type) return null;
  const copy = { ...item, key: nextKey() };
  // Issue #154: cross-cutting, like the type-specific caps below - a plan
  // item's own bookkeeping fields never reached here unfiltered before this
  // existed, and this one is no different.
  copy.overlayCaption = typeof copy.overlayCaption === 'string' ? copy.overlayCaption.slice(0, 500) : '';
  if (copy.type === 'text') {
    // Issue #103: headings/body, bulleted/numbered lists (miniMarkdown in
    // util.js), a background colour, a font choice, and an optional inline
    // picture with a caption. `src` is left alone - it is `''`, a path, or
    // an `asset:<id>` reference, the exact convention every other item
    // type's picture already uses, and it is what makes stage()'s own
    // pushAssetIfHeld(clean.src) and resolveAssets() work for this picture
    // with no changes to either.
    copy.body = String(copy.body || '').slice(0, 4000);
    copy.size = ['s', 'm', 'l', 'xl'].includes(copy.size) ? copy.size : 'l';
    copy.align = copy.align === 'left' ? 'left' : 'center';
    copy.bg = String(copy.bg || '').slice(0, 64);
    // Issue #222: the words' own colour, beside the background's. A hex
    // colour or nothing (the renderer's default) - it ends up in a style.
    copy.color = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(copy.color || '') ? copy.color : '';
    copy.font = ['serif', 'mono', 'rounded', 'display'].includes(copy.font) ? copy.font : 'sans';
    copy.caption = String(copy.caption || '').slice(0, 200);
  }
  if (copy.type === 'video' || copy.type === 'audio' || copy.type === 'youtube' || copy.type === 'stream') {
    copy.playing = copy.playing ?? true;
    copy.startAt = Number(copy.startAt) || 0;
  }
  if (copy.type === 'stream') {
    // Issue #175: read whatever was given - a planner's `url`, a manifest
    // tile's `src`, or fields already split out - into platform + one id.
    const parsed = (copy.channel || copy.videoId)
      ? parseStreamSource(copy.platform === 'youtube' ? (copy.videoId || copy.channel) : copy.channel, copy.platform)
      : parseStreamSource(copy.url || copy.src, copy.platform);
    if (!parsed) return null;
    copy.platform = parsed.platform;
    copy.channel = parsed.channel || '';
    copy.videoId = parsed.videoId || '';
    delete copy.url;
    delete copy.src;
    copy.show = STREAM_SHOWS.includes(copy.show) ? copy.show : 'both';
    copy.title = String(copy.title || streamLabel(copy)).slice(0, 120);
  }
  // Issue #113: every field PLAN_TYPES declares for these types used to pass
  // through normalizeItem completely unvalidated - unlike text.body/caption
  // above, an oversized or malformed value here reached every connected
  // controller and the projector unfiltered. `image.src`/`text.src` are the
  // one deliberate exception (see the comment on the 'text' branch above);
  // everything else gets the same length caps and enum checks text's own
  // fields already have.
  if (copy.type === 'youtube') copy.videoId = String(copy.videoId || '').slice(0, 64);
  if (copy.type === 'image') {
    copy.fit = copy.fit === 'cover' ? 'cover' : 'contain';
    // Issue #262: a photo zooms on the projector like a PDF page does.
    copy.zoom = Math.min(ZOOM_MAX, Math.max(1, Number(copy.zoom) || 1));
    copy.panX = Number.isFinite(copy.panX) ? copy.panX : 0.5;
    copy.panY = Number.isFinite(copy.panY) ? copy.panY : 0.5;
  }
  if (copy.type === 'qr') {
    copy.data = String(copy.data || '').slice(0, 2000);
    copy.caption = String(copy.caption || '').slice(0, 200);
  }
  if (copy.type === 'web') copy.src = String(copy.src || '').slice(0, 2000);
  if (copy.type === 'whiteboard') copy.bg = String(copy.bg || '').slice(0, 64);
  if (copy.type === 'timer') {
    copy.timerId = String(copy.timerId || '').slice(0, 64);
    copy.label = String(copy.label || '').slice(0, 120);
  }
  if (copy.type === 'pdf') {
    copy.page = Math.max(1, Number(copy.page) || 1);
    copy.zoom = Math.min(ZOOM_MAX, Math.max(1, Number(copy.zoom) || 1));
    copy.panX = Number.isFinite(copy.panX) ? copy.panX : 0.5;
    copy.panY = Number.isFinite(copy.panY) ? copy.panY : 0.5;
  }
  if (copy.type === 'slides') copy.slide = Math.max(0, Number(copy.slide) || 0);
  if (copy.type === 'imagedeck') {
    // Issue #106: a folder of per-slide images played as one deck. Accepts
    // the plan file's one-per-line text as well as an array. Only relative
    // paths and http(s) - the same rule plan files apply to src - because
    // every entry ends up in an <img> on the projector.
    const list = Array.isArray(copy.images) ? copy.images : String(copy.images || '').split('\n');
    copy.images = list
      .map((s) => String(s || '').trim().slice(0, 2000))
      .filter((s) => s && (!/^[a-z][a-z0-9+.-]*:/i.test(s) || /^https?:/i.test(s)))
      .slice(0, MAX_IMAGEDECK_SLIDES);
    copy.slide = Math.min(Math.max(0, Math.round(Number(copy.slide)) || 0), Math.max(0, copy.images.length - 1));
    copy.fit = copy.fit === 'cover' ? 'cover' : 'contain';
  }
  if (copy.type === 'document') {
    // The rendered page's height in its own pixels, measured by whoever
    // staged it (a page cannot be scrolled past what it holds), and where
    // the room is in it. `look` is the page's light or dark.
    copy.height = Math.min(MAX_DOC_HEIGHT, Math.max(DOC_VIEW, Math.round(Number(copy.height)) || DOC_VIEW));
    copy.at = clampDocAt(copy.at, copy.height);
    copy.look = copy.look === 'dark' || copy.look === 'light' ? copy.look : '';
  }
  if (copy.type === 'deck') {
    copy.slide = Math.max(0, Number(copy.slide) || 0);
    copy.slideCount = Math.max(1, Number(copy.slideCount) || 1);
    copy.step = Math.max(0, Number(copy.step) || 0);
    // Fragment count per slide, for PowerPoint-style progressive bullet
    // reveal. Absent or short arrays just mean "no fragments on this slide".
    copy.fragments = Array.isArray(copy.fragments) ? copy.fragments.map((n) => Math.max(0, Number(n) || 0)) : [];
    // Which slides are video slides (Issue #226), so a controller can offer
    // the transport on one; the display finds the video itself. A deck's
    // video only plays when someone presses Play - unlike a video item,
    // arriving on the slide is not "start".
    copy.videoSlides = Array.isArray(copy.videoSlides)
      ? [...new Set(copy.videoSlides.map((n) => Math.trunc(Number(n))).filter((n) => Number.isInteger(n) && n >= 0))].slice(0, 500)
      : [];
    copy.playing = copy.playing === true;
  }
  if (copy.type === 'set') {
    copy.mode = copy.mode === 'random' ? 'random' : 'sequential';
    copy.entries = (Array.isArray(copy.entries) ? copy.entries : [])
      .slice(0, MAX_SET_ENTRIES)
      .map((e) => {
        const sub = normalizeItem(e?.item);
        if (!sub) return null;
        // A minute cap, not because a longer hold is unreasonable, but
        // because a typo (2000 instead of 20) should not leave one slide up
        // for half an hour with nothing on screen to say why.
        return { item: sub, seconds: Math.max(1, Math.min(3600, Math.round(Number(e?.seconds)) || 10)) };
      })
      .filter(Boolean);
    copy.index = copy.entries.length ? Math.min(Math.max(0, Math.round(Number(copy.index)) || 0), copy.entries.length - 1) : 0;
    // Always a fresh clock on (re)staging, the same reason a re-picked video
    // starts from startAt rather than wherever an old copy's seek left off.
    copy.startedAt = Date.now();
    copy.paused = false;
    copy.remainingMs = 0;
    copy.cycle = [];
    copy.cyclePos = 0;
  }
  if (copy.type === 'poll') {
    // pollId and token identify the poll on the relay (see server/podium-
    // server.js's /poll routes) and are set once, at creation, by whoever
    // composed it - never regenerated here. Everything else is either what
    // was asked (kind/question/options, editable by re-staging) or a tally
    // the display fills in on its own polling tick (open/revealed/counts/
    // answers) and this normalization must not clobber on every re-stage.
    copy.kind = ['text', 'qna'].includes(copy.kind) ? copy.kind : 'choice';
    copy.question = String(copy.question || '').slice(0, 500);
    copy.options = copy.kind === 'choice'
      ? (Array.isArray(copy.options) ? copy.options : []).slice(0, 8).map((o) => String(o).slice(0, 200))
      : [];
    copy.correct = Number.isFinite(Number(copy.correct)) ? Math.round(Number(copy.correct)) : -1;
    copy.closesAt = Number.isFinite(Number(copy.closesAt)) && copy.closesAt > 0 ? Number(copy.closesAt) : null;
    copy.open = copy.open !== false;
    copy.revealed = !!copy.revealed;
    copy.voters = Math.max(0, Number(copy.voters) || 0);
    copy.counts = copy.kind === 'choice'
      ? copy.options.map((_, i) => Math.max(0, Number(copy.counts?.[i]) || 0))
      : [];
    copy.answers = copy.kind === 'text' && Array.isArray(copy.answers)
      ? copy.answers.map((a) => String(a).slice(0, 200)).slice(0, 500)
      : [];
    // Indices into `answers`, not the strings themselves - the relay's answer
    // order is stable per voter (a Map keeps an existing key's position when
    // its value changes; only a genuinely new voter appends), so an index a
    // presenter hid stays pointing at the same answer across tickPolls'
    // refetches. Only meaningful for 'text'; a choice poll has nothing to hide.
    copy.hiddenAnswers = copy.kind === 'text' && Array.isArray(copy.hiddenAnswers)
      ? [...new Set(copy.hiddenAnswers.map((i) => Math.trunc(Number(i))).filter((i) => i >= 0 && i < copy.answers.length))]
      : [];
    copy.qnaFeed = copy.kind === 'qna' ? (Array.isArray(copy.qnaFeed) ? copy.qnaFeed : []) : [];
    copy.viewMode = copy.viewMode === 'cloud' ? 'cloud' : 'list';
    copy.askName = !!copy.askName;
    copy.namePrompt = String(copy.namePrompt || 'Name:').slice(0, 50);
    copy.showNames = !!copy.showNames;
    copy.responses = Array.isArray(copy.responses) ? copy.responses : [];
    // Whether the join card spells out the URL under the QR, alongside the
    // four-letter code - a controller-local presentation preference (see
    // control.js's `presentation` prefs), decided once by whoever composes
    // the poll and carried on the item like kind/question/options, since
    // nothing else about a poll's rendering depends on which controller is
    // looking at it right now.
    copy.showUrl = copy.showUrl !== false;
  }
  if (copy.type === 'attendance') {
    // Check-in on screen (Issue #256). The session and the key that lets a
    // display ask the server for its current code - never the code itself,
    // which changes every few seconds and is fetched by the display.
    copy.sessionId = Math.max(0, Math.trunc(Number(copy.sessionId)) || 0);
    copy.screenKey = /^[A-Za-z0-9_-]{1,64}$/.test(copy.screenKey || '') ? copy.screenKey : '';
    copy.course = String(copy.course || '').slice(0, 64);
    copy.title = String(copy.title || 'Check in').slice(0, 120);
  }
  if (copy.type === 'trackend') {
    copy.untilQueue = !!copy.untilQueue;
    copy.title = String(copy.title || 'We begin in…').slice(0, 120);
  }
  return copy;
}

// Fisher-Yates over every entry except the one just shown, so a shuffled
// rotation never immediately repeats itself - the same reasoning as the
// music queue's "Shuffle the rest".
function shuffledIndices(count, excludeIndex) {
  const arr = [];
  for (let i = 0; i < count; i++) if (i !== excludeIndex) arr.push(i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Moves a set on to its next entry - sequential just steps forward and
// wraps; random draws from a shuffled bag of "not shown yet this lap",
// refilling the bag (minus whatever is showing right now) once it is spent,
// so every entry is seen once before any repeats and the same one never
// shows twice in a row.
function advanceSet(item) {
  if (!item.entries.length) return;
  if (item.entries.length === 1) { item.startedAt = Date.now(); item.remainingMs = 0; return; }
  if (item.mode === 'random') {
    if (!item.cycle?.length || item.cyclePos >= item.cycle.length) {
      item.cycle = shuffledIndices(item.entries.length, item.index);
      item.cyclePos = 0;
    }
    item.index = item.cycle[item.cyclePos];
    item.cyclePos += 1;
  } else {
    item.index = (item.index + 1) % item.entries.length;
  }
  item.startedAt = Date.now();
  item.remainingMs = 0;
}

// --- Guest View (Issue #150) --------------------------------------------------
//
// What a guest viewer is sent: what is on the projector right now, and
// nothing a viewer has no business holding. A second real display receives
// the whole of `state`, because it is trusted - it holds the room passphrase
// and could drive the room anyway. A viewer holds only the view key (see
// viewChannel below), and this is everything it ever gets, so it is written
// as an allow-list: a field added to `state` later stays private until
// someone decides a viewer should see it.
//
// Left out on purpose: the presenter's cue (preview/previewLayout/
// previewMode), the lecture id, mic and camera levels, and the full ink
// store (a viewer pulls the surfaces it is actually shown - see `ink` below).
const VIEWER_KEYS = [
  'rev', 'armed', 'program', 'panels', 'layout', 'focus', 'pip', 'blank',
  'overlay', 'watermark', 'timers', 'music', 'volume', 'contentVolume', 'muted',
  'stageAspect', 'musicNow', 'build',
];

/**
 * A poll on screen, as a viewer may see it. The host token is what ends or
 * rewrites the poll on the relay; named responses are students' names next
 * to their answers; the tallies and the correct answer stay hidden until the
 * presenter reveals them - exactly what the projector itself shows.
 */
function viewerPoll(item) {
  const { token, responses, ...rest } = item;
  const safe = { ...rest, viewerLive: !!token };
  if (!item.revealed) {
    safe.counts = (item.counts || []).map(() => 0);
    safe.answers = [];
    safe.correct = -1;
  }
  // Who upvoted a question is not on the screen - only how many did.
  if (Array.isArray(item.qnaFeed)) {
    safe.qnaFeed = item.qnaFeed.map((q) => ({ ...q, upvotes: Array.from({ length: q.upvotes?.length || 0 }, () => '') }));
  }
  return safe;
}

function viewerItem(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.type === 'poll') return viewerPoll(item);
  // A guest viewer is not in the room, so it never gets the key to the
  // rotating check-in code (Issue #256) - that would be the code texted to
  // someone outside, kept fresh for them.
  if (item.type === 'attendance') return { ...item, screenKey: '' };
  if (item.type === 'set' && Array.isArray(item.entries)) {
    return { ...item, entries: item.entries.map((entry) => ({ ...entry, item: viewerItem(entry.item) })) };
  }
  return item;
}

/**
 * @param {object} wire - the display's wireState()
 * @param {Object<string, string>} surfaces - inkSurfaceKey -> inkDigest for
 *   every panel actually on screen. Not wire.ink, which describes only the
 *   FOCUSED panel (what a controller draws on): a viewer has to draw every
 *   visible panel's ink, and pulls whichever of these its own copy disagrees
 *   with - never the presenter's pen colour, or the whole ink store.
 * @returns {object} what goes out on the view channel
 */
export function viewerState(wire, surfaces = {}) {
  const out = {};
  for (const key of VIEWER_KEYS) if (wire[key] !== undefined) out[key] = wire[key];
  out.program = viewerItem(wire.program);
  out.panels = (wire.panels || []).map(viewerItem);
  out.ink = { surfaces: { ...surfaces } };
  return out;
}

// Marp's own directive names (global and per-slide - a per-slide one may also
// be spelled with a leading underscore). A comment made only of these is
// consumed by Marp as configuration; every other comment is a presenter note.
const MARP_DIRECTIVES = new Set([
  'marp', 'theme', 'style', 'headingDivider', 'lang', 'title', 'description', 'author', 'image',
  'keywords', 'url', 'size', 'math', 'paginate', 'header', 'footer', 'class', 'transition',
  'backgroundColor', 'backgroundImage', 'backgroundPosition', 'backgroundRepeat', 'backgroundSize', 'color',
  // Podium's own: a video slide, which a viewer plays too (Issue #226), the
  // theme of a slide's diagrams and where an exported deck keeps a picture of
  // one (Issue #235).
  'video', 'videoStart', 'mermaidTheme', 'diagram',
]);

// --- things that play ----------------------------------------------------------

/** Item types that are themselves something playing: a clip, a track, a stream. */
export const MEDIA_TYPES = ['video', 'audio', 'youtube', 'stream'];

/** Whether a deck is on one of its video slides (Issue #226). */
export function deckVideoHere(item) {
  return item?.type === 'deck' && Array.isArray(item.videoSlides) && item.videoSlides.includes(item.slide || 0);
}

/**
 * Whether an item has a transport right now: Play, Pause, the scrubber. A
 * clip, a track or a stream always; a deck while it is on a video slide.
 */
export function isPlayable(item) {
  return MEDIA_TYPES.includes(item?.type) || deckVideoHere(item);
}

// --- keeping marked-up screens (Issues #182, #183) ---------------------------

/**
 * What each visible panel is showing, for inkCapturesFor to compare before
 * and after a command: its ink surface, whether that surface has ink, and
 * whether a video there is playing.
 */
export function liveInkSurfaces(state) {
  const count = LAYOUTS[state.layout] || 1;
  const out = [];
  for (let panel = 0; panel < count; panel++) {
    const item = panel === 0 ? state.program : state.panels?.[panel - 1];
    const key = inkSurfaceKey(item);
    const strokes = state.ink?.bySurface?.[key]?.strokes || [];
    let points = 0;
    for (const stroke of strokes) points += stroke.pts?.length || 0;
    out.push({
      panel, key, item,
      type: item?.type || 'black',
      // A deck plays only when told to (a video slide, Issue #226).
      playing: item?.type === 'deck' ? item.playing === true : item?.playing !== false,
      video: item?.type === 'video' || deckVideoHere(item),
      inked: strokes.length > 0,
      // Enough to tell "the same marks as last time" from new ones.
      sig: `${strokes.length}:${points}`,
    });
  }
  return out;
}

/**
 * Which panels to photograph because of one change to the room, and why.
 *
 *  - 'resume' (Issue #182): a paused video with marks on it starts playing
 *    again. The marks were made on that frame, so the frame and the marks
 *    are kept together, and the marks are then cleared (clearInk) rather
 *    than left floating over a moving picture. Always on.
 *  - 'leave' (Issue #183): with autoSave on, a panel with marks on it moves
 *    to something else - another slide, page or item, or out of the layout.
 *    Skipped when the same marks were already kept (`saved`: key -> sig),
 *    so paging back and forth past one annotated slide keeps it once.
 *
 * @param {ReturnType<liveInkSurfaces>} before
 * @param {ReturnType<liveInkSurfaces>} after
 * @param {{autoSave?: boolean, saved?: Map<string, string>}} [opts]
 * @returns {{panel: number, key: string, item: object, sig: string, reason: 'resume'|'leave', clearInk: boolean}[]}
 */
export function inkCapturesFor(before, after, { autoSave = false, saved = new Map() } = {}) {
  const out = [];
  for (const was of before) {
    if (!was.inked) continue;
    const now = after.find((s) => s.panel === was.panel);
    const base = { panel: was.panel, key: was.key, item: was.item, sig: was.sig };
    if (now && now.key === was.key) {
      if (was.video && !was.playing && now.playing) out.push({ ...base, reason: 'resume', clearInk: true });
      continue;
    }
    if (autoSave && saved.get(was.key) !== was.sig) out.push({ ...base, reason: 'leave', clearInk: false });
  }
  return out;
}

// Issue #180: a music queue nobody has touched for this long belongs to an
// earlier class. Long enough that no single lecture, break included, gets
// near it; short enough that a room used in the morning and again after
// lunch starts the afternoon with its own music rather than the morning's.
export const MUSIC_IDLE_RESET_MS = 3 * 60 * 60 * 1000;

/**
 * Clear yesterday's music queue before today's first command (Issue #180).
 *
 * The queue lives on the display and outlives every lecture: it is saved
 * with the rest of the room, a display tab is often left open for days, and
 * the one-tap audio chips and a plan's audio items ADD to it rather than
 * replacing it. So every Music tab showed a growing list of tracks from
 * earlier days' plans. Nothing marks where one class ends and the next
 * begins, but a room that has heard nothing for hours has plainly started
 * over, and that is when the old queue goes - never while it is playing.
 *
 * @param {object} state - mutated in place
 * @param {number} lastActivityAt - when the room last heard a command (0 = unknown)
 * @param {number} now
 * @returns {boolean} whether anything was cleared
 */
export function clearStaleMusic(state, lastActivityAt, now) {
  const music = state?.music;
  if (!music?.tracks?.length || music.playing) return false;
  if (!lastActivityAt || now - lastActivityAt < MUSIC_IDLE_RESET_MS) return false;
  music.tracks = [];
  music.index = 0;
  music.playlist = '';
  music.seekTo = 0;
  return true;
}

/**
 * Next or Previous through a Marp deck, builds included: Next reveals the
 * slide's next build step, and only moves on once every step is showing;
 * Previous hides them again one at a time, and lands on the slide before
 * fully built. The one rule, shared by the room and the planning page's
 * preview (Issue #177) so rehearsing a deck there steps exactly as it will
 * in class.
 *
 * @param {{slide?: number, step?: number}} pos
 * @param {'next'|'prev'} dir
 * @param {number[]} [fragments] - build steps per slide
 * @param {number} slideCount
 * @returns {{slide: number, step: number}}
 */
export function deckStep(pos, dir, fragments, slideCount) {
  const last = Math.max(0, (slideCount || 1) - 1);
  const fragsFor = (i) => (fragments && fragments[i]) || 0;
  let slide = Math.max(0, pos?.slide || 0);
  let step = pos?.step || 0;
  if (dir === 'next') {
    if (step < fragsFor(slide)) step += 1;
    else if (slide < last) { slide += 1; step = 0; }
  } else if (step > 0) {
    step -= 1;
  } else if (slide > 0) {
    slide -= 1;
    step = fragsFor(slide);
  }
  return { slide, step };
}

/**
 * A Marp deck as a guest viewer may have it (Issue #150): the slides, without
 * the presenter's notes. Notes are HTML comments in the source, and the only
 * copy a viewer can get is the one the display sends it - so this is where
 * they come out. Directive comments (`<!-- _class: lead -->`) stay, or the
 * slides would not render the way the room sees them.
 */
export function stripDeckNotes(source) {
  return String(source || '').replace(/<!--([\s\S]*?)-->/g, (whole, body) => {
    const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
    const directive = lines.length > 0 && lines.every((line) => {
      const m = line.match(/^_?([A-Za-z]+)\s*:/);
      return !!m && MARP_DIRECTIVES.has(m[1]);
    });
    return directive ? whole : '';
  });
}

/**
 * The view channel's room name and key, from a display's saved config. Room
 * names are not secret (the relay sees them), so a viewer room is named by a
 * random id of its own rather than anything derived from the class's room -
 * knowing one must not help anyone find the other. The key is what actually
 * keeps it private, exactly as the passphrase does for the real room.
 */
export function viewChannel(cfg) {
  if (!cfg?.viewId || !cfg?.viewKey) return null;
  return { room: `view.${cfg.viewId}`, passphrase: cfg.viewKey };
}

/** True for a room name viewChannel makes - what the relay keys its viewer rules on. */
export const isViewRoom = (room) => /^view\.[A-Za-z0-9_-]{8,40}$/.test(String(room || ''));

/**
 * What the corner shows when a NEW lecture starts under a course (Issue #157).
 *
 * A watermark the presenter set - typed or uploaded from the Say tab, before
 * Go live or in an earlier session - is theirs and is never replaced. One that
 * was itself a course default is: a classroom PC may have just taught a
 * different course, and that course's logo has no business opening this one,
 * or staying up at all when this course has no default.
 *
 * Pure, so it can be tested: `newAssetId` names the logo's bytes, and the
 * caller files `asset.data` under that id in its own asset store.
 *
 * @param {object} current - state.watermark as it is now
 * @param {{text?: string, image?: string, position?: string}|null|undefined} branding - from the server
 * @param {() => string} newAssetId
 * @param {number} maxImageChars - the asset cap every picture is held to
 * @returns {{ watermark: object, asset: {id: string, data: string}|null } | null} null = leave it alone
 */
export function watermarkForNewLecture(current, branding, newAssetId, maxImageChars) {
  if ((current.text || current.image) && !current.fromCourse) return null;
  const data = typeof branding?.image === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(branding.image)
    && branding.image.length <= maxImageChars ? branding.image : '';
  const text = String(branding?.text || '').slice(0, 120);
  if (!data && !text) {
    if (!current.fromCourse) return null;
    return { watermark: { ...current, enabled: false, text: '', image: '', fromCourse: false }, asset: null };
  }
  const asset = data ? { id: newAssetId(), data } : null;
  return {
    watermark: {
      enabled: true, text, image: asset ? `asset:${asset.id}` : '',
      position: branding.position === 'tl' ? 'tl' : 'br', fromCourse: true,
    },
    asset,
  };
}

// Pre-scripted captions (Issue #154): whatever is actually on the program
// layer names its own caption text, and this is the one place that gets
// applied to the SAME bar Live Captions (#79) uses - state.overlay. Only
// ever driven by panel A / the program layer, never B/C/D: the caption bar
// is one strip of screen, and a multi-panel layout's secondary panes are
// supplementary by nature, the same reason only program's own blank flag is
// cleared on stage (see 'stage' below). Never overrides a LIVE presenter's
// running transcript - state.overlay.live is that presenter's, and a
// captionless item elsewhere in the plan has no business silencing it.
function syncOverlayForProgram(state) {
  if (state.overlay.live) return;
  const program = state.program;
  const active = program?.type === 'set' ? program.entries?.[program.index]?.item : program;
  const text = typeof active?.overlayCaption === 'string' ? active.overlayCaption.slice(0, 500) : '';
  state.overlay = { ...state.overlay, text, visible: !!text, live: false };
}

// A snapshot of the on-screen item, given a new identity so the two content
// layers never confuse it with the original. Used when FREEZE needs to hand
// the presenter a safe copy of what is already showing - e.g. "let me peek
// ahead in this same deck without the class seeing it move" - without an
// explicit new pick from the library.
function cloneForPreview(item) {
  if (!item) return null;
  return { ...JSON.parse(JSON.stringify(item)), key: nextKey() };
}

// nav/fit change what is visually on screen, which is exactly what FREEZE
// promises to protect. media (play/pause/seek/volume) is different - the
// class already hears whatever is playing, so those always drive the program
// item directly, frozen or not, the same as a normal AV remote would.
function resolveVisualTarget(state, cmd) {
  if (cmd.where === 'program' || cmd.where === 'preview') return cmd.where;
  if (state.frozen) {
    if (!state.preview) state.preview = cloneForPreview(state.program);
    return state.preview ? 'preview' : 'program';
  }
  return 'program';
}

// Stable identity for an ink surface: what a stroke is considered to be drawn
// "on". Keying by slide/page means flipping to a different one shows a blank
// sheet rather than yesterday's doodles, while flipping back restores them.
export function inkSurfaceKey(item) {
  if (!item) return 'none';
  switch (item.type) {
    case 'deck': return `deck:${item.deckId}:${item.slide || 0}`;
    // One surface for the whole page (Issue #240): its strokes are in the
    // page's own coordinates (see docInkSpace in doc.js), so they scroll
    // with the text rather than staying where the screen was.
    case 'document': return `document:${item.deckId}`;
    case 'pdf': return `pdf:${item.src}:${item.page || 1}`;
    case 'slides': return `web:${item.src}:${item.slide || 0}`;
    case 'web': return `web:${item.src}`;
    case 'whiteboard': return `whiteboard:${item.bg || 'default'}`;
    case 'image': return `image:${item.src}`;
    // Keyed by the slide's own image, like a plain image: each slide keeps
    // its own ink, and flipping back finds it again.
    case 'imagedeck': return `image:${item.images?.[item.slide || 0] || ''}`;
    // Two panels can hold two different countdowns; drawing on one must not
    // put the same marks on the other.
    case 'timer': return `timer:${item.timerId || ''}`;
    // Content-derived, the same reason image and whiteboard are: re-picking
    // the identical message or code should find its own ink again, and
    // there is nothing else stable to key it by - both types carry no src
    // or deckId, so falling through to the default case below would key
    // them by the item's own `key` instead, which is reassigned every time
    // the SAME text/QR is re-staged (including by "Full screen this" -
    // see the black case right below for what that actually does).
    case 'text': return `text:${item.body || ''}`;
    case 'qr': return `qr:${item.data || ''}`;
    // One surface, not one per instance: unlike every case above, "black"
    // carries no content of its own to distinguish one from another, so it
    // needs an identity that isn't the item's own `key` at all. The default
    // case below falls back to `key` for exactly this reason (nothing else
    // to go on) - which is fine for an item that is never re-staged, but a
    // panel showing the untouched default black item has no key yet
    // (state.panels starts as plain {...BLACK} literals, never normalized),
    // so drawing on it computes "black:" - and the instant that panel's
    // content is re-staged for ANY reason, including "Full screen this"
    // promoting it, normalizeItem() hands it a fresh random key and the
    // surface becomes "black:<newkey>": a new, empty one. The promoted
    // panel then shows literally nothing (black has no content of its own
    // to render) with an ink layer that has nothing to paint either -
    // indistinguishable from the screen having simply gone black.
    case 'black': return 'black';
    // Scoped by position, not just by the set: drawing on entry 2 must not
    // show up when the rotation comes back around to entry 5, the same
    // reason a deck keys ink by slide rather than by the deck as a whole.
    case 'set': return `set:${item.key}:${item.index}`;
    // pollId, not item.key, for the same reason black/text/qr use their own
    // content above rather than falling to the default case: re-asking the
    // same question (re-staging with the same pollId) must not orphan
    // whatever was circled on it a moment ago.
    case 'poll': return `poll:${item.pollId}`;
    case 'attendance': return `attendance:${item.sessionId}`;
    default: return `${item.type}:${item.src || item.deckId || item.key || ''}`;
  }
}

const MAX_SURFACES = 300;   // a whole semester of slide-by-slide ink, capped
const MAX_STROKES_PER_SURFACE = 500;

// One stroke, capped. The stroke count was already bounded; the points inside
// each one were not, so a pen left down - or a pointer that never lifted
// because a tab was backgrounded mid-gesture - could grow a single stroke
// without limit. 3000 points is a very long deliberate line.
const MAX_POINTS_PER_STROKE = 3000;

/**
 * Ink points are fractions of the content box, and they used to cross the wire
 * at full float precision: 0.5488135039273248, eighteen characters to describe
 * a position on a projector.
 *
 * Four decimal places is one ten-thousandth of the screen - 0.19px on a 1920px
 * projector, well under a pixel and far under the width of the thinnest pen -
 * and it takes 60% off every stroke that is stored, broadcast, or saved. That
 * is not a micro-optimisation here: see inkDigest below for what the size of
 * this data was doing to the connection.
 */
const INK_PRECISION = 1e4;

function roundPoints(pts) {
  const out = [];
  for (const pt of Array.isArray(pts) ? pts : []) {
    const x = Number(pt?.[0]);
    const y = Number(pt?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push([Math.round(x * INK_PRECISION) / INK_PRECISION, Math.round(y * INK_PRECISION) / INK_PRECISION]);
  }
  return out;
}

/**
 * A cheap summary of a surface's ink, for the state heartbeat.
 *
 * The heartbeat used to carry every stroke on the current surface, in full,
 * every two seconds - and every 400ms while anything was playing. A hundred
 * strokes of sixty points is 243 KB of JSON, which seals to about 330 KB, and
 * every relay caps a message well below that: the self-hosted one closes the
 * socket with 1009, the transport reconnects, the next heartbeat closes it
 * again. A well-annotated whiteboard took the projector off the air.
 *
 * So the heartbeat carries this instead, and a controller whose own copy does
 * not match asks for the surface (see 'ink-pull' in display.js). `p` excludes
 * the final stroke deliberately: while someone is drawing, that stroke's point
 * count is legitimately different on every device, because batches are in
 * flight. Counting it would mean re-pulling the whole surface on every frame
 * of every gesture.
 */
export function inkDigest(strokes) {
  const list = Array.isArray(strokes) ? strokes : [];
  let points = 0;
  for (let i = 0; i < list.length - 1; i++) points += list[i].pts?.length || 0;
  return { n: list.length, p: points };
}

export function inkDigestsAgree(a, b) {
  return !!a && !!b && a.n === b.n && a.p === b.p;
}

/**
 * Apply one ink action to a plain array of strokes, in place.
 *
 * Lives here rather than inside applyCommand's switch because both ends need
 * it: the display owns the authoritative surfaces, and a controller now follows
 * the ink commands its peers put on the bus so a second device draws live
 * rather than a heartbeat later. Two copies of this would drift.
 *
 * Returns true if anything changed.
 */
export function applyInkAction(strokes, cmd, fallback = {}) {
  if (cmd.action === 'begin' || cmd.action === 'points') {
    let stroke = cmd.action === 'points' ? strokes.find((s) => s.id === cmd.id) : null;
    if (stroke) {
      stroke.pts.push(...roundPoints(cmd.pts));
    } else {
      // 'begin', or a 'points' whose 'begin' was dropped - which should not
      // lose the rest of the stroke.
      stroke = {
        id: cmd.id,
        color: cmd.color || fallback.color,
        width: cmd.width || fallback.width,
        pts: roundPoints(cmd.pts),
      };
      if (cmd.highlighter || fallback.highlighter) stroke.highlighter = true;
      strokes.push(stroke);
    }
    // Capped on the stroke actually touched, not the last one in the list: a
    // late batch can land on a stroke that is no longer the newest.
    if (stroke.pts.length > MAX_POINTS_PER_STROKE) stroke.pts.length = MAX_POINTS_PER_STROKE;
    return true;
  }
  if (cmd.action === 'erase') {
    const ids = Array.isArray(cmd.ids) ? cmd.ids : (cmd.id ? [cmd.id] : []);
    if (!ids.length) return false;
    const set = new Set(ids);
    let changed = false;
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (set.has(strokes[i].id)) {
        strokes.splice(i, 1);
        changed = true;
      }
    }
    return changed;
  }
  if (cmd.action === 'undo') { strokes.pop(); return true; }
  if (cmd.action === 'clear') { strokes.length = 0; return true; }
  return false;
}

/**
 * Squared distance from point (px, py) to segment (x1, y1)-(x2, y2).
 */
export function distToSegmentSquared(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return (px - x1) ** 2 + (py - y1) ** 2;
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
}

/**
 * Hit test a stroke against screen coordinates (px, py) given surface size (w, h).
 */
export function strokeHitTest(stroke, px, py, w, h, eraserRadius = 18) {
  if (!stroke?.pts || stroke.pts.length === 0) return false;
  const radius = Math.max(eraserRadius, (stroke.width || 6) * 0.5 + 8);
  const r2 = radius * radius;

  if (stroke.pts.length === 1) {
    const sx = stroke.pts[0][0] * w;
    const sy = stroke.pts[0][1] * h;
    return (px - sx) ** 2 + (py - sy) ** 2 <= r2;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of stroke.pts) {
    const sx = x * w;
    const sy = y * h;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  if (px < minX - radius || px > maxX + radius || py < minY - radius || py > maxY + radius) {
    return false;
  }

  for (let i = 0; i < stroke.pts.length - 1; i++) {
    const x1 = stroke.pts[i][0] * w;
    const y1 = stroke.pts[i][1] * h;
    const x2 = stroke.pts[i + 1][0] * w;
    const y2 = stroke.pts[i + 1][1] * h;
    if (distToSegmentSquared(px, py, x1, y1, x2, y2) <= r2) {
      return true;
    }
  }
  return false;
}

function touchSurface(ink, key) {
  let surface = ink.bySurface[key];
  if (!surface) {
    surface = { strokes: [], touched: Date.now() };
    ink.bySurface[key] = surface;
    const keys = Object.keys(ink.bySurface);
    if (keys.length > MAX_SURFACES) {
      keys.sort((a, b) => ink.bySurface[a].touched - ink.bySurface[b].touched);
      for (const stale of keys.slice(0, keys.length - MAX_SURFACES)) delete ink.bySurface[stale];
    }
  }
  surface.touched = Date.now();
  return surface;
}

/**
 * Apply one controller command to the display's state.
 * Returns true when something changed (and therefore needs broadcasting).
 */
function cleanTrack(track) {
  if (!track || typeof track.src !== 'string' || !track.src) return null;
  return {
    src: track.src.slice(0, 500),
    title: String(track.title || track.src.split('/').pop() || 'Track').slice(0, 120),
    artist: String(track.artist || '').slice(0, 120),
  };
}

/**
 * The background music queue.
 *
 * Everything here is state rather than an instruction to a player: what the
 * queue is, which track it is on, whether it should be sounding, and how long
 * the display should take over the next change. The display reconciles its one
 * hidden <audio> against that, which is what makes two controllers agree and a
 * controller that joins mid-lecture see what is already playing.
 */
function applyMusicCommand(state, cmd) {
  if (!state.music) state.music = { tracks: [], index: 0, playing: false, volume: 0.6, fadeMs: MUSIC_FADE_OUT_MS, playlist: '', pauseQueue: false };
  const music = state.music;
  const last = Math.max(0, music.tracks.length - 1);

  switch (cmd.action) {
    case 'load': {
      const tracks = (Array.isArray(cmd.tracks) ? cmd.tracks : []).map(cleanTrack).filter(Boolean).slice(0, MAX_TRACKS);
      if (!tracks.length) return false;
      music.tracks = tracks;
      music.playlist = String(cmd.name || '').slice(0, 80);
      music.index = 0;
      music.fadeMs = MUSIC_FADE_IN_MS;
      music.playing = !!cmd.play;
      if (cmd.pauseQueue !== undefined) music.pauseQueue = !!cmd.pauseQueue;
      return true;
    }

    case 'add': {
      const tracks = (Array.isArray(cmd.tracks) ? cmd.tracks : []).map(cleanTrack).filter(Boolean);
      if (!tracks.length) return false;
      music.tracks = [...music.tracks, ...tracks].slice(0, MAX_TRACKS);
      return true;
    }

    // A resource that is also on screen somewhere - a library tile, a plan
    // item - offered as background music with one tap: queue it if it is not
    // already there, then jump to it and play, rather than making a chip
    // press be "add, then go find it in the queue and select it".
    case 'playnow': {
      const track = cleanTrack(cmd.track);
      if (!track) return false;
      let index = music.tracks.findIndex((t) => t.src === track.src);
      if (index === -1) {
        const tracks = [...music.tracks, track];
        // Dropping from the head rather than the tail when the queue is
        // already full, unlike `add`'s cap: this command exists to play the
        // NEW track, and trimming from the end would silently drop it and
        // play whatever used to be last instead.
        music.tracks = tracks.length > MAX_TRACKS ? tracks.slice(tracks.length - MAX_TRACKS) : tracks;
        index = music.tracks.length - 1;
      }
      music.index = index;
      music.playing = true;
      music.fadeMs = MUSIC_PAUSE_MS;
      return true;
    }

    case 'play':
    case 'pause':
    case 'toggle': {
      if (!music.tracks.length) return false;
      const playing = cmd.action === 'toggle' ? !music.playing : cmd.action === 'play';
      if (playing === music.playing) return false;
      music.playing = playing;
      music.fadeMs = playing ? MUSIC_FADE_IN_MS : MUSIC_PAUSE_MS;
      return true;
    }

    // The one the class beginning is for: the room goes quiet over a few
    // seconds rather than being cut off mid-bar.
    case 'fadeout':
      if (!music.playing) return false;
      music.playing = false;
      music.fadeMs = MUSIC_FADE_OUT_MS;
      return true;

    case 'select': {
      const index = Number(cmd.index);
      if (!Number.isInteger(index) || index < 0 || index > last) return false;
      music.index = index;
      music.playing = cmd.play ?? true;
      music.fadeMs = MUSIC_PAUSE_MS;
      return true;
    }

    case 'next':
    case 'prev': {
      if (!music.tracks.length) return false;
      const step = cmd.action === 'next' ? 1 : -1;
      // Wraps rather than stopping at the end: this is music for a room that
      // is filling up, and nobody wants to notice that it ran out.
      music.index = (music.index + step + music.tracks.length) % music.tracks.length;
      music.fadeMs = MUSIC_PAUSE_MS;
      // `auto` is the display telling us a track ended by itself. It should
      // not start music that was not already playing.
      if (!cmd.auto) {
        music.playing = true;
      } else if (music.pauseQueue) {
        music.playing = false;
      }
      return true;
    }

    case 'pauseQueue':
      music.pauseQueue = cmd.value !== undefined ? !!cmd.value : !music.pauseQueue;
      return true;

    case 'seek': {
      if (!music.tracks.length) return false;
      const time = Math.max(0, Number(cmd.time ?? cmd.value) || 0);
      music.seekTo = time;
      music.seekNonce = (music.seekNonce || 0) + 1;
      if (cmd.play !== false) {
        music.playing = true;
        music.fadeMs = MUSIC_PAUSE_MS;
      }
      return true;
    }

    case 'shuffle': {
      if (music.tracks.length < 3) return false;
      // Everything after the current track, reordered: what is playing now
      // keeps playing, and the surprise is in what comes next.
      const head = music.tracks.slice(0, music.index + 1);
      const tail = music.tracks.slice(music.index + 1);
      for (let i = tail.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tail[i], tail[j]] = [tail[j], tail[i]];
      }
      music.tracks = [...head, ...tail];
      return true;
    }

    case 'clear':
      if (!music.tracks.length && !music.playing) return false;
      music.tracks = [];
      music.index = 0;
      music.playing = false;
      music.playlist = '';
      music.fadeMs = MUSIC_PAUSE_MS;
      return true;

    case 'volume':
      music.volume = clamp01(cmd.value);
      return true;

    default:
      return false;
  }
}

export function applyCommand(state, cmd) {
  const before = [state.program, ...(state.panels || [])];
  const applied = applyOp(state, cmd);
  if (applied) rememberDecks(state, before);
  return applied;
}

/**
 * Issue #216: when a panel's deck is replaced by something that is not a
 * deck, keep it - where it was, build step and all - in state.recall, so the
 * Slides tab can still show it and put it back. A deck going up on a panel
 * (a different one, or this one again) clears that panel's memory.
 */
export function rememberDecks(state, before) {
  if (!Array.isArray(state.recall) || state.recall.length !== PANEL_COUNT) state.recall = [null, null, null, null];
  const now = [state.program, ...(state.panels || [])];
  for (let i = 0; i < PANEL_COUNT; i++) {
    const was = before[i];
    const is = now[i];
    if (is?.type === 'deck') state.recall[i] = null;
    else if (was?.type === 'deck' && was !== is) state.recall[i] = { ...was };
  }
}

function applyOp(state, cmd) {
  switch (cmd.op) {
    case 'stage': {
      const item = normalizeItem(cmd.item);
      if (!item) return false;
      state[stageTarget(state, cmd.where)] = item;
      // Putting something on the program bus is an explicit "show this".
      if (stageTarget(state, cmd.where) === 'program') { state.blank = false; syncOverlayForProgram(state); }
      return true;
    }

    case 'take': {
      // A cued layout can arrive with no cued content at all (you only
      // changed panels while frozen), so this can no longer refuse just
      // because state.preview is empty - only when NEITHER is pending.
      // Held ink (Issue #174) is part of the cue too: marking up what is
      // already on screen while frozen, then TAKE, reveals just the ink.
      const heldInk = heldInkCount(state.ink) > 0;
      if (!state.preview && state.previewLayout === null && !heldInk) return false;
      if (heldInk) commitHeldInk(state.ink);
      else discardHeldInk(state.ink);
      if (state.preview) {
        state.program = state.preview;
        state.preview = null;
        // A deliberate blank is "eyes on me", and only new CONTENT is worth
        // interrupting that for - a bare rearrangement of empty structure
        // (see below) has nothing to reveal and must not undo it by itself.
        state.blank = false;
        syncOverlayForProgram(state);
      }
      if (state.previewLayout !== null) {
        state.layout = state.previewLayout;
        state.previewLayout = null;
        if (state.focus >= LAYOUTS[state.layout]) state.focus = 0;
      }
      state.frozen = false;
      return true;
    }

    case 'swap': {
      if (!state.preview) return false;
      [state.program, state.preview] = [state.preview, state.program];
      syncOverlayForProgram(state);
      return true;
    }

    case 'clear': {
      const where = cmd.where === 'program' ? 'program' : 'preview';
      if (where === 'program') { state.program = { ...BLACK }; syncOverlayForProgram(state); }
      // Abandoning the cue abandons a cued layout with it - "Clear cue"
      // means throw away everything queued up for the next TAKE, not just
      // whichever half of it happens to be content.
      else { state.preview = null; state.previewLayout = null; discardHeldInk(state.ink); }
      return true;
    }

    case 'freeze':
      state.frozen = cmd.on ?? !state.frozen;
      // Unfreezing without taking should not silently drop the cued item; the
      // controller decides whether to take it, so preview is left alone.
      return true;

    case 'blank':
      state.blank = cmd.on ?? !state.blank;
      return true;

    case 'autoSaveInk':
      state.autoSaveInk = cmd.on === undefined ? !state.autoSaveInk : !!cmd.on;
      return true;

    case 'previewMode':
      state.previewMode = cmd.on ?? !state.previewMode;
      return true;

    case 'layout': {
      if (!Object.prototype.hasOwnProperty.call(LAYOUTS, cmd.mode)) return false;
      // Frozen is "hold what the room sees" for the whole stage, not just
      // panel A - a layout change is exactly that, so it queues the same way
      // a new pick does, and TAKE (above) is what actually applies it.
      if (state.frozen) {
        if (cmd.mode === (state.previewLayout ?? state.layout)) return false;
        state.previewLayout = cmd.mode;
        return true;
      }
      state.layout = cmd.mode;
      // A focus the new layout does not have (going from 4 panels down to 2,
      // say) falls back to A rather than pointing at a panel that is no
      // longer shown.
      if (state.focus >= LAYOUTS[cmd.mode]) state.focus = 0;
      return true;
    }

    case 'panel': {
      // B/C/D are set directly, with no freeze/cue in between - see the
      // comment on `layout` in initialState(). index 0/1/2 is B/C/D.
      const index = Number(cmd.index);
      if (!Number.isInteger(index) || index < 0 || index > 2) return false;
      const item = normalizeItem(cmd.item);
      if (!item) return false;
      state.panels[index] = item;
      return true;
    }

    case 'focus': {
      // Any of A-D, whether or not the layout shows it (Issue #215): B can be
      // set up while A is full screen. A panel off screen is never mounted
      // on the display (see syncLayers), so it is silent until shown.
      const index = Number(cmd.index);
      if (!Number.isInteger(index) || index < 0 || index >= PANEL_COUNT) return false;
      state.focus = index;
      return true;
    }

    case 'music':
      return applyMusicCommand(state, cmd);

    case 'volume':
      state.volume = clamp01(cmd.value);
      if (state.volume > 0) state.muted = false;
      return true;

    // The Mixer's own per-channel level for whatever is playing on a panel -
    // see the comment on contentVolume in initialState().
    case 'contentVolume':
      state.contentVolume = clamp01(cmd.value);
      return true;

    // The Mixer's own channel for a controller's amplified mic - see the
    // comment on micVolume in initialState().
    case 'micVolume':
      state.micVolume = clamp01(cmd.value);
      return true;

    case 'mute':
      state.muted = cmd.on ?? !state.muted;
      return true;

    case 'media': {
      // Deliberately NOT frozen-aware: background music or a paused video is
      // "now playing" control, not a visual reveal, so it always targets what
      // the room can actually hear. In a split layout that is whichever
      // panel has focus - B/C/D have no preview of their own to choose
      // between, so cmd.where only matters for panel A.
      const item = state.focus === 0 ? state[cmd.where === 'preview' ? 'preview' : 'program'] : state.panels[state.focus - 1];
      if (!item) return false;
      if (cmd.action === 'play') item.playing = true;
      else if (cmd.action === 'pause') item.playing = false;
      else if (cmd.action === 'toggle') item.playing = !item.playing;
      else if (cmd.action === 'seek') { item.seekTo = Math.max(0, Number(cmd.value) || 0); item.seekNonce = (item.seekNonce || 0) + 1; }
      else if (cmd.action === 'nudge') { item.seekBy = Number(cmd.value) || 0; item.seekNonce = (item.seekNonce || 0) + 1; }
      // A clip that already ran to its end is sitting there paused (see
      // handleMediaEnded in display.js) - Restart has to say "play" again
      // itself, not just "go back to 0", or seeking a paused clip would just
      // move where it is paused.
      else if (cmd.action === 'restart') { item.seekTo = 0; item.seekNonce = (item.seekNonce || 0) + 1; item.playing = true; }
      else if (cmd.action === 'setLoop') item.loop = !!cmd.value;
      // Issue #175: how much of a live stream the room gets - switched on the
      // live player, never by restaging it (which would reload the stream).
      else if (cmd.action === 'show' && item.type === 'stream' && STREAM_SHOWS.includes(cmd.value)) item.show = cmd.value;
      else return false;
      return true;
    }

    // Found by pollId rather than focus/where: the Polls tab controls
    // whichever poll is actually live regardless of which panel happens to
    // be focused right now, the same reason a poll's ink is keyed by pollId
    // rather than by panel. open/voters/counts/answers are the display's own
    // to fill in (see tickPolls in display.js) - revealed is the only thing
    // a controller ever sets directly, since "does the room see this yet"
    // was the one thing asked to stay a deliberate, separate action rather
    // than a side effect of asking a question or closing one.
    case 'poll': {
      const item = [state.program, state.preview, ...state.panels].find((it) => it?.type === 'poll' && it.pollId === cmd.pollId);
      if (!item) return false;
      if (cmd.action === 'reveal') {
        item.revealed = !!cmd.value;
      } else if (cmd.action === 'hideAnswer') {
        const index = Math.trunc(Number(cmd.index));
        if (!Number.isInteger(index) || index < 0 || index >= item.answers.length) return false;
        const hidden = new Set(item.hiddenAnswers || []);
        if (cmd.value) hidden.add(index); else hidden.delete(index);
        item.hiddenAnswers = [...hidden];
      } else if (cmd.action === 'viewMode') {
        item.viewMode = cmd.value === 'cloud' ? 'cloud' : 'list';
      } else if (cmd.action === 'showNames') {
        item.showNames = !!cmd.value;
      } else {
        return false;
      }
      return true;
    }

    case 'nav': {
      // Panel A goes through freeze/cue like always; B/C/D have no preview
      // to cue into, so a focused B/C/D is navigated directly and immediately
      // regardless of freeze - freeze's whole point (browse ahead unseen) is
      // moot for a panel that was never going to be seen changing anyway,
      // since it is not what freeze is protecting.
      // "What the room sees" (a guest clicker's Next) never pages a panel the
      // layout is not showing (Issue #215) - it means the screen, so A.
      const panel = cmd.where === 'program' && !panelOnScreen(state, state.focus) ? 0 : state.focus;
      const item = panel === 0 ? state[resolveVisualTarget(state, cmd)] : state.panels[panel - 1];
      if (!item) return false;
      const step = cmd.dir === 'prev' ? -1 : 1;
      if (item.type === 'deck') {
        const was = item.slide || 0;
        const last = Math.max(0, (item.slideCount || 1) - 1);
        const fragsFor = (i) => (item.fragments && item.fragments[i]) || 0;
        if (cmd.dir === 'goto') {
          item.slide = Math.min(last, Math.max(0, Number(cmd.value) || 0));
          // A thumbnail is a "go look at this slide" jump, not a re-run of its
          // build, so land fully revealed rather than back at bullet one.
          item.step = fragsFor(item.slide);
        } else {
          const pos = deckStep(item, cmd.dir, item.fragments, item.slideCount || 1);
          item.slide = pos.slide;
          item.step = pos.step;
        }
        // Leaving a video slide pauses its video (Issue #226); the display
        // remembers where, so coming back finds it there.
        if (item.slide !== was) item.playing = false;
      } else if (item.type === 'document') {
        // Next and Previous move most of a screen; a jump (a heading, the
        // scrubber, a drag on the mirror) goes to a position in the page.
        const target = cmd.dir === 'goto' ? Number(cmd.value) : (item.at || 0) + step * Math.round(DOC_VIEW * DOC_STEP);
        const was = item.at || 0;
        item.at = clampDocAt(target, item.height);
        return item.at !== was;
      } else if (item.type === 'imagedeck') {
        const last = Math.max(0, (item.images?.length || 1) - 1);
        const target = cmd.dir === 'goto' ? Number(cmd.value) || 0 : (item.slide || 0) + step;
        item.slide = Math.min(last, Math.max(0, Math.round(target)));
      } else if (item.type === 'pdf') {
        item.page = cmd.dir === 'goto' ? Math.max(1, Number(cmd.value) || 1) : Math.max(1, (item.page || 1) + step);
      } else if (item.type === 'slides' || item.type === 'web') {
        item.slide = cmd.dir === 'goto' ? Math.max(0, Number(cmd.value) || 0) : Math.max(0, (item.slide || 0) + step);
        item.navNonce = (item.navNonce || 0) + 1;
        item.navDir = cmd.dir;
      } else return false;
      return true;
    }

    // A document's page grew or shrank once its pictures loaded (Issue #240):
    // every copy of it on screen or in the cue learns its real height, so
    // Next stops at the real end.
    case 'doc-height': {
      const height = Math.min(MAX_DOC_HEIGHT, Math.max(DOC_VIEW, Math.round(Number(cmd.height)) || DOC_VIEW));
      let changed = false;
      for (const it of [state.program, state.preview, ...(state.panels || [])]) {
        if (it?.type !== 'document' || !cmd.deckId || it.deckId !== cmd.deckId || it.height === height) continue;
        it.height = height;
        it.at = clampDocAt(it.at, height);
        changed = true;
      }
      return changed;
    }

    case 'fit': {
      const item = state.focus === 0 ? state[resolveVisualTarget(state, cmd)] : state.panels[state.focus - 1];
      if (!item) return false;
      item.fit = cmd.value === 'cover' ? 'cover' : 'contain';
      return true;
    }

    // Zooming into a PDF page (Issue #82). panX/panY are fractions (0..1) of
    // the page marking the point held at the center of the view - clamped so
    // the visible window never pans past the page's own edge, the same
    // "never show dead space" rule fit/contain already gives every other
    // panel here.
    case 'zoom': {
      const item = state.focus === 0 ? state[resolveVisualTarget(state, cmd)] : state.panels[state.focus - 1];
      // A PDF page or (Issue #262) a photo shown whole, not cropped to fill.
      if (!item || !(item.type === 'pdf' || (item.type === 'image' && item.fit !== 'cover'))) return false;
      if (cmd.action === 'reset') {
        item.zoom = 1;
        item.panX = 0.5;
        item.panY = 0.5;
        return true;
      }
      if (cmd.action !== 'set') return false;
      // Kept within bounds here; kept ON the content by whoever draws it, the
      // one that knows both the content's and the panel's shape (see
      // clampView in zoom.js - the controller clamps before it sends too).
      const zoom = Math.min(ZOOM_MAX, Math.max(1, Number(cmd.zoom) || 1));
      const unit = (v, d) => Math.min(1, Math.max(0, Number.isFinite(Number(v)) ? Number(v) : d));
      item.zoom = zoom;
      item.panX = zoom === 1 ? 0.5 : unit(cmd.panX ?? item.panX, 0.5);
      item.panY = zoom === 1 ? 0.5 : unit(cmd.panY ?? item.panY, 0.5);
      return true;
    }

    // A running set's own clock is "what is actually showing", the same
    // category as media's play/pause/seek above rather than a visual reveal
    // - so, like media, it is deliberately not frozen-aware for anything a
    // person asks for. `advance` is the one exception: the display's own
    // tick loop calls it, independent of what is focused, once per panel
    // that actually has a running set - see SET_TICK_MS in display.js.
    case 'set': {
      if (cmd.action === 'advance') {
        const item = Number(cmd.panel) === 0 ? state.program : state.panels[Number(cmd.panel) - 1];
        if (!item || item.type !== 'set' || item.paused) return false;
        advanceSet(item);
        if (item === state.program) syncOverlayForProgram(state);
        return true;
      }
      const item = state.focus === 0 ? state[cmd.where === 'preview' ? 'preview' : 'program'] : state.panels[state.focus - 1];
      if (!item || item.type !== 'set') return false;
      const entrySeconds = () => Math.max(1, Number(item.entries[item.index]?.seconds) || 1) * 1000;
      switch (cmd.action) {
        case 'select': {
          const index = Number(cmd.index);
          if (!Number.isInteger(index) || index < 0 || index >= item.entries.length) return false;
          item.index = index;
          item.startedAt = Date.now();
          item.paused = false;
          item.remainingMs = 0;
          if (item === state.program) syncOverlayForProgram(state);
          return true;
        }
        case 'pause':
          if (item.paused || !item.entries.length) return false;
          item.remainingMs = Math.max(0, entrySeconds() - (Date.now() - item.startedAt));
          item.paused = true;
          return true;
        case 'resume':
          if (!item.paused) return false;
          item.startedAt = Date.now() - (entrySeconds() - item.remainingMs);
          item.paused = false;
          item.remainingMs = 0;
          return true;
        default:
          return false;
      }
    }

    case 'overlay':
      if (cmd.text !== undefined) state.overlay.text = String(cmd.text).slice(0, 500);
      state.overlay.visible = cmd.visible ?? !!state.overlay.text;
      // A manually TYPED caption ends live mode - otherwise the next
      // recognized phrase would silently overwrite what was just typed. A
      // bare Hide (#overlay-hide sends no text at all) does not: it is
      // "clear the bar right now" for either kind of caption, and for a
      // live one, staying in live mode is what lets the very next thing
      // said bring the bar back on its own, with no separate Stop/Start.
      if (cmd.text) state.overlay.live = false;
      return true;

    // Live captions (Issue #79): speech recognized on whichever device
    // started it (normally the controller, since it is the one near the
    // instructor's voice) rides this SAME bottom bar rather than a second
    // one competing for the same strip of screen - see the 'overlay' case
    // above and overlayEl in display.js. A distinct op rather than driving
    // 'overlay' directly: turning captions off has to know THIS is what is
    // holding the bar, not blindly clear a caption the presenter typed by
    // hand a moment ago.
    case 'caption': {
      if (cmd.on !== undefined) {
        state.overlay.live = !!cmd.on;
        if (!cmd.on) { state.overlay.text = ''; state.overlay.visible = false; }
        return true;
      }
      // A stale update from a device that had captions running before
      // someone else turned them off, or typed a manual caption over them.
      if (!state.overlay.live) return false;
      state.overlay.text = String(cmd.text || '').slice(0, 500);
      state.overlay.visible = !!state.overlay.text;
      return true;
    }

    // A corner watermark, set field by field like overlay above: whichever
    // of text/image/position/enabled the caller names changes, the rest is
    // left exactly as it was, so "Hide" does not throw away what was typed
    // and uploading a logo does not touch a position someone already chose.
    case 'watermark':
      if (cmd.text !== undefined) state.watermark.text = String(cmd.text).slice(0, 120);
      if (cmd.image !== undefined) state.watermark.image = String(cmd.image).slice(0, 200);
      // New text or a new logo makes it the presenter's own - a later lecture
      // leaves it alone. Moving or hiding a course default does not: the next
      // lecture of that course still starts with it showing.
      if (cmd.text !== undefined || cmd.image !== undefined) {
        state.watermark.fromCourse = false;
        state.watermark.fromDefault = cmd.fromDefault === true;
      }
      if (cmd.position !== undefined) state.watermark.position = cmd.position === 'tl' ? 'tl' : 'br';
      if (cmd.enabled !== undefined) state.watermark.enabled = !!cmd.enabled;
      return true;

    case 'pip': {
      const letters = ['A', 'B', 'C', 'D'];
      // Picking the pane already on the OTHER side swaps the two, rather
      // than being refused as "a pane cannot be its own inset" - it is the
      // likely reason to pick it at all, and the only way this ever comes
      // up (readPlan/initialState never produce main === inset to begin
      // with). Resolved here, against whatever state.pip actually holds
      // right now, rather than by the caller pre-computing both fields
      // itself - a client-side cache of "what it used to be" is exactly
      // the kind of thing a second, half-landed command leaves stale.
      if (cmd.main !== undefined && letters.includes(cmd.main) && cmd.main !== state.pip.main) {
        if (cmd.main === state.pip.inset) state.pip.inset = state.pip.main;
        state.pip.main = cmd.main;
      }
      if (cmd.inset !== undefined && letters.includes(cmd.inset) && cmd.inset !== state.pip.inset) {
        if (cmd.inset === state.pip.main) state.pip.main = state.pip.inset;
        state.pip.inset = cmd.inset;
      }
      if (cmd.corner !== undefined) {
        state.pip.corner = ['tl', 'tr', 'bl', 'br'].includes(cmd.corner) ? cmd.corner : state.pip.corner;
      }
      if (cmd.size !== undefined) {
        const n = Number(cmd.size);
        if (Number.isFinite(n)) state.pip.size = Math.min(50, Math.max(10, Math.round(n)));
      }
      return true;
    }

    case 'timer': {
      // Set-level actions first: they are about which timers exist, not about
      // any one of them.
      if (cmd.action === 'add') {
        if (state.timers.length >= MAX_TIMERS) return false;
        // The caller may name it, so a controller knows the id of the timer it
        // just created without waiting for the state to come back.
        const id = cmd.id ? String(cmd.id).slice(0, 40) : null;
        if (id && state.timers.some((t) => t.id === id)) return false;
        state.timers.push(newTimer(id, cmd.label, cmd.seconds));
        return true;
      }
      if (cmd.action === 'remove') {
        // The first one is the one every timer item falls back to, so there is
        // always at least one.
        if (state.timers.length <= 1) return false;
        const index = state.timers.findIndex((t) => t.id === cmd.id);
        if (index < 1) return false;
        state.timers.splice(index, 1);
        return true;
      }
      if (cmd.action === 'define') {
        // Replaces the whole set - what loading a lecture plan does. Ids come
        // from the caller so a plan's countdown items can name one.
        const wanted = Array.isArray(cmd.timers) ? cmd.timers.slice(0, MAX_TIMERS) : [];
        if (!wanted.length) return false;
        const built = [];
        const seen = new Set();
        for (const [i, t] of wanted.entries()) {
          const id = String(t?.id || `t${i + 1}`).slice(0, 40);
          // Two clocks sharing an id would leave the second unreachable -
          // timerById would hand back the first for both.
          if (seen.has(id)) continue;
          seen.add(id);
          built.push(newTimer(id, t?.label, t?.seconds));
        }
        if (!built.length) return false;
        state.timers = built;
        return true;
      }

      const t = timerById(state, cmd.id);
      if (!t) return false;
      if (cmd.label !== undefined) t.label = String(cmd.label).slice(0, 80);
      if (cmd.mode) t.mode = cmd.mode;
      if (cmd.action === 'start') {
        const ms = Math.max(0, (Number(cmd.seconds) || 0) * 1000);
        t.running = true;
        t.remainingMs = ms;
        t.endsAt = Date.now() + ms;
      } else if (cmd.action === 'pause') {
        if (!t.running) return true;
        t.remainingMs = Math.max(0, t.endsAt - Date.now());
        t.running = false;
      } else if (cmd.action === 'resume') {
        if (t.running) return true;
        t.running = true;
        t.endsAt = Date.now() + t.remainingMs;
      } else if (cmd.action === 'stop') {
        t.running = false;
        t.remainingMs = 0;
        t.endsAt = 0;
      }
      return true;
    }

    case 'ink': {
      const ink = state.ink;
      if (cmd.color) ink.color = cmd.color;
      if (cmd.width) ink.width = Number(cmd.width) || ink.width;
      // Every ink action applies to whichever panel has focus. On panel A
      // while frozen it lands on a held surface instead (Issue #174 - see
      // inkTargetKey): the cued item if one is cued, otherwise what is on
      // screen, and either way invisible to the room until TAKE.
      const surface = touchSurface(ink, inkTargetKey(state));
      // Note 'clear' empties the CURRENT surface only - the chalkboard you are
      // looking at, or this one slide - never every board you have ever drawn on.
      //
      // And it is undoable. Wiping the board is a frequent, deliberate move
      // mid-lecture - finish one problem, start the next - so making it a
      // two-tap confirmation would tax the common case to protect against the
      // rare one. Keeping what it wiped costs nothing until it is needed, and
      // an accidental Clear is recoverable for as long as the surface is still
      // on screen. Only the most recent clear per surface is kept, and it is
      // dropped before anything is written to disk (see saveInkSoon).
      if (cmd.action === 'restore') {
        // Put back from this screen's own stash rather than having the
        // controller send the strokes again: a wiped board can be hundreds of
        // kilobytes, and the point of undo is that nothing had to move.
        if (!surface.cleared?.length) return false;
        surface.strokes = surface.cleared;
        delete surface.cleared;
        return true;
      }
      if (cmd.action === 'clear' && surface.strokes.length) surface.cleared = surface.strokes.slice();
      const changed = applyInkAction(surface.strokes, cmd, { color: ink.color, width: ink.width, highlighter: !!cmd.highlighter });
      // Cap memory over a long lecture; the oldest strokes fall off first.
      if (surface.strokes.length > MAX_STROKES_PER_SURFACE) {
        surface.strokes.splice(0, surface.strokes.length - MAX_STROKES_PER_SURFACE);
      }
      if (cmd.action === 'erase') return changed;
      return true;
    }

    default:
      return false;
  }
}

// Remaining milliseconds on the countdown, computed fresh so controllers can
// tick smoothly between heartbeats.
export function timerRemaining(timer, now = Date.now()) {
  if (!timer) return 0;
  return timer.running ? Math.max(0, timer.endsAt - now) : timer.remainingMs;
}

// --- shape recognition & snapping (hold-to-straighten #38) -------------------

/**
 * Computes polygon area using the shoelace formula.
 */
export function shoelaceArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const next = pts[(i + 1) % pts.length];
    area += pts[i][0] * next[1] - next[0] * pts[i][1];
  }
  return Math.abs(area) * 0.5;
}

/**
 * Snaps an open stroke to a clean straight line between its endpoints,
 * with horizontal, vertical, and 45-degree angle snapping.
 */
export function snapStraightLine(pts, width = 1000, height = 1000) {
  if (!pts || pts.length < 2) return null;
  const w = width || 1000;
  const h = height || 1000;
  const p0 = [pts[0][0] * w, pts[0][1] * h];
  const pn = [pts[pts.length - 1][0] * w, pts[pts.length - 1][1] * h];

  const x0 = p0[0];
  const y0 = p0[1];
  let x1 = pn[0];
  let y1 = pn[1];
  let dx = x1 - x0;
  let dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;

  const angle = Math.atan2(Math.abs(dy), Math.abs(dx));
  // Snap horizontal if within ~5 degrees (0.087 rad)
  if (angle < 0.087) {
    y1 = y0;
  }
  // Snap vertical if within ~5 degrees
  else if (Math.abs(Math.PI / 2 - angle) < 0.087) {
    x1 = x0;
  }
  // Snap to 45 degree diagonal if within ~4 degrees (0.07 rad)
  else if (Math.abs(Math.PI / 4 - angle) < 0.07) {
    const signX = dx >= 0 ? 1 : -1;
    const signY = dy >= 0 ? 1 : -1;
    const avg = (Math.abs(dx) + Math.abs(dy)) / 2;
    x1 = x0 + signX * avg;
    y1 = y0 + signY * avg;
  }

  const rawPts = [
    [x0, y0],
    [x1, y1],
  ];

  return {
    type: 'line',
    pts: roundPoints(rawPts.map(([x, y]) => [
      Math.max(0, Math.min(1, x / w)),
      Math.max(0, Math.min(1, y / h)),
    ])),
  };
}

function snapArrowFromPoints(p0, tip, width, height) {
  const w = width || 1000;
  const h = height || 1000;
  const x0 = p0[0];
  const y0 = p0[1];
  let tx = tip[0];
  let ty = tip[1];
  let dx = tx - x0;
  let dy = ty - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;

  // Snap shaft to horizontal/vertical if close (within 5 degrees ~ 0.087 rad)
  const angle = Math.atan2(Math.abs(dy), Math.abs(dx));
  if (angle < 0.087) {
    ty = y0;
    dy = 0;
  } else if (Math.abs(Math.PI / 2 - angle) < 0.087) {
    tx = x0;
    dx = 0;
  }

  const shaftLen = Math.hypot(dx, dy);
  if (shaftLen < 1) return null;
  const ux = dx / shaftLen;
  const uy = dy / shaftLen;
  const px = -uy;
  const py = ux;

  const barbLen = Math.min(26, Math.max(12, shaftLen * 0.18));
  const barbAngle = 0.488; // ~28 degrees
  const cosA = Math.cos(barbAngle);
  const sinA = Math.sin(barbAngle);

  // Barb 1
  const b1x = tx - barbLen * (ux * cosA - px * sinA);
  const b1y = ty - barbLen * (uy * cosA - py * sinA);

  // Barb 2
  const b2x = tx - barbLen * (ux * cosA + px * sinA);
  const b2y = ty - barbLen * (uy * cosA + py * sinA);

  const rawPts = [
    [x0, y0],
    [tx, ty],
    [b1x, b1y],
    [tx, ty],
    [b2x, b2y],
  ];

  return {
    type: 'arrow',
    shaft: { from: [x0, y0], to: [tx, ty] },
    pts: roundPoints(rawPts.map(([x, y]) => [
      Math.max(0, Math.min(1, x / w)),
      Math.max(0, Math.min(1, y / h)),
    ])),
  };
}

/**
 * Snaps points to an arrow with a straight shaft and symmetrical barbs.
 */
export function snapArrow(pts, width = 1000, height = 1000) {
  if (!pts || pts.length < 2) return null;
  const w = width || 1000;
  const h = height || 1000;
  const pxPts = pts.map(([x, y]) => [x * w, y * h]);
  const p0 = pxPts[0];
  let maxDist = 0;
  let maxIdx = 0;
  for (let i = 0; i < pxPts.length; i++) {
    const d = Math.hypot(pxPts[i][0] - p0[0], pxPts[i][1] - p0[1]);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  const tip = pxPts[maxIdx];
  return snapArrowFromPoints(p0, tip, w, h);
}

/**
 * Snaps a closed stroke to a clean axis-aligned rectangle or square.
 */
export function snapBox(pts, width = 1000, height = 1000) {
  if (!pts || pts.length < 3) return null;
  const w = width || 1000;
  const h = height || 1000;
  const pxPts = pts.map(([x, y]) => [x * w, y * h]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pxPts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const bw = maxX - minX;
  const bh = maxY - minY;
  if (bw < 1 || bh < 1) return null;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const maxDim = Math.max(bw, bh);
  const isSquare = maxDim > 0 && Math.abs(bw - bh) / maxDim < 0.15;
  let x1 = minX, x2 = maxX, y1 = minY, y2 = maxY;
  if (isSquare) {
    const side = (bw + bh) / 2;
    x1 = cx - side / 2;
    x2 = cx + side / 2;
    y1 = cy - side / 2;
    y2 = cy + side / 2;
  }
  const rawPts = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
    [x1, y1],
  ];
  return {
    type: 'box',
    isSquare,
    pts: roundPoints(rawPts.map(([x, y]) => [
      Math.max(0, Math.min(1, x / w)),
      Math.max(0, Math.min(1, y / h)),
    ])),
  };
}

/**
 * Snaps a closed stroke to a clean ellipse or circle.
 */
export function snapEllipse(pts, width = 1000, height = 1000) {
  if (!pts || pts.length < 3) return null;
  const w = width || 1000;
  const h = height || 1000;
  const pxPts = pts.map(([x, y]) => [x * w, y * h]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pxPts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const bw = maxX - minX;
  const bh = maxY - minY;
  if (bw < 1 || bh < 1) return null;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const maxDim = Math.max(bw, bh);
  const isCircle = maxDim > 0 && Math.abs(bw - bh) / maxDim < 0.18;
  let rx = bw / 2;
  let ry = bh / 2;
  if (isCircle) {
    const r = (bw + bh) / 4;
    rx = r;
    ry = r;
  }
  const p0 = pxPts[0];
  const startAngle = Math.atan2(p0[1] - cy, p0[0] - cx);
  const SAMPLES = 36;
  const rawPts = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const theta = startAngle + (i * 2 * Math.PI) / SAMPLES;
    rawPts.push([cx + rx * Math.cos(theta), cy + ry * Math.sin(theta)]);
  }
  return {
    type: 'ellipse',
    isCircle,
    pts: roundPoints(rawPts.map(([x, y]) => [
      Math.max(0, Math.min(1, x / w)),
      Math.max(0, Math.min(1, y / h)),
    ])),
  };
}

/**
 * Analyzes a stroke and detects whether it should snap to a geometric shape
 * (straight line, arrow, rectangle/box, circle/ellipse).
 * Returns { type, pts, ... } or null if stroke is too short or irregular.
 */
export function detectAndSnapShape(pts, width = 1000, height = 1000) {
  if (!pts || pts.length < 2) return null;
  const w = width || 1000;
  const h = height || 1000;
  const pxPts = pts.map(([x, y]) => [x * w, y * h]);

  let totalLength = 0;
  for (let i = 1; i < pxPts.length; i++) {
    totalLength += Math.hypot(pxPts[i][0] - pxPts[i - 1][0], pxPts[i][1] - pxPts[i - 1][1]);
  }
  if (totalLength < 25) return null; // Too short (e.g. dot, tap)

  const p0 = pxPts[0];
  const pn = pxPts[pxPts.length - 1];
  const endDist = Math.hypot(pn[0] - p0[0], pn[1] - p0[1]);
  const isClosed = endDist < 0.28 * totalLength || (endDist < 45 && endDist / totalLength < 0.35);

  if (isClosed) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pxPts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const bw = maxX - minX;
    const bh = maxY - minY;
    if (bw < 10 || bh < 10) {
      return snapStraightLine(pts, w, h);
    }
    const boxArea = bw * bh;
    const polyArea = shoelaceArea(pxPts);
    const ratio = boxArea > 0 ? polyArea / boxArea : 0;

    if (ratio >= 0.85) {
      return snapBox(pts, w, h);
    }
    if (ratio >= 0.55) {
      return snapEllipse(pts, w, h);
    }
    return null; // Irregular closed doodle, preserve freehand
  }

  // Open stroke: check for arrow first
  let maxDist = 0;
  let maxIdx = 0;
  for (let i = 0; i < pxPts.length; i++) {
    const d = Math.hypot(pxPts[i][0] - p0[0], pxPts[i][1] - p0[1]);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  const n = pxPts.length - 1;
  const idxRatio = n > 0 ? maxIdx / n : 1;

  if (maxDist >= 25 && idxRatio >= 0.50 && idxRatio <= 0.94) {
    const tip = pxPts[maxIdx];
    const shaftLen = maxDist;
    let tailLen = 0;
    let maxTailDistFromTip = 0;
    for (let i = maxIdx + 1; i <= n; i++) {
      tailLen += Math.hypot(pxPts[i][0] - pxPts[i - 1][0], pxPts[i][1] - pxPts[i - 1][1]);
      const dTip = Math.hypot(pxPts[i][0] - tip[0], pxPts[i][1] - tip[1]);
      if (dTip > maxTailDistFromTip) maxTailDistFromTip = dTip;
    }

    const tipToP0 = [p0[0] - tip[0], p0[1] - tip[1]];
    const tipToTail = [pn[0] - tip[0], pn[1] - tip[1]];
    const dot = tipToP0[0] * tipToTail[0] + tipToP0[1] * tipToTail[1];

    if (
      tailLen > 0
      && tailLen <= 0.65 * shaftLen
      && maxTailDistFromTip <= 0.45 * shaftLen
      && dot > 0
    ) {
      return snapArrowFromPoints(p0, tip, w, h);
    }
  }

  return snapStraightLine(pts, w, h);
}

