// End-to-end test for Podium.
//
//   npm i playwright && npx playwright install chromium
//   node podium/test/e2e.mjs
//
// It starts the self-hosted relay on a spare port, serves the pages from it,
// drives a display and two controllers in real browsers, and checks the things
// that would embarrass you in front of a class: freeze really holds, TAKE puts
// the cued item up without reloading it, ink arrives, and a device with the
// wrong passphrase cannot touch the screen.
//
// It generates its own audio fixture, so there is nothing to download.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

async function loadPlaywright() {
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    try { return await import(spec); } catch { /* try the next one */ }
  }
  console.error('playwright not found. Run: npm i playwright && npx playwright install chromium');
  process.exit(2);
}

// A 30-second tone, written with nothing but the standard library.
function writeFixture() {
  const file = path.join(HERE, 'fixtures', 'tone.wav');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return file;
  const rate = 8000;
  const seconds = 30;
  const samples = rate * seconds;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    data.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * (220 + 40 * Math.floor(t)) * t)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
  return file;
}

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const { chromium } = await loadPlaywright();
writeFixture();

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['podium-server.js'], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(PORT), STATIC: '../' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('relay did not start')), 10000);
  server.stdout.on('data', (d) => { if (String(d).includes('podium relay')) { clearTimeout(timer); resolve(); } });
  server.on('exit', (code) => reject(new Error(`relay exited with ${code} - did you run npm install in podium/server?`)));
});

const CFG = JSON.stringify({
  transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`,
  room: 'e2e-room', passphrase: 'correct horse battery staple',
});

const fails = [];
const errors = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

const browser = await chromium.launch({
  args: [
    '--autoplay-policy=no-user-gesture-required',
    // A synthetic camera and mic, auto-granted with no permission prompt, so
    // the phone-camera flow can be driven end-to-end headlessly.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), CFG);

// Themes may pull webfonts from the internet (gaia imports one, KaTeX fetches
// its glyph fonts). A sandbox with no outbound network fails those requests and
// the slides still render, so they are noise rather than a result.
const OFFLINE_NOISE = /ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_PROXY_CONNECTION_FAILED/;

const trap = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (OFFLINE_NOISE.test(m.text())) return;
    errors.push(`${tag} console: ${m.text()}`);
  });
};

try {
console.log('-- switching, freeze and take --');
const display = await ctx.newPage();
trap(display, 'display');
await display.goto(`${BASE}/display.html`);
await display.waitForSelector('#arm:not([hidden])');
ok('display shows the arming screen', true);
await display.click('#arm-button');
await display.waitForSelector('#hud[data-status="online"]', { timeout: 10000 });
ok('display connects to the relay', true);

const control = await ctx.newPage();
trap(control, 'control');
await control.goto(`${BASE}/control.html`);
await control.waitForSelector('#app:not([hidden])');
await control.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'), null, { timeout: 10000 });
ok('controller sees the display', true);

await control.waitForSelector('.tile');
const tiles = await control.$$eval('.tile-title', (n) => n.map((x) => x.textContent));
ok('library loaded built-ins and the manifest', tiles.includes('Whiteboard') && tiles.includes('Opening slide'));

const fpD = await display.textContent('#fingerprint');
const fpC = await control.textContent('#fingerprint');
ok(`pairing code matches on both ends (${fpD})`, fpD === fpC && fpD.length === 4);

const programHTML = () => display.$eval('.layer[data-role="program"]', (n) => n.innerHTML).catch(() => '');
const clickTile = (title) => control.click(`.tile:has(.tile-title:text-is("${title}"))`);

// --- unfrozen: picking goes straight to the projector
await clickTile('Whiteboard');
await display.waitForFunction(() => !!document.querySelector('.layer[data-role="program"] .r-whiteboard'), null, { timeout: 5000 });
ok('picking content while live puts it on screen', true);

// --- freeze: the projector holds, picks land in the cue
await control.click('#freeze');
await display.waitForFunction(() => document.body.classList.contains('is-frozen'), null, { timeout: 5000 });
await clickTile('Opening slide');
await control.waitForFunction(() => document.querySelector('#preview-label')?.textContent === 'Cued', null, { timeout: 5000 });
const heldHTML = await programHTML();
ok('projector still shows the whiteboard while frozen', heldHTML.includes('r-whiteboard'));
ok('the new pick is waiting in the cue, not on screen', !heldHTML.includes('r-text'));
ok('controller preview shows the cued item', await control.$eval('#preview-stage', (n) => n.innerHTML.includes('r-text')));
ok('TAKE is armed', await control.$eval('#take', (b) => !b.disabled && b.classList.contains('is-armed')));

// --- take: the cued item goes live and freeze releases
await control.click('#take');
await display.waitForFunction(() => !!document.querySelector('.layer[data-role="program"] .r-text'), null, { timeout: 5000 });
ok('TAKE puts the cued item on screen', true);
ok('TAKE releases the freeze', !(await display.evaluate(() => document.body.classList.contains('is-frozen'))));

// --- the layer that was cued is the same node that went live (no rebuild)
const reused = await display.evaluate(() => {
  const program = document.querySelector('.layer[data-role="program"]');
  // Scoped to panel A: B/C/D each carry their own (idle, single) .layer too,
  // present but unused outside a split layout - see LAYOUTS in protocol.js.
  return program?.dataset.role === 'program' && document.querySelectorAll('[data-panel="a"] .layer').length === 2;
});
ok('two content layers are reused rather than rebuilt', reused);

// --- blank
await control.click('#blank');
await display.waitForFunction(() => document.querySelector('#blank').classList.contains('is-on'), null, { timeout: 5000 });
ok('blank cuts to black', true);
await control.click('#blank');
await display.waitForFunction(() => !document.querySelector('#blank').classList.contains('is-on'), null, { timeout: 5000 });
ok('blank toggles back off', true);

// --- caption overlay
await control.click('.tab[data-tab="say"]');
await control.fill('#overlay-text', 'Chapter 4 · Working memory');
await control.click('#overlay-form button[type=submit]');
await display.waitForFunction(() => document.querySelector('#overlay').classList.contains('is-on'), null, { timeout: 5000 });
ok('caption overlay appears on the display', (await display.textContent('#overlay')).includes('Working memory'));

// --- timer runs on the display
await control.click('.tab[data-tab="timer"]');
await control.click('.timer-preset[data-mins="5"]');
await display.waitForFunction(() => !!document.querySelector('.layer[data-role="program"] .r-timer-value'), null, { timeout: 5000 });
const t1 = await display.textContent('.r-timer-value');
await display.waitForTimeout(1200);
const t2 = await display.textContent('.r-timer-value');
ok(`countdown ticks on the display (${t1} -> ${t2})`, t1 !== t2 && t1.startsWith('5:'));

// --- ink draws over whatever is on screen
await control.click('.tab[data-tab="ink"]');
await control.waitForSelector('#pad');
const box = await control.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await control.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.3);
await control.mouse.down();
for (let i = 1; i <= 12; i++) await control.mouse.move(box.x + box.w * (0.2 + i * 0.045), box.y + box.h * (0.3 + i * 0.03));
await control.mouse.up();
await display.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
ok('ink from the iPad reaches the display', true);
const painted = await display.evaluate(() => {
  const c = document.querySelector('#ink');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
  return n;
});
ok(`ink actually painted pixels (${painted})`, painted > 200);
await control.click('#ink-clear');
await display.waitForFunction(() => !document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
ok('clear wipes the annotation', true);

// --- a second controller stays in step with the first
const phone = await ctx.newPage();
trap(phone, 'phone');
await phone.setViewportSize({ width: 390, height: 844 });
await phone.goto(`${BASE}/control.html`);
await phone.waitForSelector('#app:not([hidden])');
await phone.waitForFunction(() => document.querySelector('#preview-title')?.textContent === 'Timer', null, { timeout: 10000 });
ok('a second controller syncs to current state on join', true);
await phone.click('#freeze');
await control.waitForFunction(() => document.querySelector('#freeze').classList.contains('is-on'), null, { timeout: 5000 });
ok('the iPhone and the iPad stay in step', true);

// --- a wrong passphrase cannot drive the display
const intruderCtx = await browser.newContext();
await intruderCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'e2e-room', passphrase: 'guessed-wrong' }));
const intruder = await intruderCtx.newPage();
await intruder.goto(`${BASE}/control.html`);
await intruder.waitForSelector('#app:not([hidden])');
await intruder.waitForSelector('.tile');
// Compare the renderer in use, not innerHTML: the timer's digits tick.
const programType = () => display.$eval('.layer[data-role="program"] > *', (n) => n.className).catch(() => '');
const before = await programType();
for (const t of ['Chalkboard', 'Black', 'Whiteboard', 'Chalkboard', 'Black']) {
  await intruder.click(`.tile:has(.tile-title:text-is("${t}"))`);
  await intruder.waitForTimeout(300);
}
await display.waitForTimeout(1200);
ok(`a controller with the wrong passphrase cannot change the display (${before})`, (await programType()) === before);
await display.waitForFunction(() => document.querySelector('#hud').dataset.status === 'mismatch', null, { timeout: 15000 });
ok('the display warns that something is speaking the wrong passphrase', true);

console.log('\n-- media --');
{
// Start this section from a known state: the section above left the ink tab
// open and the projector frozen.
await control.click('.tab[data-tab="library"]');
if (await control.$eval('#freeze', (b) => b.classList.contains('is-on'))) await control.click('#freeze');
await display.waitForFunction(() => !document.body.classList.contains('is-frozen'), null, { timeout: 5000 });

const audioState = () => display.evaluate(() => {
  const a = document.querySelector('.layer[data-role="program"] audio');
  const p = document.querySelector('.layer[data-role="preview"] audio');
  return {
    program: a ? { t:+a.currentTime.toFixed(2), paused:a.paused, vol:+a.volume.toFixed(2), muted:a.muted } : null,
    preview: p ? { t:+p.currentTime.toFixed(2), paused:p.paused } : null,
  };
});

// Put a tone on screen via the paste-a-link box.
await control.fill('#url-input', `${BASE}/test/fixtures/tone.wav`);
await control.click('#url-form button[type=submit]');
await display.waitForFunction(()=>!!document.querySelector('.layer[data-role="program"] audio'), null, {timeout:5000});
await display.waitForFunction(()=>{const a=document.querySelector('.layer[data-role="program"] audio');return a && !a.paused && a.currentTime>0.3;},null,{timeout:8000});
ok('a pasted audio link plays on the display', true);

// Volume is driven from the controller.
await control.evaluate(()=>{const v=document.querySelector('#volume'); v.value='0.35'; v.dispatchEvent(new Event('input',{bubbles:true}));});
await display.waitForFunction(()=>Math.abs(document.querySelector('.layer[data-role="program"] audio').volume-0.35)<0.02,null,{timeout:5000});
ok('volume slider reaches the display', true);

// Seek (transport controls live on the Now tab).
await control.click('.tab[data-tab="now"]');
await control.evaluate(()=>{const s=document.querySelector('#scrub'); s.value='18'; s.dispatchEvent(new Event('change',{bubbles:true}));});
await display.waitForFunction(()=>document.querySelector('.layer[data-role="program"] audio').currentTime>17.5,null,{timeout:5000});
ok('scrubbing from the controller seeks the display', true);

// Pause from the always-visible bar, not the tab.
await control.click('.tab[data-tab="library"]');
await control.waitForSelector('#bar-play:not([hidden])');
await control.click('#bar-play');
await display.waitForFunction(()=>document.querySelector('.layer[data-role="program"] audio').paused,null,{timeout:5000});
ok('pause from the bottom bar reaches the display', true);
await control.click('#bar-play');
await display.waitForFunction(()=>!document.querySelector('.layer[data-role="program"] audio').paused,null,{timeout:5000});
ok('play resumes', true);

// --- the headline behaviour: cue a second clip while frozen -----------------
await control.click('#freeze');
await display.waitForFunction(()=>document.body.classList.contains('is-frozen'),null,{timeout:5000});
await control.fill('#url-input', `${BASE}/test/fixtures/tone.wav?take2`);
await control.click('#url-form button[type=submit]');
await display.waitForFunction(()=>!!document.querySelector('.layer[data-role="preview"] audio'),null,{timeout:5000});

// Tag the cued element so we can prove the very same node goes live.
await display.evaluate(()=>{ document.querySelector('.layer[data-role="preview"] audio').dataset.tag='cued-node'; });
await display.waitForTimeout(1200);
const before = await audioState();
ok('the cued clip sits paused at zero instead of running in the background',
   before.preview && before.preview.paused && before.preview.t < 0.2);
ok('the clip on screen keeps playing while frozen', before.program && !before.program.paused);
const programBefore = before.program.t;

await control.click('#take');
await display.waitForFunction(()=>document.querySelector('.layer[data-role="program"] audio')?.dataset.tag==='cued-node',null,{timeout:5000});
ok('TAKE promotes the very same element - no reload, no lost cue point', true);
await display.waitForFunction(()=>{const a=document.querySelector('.layer[data-role="program"] audio');return a && !a.paused;},null,{timeout:5000});
const after = await audioState();
ok(`the taken clip starts playing (t=${after.program.t})`, !after.program.paused);
ok(`it inherits the room volume rather than full blast (${after.program.vol})`, Math.abs(after.program.vol-0.35)<0.02);
ok(`the clip it replaced was torn down (was at ${programBefore}s)`, await display.evaluate(()=>document.querySelectorAll('audio').length===1));

// Mute.
await control.click('#mute');
await display.waitForFunction(()=>document.querySelector('.layer[data-role="program"] audio').muted,null,{timeout:5000});
ok('mute reaches the display', true);
}

console.log('\n-- marp decks --');
{
await control.click('.tab[data-tab="library"]');
if (await control.$eval('#freeze', (b) => b.classList.contains('is-on'))) await control.click('#freeze');
await display.waitForFunction(() => !document.body.classList.contains('is-frozen'), null, { timeout: 5000 });

// What the projector is actually showing, read out of the deck's shadow root.
const onScreen = () => display.evaluate(() => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  if (!host?.shadowRoot) return null;
  const svgs = [...host.shadowRoot.querySelectorAll('svg[data-marpit-svg]')];
  const index = svgs.findIndex((s) => s.classList.contains('podium-on'));
  const section = index >= 0 ? svgs[index].querySelector('section') : null;
  return {
    index,
    total: svgs.length,
    heading: section?.querySelector('h1, h2, h3')?.textContent?.trim() || null,
  };
});
const waitForSlide = (i) => display.waitForFunction((want) => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  const svgs = [...(host?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]') || [])];
  return svgs.findIndex((s) => s.classList.contains('podium-on')) === want;
}, i, { timeout: 25000 });

await control.click('.tile:has(.tile-title:text-is("Podium deck features (example)"))');
await waitForSlide(0);
let shown = await onScreen();
ok(`a deck from the server renders on the projector (${shown.total} slides)`, shown.total === 4);

await control.click('.tab[data-tab="slides"]');
await control.waitForFunction(() => !document.querySelector('#deck-live').hidden, null, { timeout: 20000 });
await control.waitForFunction(() => document.querySelector('#deck-notes').textContent.includes('presenter note'), null, { timeout: 20000 });
ok('presenter notes reach the controller', true);
ok('and never reach the projector', !(await display.evaluate(() => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  return host.shadowRoot.textContent.includes('It shows up on your iPad');
})));
ok('the slide counter is right', (await control.textContent('#deck-count')) === 'Slide 1 / 4');

await control.click('#deck-next');
await waitForSlide(1);
await control.waitForFunction(() => document.querySelector('#deck-notes').textContent.includes('Second slide note'), null, { timeout: 10000 });
ok('Next advances the projector and the notes together', true);

const cells = await control.evaluate(() => document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cell').length);
ok(`the navigator built ${cells} thumbnails`, cells === 4);
await control.evaluate(() => document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cell')[3].click());
await waitForSlide(3);
ok('tapping a thumbnail jumps the projector', true);
await control.waitForFunction(() => document.querySelector('#deck-next').disabled, null, { timeout: 8000 });
ok('Next greys out on the last slide', true);
// The arrow keys bypass the disabled button, so they prove the clamp is real
// and exercise the keyboard/clicker path at the same time.
await control.click('#deck-grid');
await control.keyboard.press('ArrowRight');
await display.waitForTimeout(700);
ok('a keyboard Next on the last slide stays put instead of going blank', (await onScreen()).index === 3);
await control.keyboard.press('ArrowLeft');
await waitForSlide(2);
ok('the arrow keys drive the deck', true);

const look = await display.evaluate(() => {
  const sr = document.querySelector('.layer[data-role="program"] .r-deck').shadowRoot;
  const sec = sr.querySelector('svg.podium-on section');
  return {
    themed: getComputedStyle(sec).backgroundImage.includes('gradient'),
    katex: [...sr.querySelectorAll('style')].some((s) => s.textContent.includes('KaTeX')),
    math: !!sr.querySelectorAll('svg')[2].querySelector('.katex'),
  };
});
ok('the custom marp-themes/ CSS is applied on the projector', look.themed);
ok('math renders through KaTeX', look.katex && look.math);

// Upload: the markdown only exists on the controller and has to cross the bus.
await control.click('.tab[data-tab="library"]');
await control.setInputFiles('#deck-file', path.join(ROOT, 'content/decks/day06-evidence-weighting.md'));
await control.waitForFunction(() => document.querySelector('#deck-file-note').textContent.includes('slides'), null, { timeout: 30000 });
await display.waitForFunction(() => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  return host?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length === 13;
}, null, { timeout: 30000 });
shown = await onScreen();
ok(`an uploaded deck reaches the projector over the bus ("${shown.heading}")`, shown.total === 13);

// Cue a deck behind a freeze, exactly as you would mid-lecture.
await control.click('#freeze');
await display.waitForFunction(() => document.body.classList.contains('is-frozen'));
// Uploading jumps you to the Slides tab, so come back for the library.
await control.click('.tab[data-tab="library"]');
await control.click('.tile:has(.tile-title:text-is("Podium deck features (example)"))');
await control.waitForFunction(() => document.querySelector('#preview-label').textContent === 'Cued', null, { timeout: 25000 });
ok('the projector holds the deck on screen while another is cued', (await onScreen()).total === 13);
await control.click('#take');
await display.waitForFunction(() => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  return host?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length === 4;
}, null, { timeout: 25000 });
ok('TAKE swaps to the cued deck', true);

// A deck asking for a theme nobody installed should say so, not fail silently.
const badTheme = path.join(HERE, 'fixtures', 'missing-theme.md');
fs.writeFileSync(badTheme, '---\nmarp: true\ntheme: not-a-real-theme\n---\n\n# Slide one\n\n---\n\n# Slide two\n');
await control.setInputFiles('#deck-file', badTheme);
await control.click('.tab[data-tab="slides"]');
await control.waitForFunction(() => document.querySelector('#deck-theme').textContent.includes('not installed'), null, { timeout: 25000 });
ok('a deck naming a missing theme is called out rather than silently defaulted', true);
}

console.log('\n-- telling the three kinds of silence apart --');
{
const mk = (room, pass) => JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room, passphrase: pass });

// A display that is loaded but not armed must be visible to a controller,
// otherwise "nothing happens" covers two very different problems.
const c1 = await browser.newContext();
await c1.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), mk('diag-unarmed', 'pw'));
const unarmed = await c1.newPage();
trap(unarmed, 'unarmed display');
await unarmed.goto(`${BASE}/display.html`);
await unarmed.waitForSelector('#arm:not([hidden])');
await unarmed.waitForFunction(() => document.querySelector('#arm-status').textContent.startsWith('Connected'), null, { timeout: 10000 });
ok('an unarmed display still joins the room', true);

const watcher = await c1.newPage();
trap(watcher, 'watcher');
await watcher.goto(`${BASE}/control.html`);
await watcher.waitForSelector('#app:not([hidden])');
await watcher.waitForFunction(() => document.querySelector('#display-state').textContent.includes('Go live'), null, { timeout: 10000 });
ok('a controller can tell "not armed yet" from "not there"', true);
await watcher.waitForTimeout(7000);
ok('and does not raise the alarm banner for it', await watcher.isHidden('#link-help'));
await unarmed.click('#arm-button');
await watcher.waitForFunction(() => document.querySelector('#display-state').textContent.startsWith('Display connected'), null, { timeout: 10000 });
ok('arming flips it to connected', true);
await c1.close();

// An empty room should say so, with the room and code to compare against.
const c2 = await browser.newContext();
await c2.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), mk('diag-empty', 'pw'));
const lonely = await c2.newPage();
trap(lonely, 'lonely');
await lonely.goto(`${BASE}/control.html`);
await lonely.waitForSelector('#app:not([hidden])');
await lonely.waitForSelector('#link-help:not([hidden])', { timeout: 15000 });
const helpText = (await lonely.textContent('#link-help')).replace(/\s+/g, ' ');
ok('an empty room raises a banner naming the likely causes', helpText.includes('Go live') && helpText.includes('room'));
await c2.close();

// Same room, wrong passphrase: the controller should name that specifically.
const c3 = await browser.newContext();
await c3.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), mk('diag-mismatch', 'right'));
const rightDisplay = await c3.newPage();
await rightDisplay.goto(`${BASE}/display.html`);
await rightDisplay.click('#arm-button');
await rightDisplay.waitForSelector('#hud[data-status="online"]');
const c4 = await browser.newContext();
await c4.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), mk('diag-mismatch', 'WRONG'));
const wrongControl = await c4.newPage();
await wrongControl.goto(`${BASE}/control.html`);
await wrongControl.waitForSelector('#app:not([hidden])');
await wrongControl.waitForSelector('#link-help.is-mismatch:not([hidden])', { timeout: 25000 });
ok('a passphrase mismatch is named on the controller, not just the display', true);
await c3.close(); await c4.close();
}

console.log('\n-- pairing overlay and clearing a device --');
{
// These run in their own context so wiping storage cannot disturb the pages above.
const fresh = await browser.newContext({ viewport: { width: 1280, height: 800 } });
// Seed once: addInitScript re-runs on every navigation, and re-seeding after a
// reset would hide whether the reset actually did anything.
await fresh.addInitScript((cfg) => {
  if (localStorage.getItem('seed.done')) return;
  localStorage.setItem('seed.done', '1');
  localStorage.setItem('podium.config.v2', cfg);
  localStorage.setItem('podium.library.v1', JSON.stringify([{ type: 'image', src: 'x.png', title: 'Saved thing' }]));
  // Stand-in for another project sharing the same GitHub Pages origin.
  localStorage.setItem('someotherapp.state', 'do-not-touch');
}, JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'reset-room', passphrase: 'chalk dust' }));

const screen = await fresh.newPage();
trap(screen, 'reset display');
await screen.goto(`${BASE}/display.html`);
await screen.waitForSelector('#arm:not([hidden])');

// The pairing sheet and the arming sheet used to share one z-index, so the QR
// opened *underneath* the arming screen and the button looked broken.
await screen.click('#pair-button');
await screen.waitForSelector('#pair:not([hidden])');
const onTop = await screen.evaluate(() => {
  const qr = document.querySelector('#pair-qr svg');
  if (!qr) return { drawn: false };
  const r = qr.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { drawn: r.width > 100, onTop: !!hit?.closest('#pair') };
});
ok('the pairing QR is drawn when opened from the arming screen', onTop.drawn);
ok('and sits on top of the arming screen rather than under it', onTop.onTop);
await screen.click('#pair-close');

await screen.click('#arm-button');
await screen.waitForSelector('#standby.is-on');
await screen.click('#standby-pair');
await screen.waitForSelector('#pair:not([hidden])');
ok('pairing still works from the standby screen', await screen.evaluate(() => {
  const r = document.querySelector('#pair-qr svg').getBoundingClientRect();
  return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('#pair');
}));
await screen.click('#pair-close');

const pad = await fresh.newPage();
trap(pad, 'reset control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('#app:not([hidden])');
await pad.click('#open-settings');
await pad.waitForSelector('#setup:not([hidden])');
ok('Close is offered while the device is configured', !(await pad.isHidden('#setup-close')));

await pad.click('#reset-device');
ok('one tap only arms the reset', (await pad.textContent('#reset-device')).includes('Tap again'));
ok('and nothing is cleared yet', await pad.evaluate(() => !!localStorage.getItem('podium.config.v2')));

await Promise.all([pad.waitForNavigation({ timeout: 20000 }), pad.click('#reset-device')]);
await pad.waitForSelector('#setup:not([hidden])', { timeout: 15000 });
ok('the second tap clears settings and reloads into first-run',
   await pad.evaluate(() => !localStorage.getItem('podium.config.v2')));
ok('saved library items are cleared too', await pad.evaluate(() => !localStorage.getItem('podium.library.v1')));
ok('another app sharing the origin is left alone',
   await pad.evaluate(() => localStorage.getItem('someotherapp.state') === 'do-not-touch'));
ok('Close is hidden once there is nothing to go back to', await pad.isHidden('#setup-close'));
const freshRoom = await pad.inputValue('#c-room');
ok(`a new random room is generated rather than the old one (${freshRoom})`,
   freshRoom !== 'reset-room' && freshRoom.startsWith('room-'));

// S is the way into Settings on a kiosk display with no browser chrome.
await screen.keyboard.press('s');
await screen.waitForSelector('#setup:not([hidden])', { timeout: 5000 });
ok('pressing S on the display opens Settings', true);
await screen.click('#reset-device');
await Promise.all([screen.waitForNavigation({ timeout: 20000 }), screen.click('#reset-device')]);
await screen.waitForSelector('#setup:not([hidden])', { timeout: 15000 });
ok('the display clears the same way', await screen.evaluate(() => !localStorage.getItem('podium.config.v2')));
await fresh.close();
}

console.log('\n-- freeze protects what is on screen, never the audio --');
{
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'freeze-room', passphrase: 'hold still' }));

const screen = await ctx.newPage();
trap(screen, 'freeze display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'freeze control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

const shownSlide = () => screen.evaluate(() => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  const svgs = [...(host?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]') || [])];
  return svgs.findIndex((s) => s.classList.contains('podium-on'));
});

await pad.click('.tile:has(.tile-title:text-is("Podium deck features (example)"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg].podium-on').length === 1, null, { timeout: 20000 });
ok('a deck is on screen to freeze', (await shownSlide()) === 0);

await pad.click('#freeze');
await screen.waitForFunction(() => document.body.classList.contains('is-frozen'));
await pad.click('.tab[data-tab="slides"]');
await pad.click('#deck-next');
await pad.waitForFunction(() => document.querySelector('#preview-label')?.textContent === 'Cued', null, { timeout: 10000 });
await screen.waitForTimeout(600);
ok('Next while frozen does NOT advance the projector', (await shownSlide()) === 0);
ok('it quietly cues a browsable copy instead, armed to take', await pad.$eval('#take', (b) => !b.disabled));

await pad.click('#deck-next');
await pad.waitForTimeout(300);
await screen.waitForTimeout(300);
ok('further paging while frozen keeps advancing only the cue', (await shownSlide()) === 0);

await pad.click('#take');
await screen.waitForFunction((want) => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  const svgs = [...(host?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]') || [])];
  return svgs.findIndex((s) => s.classList.contains('podium-on')) === want;
}, 2, { timeout: 10000 });
ok('TAKE is what actually moves the projector, landing where you browsed to', true);
ok('and it unfreezes', !(await screen.evaluate(() => document.body.classList.contains('is-frozen'))));

// Now background audio: freeze must never redirect play/pause/seek to a cue.
await pad.click('.tab[data-tab="library"]');
await pad.fill('#url-input', `${BASE}/test/fixtures/tone.wav`);
await pad.click('#url-form button[type=submit]');
await screen.waitForFunction(() => {
  const a = document.querySelector('.layer[data-role="program"] audio');
  return a && !a.paused && a.currentTime > 0.3;
}, null, { timeout: 8000 });
await pad.click('#freeze');
await screen.waitForFunction(() => document.body.classList.contains('is-frozen'));
ok('music keeps playing once frozen', !(await screen.evaluate(() => document.querySelector('.layer[data-role="program"] audio').paused)));

await pad.click('.tab[data-tab="now"]');
await pad.click('#play-pause');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] audio').paused, null, { timeout: 5000 });
ok('pause while frozen reaches the actual playing audio, not a hidden cue', await pad.evaluate(() => !document.querySelector('#take').classList.contains('is-armed')));
await pad.click('#play-pause');
await screen.waitForFunction(() => !document.querySelector('.layer[data-role="program"] audio').paused, null, { timeout: 5000 });
ok('and resumes it the same way', true);
await pad.evaluate(() => { const s = document.querySelector('#scrub'); s.value = '18'; s.dispatchEvent(new Event('change', { bubbles: true })); });
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] audio').currentTime > 17.5, null, { timeout: 5000 });
ok('seeking while frozen also reaches the real audio directly', true);
await ctx.close();
}

console.log('\n-- ink is shaped to the content, not the whole (possibly letterboxed) screen --');
{
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

await pad.click('.tab[data-tab="ink"]');
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
await pad.fill('#text-body', 'Back in 5');
await pad.click('#text-form button[type=submit]');
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
await pad.waitForTimeout(200);
await pad.click('#ink-clear');
await screen.waitForFunction(() => !document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
ok('Clear wipes only the surface currently on screen', true);
await ctx.close();
}

console.log('\n-- the phone-camera tile in the library actually starts the camera --');
{
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'camera-room', passphrase: 'say cheese' }));
const screen = await ctx.newPage();
trap(screen, 'camera display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const phone = await ctx.newPage();
trap(phone, 'camera phone');
await phone.goto(`${BASE}/control.html`);
await phone.waitForSelector('.tile');
await phone.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

// The natural thing to tap is the library tile, not the separate Camera tab -
// this used to only stage the type without ever requesting the camera.
await phone.click('.tile:has(.tile-title:text-is("Phone camera"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-camera')?.classList.contains('has-stream'), null, { timeout: 15000 });
ok('tapping the library tile alone starts the camera and gets it on screen', true);
await phone.waitForFunction(() => document.querySelector('#cam-status').textContent === 'Live on the display', null, { timeout: 10000 });
ok('the controller reflects a live connection too', true);
await ctx.close();
}

console.log('\n-- progressive builds: bullets arrive one at a time --');
{
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

console.log('\n-- zoom on the ink pad is a view convenience, not a coordinate change --');
{
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

await pad.click('#ink-zoom-in');
await pad.click('#ink-zoom-in');
await pad.waitForTimeout(200);
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
await pad.waitForTimeout(200);
ok('reset zoom returns to 1x and disables panning again', await pad.$eval('#pan-left', (b) => b.disabled));
await ctx.close();
}

console.log('\n-- exporting marked-up slides to a zip --');
{
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

console.log('\n-- freezing a camera holds its current frame --');
{
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'cam-freeze-room', passphrase: 'hold that frame' }));
const screen = await ctx.newPage();
trap(screen, 'camfreeze display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const phone = await ctx.newPage();
trap(phone, 'camfreeze phone');
await phone.goto(`${BASE}/control.html`);
await phone.waitForSelector('.tile');
await phone.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await phone.click('.tile:has(.tile-title:text-is("Phone camera"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-camera')?.classList.contains('has-stream'), null, { timeout: 15000 });
ok('the camera is live and playing', !(await screen.evaluate(() => document.querySelector('.r-video').paused)));

await phone.click('#freeze');
await screen.waitForFunction(() => document.body.classList.contains('is-frozen'));
await screen.waitForFunction(() => document.querySelector('.r-video').paused, null, { timeout: 5000 });
ok('freezing pauses the live feed on its current frame', true);
ok('and shows a Frozen badge on the projector', await screen.evaluate(() => getComputedStyle(document.querySelector('.r-camera-frozen')).display !== 'none'));

await phone.click('#freeze');
await screen.waitForFunction(() => !document.body.classList.contains('is-frozen'));
await screen.waitForFunction(() => !document.querySelector('.r-video').paused, null, { timeout: 5000 });
ok('unfreezing resumes the live view', true);
await ctx.close();
}

console.log('\n-- the Ink tab shows what you are drawing on, and can hide it --');
{
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

console.log('\n-- Slides tab: a Now/Next confidence monitor, Markup, and a laser pointer --');
{
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'confidence-room', passphrase: 'now and next' }));
const screen = await ctx.newPage();
trap(screen, 'confidence display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'confidence control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Podium deck features (example)"))');
await screen.waitForFunction(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length === 4, null, { timeout: 20000 });
// A box measured while its panel was [hidden] gets 0x0 back from
// getBoundingClientRect(), which fitBox() quietly declines to size anything
// from - switching tabs cold, with no extra wait, is what catches a mirror
// left permanently zero-sized rather than merely "not mounted yet".
await pad.click('.tab[data-tab="slides"]');

ok('the Now box mirrors the live deck', await pad.evaluate(() => document.querySelector('#deck-now-preview').querySelector('.r-deck') !== null));
ok('and its frame is actually sized, not left blank from a hidden-panel measurement',
   await pad.$eval('#deck-now-preview .mirror-frame', (n) => n.getBoundingClientRect().width > 20));
ok('the Next box previews the deck too', await pad.evaluate(() => document.querySelector('#deck-next-preview').querySelector('.r-deck') !== null));
ok('and its frame is sized too', await pad.$eval('#deck-next-preview .mirror-frame', (n) => n.getBoundingClientRect().width > 20));
ok('Next names the upcoming slide', (await pad.textContent('#deck-next-title')).startsWith('2.'));

await pad.click('#deck-next'); await pad.click('#deck-next'); await pad.click('#deck-next');
await pad.waitForTimeout(400);
ok('Next reads "End of deck" once there is nothing left to look ahead to', (await pad.textContent('#deck-next-title')) === 'End of deck');

await pad.click('#deck-markup');
ok('Markup jumps straight to the Ink tab', await pad.evaluate(() => document.querySelector('.tab[data-tab="ink"]').classList.contains('is-on')));

await pad.click('.tab[data-tab="slides"]');
await pad.waitForTimeout(300);
await pad.click('#deck-laser');
ok('Laser arms', await pad.evaluate(() => document.querySelector('#deck-laser').classList.contains('is-on')));
const box = await pad.$eval('#deck-now-preview .mirror-frame', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await pad.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5);
await pad.mouse.down();
await screen.waitForFunction(() => document.querySelector('#laser').classList.contains('is-on'), null, { timeout: 5000 });
const stage = await screen.evaluate(() => ({ w: document.querySelector('#stage').clientWidth, h: document.querySelector('#stage').clientHeight }));
const dot1 = await screen.evaluate(() => { const l = document.querySelector('#laser'); return { x: parseFloat(l.style.left), y: parseFloat(l.style.top) }; });
ok('a laser dot appears on the projector, at the content center', Math.abs(dot1.x - stage.w / 2) < 40 && Math.abs(dot1.y - stage.h / 2) < 40);

await pad.mouse.move(box.x + box.w * 0.85, box.y + box.h * 0.15);
await screen.waitForTimeout(150);
const dot2 = await screen.evaluate(() => { const l = document.querySelector('#laser'); return { x: parseFloat(l.style.left), y: parseFloat(l.style.top) }; });
ok('the dot tracks the drag', dot2.x > dot1.x && dot2.y < dot1.y);

await pad.mouse.up();
await screen.waitForFunction(() => !document.querySelector('#laser').classList.contains('is-on'), null, { timeout: 3000 });
ok('releasing hides the dot - nothing is left behind, nothing was saved', true);
await ctx.close();
}

console.log('\n-- waiting music actually plays --');
{
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'music-room', passphrase: 'between classes' }));
const screen = await ctx.newPage();
trap(screen, 'music display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'music control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Waiting music"))');
await screen.waitForFunction(() => {
  const a = document.querySelector('.layer[data-role="program"] audio');
  return a && !a.paused && a.currentTime > 0.3;
}, null, { timeout: 8000 });
ok('picking "Waiting music" from the library actually plays sound', true);
await ctx.close();
}

console.log('\n-- ink survives a layout change mid-stroke instead of warping --');
{
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

console.log('\n-- ink drawn the instant a deck pick allows it lands correctly, and never lands wrong --');
{
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

console.log('\n-- ink recovers even if a fullscreen transition never fires a resize event --');
{
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

console.log('\n-- ink stays put when the display is dragged to a screen of a different pixel density --');
{
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

console.log('\n-- Waiting Music under a strict (Safari-like) autoplay policy --');
{
// The main suite launches Chromium with --autoplay-policy=no-user-gesture-
// required, which is realistic for Chromium's own default but would let a
// broken unlock pass silently - it disables the very policy the fix targets.
// This block runs its own context with an in-page monkeypatch of
// HTMLMediaElement.play() instead, simulating Safari's stricter rule (every
// play() call rejected until a real gesture has occurred) regardless of the
// browser-level launch flag, so it actually exercises the Go Live fix: a
// real <audio> element's play() called synchronously inside the click,
// which is the one thing every engine honors - resuming an AudioContext
// alone does not satisfy this gate.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'audio-strict-room', passphrase: 'strict policy' }));
await ctx.addInitScript(() => {
  let unlocked = false;
  document.addEventListener('pointerdown', () => { unlocked = true; }, { capture: true });
  document.addEventListener('keydown', () => { unlocked = true; }, { capture: true });
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (unlocked || this.muted) return nativePlay.call(this);
    return Promise.reject(new DOMException('simulated autoplay block', 'NotAllowedError'));
  };
});
const screen = await ctx.newPage();
trap(screen, 'audio-strict display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'audio-strict control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Waiting music"))');
await screen.waitForFunction(() => {
  const a = document.querySelector('.layer[data-role="program"] audio');
  return a && !a.paused && a.currentTime > 0.2;
}, null, { timeout: 5000 });
ok('under a strict simulated autoplay policy, the Go Live click alone unlocks Waiting Music', true);
await ctx.close();
}

console.log('\n-- audio self-heals on the next gesture if even the Go Live unlock fails --');
{
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'audio-selfheal-room', passphrase: 'self heal' }));
// A policy so strict even the Go Live silent-clip unlock fails - only
// lifted by a flag flipped manually well after Go Live, simulating "the
// unlock genuinely did not satisfy this engine."
await ctx.addInitScript(() => {
  window.__blockAll = true;
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!window.__blockAll) return nativePlay.call(this);
    return Promise.reject(new DOMException('simulated autoplay block', 'NotAllowedError'));
  };
});
const screen = await ctx.newPage();
trap(screen, 'audio-selfheal display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'audio-selfheal control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tile:has(.tile-title:text-is("Waiting music"))');
await screen.waitForTimeout(1000);
const blocked = await screen.evaluate(() => {
  const a = document.querySelector('.layer[data-role="program"] audio');
  return a ? { paused: a.paused, currentTime: a.currentTime } : null;
});
ok(`with everything blocked, Waiting Music sits paused rather than erroring (${JSON.stringify(blocked)})`, blocked && blocked.paused === true);

// Lift the simulated block and fire one unrelated interaction elsewhere on
// the display page - a keypress, nothing to do with audio.
await screen.evaluate(() => { window.__blockAll = false; });
await screen.keyboard.press('Escape');
await screen.waitForFunction(() => {
  const a = document.querySelector('.layer[data-role="program"] audio');
  return a && !a.paused && a.currentTime > 0.1;
}, null, { timeout: 3000 });
ok('one unrelated keypress afterward is enough to self-heal it - no need to find the "exit fullscreen" trick', true);
await ctx.close();
}

console.log('\n-- splitting the screen: B/C/D are direct and immediate, unlike A --');
{
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
await pad.fill('#text-body', 'Discuss in your groups');
await pad.$eval('#text-form', (f) => f.requestSubmit());
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

console.log('\n-- the ink layer covers the screen exactly, on a 2x display --');
{
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

console.log('\n-- version readouts, and a stale device that says so instead of looking like a bug --');
{
// The two ends are separate devices loading their own copy of the app from
// your server, so one can easily be running last week's code: a browser that
// never revalidated the page, or a machine whose projector tab has been open
// since before you deployed. That misbehaves in ways that read as fresh bugs
// - ink landing in the wrong place, say - and cost real debugging time twice
// before either end could just say so. Simulated the only way that matters:
// a context is served an older protocol.js, which is where BUILD lives.
const withProtocol = (ctx, rewrite) => ctx.route('**/assets/js/protocol.js', async (route) => {
  const res = await route.fetch();
  await route.fulfill({ response: res, body: rewrite(await res.text()) });
});
const roomCfg = (room) => JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room, passphrase: 'which build' });

async function pair(room, rewrite) {
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (rewrite) await withProtocol(dctx, rewrite);
  await dctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), roomCfg(room));
  const screen = await dctx.newPage();
  trap(screen, `${room} display`);
  await screen.goto(`${BASE}/display.html`);
  await screen.click('#arm-button');
  await screen.waitForSelector('#hud[data-status="online"]');
  const cctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  await cctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), roomCfg(room));
  const pad = await cctx.newPage();
  trap(pad, `${room} control`);
  await pad.goto(`${BASE}/control.html`);
  await pad.waitForSelector('.tile');
  return { screen, pad, close: async () => { await cctx.close(); await dctx.close(); } };
}
const settle = (pad, re) => pad.waitForFunction((src) => new RegExp(src).test(document.querySelector('#display-state')?.textContent || ''), re.source, { timeout: 10000 }).catch(() => {});

{
  const { screen, pad, close } = await pair('ver-match', null);
  await settle(pad, /build \d+/);
  const label = await pad.textContent('#display-state');
  ok(`the controller reads out the build next to the response time ("${label}")`, /Display connected.*build \d+/.test(label));
  ok('and does not cry wolf when they agree', !(await pad.$eval('#display-state', (n) => n.classList.contains('is-bad'))));
  ok('the display states its own build in Settings', /^\d+$/.test((await screen.textContent('#build-number')).trim()));
  await close();
}
{
  // The case the first version of this check stayed silent for: a display old
  // enough to report no build at all. Missing is not "fine", it is the oldest
  // answer there is.
  const { pad, close } = await pair('ver-none', (t) => t.replace(/export const BUILD = \d+;/, 'export const BUILD = undefined;'));
  await settle(pad, /older/);
  const label = await pad.textContent('#display-state');
  ok(`a display too old to report a build is still called out ("${label}")`, /older than build/.test(label));
  ok('and flagged as a problem', await pad.$eval('#display-state', (n) => n.classList.contains('is-bad')));
  await close();
}
{
  const { pad, close } = await pair('ver-old', (t) => t.replace(/export const BUILD = \d+;/, 'export const BUILD = 1;'));
  await settle(pad, /build 1/);
  const label = await pad.textContent('#display-state');
  ok(`it names both builds and which end to reload ("${label}")`, /Display is on build 1/.test(label) && /reload the display/i.test(label));
  await close();
}
{
  // The mirror image: this controller is the one behind. An integer build is
  // what makes that answerable rather than just "these differ".
  const { pad, close } = await pair('ver-new', (t) => t.replace(/export const BUILD = \d+;/, 'export const BUILD = 99;'));
  await settle(pad, /build 99/);
  const label = await pad.textContent('#display-state');
  ok(`it points at THIS device when this is the older one ("${label}")`, /reload THIS device/.test(label));
  await close();
}
{
  // And with no peer at all: a page notices on load that it is itself a copy
  // the server has already replaced, by re-reading protocol.js with no-store.
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  await ctx.route('**/assets/js/protocol.js', async (route) => {
    const res = await route.fetch();
    // Only the MODULE load is downgraded; the verification fetch sees current.
    if (route.request().resourceType() === 'script') {
      await route.fulfill({ response: res, body: (await res.text()).replace(/export const BUILD = \d+;/, 'export const BUILD = 1;') });
      return;
    }
    await route.fulfill({ response: res });
  });
  await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), roomCfg('ver-self'));
  const pad = await ctx.newPage();
  trap(pad, 'ver-self control');
  await pad.goto(`${BASE}/control.html`);
  await pad.waitForSelector('#update-banner:not([hidden])', { timeout: 10000 }).catch(() => {});
  const detail = await pad.textContent('#update-detail').catch(() => '');
  ok(`a cached page says so on load with no peer involved ("${detail}")`, /server is serving build/.test(detail));
  await ctx.close();
}
}

console.log('\nconsole/page errors: ' + (errors.length ? '\n  - ' + errors.join('\n  - ') : 'none'));
} finally {
  await browser?.close().catch(() => {});
  server.kill();
}
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length || errors.length ? 1 : 0);
