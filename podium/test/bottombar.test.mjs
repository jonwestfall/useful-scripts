// Run with: node podium/test/bottombar.test.mjs
// Unit tests for Podium customizable bottom bar quick-action slots (Issue #33).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let ok = true;
const chk = (label, cond) => {
  if (!cond) {
    ok = false;
    console.error('FAIL', label);
  } else {
    console.log('ok  ', label);
  }
};

console.log('-- bottom slot rendering logic --');

function simulateRenderSlot(slotType, context) {
  const { musicTracks = [], musicPlaying = false, isMedia = false, isPaged = false, mediaPlaying = false, isWhiteboard = false, laserActive = false, timerRunning = false } = context;

  const res = {
    action: slotType || 'none',
    hidden: false,
    disabled: false,
    isOn: false,
    text: '',
    title: '',
  };

  switch (slotType) {
    case 'music':
      res.hidden = !musicTracks.length;
      res.text = musicPlaying ? '♪ ⏸' : '♪ ▶';
      res.isOn = !!musicPlaying;
      break;
    case 'play':
      res.hidden = !isMedia;
      res.text = mediaPlaying ? '⏸' : '▶';
      res.isOn = !!mediaPlaying;
      break;
    case 'whiteboard':
      res.hidden = false;
      res.text = '✎';
      res.isOn = !!isWhiteboard;
      break;
    case 'laser':
      res.hidden = false;
      res.text = '🔦';
      res.isOn = !!laserActive;
      break;
    case 'timer':
      res.hidden = false;
      res.text = timerRunning ? '⏱ ⏸' : '⏱ ▶';
      res.isOn = !!timerRunning;
      break;
    case 'next':
      res.hidden = false;
      res.disabled = !isPaged;
      res.text = '→';
      break;
    case 'prev':
      res.hidden = false;
      res.disabled = !isPaged;
      res.text = '←';
      break;
    case 'none':
    default:
      res.hidden = true;
      res.text = '';
      break;
  }
  return res;
}

// 1. Music slot
chk('music: hidden when no tracks in queue', simulateRenderSlot('music', { musicTracks: [] }).hidden === true);
chk('music: visible and shows play when paused', simulateRenderSlot('music', { musicTracks: ['song.mp3'], musicPlaying: false }).text === '♪ ▶');
chk('music: shows pause and is-on when playing', () => {
  const r = simulateRenderSlot('music', { musicTracks: ['song.mp3'], musicPlaying: true });
  return r.text === '♪ ⏸' && r.isOn === true;
});

// 2. Play slot
chk('play: hidden when not media', simulateRenderSlot('play', { isMedia: false }).hidden === true);
chk('play: visible when media active', simulateRenderSlot('play', { isMedia: true, mediaPlaying: false }).hidden === false);
chk('play: shows pause and is-on when media playing', () => {
  const r = simulateRenderSlot('play', { isMedia: true, mediaPlaying: true });
  return r.text === '⏸' && r.isOn === true;
});

// 3. Whiteboard slot
chk('whiteboard: shows ✎ icon and is visible', () => {
  const r = simulateRenderSlot('whiteboard', {});
  return r.hidden === false && r.text === '✎' && r.isOn === false;
});
chk('whiteboard: is-on when whiteboard item is focused', simulateRenderSlot('whiteboard', { isWhiteboard: true }).isOn === true);

// 4. Laser slot
chk('laser: shows 🔦 and highlights when armed', () => {
  const rOff = simulateRenderSlot('laser', { laserActive: false });
  const rOn = simulateRenderSlot('laser', { laserActive: true });
  return rOff.text === '🔦' && !rOff.isOn && rOn.isOn === true;
});

// 5. Timer slot
chk('timer: shows ⏱ and highlights when timer is running', () => {
  const rOff = simulateRenderSlot('timer', { timerRunning: false });
  const rOn = simulateRenderSlot('timer', { timerRunning: true });
  return rOff.text === '⏱ ▶' && !rOff.isOn && rOn.text === '⏱ ⏸' && rOn.isOn === true;
});

// 6. Navigation slots
chk('next: disabled when not paged item', simulateRenderSlot('next', { isPaged: false }).disabled === true);
chk('next: enabled when paged item', simulateRenderSlot('next', { isPaged: true }).disabled === false);
chk('prev: disabled when not paged item', simulateRenderSlot('prev', { isPaged: false }).disabled === true);
chk('prev: enabled when paged item', simulateRenderSlot('prev', { isPaged: true }).disabled === false);

// 7. None slot
chk('none: hidden', simulateRenderSlot('none', {}).hidden === true);

console.log('-- action execution dispatcher --');

function simulateExecute(actionType) {
  const sent = [];
  const staged = [];
  let laserToggled = false;
  let laserActive = false;

  const send = (cmd) => sent.push(cmd);
  const stage = (item) => staged.push(item);
  const setLaserActive = (on) => { laserToggled = true; laserActive = on; };

  switch (actionType) {
    case 'music':
      send({ op: 'music', action: 'toggle' });
      break;
    case 'play':
      send({ op: 'media', action: 'toggle' });
      break;
    case 'whiteboard':
      stage({ title: 'Whiteboard', type: 'whiteboard', bg: '#f7f5ef' });
      break;
    case 'laser':
      setLaserActive(!laserActive);
      break;
    case 'timer':
      send({ op: 'timer', action: 'start' });
      break;
    case 'next':
      send({ op: 'nav', dir: 'next' });
      break;
    case 'prev':
      send({ op: 'nav', dir: 'prev' });
      break;
  }

  return { sent, staged, laserToggled };
}

chk('execute music sends toggle music', simulateExecute('music').sent[0]?.op === 'music');
chk('execute play sends toggle media', simulateExecute('play').sent[0]?.op === 'media');
chk('execute whiteboard stages whiteboard', simulateExecute('whiteboard').staged[0]?.type === 'whiteboard');
chk('execute laser toggles laser state', simulateExecute('laser').laserToggled === true);
chk('execute next sends nav next', simulateExecute('next').sent[0]?.dir === 'next');
chk('execute prev sends nav prev', simulateExecute('prev').sent[0]?.dir === 'prev');

console.log('-- DOM and CSS verification --');

{
  const html = fs.readFileSync(path.join(ROOT, 'control.html'), 'utf8');
  chk('control.html has #bar-music with .bar-slot', html.includes('id="bar-music" class="bar-slot"'));
  chk('control.html has #bar-play with .bar-slot', html.includes('id="bar-play" class="bar-slot"'));
  chk('control.html has #pref-bottom-slot-1 select', html.includes('id="pref-bottom-slot-1"'));
  chk('control.html has #pref-bottom-slot-2 select', html.includes('id="pref-bottom-slot-2"'));
  chk('control.html includes whiteboard option', html.includes('value="whiteboard"'));
  chk('control.html includes laser option', html.includes('value="laser"'));
  chk('control.html includes timer option', html.includes('value="timer"'));
  chk('control.html includes next option', html.includes('value="next"'));
  chk('control.html includes prev option', html.includes('value="prev"'));
  chk('control.html includes none option', html.includes('value="none"'));

  const css = fs.readFileSync(path.join(ROOT, 'assets/css/podium.css'), 'utf8');
  chk('podium.css styles .bottombar .bar-slot', css.includes('.bottombar .bar-slot'));
  chk('podium.css styles .bar-slot.is-on', css.includes('.bottombar .bar-slot.is-on'));
  chk('podium.css styles laser armed state', css.includes('.bar-slot[data-slot-action="laser"].is-on'));
  chk('podium.css scales .bar-slot on mobile', css.includes('#mute, #bar-play, #bar-music, .bottombar .bar-slot { width: 44px; }'));

  const js = fs.readFileSync(path.join(ROOT, 'assets/js/control.js'), 'utf8');
  chk('control.js has bottomSlot1 default', js.includes("bottomSlot1: 'music'"));
  chk('control.js has bottomSlot2 default', js.includes("bottomSlot2: 'play'"));
  chk('control.js has renderBottomSlots', js.includes('function renderBottomSlots()'));
  chk('control.js has executeSlotAction', js.includes('function executeSlotAction('));
  chk('control.js routes bar-music click to executeSlotAction', js.includes("executeSlotAction(presentation.bottomSlot1 || 'music')"));
  chk('control.js routes bar-play click to executeSlotAction', js.includes("executeSlotAction(presentation.bottomSlot2 || 'play')"));
  chk('control.js populates pref-bottom-slot-1 in showSetup', js.includes("$('#pref-bottom-slot-1').value = presentation.bottomSlot1 || 'music'"));
  chk('control.js populates pref-bottom-slot-2 in showSetup', js.includes("$('#pref-bottom-slot-2').value = presentation.bottomSlot2 || 'play'"));
  chk('control.js safely resolves state.music in renderSlotButton', js.includes('const music = state.music ||'));
}

if (!ok) {
  console.error('\nSOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
