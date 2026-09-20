// Run with: node podium/test/spotlight.test.mjs
// Unit tests for Podium Spotlight / Attention Dimmer Pointer Mode (Issue #37).
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

console.log('-- spotlight geometry and message calculation --');

function calculateSpotlightCoords(msg, rect) {
  if (!msg?.on) return null;
  const px = rect.x + (Number(msg.x) || 0) * rect.w;
  const py = rect.y + (Number(msg.y) || 0) * rect.h;
  const radius = Math.max(80, Math.round(Math.min(rect.w, rect.h) * 0.18));
  return { px, py, radius };
}

{
  const fullHdRect = { x: 0, y: 0, w: 1920, h: 1080 };
  const center = calculateSpotlightCoords({ t: 'spotlight', x: 0.5, y: 0.5, on: true }, fullHdRect);
  chk('center x at 960 on 1080p', center.px === 960);
  chk('center y at 540 on 1080p', center.py === 540);
  chk('radius is 18% of min dimension (~194px on 1080p)', center.radius === Math.round(1080 * 0.18));

  // Letterboxed 4:3 content inside 16:9 screen
  const letterboxedRect = { x: 240, y: 0, w: 1440, h: 1080 };
  const topCorner = calculateSpotlightCoords({ t: 'spotlight', x: 0.1, y: 0.2, on: true }, letterboxedRect);
  chk('letterbox x offset properly added', Math.abs(topCorner.px - (240 + 144)) < 0.001);
  chk('letterbox y properly scaled', Math.abs(topCorner.py - 216) < 0.001);

  // Minimum radius fallback for small display/preview window
  const smallRect = { x: 0, y: 0, w: 320, h: 180 };
  const smallCoords = calculateSpotlightCoords({ t: 'spotlight', x: 0.5, y: 0.5, on: true }, smallRect);
  chk('radius enforces 80px minimum on small displays', smallCoords.radius === 80);

  // Off message returns null
  const offCoords = calculateSpotlightCoords({ t: 'spotlight', on: false }, fullHdRect);
  chk('off message clears spotlight', offCoords === null);
}

console.log('-- mutual exclusivity: laser vs spotlight --');

{
  let laserActive = false;
  let spotlightActive = false;

  function setLaserActive(on) {
    if (on && spotlightActive) setSpotlightActive(false);
    laserActive = on;
  }

  function setSpotlightActive(on) {
    if (on && laserActive) setLaserActive(false);
    spotlightActive = on;
  }

  // Initial state
  chk('initially both pointers inactive', !laserActive && !spotlightActive);

  // Turn on laser
  setLaserActive(true);
  chk('laser active', laserActive && !spotlightActive);

  // Turn on spotlight: should disarm laser
  setSpotlightActive(true);
  chk('spotlight active and laser disarmed', spotlightActive && !laserActive);

  // Turn on laser: should disarm spotlight
  setLaserActive(true);
  chk('laser active and spotlight disarmed', laserActive && !spotlightActive);

  // Turn off laser
  setLaserActive(false);
  chk('turning off laser leaves both inactive', !laserActive && !spotlightActive);
}

console.log('-- ink tool switching and pointer state --');

{
  const ink = { tool: 'pen', pointing: null };
  const classes = { eraser: false, laser: false, spotlight: false };
  let busSent = [];

  function setInkTool(tool) {
    if (ink.pointing) {
      busSent.push({ t: ink.pointing, on: false });
      ink.pointing = null;
    }
    ink.tool = tool;
    classes.eraser = tool === 'eraser';
    classes.laser = tool === 'laser';
    classes.spotlight = tool === 'spotlight';
  }

  setInkTool('spotlight');
  chk('ink tool is spotlight', ink.tool === 'spotlight');
  chk('pad has is-spotlight class', classes.spotlight && !classes.laser && !classes.eraser);

  // Simulate active drag when tool changes
  ink.pointing = 'spotlight';
  setInkTool('pen');
  chk('switching away from spotlight auto-releases bus message', busSent.some((m) => m.t === 'spotlight' && m.on === false));
  chk('ink pointing is cleared', ink.pointing === null);
  chk('pad classes reset for pen', !classes.spotlight && !classes.laser && !classes.eraser);
}

console.log('-- bottom bar quick action slot for spotlight --');

{
  function simulateRenderSlot(slotType, spotlightActive) {
    const btn = { hidden: false, text: '', title: '', isOn: false, action: slotType };
    switch (slotType) {
      case 'spotlight':
        btn.hidden = false;
        btn.text = '🔆';
        btn.title = 'Toggle spotlight mode';
        btn.isOn = spotlightActive;
        break;
      default:
        btn.hidden = true;
    }
    return btn;
  }

  const slotOff = simulateRenderSlot('spotlight', false);
  chk('spotlight slot renders 🔆 icon', slotOff.text === '🔆');
  chk('spotlight slot off when inactive', slotOff.isOn === false);

  const slotOn = simulateRenderSlot('spotlight', true);
  chk('spotlight slot is-on when active', slotOn.isOn === true);

  // Execute slot action
  let spotlightActive = false;
  function executeSlotAction(type) {
    if (type === 'spotlight') spotlightActive = !spotlightActive;
  }

  executeSlotAction('spotlight');
  chk('executeSlotAction toggles spotlight on', spotlightActive === true);
  executeSlotAction('spotlight');
  chk('executeSlotAction toggles spotlight off', spotlightActive === false);
}

console.log('-- DOM and CSS verification --');

{
  const displayHtml = fs.readFileSync(path.join(ROOT, 'display.html'), 'utf8');
  chk('display.html has #spotlight element', displayHtml.includes('<div id="spotlight"></div>'));

  const controlHtml = fs.readFileSync(path.join(ROOT, 'control.html'), 'utf8');
  chk('control.html has #deck-spotlight button', controlHtml.includes('id="deck-spotlight"'));
  chk('control.html has #ink-tool-spotlight button', controlHtml.includes('id="ink-tool-spotlight"'));
  chk('control.html has #ink-tool-laser button', controlHtml.includes('id="ink-tool-laser"'));
  chk('control.html has spotlight option in slot 1', controlHtml.includes('<option value="spotlight">Spotlight (🔆)</option>'));

  const css = fs.readFileSync(path.join(ROOT, 'assets/css/podium.css'), 'utf8');
  chk('podium.css styles body.display #spotlight', css.includes('body.display #spotlight'));
  chk('podium.css styles body.display #spotlight.is-on', css.includes('body.display #spotlight.is-on'));
  chk('podium.css has radial-gradient cutout on #spotlight', css.includes('var(--spotlight-radius') && css.includes('var(--spotlight-x'));
  chk('podium.css styles #deck-spotlight', css.includes('#deck-spotlight'));
  chk('podium.css styles #deck-spotlight.is-on', css.includes('#deck-spotlight.is-on'));
  chk('podium.css styles #pad.is-spotlight', css.includes('#pad.is-spotlight'));
  chk('podium.css styles .spotlight-preview', css.includes('.spotlight-preview'));
  chk('podium.css styles .bar-slot[data-slot-action="spotlight"].is-on', css.includes('.bar-slot[data-slot-action="spotlight"].is-on'));

  const displayJs = fs.readFileSync(path.join(ROOT, 'assets/js/display.js'), 'utf8');
  chk('display.js queries #spotlight element', displayJs.includes("const spotlightEl = $('#spotlight')"));
  chk('display.js handles spotlight message type', displayJs.includes("msg.t === 'spotlight'"));
  chk('display.js has showSpotlight function', displayJs.includes('function showSpotlight('));
  chk('display.js has hideSpotlight function', displayJs.includes('function hideSpotlight('));
  chk('display.js maps contentRectFor in showSpotlight', displayJs.includes('contentRectFor(slot, renderer)'));
  chk('display.js sets 1.5s safety timeout', displayJs.includes('setTimeout(hideSpotlight, 1500)'));

  const controlJs = fs.readFileSync(path.join(ROOT, 'assets/js/control.js'), 'utf8');
  chk('control.js has sendSpotlight throttle', controlJs.includes("sendSpotlight = throttle((x, y) => bus?.send({ t: 'spotlight'"));
  chk('control.js declares spotlightActive', controlJs.includes('let spotlightActive = false'));
  chk('control.js has setSpotlightActive', controlJs.includes('function setSpotlightActive(on)'));
  chk('control.js creates padSpotlightPreview', controlJs.includes("padSpotlightPreview = el('div', { class: 'spotlight-preview' })"));
  chk('control.js creates deck spotlightPreview', controlJs.includes("spotlightPreview = el('div', { class: 'spotlight-preview' })"));
  chk('control.js handles spotlight in renderSlotButton', controlJs.includes("case 'spotlight':"));
  chk('control.js handles spotlight in executeSlotAction', controlJs.includes("case 'spotlight':\n      setSpotlightActive(!spotlightActive);"));
  chk('control.js has keydown shortcut 5 for spotlight on ink', controlJs.includes("ev.key === '5') { ev.preventDefault(); setInkTool('spotlight');"));
  chk('control.js has keydown shortcut s for spotlight on ink', controlJs.includes("ev.key === 's' || ev.key === 'S') { ev.preventDefault(); setInkTool('spotlight');"));
  chk('control.js has keydown shortcut s for spotlight on deck', controlJs.includes("ev.key === 's' || ev.key === 'S') { ev.preventDefault(); setSpotlightActive(!spotlightActive);"));
}

if (!ok) {
  console.error('\nSOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
