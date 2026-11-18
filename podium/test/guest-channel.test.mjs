// The guest clicker's channel (Issue #336): what a guest link opens, and what
// the display takes from it. A guest link used to carry the room and the full
// passphrase, so editing guest.html to control.html in it made a full
// controller. Now it names the display's own guest room and key, and the
// display passes on only a clicker's commands.
//
//   node podium/test/guest-channel.test.mjs

import { guestChannel, isGuestRoom, isViewRoom, guestCommand, guestLaser, guestState, applyCommand, initialState } from '../assets/js/protocol.js';

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('-- the channel --');
const cfg = { room: 'psy415', passphrase: 'the class secret', guestId: 'Ab3_dEf-90xyZ123', guestKey: 'k'.repeat(32) };
const channel = guestChannel(cfg);
ok('its own room, named by the display\'s guest id', channel.room === 'guest.Ab3_dEf-90xyZ123');
ok('and its own key, not the class\'s passphrase', channel.passphrase === cfg.guestKey && channel.passphrase !== cfg.passphrase);
ok('nothing derived from the class\'s room in either', !JSON.stringify(channel).includes('psy415'));
ok('a display that never made one has none', guestChannel({ room: 'r', passphrase: 'p' }) === null);
ok('a guest room is recognised', isGuestRoom(channel.room));
ok('and is not a viewer room, nor a viewer room a guest room', !isViewRoom(channel.room) && !isGuestRoom('view.Ab3_dEf-90xyZ123'));
ok('a class room is not a guest room', !isGuestRoom('psy415') && !isGuestRoom('guest.') && !isGuestRoom('guest.short') && !isGuestRoom('guest.has space here'));

console.log('\n-- what the display takes from a guest --');
ok('Next', same(guestCommand({ t: 'cmd', op: 'nav', dir: 'next', where: 'program' }), { op: 'nav', dir: 'next', where: 'program' }));
ok('Previous', same(guestCommand({ t: 'cmd', op: 'nav', dir: 'prev' }), { op: 'nav', dir: 'prev', where: 'program' }));
ok('Next always means what the room sees, never the cued preview', guestCommand({ t: 'cmd', op: 'nav', dir: 'next', where: 'preview' }).where === 'program');
ok('a jump to any slide is not a clicker\'s', guestCommand({ t: 'cmd', op: 'nav', dir: 'goto', value: 40 }) === null);
ok('Blank, as a toggle', same(guestCommand({ t: 'cmd', op: 'blank' }), { op: 'blank' }));
ok('Blank, on or off', same(guestCommand({ t: 'cmd', op: 'blank', on: true }), { op: 'blank', on: true }));
ok('a non-boolean "on" is dropped rather than passed on', same(guestCommand({ t: 'cmd', op: 'blank', on: 'yes' }), { op: 'blank' }));
ok('Play/Pause', same(guestCommand({ t: 'cmd', op: 'media', action: 'toggle' }), { op: 'media', action: 'toggle', where: 'program' }));
ok('but not a seek, a loop, or the cued preview\'s media', guestCommand({ t: 'cmd', op: 'media', action: 'seek', value: 9 }) === null
  && guestCommand({ t: 'cmd', op: 'media', action: 'setLoop', value: true }) === null
  && guestCommand({ t: 'cmd', op: 'media', action: 'toggle', where: 'preview' }).where === 'program');
for (const op of ['stage', 'take', 'freeze', 'layout', 'ink', 'clearInk', 'poll', 'music', 'watermark', 'timer', 'focus', 'say', 'previewMode', 'autoSaveInk']) {
  ok(`nothing else: ${op}`, guestCommand({ t: 'cmd', op, item: { type: 'text', text: 'hijacked' } }) === null);
}
ok('extra fields on an allowed command never get through', same(guestCommand({ t: 'cmd', op: 'nav', dir: 'next', item: { type: 'text' }, panel: 3, from: 'x' }), { op: 'nav', dir: 'next', where: 'program' }));
ok('a message that is not a command is no command', guestCommand({ t: 'deck', op: 'nav', dir: 'next' }) === null && guestCommand(null) === null);

console.log('\n-- and its laser --');
ok('a dot, clamped to the slide, in one of the three colours', same(guestLaser({ t: 'laser', on: true, x: 1.7, y: -2, color: 'green', panel: 3, size: 900 }), { t: 'laser', on: true, x: 1, y: 0, color: 'green' }));
ok('any other colour is red', guestLaser({ t: 'laser', on: true, x: 0.5, y: 0.5, color: 'url(javascript:x)' }).color === 'red');
ok('off is off', same(guestLaser({ t: 'laser', on: false, x: 'whatever' }), { t: 'laser', on: false }));
ok('a dot with no position is nothing', guestLaser({ t: 'laser', on: true, x: 'a', y: 1 }) === null);
ok('a spotlight is not a laser', guestLaser({ t: 'spotlight', on: true, x: 0.5, y: 0.5 }) === null);

console.log('\n-- what a guest is told --');
const state = initialState();
applyCommand(state, { op: 'stage', item: { type: 'deck', title: 'Weighing the Evidence', deckId: 'd1', slideCount: 9, videoSlides: [3], notes: ['private'] }, where: 'program' });
state.blank = true;
state.preview = { type: 'text', title: 'Cued and secret', text: 'quiz answers' };
const told = guestState(state, { playing: true, time: 12, duration: 40 });
ok('what is on the projector: its kind and title', told.state.program.type === 'deck' && told.state.program.title === 'Weighing the Evidence');
ok('and enough of a deck to know a video slide', told.state.program.slide === 0 && same(told.state.program.videoSlides, [3]));
ok('whether it is blanked, and whether something plays', told.state.blank === true && told.telemetry.playing === true);
ok('nothing else: not the cue, the notes, the deck id or the other panels', !/Cued and secret|quiz answers|private|"d1"|deckId|notes/.test(JSON.stringify(told)) && same(told.state.panels, []));
ok('a state message, as guest.html reads it', told.t === 'state' && told.state.focus === 0);

if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
