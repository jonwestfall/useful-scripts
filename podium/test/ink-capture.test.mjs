// Run with: node podium/test/ink-capture.test.mjs
// Issues #182 and #183: which marked-up screens the display keeps a photo
// of, decided by comparing each visible panel before and after a command.
import { initialState, applyCommand, liveInkSurfaces, inkCapturesFor, inkSurfaceKey, isPlayable, deckVideoHere } from '../assets/js/protocol.js';

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};

let strokeId = 0;
const draw = (state) => applyCommand(state, { op: 'ink', action: 'begin', id: `s${++strokeId}`, pts: [[0.1, 0.1], [0.5, 0.5]] });
const deck = (slide) => ({ type: 'deck', deckId: 'd1', slide, step: 0, slideCount: 5, fragments: [], key: 'deck-item' });
const video = (playing) => ({ type: 'video', src: 'clip.mp4', playing, key: 'video-item' });

console.log('-- the room keeps the switch --');
{
  const state = initialState();
  chk('auto-save starts off', state.autoSaveInk === false);
  applyCommand(state, { op: 'autoSaveInk', on: true });
  chk('a controller turns it on', state.autoSaveInk === true);
  applyCommand(state, { op: 'autoSaveInk', on: false });
  chk('and off', state.autoSaveInk === false);
}

console.log('-- leaving a marked-up slide (#183) --');
{
  const state = initialState();
  state.program = deck(0);
  draw(state);
  chk('the stroke landed on the slide', (state.ink.bySurface[inkSurfaceKey(state.program)]?.strokes.length || 0) > 0);
  const before = liveInkSurfaces(state);
  state.program = deck(1);
  const after = liveInkSurfaces(state);
  chk('with auto-save off, Next keeps nothing', inkCapturesFor(before, after, { autoSave: false }).length === 0);
  const plans = inkCapturesFor(before, after, { autoSave: true });
  chk('with it on, the slide being left is kept', plans.length === 1 && plans[0].reason === 'leave'
    && plans[0].key === 'deck:d1:0' && plans[0].panel === 0 && !plans[0].clearInk);
  chk('and the plan names the item that was there, for the photo\'s title', plans[0].item.slide === 0);
  const saved = new Map([[plans[0].key, plans[0].sig]]);
  chk('the same marks left a second time are not kept twice', inkCapturesFor(before, after, { autoSave: true, saved }).length === 0);
  state.program = deck(0);
  draw(state);
  const again = inkCapturesFor(liveInkSurfaces(state), liveInkSurfaces({ ...state, program: deck(2) }), { autoSave: true, saved });
  chk('but new marks on it are', again.length === 1);
}

console.log('-- nothing to keep --');
{
  const state = initialState();
  state.program = deck(0);
  const before = liveInkSurfaces(state);
  state.program = deck(1);
  chk('a slide with no marks is never photographed', inkCapturesFor(before, liveInkSurfaces(state), { autoSave: true }).length === 0);
  state.program = deck(0);
  draw(state);
  const b2 = liveInkSurfaces(state);
  draw(state);
  chk('drawing more on the same slide is not leaving it', inkCapturesFor(b2, liveInkSurfaces(state), { autoSave: true }).length === 0);
  state.program = { ...deck(0), step: 1 };
  chk('nor is the next bullet of its build', inkCapturesFor(b2, liveInkSurfaces(state), { autoSave: true }).length === 0);
}

console.log('-- a panel that goes away --');
{
  const state = initialState();
  applyCommand(state, { op: 'layout', mode: '2h' });
  state.panels[0] = { type: 'whiteboard', bg: '#fff', key: 'wb' };
  applyCommand(state, { op: 'focus', index: 1 });
  draw(state);
  const before = liveInkSurfaces(state);
  chk('panel B is on screen with marks', before.length === 2 && before[1].inked);
  applyCommand(state, { op: 'layout', mode: 'single' });
  const plans = inkCapturesFor(before, liveInkSurfaces(state), { autoSave: true });
  chk('a layout that drops it keeps it', plans.length === 1 && plans[0].panel === 1);
}

console.log('-- a paused video marked up and played again (#182) --');
{
  const state = initialState();
  state.program = video(false);
  draw(state);
  const before = liveInkSurfaces(state);
  state.program = video(true);
  const plans = inkCapturesFor(before, liveInkSurfaces(state), { autoSave: false });
  chk('resuming keeps the frame and its marks, even with auto-save off', plans.length === 1 && plans[0].reason === 'resume');
  chk('and clears the marks off the moving picture', plans[0].clearInk === true);
  const playingBefore = liveInkSurfaces(state);
  state.program = video(false);
  chk('pausing is not resuming', inkCapturesFor(playingBefore, liveInkSurfaces(state), { autoSave: true }).length === 0);
  const clean = initialState();
  clean.program = video(false);
  const b = liveInkSurfaces(clean);
  clean.program = video(true);
  chk('a paused video with no marks plays on without a photo', inkCapturesFor(b, liveInkSurfaces(clean), { autoSave: true }).length === 0);
}

console.log('-- a deck\'s video slide (Issue #226) --');
{
  const state = initialState();
  applyCommand(state, { op: 'stage', where: 'program', item: { type: 'deck', deckId: 'd2', slideCount: 4, videoSlides: [1, '2', -1, 'x'] } });
  const item = state.program;
  chk('a staged deck keeps which slides are video slides, and only real ones', JSON.stringify(item.videoSlides) === '[1,2]');
  chk('and is not playing to begin with', item.playing === false);
  chk('slide 1 of a deck is not a video slide', !deckVideoHere(item) && !isPlayable(item));
  applyCommand(state, { op: 'nav', dir: 'next' });
  chk('on slide 2 it is', deckVideoHere(state.program) && isPlayable(state.program));
  chk('arriving does not start it', state.program.playing === false);
  applyCommand(state, { op: 'media', action: 'play' });
  chk('Play plays it', state.program.playing === true);
  applyCommand(state, { op: 'media', action: 'seek', value: 30 });
  chk('the scrubber seeks it', state.program.seekTo === 30 && state.program.seekNonce === 1);
  applyCommand(state, { op: 'nav', dir: 'next' });
  chk('moving to another slide pauses it', state.program.playing === false);
  chk('a video, a track and a stream are always playable', ['video', 'audio', 'youtube', 'stream'].every((type) => isPlayable({ type })));
  chk('a picture never is', !isPlayable({ type: 'image' }));

  const marked = initialState();
  marked.program = { ...deck(1), videoSlides: [1], playing: false };
  draw(marked);
  const before = liveInkSurfaces(marked);
  marked.program = { ...marked.program, playing: true };
  const plans = inkCapturesFor(before, liveInkSurfaces(marked), { autoSave: false });
  chk('playing a marked-up paused video slide keeps the frame and its marks (#182)', plans.length === 1 && plans[0].reason === 'resume' && plans[0].clearInk);
  const plain = initialState();
  plain.program = { ...deck(0), videoSlides: [1], playing: false };
  draw(plain);
  const b = liveInkSurfaces(plain);
  plain.program = { ...plain.program, playing: true };
  chk('an ordinary slide is never "resumed"', inkCapturesFor(b, liveInkSurfaces(plain), { autoSave: false }).length === 0);
}

if (!ok) process.exit(1);
console.log('all ink capture checks passed');
