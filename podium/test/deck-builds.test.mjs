// Run with: node podium/test/deck-builds.test.mjs
// Issue #177: the planning page steps through Marp builds exactly as the room
// does (deckStep, shared with the reducer), and says what each slide builds -
// above all when a build directive will not do what it was meant to.
import { deckStep, initialState, applyCommand } from '../assets/js/protocol.js';
import { describeBuild } from '../assets/js/deck.js';

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};

console.log('-- stepping through builds --');
{
  // Slide 0 plain, slide 1 builds 3 steps, slide 2 plain.
  const frags = [0, 3, 0];
  let pos = { slide: 0, step: 0 };
  const walk = [];
  for (let i = 0; i < 6; i++) { pos = deckStep(pos, 'next', frags, 3); walk.push(`${pos.slide}.${pos.step}`); }
  chk(`Next reveals each step before moving on (${walk.join(' ')})`, walk.join(' ') === '1.0 1.1 1.2 1.3 2.0 2.0');
  const back = [];
  for (let i = 0; i < 6; i++) { pos = deckStep(pos, 'prev', frags, 3); back.push(`${pos.slide}.${pos.step}`); }
  chk(`Previous lands on a slide fully built, then hides one step at a time (${back.join(' ')})`,
    back.join(' ') === '1.3 1.2 1.1 1.0 0.0 0.0');
  chk('no builds at all is plain slide stepping', deckStep({ slide: 0, step: 0 }, 'next', [], 2).slide === 1);
  chk('a missing position starts at the first slide', deckStep(undefined, 'next', [2], 1).step === 1);
}

console.log('-- the room steps the same way --');
{
  const state = initialState();
  state.program = { type: 'deck', deckId: 'd', slide: 0, step: 0, slideCount: 3, fragments: [0, 2, 0] };
  const seen = [];
  let pos = { slide: 0, step: 0 };
  for (let i = 0; i < 4; i++) {
    applyCommand(state, { op: 'nav', dir: 'next' });
    pos = deckStep(pos, 'next', [0, 2, 0], 3);
    seen.push(state.program.slide === pos.slide && state.program.step === pos.step);
  }
  chk('the reducer and the planner agree at every press', seen.every(Boolean));
}

console.log('-- describing a slide\'s build --');
{
  const bullets = describeBuild({ classes: ['build'], mode: 'bullets', steps: 3 });
  chk('a bullet build says so, with its step count', !bullets.warn && /bullets/.test(bullets.text) && /3 steps/.test(bullets.text));
  const marked = describeBuild({ classes: [], mode: 'marked', steps: 1 });
  chk('a hand-marked build says so', !marked.warn && /class="build"/.test(marked.text) && /1 step,/.test(marked.text));
  const empty = describeBuild({ classes: ['build'], mode: 'empty', steps: 0 });
  chk('the class with nothing to reveal is a warning', empty.warn && /nothing to reveal/.test(empty.text));
  const none = describeBuild({ classes: ['lead'], mode: '', steps: 0 });
  chk('no build explains how to add one', !none.warn && /_class: build/.test(none.text));
  for (const typo of ['Build', 'builds', 'bulid', 'buld']) {
    chk(`"${typo}" is flagged as a near miss`, describeBuild({ classes: [typo], mode: '', steps: 0 }).warn);
  }
  for (const fine of ['lead', 'bold', 'bud', 'invert']) {
    chk(`"${fine}" is not`, !describeBuild({ classes: [fine], mode: '', steps: 0 }).warn);
  }
  chk('nothing to describe is nothing', describeBuild(undefined).text === '');
}

if (!ok) process.exit(1);
console.log('all deck build checks passed');
