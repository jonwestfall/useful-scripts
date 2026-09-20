// Run with: node podium/test/pacing.test.mjs
// Unit tests for Podium persistent pacing clock & lecture progress bar (Issue #31).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtTime } from '../assets/js/util.js';

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

console.log('-- pacing calculation & formatting --');

// Test fmtTime behavior for pacing
chk('fmtTime formats 0 seconds', fmtTime(0) === '0:00');
chk('fmtTime formats 65 seconds', fmtTime(65) === '1:05');
chk('fmtTime formats 25 minutes (1500s)', fmtTime(1500) === '25:00');
chk('fmtTime formats 75 minutes (4500s)', fmtTime(4500) === '1:15:00');

function computePacing(elapsedSec, durationMins) {
  const totalSec = durationMins * 60;
  if (totalSec <= 0) return { visible: false };

  const isOvertime = elapsedSec >= totalSec;
  const isNearEnd = !isOvertime && elapsedSec >= totalSec * 0.85;
  const pct = isOvertime ? 100 : Math.min(100, Math.round((elapsedSec / totalSec) * 100));

  let label = '';
  if (isOvertime) {
    const overSec = elapsedSec - totalSec;
    label = `+${fmtTime(overSec)} (${durationMins}m)`;
  } else {
    label = `${fmtTime(elapsedSec)} / ${durationMins}m`;
  }

  return {
    visible: true,
    isNearEnd,
    isOvertime,
    pct,
    label,
  };
}

{
  const p0 = computePacing(0, 50);
  chk('0s into 50m: 0%, normal, label is 0:00 / 50m', p0.pct === 0 && !p0.isNearEnd && !p0.isOvertime && p0.label === '0:00 / 50m');

  const pHalf = computePacing(1500, 50);
  chk('25m into 50m: 50%, normal, label is 25:00 / 50m', pHalf.pct === 50 && !pHalf.isNearEnd && !pHalf.isOvertime && pHalf.label === '25:00 / 50m');

  const pNear = computePacing(43 * 60, 50); // 43/50 = 86%
  chk('43m into 50m: 86%, near-end active', pNear.pct === 86 && pNear.isNearEnd && !pNear.isOvertime);

  const pExact = computePacing(50 * 60, 50);
  chk('50m into 50m: 100%, overtime active, label is +0:00 (50m)', pExact.pct === 100 && !pExact.isNearEnd && pExact.isOvertime && pExact.label === '+0:00 (50m)');

  const pOver = computePacing(53 * 60 + 15, 50);
  chk('53m15s into 50m: 100%, overtime active, label is +3:15 (50m)', pOver.pct === 100 && pOver.isOvertime && pOver.label === '+3:15 (50m)');

  const pOff = computePacing(100, 0);
  chk('duration 0: pacing hidden', !pOff.visible);
}

console.log('-- auto-start logic --');

{
  function shouldAutoStart(cmd, state, presentation, pacingState) {
    if (!presentation.pacingAutoStart || !presentation.lectureDuration || pacingState.startedAt) return false;
    const isNav = cmd?.op === 'nav';
    const isUnblank = cmd?.op === 'blank' && (cmd.on === false || (cmd.on === undefined && state.blank));
    return isNav || isUnblank;
  }

  const pres = { lectureDuration: 50, pacingAutoStart: true };
  const stBlank = { blank: true };
  const stLive = { blank: false };
  const pacingIdle = { startedAt: null };
  const pacingRunning = { startedAt: Date.now() - 5000 };

  // blankOnConnect sends { op: 'blank', on: true }
  chk('blank on connect does NOT auto-start', !shouldAutoStart({ op: 'blank', on: true }, stLive, pres, pacingIdle));

  // unblanking sends { op: 'blank' } when state.blank is true
  chk('unblanking via toggle DOES auto-start', shouldAutoStart({ op: 'blank' }, stBlank, pres, pacingIdle));

  // unblanking explicitly with on: false
  chk('unblanking via on:false DOES auto-start', shouldAutoStart({ op: 'blank', on: false }, stBlank, pres, pacingIdle));

  // advancing slide
  chk('nav next DOES auto-start', shouldAutoStart({ op: 'nav', dir: 'next' }, stLive, pres, pacingIdle));

  // slide advance when already running does not trigger again
  chk('already running timer does not trigger auto-start', !shouldAutoStart({ op: 'nav', dir: 'next' }, stLive, pres, pacingRunning));

  // when pacingAutoStart is off
  const presNoAuto = { lectureDuration: 50, pacingAutoStart: false };
  chk('pacingAutoStart false prevents auto-start', !shouldAutoStart({ op: 'nav', dir: 'next' }, stLive, presNoAuto, pacingIdle));

  // when lectureDuration is 0 (off)
  const presOff = { lectureDuration: 0, pacingAutoStart: true };
  chk('lectureDuration 0 prevents auto-start', !shouldAutoStart({ op: 'nav', dir: 'next' }, stLive, presOff, pacingIdle));
}

console.log('-- DOM and assets verification --');

{
  const html = fs.readFileSync(path.join(ROOT, 'control.html'), 'utf8');
  chk('control.html has #clock-widget', html.includes('id="clock-widget"'));
  chk('control.html has #topbar-clock', html.includes('id="topbar-clock"'));
  chk('control.html has #topbar-pacing', html.includes('id="topbar-pacing"'));
  chk('control.html has #topbar-pacing-label', html.includes('id="topbar-pacing-label"'));
  chk('control.html has #topbar-pacing-bar', html.includes('id="topbar-pacing-bar"'));
  chk('control.html has #pref-lecture-duration', html.includes('id="pref-lecture-duration"'));
  chk('control.html has #pref-lecture-duration-custom', html.includes('id="pref-lecture-duration-custom"'));
  chk('control.html has #pref-pacing-autostart', html.includes('id="pref-pacing-autostart"'));

  const css = fs.readFileSync(path.join(ROOT, 'assets/css/podium.css'), 'utf8');
  chk('podium.css has .clock-widget', css.includes('.clock-widget'));
  chk('podium.css has .topbar-clock', css.includes('.topbar-clock'));
  chk('podium.css has .topbar-pacing', css.includes('.topbar-pacing'));
  chk('podium.css has .topbar-pacing.is-running', css.includes('.topbar-pacing.is-running'));
  chk('podium.css has .topbar-pacing.is-near-end', css.includes('.topbar-pacing.is-near-end'));
  chk('podium.css has .topbar-pacing.is-overtime', css.includes('.topbar-pacing.is-overtime'));
  chk('podium.css has .pacing-track', css.includes('.pacing-track'));
  chk('podium.css has #topbar-pacing-bar', css.includes('#topbar-pacing-bar'));

  const js = fs.readFileSync(path.join(ROOT, 'assets/js/control.js'), 'utf8');
  chk('control.js has lectureDuration default', js.includes('lectureDuration: 0'));
  chk('control.js has pacingAutoStart default', js.includes('pacingAutoStart: true'));
  chk('control.js has PACING_KEY', js.includes('podium.pacing.v1'));
  chk('control.js has renderClockAndPacing', js.includes('function renderClockAndPacing()'));
  chk('control.js has checkPacingAutoStart', js.includes('function checkPacingAutoStart('));
  chk('control.js wires pref-lecture-duration', js.includes("pref-lecture-duration"));
  chk('control.js wires pref-pacing-autostart', js.includes("pref-pacing-autostart"));
}

if (!ok) {
  console.error('\nSOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
