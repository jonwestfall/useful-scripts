// Run with: node podium/test/freeze-cue.test.mjs
// Issue #174: freeze holds what the room sees, not the presenter's hands. The
// controller's views follow the cue while frozen (workingItem), and ink drawn
// on panel A while frozen is held like the cue - TAKE reveals it, Clear cue
// throws it away, Unfreeze leaves it waiting.
import {
  initialState, applyCommand, workingItem, focusedItem, inkTargetKey, inkSurfaceKey,
  heldInkCount, isHeldInkKey, HELD_INK_PREFIX,
} from '../assets/js/protocol.js';

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};

const deck = (deckId, slide = 0) => ({ type: 'deck', title: deckId, deckId, slide, slideCount: 10 });
let strokeSeq = 0;
const draw = (state) => {
  const id = `s${strokeSeq++}`;
  applyCommand(state, { op: 'ink', action: 'begin', id, color: '#f00', width: 4, pts: [[0.1, 0.1], [0.2, 0.2]] });
  return id;
};
const strokesOn = (state, key) => state.ink.bySurface[key]?.strokes || [];

console.log('-- workingItem follows the cue only while frozen --');
{
  const s = initialState();
  applyCommand(s, { op: 'stage', item: deck('live') });
  chk('unfrozen: working item is what is on screen', workingItem(s)?.deckId === 'live');
  applyCommand(s, { op: 'freeze', on: true });
  chk('frozen with nothing cued: still what is on screen', workingItem(s)?.deckId === 'live');
  applyCommand(s, { op: 'stage', item: deck('cued') });
  chk('a deck opened while frozen lands in the cue', s.preview?.deckId === 'cued' && s.program?.deckId === 'live');
  chk('frozen with a deck cued: working item is the cue', workingItem(s)?.deckId === 'cued');
  chk('focusedItem is still the screen', focusedItem(s)?.deckId === 'live');
  applyCommand(s, { op: 'nav', dir: 'next' });
  chk('paging while frozen moves the cued deck', s.preview.slide === 1 && (s.program.slide || 0) === 0);
  applyCommand(s, { op: 'freeze', on: false });
  chk('unfrozen again: working item is the screen', workingItem(s)?.deckId === 'live');
}

console.log('-- ink drawn while frozen is held --');
{
  const s = initialState();
  applyCommand(s, { op: 'stage', item: deck('live', 2) });
  const liveKey = inkSurfaceKey(s.program);
  draw(s);
  chk('unfrozen ink goes straight to the real surface', strokesOn(s, liveKey).length === 1 && inkTargetKey(s) === liveKey);

  applyCommand(s, { op: 'freeze', on: true });
  chk('frozen: ink targets a held surface', inkTargetKey(s) === HELD_INK_PREFIX + liveKey && isHeldInkKey(inkTargetKey(s)));
  draw(s);
  chk('the held stroke is not on the real surface', strokesOn(s, liveKey).length === 1);
  chk('it is on the held one', strokesOn(s, HELD_INK_PREFIX + liveKey).length === 1 && heldInkCount(s.ink) === 1);

  applyCommand(s, { op: 'freeze', on: false });
  chk('unfreeze without TAKE keeps held ink waiting', heldInkCount(s.ink) === 1 && strokesOn(s, liveKey).length === 1);
  chk('unfrozen, new ink is live again', inkTargetKey(s) === liveKey);

  chk('TAKE with only held ink is allowed', applyCommand(s, { op: 'take' }) === true);
  chk('TAKE merges held ink into the real surface', strokesOn(s, liveKey).length === 2 && heldInkCount(s.ink) === 0);
  chk('no held surface is left behind', !Object.keys(s.ink.bySurface).some(isHeldInkKey));
  chk('the screen is unchanged by an ink-only TAKE', s.program.deckId === 'live' && !s.frozen);
}

console.log('-- held ink on a cued deck is revealed with it --');
{
  const s = initialState();
  applyCommand(s, { op: 'stage', item: deck('live') });
  applyCommand(s, { op: 'freeze', on: true });
  applyCommand(s, { op: 'stage', item: deck('next', 4) });
  const cuedKey = inkSurfaceKey(s.preview);
  chk('frozen with a cue: ink targets the cued slide, held', inkTargetKey(s) === HELD_INK_PREFIX + cuedKey);
  draw(s); draw(s);
  applyCommand(s, { op: 'ink', action: 'undo' });
  chk('undo works on held ink', strokesOn(s, HELD_INK_PREFIX + cuedKey).length === 1);
  applyCommand(s, { op: 'take' });
  chk('TAKE puts the cued deck up', s.program.deckId === 'next' && s.preview === null);
  chk('and its held ink with it', strokesOn(s, cuedKey).length === 1 && heldInkCount(s.ink) === 0);
}

console.log('-- Clear cue discards held ink --');
{
  const s = initialState();
  applyCommand(s, { op: 'stage', item: deck('live') });
  const liveKey = inkSurfaceKey(s.program);
  applyCommand(s, { op: 'freeze', on: true });
  draw(s);
  applyCommand(s, { op: 'stage', item: deck('other') });
  draw(s);
  chk('two held surfaces', heldInkCount(s.ink) === 2);
  applyCommand(s, { op: 'clear', where: 'preview' });
  chk('Clear cue drops the cue and every held surface', s.preview === null && heldInkCount(s.ink) === 0);
  chk('the live surface was never touched', strokesOn(s, liveKey).length === 0);
  chk('TAKE with nothing left is refused', applyCommand(s, { op: 'take' }) === false);
}

console.log('-- B/C/D are never frozen, so their ink stays live --');
{
  const s = initialState();
  applyCommand(s, { op: 'layout', mode: '2h' });
  applyCommand(s, { op: 'stage', item: deck('a') });
  applyCommand(s, { op: 'panel', index: 0, item: { type: 'whiteboard', bg: '#fff' } });
  applyCommand(s, { op: 'freeze', on: true });
  applyCommand(s, { op: 'focus', index: 1 });
  const bKey = inkSurfaceKey(s.panels[0]);
  chk('focused on B while frozen: ink is not held', inkTargetKey(s) === bKey);
  draw(s);
  chk('B ink lands live', strokesOn(s, bKey).length === 1 && heldInkCount(s.ink) === 0);
  chk('working item on B is B', workingItem(s) === s.panels[0]);
}

if (!ok) process.exit(1);
console.log('all freeze/cue checks passed');
