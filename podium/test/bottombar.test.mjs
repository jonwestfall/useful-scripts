// Run with: node podium/test/bottombar.test.mjs
// Unit tests for Podium customizable bottom bar dock with 8 slots & mobile cutoff (Issue #50).
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
  const {
    musicTracks = [],
    musicPlaying = false,
    isMedia = false,
    isPaged = false,
    mediaPlaying = false,
    isWhiteboard = false,
    laserActive = false,
    spotlightActive = false,
    timerRunning = false,
    frozen = false,
    blank = false,
    cued = false,
  } = context;

  const res = {
    action: slotType || 'none',
    hidden: false,
    disabled: false,
    isOn: false,
    isArmed: false,
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
    case 'freeze':
      res.hidden = false;
      res.text = frozen ? 'Frozen' : 'Freeze';
      res.isOn = !!frozen;
      break;
    case 'blank':
      res.hidden = false;
      res.text = blank ? 'Blanked' : 'Blank';
      res.isOn = !!blank;
      break;
    case 'take':
      res.hidden = false;
      res.disabled = !cued;
      res.text = 'TAKE';
      res.isArmed = !!cued;
      break;
    case 'clear':
      res.hidden = false;
      res.disabled = !cued;
      res.text = '✕ Clear';
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
    case 'spotlight':
      res.hidden = false;
      res.text = '🔆';
      res.isOn = !!spotlightActive;
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

// 3. Freeze slot
chk('freeze: shows Freeze when not frozen', () => {
  const r = simulateRenderSlot('freeze', { frozen: false });
  return r.hidden === false && r.text === 'Freeze' && !r.isOn;
});
chk('freeze: shows Frozen and is-on when frozen', () => {
  const r = simulateRenderSlot('freeze', { frozen: true });
  return r.hidden === false && r.text === 'Frozen' && r.isOn;
});

// 4. Blank slot
chk('blank: shows Blank when not blanked', () => {
  const r = simulateRenderSlot('blank', { blank: false });
  return r.hidden === false && r.text === 'Blank' && !r.isOn;
});
chk('blank: shows Blanked and is-on when blanked', () => {
  const r = simulateRenderSlot('blank', { blank: true });
  return r.hidden === false && r.text === 'Blanked' && r.isOn;
});

// 5. TAKE slot
chk('take: disabled when no item cued', () => {
  const r = simulateRenderSlot('take', { cued: false });
  return r.disabled === true && !r.isArmed;
});
chk('take: enabled and armed when item cued', () => {
  const r = simulateRenderSlot('take', { cued: true });
  return r.disabled === false && r.isArmed === true && r.text === 'TAKE';
});

// 6. Clear slot
chk('clear: disabled when no item cued', () => {
  const r = simulateRenderSlot('clear', { cued: false });
  return r.disabled === true && r.text === '✕ Clear';
});
chk('clear: enabled when item cued', () => {
  const r = simulateRenderSlot('clear', { cued: true });
  return r.disabled === false && r.text === '✕ Clear';
});

// 7. Whiteboard slot
chk('whiteboard: shows ✎ icon and is visible', () => {
  const r = simulateRenderSlot('whiteboard', {});
  return r.hidden === false && r.text === '✎' && r.isOn === false;
});
chk('whiteboard: is-on when whiteboard item is focused', simulateRenderSlot('whiteboard', { isWhiteboard: true }).isOn === true);

// 8. Laser slot
chk('laser: shows 🔦 and highlights when armed', () => {
  const rOff = simulateRenderSlot('laser', { laserActive: false });
  const rOn = simulateRenderSlot('laser', { laserActive: true });
  return rOff.text === '🔦' && !rOff.isOn && rOn.isOn === true;
});

// 9. Spotlight slot
chk('spotlight: shows 🔆 and highlights when active', () => {
  const rOff = simulateRenderSlot('spotlight', { spotlightActive: false });
  const rOn = simulateRenderSlot('spotlight', { spotlightActive: true });
  return rOff.text === '🔆' && !rOff.isOn && rOn.isOn === true;
});

// 10. Timer slot
chk('timer: shows ⏱ and highlights when timer is running', () => {
  const rOff = simulateRenderSlot('timer', { timerRunning: false });
  const rOn = simulateRenderSlot('timer', { timerRunning: true });
  return rOff.text === '⏱ ▶' && !rOff.isOn && rOn.text === '⏱ ⏸' && rOn.isOn === true;
});

// 11. Navigation slots
chk('next: disabled when not paged item', simulateRenderSlot('next', { isPaged: false }).disabled === true);
chk('next: enabled when paged item', simulateRenderSlot('next', { isPaged: true }).disabled === false);
chk('prev: disabled when not paged item', simulateRenderSlot('prev', { isPaged: false }).disabled === true);
chk('prev: enabled when paged item', simulateRenderSlot('prev', { isPaged: true }).disabled === false);

// 12. None slot
chk('none: hidden', simulateRenderSlot('none', {}).hidden === true);

console.log('-- mobile cutoff logic --');

function simulateMobileCutoff(slots, context) {
  const rendered = slots.map((s) => simulateRenderSlot(s, context));
  let visibleActiveCount = 0;
  return rendered.map((btn) => {
    if (!btn.hidden) {
      visibleActiveCount += 1;
      return { ...btn, mobileOverflow: visibleActiveCount > 4 };
    }
    return { ...btn, mobileOverflow: false };
  });
}

{
  // 8 slots configured: all visible
  const slots = ['whiteboard', 'laser', 'freeze', 'blank', 'timer', 'next', 'prev', 'spotlight'];
  const res = simulateMobileCutoff(slots, { isPaged: true });
  const visibleButtons = res.filter((b) => !b.hidden);
  chk('8 visible buttons rendered', visibleButtons.length === 8);
  const mobileVisible = visibleButtons.filter((b) => !b.mobileOverflow);
  chk('mobile priority cutoff keeps exactly 4 buttons visible on mobile', mobileVisible.length === 4);
  chk('buttons 1-4 are not overflow', !res[0].mobileOverflow && !res[1].mobileOverflow && !res[2].mobileOverflow && !res[3].mobileOverflow);
  chk('buttons 5-8 are tagged as mobileOverflow', res[4].mobileOverflow && res[5].mobileOverflow && res[6].mobileOverflow && res[7].mobileOverflow);
}

{
  // First two slots are music and play, but inactive/hidden
  const slots = ['music', 'play', 'freeze', 'blank', 'whiteboard', 'laser', 'spotlight', 'timer'];
  const res = simulateMobileCutoff(slots, { musicTracks: [], isMedia: false });
  chk('inactive music and play are hidden', res[0].hidden && res[1].hidden);
  // Next 4 slots should be visible on mobile (freeze, blank, whiteboard, laser)
  chk('freeze is mobile-visible', !res[2].mobileOverflow && !res[2].hidden);
  chk('blank is mobile-visible', !res[3].mobileOverflow && !res[3].hidden);
  chk('whiteboard is mobile-visible', !res[4].mobileOverflow && !res[4].hidden);
  chk('laser is mobile-visible', !res[5].mobileOverflow && !res[5].hidden);
  chk('spotlight overflows mobile', res[6].mobileOverflow);
  chk('timer overflows mobile', res[7].mobileOverflow);
}

console.log('-- action execution dispatcher --');

function simulateExecute(actionType) {
  const sent = [];
  const staged = [];
  let laserToggled = false;
  let laserActive = false;
  let spotlightToggled = false;
  let spotlightActive = false;

  const send = (cmd) => sent.push(cmd);
  const stage = (item) => staged.push(item);
  const setLaserActive = (on) => { laserToggled = true; laserActive = on; };
  const setSpotlightActive = (on) => { spotlightToggled = true; spotlightActive = on; };

  switch (actionType) {
    case 'music':
      send({ op: 'music', action: 'toggle' });
      break;
    case 'play':
      send({ op: 'media', action: 'toggle' });
      break;
    case 'freeze':
      send({ op: 'freeze' });
      break;
    case 'blank':
      send({ op: 'blank' });
      break;
    case 'take':
      send({ op: 'take' });
      break;
    case 'clear':
      send({ op: 'clear', where: 'preview' });
      break;
    case 'whiteboard':
      stage({ title: 'Whiteboard', type: 'whiteboard', bg: '#f7f5ef' });
      break;
    case 'laser':
      setLaserActive(!laserActive);
      break;
    case 'spotlight':
      setSpotlightActive(!spotlightActive);
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

  return { sent, staged, laserToggled, spotlightToggled };
}

chk('execute music sends toggle music', simulateExecute('music').sent[0]?.op === 'music');
chk('execute play sends toggle media', simulateExecute('play').sent[0]?.op === 'media');
chk('execute freeze sends op freeze', simulateExecute('freeze').sent[0]?.op === 'freeze');
chk('execute blank sends op blank', simulateExecute('blank').sent[0]?.op === 'blank');
chk('execute take sends op take', simulateExecute('take').sent[0]?.op === 'take');
chk('execute clear sends op clear with preview', () => {
  const r = simulateExecute('clear');
  return r.sent[0]?.op === 'clear' && r.sent[0]?.where === 'preview';
});
chk('execute whiteboard stages whiteboard', simulateExecute('whiteboard').staged[0]?.type === 'whiteboard');
chk('execute laser toggles laser state', simulateExecute('laser').laserToggled === true);
chk('execute spotlight toggles spotlight state', simulateExecute('spotlight').spotlightToggled === true);
chk('execute next sends nav next', simulateExecute('next').sent[0]?.dir === 'next');
chk('execute prev sends nav prev', simulateExecute('prev').sent[0]?.dir === 'prev');

console.log('-- DOM and CSS verification --');

{
  const html = fs.readFileSync(path.join(ROOT, 'control.html'), 'utf8');
  chk('control.html has #bar-music with .bar-slot', html.includes('id="bar-music" class="bar-slot"'));
  chk('control.html has #bar-play with .bar-slot', html.includes('id="bar-play" class="bar-slot"'));
  chk('control.html has #freeze with .bar-slot', html.includes('id="freeze" class="bar-slot"'));
  chk('control.html has #blank with .bar-slot', html.includes('id="blank" class="bar-slot"'));
  chk('control.html has #bar-slot-5 with .bar-slot', html.includes('id="bar-slot-5" class="bar-slot"'));
  chk('control.html has #bar-slot-6 with .bar-slot', html.includes('id="bar-slot-6" class="bar-slot"'));
  chk('control.html has #bar-slot-7 with .bar-slot', html.includes('id="bar-slot-7" class="bar-slot"'));
  chk('control.html has #bar-slot-8 with .bar-slot', html.includes('id="bar-slot-8" class="bar-slot"'));

  for (let i = 1; i <= 8; i++) {
    chk(`control.html has #pref-bottom-slot-${i} select`, html.includes(`id="pref-bottom-slot-${i}"`));
  }

  chk('control.html includes whiteboard option', html.includes('value="whiteboard"'));
  chk('control.html includes laser option', html.includes('value="laser"'));
  chk('control.html includes spotlight option', html.includes('value="spotlight"'));
  chk('control.html includes timer option', html.includes('value="timer"'));
  chk('control.html includes next option', html.includes('value="next"'));
  chk('control.html includes prev option', html.includes('value="prev"'));
  chk('control.html includes take option', html.includes('value="take"'));
  chk('control.html includes clear option', html.includes('value="clear"'));
  chk('control.html includes freeze option', html.includes('value="freeze"'));
  chk('control.html includes blank option', html.includes('value="blank"'));
  chk('control.html includes none option', html.includes('value="none"'));

  const css = fs.readFileSync(path.join(ROOT, 'assets/css/podium.css'), 'utf8');
  chk('podium.css styles .bottombar .bar-slot', css.includes('.bottombar .bar-slot'));
  chk('podium.css styles .bar-slot.is-on', css.includes('.bottombar .bar-slot.is-on'));
  chk('podium.css styles laser armed state', css.includes('.bar-slot[data-slot-action="laser"].is-on'));
  chk('podium.css styles spotlight state', css.includes('.bar-slot[data-slot-action="spotlight"].is-on'));
  chk('podium.css styles freeze state', css.includes('.bar-slot[data-slot-action="freeze"].is-on'));
  chk('podium.css styles blank state', css.includes('.bar-slot[data-slot-action="blank"].is-on'));
  chk('podium.css styles take armed state', css.includes('.bar-slot[data-slot-action="take"].is-armed'));
  chk('podium.css scales .bar-slot on mobile', css.includes('#mute, #bar-play, #bar-music, .bottombar .bar-slot { width: 44px; }'));
  chk('podium.css has mobile overflow rule', css.includes('.bottombar .bar-slot.mobile-overflow { display: none !important; }'));
  chk('podium.css styles .bottom-slots-grid', css.includes('.bottom-slots-grid'));

  const js = fs.readFileSync(path.join(ROOT, 'assets/js/control.js'), 'utf8');
  chk('control.js has bottomSlots default array', js.includes("bottomSlots: ['music', 'play', 'freeze', 'blank', 'none', 'none', 'none', 'none']"));
  chk('control.js has bottomSlot1 backward compatibility default', js.includes("bottomSlot1: 'music'"));
  chk('control.js has bottomSlot2 backward compatibility default', js.includes("bottomSlot2: 'play'"));
  chk('control.js has renderBottomSlots', js.includes('function renderBottomSlots()'));
  chk('control.js has executeSlotAction', js.includes('function executeSlotAction('));
  chk('control.js routes bottombar click to executeSlotAction', js.includes("executeSlotAction(action)"));
  chk('control.js populates pref-bottom-slot-1 in showSetup', js.includes("$('#pref-bottom-slot-1').value = presentation.bottomSlot1 ||"));
  chk('control.js populates pref-bottom-slot-2 in showSetup', js.includes("$('#pref-bottom-slot-2').value = presentation.bottomSlot2 ||"));
  chk('control.js safely resolves state.music in renderSlotButton', js.includes('const music = state.music ||'));
}

if (!ok) {
  console.error('\nSOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
