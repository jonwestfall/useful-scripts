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

import { spawn } from 'node:child_process';
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

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
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
  return program?.dataset.role === 'program' && document.querySelectorAll('.layer').length === 2;
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

console.log('\nconsole/page errors: ' + (errors.length ? '\n  - ' + errors.join('\n  - ') : 'none'));
} finally {
  await browser?.close().catch(() => {});
  server.kill();
}
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length || errors.length ? 1 : 0);
