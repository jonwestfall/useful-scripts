// Run with:  node podium/test/protocol.test.mjs
// Pure state-machine tests - no DOM, no network.
import { initialState, applyCommand, timerRemaining, inkSurfaceKey } from '../assets/js/protocol.js';
const s = initialState();
let ok = true;
const chk = (label, cond) => { if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label); };
const strokesOf = (state) => state.ink.bySurface[inkSurfaceKey(state.program)]?.strokes || [];

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

// --- ink: per-surface, not one global sheet ---------------------------------
applyCommand(s, {op:'stage', item:{type:'whiteboard', bg:'#12261f'}});
applyCommand(s, {op:'ink', id:'s1', pts:[[0.1,0.1]], color:'#fff'});
chk('ink without action is a no-op on strokes', strokesOf(s).length === 0);
applyCommand(s, {op:'ink', action:'begin', id:'s1', pts:[[0.1,0.1]]});
applyCommand(s, {op:'ink', action:'points', id:'s1', pts:[[0.2,0.2]]});
chk('ink stroke builds on the current surface', strokesOf(s).length === 1 && strokesOf(s)[0].pts.length === 2);

applyCommand(s, {op:'stage', item:{type:'timer', title:'Timer'}});
chk('switching to unrelated content shows a blank surface, not the old strokes', strokesOf(s).length === 0);

applyCommand(s, {op:'stage', item:{type:'whiteboard', bg:'#12261f'}});
chk('returning to the same board restores its strokes', strokesOf(s).length === 1);
applyCommand(s, {op:'ink', action:'clear'});
chk('clear wipes only the current surface', strokesOf(s).length === 0);

applyCommand(s, {op:'stage', item:{type:'deck', deckId:'notes-deck', slideCount:3, title:'Notes'}});
applyCommand(s, {op:'ink', action:'begin', id:'d1', pts:[[0.3,0.3]]});
applyCommand(s, {op:'nav', dir:'next'});
chk('a different slide of the same deck is a different surface', strokesOf(s).length === 0);
applyCommand(s, {op:'nav', dir:'prev'});
chk('going back to that slide restores its ink', strokesOf(s).length === 1);

// --- freeze protects what the room is looking at, not the audio ------------
applyCommand(s, {op:'stage', item:{type:'deck', deckId:'lecture', slideCount:5, title:'Lecture'}});
applyCommand(s, {op:'freeze', on:true});
applyCommand(s, {op:'nav', dir:'next'});
chk('Next while frozen does not move the visible slide', s.program.slide === 0);
chk('Next while frozen quietly clones the program into a safe-to-browse preview', s.preview && s.preview.type === 'deck' && s.preview.slide === 1);
applyCommand(s, {op:'nav', dir:'next'});
chk('further paging while frozen continues to advance only the cued copy', s.program.slide === 0 && s.preview.slide === 2);
applyCommand(s, {op:'take'});
chk('taking the cued copy is what actually changes the screen', s.program.slide === 2 && s.frozen === false);

applyCommand(s, {op:'stage', item:{type:'audio', src:'music.mp3'}});
applyCommand(s, {op:'freeze', on:true});
chk('audio keeps playing once frozen', s.program.playing === true);
applyCommand(s, {op:'media', action:'toggle'});
chk('pause while frozen still reaches the program item, not a cue', s.program.playing === false && s.preview === null);
applyCommand(s, {op:'media', action:'toggle'});
chk('and resumes the same way', s.program.playing === true);
applyCommand(s, {op:'media', action:'seek', value:10});
chk('seeking while frozen also targets the program item directly', s.program.seekTo === 10 && s.preview === null);
applyCommand(s, {op:'freeze', on:false});

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

// --- builds: progressive bullet reveal within a slide -----------------------
applyCommand(s, {op:'stage', item:{type:'deck', deckId:'built', slideCount:3, fragments:[2,0,1], title:'Built'}});
chk('a fresh slide starts with no fragments revealed', s.program.slide === 0 && s.program.step === 0);
applyCommand(s, {op:'nav', dir:'next'});
chk('Next reveals the first fragment instead of moving slides', s.program.slide === 0 && s.program.step === 1);
applyCommand(s, {op:'nav', dir:'next'});
chk('and the second', s.program.slide === 0 && s.program.step === 2);
applyCommand(s, {op:'nav', dir:'next'});
chk('once all fragments are shown, Next finally advances the slide', s.program.slide === 1 && s.program.step === 0);
applyCommand(s, {op:'nav', dir:'next'});
chk('a slide with zero fragments just advances immediately', s.program.slide === 2 && s.program.step === 0);
applyCommand(s, {op:'nav', dir:'prev'});
chk('Previous steps back into the prior slide fully built, not from scratch', s.program.slide === 1 && s.program.step === 0);
applyCommand(s, {op:'nav', dir:'prev'});
chk('and Previous again walks back into slide 0 fully revealed', s.program.slide === 0 && s.program.step === 2);
applyCommand(s, {op:'nav', dir:'goto', value:0});
chk('jumping via a thumbnail lands fully revealed, not bullet-by-bullet', s.program.step === 2);

chk('unknown command ignored', applyCommand(s, {op:'nope'}) === false);
console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
