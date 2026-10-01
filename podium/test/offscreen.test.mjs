// Run with: node podium/test/offscreen.test.mjs
// Issue #215: any of panels A-D can be worked on, whether or not the layout
// shows it. Issue #216: a deck replaced by something else on its panel is
// kept in state.recall, so the Slides tab can show it and put it back.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialState, applyCommand, panelOnScreen, PANEL_COUNT } from '../assets/js/protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};

const deck = (deckId, slide = 0) => ({ type: 'deck', title: deckId, deckId, slide, step: 0, slideCount: 10 });
const video = { type: 'video', title: 'Clip', src: '/clip.mp4' };

console.log('-- #215: a panel the layout does not show can still be worked on --');
{
  const s = initialState();
  chk('four panels in all', PANEL_COUNT === 4);
  chk('single layout: only A is on screen', panelOnScreen(s, 0) && !panelOnScreen(s, 1) && !panelOnScreen(s, 3));
  chk('focusing B while A is full screen is accepted', applyCommand(s, { op: 'focus', index: 1 }) && s.focus === 1);
  chk('focusing past D is still refused', applyCommand(s, { op: 'focus', index: 4 }) === false && s.focus === 1);
  applyCommand(s, { op: 'panel', index: 0, item: deck('b') });
  applyCommand(s, { op: 'nav', dir: 'next' });
  chk('the presenter\'s own Next pages the off-screen B they chose', s.panels[0].slide === 1);
  chk('...while A, on screen, is untouched', s.program.type === 'black');
}
{
  const s = initialState();
  applyCommand(s, { op: 'stage', item: deck('a') });
  applyCommand(s, { op: 'focus', index: 1 });
  applyCommand(s, { op: 'panel', index: 0, item: deck('b') });
  applyCommand(s, { op: 'nav', dir: 'next', where: 'program' });
  chk('a clicker\'s Next ("what the room sees") pages A, not the off-screen B', s.program.slide === 1 && s.panels[0].slide === 0);
  applyCommand(s, { op: 'layout', mode: '2h' });
  applyCommand(s, { op: 'focus', index: 1 });
  applyCommand(s, { op: 'nav', dir: 'next', where: 'program' });
  chk('once B is on screen, a clicker pages the focused B as before', s.panels[0].slide === 1);
}
{
  const s = initialState();
  applyCommand(s, { op: 'layout', mode: 'pip' });
  chk('picture-in-picture shows only its main and inset panes', panelOnScreen(s, 0) && panelOnScreen(s, 1) && !panelOnScreen(s, 2) && !panelOnScreen(s, 3));
}

console.log('-- #216: a deck replaced on its panel is kept --');
{
  const s = initialState();
  chk('nothing kept to begin with', s.recall.length === PANEL_COUNT && s.recall.every((r) => r === null));
  applyCommand(s, { op: 'stage', item: deck('a') });
  applyCommand(s, { op: 'nav', dir: 'next' });
  applyCommand(s, { op: 'nav', dir: 'next' });
  chk('paging a deck keeps nothing (it is still up)', s.recall[0] === null);
  applyCommand(s, { op: 'stage', item: video });
  chk('a video replacing it keeps the deck, at the slide it was on', s.recall[0]?.deckId === 'a' && s.recall[0].slide === 2);
  applyCommand(s, { op: 'stage', item: { type: 'whiteboard', bg: '#fff' } });
  chk('a second non-deck pick does not forget it', s.recall[0]?.deckId === 'a');
  applyCommand(s, { op: 'stage', item: deck('a', 2) });
  chk('putting it back clears the memory - it is up again', s.recall[0] === null);
  applyCommand(s, { op: 'stage', item: video });
  applyCommand(s, { op: 'stage', item: deck('other') });
  chk('a different deck going up replaces the memory', s.recall[0] === null);
}
{
  const s = initialState();
  applyCommand(s, { op: 'stage', item: deck('a') });
  applyCommand(s, { op: 'freeze', on: true });
  applyCommand(s, { op: 'stage', item: video });
  chk('cueing a video while frozen keeps nothing yet - the deck is still on screen', s.recall[0] === null);
  applyCommand(s, { op: 'take' });
  chk('TAKE puts the video up and keeps the deck', s.recall[0]?.deckId === 'a');
}
{
  const s = initialState();
  applyCommand(s, { op: 'stage', item: deck('a') });
  applyCommand(s, { op: 'panel', index: 1, item: deck('c') });
  applyCommand(s, { op: 'panel', index: 1, item: video });
  chk('each panel keeps its own deck (C here)', s.recall[2]?.deckId === 'c' && s.recall[0] === null);
}
{
  const s = initialState();
  delete s.recall;
  applyCommand(s, { op: 'stage', item: deck('a') });
  applyCommand(s, { op: 'stage', item: video });
  chk('a state from before recall existed gets one on first use', s.recall?.[0]?.deckId === 'a');
}

console.log('-- wiring --');
{
  const display = fs.readFileSync(path.join(ROOT, 'assets/js/display.js'), 'utf8');
  chk('the display saves the kept decks with the rest of the session', /savedAt: Date\.now\(\), program, panels, recall,/.test(display));
  chk('and clearing the room\'s saved session clears them', display.includes('state.recall = fresh.recall;'));
  const control = fs.readFileSync(path.join(ROOT, 'assets/js/control.js'), 'utf8');
  chk('the panel picker always offers all four', control.includes('Array.from({ length: PANEL_COUNT }'));
  chk('Back to slides goes through stage(), so a frozen screen cues it', /function putDeckBack\(\)[\s\S]{0,200}stage\(item\)/.test(control));
  const html = fs.readFileSync(path.join(ROOT, 'control.html'), 'utf8');
  chk('the Slides tab has a Back to slides button', html.includes('id="deck-back"'));
}

if (!ok) process.exit(1);
console.log('all off-screen panel checks passed');
