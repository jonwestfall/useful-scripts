// Run with:  node podium/test/protocol.test.mjs
// Pure state-machine tests - no DOM, no network.
import { initialState, applyCommand, timerRemaining } from '../assets/js/protocol.js';
const s = initialState();
let ok = true;
const chk = (label, cond) => { if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label); };

applyCommand(s, {op:'stage', item:{type:'image', src:'a.png'}});
chk('unfrozen pick goes live', s.program.type === 'image' && s.preview === null);

applyCommand(s, {op:'freeze', on:true});
applyCommand(s, {op:'stage', item:{type:'text', body:'secret'}});
chk('frozen pick lands in preview', s.program.type === 'image' && s.preview.type === 'text');
chk('program untouched while frozen', s.program.src === 'a.png');

applyCommand(s, {op:'take'});
chk('take promotes preview', s.program.type === 'text' && s.preview === null);
chk('take clears freeze', s.frozen === false);

applyCommand(s, {op:'stage', item:{type:'video', src:'v.mp4'}});
chk('video defaults to playing', s.program.playing === true);
applyCommand(s, {op:'media', action:'toggle'});
chk('toggle pauses', s.program.playing === false);
applyCommand(s, {op:'media', action:'seek', value:42});
chk('seek records nonce', s.program.seekTo === 42 && s.program.seekNonce === 1);

applyCommand(s, {op:'stage', item:{type:'pdf', src:'x.pdf'}});
applyCommand(s, {op:'nav', dir:'next'});
applyCommand(s, {op:'nav', dir:'next'});
chk('pdf paging', s.program.page === 3);
applyCommand(s, {op:'nav', dir:'prev'});
chk('pdf paging back', s.program.page === 2);

applyCommand(s, {op:'timer', action:'start', seconds:300, label:'Group work'});
chk('timer runs', s.timer.running && timerRemaining(s.timer) > 299000);
applyCommand(s, {op:'timer', action:'pause'});
const held = timerRemaining(s.timer);
chk('paused timer holds', !s.timer.running && held > 0 && timerRemaining(s.timer) === held);
applyCommand(s, {op:'timer', action:'resume'});
chk('resume restarts', s.timer.running);

applyCommand(s, {op:'ink', id:'s1', pts:[[0.1,0.1]], color:'#fff'});
chk('ink without action is a no-op on strokes', s.ink.strokes.length === 0);
applyCommand(s, {op:'ink', action:'begin', id:'s1', pts:[[0.1,0.1]]});
applyCommand(s, {op:'ink', action:'points', id:'s1', pts:[[0.2,0.2]]});
chk('ink stroke builds', s.ink.strokes.length === 1 && s.ink.strokes[0].pts.length === 2);
applyCommand(s, {op:'ink', action:'clear'});
chk('ink clears', s.ink.strokes.length === 0);

applyCommand(s, {op:'volume', value:0.5});
chk('volume', s.volume === 0.5);
applyCommand(s, {op:'blank', on:true});
chk('blank on', s.blank === true);
applyCommand(s, {op:'stage', item:{type:'image', src:'b.png'}});
chk('staging to program clears blank', s.blank === false);

applyCommand(s, {op:'stage', item:{type:'deck', deckId:'abc', slideCount:13, title:'Day 6'}});
chk('deck starts on slide 0', s.program.slide === 0 && s.program.slideCount === 13);
applyCommand(s, {op:'nav', dir:'next'});
applyCommand(s, {op:'nav', dir:'next'});
chk('deck advances', s.program.slide === 2);
applyCommand(s, {op:'nav', dir:'prev'});
chk('deck goes back', s.program.slide === 1);
applyCommand(s, {op:'nav', dir:'goto', value:12});
chk('deck jumps to a slide', s.program.slide === 12);
applyCommand(s, {op:'nav', dir:'next'});
chk('deck parks on the last slide instead of running past the end', s.program.slide === 12);
applyCommand(s, {op:'nav', dir:'goto', value:0});
applyCommand(s, {op:'nav', dir:'prev'});
chk('deck parks on the first slide going backwards', s.program.slide === 0);

chk('unknown command ignored', applyCommand(s, {op:'nope'}) === false);
console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
