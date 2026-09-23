// Podium end-to-end group: ink, split layouts, picture-in-picture and what gets kept.
//
//   node podium/test/e2e/ink-layout.mjs [--only <name>[,<name>...]]
//
// Starts its own relay and browser (see harness.mjs), so it runs on its own.
// node podium/test/e2e.mjs runs every group.

import {
  HERE,
  fs,
  path,
  execFileSync,
  writeImageFixture,
  writeAlphaImageFixture,
  PORT,
  BASE,
  browser,
  ok,
  want,
  trap,
  reportErrors,
  teardown,
  exitWithResult
} from './harness.mjs';

try {
if (want('ink is shaped to the content, not the whole (possibly letterboxed) screen')) {
console.log('\n-- ink is shaped to the content, not the whole (possibly letterboxed) screen --');
// A deliberately odd, very wide viewport: a 16:9 deck slide will be
// pillarboxed with real dead space left and right of it.
const ctx = await browser.newContext({ viewport: { width: 1500, height: 500 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'ink-room', passphrase: 'stay in bounds' }));
const screen = await ctx.newPage();
trap(screen, 'ink display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'ink control');
await pad.setViewportSize({ width: 900, height: 700 });
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Podium deck features (example)"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length === 4, null, { timeout: 20000 });

const contentBox = await screen.evaluate(() => {
  const stage = document.querySelector('#stage');
  const svg = document.querySelector('.layer[data-role="program"] .r-deck').shadowRoot.querySelector('svg.podium-on');
  const box = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
  const aspect = box[2] / box[3];
  const w = stage.clientWidth, h = stage.clientHeight;
  const stageAspect = w / h;
  if (stageAspect > aspect) { const cw = h * aspect; return { x: (w - cw) / 2, y: 0, w: cw, h }; }
  const ch = w / aspect; return { x: 0, y: (h - ch) / 2, w, h: ch };
});
ok(`the 16:9 slide is genuinely pillarboxed in this window (dead margin ${Math.round(contentBox.x)}px each side)`, contentBox.x > 50);

// Every tab shares one scrolling container - scrolled deep into a long
// Library, switching tabs must not carry that scroll position into the
// next one, or a tall panel (Ink, here) starts measured from a viewport
// rect shifted up off the top of the screen.
await pad.evaluate(() => { document.querySelector('.panels').scrollTop = 400; });
await pad.click('.tab[data-tab="ink"]');
ok('switching tabs resets the shared scroll position', await pad.evaluate(() => document.querySelector('.panels').scrollTop === 0));
await pad.waitForTimeout(300);
const padBox = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
// Draw right near the pad's own left edge - if the pad is correctly shaped to
// the slide (not the raw window), this must land inside the slide's content
// box on the display, never out in the pillarbox margin.
const drawFrac = [0.03, 0.5];
await pad.mouse.move(padBox.x + padBox.w * drawFrac[0], padBox.y + padBox.h * drawFrac[1]);
await pad.mouse.down();
await pad.mouse.move(padBox.x + padBox.w * 0.15, padBox.y + padBox.h * 0.55);
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });

const paintedNearEdge = await screen.evaluate((box) => {
  const c = document.querySelector('#ink');
  const ctx = c.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  // A strip just inside the computed content box's left edge.
  const x0 = Math.max(0, Math.round((box.x + 2) * ratio));
  const x1 = Math.round((box.x + box.w * 0.2) * ratio);
  const y0 = Math.round(box.y * ratio);
  const y1 = Math.round((box.y + box.h) * ratio);
  const data = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
  return false;
}, contentBox);
ok('the stroke actually lands inside the slide’s own bounds', paintedNearEdge);

const paintedInMargin = await screen.evaluate((box) => {
  if (box.x < 4) return false; // no real margin to check in this layout
  const c = document.querySelector('#ink');
  const ctx = c.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const data = ctx.getImageData(0, 0, Math.round(box.x * ratio), c.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
  return false;
}, contentBox);
ok('and never spills into the pillarbox margin outside it', !paintedInMargin);

// Switching to unrelated content shows a blank surface, not the deck's ink.
await pad.click('.tab[data-tab="say"]');
await pad.click('#text-open-editor');
await pad.fill('#msg-body', 'Back in 5');
await pad.click('#message-editor-show');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-text'), null, { timeout: 5000 });
await screen.waitForTimeout(400);
ok('switching to a text message clears the ink layer visually', !(await screen.evaluate(() => document.querySelector('#ink').classList.contains('has-ink'))));

// And returning to the same slide restores it.
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Podium deck features (example)"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck'), null, { timeout: 10000 });
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
ok('returning to that slide restores its own ink', true);

await pad.click('.tab[data-tab="ink"]');
await pad.waitForTimeout(700);
await pad.click('#ink-clear');
await screen.waitForFunction(() => !document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
ok('Clear wipes only the surface currently on screen', true);
await ctx.close();
}

if (want('keeping what was on screen: panel photos, screenshots, and the export')) {
console.log('\n-- keeping what was on screen: panel photos, screenshots, and the export --');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
// try/catch because this section puts a cross-origin page on screen, and an
// init script runs in that frame too - where storage is (correctly) denied.
await ctx.addInitScript((cfg) => { try { localStorage.setItem('podium.config.v2', cfg); } catch { /* not our frame */ } },
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'keep-room', passphrase: 'keep that board' }));
const screen = await ctx.newPage();
trap(screen, 'keep display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'keep pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

// A board with something on it: the case the whole feature exists for.
await pad.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await screen.waitForSelector('.r-whiteboard');
await pad.click('.tab[data-tab="ink"]');
const pad1 = await pad.locator('#pad').boundingBox();
await pad.mouse.move(pad1.x + 60, pad1.y + 60);
await pad.mouse.down();
for (let i = 0; i < 12; i++) await pad.mouse.move(pad1.x + 60 + i * 18, pad1.y + 60 + Math.sin(i / 2) * 40);
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 8000 });

await pad.click('#ink-save');
await pad.waitForSelector('#photo-strip .shot', { timeout: 20000 });
ok('Save a photo on the Ink tab keeps the annotated board', true);
const kept = await pad.evaluate(() => {
  const img = document.querySelector('#photo-strip .shot img');
  return { jpeg: img.src.startsWith('data:image/jpeg'), badge: document.querySelector('#photo-strip .shot-num').textContent };
});
ok(`it is a real photo, taken on the display (badge "${kept.badge}")`, kept.jpeg && kept.badge === 'Panel A');
await pad.click('#photo-strip .shot');
await screen.waitForFunction(() => !!document.querySelector('.layer[data-role="program"] .r-image'), null, { timeout: 10000 });
ok('and it goes straight back up as an ordinary photo', true);

// The photo has to BE the board plus the ink - not a blank rectangle. Measured
// on the projector rather than on the thumbnail in the strip: the strip draws
// small JPEG copies, and a 6px pen shrunk to a fifth of its size and
// re-compressed is not a fair test of whether the ink was captured.
const hasInk = await screen.evaluate(() => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx2 = c.getContext('2d');
    ctx2.drawImage(img, 0, 0);
    const { data } = ctx2.getImageData(0, 0, c.width, c.height);
    let board = 0;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      // The board is near-white; the pen is #ffd166, which is much less blue.
      if (data[i] > 200 && data[i + 2] > 200) board++;
      else if (data[i] > 180 && data[i + 2] < 160) ink++;
    }
    resolve({ board, ink });
  };
  img.src = document.querySelector('.layer[data-role="program"] .r-image').src;
}));
ok(`the photo really is the board with the ink burnt into it (${hasInk.ink} inked pixels)`, hasInk.board > 1000 && hasInk.ink > 200);

// Hold a panel letter. The click that a tap would fire must not also happen.
await pad.click('.layout-btn[data-layout="2h"]');
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-2h'), null, { timeout: 8000 });
await pad.waitForSelector('.panel-btn');
const letter = await pad.locator('.panel-btn').nth(1).boundingBox();
await pad.mouse.move(letter.x + letter.width / 2, letter.y + letter.height / 2);
await pad.mouse.down();
await pad.waitForTimeout(1000);
await pad.mouse.up();
await pad.waitForFunction(() => document.querySelectorAll('#photo-strip .shot').length === 2, null, { timeout: 20000 });
ok('holding a panel letter photographs that panel', true);
ok('and photographs the panel held, not the one in focus',
  (await pad.evaluate(() => document.querySelector('#photo-strip .shot-num').textContent)) === 'Panel B');
// The tap that a hold would otherwise also fire has to be swallowed, or
// holding "B" photographs B and moves every controller's focus to it.
ok('and the hold does not also fire the tap underneath it',
  (await pad.evaluate(() => document.querySelector('.panel-btn.is-on')?.textContent)) === 'A');
await pad.locator('.panel-btn').nth(1).click();
await pad.waitForFunction(() => document.querySelector('.panel-btn.is-on')?.textContent === 'B', null, { timeout: 8000 })
  .then(() => ok('while a plain tap still focuses that panel', true))
  .catch(() => ok('while a plain tap still focuses that panel', false));
await pad.locator('.panel-btn').nth(0).click();
await pad.waitForFunction(() => document.querySelector('.panel-btn.is-on')?.textContent === 'A', null, { timeout: 8000 });

// Hold a layout button: the whole screen, and the layout must not change.
const layout = await pad.locator('.layout-btn[data-layout="4"]').boundingBox();
await pad.mouse.move(layout.x + layout.width / 2, layout.y + layout.height / 2);
await pad.mouse.down();
await pad.waitForTimeout(1500);
await pad.mouse.up();
await pad.waitForFunction(() => document.querySelectorAll('#photo-strip .shot').length === 3, null, { timeout: 20000 });
ok('holding a layout button photographs the whole screen', true);
ok('and does not also rearrange the screen it just photographed',
  await pad.evaluate(() => document.querySelector('.layout-btn[data-layout="2h"]').classList.contains('is-on')));
const screenShot = await pad.evaluate(() => {
  const img = document.querySelector('#photo-strip .shot img');
  return { badge: document.querySelector('#photo-strip .shot-num').textContent, len: img.src.length };
});
ok(`the screenshot is the whole stage, not one panel (${screenShot.badge})`, screenShot.badge === 'Screen' && screenShot.len > 2000);

// A slide is the hard case: Marpit scopes every rule it emits to
// `div.marpit > svg > ...`, and a slide rasterized on its own has no such
// wrapper - so an unfixed build photographs a deck as a black rectangle
// (unstyled black text on a transparent ground) and exports slides with no
// theme on them at all.
const rescoped = await pad.evaluate(async () => {
  const deck = await import('/assets/js/deck.js');
  return deck.cssForStandaloneSlide('div.marpit > svg > foreignObject > section{color:red}');
});
ok('a slide lifted out of the page has its theme re-scoped to follow it',
  rescoped === 'svg > foreignObject > section{color:red}');

// Back to one panel for this one, so "how much of the photo is black" is a
// statement about the slide rather than about the letterboxing a half-width
// panel puts around it.
await pad.click('.layout-btn[data-layout="single"]');
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-single'), null, { timeout: 8000 });
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence"))');
await screen.waitForFunction(() => !!document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelector('svg.podium-on'), null, { timeout: 40000 });
await screen.waitForTimeout(1500);
// Annotate it too, so the export has a marked-up slide to render as well.
await pad.click('.tab[data-tab="ink"]');
await pad.waitForTimeout(800);
const pad2 = await pad.locator('#pad').boundingBox();
await pad.mouse.move(pad2.x + 40, pad2.y + 40);
await pad.mouse.down();
for (let i = 0; i < 10; i++) await pad.mouse.move(pad2.x + 40 + i * 22, pad2.y + 40 + i * 7);
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 8000 });
await pad.click('.tab[data-tab="photos"]');
await pad.click('#photo-panel');
await pad.waitForFunction(() => document.querySelectorAll('#photo-strip .shot').length === 4, null, { timeout: 25000 });
const slideShot = await pad.evaluate(() => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const ctx2 = c.getContext('2d');
    ctx2.drawImage(img, 0, 0);
    const { data } = ctx2.getImageData(0, 0, c.width, c.height);
    let black = 0;
    let themed = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r + g + b < 40) black++;
      // This deck's title slide is a field of Delta State green.
      else if (g > r + 20 && g > b + 10) themed++;
    }
    const n = c.width * c.height;
    resolve({ blackPct: Math.round(black / n * 100), themedPct: Math.round(themed / n * 100) });
  };
  img.src = document.querySelector('#photo-strip .shot img').src;
}));
ok(`a photographed slide is the slide, theme and all (${slideShot.themedPct}% of it is the theme's green)`, slideShot.themedPct > 20);
ok(`and not the black rectangle an unscoped stylesheet produces (${slideShot.blackPct}% black)`, slideShot.blackPct < 35);

// The same two things from a keyboard, for whoever teaches with a Magic
// Keyboard propped up rather than an iPad in hand.
await pad.keyboard.press('p');
await pad.waitForFunction(() => document.querySelectorAll('#photo-strip .shot').length === 5, null, { timeout: 20000 })
  .then(() => ok('P photographs the focused panel', true))
  .catch(() => ok('P photographs the focused panel', false));
await pad.keyboard.press('Shift+P');
await pad.waitForFunction(() => document.querySelector('#photo-strip .shot-num')?.textContent === 'Screen', null, { timeout: 20000 })
  .then(() => ok('and Shift+P photographs the whole screen', true))
  .catch(() => ok('and Shift+P photographs the whole screen', false));
const beforeCtrlP = (await pad.$$('#photo-strip .shot')).length;
await pad.keyboard.press('Control+p');
await pad.waitForTimeout(2500);
ok('while Ctrl+P still belongs to the browser, not to Podium',
  (await pad.$$('#photo-strip .shot')).length === beforeCtrlP);

// An embedded page cannot be photographed, and says so rather than saving a lie.
await pad.click('.tab[data-tab="library"]');
await pad.fill('#url-input', 'https://example.com/');
await pad.click('#url-form button[type="submit"]');
await screen.waitForSelector('.layer[data-role="program"] .r-web', { timeout: 10000 });
await pad.click('.tab[data-tab="photos"]');
await pad.click('#photo-panel');
await pad.waitForFunction(() => /cannot be photographed|cannot photograph/.test(document.querySelector('#photo-note').textContent), null, { timeout: 15000 });
const refusal = await pad.textContent('#photo-note');
ok(`a panel Podium cannot photograph says so, in terms of what is in it ("${refusal.slice(0, 60)}…")`,
  /embedded web page/.test(refusal));
ok('and nothing was added to the strip', (await pad.$$('#photo-strip .shot')).length === 6);

// The export: photos, annotated slides, and the board itself.
const download = pad.waitForEvent('download', { timeout: 40000 });
// Clicked from inside the page while watching the button: renderPhotos() runs
// on every heartbeat and used to re-enable it half a second in, where a second
// tap starts a second export that steals the first one's ink from the display.
const enabledMidExport = await pad.evaluate(() => new Promise((resolve) => {
  const btn = document.querySelector('#photo-export');
  const status = document.querySelector('#photo-export-status');
  let seen = false;
  const poll = setInterval(() => {
    const finished = /Saved|failed|Nothing/.test(status.textContent);
    if (!btn.disabled && !finished) seen = true;   // enabled while still working
    if (finished) { clearInterval(poll); resolve(seen); }
  }, 40);
  btn.click();
  setTimeout(() => { clearInterval(poll); resolve(seen); }, 20000);
}));
const file = await download;
ok('the export button is not re-enabled underneath a running export', !enabledMidExport);
const zipPath = path.join(HERE, 'fixtures', 'session-export.zip');
await file.saveAs(zipPath);
const names = [];
{
  // Just enough of a ZIP reader to check what is inside: local file headers,
  // in order, each naming its entry.
  const buf = fs.readFileSync(zipPath);
  let at = 0;
  while (at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const size = buf.readUInt32LE(at + 18);
    names.push(buf.toString('utf8', at + 30, at + 30 + nameLen));
    at += 30 + nameLen + extraLen + size;
  }
}
ok(`the export is a zip holding ${names.length} files`, names.length >= 5);
ok('with every photo in it', names.filter((n) => n.startsWith('photos/')).length === 6);
ok('with the annotated slide, rendered from the deck rather than photographed',
  names.some((n) => n.startsWith('slides/') && n.endsWith('.png')));
ok('with the board that was drawn on, rebuilt as an image', names.some((n) => n.startsWith('boards/')));
ok('and a manifest saying what is inside', names.includes('session.txt'));
ok('named for the room and the day, not "download (3)"', /^podium-keep-room-\d{4}-\d{2}-\d{2}/.test(file.suggestedFilename()));

// The strip is drawn from small copies: two dozen full-size photos, rendered
// twice over (Camera tab and Photos tab), is a few hundred megabytes of
// decoded bitmap on the device least able to spare it.
await pad.waitForFunction(() => [...document.querySelectorAll('#photo-strip .shot img')].every((i) => i.src.length < 30000), null, { timeout: 15000 })
  .then(() => ok('the strip draws small copies rather than the full photos', true))
  .catch(() => ok('the strip draws small copies rather than the full photos', false));
ok('and every tile says when it was taken', (await pad.$$('#photo-strip .shot-time')).length === 6);

const single = pad.waitForEvent('download', { timeout: 20000 });
await pad.click('#photo-strip .shot .shot-save');
const onePhoto = await single;
ok(`one photo can be saved on its own, without building the whole zip (${onePhoto.suggestedFilename()})`,
  /\.jpg$/.test(onePhoto.suggestedFilename()));
ok('and saving it neither removes it nor puts it on screen', (await pad.$$('#photo-strip .shot')).length === 6);

// Discarding the lot is two taps, like everything else here that cannot be
// undone - and it is about the strip, not about the projector.
await pad.click('#photo-strip .shot');
await screen.waitForFunction(() => !!document.querySelector('.layer[data-role="program"] .r-image'), null, { timeout: 10000 });
await pad.click('#photo-clear');
ok('one tap only arms "discard every photo"', (await pad.$$('#photo-strip .shot')).length === 6);
await pad.click('#photo-clear');
await pad.waitForFunction(() => document.querySelectorAll('#photo-strip .shot').length === 0, null, { timeout: 5000 })
  .then(() => ok('the second tap clears the strip', true))
  .catch(() => ok('the second tap clears the strip', false));
ok('and what the class is looking at is not touched by it',
  await screen.evaluate(() => !!document.querySelector('.layer[data-role="program"] .r-image')));

// Last, because it empties this controller's strip: a controller that reloads
// mid-lecture has no bytes for the photo the projector is showing. It asks the
// display for them rather than rendering `asset:<id>` as a URL, which is a
// broken image in every mirror on the page.
await pad.reload();
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'), null, { timeout: 20000 });
await pad.waitForFunction(() => {
  const img = document.querySelector('#preview-stage img');
  return !!img && img.src.startsWith('data:image/jpeg');
}, null, { timeout: 15000 })
  .then(() => ok('a reloaded controller gets the photo back from the display', true))
  .catch(() => ok('a reloaded controller gets the photo back from the display', false));
ok('and never renders an asset: reference as if it were a URL',
  await pad.evaluate(() => ![...document.querySelectorAll('img')].some((i) => i.getAttribute('src')?.startsWith('asset:'))));
await ctx.close();
}

if (want('progressive builds: bullets arrive one at a time')) {
console.log('\n-- progressive builds: bullets arrive one at a time --');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'build-room', passphrase: 'one at a time' }));
const screen = await ctx.newPage();
trap(screen, 'build display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'build control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

const shown = () => screen.evaluate(() => {
  const svg = document.querySelector('.layer[data-role="program"] .r-deck').shadowRoot.querySelector('svg.podium-on');
  const frags = [...svg.querySelectorAll('.podium-fragment')];
  return { total: frags.length, shown: frags.filter((f) => f.classList.contains('is-shown')).length };
});

await pad.click('.tile:has(.tile-title:text-is("Progressive builds (example)"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length === 4, null, { timeout: 20000 });
await pad.click('.tab[data-tab="slides"]');

await pad.click('#deck-next'); // slide 0 -> slide 1, the first "_class: build" slide
await screen.waitForTimeout(400);
let s = await shown();
ok(`landing on a build slide starts with nothing revealed (${s.shown}/${s.total})`, s.total === 3 && s.shown === 0);

await pad.click('#deck-next');
await screen.waitForTimeout(300);
ok('Next reveals one bullet instead of moving slides', (await shown()).shown === 1);
await pad.click('#deck-next');
await screen.waitForTimeout(300);
ok('and the next one', (await shown()).shown === 2);
await pad.click('#deck-next');
await screen.waitForTimeout(300);
ok('and the last', (await shown()).shown === 3);

const beforeAdvance = await screen.evaluate(() => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  const svgs = [...host.shadowRoot.querySelectorAll('svg[data-marpit-svg]')];
  return svgs.findIndex((x) => x.classList.contains('podium-on'));
});
await pad.click('#deck-next');
await screen.waitForFunction((prev) => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  const svgs = [...host.shadowRoot.querySelectorAll('svg[data-marpit-svg]')];
  return svgs.findIndex((x) => x.classList.contains('podium-on')) === prev + 1;
}, beforeAdvance, { timeout: 5000 });
ok('only once every bullet is shown does Next finally advance the slide', true);

// The next slide uses hand-marked class="build" paragraphs instead of <li>.
s = await shown();
ok(`a hand-marked build slide also starts unrevealed (${s.shown}/${s.total})`, s.total === 2 && s.shown === 0);

// Jumping via a thumbnail should land fully built, not bullet-by-bullet.
await pad.evaluate(() => document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cell')[1].click());
await screen.waitForTimeout(400);
s = await shown();
ok('jumping to a build slide via its thumbnail shows it fully revealed', s.total === 3 && s.shown === 3);

// And the thumbnail grid itself always shows slides fully built.
const gridFullyShown = await pad.evaluate(() => {
  const cells = [...document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cell')];
  const cell = cells[1];
  const frags = [...cell.querySelectorAll('.podium-fragment')];
  return frags.length > 0 && frags.every((f) => getComputedStyle(f).opacity === '1');
});
ok('thumbnails always render a build slide finished, for a clear picture to jump to', gridFullyShown);
await ctx.close();
}

if (want('zoom on the ink pad is a view convenience, not a coordinate change')) {
console.log('\n-- zoom on the ink pad is a view convenience, not a coordinate change --');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'zoom-room', passphrase: 'steady hand' }));
const screen = await ctx.newPage();
trap(screen, 'zoom display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'zoom control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));
await pad.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await screen.waitForFunction(() => !!document.querySelector('.layer[data-role="program"] .r-whiteboard'), null, { timeout: 10000 });
await pad.click('.tab[data-tab="ink"]');
await pad.waitForTimeout(300);

const pixelAt = async (fx, fy) => screen.evaluate(({ fx, fy }) => {
  const stage = document.querySelector('#stage');
  const c = document.querySelector('#ink');
  const ratio = window.devicePixelRatio || 1;
  const x = Math.round(stage.clientWidth * fx * ratio);
  const y = Math.round(stage.clientHeight * fy * ratio);
  const d = c.getContext('2d').getImageData(Math.max(0, x - 6), Math.max(0, y - 6), 12, 12).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
  return false;
}, { fx, fy });

// A short dab at the pad's exact center, at zoom 1x. (A bare click() is
// down+up with no intervening pointermove, so the stroke would only ever get
// one point - and a one-point stroke draws nothing - hence the tiny drag.)
const dab = async (fx, fy) => {
  const b = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await pad.mouse.move(b.x + b.w * fx, b.y + b.h * fy);
  await pad.mouse.down();
  await pad.mouse.move(b.x + b.w * fx + 2, b.y + b.h * fy + 2);
  await pad.mouse.up();
};
await dab(0.5, 0.5);
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
ok('a dot at the pad center lands at the stage center', await pixelAt(0.5, 0.5));
await pad.click('#ink-undo');
await screen.waitForFunction(() => !document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });

// Same button, reached from a physical keyboard rather than a tap - the one
// modified key exempted from "a modified key is not ours" (see control.js).
await dab(0.5, 0.5);
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
await pad.keyboard.press('Control+z');
await screen.waitForFunction(() => !document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });

await pad.click('#ink-zoom-in');
await pad.click('#ink-zoom-in');
await pad.waitForTimeout(700);
const zoomedTransform = await pad.$eval('#pad-frame', (n) => n.style.transform);
ok(`zooming in actually scales the pad (${zoomedTransform})`, /scale\(([2-9]|\d\d)/.test(zoomedTransform) || /scale\(2\.\d/.test(zoomedTransform));
ok('pan buttons become available once zoomed', await pad.$eval('#pan-left', (b) => !b.disabled));

// The SAME center point, now dabbed on the zoomed (larger, post-transform)
// pad box, must still land at the stage center - zoom changes what you see,
// never where the mark actually goes.
await dab(0.5, 0.5);
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
ok('the same relative point still lands in the same place once zoomed', await pixelAt(0.5, 0.5));

await pad.click('#ink-zoom-reset');
await pad.waitForTimeout(700);
ok('reset zoom returns to 1x and disables panning again', await pad.$eval('#pan-left', (b) => b.disabled));
await ctx.close();
}

if (want('exporting marked-up slides to a zip')) {
console.log('\n-- exporting marked-up slides to a zip --');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'export-room', passphrase: 'zip it up' }));
const screen = await ctx.newPage();
trap(screen, 'export display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'export control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Podium deck features (example)"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length === 4, null, { timeout: 20000 });

// Annotate slide 1 before exporting.
await pad.click('.tab[data-tab="ink"]');
await pad.waitForTimeout(300);
const box = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await pad.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.3);
await pad.mouse.down();
await pad.mouse.move(box.x + box.w * 0.6, box.y + box.h * 0.6);
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
// Give the debounced save/broadcast a moment, then confirm the display has
// actually filed the stroke under this slide's own surface before exporting.
await screen.waitForTimeout(300);

await pad.click('.tab[data-tab="slides"]');
await pad.waitForFunction(() => !document.querySelector('#deck-export').disabled, null, { timeout: 10000 });

const downloadDir = path.join(HERE, 'fixtures', 'downloads');
fs.mkdirSync(downloadDir, { recursive: true });
const [download] = await Promise.all([
  pad.waitForEvent('download', { timeout: 20000 }),
  pad.click('#deck-export'),
]);
const zipPath = path.join(downloadDir, 'export.zip');
await download.saveAs(zipPath);
ok(`the export produced a real file (${fs.statSync(zipPath).size} bytes)`, fs.statSync(zipPath).size > 1000);

const listing = execFileSync('python3', ['-c', `
import zipfile, sys, struct
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
assert z.testzip() is None, "corrupt zip"
pngs = sorted(n for n in names if n.endswith('.png'))
assert len(pngs) == 4, f"expected 4 slide images, got {pngs}"
for n in pngs:
    data = z.read(n)
    assert data[:8] == b'\\x89PNG\\r\\n\\x1a\\n', f"{n} is not a PNG"
    w, h = struct.unpack('>II', data[16:24])
    assert w > 200 and h > 200, f"{n} is suspiciously small: {w}x{h}"
manifest = z.read('slides.txt').decode()
assert 'annotated' in manifest.lower(), manifest
print('OK', len(pngs), 'pngs', len(manifest), 'byte manifest')
`, zipPath]).toString().trim();
ok(`the zip contains four valid, correctly sized slide PNGs (${listing})`, listing.startsWith('OK'));

const statusText = await pad.textContent('#deck-export-status');
ok(`the controller reports success: ${JSON.stringify(statusText)}`, /saved/i.test(statusText));
await ctx.close();
}

if (want('the Ink tab shows what you are drawing on, and can hide it')) {
console.log('\n-- the Ink tab shows what you are drawing on, and can hide it --');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'ink-mirror-room', passphrase: 'see what you draw on' }));
const screen = await ctx.newPage();
trap(screen, 'inkmirror display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'inkmirror control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Podium deck features (example)"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length === 4, null, { timeout: 20000 });
await pad.click('.tab[data-tab="ink"]');
await pad.waitForTimeout(500);
ok('the ink pad mirrors the actual slide behind the canvas', await pad.evaluate(() => document.querySelector('#pad-mirror').querySelector('.r-deck') !== null));

await pad.click('#ink-toggle-mirror');
ok('a toggle can hide that mirror', await pad.evaluate(() => document.querySelector('#pad-mirror').classList.contains('is-hidden')));
await pad.click('#ink-toggle-mirror');
ok('and show it again', !(await pad.evaluate(() => document.querySelector('#pad-mirror').classList.contains('is-hidden'))));
await ctx.close();
}

if (want('ink survives a layout change mid-stroke instead of warping')) {
console.log('\n-- ink survives a layout change mid-stroke instead of warping --');
// A pad frame that resizes WHILE a stroke is still in progress is what
// warped ink on a real iPad: an iPad rotation crosses the controller's
// @media(max-width:900px) breakpoint (the preview rail moves from beside the
// pad to above it), reshaping #pad-viewport mid-gesture. Points captured
// before vs after that reshape are fractions of two DIFFERENT boxes, so
// redrawing them all under one final size warps the stroke. Start narrow
// (portrait, stacked layout) and rotate to wide (landscape, side-by-side)
// with the pointer still down.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'ink-rotate-room', passphrase: 'rotate me' }));
const screen = await ctx.newPage();
trap(screen, 'ink-rotate display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'ink-rotate control');
await pad.goto(`${BASE}/control.html`);
await pad.setViewportSize({ width: 820, height: 1180 });
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Podium deck features (example)"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length === 4, null, { timeout: 20000 });
await pad.click('.tab[data-tab="ink"]');
await pad.waitForTimeout(400);

const frameBox = () => pad.evaluate(() => { const f = document.querySelector('#pad-frame'); return { w: f.style.width, h: f.style.height, left: f.style.left, top: f.style.top }; });
const padBox = () => pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const before = await frameBox();

let pb = await padBox();
await pad.mouse.move(pb.x + pb.w * 0.2, pb.y + pb.h * 0.2);
await pad.mouse.down();
await pad.mouse.move(pb.x + pb.w * 0.3, pb.y + pb.h * 0.3);
await pad.setViewportSize({ width: 1180, height: 820 });
await pad.waitForTimeout(150);
ok('the pad frame does not resize while a stroke is still in progress', JSON.stringify(await frameBox()) === JSON.stringify(before));

await pad.mouse.move(pb.x + pb.w * 0.4, pb.y + pb.h * 0.4);
await pad.mouse.up();
await pad.waitForTimeout(300);
ok('and catches up to the new size once the stroke ends', JSON.stringify(await frameBox()) !== JSON.stringify(before));

// A fresh circle drawn entirely AFTER the rotation settled should stay
// round on the projector - equal PHYSICAL pixel radii on both axes, since
// the pad's own box is 16:9 and equal fractions of w/h would draw an
// ellipse by construction regardless of any bug.
await pad.click('#ink-clear');
await screen.waitForFunction(() => !document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
await pad.evaluate(() => { document.querySelector('.panels').scrollTop = 0; });
pb = await padBox();
const cx = pb.x + pb.w * 0.5, cy = pb.y + pb.h * 0.5, r = Math.min(pb.w, pb.h) * 0.3;
await pad.mouse.move(cx + r, cy);
await pad.mouse.down();
for (let i = 0; i <= 24; i++) { const a = (i / 24) * 2 * Math.PI; await pad.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
const painted = await screen.evaluate(() => {
  const cv = document.querySelector('#ink'); const c2d = cv.getContext('2d');
  const data = c2d.getImageData(0, 0, cv.width, cv.height).data;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < cv.height; y += 2) for (let x = 0; x < cv.width; x += 2) {
    const i = (y * cv.width + x) * 4;
    if (data[i + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return { w: maxX - minX, h: maxY - minY };
});
const paintedAspect = painted.w / painted.h;
ok(`the drawn circle stays round on the projector (aspect ${paintedAspect.toFixed(2)} vs drawn 1.00)`, Math.abs(paintedAspect - 1) < 0.25);
await ctx.close();
}

if (want('ink drawn the instant a deck pick allows it lands correctly, and never lands wrong')) {
console.log('\n-- ink drawn the instant a deck pick allows it lands correctly, and never lands wrong --');
// The actual bug report: circling a word on a slide landed nowhere near it
// on the projector. Root cause was three independent "real aspect not known
// yet" windows, none needing any resize or rotation to trigger:
//   1. Clicking a deck tile calls the (necessarily async) pick(), whose
//      first await returns control to the browser well before it gets to
//      stageDeck()'s own stage() call - so switching to Ink and drawing
//      right away used to race a pick that had not even sent its 'stage'
//      command yet, let alone gotten it echoed back. pick() now marks that
//      a deck pick is in flight the instant it starts, synchronously,
//      before any of that.
//   2. Once picked, the CONTROLLER's own pad used to size itself off the
//      display's raw window shape until a SECOND, redundant Marp parse -
//      kicked off reactively once state.program echoed back - finished,
//      which for a deck with a real theme's fonts could take over a
//      second. stageDeck() now reuses the parse it already did to stage
//      the deck, instead of leaving a second one to race.
//   3. Even with the controller's own pad correct, the DISPLAY draws ink
//      through contentRect(), which needs the deck's own mount() to finish
//      before it knows the slide's real aspect - before that it falls back
//      to the full, un-letterboxed stage. A stroke applied in that window
//      stayed wrong forever, because nothing re-drew ink once the deck
//      caught up. renderDeck() now tells the display to redo it via
//      onReady() the moment its real shape becomes known.
// The fix for (1) means the pad now simply refuses pointer input for
// whatever's left of that window (pad.is-pending, pointer-events:none)
// rather than guessing - so drawing "the instant a click can land" is the
// right thing to race here, not drawing at some fixed instant regardless.
// This uses the actual "Weighing the Evidence" deck (a real theme, not the
// tiny bundled demo) to make that window as real as it gets in a lecture.
const ctx = await browser.newContext({ viewport: { width: 1512, height: 944 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'ink-instant-room', passphrase: 'circle the evidence' }));
const screen = await ctx.newPage();
trap(screen, 'ink-instant display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'ink-instant control');
await pad.setViewportSize({ width: 834, height: 1194 });
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence"))');
await pad.click('.tab[data-tab="ink"]');
// Draw the moment the pad itself says it is safe to - not some fixed delay -
// and require that to be prompt: a presenter should never feel like the
// Ink tab is broken while a real deck loads.
await pad.waitForSelector('#pad:not(.is-pending)', { timeout: 3000 });
ok('the pad becomes drawable again promptly once the deck is actually ready', true);
const padBox = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const fx = 0.25, fy = 0.30;
const px = padBox.x + padBox.w * fx, py = padBox.y + padBox.h * fy;
await pad.mouse.move(px, py);
await pad.mouse.down();
for (let i = 1; i <= 4; i++) await pad.mouse.move(px + i * 3, py + i * 3);
await pad.mouse.up();

await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length > 0, null, { timeout: 20000 });
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 8000 });
await screen.waitForTimeout(300);

const info = await screen.evaluate(({ fx, fy }) => {
  const stage = document.querySelector('#stage');
  const svg = document.querySelector('.layer[data-role="program"] .r-deck').shadowRoot.querySelector('svg.podium-on');
  const viewBox = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
  const aspect = viewBox[2] / viewBox[3];
  const w = stage.clientWidth, h = stage.clientHeight;
  const stageAspect = w / h;
  let rect;
  if (stageAspect > aspect) { const cw = h * aspect; rect = { x: (w - cw) / 2, y: 0, w: cw, h }; }
  else { const ch = w / aspect; rect = { x: 0, y: (h - ch) / 2, w, h: ch }; }
  const cv = document.querySelector('#ink'); const c2d = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const data = c2d.getImageData(0, 0, cv.width, cv.height).data;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const i = (y * cv.width + x) * 4;
    if (data[i + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return { rect, painted: { x: (minX + maxX) / 2 / dpr, y: (minY + maxY) / 2 / dpr }, expected: { x: rect.x + fx * rect.w, y: rect.y + fy * rect.h } };
}, { fx, fy });
const dx = Math.abs(info.painted.x - info.expected.x), dy = Math.abs(info.painted.y - info.expected.y);
ok(`a stroke drawn the instant a real deck is picked still lands on the spot it was drawn (dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)})`, dx < 15 && dy < 15);
await ctx.close();
}

if (want('ink recovers even if a fullscreen transition never fires a resize event')) {
console.log('\n-- ink recovers even if a fullscreen transition never fires a resize event --');
// requestFullscreen()'s promise is documented to settle before the viewport
// has actually finished resizing in some browsers, and goLive() sizes the
// ink canvas right after that promise resolves. If the eventual layout
// change never generates its own 'resize' event (or generates it too late),
// the ink canvas is stuck at the pre-transition size until something else
// happens to redraw it. fullscreenchange is a second, independent trigger
// for the same recompute - this proves it works on its own, with 'resize'
// deliberately disabled so nothing else can be doing the job instead.
const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
await ctx.addInitScript(() => {
  const realAdd = window.addEventListener.bind(window);
  window.addEventListener = (type, ...rest) => { if (type === 'resize') return; return realAdd(type, ...rest); };
});
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'fs-race-room', passphrase: 'no resize for you' }));
const screen = await ctx.newPage();
trap(screen, 'fs-race display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');

// Arming just requested real Fullscreen (goLive() -> enterFullscreen()), and
// a CDP-level window resize is refused while a page is actually in that
// state - not every Chromium build enforces this (it did not in the one
// this test was first written against), but relying on that is exactly the
// kind of thing that quietly breaks on the next engine bump. Leaving
// fullscreen is not what this test is about; it only wants the viewport to
// change size, so it drops out first rather than depending on this.
await screen.evaluate(() => (document.fullscreenElement ? document.exitFullscreen() : Promise.resolve()));
await screen.setViewportSize({ width: 1600, height: 900 });
await screen.waitForTimeout(150);

// Force the canvas back out of step and immediately fire ONLY
// fullscreenchange, so this still measures what it is named for. (It used to
// assert the canvas sat stuck at the old size until something corrected it,
// which stopped being true once every redraw started re-checking that for
// itself - a better guarantee, but one that would quietly answer this
// question for the event being tested here.)
await screen.evaluate(() => {
  const cv = document.querySelector('#ink');
  cv.width = 640; cv.height = 480;
  document.dispatchEvent(new Event('fullscreenchange'));
});
await screen.waitForTimeout(150);
const after = await screen.evaluate(() => {
  const stage = document.querySelector('#stage');
  const ink = document.querySelector('#ink');
  return { stageW: stage.clientWidth, stageH: stage.clientHeight, inkW: ink.width, inkH: ink.height, ratio: window.devicePixelRatio || 1 };
});
ok('fullscreenchange alone catches the ink canvas up to the current stage size',
  Math.abs(after.inkW - Math.round(after.stageW * after.ratio)) < 4 && Math.abs(after.inkH - Math.round(after.stageH * after.ratio)) < 4);
await ctx.close();
}

if (want('ink stays put when the display is dragged to a screen of a different pixel density')) {
console.log('\n-- ink stays put when the display is dragged to a screen of a different pixel density --');
// A laptop screen and a projector rarely share a pixel density, and a window
// moved between them changes devicePixelRatio WITHOUT firing a resize: the
// window is the same size, so nothing tells the page anything happened. The
// ink canvas is sized in device pixels, so one still scaled for the old
// ratio paints every stroke at the wrong size - on a 2x laptop driving a 1x
// projector, at double the distance from the corner, nowhere near the slide
// it was drawn over. The page re-checks that before every redraw rather than
// trusting it was told, so this has to come out right even with every event
// that would normally have warned it suppressed.
const ctx = await browser.newContext({ viewport: { width: 1512, height: 944 } });
await ctx.addInitScript(() => {
  window.__dpr = 2;
  Object.defineProperty(window, 'devicePixelRatio', { get: () => window.__dpr, configurable: true });
});
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'dpr-room', passphrase: 'two screens' }));
const screen = await ctx.newPage();
trap(screen, 'dpr display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'dpr control');
await pad.setViewportSize({ width: 834, height: 1194 });
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length > 0, null, { timeout: 20000 });
await pad.click('.tab[data-tab="ink"]');
await pad.waitForSelector('#pad:not(.is-pending)', { timeout: 5000 });
await pad.waitForTimeout(400);
ok('the ink canvas starts out sized for the 2x screen', await screen.evaluate(() => document.querySelector('#ink').width === 3024));

// Now it is the projector's problem: same window size, half the density,
// and not a single event to say so.
await screen.evaluate(() => { window.__dpr = 1; });

const pb = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const fx = 0.25, fy = 0.30;
await pad.mouse.move(pb.x + pb.w * fx, pb.y + pb.h * fy);
await pad.mouse.down();
for (let i = 1; i <= 8; i++) await pad.mouse.move(pb.x + pb.w * fx + i * 4, pb.y + pb.h * fy + i * 2);
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 6000 });
await screen.waitForTimeout(400);

const landed = await screen.evaluate(({ fx, fy }) => {
  const svg = document.querySelector('.layer[data-role="program"] .r-deck').shadowRoot.querySelector('svg.podium-on');
  const fo = svg.querySelector('foreignObject').getBoundingClientRect();
  const cv = document.querySelector('#ink'); const c2d = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const data = c2d.getImageData(0, 0, cv.width, cv.height).data;
  let minX = Infinity, minY = Infinity;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const i = (y * cv.width + x) * 4;
    if (data[i + 3] > 0) { if (x < minX) minX = x; if (y < minY) minY = y; }
  }
  return { dx: Math.abs(minX / dpr - (fo.x + fo.width * fx)), dy: Math.abs(minY / dpr - (fo.y + fo.height * fy)), canvasW: cv.width };
}, { fx, fy });
ok(`the canvas re-sizes itself for the new density (${landed.canvasW}px backing store)`, landed.canvasW === 1512);
ok(`and the stroke still lands where it was drawn (dx=${landed.dx.toFixed(1)}, dy=${landed.dy.toFixed(1)}), not at double the distance`,
  landed.dx < 20 && landed.dy < 20);

// The same fault in a split layout is where it gets really loud: panel A is
// exactly half the stage in each direction, so painting it at 2x covers the
// whole screen - annotations correctly placed WITHIN panel A, but sprayed
// across all four of them.
await pad.click('#ink-clear');
await screen.waitForFunction(() => !document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
// Put the canvas back out of step with the screen the way the move left it,
// so the split layout is genuinely being asked to survive the mismatch and
// not quietly handed a canvas that happens to match again.
await screen.evaluate(() => {
  const cv = document.querySelector('#ink');
  cv.width = Math.round(document.querySelector('#stage').clientWidth * 2);
  cv.height = Math.round(document.querySelector('#stage').clientHeight * 2);
  cv.getContext('2d').setTransform(2, 0, 0, 2, 0, 0);
});
await pad.click('.layout-btn[data-layout="4"]');
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-4'), null, { timeout: 5000 });
await pad.waitForTimeout(500);
const pb2 = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await pad.mouse.move(pb2.x + pb2.w * 0.15, pb2.y + pb2.h * 0.15);
await pad.mouse.down();
for (let i = 1; i <= 10; i++) await pad.mouse.move(pb2.x + pb2.w * (0.15 + 0.7 * i / 10), pb2.y + pb2.h * (0.15 + 0.65 * i / 10));
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 6000 });
await screen.waitForTimeout(400);
const quad = await screen.evaluate(() => {
  const slotA = document.querySelector('[data-panel="a"]').getBoundingClientRect();
  const cv = document.querySelector('#ink'); const c2d = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const data = c2d.getImageData(0, 0, cv.width, cv.height).data;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const i = (y * cv.width + x) * 4;
    if (data[i + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (minX === Infinity) return { ok: false, why: 'nothing painted' };
  const box = { x: minX / dpr, y: minY / dpr, r: maxX / dpr, b: maxY / dpr };
  return {
    ok: box.x >= slotA.left - 2 && box.r <= slotA.right + 2 && box.y >= slotA.top - 2 && box.b <= slotA.bottom + 2,
    why: `ink ${box.x.toFixed(0)},${box.y.toFixed(0)}..${box.r.toFixed(0)},${box.b.toFixed(0)} vs panel A ${slotA.left.toFixed(0)},${slotA.top.toFixed(0)}..${slotA.right.toFixed(0)},${slotA.bottom.toFixed(0)}`,
  };
});
ok(`a density change in a split layout still keeps panel A's ink inside panel A (${quad.why})`, quad.ok);
await ctx.close();
}

if (want('splitting the screen: B/C/D are direct and immediate, unlike A')) {
console.log('\n-- splitting the screen: B/C/D are direct and immediate, unlike A --');
// "I could split to slides + a countdown for group work + instruction
// slide" - B/C/D have no freeze/cue/take of their own (see LAYOUTS and
// "layout" in protocol.js's initialState()): picking into one is immediate,
// even while frozen, since there is nothing to protect - it was never going
// to be revealed at a moment the class was watching. Panel A keeps its full
// freeze/cue pipeline exactly as it had it, just confined to its own region
// once a layout splits the screen. Deck nav, transport, and Ink all follow
// `focus`, not always panel A.
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'panels-room', passphrase: 'split screen' }));
const screen = await ctx.newPage();
trap(screen, 'panels display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'panels control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Podium deck features (example)"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length === 4, null, { timeout: 20000 });

await pad.click('.layout-btn[data-layout="3"]');
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-3'), null, { timeout: 5000 });
const slotDisplay = await screen.evaluate(() => ({
  a: getComputedStyle(document.querySelector('[data-panel="a"]')).display,
  b: getComputedStyle(document.querySelector('[data-panel="b"]')).display,
  c: getComputedStyle(document.querySelector('[data-panel="c"]')).display,
  d: getComputedStyle(document.querySelector('[data-panel="d"]')).display,
}));
ok('the 3-panel layout shows A/B/C and leaves D hidden', slotDisplay.a === 'block' && slotDisplay.b === 'block' && slotDisplay.c === 'block' && slotDisplay.d === 'none');
await pad.waitForFunction(() => document.querySelectorAll('.panel-btn').length === 3, null, { timeout: 3000 });
ok('the panel picker offers exactly 3 panels for a 3-panel layout', true);

await pad.click('.panel-btn:nth-child(2)');
await pad.waitForFunction(() => document.querySelector('.panel-btn.is-on')?.textContent === 'B', null, { timeout: 3000 });
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Timer"))');
await screen.waitForFunction(() => document.querySelector('[data-panel="b"] .r-timer'), null, { timeout: 5000 });
ok('picking content while focused on B lands directly on B, not A', true);
ok('and panel A is untouched by it', await screen.evaluate(() => !!document.querySelector('[data-panel="a"] .r-deck')));

await pad.click('#freeze');
await pad.click('.panel-btn:text-is("C")');
await pad.waitForFunction(() => document.querySelector('.panel-btn.is-on')?.textContent === 'C', null, { timeout: 3000 });
await pad.click('.tab[data-tab="say"]');
await pad.click('#text-open-editor');
await pad.fill('#msg-body', 'Discuss in your groups');
await pad.$eval('#message-editor-form', (f) => f.requestSubmit());
await screen.waitForFunction(() => document.querySelector('[data-panel="c"] .r-text'), null, { timeout: 5000 });
ok('freeze does not gate a focused B/C/D panel either - nothing to protect, it was never cued', true);
await pad.click('#freeze');

await pad.click('.panel-btn:nth-child(1)');
await pad.waitForFunction(() => document.querySelector('.panel-btn.is-on')?.textContent === 'A', null, { timeout: 3000 });
await pad.click('.tab[data-tab="slides"]');
await pad.click('#deck-next');
await screen.waitForFunction(() => {
  const svgs = Array.from(document.querySelector('[data-panel="a"] .r-deck').shadowRoot.querySelectorAll('svg[data-marpit-svg]'));
  return svgs.findIndex((s) => s.classList.contains('podium-on')) === 1;
}, null, { timeout: 5000 });
ok("Next while focused on A still advances A's own deck, not B or C", true);
ok('B is untouched by that Next', await screen.evaluate(() => !!document.querySelector('[data-panel="b"] .r-timer')));

await pad.click('.tab[data-tab="ink"]');
await pad.waitForTimeout(300);
const padBox = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
// A long diagonal rather than a dab: big enough that a rendering at a split
// layout's smaller scale would be unmistakable in the before/after below.
const strokeFrom = { x: padBox.x + padBox.w * 0.25, y: padBox.y + padBox.h * 0.25 };
const strokeTo = { x: padBox.x + padBox.w * 0.70, y: padBox.y + padBox.h * 0.65 };
await pad.mouse.move(strokeFrom.x, strokeFrom.y);
await pad.mouse.down();
for (let i = 1; i <= 10; i++) {
  await pad.mouse.move(strokeFrom.x + (strokeTo.x - strokeFrom.x) * i / 10, strokeFrom.y + (strokeTo.y - strokeFrom.y) * i / 10);
}
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
// EVERY painted pixel has to be inside panel A, not merely the first one
// found: ink sprayed across all four panels still starts inside A if A is
// the top-left one, so checking where the stroke begins says nothing about
// whether it stayed there.
const inkInsideA = await screen.evaluate(() => {
  const slotA = document.querySelector('[data-panel="a"]').getBoundingClientRect();
  const cv = document.querySelector('#ink'); const ctx2d = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const data = ctx2d.getImageData(0, 0, cv.width, cv.height).data;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const i = (y * cv.width + x) * 4;
    if (data[i + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (minX === Infinity) return { ok: false, why: 'nothing painted' };
  const box = { x: minX / dpr, y: minY / dpr, r: maxX / dpr, b: maxY / dpr };
  return {
    ok: box.x >= slotA.left - 2 && box.r <= slotA.right + 2 && box.y >= slotA.top - 2 && box.b <= slotA.bottom + 2,
    why: `ink ${box.x.toFixed(0)},${box.y.toFixed(0)}..${box.r.toFixed(0)},${box.b.toFixed(0)} vs panel A ${slotA.left.toFixed(0)},${slotA.top.toFixed(0)}..${slotA.right.toFixed(0)},${slotA.bottom.toFixed(0)}`,
  };
});
ok(`every bit of the stroke stays inside panel A, not spread over the whole stage (${inkInsideA.why})`, inkInsideA.ok);

await pad.click('.layout-btn[data-layout="single"]');
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-single'), null, { timeout: 5000 });
const backToSingle = await screen.evaluate(() => {
  const a = document.querySelector('[data-panel="a"]').getBoundingClientRect();
  const s = document.querySelector('#stage').getBoundingClientRect();
  return { bHidden: getComputedStyle(document.querySelector('[data-panel="b"]')).display === 'none', aFillsStage: Math.abs(a.width - s.width) < 2 && Math.abs(a.height - s.height) < 2 };
});
ok('dropping back to single hides B/C/D again and A fills the whole stage', backToSingle.bHidden && backToSingle.aFillsStage);

// A split layout paints panel A's ink into a fraction of the screen. Coming
// back to full screen, the incremental "just append the new points" path
// must NOT decide nothing has changed and keep that smaller rendering: the
// stroke has to be re-scaled to the slide it is actually sitting on now.
// Checked against where its own fractions say it belongs, since the two
// layouts legitimately paint it at different sizes.
await screen.waitForTimeout(500);
const rescaled = await screen.evaluate(() => {
  const svg = document.querySelector('.layer[data-role="program"] .r-deck').shadowRoot.querySelector('svg.podium-on');
  const fo = svg.querySelector('foreignObject').getBoundingClientRect();
  const cv = document.querySelector('#ink'); const c2d = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const data = c2d.getImageData(0, 0, cv.width, cv.height).data;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const i = (y * cv.width + x) * 4;
    if (data[i + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  // The stroke ran 0.25 -> 0.70 across and 0.25 -> 0.65 down the slide.
  return {
    w: (maxX - minX) / dpr, expectedW: fo.width * 0.45,
    h: (maxY - minY) / dpr, expectedH: fo.height * 0.40,
  };
});
ok(`ink is re-scaled to the full-screen slide, not left at the split layout's smaller scale (${rescaled.w.toFixed(0)}x${rescaled.h.toFixed(0)}, expected about ${rescaled.expectedW.toFixed(0)}x${rescaled.expectedH.toFixed(0)})`,
  Math.abs(rescaled.w - rescaled.expectedW) < 20 && Math.abs(rescaled.h - rescaled.expectedH) < 20);

// And the harder version of the same trap: ink already on screen in the
// single layout, out to a split and straight back. The content box ends up
// byte-identical to the one the incremental path last recorded, so nothing
// about the key says anything changed - but the canvas in between was
// repainted at a quarter size, and appending to THAT would keep it.
const inkBox = () => screen.evaluate(() => {
  const cv = document.querySelector('#ink'); const c2d = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const data = c2d.getImageData(0, 0, cv.width, cv.height).data;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const i = (y * cv.width + x) * 4;
    if (data[i + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return { x: minX / dpr, y: minY / dpr, w: (maxX - minX) / dpr, h: (maxY - minY) / dpr };
});
const beforeRoundTrip = await inkBox();
await pad.click('.layout-btn[data-layout="4"]');
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-4'), null, { timeout: 5000 });
await screen.waitForTimeout(300);
await pad.click('.layout-btn[data-layout="single"]');
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-single'), null, { timeout: 5000 });
await screen.waitForTimeout(500);
const afterRoundTrip = await inkBox();
ok(`a split and straight back leaves the ink exactly where it was (${beforeRoundTrip.w.toFixed(0)}x${beforeRoundTrip.h.toFixed(0)} -> ${afterRoundTrip.w.toFixed(0)}x${afterRoundTrip.h.toFixed(0)})`,
  Math.abs(afterRoundTrip.x - beforeRoundTrip.x) < 3 && Math.abs(afterRoundTrip.y - beforeRoundTrip.y) < 3
  && Math.abs(afterRoundTrip.w - beforeRoundTrip.w) < 3 && Math.abs(afterRoundTrip.h - beforeRoundTrip.h) < 3);
await ctx.close();
}

if (want('the ink layer covers the screen exactly, on a 2x display')) {
console.log('\n-- the ink layer covers the screen exactly, on a 2x display --');
// A <canvas> is a REPLACED element, so an absolutely positioned one with
// width:auto takes its intrinsic width - its width attribute, read as CSS
// pixels - rather than stretching to left:0/right:0. That attribute is the
// backing store, sized in DEVICE pixels, so on a 2x screen the element gets
// laid out at twice the viewport, anchored top-left, and the window shows
// the top-left quarter of it. Ink at double size, drifting further off the
// further from the corner you draw.
//
// Every earlier ink check missed this for one reason: they read pixels out
// of the backing store, which is completely unaffected by the canvas being
// DISPLAYED at the wrong size. So this one measures through the canvas's
// real on-screen box - where the eye actually sees the mark - and asserts
// the invariant that was silently untrue: the ink layer covers the stage,
// no more and no less.
const ctx = await browser.newContext({ viewport: { width: 1512, height: 944 }, deviceScaleFactor: 2 });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'retina-room', passphrase: 'two times' }));
const screen = await ctx.newPage();
trap(screen, 'retina display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'retina control');
await pad.setViewportSize({ width: 1024, height: 1366 });
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

const cover = await screen.evaluate(() => {
  const c = document.querySelector('#ink').getBoundingClientRect();
  const s = document.querySelector('#stage').getBoundingClientRect();
  return { canvas: { w: Math.round(c.width), h: Math.round(c.height) }, stage: { w: Math.round(s.width), h: Math.round(s.height) }, dpr: window.devicePixelRatio };
});
ok(`the ink layer is laid out over exactly the stage, not its device-pixel size (canvas ${cover.canvas.w}x${cover.canvas.h}, stage ${cover.stage.w}x${cover.stage.h}, dpr ${cover.dpr})`,
  cover.canvas.w === cover.stage.w && cover.canvas.h === cover.stage.h);

await pad.click('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length > 0, null, { timeout: 20000 });
await pad.click('.tab[data-tab="ink"]');
await pad.waitForSelector('#pad:not(.is-pending)', { timeout: 5000 });
await pad.waitForTimeout(500);

// A loop around the title, the way you would actually circle something.
const pb = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const corners = [[0.12, 0.30], [0.88, 0.30], [0.88, 0.72], [0.12, 0.72], [0.12, 0.30]];
await pad.mouse.move(pb.x + pb.w * corners[0][0], pb.y + pb.h * corners[0][1]);
await pad.mouse.down();
for (let i = 1; i < corners.length; i++) {
  for (let s = 1; s <= 6; s++) {
    const a = corners[i - 1], z = corners[i];
    await pad.mouse.move(pb.x + pb.w * (a[0] + (z[0] - a[0]) * s / 6), pb.y + pb.h * (a[1] + (z[1] - a[1]) * s / 6));
  }
}
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 6000 });
await screen.waitForTimeout(400);

const landed = await screen.evaluate(() => {
  const svg = document.querySelector('.layer[data-role="program"] .r-deck').shadowRoot.querySelector('svg.podium-on');
  const art = svg.querySelector('foreignObject').getBoundingClientRect();
  const cv = document.querySelector('#ink'); const c2d = cv.getContext('2d');
  const data = c2d.getImageData(0, 0, cv.width, cv.height).data;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
    const i = (y * cv.width + x) * 4;
    if (data[i + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (minX === Infinity) return null;
  // Through the canvas's on-screen box, NOT its backing store - the whole
  // point of this check.
  const box = cv.getBoundingClientRect();
  const sx = (px) => box.x + (px / cv.width) * box.width;
  const sy = (py) => box.y + (py / cv.height) * box.height;
  return {
    w: sx(maxX) - sx(minX), expectedW: art.width * 0.76,
    h: sy(maxY) - sy(minY), expectedH: art.height * 0.42,
  };
});
ok(`and a loop drawn round the title comes out the size of the title, not double it (${landed.w.toFixed(0)}x${landed.h.toFixed(0)} vs ${landed.expectedW.toFixed(0)}x${landed.expectedH.toFixed(0)})`,
  Math.abs(landed.w - landed.expectedW) < 30 && Math.abs(landed.h - landed.expectedH) < 30);
await ctx.close();
}

if (want('a well-annotated board does not take the projector off the air')) {
console.log('\n-- a well-annotated board does not take the projector off the air --');
// The heartbeat used to carry every stroke on the current surface, in full,
// every two seconds - and every 400ms while anything was playing. Two separate
// ceilings sat above that: seal() overflowed the call stack somewhere past
// 100 KB (String.fromCharCode spreads every byte as an argument), and the relay
// closes a socket that sends more than 256 KB. A term's annotation on one
// whiteboard hit both.
const ROOM = 'heavy-ink';
const roomCfg = JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: ROOM, passphrase: 'ink' });

// 300 strokes of 60 points, seeded where a real term's ink ends up: the
// display's own saved surfaces. ~287 KB of JSON.
const seeded = (() => {
  const strokes = [];
  for (let n = 0; n < 300; n++) {
    const y = 0.04 + 0.92 * ((n % 30) / 30);
    const pts = [];
    for (let i = 0; i < 60; i++) {
      pts.push([Math.round((0.04 + 0.92 * i / 60) * 1e4) / 1e4, Math.round((y + 0.01 * Math.sin(i / 5)) * 1e4) / 1e4]);
    }
    strokes.push({ id: `s${n}`, color: '#ffd166', width: 6, pts });
  }
  return { 'whiteboard:#f7f5ef': { strokes, touched: Date.now() } };
})();
const seededKb = Math.round(JSON.stringify(seeded).length / 1024);

const room = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await room.addInitScript(([cfg, key, ink]) => {
  localStorage.setItem('podium.config.v2', cfg);
  localStorage.setItem(key, ink);
}, [roomCfg, `podium.ink.${ROOM}`, JSON.stringify(seeded)]);
const screen = await room.newPage();
trap(screen, 'heavy display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');

const tablet = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await tablet.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), roomCfg);
const pad = await tablet.newPage();
trap(pad, 'heavy control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.click('.tile:has(.tile-title:text-is("Whiteboard"))');

// Several heartbeats' worth. Under the old code the display threw inside
// seal() on each one and the controller never received a usable state.
await pad.waitForTimeout(5000);
ok(`the display survives heartbeats on a ${seededKb} KB surface instead of being closed off the relay`,
  (await screen.$eval('#hud', (n) => n.dataset.status)) === 'online');
ok('and the controller’s relay stays up too',
  (await pad.$eval('#status', (n) => n.dataset.status)) === 'online');

// The strokes are no longer in the heartbeat, so the pad can only have them by
// asking for the surface and stitching the slices back together.
await pad.click('.tab[data-tab="ink"]');
await pad.waitForFunction(() => {
  const cv = document.querySelector('#pad');
  if (!cv) return false;
  const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 10) return true;
  return false;
}, null, { timeout: 20000 }).catch(() => {});
const painted = await pad.evaluate(() => {
  const cv = document.querySelector('#pad');
  const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 10) n++;
  return n;
});
ok(`a controller pulls that surface in slices and draws all of it (${painted} px)`, painted > 20000);
ok('and the display still holds every stroke', (await screen.evaluate((key) => {
  const all = JSON.parse(localStorage.getItem(key) || '{}');
  return all[Object.keys(all)[0]]?.strokes.length;
}, `podium.ink.${ROOM}`)) === 300);

// The other ceiling, tested where it lives. 120 KB is an uploaded deck, 160 KB
// a lecture plan's photo - both were already at or past the limit.
const sealed = await pad.evaluate(async () => {
  const crypto = await import('./assets/js/crypto.js');
  const key = await crypto.deriveKey('passphrase', 'room');
  const out = {};
  for (const kb of [64, 160, 512]) {
    const message = { t: 'big', blob: 'y'.repeat(kb * 1024) };
    try {
      const opened = await crypto.open(key, await crypto.seal(key, message));
      out[kb] = opened?.blob?.length === message.blob.length ? 'ok' : 'corrupted';
    } catch (err) {
      out[kb] = err.message;
    }
  }
  return out;
});
ok(`encryption round-trips a payload of any size (${Object.entries(sealed).map(([k, v]) => `${k}KB ${v}`).join(', ')})`,
  sealed[64] === 'ok' && sealed[160] === 'ok' && sealed[512] === 'ok');

// A second controller used to learn about the first one's strokes only when
// the next heartbeat carried them - up to two seconds later. It now follows
// the ink commands off the bus, and asks for a surface only when its own
// summary says it has fallen behind.
{
  const second = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await second.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), roomCfg);
  const phone = await second.newPage();
  trap(phone, 'heavy second control');
  await phone.goto(`${BASE}/control.html`);
  await phone.waitForSelector('.tile');
  // A surface neither device has drawn on, so "it appeared" can only mean it
  // travelled: the chalkboard is a different whiteboard background, and so a
  // different ink surface, from the seeded one.
  await pad.click('.tab[data-tab="library"]');
  await pad.click('.tile:has(.tile-title:text-is("Chalkboard"))');
  await pad.waitForTimeout(700);
  await pad.click('.tab[data-tab="ink"]');
  await phone.click('.tab[data-tab="ink"]');
  await pad.waitForTimeout(400);

  const inked = (page) => page.evaluate(() => {
    const cv = document.querySelector('#pad');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 10) n++;
    return n;
  });
  ok('a fresh surface starts blank on both controllers', (await inked(pad)) === 0 && (await inked(phone)) === 0);

  const box = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await pad.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.3);
  await pad.mouse.down();
  await pad.mouse.move(box.x + box.w * 0.8, box.y + box.h * 0.7, { steps: 12 });
  await pad.mouse.up();
  await phone.waitForFunction(() => {
    const cv = document.querySelector('#pad');
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 10) return true;
    return false;
  }, null, { timeout: 500 }).catch(() => {});
  ok(`the other controller has it within half a second, not at the next heartbeat (${await inked(phone)} px)`,
    (await inked(phone)) > 100);

  await second.close();
}

await tablet.close();
await room.close();
}

if (want('full screen this panel, and layout respects freeze')) {
console.log('\n-- full screen this panel, and layout respects freeze --');
const ctx = await browser.newContext();
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'layout-room', passphrase: 'panel C full screen' }));
const screen = await ctx.newPage();
trap(screen, 'layout display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'layout pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

// "Full screen this": panel C's content becomes panel A, in single layout,
// in one tap - the actual complaint being "I switch back to one panel and
// get A, not the C I was just looking at".
await pad.click('.layout-btn[data-layout="4"]');
await pad.click('.panel-btn:nth-child(3)');
await pad.waitForFunction(() => document.querySelector('.panel-btn.is-on')?.textContent === 'C', null, { timeout: 5000 });
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Chalkboard"))');
await screen.waitForFunction(() => document.querySelectorAll('.panel-slot.is-on').length === 4, null, { timeout: 8000 });
ok('the "Full screen this" button appears once a non-A panel is focused', await pad.isVisible('#panel-promote'));

// Draw on panel C before promoting it - the actual class complaint was that
// promoting a panel with ink on it goes black, not just that the ink is lost.
await pad.click('.tab[data-tab="ink"]');
await pad.waitForSelector('#pad');
const cBox = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await pad.mouse.move(cBox.x + cBox.w * 0.2, cBox.y + cBox.h * 0.3);
await pad.mouse.down();
for (let i = 1; i <= 12; i++) await pad.mouse.move(cBox.x + cBox.w * (0.2 + i * 0.045), cBox.y + cBox.h * (0.3 + i * 0.03));
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
const paintedBefore = await screen.evaluate(() => {
  const c = document.querySelector('#ink');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
ok(`ink on panel C reaches the display before promoting (${paintedBefore})`, paintedBefore > 200);

await pad.click('#panel-promote');
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-single'), null, { timeout: 8000 });
ok('promoting switches to single layout', true);
ok('with panel A now showing what was in C, not black', await screen.evaluate(() => !!document.querySelector('.r-whiteboard')));
const paintedAfter = await screen.evaluate(() => {
  const c = document.querySelector('#ink');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
ok(`the ink drawn on C is still there once it is full screen (${paintedAfter})`, paintedAfter > 200);

// A layout change while frozen queues behind TAKE, the same as content -
// see the 'layout'/'take'/'clear' cases in protocol.js.
await pad.click('#freeze');
await pad.click('.layout-btn[data-layout="2h"]');
await pad.waitForTimeout(500);
ok('a layout change while frozen does not apply immediately', await screen.evaluate(() => document.querySelector('#stage').classList.contains('layout-single')));
ok('the cued layout button shows cued rather than live',
  await pad.evaluate(() => document.querySelector('.layout-btn[data-layout="2h"]').classList.contains('is-cued')
    && !document.querySelector('.layout-btn[data-layout="2h"]').classList.contains('is-on')));
ok('and the preview pane says a layout is cued', /Layout cued/.test(await pad.textContent('#preview-label')));
ok('TAKE is armed by a cued layout alone, with no content change pending', !(await pad.evaluate(() => document.querySelector('#take').disabled)));

await pad.click('#take');
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-2h'), null, { timeout: 8000 });
ok('TAKE applies the cued layout', true);
await pad.waitForFunction(() => !document.querySelector('#freeze').classList.contains('is-on'), null, { timeout: 5000 })
  .then(() => ok('and releases freeze the same as any other take', true))
  .catch(() => ok('and releases freeze the same as any other take', false));

// Clear cue abandons a cued layout, not just cued content.
await pad.click('#freeze');
await pad.click('.layout-btn[data-layout="4"]');
await pad.waitForFunction(() => document.querySelector('.layout-btn[data-layout="4"]').classList.contains('is-cued'), null, { timeout: 5000 });
await pad.click('#clear-preview');
await pad.waitForTimeout(300);
ok('Clear cue abandons a cued layout too',
  !(await pad.evaluate(() => document.querySelector('.layout-btn[data-layout="4"]').classList.contains('is-cued'))));
await pad.click('#freeze');
await screen.waitForTimeout(300);
ok('and the display never saw it', await screen.evaluate(() => document.querySelector('#stage').classList.contains('layout-2h')));

// Regression guard: plain content cueing while frozen is unaffected by the
// layout-cueing rewrite of take()/clear().
await pad.click('#freeze');
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await pad.waitForTimeout(400);
ok('plain content cueing while frozen still works', /^Cued$/.test(await pad.textContent('#preview-label')));
await pad.click('#take');
await screen.waitForSelector('.r-whiteboard', { timeout: 8000 });
ok('and TAKE still applies content with no layout change involved', true);

await ctx.close();
}

if (want('drawing on an untouched panel and promoting it does not go black')) {
console.log('\n-- drawing on an untouched panel and promoting it does not go black --');
// The exact class report: a deck on A, split to side-by-side, focus B
// WITHOUT ever picking anything into it (so it is still the untouched
// default "Black" every panel starts as), draw on the Ink tab, then
// "Full screen this". inkSurfaceKey used to fall back to the item's own
// `key` for a type with no src/deckId of its own - and the untouched
// default panels are plain {...BLACK} literals with no key at all, so
// drawing there computed surface "black:". Promoting re-stages that same
// conceptual item through normalizeItem(), which hands it a brand new
// random key - so the promoted program's surface became "black:<newkey>",
// a different, empty one: the promoted panel then had nothing of its own
// to render (black has no content) and an ink layer with nothing to
// paint either, indistinguishable from the screen having simply gone black.
const ctx = await browser.newContext();
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'black-panel-room', passphrase: 'draw on B first' }));
const screen = await ctx.newPage();
trap(screen, 'black-panel display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'black-panel pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence"))');
await screen.waitForFunction(() => (document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length || 0) > 0, null, { timeout: 20000 });
await pad.click('.layout-btn[data-layout="2h"]');
await pad.click('.panel-btn:nth-child(2)');
await pad.waitForFunction(() => document.querySelector('.panel-btn.is-on')?.textContent === 'B', null, { timeout: 5000 });
ok('panel B is focused, and nothing has ever been staged into it', await pad.evaluate(() => document.querySelector('#panel-promote') !== null));

await pad.click('.tab[data-tab="ink"]');
await pad.waitForSelector('#pad');
const bBox = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await pad.mouse.move(bBox.x + bBox.w * 0.25, bBox.y + bBox.h * 0.25);
await pad.mouse.down();
for (let i = 1; i <= 10; i++) await pad.mouse.move(bBox.x + bBox.w * (0.25 + i * 0.05), bBox.y + bBox.h * (0.25 + i * 0.05));
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
ok('ink on the untouched panel B reaches the display', true);

await pad.click('#panel-promote');
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-single'), null, { timeout: 8000 });
const paintedAfter = await screen.evaluate(() => {
  const c = document.querySelector('#ink');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
ok(`the ink drawn on the untouched panel survives promoting it (${paintedAfter} px), the screen is not just black`, paintedAfter > 100);
await ctx.close();
}

if (want('watermark: a name or logo in the corner')) {
console.log('\n-- watermark: a name or logo in the corner --');
const ctx = await browser.newContext();
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'watermark-room', passphrase: 'lower right or upper left' }));
const screen = await ctx.newPage();
trap(screen, 'watermark display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'watermark pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));
await pad.click('.tab[data-tab="say"]');

await pad.fill('#watermark-text', 'Dr. Jane Smith');
await pad.click('#watermark-form button[type=submit]');
await screen.waitForFunction(() => document.querySelector('#watermark').classList.contains('is-on'), null, { timeout: 8000 });
ok('the watermark shows on the display', true);
ok('with the text that was typed', (await screen.textContent('#watermark-text')) === 'Dr. Jane Smith');
ok('bottom right by default', !await screen.evaluate(() => document.querySelector('#watermark').classList.contains('pos-tl')));
ok('nothing rendered for it on the controller - display-only chrome', await pad.evaluate(() => !document.querySelector('#watermark')));

// Not content: survives picking something else, freezing, and blanking.
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await screen.waitForSelector('.r-whiteboard', { timeout: 8000 });
ok('survives picking new content', await screen.evaluate(() => document.querySelector('#watermark').classList.contains('is-on')));
await pad.click('#freeze');
await pad.click('#blank');
await pad.waitForTimeout(300);
ok('and survives blank too, deliberately - it is identity, not content',
  await screen.evaluate(() => document.querySelector('#watermark').classList.contains('is-on')));
await pad.click('#blank');
await pad.click('#freeze');

await pad.click('.tab[data-tab="say"]');
await pad.selectOption('#watermark-position', 'tl');
await screen.waitForFunction(() => document.querySelector('#watermark').classList.contains('pos-tl'), null, { timeout: 5000 });
ok('the position switches to top left', true);
await pad.click('#watermark-hide');
await screen.waitForFunction(() => !document.querySelector('#watermark').classList.contains('is-on'), null, { timeout: 5000 });
ok('Hide turns it off', true);
ok('without forgetting the text, so Show needs no retyping', /Dr\. Jane Smith/.test(await pad.textContent('#watermark-note')));

// A logo's whole reason to be a PNG rather than the photo ladder's JPEG: a
// transparent background must not come back as a black box in the corner.
const logoFile = writeAlphaImageFixture();
await pad.setInputFiles('#watermark-image', logoFile);
await screen.waitForFunction(() => {
  const img = document.querySelector('#watermark-img');
  return !img.hidden && img.complete && img.naturalWidth > 1;
}, null, { timeout: 10000 });
ok('uploading a logo turns the watermark back on, image over text',
  await screen.evaluate(() => document.querySelector('#watermark').classList.contains('is-on') && document.querySelector('#watermark-text').hidden));
await pad.waitForFunction(() => !document.querySelector('#watermark-image-clear').hidden, null, { timeout: 5000 });
ok('and the controller offers a Remove image button once one is set', true);

const pixel = await screen.evaluate(() => new Promise((resolve) => {
  const img = document.querySelector('#watermark-img');
  const draw = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    resolve({
      mid: Array.from(g.getImageData(Math.round(c.width * 0.2), Math.round(c.height * 0.5), 1, 1).data),
      corner: Array.from(g.getImageData(Math.round(c.width * 0.9), Math.round(c.height * 0.5), 1, 1).data),
    });
  };
  if (img.complete && img.naturalWidth) draw(); else img.onload = draw;
}));
ok('the transparent part stays transparent, not flattened to black', pixel.mid[3] === 0);
ok('and the opaque part survives re-encoding as PNG', pixel.corner[2] > 180 && pixel.corner[3] === 255);

// It really does end up IN a whole-screen grab, which was the entire point.
await pad.click('.tab[data-tab="photos"]');
await pad.click('#photo-screen');
await pad.waitForFunction(() => document.querySelectorAll('#photo-strip .shot').length === 1, null, { timeout: 15000 });
const shotSrc = await pad.evaluate(() => document.querySelector('#photo-strip .shot img').src);
const shotPixel = await screen.evaluate((url) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    // Scan a grid across the top-left quadrant and report the bluest pixel
    // found, rather than betting everything on one guessed coordinate.
    let best = null;
    for (let fx = 0.01; fx < 0.3; fx += 0.01) {
      for (let fy = 0.01; fy < 0.3; fy += 0.01) {
        const p = g.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data;
        const blueness = p[2] - p[0] - p[1];
        if (!best || blueness > best.blueness) best = { fx, fy, p: Array.from(p), blueness };
      }
    }
    resolve({ w: c.width, h: c.height, best });
  };
  img.src = url;
}), shotSrc);
ok(`the logo shows up in a whole-screen grab, top left as set (${JSON.stringify(shotPixel.best?.p)} at ${shotPixel.best?.fx.toFixed(2)},${shotPixel.best?.fy.toFixed(2)})`,
  shotPixel.best && shotPixel.best.p[2] > shotPixel.best.p[0] + 40 && shotPixel.best.p[2] > shotPixel.best.p[1] + 40);

// Remove image reverts to the text, which the queue never lost.
await pad.click('.tab[data-tab="say"]');
await pad.click('#watermark-image-clear');
await screen.waitForFunction(() => document.querySelector('#watermark-text').hidden === false, null, { timeout: 5000 });
ok('Remove image reverts the display back to the remembered text',
  (await screen.textContent('#watermark-text')) === 'Dr. Jane Smith');

// A second controller sees the same shared state without being told.
const pad2 = await ctx.newPage();
trap(pad2, 'watermark pad2');
await pad2.goto(`${BASE}/control.html`);
await pad2.waitForSelector('.tile');
await pad2.click('.tab[data-tab="say"]');
await pad2.waitForFunction(() => /Dr\. Jane Smith/.test(document.querySelector('#watermark-note').textContent), null, { timeout: 8000 })
  .then(() => ok('a second controller sees the same watermark state', true))
  .catch(() => ok('a second controller sees the same watermark state', false));

// A logo's bytes live only on whichever devices have fetched them - unlike
// every other asset in the app, on purpose (see the comment in
// saveStateNow): this one is meant to outlive the lecture, so once the
// display has it, a reload with no controller left to ask must not lose it.
await pad2.setInputFiles('#watermark-image', logoFile);
await screen.waitForFunction(() => {
  const img = document.querySelector('#watermark-img');
  return !img.hidden && img.complete && img.naturalWidth > 1;
}, null, { timeout: 10000 });
await pad.close();
await pad2.close();
await screen.waitForTimeout(1200);   // let saveStateSoon's debounce flush
await screen.reload();
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
await screen.waitForFunction(() => {
  const img = document.querySelector('#watermark-img');
  return document.querySelector('#watermark').classList.contains('is-on') && !img.hidden && img.complete && img.naturalWidth > 1;
}, null, { timeout: 8000 })
  .then(() => ok('the logo survives a display reload with no controller left to ask for it', true))
  .catch(() => ok('the logo survives a display reload with no controller left to ask for it', false));
await ctx.close();
}

if (want('picture-in-picture: one pane full screen, another inset')) {
console.log('\n-- picture-in-picture: one pane full screen, another inset --');
const pipCtx = await browser.newContext();
await pipCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'pip-room', passphrase: 'any two of four' }));
const pipScreen = await pipCtx.newPage();
trap(pipScreen, 'pip display');
await pipScreen.goto(`${BASE}/display.html`);
await pipScreen.click('#arm-button');
await pipScreen.waitForSelector('#hud[data-status="online"]');
const pipPad = await pipCtx.newPage();
trap(pipPad, 'pip pad');
await pipPad.goto(`${BASE}/control.html`);
await pipPad.waitForSelector('.tile');
await pipPad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

// Stage three visually distinct things into A, B and C first - PiP is
// choosing among panes already independently staged, the same as switching
// into "4" and picking through A/B/C/D already works, not a new staging
// path of its own.
await pipPad.click('.layout-btn[data-layout="4"]');
// The panel picker's B/C/D buttons only exist once this pad's own state
// has caught up with the layout change it just sent - a separate round
// trip from the display applying it, the same distinction the pip-main/
// pip-inset waits below are about.
await pipPad.waitForSelector('.panel-btn:text-is("B")');
await pipPad.click('.tile:has(.tile-title:text-is("Whiteboard"))'); // A: light bg
// A tile or message goes to whichever panel this pad's state says is focused,
// so each focus change has to come back from the relay before staging into it.
await pipPad.click('.panel-btn:text-is("B")');
await pipPad.waitForFunction(() => document.querySelector('.panel-btn.is-on')?.textContent === 'B', null, { timeout: 3000 });
await pipPad.click('.tile:has(.tile-title:text-is("Chalkboard"))'); // B: dark bg
await pipScreen.waitForFunction(() => document.querySelectorAll('.r-whiteboard').length === 2, null, { timeout: 8000 });
await pipPad.click('.panel-btn:text-is("C")');
await pipPad.waitForFunction(() => document.querySelector('.panel-btn.is-on')?.textContent === 'C', null, { timeout: 3000 });
await pipPad.click('.tab[data-tab="say"]');
await pipPad.click('#text-open-editor');
await pipPad.fill('#msg-body', 'Pane C');
await pipPad.click('#message-editor-show');
await pipScreen.waitForFunction(() => /Pane C/.test(document.querySelector('[data-panel="c"] .r-text-body')?.textContent || ''), null, { timeout: 8000 });
ok('A, B and C each hold their own distinct content before PiP ever gets involved', true);

await pipPad.click('.layout-btn[data-layout="pip"]');
await pipScreen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-pip'), null, { timeout: 5000 });
await pipPad.click('.tab[data-tab="say"]');
await pipPad.waitForSelector('#pip-settings:not([hidden])', { timeout: 5000 });
ok('the settings panel appears once PiP is the active layout', true);
ok('defaulting to pane A full screen, pane B inset',
  (await pipPad.inputValue('#pip-main')) === 'A' && (await pipPad.inputValue('#pip-inset')) === 'B');
ok('the inset picker never offers the pane already chosen as main',
  !(await pipPad.$$eval('#pip-inset option', (opts) => opts.map((o) => o.value))).includes('A'));

const pipBox = (panel) => pipScreen.$eval(`[data-panel="${panel}"]`, (n) => {
  const r = n.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, visible: getComputedStyle(n).display !== 'none' };
});
const stageBox = () => pipScreen.$eval('#stage', (n) => { const r = n.getBoundingClientRect(); return { w: r.width, h: r.height }; });

let [a, b, c, stage] = await Promise.all([pipBox('a'), pipBox('b'), pipBox('c'), stageBox()]);
ok(`pane A fills the whole stage as the default main (${a.w}x${a.h} vs stage ${stage.w}x${stage.h})`,
  Math.abs(a.w - stage.w) < 2 && Math.abs(a.h - stage.h) < 2);
ok('pane B shows as a small inset, not full screen', b.visible && b.w < stage.w * 0.3 && b.h < stage.h * 0.3);
ok('and pane C, staged but not chosen for PiP, is not shown at all', !c.visible);
ok(`the inset sits in the top-right corner, ~5%% off each edge (left ${(b.x / stage.w * 100).toFixed(0)}%%, top ${(b.y / stage.h * 100).toFixed(0)}%%)`,
  Math.abs(stage.w - (b.x + b.w)) / stage.w < 0.08 && b.y / stage.h < 0.08);
ok(`and is close to the default 20%% of the frame (${(b.w / stage.w * 100).toFixed(0)}%%)`,
  Math.abs(b.w / stage.w - 0.2) < 0.03);

// Swap C in for B as the inset - proving a pane that was staged but never
// shown comes up correctly the instant PiP actually picks it.
await pipPad.selectOption('#pip-inset', 'C');
await pipScreen.waitForFunction(() => getComputedStyle(document.querySelector('[data-panel="c"]')).display !== 'none', null, { timeout: 5000 });
ok('choosing pane C as the inset shows it immediately, with no re-staging needed', true);
[b, c] = await Promise.all([pipBox('b'), pipBox('c')]);
ok('and pane B, no longer chosen, drops out of view', !b.visible);
ok('with the content that was waiting there the whole time', /Pane C/.test(await pipScreen.textContent('[data-panel="c"] .r-text-body')));

// Picking the pane already showing as main for the INSET side (not main
// itself) is an ordinary, non-colliding change.
await pipPad.selectOption('#pip-main', 'B');
await pipScreen.waitForFunction(() => getComputedStyle(document.querySelector('[data-panel="b"]')).display !== 'none'
  && getComputedStyle(document.querySelector('[data-panel="a"]')).display === 'none', null, { timeout: 5000 });
ok('picking a new main (with no collision) swaps it straight in, dropping the old one', true);
ok('leaving the inset (C) untouched', /Pane C/.test(await pipScreen.textContent('[data-panel="c"] .r-text-body')));

// Now the genuine collision: main is B, inset is C - asking for C as main
// too is read as "swap them", resolved by protocol.js against whatever
// state.pip actually holds when the command lands, not refused and not
// computed from anything this pad cached client-side.
await pipPad.selectOption('#pip-main', 'C');
await pipScreen.waitForFunction(() => getComputedStyle(document.querySelector('[data-panel="c"]')).display !== 'none'
  && getComputedStyle(document.querySelector('[data-panel="b"]')).display !== 'none', null, { timeout: 5000 });
ok('and picking the current inset as the new main swaps the two, rather than being rejected as a collision', true);
await pipPad.waitForFunction(() => document.querySelector('#pip-main').value === 'C'
  && document.querySelector('#pip-inset').value === 'B', null, { timeout: 5000 });
ok('and this pad\'s own picker catches up to the swap too, not just the projector', true);

// Corner and size.
await pipPad.selectOption('#pip-corner', 'bl');
// fill() refuses a range input outright - set it and fire the same 'input'
// event a real drag would, which is what the size listener itself needs.
await pipPad.evaluate(() => {
  const input = document.querySelector('#pip-size');
  input.value = '35';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await pipScreen.waitForFunction(() => {
  const r = document.querySelector('[data-panel="b"]').getBoundingClientRect();
  const s = document.querySelector('#stage').getBoundingClientRect();
  return Math.abs(r.x - s.left) / s.width < 0.08 && Math.abs(s.bottom - r.bottom) / s.height < 0.08;
}, null, { timeout: 5000 });
ok('switching the corner moves the inset there, bottom-left this time', true);
const resized = await pipBox('b');
stage = await stageBox();
ok(`and the size slider actually resizes it (~${(resized.w / stage.w * 100).toFixed(0)}%% now, vs ~20%% at the default)`,
  resized.w / stage.w > 0.3);

await pipCtx.close();
}

if (want('display assetStore evicts old entries, not the one on screen')) {
console.log('\n-- Issue #120: display.js prunes its assetStore instead of growing forever --');
// The cap is overridden small (see MAX_ASSET_ENTRIES in display.js) so this
// proves real eviction with a handful of pictures rather than the 40+ a
// production-sized run would need.
const evictCtx = await browser.newContext();
await evictCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'asset-evict-room', passphrase: 'oldest first out' }));
await evictCtx.addInitScript(() => { window.__PODIUM_TEST_MAX_ASSET_ENTRIES__ = 3; });

const evictScreen = await evictCtx.newPage();
trap(evictScreen, 'asset-evict display');
await evictScreen.goto(`${BASE}/display.html`);
await evictScreen.click('#arm-button');
await evictScreen.waitForSelector('#hud[data-status="online"]');

const evictPad = await evictCtx.newPage();
trap(evictPad, 'asset-evict pad');
await evictPad.goto(`${BASE}/control.html`);
await evictPad.waitForSelector('.tile');
await evictPad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

const evictImage = writeImageFixture();
// One picture staged five times over, each its own fresh asset id (uid()
// mints a new one per upload even for identical bytes) - well past the cap
// of 3, so eviction has to actually run, more than once, for this to pass.
for (let i = 1; i <= 5; i++) {
  await evictPad.click('.tab[data-tab="say"]');
  await evictPad.click('#text-open-editor');
  await evictPad.fill('#msg-body', `Picture ${i}`);
  await evictPad.setInputFiles('#msg-image', evictImage);
  await evictPad.waitForFunction(() => /attached/.test(document.querySelector('#msg-image-note')?.textContent || ''), null, { timeout: 10000 });
  await evictPad.click('#message-editor-show');
  await evictScreen.waitForFunction((n) => document.querySelector('.layer[data-role="program"] .r-text-body')?.textContent === `Picture ${n}`, i, { timeout: 5000 });
}

const finalSize = await evictScreen.evaluate(() => window.__podiumAssetStoreSize());
ok(`five distinct pictures staged over a cap of 3 leaves the store at the cap, not five (${finalSize})`, finalSize <= 3);
ok('the picture actually on screen right now was never evicted to get there',
  !!(await evictScreen.getAttribute('.layer[data-role="program"] .r-text-image', 'src')));
ok('and it is real image data, not the blank-pixel placeholder a miss would show',
  (await evictScreen.getAttribute('.layer[data-role="program"] .r-text-image', 'src')).startsWith('data:image/jpeg'));

await evictCtx.close();
}

if (want('eraser hit-testing keeps up with a fast throttled swipe')) {
console.log('\n-- Issue #119: erase hit-testing is throttled without losing coverage --');
// A generous viewport, not the default: the default leaves the ink panel
// taller than the visible window, so #pad sits partly scrolled out of view
// and mouse coordinates computed from its (partly off-screen) bounding box
// land nowhere near where they are meant to.
const eraseCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await eraseCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'erase-throttle-room', passphrase: 'a fast swipe still gets both' }));
const eraseScreen = await eraseCtx.newPage();
trap(eraseScreen, 'erase-throttle display');
await eraseScreen.goto(`${BASE}/display.html`);
await eraseScreen.click('#arm-button');
await eraseScreen.waitForSelector('#hud[data-status="online"]');
const erasePad = await eraseCtx.newPage();
trap(erasePad, 'erase-throttle pad');
await erasePad.goto(`${BASE}/control.html`);
await erasePad.waitForSelector('.tile');
await erasePad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await erasePad.click('.tab[data-tab="ink"]');
await erasePad.waitForSelector('#pad');
// Measured fresh right before each use, not once up front and reused - the
// tab switch above can still be settling its own scroll position, and #pad
// moving between "drawn on" and "erased on" would silently aim every mouse
// coordinate below at the wrong place on the page.
const padBox = () => erasePad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

// Two strokes, well apart - "both gone" after one swipe only happens if the
// throttled hit-test still covers the whole path, not just wherever the
// swipe happened to be when a throttle window landed.
let box = await padBox();
await erasePad.mouse.move(box.x + box.w * 0.1, box.y + box.h * 0.15);
await erasePad.mouse.down();
for (let i = 1; i <= 8; i++) await erasePad.mouse.move(box.x + box.w * (0.1 + i * 0.02), box.y + box.h * 0.15);
await erasePad.mouse.up();
await erasePad.mouse.move(box.x + box.w * 0.1, box.y + box.h * 0.85);
await erasePad.mouse.down();
for (let i = 1; i <= 8; i++) await erasePad.mouse.move(box.x + box.w * (0.1 + i * 0.02), box.y + box.h * 0.85);
await erasePad.mouse.up();

await eraseScreen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
const paintedBefore = await eraseScreen.evaluate(() => {
  const c = document.querySelector('#ink');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
ok(`two strokes, well apart, painted before erasing (${paintedBefore} px)`, paintedBefore > 200);

await erasePad.click('#ink-tool-eraser');
box = await padBox();
// One continuous, fast swipe - many small moves with no pauses - straight
// down the left edge, crossing BOTH strokes in a single pointer gesture:
// exactly the shape of input that now sits behind the throttle.
await erasePad.mouse.move(box.x + box.w * 0.12, box.y + box.h * 0.1);
await erasePad.mouse.down();
for (let i = 1; i <= 40; i++) await erasePad.mouse.move(box.x + box.w * 0.12, box.y + box.h * (0.1 + i * 0.02));
await erasePad.mouse.up();

await eraseScreen.waitForFunction(() => !document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
ok('a single fast swipe erases both strokes, not just the one nearer where it happened to slow down', true);
const paintedAfter = await eraseScreen.evaluate(() => {
  const c = document.querySelector('#ink');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
ok(`and the canvas is actually clear, not just flagged (${paintedAfter} px)`, paintedAfter === 0);

await eraseCtx.close();
}

reportErrors();
} finally {
  await teardown();
}
exitWithResult();
