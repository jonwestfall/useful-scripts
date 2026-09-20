// Run with: node podium/test/haptics.test.mjs
// Unit tests for Podium tactile haptic feedback on navigation & lectern actions (Issue #32).
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

console.log('-- haptic pattern translations and simulation --');

let vibrateCalls = [];
let mockVibrateSupported = true;
let mockVibrateThrows = false;

const mockNavigator = {
  get vibrate() {
    if (!mockVibrateSupported) return undefined;
    return (pattern) => {
      if (mockVibrateThrows) throw new Error('SecurityError: vibration not allowed in this context');
      vibrateCalls.push(pattern);
      return true;
    };
  },
};

let presentation = { haptics: true };
let suppressHaptics = false;

function haptic(pattern = 'tick') {
  if (suppressHaptics) return;
  if (presentation && presentation.haptics === false) return;
  if (typeof mockNavigator === 'undefined' || typeof mockNavigator.vibrate !== 'function') return;
  try {
    if (pattern === 'tick') {
      mockNavigator.vibrate(15);
    } else if (pattern === 'double') {
      mockNavigator.vibrate([10, 30, 10]);
    } else if (pattern === 'pulse') {
      mockNavigator.vibrate(30);
    } else if (pattern === 'alert') {
      mockNavigator.vibrate([80, 50, 80, 50, 120]);
    } else if (typeof pattern === 'number' || Array.isArray(pattern)) {
      mockNavigator.vibrate(pattern);
    }
  } catch {
    // Graceful no-op
  }
}

function triggerCommandHaptic(cmd) {
  if (!cmd || typeof cmd !== 'object') return;
  switch (cmd.op) {
    case 'nav':
      haptic('tick');
      break;
    case 'freeze':
      haptic('double');
      break;
    case 'blank':
    case 'take':
      haptic('pulse');
      break;
  }
}

// Reset harness
function resetHaptics() {
  vibrateCalls = [];
  mockVibrateSupported = true;
  mockVibrateThrows = false;
  presentation = { haptics: true };
  suppressHaptics = false;
}

// Test 1: Navigation commands produce single tick (15ms)
resetHaptics();
triggerCommandHaptic({ op: 'nav', dir: 'next' });
chk('op:nav produces a 15ms tick', vibrateCalls.length === 1 && vibrateCalls[0] === 15);

// Test 2: Freeze command produces double tick ([10, 30, 10])
resetHaptics();
triggerCommandHaptic({ op: 'freeze' });
chk('op:freeze produces double tick [10, 30, 10]',
  vibrateCalls.length === 1 && JSON.stringify(vibrateCalls[0]) === JSON.stringify([10, 30, 10]));

// Test 3: Blank command produces firm pulse (30ms)
resetHaptics();
triggerCommandHaptic({ op: 'blank' });
chk('op:blank produces a 30ms firm pulse', vibrateCalls.length === 1 && vibrateCalls[0] === 30);

// Test 4: TAKE command produces firm pulse (30ms)
resetHaptics();
triggerCommandHaptic({ op: 'take' });
chk('op:take produces a 30ms firm pulse', vibrateCalls.length === 1 && vibrateCalls[0] === 30);

// Test 5: Unrelated commands do not trigger haptics
resetHaptics();
triggerCommandHaptic({ op: 'music', action: 'toggle' });
triggerCommandHaptic({ op: 'panel', index: 0 });
triggerCommandHaptic({ op: 'layout', mode: 'single' });
triggerCommandHaptic(null);
chk('non-navigation/switching commands do not trigger haptics', vibrateCalls.length === 0);

// Test 6: Disabled haptic preference suppresses vibration
resetHaptics();
presentation.haptics = false;
triggerCommandHaptic({ op: 'nav', dir: 'next' });
triggerCommandHaptic({ op: 'freeze' });
triggerCommandHaptic({ op: 'take' });
haptic('alert');
chk('setting haptics:false suppresses all vibrations', vibrateCalls.length === 0);

// Test 7: suppressHaptics flag suppresses vibrations (e.g. during auto-launch)
resetHaptics();
suppressHaptics = true;
triggerCommandHaptic({ op: 'nav', dir: 'next' });
triggerCommandHaptic({ op: 'freeze' });
chk('suppressHaptics suppresses vibrations during plan load', vibrateCalls.length === 0);

// Test 8: Graceful no-op when navigator.vibrate is unsupported
resetHaptics();
mockVibrateSupported = false;
try {
  triggerCommandHaptic({ op: 'nav', dir: 'next' });
  triggerCommandHaptic({ op: 'freeze' });
  chk('safely no-ops when navigator.vibrate is undefined', true);
} catch (e) {
  chk('safely no-ops when navigator.vibrate is undefined', false);
}

// Test 9: Graceful catch when navigator.vibrate throws (e.g. permissions policy)
resetHaptics();
mockVibrateThrows = true;
try {
  triggerCommandHaptic({ op: 'nav', dir: 'next' });
  chk('safely catches when navigator.vibrate throws', true);
} catch (e) {
  chk('safely catches when navigator.vibrate throws', false);
}

console.log('-- timer completion detection --');

const runningTimers = new Set();
function checkTimerCompletions(timers, now) {
  for (const timer of timers) {
    if (!timer || !timer.id) continue;
    if (timer.running) {
      const left = Math.max(0, timer.endsAt - now);
      if (left > 0) {
        runningTimers.add(timer.id);
      } else if (runningTimers.has(timer.id)) {
        runningTimers.delete(timer.id);
        haptic('alert');
      }
    } else {
      runningTimers.delete(timer.id);
    }
  }
}

// Timer starts running
resetHaptics();
runningTimers.clear();
const t1 = { id: 'timer-1', running: true, endsAt: 10000 };
checkTimerCompletions([t1], 5000); // 5s left
chk('timer running with time left is tracked without vibrating', runningTimers.has('timer-1') && vibrateCalls.length === 0);

// Timer reaches 0
checkTimerCompletions([t1], 10000); // 0s left
chk('timer transitioning to 0 fires alert pattern',
  !runningTimers.has('timer-1') && vibrateCalls.length === 1 && JSON.stringify(vibrateCalls[0]) === JSON.stringify([80, 50, 80, 50, 120]));

// Subsequent ticks while remaining is 0 should NOT fire again
checkTimerCompletions([t1], 10250);
checkTimerCompletions([t1], 10500);
chk('timer remaining at 0 does not re-alert on subsequent ticks', vibrateCalls.length === 1);

// A timer that connects already at 0 should not alert
resetHaptics();
runningTimers.clear();
const tZero = { id: 'timer-2', running: true, endsAt: 5000 };
checkTimerCompletions([tZero], 6000); // already past 0 when first seen
chk('timer already expired on connection does not fire alert', vibrateCalls.length === 0 && !runningTimers.has('timer-2'));

// Pausing a timer removes it from running tracking
resetHaptics();
runningTimers.clear();
const tPaused = { id: 'timer-3', running: true, endsAt: 15000 };
checkTimerCompletions([tPaused], 10000);
chk('running timer is tracked', runningTimers.has('timer-3'));
tPaused.running = false;
checkTimerCompletions([tPaused], 11000);
chk('paused timer is removed from tracking', !runningTimers.has('timer-3') && vibrateCalls.length === 0);

console.log('-- source file inspection & wiring checks --');

const controlHtml = fs.readFileSync(path.join(ROOT, 'control.html'), 'utf8');
chk('control.html includes pref-haptics checkbox', controlHtml.includes('id="pref-haptics"'));
chk('control.html includes pref-haptics-unsupported warning element', controlHtml.includes('id="pref-haptics-unsupported"'));

const controlJs = fs.readFileSync(path.join(ROOT, 'assets/js/control.js'), 'utf8');
chk('control.js has haptics: true in PRESENTATION_DEFAULTS', controlJs.includes('haptics: true,'));
chk('control.js defines haptic function', controlJs.includes('function haptic('));
chk('control.js defines triggerCommandHaptic function', controlJs.includes('function triggerCommandHaptic('));
chk('control.js calls triggerCommandHaptic in send()', controlJs.includes('triggerCommandHaptic(cmd);'));
chk('control.js suppresses haptics in adoptPlan autoLaunch', controlJs.includes('suppressHaptics = true;'));
chk('control.js defines checkTimerCompletions', controlJs.includes('function checkTimerCompletions('));
chk('control.js calls checkTimerCompletions in renderTimers', controlJs.includes('checkTimerCompletions(timers);'));
chk('control.js wires pref-haptics change listener', controlJs.includes("$('#pref-haptics')?.addEventListener('change'"));
chk('control.js initializes pref-haptics in showSetup', controlJs.includes("prefHaptics.checked = presentation.haptics !== false;"));
chk('control.js checks navigator.vibrate support in showSetup', controlJs.includes("typeof navigator.vibrate === 'function'"));

if (!ok) {
  console.error('\nSOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
