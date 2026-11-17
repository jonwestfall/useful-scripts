// Where a slide's content sits inside its <svg> box (slideMatrix in
// assets/js/deck.js): what Podium hands Marp's Safari polyfill in place of
// WebKit's getScreenCTM(), which leaves out a transformed ancestor and the
// page's scroll - and so put a slide's content lower in the Ink pad than the
// pad's canvas over it.
//
//   node podium/test/slide-matrix.test.mjs

import { slideMatrix } from '../assets/js/deck.js';

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const near = (a, b) => Math.abs(a - b) < 1e-9;
const same = (m, want) => ['a', 'b', 'c', 'd', 'e', 'f'].every((k) => near(m[k], want[k]));

// Marp's own formula, given a correct screen CTM for an svg whose box is at
// (left, top) on an unscrolled, untransformed page: the transform it puts on
// the section is matrix(a, b, c, d, e - left, f - top).
function marpWithTrueCTM(box, view, left, top) {
  const s = Math.min(box.width / view.width, box.height / view.height);
  const e = left + (box.width - view.width * s) / 2 - view.x * s;
  const f = top + (box.height - view.height * s) / 2 - view.y * s;
  return { a: s, b: 0, c: 0, d: s, e: e - left, f: f - top };
}

{
  const box = { width: 640, height: 360 };
  const view = { x: 0, y: 0, width: 1280, height: 720 };
  ok('a 16:9 slide in a 16:9 box: half size, no offset', same(slideMatrix(box, view), { a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 0 }));
  ok('the same as Marp gets from a correct CTM, wherever the box is', same(slideMatrix(box, view), marpWithTrueCTM(box, view, 37, 412)));
}

{
  // The pad sized a hair taller than the slide: letterboxed top and bottom.
  const box = { width: 800, height: 500 };
  const view = { x: 0, y: 0, width: 1280, height: 720 };
  const m = slideMatrix(box, view);
  ok('letterboxed: scaled by the width', near(m.a, 0.625) && near(m.d, 0.625));
  ok('letterboxed: centred down the box', near(m.e, 0) && near(m.f, (500 - 450) / 2));
  ok('letterboxed: as Marp with a correct CTM', same(m, marpWithTrueCTM(box, view, 0, 0)));
}

{
  // A slide Podium shrank to fit (setSlideScale): its viewBox grown by 1/0.8.
  const box = { width: 1024, height: 576 };
  const view = { x: 0, y: 0, width: 1600, height: 900 };
  ok('a fitted slide: the grown viewBox still fills the box', same(slideMatrix(box, view), { a: 0.64, b: 0, c: 0, d: 0.64, e: 0, f: 0 }));
}

{
  const box = { width: 400, height: 400 };
  const view = { x: 10, y: 20, width: 200, height: 100 };
  ok('a viewBox origin moves the content back', same(slideMatrix(box, view), marpWithTrueCTM(box, view, 5, 5)));
  ok('xMinYMin: no letterbox offset', same(slideMatrix(box, view, { align: 'xMinYMin' }), { a: 2, b: 0, c: 0, d: 2, e: -20, f: -40 }));
  ok('xMaxYMax: all the spare room before', same(slideMatrix(box, view, { align: 'xMaxYMax' }), { a: 2, b: 0, c: 0, d: 2, e: -20, f: 200 - 40 }));
  ok('slice: the larger scale', near(slideMatrix(box, view, { slice: true }).a, 4));
  ok('none: each axis its own scale', same(slideMatrix(box, view, { align: 'none' }), { a: 2, b: 0, c: 0, d: 4, e: -20, f: -80 }));
}

ok('no viewBox: the box as it is', same(slideMatrix({ width: 300, height: 200 }, null), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }));
ok('an empty box does not divide by zero', same(slideMatrix({ width: 0, height: 0 }, null), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }));

if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
