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

// Bumped whenever a change lands that the two ends have to agree on. The
// display and the controller are separate devices loading their own copy of
// this file from your server, so one of them can easily be running last
// week's code - a browser that never revalidated display.html, or a machine
// that has had the projector page open since before you deployed. That does
// not look like a stale page; it looks like a bug, and it has cost real
// debugging time. The controller compares this against the display's and
// says so plainly instead (see renderConnection in control.js).
export const BUILD = '2026-09-12';

export const BLACK = { type: 'black', title: 'Black' };

// How many panels each layout actually shows - panel A (state.program) is
// always the first of them; B/C/D come from state.panels[0..2].
export const LAYOUTS = {
  single: 1,
  '2h': 2,   // side by side
  '2v': 2,   // top and bottom
  3: 3,      // A large on one side, B/C stacked on the other
  4: 4,      // A/B/C/D tiled 2x2
};

export function initialState() {
  return {
    rev: 0,
    armed: false,          // has someone clicked "Go live" on the display yet
    program: { ...BLACK },
    preview: null,
    frozen: false,          // hold the program layer; new picks land in preview
    blank: false,           // hard cut to black, keeps program loaded underneath
    previewMode: false,     // always cue before going live, even when not frozen
    volume: 0.8,
    muted: false,
    overlay: { text: '', visible: false },
    timer: { running: false, endsAt: 0, remainingMs: 0, label: '', mode: 'countdown' },
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
  };
}

// The item `focus` currently points at - state.program for focus 0 (never
// the frozen preview: ink/nav/transport all address what is actually on
// screen, exactly like today when there is only one panel), or state.panels
// for 1/2/3. Returns null for an out-of-range focus rather than throwing, so
// a stale focus from a layout that has since shrunk fails safe.
export function focusedItem(state) {
  if (state.focus === 0) return state.program;
  return state.panels[state.focus - 1] || null;
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

function normalizeItem(item) {
  if (!item || typeof item !== 'object' || !item.type) return null;
  const copy = { ...item, key: nextKey() };
  if (copy.type === 'video' || copy.type === 'audio' || copy.type === 'youtube') {
    copy.playing = copy.playing ?? true;
    copy.startAt = Number(copy.startAt) || 0;
  }
  if (copy.type === 'pdf') copy.page = Math.max(1, Number(copy.page) || 1);
  if (copy.type === 'slides') copy.slide = Math.max(0, Number(copy.slide) || 0);
  if (copy.type === 'deck') {
    copy.slide = Math.max(0, Number(copy.slide) || 0);
    copy.slideCount = Math.max(1, Number(copy.slideCount) || 1);
    copy.step = Math.max(0, Number(copy.step) || 0);
    // Fragment count per slide, for PowerPoint-style progressive bullet
    // reveal. Absent or short arrays just mean "no fragments on this slide".
    copy.fragments = Array.isArray(copy.fragments) ? copy.fragments.map((n) => Math.max(0, Number(n) || 0)) : [];
  }
  return copy;
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
    case 'pdf': return `pdf:${item.src}:${item.page || 1}`;
    case 'slides': return `web:${item.src}:${item.slide || 0}`;
    case 'web': return `web:${item.src}`;
    case 'whiteboard': return `whiteboard:${item.bg || 'default'}`;
    case 'image': return `image:${item.src}`;
    default: return `${item.type}:${item.src || item.deckId || item.key || ''}`;
  }
}

const MAX_SURFACES = 300;   // a whole semester of slide-by-slide ink, capped
const MAX_STROKES_PER_SURFACE = 500;

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
export function applyCommand(state, cmd) {
  switch (cmd.op) {
    case 'stage': {
      const item = normalizeItem(cmd.item);
      if (!item) return false;
      state[stageTarget(state, cmd.where)] = item;
      // Putting something on the program bus is an explicit "show this".
      if (stageTarget(state, cmd.where) === 'program') state.blank = false;
      return true;
    }

    case 'take': {
      if (!state.preview) return false;
      state.program = state.preview;
      state.preview = null;
      state.blank = false;
      state.frozen = false;
      return true;
    }

    case 'swap': {
      if (!state.preview) return false;
      [state.program, state.preview] = [state.preview, state.program];
      return true;
    }

    case 'clear': {
      const where = cmd.where === 'program' ? 'program' : 'preview';
      if (where === 'program') state.program = { ...BLACK };
      else state.preview = null;
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

    case 'previewMode':
      state.previewMode = cmd.on ?? !state.previewMode;
      return true;

    case 'layout': {
      if (!Object.prototype.hasOwnProperty.call(LAYOUTS, cmd.mode)) return false;
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
      const index = Number(cmd.index);
      const count = LAYOUTS[state.layout] || 1;
      if (!Number.isInteger(index) || index < 0 || index >= count) return false;
      state.focus = index;
      return true;
    }

    case 'volume':
      state.volume = clamp01(cmd.value);
      if (state.volume > 0) state.muted = false;
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
      else return false;
      return true;
    }

    case 'nav': {
      // Panel A goes through freeze/cue like always; B/C/D have no preview
      // to cue into, so a focused B/C/D is navigated directly and immediately
      // regardless of freeze - freeze's whole point (browse ahead unseen) is
      // moot for a panel that was never going to be seen changing anyway,
      // since it is not what freeze is protecting.
      const item = state.focus === 0 ? state[resolveVisualTarget(state, cmd)] : state.panels[state.focus - 1];
      if (!item) return false;
      const step = cmd.dir === 'prev' ? -1 : 1;
      if (item.type === 'deck') {
        const last = Math.max(0, (item.slideCount || 1) - 1);
        const fragsFor = (i) => (item.fragments && item.fragments[i]) || 0;
        if (cmd.dir === 'goto') {
          item.slide = Math.min(last, Math.max(0, Number(cmd.value) || 0));
          // A thumbnail is a "go look at this slide" jump, not a re-run of its
          // build, so land fully revealed rather than back at bullet one.
          item.step = fragsFor(item.slide);
        } else if (cmd.dir === 'next') {
          if ((item.step || 0) < fragsFor(item.slide)) item.step = (item.step || 0) + 1;
          else if (item.slide < last) { item.slide += 1; item.step = 0; }
        } else {
          if ((item.step || 0) > 0) item.step -= 1;
          else if (item.slide > 0) {
            const target = item.slide - 1;
            item.slide = target;
            item.step = fragsFor(target);
          }
        }
      } else if (item.type === 'pdf') {
        item.page = cmd.dir === 'goto' ? Math.max(1, Number(cmd.value) || 1) : Math.max(1, (item.page || 1) + step);
      } else if (item.type === 'slides' || item.type === 'web') {
        item.slide = cmd.dir === 'goto' ? Math.max(0, Number(cmd.value) || 0) : Math.max(0, (item.slide || 0) + step);
        item.navNonce = (item.navNonce || 0) + 1;
        item.navDir = cmd.dir;
      } else return false;
      return true;
    }

    case 'fit': {
      const item = state.focus === 0 ? state[resolveVisualTarget(state, cmd)] : state.panels[state.focus - 1];
      if (!item) return false;
      item.fit = cmd.value === 'cover' ? 'cover' : 'contain';
      return true;
    }

    case 'overlay':
      if (cmd.text !== undefined) state.overlay.text = String(cmd.text).slice(0, 500);
      state.overlay.visible = cmd.visible ?? !!state.overlay.text;
      return true;

    case 'timer': {
      const t = state.timer;
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
      // Every ink action applies to whatever is on screen right now - never to
      // a frozen preview. Annotating is "mark up what the class is looking
      // at", and freeze is orthogonal to that. In a split layout that means
      // whichever panel has focus (A never means the preview here either).
      const surface = touchSurface(ink, inkSurfaceKey(focusedItem(state)));
      if (cmd.action === 'begin') {
        surface.strokes.push({ id: cmd.id, color: cmd.color || ink.color, width: cmd.width || ink.width, pts: cmd.pts || [] });
      } else if (cmd.action === 'points') {
        const stroke = surface.strokes.find((s) => s.id === cmd.id);
        if (stroke) stroke.pts.push(...(cmd.pts || []));
        // A dropped 'begin' should not lose the rest of the stroke.
        else surface.strokes.push({ id: cmd.id, color: cmd.color || ink.color, width: cmd.width || ink.width, pts: cmd.pts || [] });
      } else if (cmd.action === 'undo') {
        surface.strokes.pop();
      } else if (cmd.action === 'clear') {
        // Clears only the current surface - the chalkboard you are looking at,
        // or this one slide - never every board you have ever drawn on.
        surface.strokes = [];
      }
      // Cap memory over a long lecture; the oldest strokes fall off first.
      if (surface.strokes.length > MAX_STROKES_PER_SURFACE) {
        surface.strokes.splice(0, surface.strokes.length - MAX_STROKES_PER_SURFACE);
      }
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
