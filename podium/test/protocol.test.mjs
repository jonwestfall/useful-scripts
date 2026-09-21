// Run with:  node podium/test/protocol.test.mjs
// Pure state-machine tests - no DOM, no network.
import { initialState, applyCommand, timerRemaining, timerById, inkSurfaceKey,
  inkDigest, inkDigestsAgree, applyInkAction, distToSegmentSquared, strokeHitTest, MAX_TIMERS, BUILD, VERSION, COMMIT, versionStamp } from '../assets/js/protocol.js';
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

{
  // A layout change is cued the same way content is, while frozen - and
  // TAKE has to apply it even when nothing else is cued alongside it.
  applyCommand(s, {op:'layout', mode:'2h'});
  chk('unfrozen layout applies immediately', s.layout === '2h' && s.previewLayout === null);

  applyCommand(s, {op:'freeze', on:true});
  applyCommand(s, {op:'layout', mode:'4'});
  chk('frozen layout change is cued, not applied', s.layout === '2h' && s.previewLayout === '4');

  applyCommand(s, {op:'take'});
  chk('take applies a cued layout with no content change pending', s.layout === '4' && s.previewLayout === null);
  chk('and clears freeze the same as any other take', s.frozen === false);

  applyCommand(s, {op:'freeze', on:true});
  applyCommand(s, {op:'layout', mode:'2h'});
  applyCommand(s, {op:'clear'});
  chk('clearing the cue abandons a cued layout too', s.previewLayout === null);
  chk('and the live layout never moved', s.layout === '4');

  applyCommand(s, {op:'stage', item:{type:'image', src:'b.png'}});
  applyCommand(s, {op:'layout', mode:'3'});
  chk('content and a layout change can be cued together', s.preview?.src === 'b.png' && s.previewLayout === '3');
  applyCommand(s, {op:'take'});
  chk('one take applies both at once', s.program.src === 'b.png' && s.layout === '3');

  applyCommand(s, {op:'freeze', on:false});
  applyCommand(s, {op:'layout', mode:'single'});
}

applyCommand(s, {op:'stage', item:{type:'video', src:'v.mp4'}});
chk('video defaults to playing', s.program.playing === true);
applyCommand(s, {op:'media', action:'toggle'});
chk('toggle pauses', s.program.playing === false);
applyCommand(s, {op:'media', action:'seek', value:42});
chk('seek records nonce', s.program.seekTo === 42 && s.program.seekNonce === 1);
applyCommand(s, {op:'media', action:'setLoop', value:true});
chk('loop can be turned on', s.program.loop === true);
applyCommand(s, {op:'media', action:'setLoop', value:false});
chk('and back off', s.program.loop === false);
applyCommand(s, {op:'media', action:'restart'});
chk('restart seeks to zero and resumes playing, not just seeks a paused clip',
  s.program.seekTo === 0 && s.program.seekNonce === 2 && s.program.playing === true);

applyCommand(s, {op:'stage', item:{type:'pdf', src:'x.pdf'}});
applyCommand(s, {op:'nav', dir:'next'});
applyCommand(s, {op:'nav', dir:'next'});
chk('pdf paging', s.program.page === 3);
applyCommand(s, {op:'nav', dir:'prev'});
chk('pdf paging back', s.program.page === 2);

// Zooming into a PDF page (Issue #82)
chk('a freshly staged pdf starts at zoom 1, centered', s.program.zoom === 1 && s.program.panX === 0.5 && s.program.panY === 0.5);
applyCommand(s, {op:'zoom', action:'set', zoom:2, panX:0.5, panY:0.5});
chk('zoom sets the level', s.program.zoom === 2);
applyCommand(s, {op:'zoom', action:'set', zoom:10});
chk('zoom is capped at 4', s.program.zoom === 4);
applyCommand(s, {op:'zoom', action:'set', zoom:2, panX:0, panY:0});
chk('pan is clamped so the view never pans off the page (half the window is 1/(2*2) = 0.25 from either edge)',
  s.program.panX === 0.25 && s.program.panY === 0.25);
applyCommand(s, {op:'zoom', action:'set', zoom:2, panX:1, panY:1});
chk('clamped the other way too', s.program.panX === 0.75 && s.program.panY === 0.75);
applyCommand(s, {op:'zoom', action:'reset'});
chk('reset returns to zoom 1, centered', s.program.zoom === 1 && s.program.panX === 0.5 && s.program.panY === 0.5);
applyCommand(s, {op:'stage', item:{type:'text', body:'not a pdf'}});
const zoomedNonPdf = applyCommand(s, {op:'zoom', action:'set', zoom:2});
chk('zoom does nothing to a non-pdf item', zoomedNonPdf === false);

applyCommand(s, {op:'timer', action:'start', seconds:300, label:'Group work'});
chk('timer runs', s.timers[0].running && timerRemaining(s.timers[0]) > 299000);
applyCommand(s, {op:'timer', action:'pause'});
const held = timerRemaining(s.timers[0]);
chk('paused timer holds', !s.timers[0].running && held > 0 && timerRemaining(s.timers[0]) === held);
applyCommand(s, {op:'timer', action:'resume'});
chk('resume restarts', s.timers[0].running);

// More than one clock. A command with no id means "the countdown", which is
// what every timer item made before this still means.
chk('a command with no id drives the first', timerById(s, undefined) === s.timers[0]);
chk('so does one naming a timer that is gone', timerById(s, 'vanished') === s.timers[0]);
applyCommand(s, {op:'timer', action:'add', id:'brk', label:'Break', seconds:600});
chk('a second timer can be added, named by the caller', s.timers.length === 2 && s.timers[1].id === 'brk');
chk('and it does not start itself', !s.timers[1].running && timerRemaining(s.timers[1]) === 600000);
applyCommand(s, {op:'timer', action:'start', id:'brk', seconds:60});
chk('the two run independently', s.timers[0].running && s.timers[1].running
  && timerRemaining(s.timers[1]) < timerRemaining(s.timers[0]));
applyCommand(s, {op:'timer', action:'stop', id:'brk'});
chk('stopping one leaves the other alone', !s.timers[1].running && s.timers[0].running);
chk('a duplicate id is refused rather than shadowing the first',
  applyCommand(s, {op:'timer', action:'add', id:'brk'}) === false && s.timers.length === 2);
while (s.timers.length < MAX_TIMERS) applyCommand(s, {op:'timer', action:'add'});
chk(`the set is capped at ${MAX_TIMERS}`, applyCommand(s, {op:'timer', action:'add'}) === false && s.timers.length === MAX_TIMERS);
applyCommand(s, {op:'timer', action:'remove', id:'brk'});
chk('one can be removed', s.timers.length === MAX_TIMERS - 1 && !s.timers.some((t) => t.id === 'brk'));
chk('but never the first - everything with no id falls back to it',
  applyCommand(s, {op:'timer', action:'remove', id:s.timers[0].id}) === false && s.timers.length === MAX_TIMERS - 1);
chk('two panels showing two countdowns are two ink surfaces',
  inkSurfaceKey({type:'timer', timerId:'a'}) !== inkSurfaceKey({type:'timer', timerId:'b'}));
chk('a black panel keeps its own ink surface, not one keyed by the item\'s own (re-assignable) key',
  inkSurfaceKey({type:'black', title:'Black'}) === inkSurfaceKey({type:'black', title:'Black', key:'k1'})
  && inkSurfaceKey({type:'black'}) === inkSurfaceKey({type:'black', key:'k2'}));
chk('the same text sign keeps its ink across being re-staged with a new key',
  inkSurfaceKey({type:'text', body:'Back in 5'}) === inkSurfaceKey({type:'text', body:'Back in 5', key:'k1'})
  && inkSurfaceKey({type:'text', body:'Back in 5'}) !== inkSurfaceKey({type:'text', body:'Different message'}));
chk('the same QR code keeps its ink across being re-staged with a new key',
  inkSurfaceKey({type:'qr', data:'https://a'}) === inkSurfaceKey({type:'qr', data:'https://a', key:'k1'})
  && inkSurfaceKey({type:'qr', data:'https://a'}) !== inkSurfaceKey({type:'qr', data:'https://b'}));
applyCommand(s, {op:'timer', action:'define', timers:[{id:'grp', label:'Group work', seconds:480}, {id:'brk2', label:'Break', seconds:300}]});
chk('loading a lecture plan replaces the whole set, keeping the ids it names',
  s.timers.length === 2 && s.timers[0].id === 'grp' && s.timers[1].label === 'Break'
  && timerRemaining(s.timers[0]) === 480000 && !s.timers[0].running);
applyCommand(s, {op:'timer', action:'define', timers:[{id:'same', label:'One', seconds:60}, {id:'same', label:'Two', seconds:120}]});
chk('two clocks cannot share an id - the second would be unreachable',
  s.timers.length === 1 && s.timers[0].label === 'One');
applyCommand(s, {op:'timer', action:'define', timers:[{id:'grp', label:'Group work', seconds:480}, {id:'brk2', label:'Break', seconds:300}]});
chk('an empty define is refused rather than leaving no clock at all',
  applyCommand(s, {op:'timer', action:'define', timers:[]}) === false && s.timers.length === 2);
applyCommand(s, {op:'timer', action:'start', id:'grp'});

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
applyCommand(s, {op:'contentVolume', value:0.3});
chk('the Mixer\'s content channel is its own field, not the master', s.contentVolume === 0.3 && s.volume === 0.5);
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

// --- split-screen panels: B/C/D are direct and immediate, unlike A ---------
chk('starts in single-panel layout', s.layout === 'single' && s.focus === 0);
chk('switching to an unknown layout is ignored', applyCommand(s, {op:'layout', mode:'nonsense'}) === false && s.layout === 'single');
applyCommand(s, {op:'layout', mode:'3'});
chk('layout switches', s.layout === '3');
applyCommand(s, {op:'panel', index:0, item:{type:'timer', label:'Group work'}});
chk('a panel is set directly - no preview, no freeze', s.panels[0].type === 'timer' && s.preview === null);
applyCommand(s, {op:'freeze', on:true});
applyCommand(s, {op:'panel', index:1, item:{type:'text', body:'Instructions'}});
chk('freeze does not block setting a panel either', s.panels[1].type === 'text');
applyCommand(s, {op:'freeze', on:false});

chk('focusing a panel out of range for the current layout is ignored', applyCommand(s, {op:'focus', index:5}) === false && s.focus === 0);
applyCommand(s, {op:'focus', index:1});
chk('focus moves to B', s.focus === 1);
const programBefore = s.program.type;
applyCommand(s, {op:'panel', index:0, item:{type:'deck', deckId:'panel-deck', slideCount:5, title:'Panel deck'}});
applyCommand(s, {op:'nav', dir:'next'});
chk('Next while focused on B advances B, not A', s.panels[0].slide === 1 && s.program.type === programBefore);
applyCommand(s, {op:'freeze', on:true});
applyCommand(s, {op:'nav', dir:'next'});
chk('freeze does not protect a focused B/C/D from nav either - nothing to protect, it was never cued', s.panels[0].slide === 2);
applyCommand(s, {op:'freeze', on:false});
applyCommand(s, {op:'ink', action:'begin', id:'p1', pts:[[0.5,0.5]]});
const bSurface = inkSurfaceKey(s.panels[0]);
chk('ink while focused on B lands on B\'s own surface', s.ink.bySurface[bSurface]?.strokes.length === 1);
applyCommand(s, {op:'focus', index:0});
chk('focus back to A', s.focus === 0);
applyCommand(s, {op:'layout', mode:'single'});
chk('dropping back to single resets an out-of-range focus (already 0 here, but the guard exists)', s.focus === 0);
applyCommand(s, {op:'layout', mode:'4'});
applyCommand(s, {op:'focus', index:3});
applyCommand(s, {op:'layout', mode:'2h'});
chk('shrinking the layout falls focus back to A rather than pointing at a panel no longer shown', s.focus === 0);

// --- ink on the wire ---------------------------------------------------------
// The heartbeat used to carry every stroke on the current surface, twice a
// second. A hundred strokes of sixty points is 243 KB of JSON, which seals past
// what any relay will carry: the self-hosted one closes the socket with 1009,
// the transport reconnects, and the next heartbeat closes it again.
{
  const ink = initialState();
  applyCommand(ink, {op:'stage', item:{type:'whiteboard', bg:'#fff'}});
  const key = inkSurfaceKey(ink.program);
  applyCommand(ink, {op:'ink', action:'begin', id:'s1', pts:[[0.5488135039273248, 0.7151893663724195]]});
  const [x, y] = ink.ink.bySurface[key].strokes[0].pts[0];
  chk('points are rounded to four decimals on the way in (0.19px on a 1920px projector)',
    x === 0.5488 && y === 0.7152);
  chk('which is what a point costs on the wire, down from eighteen characters',
    JSON.stringify([x, y]).length <= 16);

  applyCommand(ink, {op:'ink', action:'points', id:'s1', pts:[[NaN, 0.5], [0.2, 'nope'], [0.3, 0.4]]});
  chk('a point that is not a pair of numbers is dropped rather than serialised as null',
    ink.ink.bySurface[key].strokes[0].pts.length === 2);

  applyCommand(ink, {op:'ink', action:'points', id:'s1', pts: Array.from({length: 5000}, () => [0.1, 0.2])});
  chk('one stroke cannot grow without limit - a pen left down is bounded now, not just the stroke count',
    ink.ink.bySurface[key].strokes[0].pts.length === 3000);

  // A late batch addressed to an older stroke must not truncate the newest one.
  applyCommand(ink, {op:'ink', action:'begin', id:'s2', pts:[[0.1, 0.1]]});
  applyCommand(ink, {op:'ink', action:'points', id:'s1', pts:[[0.9, 0.9]]});
  chk('a late batch lands on the stroke it names, and caps that one',
    ink.ink.bySurface[key].strokes[1].pts.length === 1 && ink.ink.bySurface[key].strokes[0].pts.length === 3000);
}

// The digest is what the heartbeat carries instead.
{
  const a = [{id:'1', pts:[[0,0],[1,1]]}, {id:'2', pts:[[0,0]]}];
  chk('the digest counts strokes, and the points of every stroke but the last',
    inkDigest(a).n === 2 && inkDigest(a).p === 2);
  chk('so a stroke still being drawn does not make two devices disagree',
    inkDigestsAgree(inkDigest(a), inkDigest([a[0], {id:'2', pts:[[0,0],[0.5,0.5],[1,1]]}])));
  chk('while a finished stroke nobody else has, does',
    !inkDigestsAgree(inkDigest(a), inkDigest([a[0]])));
  chk('and so does an undo followed by a different stroke',
    !inkDigestsAgree(inkDigest(a), inkDigest([{id:'3', pts:[[0,0],[1,1],[2,2]]}, {id:'2', pts:[[0,0]]}])));
  chk('an empty surface agrees with an empty surface', inkDigestsAgree(inkDigest([]), inkDigest([])));
  chk('a missing digest never counts as agreement', !inkDigestsAgree(inkDigest([]), undefined));
}

// Both ends run the same applier, so a controller following its peers' strokes
// cannot drift from the display that owns them.
{
  const mine = [];
  const theirs = [];
  const cmds = [
    {action:'begin', id:'a', color:'#f00', width:4, pts:[[0.1,0.1]]},
    {action:'points', id:'a', pts:[[0.2,0.2],[0.3,0.3]]},
    {action:'begin', id:'b', pts:[[0.4,0.4]]},
    {action:'undo'},
  ];
  for (const cmd of cmds) {
    applyInkAction(mine, cmd, {color:'#000', width:1});
    applyInkAction(theirs, cmd, {color:'#000', width:1});
  }
  chk('the shared applier gives both ends the same strokes', JSON.stringify(mine) === JSON.stringify(theirs));
  chk('and it honours the sender\u2019s pen over the local default', mine[0].color === '#f00' && mine[0].width === 4);
  chk('undo took the second stroke, not the first', mine.length === 1 && mine[0].id === 'a');
  applyInkAction(mine, {action:'clear'});
  chk('clear empties in place rather than replacing the array', mine.length === 0);
  chk('an unknown ink action changes nothing', applyInkAction(mine, {action:'sneeze'}) === false);

  // Highlighter and erase
  applyInkAction(mine, {action:'begin', id:'h1', pts:[[0.1,0.1]], highlighter:true});
  chk('highlighter stroke retains highlighter flag', mine[0].highlighter === true);
  applyInkAction(mine, {action:'begin', id:'s1', pts:[[0.2,0.2]]});
  applyInkAction(mine, {action:'begin', id:'s2', pts:[[0.3,0.3]]});
  chk('erase by single id removes that stroke', applyInkAction(mine, {action:'erase', id:'s1'}) === true && mine.length === 2 && !mine.find(s => s.id === 's1'));
  chk('erase non-existent id returns false', applyInkAction(mine, {action:'erase', id:'nonexistent'}) === false && mine.length === 2);
  chk('erase by multiple ids removes matching strokes', applyInkAction(mine, {action:'erase', ids:['h1', 's2']}) === true && mine.length === 0);

  // Distance and hit-testing pure functions
  chk('distToSegmentSquared on segment is 0', distToSegmentSquared(5, 5, 0, 5, 10, 5) === 0);
  chk('distToSegmentSquared beyond endpoint', distToSegmentSquared(15, 5, 0, 5, 10, 5) === 25);
  const testStroke = { id: 't1', width: 6, pts: [[0.1, 0.1], [0.9, 0.1]] };
  chk('strokeHitTest hits segment in middle', strokeHitTest(testStroke, 500, 100, 1000, 1000, 18) === true);
  chk('strokeHitTest misses distant point', strokeHitTest(testStroke, 500, 500, 1000, 1000, 18) === false);
  chk('strokeHitTest misses outside bounding box', strokeHitTest(testStroke, 50, 50, 1000, 1000, 10) === false);
}

{
  // An automated set: staged like any other item, then advanced, jumped and
  // paused on its own, independent of everything above.
  const entries = [
    {item:{type:'text', body:'1'}, seconds:20},
    {item:{type:'text', body:'2'}, seconds:5},
    {item:{type:'text', body:'3'}, seconds:100},
  ];
  applyCommand(s, {op:'stage', item:{type:'set', title:'My set', mode:'sequential', entries}});
  chk('a set stages onto program like any other item', s.program.type === 'set' && s.program.entries.length === 3);
  chk('starts on entry 0, not paused', s.program.index === 0 && s.program.paused === false);

  applyCommand(s, {op:'set', action:'advance', panel:0});
  applyCommand(s, {op:'set', action:'advance', panel:0});
  applyCommand(s, {op:'set', action:'advance', panel:0});
  chk('sequential advance steps forward and wraps', s.program.index === 0);

  applyCommand(s, {op:'set', action:'select', index:2});
  chk('select jumps directly', s.program.index === 2);
  const key2 = inkSurfaceKey(s.program);
  applyCommand(s, {op:'set', action:'select', index:0});
  chk('ink is scoped per entry, not per set', inkSurfaceKey(s.program) !== key2);

  applyCommand(s, {op:'set', action:'pause'});
  chk('pause freezes it and records the time left', s.program.paused && s.program.remainingMs > 0);
  applyCommand(s, {op:'set', action:'advance', panel:0});
  chk('advance is a no-op while paused', s.program.index === 0 && s.program.paused);
  applyCommand(s, {op:'set', action:'resume'});
  chk('resume clears paused', s.program.paused === false);

  applyCommand(s, {op:'stage', item:{
    type:'set', mode:'random',
    entries: Array.from({length:5}, (_, i) => ({item:{type:'text', body:String(i)}, seconds:5})),
  }});
  const seen = [s.program.index];
  for (let i = 0; i < 4; i++) { applyCommand(s, {op:'set', action:'advance', panel:0}); seen.push(s.program.index); }
  chk('random mode covers every entry before repeating', new Set(seen).size === 5);
  chk('and never repeats back to back', seen.every((v, i) => i === 0 || v !== seen[i - 1]));

  applyCommand(s, {op:'stage', item:{
    type:'set', entries: Array.from({length:80}, (_, i) => ({item:{type:'text', body:String(i)}, seconds:5})),
  }});
  chk('entries are capped rather than growing without bound', s.program.entries.length === 50);

  chk('advance on an empty panel is a no-op, not a throw', applyCommand(s, {op:'set', action:'advance', panel:3}) === false);
  chk('select out of range is rejected', applyCommand(s, {op:'set', action:'select', index:999}) === false);
}

applyCommand(s, {op:'stage', item:{
  type:'poll', pollId:'ABCD', token:'secret', kind:'choice',
  question:'Which bias is this?', options:['Construct','Method','Norming','Access'],
}});
chk('a fresh poll starts open, not yet revealed, with a zeroed tally',
  s.program.open === true && s.program.revealed === false && s.program.voters === 0
  && s.program.counts.length === 4 && s.program.counts.every((c) => c === 0));
chk('and shows its URL by default - showUrl defaults true unless explicitly turned off',
  s.program.showUrl === true);
chk('reveal is found by pollId, not by focus or where', applyCommand(s, {op:'poll', pollId:'ABCD', action:'reveal', value:true}));
chk('and it actually set revealed', s.program.revealed === true);
chk('a pollId nobody is running is simply rejected', applyCommand(s, {op:'poll', pollId:'ZZZZ', action:'reveal', value:true}) === false);
chk('an unknown poll action is rejected too', applyCommand(s, {op:'poll', pollId:'ABCD', action:'nope'}) === false);
const beforeReask = s.program.key;
applyCommand(s, {op:'stage', item:{
  type:'poll', pollId:'ABCD', token:'secret', kind:'choice',
  question:'Which bias is this?', options:['Construct','Method','Norming','Access'],
}});
chk('re-staging the identical question still keys ink by pollId, not by the fresh key a re-stage always gets',
  inkSurfaceKey({type:'poll', pollId:'ABCD'}) === inkSurfaceKey({type:'poll', pollId:'ABCD', key:s.program.key})
  && s.program.key !== beforeReask);

applyCommand(s, {op:'stage', item:{
  type:'poll', pollId:'WXYZ', token:'secret2', kind:'text', question:'One word for how that felt?',
  answers:['exposed', 'seen', 'fine actually'],
}});
chk('a fresh text poll starts with nothing hidden', s.program.hiddenAnswers.length === 0);
chk('hiding one answer by index is accepted', applyCommand(s, {op:'poll', pollId:'WXYZ', action:'hideAnswer', index:1, value:true}));
chk('and only that index is hidden', s.program.hiddenAnswers.length === 1 && s.program.hiddenAnswers[0] === 1);
chk('hiding it again is a no-op, not a duplicate', applyCommand(s, {op:'poll', pollId:'WXYZ', action:'hideAnswer', index:1, value:true})
  && s.program.hiddenAnswers.length === 1);
chk('unhiding clears it', applyCommand(s, {op:'poll', pollId:'WXYZ', action:'hideAnswer', index:1, value:false})
  && s.program.hiddenAnswers.length === 0);
chk('an out-of-range index is rejected', applyCommand(s, {op:'poll', pollId:'WXYZ', action:'hideAnswer', index:99, value:true}) === false);
chk('a negative index is rejected too', applyCommand(s, {op:'poll', pollId:'WXYZ', action:'hideAnswer', index:-1, value:true}) === false);
chk('a choice poll has nothing to hide - hideAnswer on ABCD is rejected', applyCommand(s, {op:'poll', pollId:'ABCD', action:'hideAnswer', index:0, value:true}) === false);

applyCommand(s, {op:'stage', item:{
  type:'poll', pollId:'WXYZ', token:'secret2', kind:'text', question:'One word for how that felt?',
  answers:['exposed'], hiddenAnswers:[0, 5, -1],
}});
chk('normalizing drops a hiddenAnswers index that does not fit the answers it arrived with',
  s.program.hiddenAnswers.length === 1 && s.program.hiddenAnswers[0] === 0);

applyCommand(s, {op:'stage', item:{
  type:'poll', pollId:'QRST', token:'secret3', kind:'choice', question:'Show the URL?', options:['Yes','No'], showUrl:false,
}});
chk('an explicit showUrl:false is honoured, not overridden by the default', s.program.showUrl === false);

applyCommand(s, {op:'music', action:'load', tracks:[{src:'content/audio/test.mp3', title:'Test Track'}], name:'Test'});
chk('music load defaults to not playing', s.music.tracks.length === 1 && s.music.playing === false);
applyCommand(s, {op:'music', action:'load', tracks:[{src:'content/audio/test.mp3', title:'Test Track'}], name:'Test', play:true});
chk('music load with play: true auto-plays', s.music.playing === true);

chk('music pauseQueue defaults to false', initialState().music.pauseQueue === false);
applyCommand(s, {op:'music', action:'load', tracks:[{src:'content/audio/t1.mp3', title:'Track 1'}, {src:'content/audio/t2.mp3', title:'Track 2'}], play:true});
chk('queue begins playing first track', s.music.index === 0 && s.music.playing === true);
applyCommand(s, {op:'music', action:'next', auto:true});
chk('default behavior auto-plays next track in queue', s.music.index === 1 && s.music.playing === true);
applyCommand(s, {op:'music', action:'pauseQueue', value:true});
chk('pauseQueue can be enabled', s.music.pauseQueue === true);
applyCommand(s, {op:'music', action:'next', auto:true});
chk('with pauseQueue enabled, queue pauses after current track finishes', s.music.index === 0 && s.music.playing === false);
applyCommand(s, {op:'music', action:'next'});
chk('manual next with pauseQueue enabled still plays', s.music.index === 1 && s.music.playing === true);
applyCommand(s, {op:'music', action:'pauseQueue', value:false});
chk('pauseQueue can be disabled', s.music.pauseQueue === false);

applyCommand(s, {op:'music', action:'seek', time: 75});
chk('music seek updates seekTo and seekNonce', s.music.seekTo === 75 && s.music.seekNonce === 1);
chk('music seek sets playing to true', s.music.playing === true);
applyCommand(s, {op:'music', action:'pause'});
chk('music pause pauses playback', s.music.playing === false);
applyCommand(s, {op:'music', action:'seek', time: 120});
chk('music seek resumes/restarts playback when paused', s.music.seekTo === 120 && s.music.seekNonce === 2 && s.music.playing === true);
applyCommand(s, {op:'music', action:'pause'});
applyCommand(s, {op:'music', action:'seek', time: 30, play: false});
chk('music seek with play:false does not restart playback', s.music.seekTo === 30 && s.music.seekNonce === 3 && s.music.playing === false);

const emptyMusic = initialState();
chk('music seek on empty queue returns false', applyCommand(emptyMusic, {op:'music', action:'seek', time: 10}) === false);

applyCommand(s, {op:'stage', item:{type:'trackend', title:'We begin in…', untilQueue:true}});
chk('trackend normalizes untilQueue flag', s.program.type === 'trackend' && s.program.untilQueue === true);
applyCommand(s, {op:'stage', item:{type:'trackend', title:'We begin in…'}});
chk('trackend defaults untilQueue to false', s.program.type === 'trackend' && s.program.untilQueue === false);

chk('BUILD is a number', typeof BUILD === 'number' && BUILD > 0);
chk('VERSION is a string', typeof VERSION === 'string' && VERSION.length > 0);
chk('COMMIT is a string', typeof COMMIT === 'string' && COMMIT.length > 0);
chk('versionStamp formats expected string', versionStamp().includes(`v${VERSION} · build ${BUILD}`));

chk('unknown command ignored', applyCommand(s, {op:'nope'}) === false);

{
  // Live captions (Issue #79) ride the same overlay bar a manually typed
  // caption uses, gated by overlay.live so a stale update from a device
  // whose captions were turned off elsewhere is rejected rather than
  // reviving the bar.
  const c = initialState();
  chk('captions start off', c.overlay.live === false && c.overlay.visible === false);

  chk('a caption update before "on" is rejected', applyCommand(c, {op:'caption', text:'too early'}) === false);
  chk('and touches nothing', c.overlay.text === '' && c.overlay.visible === false);

  applyCommand(c, {op:'caption', on:true});
  chk('caption on arms live mode without showing anything yet', c.overlay.live === true && c.overlay.visible === false);

  applyCommand(c, {op:'caption', text:'the mitochondria is the powerhouse of the cell'});
  chk('a recognized phrase shows on the bar', c.overlay.text === 'the mitochondria is the powerhouse of the cell' && c.overlay.visible === true);

  applyCommand(c, {op:'caption', text:''});
  chk('an empty phrase (silence) clears the bar but stays live', c.overlay.text === '' && c.overlay.visible === false && c.overlay.live === true);

  applyCommand(c, {op:'caption', text:'back again'});
  chk('and a later phrase reappears on its own, no re-arming needed', c.overlay.text === 'back again' && c.overlay.visible === true);

  applyCommand(c, {op:'overlay', visible:false});
  chk('a bare Hide clears the bar but does not end live mode', c.overlay.visible === false && c.overlay.live === true);
  applyCommand(c, {op:'caption', text:'still going'});
  chk('so the next phrase still gets through after a Hide', c.overlay.text === 'still going' && c.overlay.visible === true);

  applyCommand(c, {op:'overlay', text:'Chapter 4 · Working memory', visible:true});
  chk('typing a manual caption ends live mode', c.overlay.live === false && c.overlay.text === 'Chapter 4 · Working memory');
  chk('a caption update after that is rejected, not overwriting what was typed',
    applyCommand(c, {op:'caption', text:'ignored'}) === false && c.overlay.text === 'Chapter 4 · Working memory');

  applyCommand(c, {op:'caption', on:true});
  applyCommand(c, {op:'caption', text:'live again'});
  applyCommand(c, {op:'caption', on:false});
  chk('caption off clears the bar and ends live mode in one step',
    c.overlay.live === false && c.overlay.text === '' && c.overlay.visible === false);
}

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
