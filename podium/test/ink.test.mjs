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
}

if (!ok) {
  console.error('\nSOME CHECKS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
