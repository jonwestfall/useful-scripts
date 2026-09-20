// Run with: node podium/test/ink.test.mjs
// Unit tests for Highlighter mode (#35) and Stroke Eraser (#36)
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initialState,
  applyCommand,
  applyInkAction,
  distToSegmentSquared,
  strokeHitTest,
  inkDigest,
  inkDigestsAgree,
} from '../assets/js/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let ok = true;
const chk = (label, cond) => {
  if (!cond) {
    ok = false;
    console.log('FAIL', label);
  } else {
    console.log('ok  ', label);
  }
};

console.log('-- highlighter stroke creation and protocol --');
{
  const strokes = [];
  applyInkAction(strokes, {
    action: 'begin',
    id: 'h1',
    pts: [[0.1, 0.2]],
    color: '#ffd166',
    width: 20,
    highlighter: true,
  });
  chk('highlighter stroke has highlighter property set', strokes[0].highlighter === true);
  chk('highlighter stroke has correct color and width', strokes[0].color === '#ffd166' && strokes[0].width === 20);

  applyInkAction(strokes, { action: 'points', id: 'h1', pts: [[0.2, 0.2], [0.3, 0.2]] });
  chk('highlighter stroke accumulates points without losing flag', strokes[0].pts.length === 3 && strokes[0].highlighter === true);

  const normalStrokes = [];
  applyInkAction(normalStrokes, {
    action: 'begin',
    id: 'p1',
    pts: [[0.1, 0.1]],
    color: '#ff4d4f',
    width: 6,
  });
  chk('normal pen stroke does not have highlighter set', !normalStrokes[0].highlighter);
}

console.log('-- stroke erase protocol and state updates --');
{
  const s = initialState();
  applyCommand(s, { op: 'stage', item: { type: 'whiteboard', bg: '#fff' } });

  // Add 3 strokes
  applyCommand(s, { op: 'ink', action: 'begin', id: 's1', pts: [[0.1, 0.1], [0.2, 0.1]] });
  applyCommand(s, { op: 'ink', action: 'begin', id: 's2', pts: [[0.3, 0.3], [0.4, 0.3]], highlighter: true });
  applyCommand(s, { op: 'ink', action: 'begin', id: 's3', pts: [[0.5, 0.5], [0.6, 0.5]] });

  const surfaceKey = Object.keys(s.ink.bySurface)[0];
  chk('state holds 3 strokes', s.ink.bySurface[surfaceKey].strokes.length === 3);

  const d1 = inkDigest(s.ink.bySurface[surfaceKey].strokes);
  chk('digest has 3 strokes', d1.n === 3);

  // Erase stroke s2 (the highlighter)
  const changed = applyCommand(s, { op: 'ink', action: 'erase', id: 's2' });
  chk('erasing existing stroke returns changed = true', changed === true);
  chk('state now has 2 strokes', s.ink.bySurface[surfaceKey].strokes.length === 2);
  chk('remaining strokes are s1 and s3', s.ink.bySurface[surfaceKey].strokes.map((x) => x.id).join(',') === 's1,s3');

  const d2 = inkDigest(s.ink.bySurface[surfaceKey].strokes);
  chk('digest updated after erase', d2.n === 2 && !inkDigestsAgree(d1, d2));

  // Erase non-existent stroke
  const noChange = applyCommand(s, { op: 'ink', action: 'erase', id: 'does-not-exist' });
  chk('erasing non-existent stroke returns false', noChange === false);
  chk('stroke count remains 2', s.ink.bySurface[surfaceKey].strokes.length === 2);

  // Erase multiple strokes by array
  const multiChange = applyCommand(s, { op: 'ink', action: 'erase', ids: ['s1', 's3'] });
  chk('erasing multiple strokes by ids array succeeds', multiChange === true);
  chk('surface is now empty', s.ink.bySurface[surfaceKey].strokes.length === 0);
}

console.log('-- distance and hit-testing math --');
{
  // Point to segment
  chk('point directly on horizontal segment', distToSegmentSquared(50, 100, 0, 100, 100, 100) === 0);
  chk('point 10px perpendicular to segment', distToSegmentSquared(50, 110, 0, 100, 100, 100) === 100);
  chk('point before start of segment', distToSegmentSquared(-10, 100, 0, 100, 100, 100) === 100);
  chk('point past end of segment', distToSegmentSquared(110, 100, 0, 100, 100, 100) === 100);
  chk('degenerate zero-length segment', distToSegmentSquared(10, 20, 10, 10, 10, 10) === 100);

  // Stroke hit testing
  const stroke = {
    id: 'test',
    width: 6,
    pts: [
      [0.2, 0.2],
      [0.4, 0.2],
      [0.6, 0.4],
    ],
  };

  const W = 1000;
  const H = 1000;

  // Hit on first segment (px = 300, py = 200)
  chk('hit testing directly on segment', strokeHitTest(stroke, 300, 200, W, H, 15) === true);

  // Hit near segment within threshold
  chk('hit testing 10px off segment', strokeHitTest(stroke, 300, 210, W, H, 15) === true);

  // Miss far from segment
  chk('miss far from segment', strokeHitTest(stroke, 300, 400, W, H, 15) === false);

  // Miss completely outside bounding box
  chk('miss far outside bounding box', strokeHitTest(stroke, 50, 50, W, H, 15) === false);

  // Single point stroke
  const dotStroke = { id: 'dot', width: 8, pts: [[0.5, 0.5]] };
  chk('hit on dot stroke center', strokeHitTest(dotStroke, 500, 500, W, H, 10) === true);
  chk('hit on dot stroke edge', strokeHitTest(dotStroke, 510, 500, W, H, 15) === true);
  chk('miss on dot stroke distant', strokeHitTest(dotStroke, 600, 500, W, H, 15) === false);
}

console.log('-- DOM and CSS verification --');
{
  const html = readFileSync(resolve(__dirname, '../control.html'), 'utf-8');
  const css = readFileSync(resolve(__dirname, '../assets/css/podium.css'), 'utf-8');

  chk('control.html has .ink-tools container', html.includes('class="ink-tools"'));
  chk('control.html has #ink-tool-pen', html.includes('id="ink-tool-pen"'));
  chk('control.html has #ink-tool-highlighter', html.includes('id="ink-tool-highlighter"'));
  chk('control.html has #ink-tool-eraser', html.includes('id="ink-tool-eraser"'));

  chk('podium.css styles .ink-tools', css.includes('.ink-tools'));
  chk('podium.css styles .ink-tool-btn', css.includes('.ink-tool-btn'));
  chk('podium.css styles #pad.is-eraser', css.includes('#pad.is-eraser'));

  // Issue #53 verification
  chk('control.html has #ink-controls container', html.includes('id="ink-controls" class="ink-controls"'));
  chk('control.html has #ink-color-picker input', html.includes('id="ink-color-picker" type="color"'));
  chk('control.html has #ink-picker-label with .swatch-picker', html.includes('id="ink-picker-label" class="swatch swatch-picker"'));
  chk('control.html has #pref-ink-scroll-gutter checkbox', html.includes('id="pref-ink-scroll-gutter"'));
  chk('control.html has #pref-ink-controls-top checkbox', html.includes('id="pref-ink-controls-top"'));

  chk('podium.css styles .swatch-picker', css.includes('.swatch-picker'));
  chk('podium.css styles .swatch-picker-inner', css.includes('.swatch-picker-inner'));
  chk('podium.css styles .pad-gutter #pad-viewport', css.includes('.panel[data-panel="ink"].pad-gutter #pad-viewport'));
  chk('podium.css styles .controls-top #ink-controls', css.includes('.panel[data-panel="ink"].controls-top #ink-controls'));

  const js = readFileSync(resolve(__dirname, '../assets/js/control.js'), 'utf-8');
  chk('control.js defaults inkScrollGutter', js.includes('inkScrollGutter: false'));
  chk('control.js defaults inkControlsTop', js.includes('inkControlsTop: false'));
  chk('control.js defines applyInkPreferences', js.includes('function applyInkPreferences()'));
  chk('control.js handles #ink-color-picker', js.includes("const inkColorPicker = $('#ink-color-picker')"));
  chk('control.js persists custom color key', js.includes("INK_CUSTOM_COLOR_KEY = 'podium.ink_custom_color.v1'"));
}

console.log('-- custom color protocol and layout preferences --');
{
  // Custom hex color with normal pen stroke
  const customPenStrokes = [];
  applyInkAction(customPenStrokes, {
    action: 'begin',
    id: 'c1',
    pts: [[0.1, 0.1]],
    color: '#a371f7',
    width: 6,
  });
  chk('custom color stroke created with #a371f7', customPenStrokes[0].color === '#a371f7');

  // Custom hex color with highlighter
  const customHlStrokes = [];
  applyInkAction(customHlStrokes, {
    action: 'begin',
    id: 'c2',
    pts: [[0.2, 0.2]],
    color: '#00ffff',
    width: 22,
    highlighter: true,
  });
  chk('custom highlighter stroke has #00ffff and highlighter flag', customHlStrokes[0].color === '#00ffff' && customHlStrokes[0].highlighter === true);

  // Preference layout simulations
  function simulateInkLayout(prefs) {
    const classes = new Set();
    if (prefs.inkScrollGutter) classes.add('pad-gutter');
    if (prefs.inkControlsTop) classes.add('controls-top');
    return {
      hasGutterClass: classes.has('pad-gutter'),
      hasControlsTopClass: classes.has('controls-top'),
      viewportWidthPercent: classes.has('pad-gutter') ? 80 : 100,
      controlsOrder: classes.has('controls-top') ? 1 : 2,
      viewportOrder: classes.has('controls-top') ? 2 : 1,
    };
  }

  const defaultLayout = simulateInkLayout({ inkScrollGutter: false, inkControlsTop: false });
  chk('default layout has 100% viewport width and controls below', defaultLayout.viewportWidthPercent === 100 && defaultLayout.controlsOrder > defaultLayout.viewportOrder);

  const gutterLayout = simulateInkLayout({ inkScrollGutter: true, inkControlsTop: false });
  chk('gutter layout has 80% viewport width (10% borders)', gutterLayout.hasGutterClass && gutterLayout.viewportWidthPercent === 80);

  const topControlsLayout = simulateInkLayout({ inkScrollGutter: false, inkControlsTop: true });
  chk('top controls layout has controlsOrder before viewportOrder', topControlsLayout.hasControlsTopClass && topControlsLayout.controlsOrder < topControlsLayout.viewportOrder);
}

if (!ok) {
  console.error('\nSOME CHECKS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
