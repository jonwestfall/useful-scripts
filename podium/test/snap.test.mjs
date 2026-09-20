// Run with: node podium/test/snap.test.mjs
// Unit tests for Quick Shape & Straight-Line Snapping (Hold-to-Straighten, #38)
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initialState,
  applyCommand,
  applyInkAction,
  strokeHitTest,
  inkDigest,
  shoelaceArea,
  snapStraightLine,
  snapArrow,
  snapBox,
  snapEllipse,
  detectAndSnapShape,
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

console.log('-- shoelace polygon area calculation --');
{
  // 100 x 50 rectangle in pixels
  const rect = [
    [10, 10],
    [110, 10],
    [110, 60],
    [10, 60],
  ];
  const area = shoelaceArea(rect);
  chk('shoelaceArea calculates exact rectangle area (5000)', Math.abs(area - 5000) < 0.001);

  // Right triangle: base 60, height 40 -> area 1200
  const tri = [
    [0, 0],
    [60, 0],
    [0, 40],
  ];
  chk('shoelaceArea calculates right triangle area (1200)', Math.abs(shoelaceArea(tri) - 1200) < 0.001);

  chk('shoelaceArea returns 0 for less than 3 points', shoelaceArea([[0, 0], [10, 10]]) === 0);
  chk('shoelaceArea returns 0 for null/empty', shoelaceArea(null) === 0 && shoelaceArea([]) === 0);
}

console.log('-- straight line snapping & angle constraints --');
{
  const W = 1000, H = 1000;

  // Nearly horizontal line: y moves from 100 to 103 over 200px (angle ~0.86 deg < 5 deg)
  const nearlyHoriz = [];
  for (let x = 100; x <= 300; x += 10) {
    nearlyHoriz.push([x / W, (100 + Math.sin(x) * 2) / H]);
  }
  const snapH = snapStraightLine(nearlyHoriz, W, H);
  chk('nearly horizontal stroke snaps to 2 points', snapH?.pts?.length === 2);
  chk('nearly horizontal stroke snaps y1 to y0 exactly', snapH.pts[0][1] === snapH.pts[1][1]);
  chk('straight line preserves x range', snapH.pts[0][0] === 0.1 && snapH.pts[1][0] === 0.3);

  // Nearly vertical line: x moves from 200 to 204 over 300px (angle ~0.76 deg < 5 deg)
  const nearlyVert = [];
  for (let y = 200; y <= 500; y += 10) {
    nearlyVert.push([(200 + Math.cos(y) * 2) / W, y / H]);
  }
  const snapV = snapStraightLine(nearlyVert, W, H);
  chk('nearly vertical stroke snaps to 2 points', snapV?.pts?.length === 2);
  chk('nearly vertical stroke snaps x1 to x0 exactly', snapV.pts[0][0] === snapV.pts[1][0]);
  chk('straight line preserves y range', snapV.pts[0][1] === 0.2 && snapV.pts[1][1] === 0.5);

  // 45-degree diagonal line: (100, 100) to (302, 298)
  const diagonal = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    diagonal.push([(100 + 200 * t + (i % 2 === 0 ? 2 : -2)) / W, (100 + 200 * t) / H]);
  }
  const snapD = snapStraightLine(diagonal, W, H);
  chk('diagonal stroke snaps to 2 points', snapD?.pts?.length === 2);
  const dx = Math.abs(snapD.pts[1][0] - snapD.pts[0][0]);
  const dy = Math.abs(snapD.pts[1][1] - snapD.pts[0][1]);
  chk('diagonal stroke snaps to exact 45 degrees (|dx| === |dy|)', Math.abs(dx - dy) < 0.0002);

  // Free angle line: (100, 100) to (400, 200) (atan2(100, 300) = 18.4 deg)
  const freeLine = [
    [0.1, 0.1],
    [0.2, 0.16],
    [0.3, 0.14],
    [0.4, 0.2],
  ];
  const snapF = snapStraightLine(freeLine, W, H);
  chk('free angle line snaps directly between start and end', snapF.pts[0][0] === 0.1 && snapF.pts[1][0] === 0.4);
}

console.log('-- arrow snapping & arrowhead geometry --');
{
  const W = 1000, H = 1000;

  // Draw horizontal shaft from (100, 200) to (400, 200) [30 points]
  // Then barb turning back towards (370, 180) [10 points]
  const arrowPts = [];
  for (let x = 100; x <= 400; x += 10) {
    arrowPts.push([x / W, 200 / H]);
  }
  // Turn back for barb
  for (let s = 1; s <= 8; s++) {
    arrowPts.push([(400 - s * 3) / W, (200 - s * 2) / H]);
  }

  const detected = detectAndSnapShape(arrowPts, W, H);
  chk('detectAndSnapShape identifies arrow gesture', detected?.type === 'arrow');
  chk('arrow contains 5 points (shaft, tip, barb1, tip, barb2)', detected?.pts?.length === 5);

  const [p0, tip, b1, tipReturn, b2] = detected.pts;
  chk('arrow shaft starts at stroke origin', p0[0] === 0.1 && p0[1] === 0.2);
  chk('arrow tip matches maximum forward extent', tip[0] === 0.4 && tip[1] === 0.2);
  chk('arrow tip returns to same vertex for second barb', tipReturn[0] === tip[0] && tipReturn[1] === tip[1]);
  chk('both barbs are located behind the tip', b1[0] < tip[0] && b2[0] < tip[0]);

  // Check barb symmetry across the horizontal shaft
  const dy1 = b1[1] - tip[1];
  const dy2 = b2[1] - tip[1];
  chk('arrow barbs are symmetric across the shaft axis', Math.abs(dy1 + dy2) < 0.001 && Math.abs(dy1) > 0.005);
}

console.log('-- rectangle and square snapping --');
{
  const W = 1000, H = 1000;

  // Hand-drawn rectangle: 200 wide x 100 tall
  const rectPts = [];
  // Top: (100, 100) -> (300, 100)
  for (let x = 100; x <= 300; x += 10) rectPts.push([x / W, (100 + (x % 3)) / H]);
  // Right: (300, 100) -> (300, 200)
  for (let y = 100; y <= 200; y += 10) rectPts.push([(300 - (y % 3)) / W, y / H]);
  // Bottom: (300, 200) -> (100, 200)
  for (let x = 300; x >= 100; x -= 10) rectPts.push([x / W, (200 - (x % 3)) / H]);
  // Left: (100, 200) -> (100, 102)
  for (let y = 200; y >= 102; y -= 10) rectPts.push([(100 + (y % 3)) / W, y / H]);

  const snapR = detectAndSnapShape(rectPts, W, H);
  chk('detectAndSnapShape identifies rectangle gesture', snapR?.type === 'box');
  chk('snapped box produces 5 closed points', snapR?.pts?.length === 5);
  chk('box start and end points match (closed loop)', snapR.pts[0][0] === snapR.pts[4][0] && snapR.pts[0][1] === snapR.pts[4][1]);
  chk('non-square box has isSquare === false', snapR.isSquare === false);

  // Square: 150 wide x 150 tall
  const squarePts = [];
  for (let x = 100; x <= 250; x += 10) squarePts.push([x / W, 100 / H]);
  for (let y = 100; y <= 250; y += 10) squarePts.push([250 / W, y / H]);
  for (let x = 250; x >= 100; x -= 10) squarePts.push([x / W, 250 / H]);
  for (let y = 250; y >= 100; y -= 10) squarePts.push([100 / W, y / H]);

  const snapS = detectAndSnapShape(squarePts, W, H);
  chk('detectAndSnapShape identifies square gesture', snapS?.type === 'box' && snapS.isSquare === true);
  const sw = Math.abs(snapS.pts[1][0] - snapS.pts[0][0]);
  const sh = Math.abs(snapS.pts[2][1] - snapS.pts[1][1]);
  chk('snapped square has equal width and height', Math.abs(sw - sh) < 0.001);
}

console.log('-- circle and ellipse snapping --');
{
  const W = 1000, H = 1000;

  // Hand-drawn circle: radius 80 centered at (300, 300)
  const circlePts = [];
  const cx = 300, cy = 300, r = 80;
  for (let deg = 0; deg <= 360; deg += 10) {
    const rad = (deg * Math.PI) / 180;
    // Add tiny jitter
    const j = (deg % 20 === 0 ? 2 : -2);
    circlePts.push([(cx + (r + j) * Math.cos(rad)) / W, (cy + (r + j) * Math.sin(rad)) / H]);
  }

  const snapC = detectAndSnapShape(circlePts, W, H);
  chk('detectAndSnapShape identifies circle gesture', snapC?.type === 'ellipse' && snapC.isCircle === true);
  chk('snapped circle has 37 smooth sample points', snapC?.pts?.length === 37);
  chk('circle start and end points close the loop', snapC.pts[0][0] === snapC.pts[36][0] && snapC.pts[0][1] === snapC.pts[36][1]);

  // Ellipse: 200 wide x 100 tall
  const ellipsePts = [];
  for (let deg = 0; deg <= 360; deg += 10) {
    const rad = (deg * Math.PI) / 180;
    ellipsePts.push([(400 + 100 * Math.cos(rad)) / W, (400 + 50 * Math.sin(rad)) / H]);
  }
  const snapE = detectAndSnapShape(ellipsePts, W, H);
  chk('detectAndSnapShape identifies non-circular ellipse', snapE?.type === 'ellipse' && snapE.isCircle === false);
}

console.log('-- rejection of short strokes and scribbles --');
{
  const W = 1000, H = 1000;

  // Dot or tiny tap (length < 25px)
  const dot = [
    [0.5, 0.5],
    [0.502, 0.501],
    [0.501, 0.503],
  ];
  chk('detectAndSnapShape returns null for short dot stroke (< 25px)', detectAndSnapShape(dot, W, H) === null);

  // Single point
  chk('detectAndSnapShape returns null for single point', detectAndSnapShape([[0.5, 0.5]], W, H) === null);

  // Empty or null
  chk('detectAndSnapShape returns null for empty array', detectAndSnapShape([], W, H) === null);
  chk('detectAndSnapShape returns null for null', detectAndSnapShape(null, W, H) === null);
}

console.log('-- protocol compatibility: applyInkAction, erase, and digest --');
{
  const strokes = [];
  const line = snapStraightLine([[0.1, 0.1], [0.8, 0.1]], 1000, 1000);

  // 1. Begin stroke with snapped points
  applyInkAction(strokes, {
    action: 'begin',
    id: 'snap-line-1',
    color: '#34c759',
    width: 6,
    pts: line.pts,
  });
  chk('snapped stroke successfully recorded in strokes list', strokes.length === 1);
  chk('snapped stroke preserves id, color, and width', strokes[0].id === 'snap-line-1' && strokes[0].color === '#34c759');
  chk('snapped stroke points match snapped geometry', strokes[0].pts.length === 2);

  // 2. Digest computation
  const d1 = inkDigest(strokes);
  chk('inkDigest succeeds on snapped strokes', typeof d1 === 'object' && d1.n === 1);

  // 3. Hit testing against snapped line
  chk('strokeHitTest detects hit along the line', strokeHitTest(strokes[0], 450, 100, 1000, 1000));
  chk('strokeHitTest rejects point far from the line', !strokeHitTest(strokes[0], 450, 300, 1000, 1000));

  // 4. Erase snapped stroke
  const erased = applyInkAction(strokes, { action: 'erase', ids: ['snap-line-1'] });
  chk('applyInkAction erases snapped stroke cleanly', erased && strokes.length === 0);
}

console.log('-- settings UI and defaults --');
{
  const html = readFileSync(resolve(__dirname, '../control.html'), 'utf8');
  chk('control.html contains #pref-snap-shapes checkbox', html.includes('id="pref-snap-shapes"'));

  const js = readFileSync(resolve(__dirname, '../assets/js/control.js'), 'utf8');
  chk('control.js includes snapShapes in PRESENTATION_DEFAULTS', js.includes('snapShapes: true'));
  chk('control.js handles pref-snap-shapes change listener', js.includes("pref-snap-shapes'"));
  chk('control.js imports detectAndSnapShape from protocol.js', js.includes('detectAndSnapShape'));
  chk('control.js defines 450ms hold threshold', js.includes('HOLD_TO_SNAP_MS = 450'));
  chk('control.js defines 14px jitter radius', js.includes('HOLD_JITTER_RADIUS = 14'));
}

if (!ok) {
  console.error('\nTests FAILED');
  process.exit(1);
} else {
  console.log('\nAll 30+ shape snapping tests passed!');
}
