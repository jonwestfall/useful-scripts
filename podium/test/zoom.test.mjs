// Zooming a page or a photo on the projector (Issue #262, phase 2): the view
// arithmetic in assets/js/zoom.js, for portrait and landscape content on 16:9
// and 4:3 screens.
//
//   node podium/test/zoom.test.mjs

import { contentRect, visibleWindow, clampView, fitView, zoomAround, panBy, isZoomed, ZOOM_MAX, viewKeeping, contentPointAt, panelPointOf, zoomToSlider, sliderToZoom } from '../assets/js/zoom.js';

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const r2 = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1000) / 1000])));

const LETTER = 8.5 / 11;   // a portrait page
const SLIDE = 16 / 9;      // a landscape slide
const SCREEN = 16 / 9;
const OLD = 4 / 3;

console.log('-- fit page is the letterbox it always was --');
const page1 = contentRect(1600, 900, LETTER);
ok(`a portrait page on 16:9 is a centred column (${r2(page1)})`, near(page1.h, 900) && near(page1.w, 900 * LETTER) && near(page1.x, (1600 - 900 * LETTER) / 2) && near(page1.y, 0));
const slide1 = contentRect(1200, 900, SLIDE);
ok(`a 16:9 slide on 4:3 has bars top and bottom (${r2(slide1)})`, near(slide1.w, 1200) && near(slide1.y, (900 - 1200 / SLIDE) / 2));

console.log('\n-- zoomed, the screen is filled --');
const w = fitView('width', LETTER, SCREEN);
ok(`"fit width" on a portrait page zooms to the screen's width (${r2(w)})`, near(w.zoom, SCREEN / LETTER) && near(w.panX, 0.5));
const wRect = contentRect(1600, 900, LETTER, w);
ok(`and the page is exactly as wide as the screen, starting at its top (${r2(wRect)})`, near(wRect.w, 1600) && near(wRect.x, 0) && near(wRect.y, 0));
const win = visibleWindow(LETTER, SCREEN, w);
ok(`the room sees the whole width and the top part of the page (${r2(win)})`, near(win.x, 0) && near(win.w, 1) && near(win.y, 0) && win.h < 0.5);
const two = clampView({ zoom: 2, panX: 0.5, panY: 0.5 }, LETTER, SCREEN);
const twoRect = contentRect(1600, 900, LETTER, two);
ok(`at 2× a portrait page is still narrower than 16:9, so it stays centred sideways (${r2(twoRect)})`, twoRect.w < 1600 && near(twoRect.x, (1600 - twoRect.w) / 2));
const four = contentRect(1600, 900, LETTER, { zoom: 4, panX: 0.2, panY: 0.3 });
ok(`at 4× it is wider than the screen and fills it, panned where asked (${r2(four)})`, four.x <= 1e-6 && four.x + four.w >= 1600 - 1e-6 && four.y <= 1e-6 && four.y + four.h >= 900 - 1e-6);
ok('fit height on a landscape slide on 4:3 fills the height', near(contentRect(1200, 900, SLIDE, fitView('height', SLIDE, OLD)).h, 900));
ok('a preset already met is just fit page', fitView('width', SLIDE, SCREEN).zoom === 1 && fitView('height', LETTER, SCREEN).zoom === 1);

console.log('\n-- the window stays on the content --');
const edge = clampView({ zoom: 4, panX: 0, panY: 1 }, LETTER, SCREEN);
const edgeRect = contentRect(1600, 900, LETTER, edge);
ok(`panned past the corner, it stops at the corner (${r2(edgeRect)})`, near(edgeRect.x, 0) && near(edgeRect.y + edgeRect.h, 900));
ok('zoom is between 1 and the maximum', clampView({ zoom: 99 }, LETTER, SCREEN).zoom === ZOOM_MAX && clampView({ zoom: 0 }, LETTER, SCREEN).zoom === 1);
ok('nonsense comes out as fit page', JSON.stringify(clampView({ zoom: 'x', panX: NaN }, LETTER, SCREEN)) === JSON.stringify({ zoom: 1, panX: 0.5, panY: 0.5 }));

console.log('\n-- zooming around a point, and panning --');
const at = zoomAround({ zoom: 4, panX: 0.5, panY: 0.5 }, 6, LETTER, SCREEN, 0.25, 0.75);
const before = contentRect(SCREEN, 1, LETTER, { zoom: 4, panX: 0.5, panY: 0.5 });
const after = contentRect(SCREEN, 1, LETTER, at);
const fracBefore = [(0.25 * SCREEN - before.x) / before.w, (0.75 - before.y) / before.h];
const fracAfter = [(0.25 * SCREEN - after.x) / after.w, (0.75 - after.y) / after.h];
ok(`the point under a pinch stays under it (${fracBefore.map((f) => f.toFixed(3))} → ${fracAfter.map((f) => f.toFixed(3))})`,
  near(fracBefore[0], fracAfter[0], 1e-4) && near(fracBefore[1], fracAfter[1], 1e-4));
const down = panBy(w, 0, 0.5, LETTER, SCREEN);
ok(`half a window down from the top of a fit-width page (${r2(down)} from ${r2(w)})`, down.panY > w.panY && near(down.zoom, w.zoom));
ok('panning sideways where the page already fills the width does nothing', near(panBy(w, 1, 0, LETTER, SCREEN).panX, 0.5));
ok('isZoomed tells fit page from anything else', !isZoomed({ zoom: 1 }) && isZoomed({ zoom: 1.5 }) && !isZoomed(null));

console.log('\n-- for gestures (phase 3) --');
const kept = viewKeeping(0.3, 0.6, 0.25, 0.5, 3, LETTER, SCREEN);
const there = panelPointOf(kept, 0.3, 0.6, LETTER, SCREEN);
ok(`a pinch keeps the words under the fingers under them (${r2(there)})`, near(there.x, 0.25, 1e-6) && near(there.y, 0.5, 1e-6));
const back = contentPointAt(kept, there.x, there.y, LETTER, SCREEN);
ok('and the two directions agree', near(back.x, 0.3) && near(back.y, 0.6));
ok(`the slider runs 0 (1×) to 100 (${ZOOM_MAX}×), evenly in log (2× is ${zoomToSlider(2)})`,
  zoomToSlider(1) === 0 && zoomToSlider(ZOOM_MAX) === 100 && near(sliderToZoom(zoomToSlider(2)), 2, 0.05) && sliderToZoom(-5) === 1);

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
