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
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import zlib from 'node:zlib';
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

// The PNG-writing part shared by every fixture below: chunk framing and the
// CRC32 every chunk needs. `channels` is 3 for plain truecolour or 4 for
// truecolour+alpha; `fillPixel(x, y)` returns that many byte values.
function writePng(file, w, h, channels, fillPixel) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = Buffer.alloc((w * channels + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;                       // filter byte: none
    for (let x = 0; x < w; x++) {
      for (const v of fillPixel(x, y)) raw[o++] = v;
    }
  }
  let table = null;
  const crc32 = (buf) => {
    if (!table) {
      table = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
      }
    }
    let c = -1;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;   // 8-bit, truecolour(+alpha)
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// A real PNG, written with nothing but the standard library, big enough that
// the resize ladder a lecture plan puts photos through has something to do.
function writeImageFixture() {
  const file = path.join(HERE, 'fixtures', 'photo.png');
  if (fs.existsSync(file)) return file;
  const w = 1400, h = 900;
  writePng(file, w, h, 3, (x, y) => [Math.round(x * 255 / w), Math.round(y * 255 / h), 128]);
  return file;
}

// A PNG with real alpha: transparent everywhere except an opaque blue block
// in one corner, so a test can tell "the background survived as transparent"
// from "it got flattened to a black box", which is what plain JPEG
// re-encoding would do to a logo.
function writeAlphaImageFixture() {
  const file = path.join(HERE, 'fixtures', 'logo.png');
  if (fs.existsSync(file)) return file;
  const w = 200, h = 100;
  writePng(file, w, h, 4, (x, y) => {
    const opaque = x > w * 0.6 && y > h * 0.35 && y < h * 0.75;
    return [40, 90, 255, opaque ? 255 : 0];
  });
  return file;
}

// A 1.2-second tone: short enough to actually reach its own end inside a test
// timeout, for exercising what happens once a clip runs out rather than
// what happens while it is playing.
function writeShortFixture() {
  const file = path.join(HERE, 'fixtures', 'short-tone.wav');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return file;
  const rate = 8000;
  const seconds = 1.2;
  const samples = Math.round(rate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    data.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 440 * t)), i * 2);
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
writeShortFixture();

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

// Iterating on one section without sitting through the other thirty:
//
//   node podium/test/e2e.mjs --only ink        every section with "ink" in its name
//   node podium/test/e2e.mjs --only photos,camera
//
// A filtered run is a convenience, not the contract: the first few sections
// share one display and controller and later ones can lean on what an earlier
// one left on screen, so a section that passes alone can still fail in the
// full run. CI, and anything you are about to push, runs all of it.
const onlyArg = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
const only = String(onlyArg || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const skipped = [];
const want = (name) => {
  if (!only.length || only.some((needle) => name.toLowerCase().includes(needle))) return true;
  skipped.push(name);
  return false;
};
if (only.length) console.log(`(only sections matching: ${only.join(', ')})`);

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

// One test deliberately points the music player at a file that is not there, to
// prove the room is told why it went quiet. The browser's own 404 is the point
// of that test rather than a result, and naming the fixture keeps the allowance
// narrow enough that a real 404 anywhere else still counts.
//
// /api/login is the same shape of thing: a test types the wrong password on
// purpose, and the 401 it gets back - which the browser logs as a failed
// resource load - is the assertion, not a fault. Narrow on purpose: a 401 from
// any OTHER url is still a failure.
//
// The 415 is the third of these: a test uploads an .html file to prove the
// allow-list refuses it. Matched by its status text rather than by url,
// because that status has exactly one source - library.js turning down a file
// type - and an upload that broke for any other reason fails its assertion
// instead of quietly passing.
//
// favicon.ico is not deliberate in the same sense - nothing here is testing
// it - but it is not a result either: Podium serves no favicon by design (see
// "stays reachable with no credentials (404)" in the auth-gate section, which
// asserts exactly this response), and a browser fetching it unprompted on
// every fresh origin this suite signs into is standard behaviour, not
// something any page here caused. Narrowed to that one path so a real 404
// anywhere else - including a real 404 that happens to be ABOUT a favicon a
// test actually cares about - still fails its own assertion.
const DELIBERATE = /not-a-real-file|\/api\/login|415 \(Unsupported Media Type\)|404 \(Not Found\).*favicon\.ico/;

// A fourth deliberate case - a PATCH to /api/lectures/<id> forced to answer
// 403, to prove a rejected rename reverts the field rather than leaving it
// looking saved - does not fit DELIBERATE above: matching on status and path
// alone would also swallow a real forbidden GET, DELETE, or a sibling route
// like /api/lectures/<id>/files, /events or /polls (all contain the same
// "/api/lectures/<digits>" substring), hiding a genuine permission
// regression anywhere under that prefix for the rest of the suite. This flag
// is armed only for the duration of that one interception (see the rename
// test itself) so the allowance covers exactly the request it is testing.
let expectingLectureRenameForbidden = false;
// Anchored at the end (where = text + " " + url, so the url is always last):
// a sibling route always has more path after the id, which this cannot match.
const LECTURE_RENAME_FORBIDDEN = /403 \(Forbidden\).*\/api\/lectures\/\d+$/;

const trap = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = `${m.text()} ${m.location()?.url || ''}`;
    if (OFFLINE_NOISE.test(where) || DELIBERATE.test(where)) return;
    if (expectingLectureRenameForbidden && LECTURE_RENAME_FORBIDDEN.test(where)) return;
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

if (want('media')) {
console.log('\n-- media --');
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
// :not(#music) because the display also holds one hidden <audio> of its own
// for the background music, which is not a clip and is never torn down.
ok(`the clip it replaced was torn down (was at ${programBefore}s)`, await display.evaluate(()=>document.querySelectorAll('audio:not(#music)').length===1));

// Mute.
await control.click('#mute');
await display.waitForFunction(()=>document.querySelector('.layer[data-role="program"] audio').muted,null,{timeout:5000});
ok('mute reaches the display', true);

// A clip that runs out on its own used to be indistinguishable from one set
// to loop: nothing in `state` ever heard that it had ended, so the next
// broadcast for any unrelated reason called play() again. Using the short
// fixture here so the test can actually wait for that moment to arrive.
await control.fill('#url-input', `${BASE}/test/fixtures/short-tone.wav`);
await control.click('#url-form button[type=submit]');
await display.waitForFunction(()=>{const a=document.querySelector('.layer[data-role="program"] audio');return a && !a.paused && a.currentTime>0.1;},null,{timeout:5000});
await display.waitForFunction(()=>document.querySelector('.layer[data-role="program"] audio').paused,null,{timeout:5000});
ok('an unlooped clip stops on its own once it runs out', true);
await display.waitForTimeout(900);
ok('and stays stopped rather than restarting on the next thing that happens to broadcast',
  await display.evaluate(()=>document.querySelector('.layer[data-role="program"] audio').paused));
await control.click('.tab[data-tab="now"]');
await control.waitForFunction(()=>document.querySelector('#play-pause').textContent==='▶',null,{timeout:5000});
ok('the controller\'s own Play/Pause button agrees it stopped', true);

// Restart: back to zero AND actually playing again, not just seeked while
// still paused where a plain seek would have left it.
await control.click('#restart-media');
await display.waitForFunction(()=>{const a=document.querySelector('.layer[data-role="program"] audio');return a && !a.paused && a.currentTime<0.3;},null,{timeout:5000});
ok('Restart takes it back to the start and actually plays it, not just seeks a paused clip', true);

// Loop: opted into per item, off by default, and genuinely keeps it going
// past where it would otherwise have stopped.
await control.click('#media-loop');
await display.waitForFunction(()=>document.querySelector('.layer[data-role="program"] audio').loop===true,null,{timeout:5000});
await display.waitForTimeout(1900);
ok('with loop on, the same clip is still playing well past when it would have ended',
  await display.evaluate(()=>{const a=document.querySelector('.layer[data-role="program"] audio');return a && !a.paused;}));
}

if (want('marp decks')) {
console.log('\n-- marp decks --');
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

// A slide with more on it than a 1280x720 box holds used to lose its last
// bullets off the bottom edge, silently. Slide 9 of this deck is one of those.
await control.click('.tab[data-tab="slides"]');
await control.waitForFunction(() => document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cell').length === 13, null, { timeout: 30000 });
await control.evaluate(() => document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cell')[8].click());
await waitForSlide(8);
const fitted = await display.evaluate(() => {
  const sr = document.querySelector('.layer[data-role="program"] .r-deck').shadowRoot;
  const svg = sr.querySelector('svg.podium-on');
  const section = svg.querySelector('section');
  return {
    scale: Number(svg.dataset.podiumFit || 1),
    over: section.scrollHeight - section.clientHeight,
    // Shrinking must not change the slide's shape: ink is mapped onto it.
    aspect: (() => { const b = svg.getAttribute('viewBox').split(' ').map(Number); return b[2] / b[3]; })(),
  };
});
ok(`an over-full slide is shrunk to fit (to ${Math.round(fitted.scale * 100)}%)`, fitted.scale < 1 && fitted.scale >= 0.55);
ok('and then nothing runs off the bottom of it', fitted.over <= 1);
ok(`it is still the same shape, so ink still lands where it was drawn (${fitted.aspect.toFixed(3)})`,
  Math.abs(fitted.aspect - 16 / 9) < 0.002);
// Waited for rather than read: the controller learns which slide is up from
// the display's next heartbeat, so reading its readout the instant the
// projector changed is a race that fails about one run in ten.
await control.waitForFunction((want) => document.querySelector('#deck-count').textContent.includes(want),
  `fit ${Math.round(fitted.scale * 100)}%`, { timeout: 8000 })
  .then(() => ok('the controller says the slide was shrunk rather than leaving you guessing', true))
  .catch(async () => ok(`the controller says the slide was shrunk rather than leaving you guessing (said "${await control.textContent('#deck-count')}")`, false));
ok('and its thumbnail is shrunk by the same amount, so the two agree',
  await control.evaluate((want) => {
    const svg = document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cell svg')[8];
    return Number(svg.dataset.podiumFit || 1).toFixed(3) === want.toFixed(3);
  }, fitted.scale));
ok('a slide that already fits is left at the size its author chose',
  await display.evaluate(() => {
    const sr = document.querySelector('.layer[data-role="program"] .r-deck').shadowRoot;
    return [...sr.querySelectorAll('svg[data-marpit-svg]')].some((s) => !s.dataset.podiumFit);
  }));

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

if (want('telling the three kinds of silence apart')) {
console.log('\n-- telling the three kinds of silence apart --');
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

if (want('pairing overlay and clearing a device')) {
console.log('\n-- pairing overlay and clearing a device --');
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

if (want('Settings: Connection/Presentation tabs and the presentation preferences')) {
console.log('\n-- Settings: Connection/Presentation tabs and the presentation preferences --');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'settings-room', passphrase: 'tabbed settings' }));
// A page-level stub for the Wake Lock API: headless Chromium's own support for
// it is not something worth this test depending on - this just records what
// the page asked for, which is the part actually being tested.
await ctx.addInitScript(() => {
  window.__wakeLog = [];
  // navigator.wakeLock is a getter-only accessor on the real Navigator
  // prototype - a plain assignment silently no-ops and the real API (which
  // headless Chromium denies with "permission request denied" here) stays
  // in place, so this has to actually shadow the property.
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: {
    request: (type) => {
      window.__wakeLog.push(`request:${type}`);
      return Promise.resolve({ addEventListener() {}, release() { window.__wakeLog.push('release'); return Promise.resolve(); } });
    },
  } });
});

const screen = await ctx.newPage();
trap(screen, 'settings display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');

// Something is on screen before the controller under test ever connects, so
// blank-on-connect has something to actually prove - a display that starts
// black by default would make "it blanked" indistinguishable from "nothing
// happened".
const setupPad = await ctx.newPage();
trap(setupPad, 'settings pad (setup)');
await setupPad.goto(`${BASE}/control.html`);
await setupPad.waitForSelector('.tile');
await setupPad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));
await setupPad.click('.tab[data-tab="say"]');
await setupPad.fill('#text-body', 'Before the presenter arrives');
await setupPad.click('#text-form button[type=submit]');
await screen.waitForSelector('.layer[data-role="program"] .r-text', { timeout: 5000 });
await setupPad.close();

const pad = await ctx.newPage();
trap(pad, 'settings pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => window.__wakeLog?.length > 0, null, { timeout: 5000 });
ok('this device requests a wake lock on load - Keep this device\'s screen awake defaults on',
  (await pad.evaluate(() => window.__wakeLog)).includes('request:screen'));
await screen.waitForFunction(() => document.querySelector('#blank').classList.contains('is-on'), null, { timeout: 5000 });
ok('and blacks out the screen the moment it connects - Black out on connect defaults on too', true);

await pad.click('#open-settings');
await pad.waitForSelector('#setup:not([hidden])');
ok('Settings opens on the Connection tab', await pad.evaluate(() =>
  document.querySelector('.settings-tabs .tab[data-settings-tab="connection"]').classList.contains('is-on')
  && !document.querySelector('[data-settings-panel="connection"]').hidden
  && document.querySelector('[data-settings-panel="presentation"]').hidden));

await pad.click('.settings-tabs .tab[data-settings-tab="presentation"]');
ok('and switches to Presentation without disturbing the connection form underneath', await pad.evaluate(() =>
  !document.querySelector('[data-settings-panel="presentation"]').hidden
  && document.querySelector('[data-settings-panel="connection"]').hidden));
ok('all three presentation options default on',
  (await pad.isChecked('#pref-poll-url')) && (await pad.isChecked('#pref-blank-on-connect')) && (await pad.isChecked('#pref-keep-awake')));

await pad.uncheck('#pref-keep-awake');
await pad.waitForFunction(() => window.__wakeLog.includes('release'), null, { timeout: 5000 });
ok('unchecking Keep awake actually releases the lock, not just the checkbox', true);
await pad.check('#pref-keep-awake');
await pad.waitForFunction(() => window.__wakeLog.filter((s) => s === 'request:screen').length >= 2, null, { timeout: 5000 });
ok('and re-checking it requests a fresh one', true);

await pad.uncheck('#pref-poll-url');
ok('a preference is saved the moment it changes, with no Save button of its own',
  await pad.evaluate(() => JSON.parse(localStorage.getItem('podium.presentation.v1')).showPollUrl === false));

await pad.click('#setup-close');
await pad.waitForSelector('#app:not([hidden])', { timeout: 15000 });
await pad.waitForSelector('.tile', { timeout: 15000 });

await pad.click('.tab[data-tab="polls"]');
await pad.fill('#poll-question', 'Which bias is this?');
await pad.fill('#poll-options .poll-option-row:nth-child(1) input', 'Construct');
await pad.fill('#poll-options .poll-option-row:nth-child(2) input', 'Method');
await pad.click('#poll-start');
await pad.waitForFunction(() => !document.querySelector('#poll-running').hidden, null, { timeout: 8000 });
await screen.waitForFunction(() => document.querySelector('.r-poll-question')?.textContent === 'Which bias is this?', null, { timeout: 5000 });
ok('with Show voting URL off, the join card carries no URL text',
  await screen.evaluate(() => {
    const node = document.querySelector('.r-poll-url');
    return !node || node.hidden || !node.textContent;
  }));
ok('but the QR and the four-letter code are there regardless - only the URL is optional', await screen.evaluate(() =>
  !!document.querySelector('.r-poll-qr svg') && document.querySelector('.r-poll-code').textContent.length === 4));

await pad.click('#poll-end');
await pad.click('#poll-end');
await screen.waitForFunction(() => !document.querySelector('.r-poll'), null, { timeout: 5000 });

await pad.click('#open-settings');
await pad.click('.settings-tabs .tab[data-settings-tab="presentation"]');
await pad.check('#pref-poll-url');
await pad.click('#setup-close');
await pad.waitForSelector('#app:not([hidden])', { timeout: 15000 });
await pad.waitForSelector('.tile', { timeout: 15000 });

await pad.click('.tab[data-tab="polls"]');
await pad.fill('#poll-question', 'And now?');
await pad.fill('#poll-options .poll-option-row:nth-child(1) input', 'Yes');
await pad.fill('#poll-options .poll-option-row:nth-child(2) input', 'No');
await pad.click('#poll-start');
await pad.waitForFunction(() => !document.querySelector('#poll-running').hidden, null, { timeout: 8000 });
const code2 = (await pad.textContent('#poll-running-code')).trim();
await screen.waitForFunction(() => document.querySelector('.r-poll-question')?.textContent === 'And now?', null, { timeout: 5000 });
const urlShown = await screen.textContent('.r-poll-url');
ok(`with it back on, the join card spells out the actual URL under the QR (${urlShown})`,
  urlShown.includes(code2) && /^https?:\/\//.test(urlShown));

await ctx.close();
}

if (want('freeze protects what is on screen, never the audio')) {
console.log('\n-- freeze protects what is on screen, never the audio --');
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

if (want('the phone-camera tile in the library actually starts the camera')) {
console.log('\n-- the phone-camera tile in the library actually starts the camera --');
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

if (want('background music: heard, never seen')) {
console.log('\n-- background music: heard, never seen --');
{
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'music-room', passphrase: 'before class' }));
const screen = await ctx.newPage();
trap(screen, 'music display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'music pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

// What the display's own player is doing, which is the only thing that
// actually matters - the controller is a remote for it.
const music = () => screen.evaluate(() => {
  const el = document.querySelector('audio#music');
  return el ? { src: (el.currentSrc || '').split('/').pop(), paused: el.paused, vol: Math.round(el.volume * 100) / 100 } : null;
});

await pad.click('.tab[data-tab="music"]');
await pad.click('#music-load');
await screen.waitForFunction(() => {
  const el = document.querySelector('audio#music');
  return el && !el.paused && el.currentTime > 0;
}, null, { timeout: 15000 })
  .then(() => ok('loading a playlist plays it on the display', true))
  .catch(() => ok('loading a playlist plays it on the display', false));

ok('and the projector shows nothing at all for it', await screen.evaluate(() => {
  const el = document.querySelector('audio#music');
  return el.hidden && el.getBoundingClientRect().height === 0
    && !document.querySelector('.r-audio')
    && document.querySelector('.layer[data-role="program"]').textContent.trim() === '';
}));

// It arrives at a listenable level rather than at full volume.
const rampedUp = await screen.evaluate(() => new Promise((resolve) => {
  const el = document.querySelector('audio#music');
  const first = el.volume;
  setTimeout(() => resolve({ first, later: el.volume }), 1200);
}));
ok(`it fades in rather than banging on (${rampedUp.first.toFixed(2)} -> ${rampedUp.later.toFixed(2)})`,
  rampedUp.later > rampedUp.first);

// A clip with its own sound ducks it, and it comes back afterwards.
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Waiting music"))');
await screen.waitForSelector('.r-audio', { timeout: 15000 });
await pad.waitForTimeout(1800);
const ducked = (await music()).vol;
await pad.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await screen.waitForSelector('.r-whiteboard', { timeout: 10000 });
await pad.waitForTimeout(2200);
const recovered = (await music()).vol;
ok(`a clip with sound ducks the music to a whisper (${ducked})`, ducked > 0 && ducked < 0.2);
// At rest this is music.volume (0.6 by default) times the master fader
// (0.8 by default) - see the Mixer tab - so 0.5 is no longer a safe floor
// for "clearly recovered", only "clearly not still ducked or muted" is.
ok(`and it comes back up when the clip goes away (${recovered})`, recovered > 0.4);

// Teaching must not disturb it.
await pad.click('#freeze');
await pad.waitForTimeout(500);
await pad.click('#blank');
await pad.waitForTimeout(700);
const during = await music();
ok('freeze and blank leave the music alone', !during.paused && during.vol > 0.4);
await pad.click('#blank');
await pad.click('#freeze');

// Mute is the room's silence button, so it covers the music too.
await pad.click('#mute');
await pad.waitForTimeout(1200);
ok('Mute silences the music as well as the content', (await music()).vol < 0.02);
await pad.click('#mute');
await pad.waitForTimeout(1600);
ok('and unmuting brings it back', (await music()).vol > 0.4);

// The queue is shared state: a second controller sees it without asking.
await pad.click('.tab[data-tab="music"]');
await pad.fill('#music-url', 'content/audio/waiting-music.wav?second');
await pad.click('#music-url-form button[type="submit"]');
await pad.waitForFunction(() => document.querySelectorAll('.music-row').length === 2, null, { timeout: 8000 });
const phone = await ctx.newPage();
trap(phone, 'music phone');
await phone.goto(`${BASE}/control.html`);
await phone.waitForSelector('.tile');
await phone.click('.tab[data-tab="music"]');
await phone.waitForFunction(() => document.querySelectorAll('.music-row').length === 2, null, { timeout: 10000 })
  .then(() => ok('a second controller sees the same queue and the same track', true))
  .catch(() => ok('a second controller sees the same queue and the same track', false));

await pad.click('#music-next');
await screen.waitForFunction(() => (document.querySelector('audio#music').currentSrc || '').includes('second'), null, { timeout: 8000 })
  .then(() => ok('next moves the display to the next track', true))
  .catch(() => ok('next moves the display to the next track', false));

// A track running out advances by itself, and everyone follows.
await screen.waitForFunction(() => Number.isFinite(document.querySelector('audio#music').duration), null, { timeout: 15000 });
await screen.evaluate(() => {
  const el = document.querySelector('audio#music');
  el.currentTime = Math.max(0, el.duration - 0.25);
});
await pad.waitForFunction(() => document.querySelector('#music-sub').textContent.includes('1 of 2'), null, { timeout: 15000 })
  .then(() => ok('a track running out wraps to the next one on its own', true))
  .catch(() => ok('a track running out wraps to the next one on its own', false));

// The button for the moment class starts. Waited for first: a track change
// pauses the element for an instant while the next source loads, and
// measuring a fade that began there would time nothing at all.
await screen.waitForFunction(() => {
  const el = document.querySelector('audio#music');
  return el && !el.paused && el.currentTime > 0.3 && el.volume > 0.3;
}, null, { timeout: 15000 });

// A fade out you change your mind about, which is what happens when someone
// walks in late: Play has to catch the level on its way down and bring it
// back, rather than leave the track running at silence.
await pad.click('#music-fade');
await screen.waitForFunction(() => document.querySelector('audio#music').volume < 0.4, null, { timeout: 8000 });
await pad.click('#music-play');
// See the master-fader comment above: at rest this settles around 0.48
// (0.6 channel x 0.8 master) by default, not the old ~0.6.
await screen.waitForFunction(() => {
  const el = document.querySelector('audio#music');
  return !el.paused && el.volume > 0.4;
}, null, { timeout: 8000 })
  .then(() => ok('Play during a fade out catches the music and brings it back', true))
  .catch(() => ok('Play during a fade out catches the music and brings it back', false));

await pad.click('#music-fade');
const fade = await screen.evaluate(() => new Promise((resolve) => {
  const el = document.querySelector('audio#music');
  const start = el.volume;
  const began = Date.now();
  const poll = setInterval(() => {
    if (el.paused) { clearInterval(poll); resolve({ start, ms: Date.now() - began, end: el.volume }); }
    else if (Date.now() - began > 8000) { clearInterval(poll); resolve({ start, ms: -1, end: el.volume }); }
  }, 50);
}));
ok(`"fade out and stop" takes the room down gently rather than cutting it (${fade.ms}ms)`,
  fade.ms > 2200 && fade.ms < 4200 && fade.end < 0.05);
ok('and leaves the player paused, not silently running', (await music()).paused);

// A path that is not there is the likeliest first-night mistake, and music
// that simply never starts, with nothing said anywhere, is the worst possible
// answer to it: you stand there in a quiet room checking cables.
await pad.click('#music-clear');
await pad.fill('#music-url', 'content/audio/not-a-real-file.mp3');
await pad.click('#music-url-form button[type="submit"]');
await pad.waitForFunction(() => /would not load/.test(document.querySelector('#music-sub').textContent), null, { timeout: 10000 })
  .then(() => ok('a track that will not load says so instead of going quiet', true))
  .catch(() => ok('a track that will not load says so instead of going quiet', false));
ok('and says it in the warning colour, not as a grey hint',
  await pad.evaluate(() => document.querySelector('#music-sub').classList.contains('is-warning')));
await phone.waitForFunction(() => /would not load/.test(document.querySelector('#music-sub').textContent), null, { timeout: 8000 })
  .then(() => ok('every controller in the room hears about it', true))
  .catch(() => ok('every controller in the room hears about it', false));

// And the complaint clears itself once something does play, rather than
// haunting the panel for the rest of the class.
await pad.fill('#music-url', 'content/audio/waiting-music.wav?v=2#start');
await pad.click('#music-url-form button[type="submit"]');
await pad.click('#music-next');
await pad.waitForFunction(() => !/would not load/.test(document.querySelector('#music-sub').textContent), null, { timeout: 12000 })
  .then(() => ok('and the message clears itself when a track does play', true))
  .catch(() => ok('and the message clears itself when a track does play', false));
ok('a pasted link keeps its query string out of the track name',
  (await pad.$$eval('.music-row-title', (ns) => ns.map((n) => n.textContent))).every((t) => !/[?#]/.test(t)));

// And emptying the queue takes the complaint with it, rather than leaving it
// on the panel for the rest of the class.
await pad.click('#music-clear');
await pad.waitForFunction(() => document.querySelector('#music-title').textContent === 'Nothing queued', null, { timeout: 8000 });
ok('clearing the queue leaves no stale warning behind',
  !/would not load/.test(await pad.textContent('#music-sub')));

// Some audio is both things: a title card the room reads, and something
// that can play behind everything else without it. Same manifest entry,
// two doors in - the Library tile, and the Music tab's own quick row.
await pad.click('.tab[data-tab="library"]');
const waitingTile = pad.locator('.tile:has(.tile-title:text-is("Waiting music"))');
await waitingTile.locator('.tile-music').click();
await pad.waitForTimeout(500);
ok('Add to Music from the Library tile does not also stage it on the projector',
  await screen.evaluate(() => !document.querySelector('.r-audio')));
await pad.click('.tab[data-tab="music"]');
await pad.waitForFunction(() => document.querySelectorAll('.music-row').length === 1, null, { timeout: 8000 })
  .then(() => ok('and it lands in the background queue from there', true))
  .catch(() => ok('and it lands in the background queue from there', false));
ok('queued rather than already playing', await screen.evaluate(() => document.querySelector('audio#music').paused));

await pad.waitForSelector('.music-quick-chip');
ok('the Music tab also offers it as a quick-push button',
  /Waiting music/.test(await pad.textContent('.music-quick-chip')));
await pad.click('.music-quick-chip');
await screen.waitForFunction(() => {
  const el = document.querySelector('audio#music');
  return el && !el.paused && el.currentTime > 0;
}, null, { timeout: 10000 })
  .then(() => ok('tapping the quick-push chip plays it as background music', true))
  .catch(() => ok('tapping the quick-push chip plays it as background music', false));
ok('without duplicating the track it had already queued',
  (await pad.$$('.music-row')).length === 1);
await pad.waitForFunction(() => document.querySelector('.music-quick-chip').classList.contains('is-on'), null, { timeout: 8000 })
  .then(() => ok('and marks the chip as the one currently playing', true))
  .catch(() => ok('and marks the chip as the one currently playing', false));

// The same resource, picked the normal way, still works as a visual item -
// and does not interrupt what is now playing behind it.
await pad.click('.tab[data-tab="library"]');
await waitingTile.click();
await screen.waitForSelector('.r-audio', { timeout: 8000 })
  .then(() => ok('and the same manifest entry still works as an on-screen item', true))
  .catch(() => ok('and the same manifest entry still works as an on-screen item', false));
ok('with the background music undisturbed by it',
  await screen.evaluate(() => !document.querySelector('audio#music').paused));

// Standing down ends the lecture, and the room has to go quiet with it.
// Music that outlives the arming screen is a track with no control left on
// screen for it, playing to a room that thinks it has been dismissed.
await screen.keyboard.press('e');
await screen.waitForSelector('#arm:not([hidden])', { timeout: 8000 });
await screen.waitForFunction(() => document.querySelector('audio#music').paused, null, { timeout: 12000 })
  .then(() => ok('standing down stops the background music, rather than leaving it playing to an empty room', true))
  .catch(() => ok('standing down stops the background music, rather than leaving it playing to an empty room', false));
// And the controllers are told, so the Music tab does not still offer Pause
// for something that is no longer playing.
await pad.waitForFunction(() => !document.querySelector('.music-quick-chip')?.classList.contains('is-on'), null, { timeout: 8000 })
  .then(() => ok('and every controller is told it stopped', true))
  .catch(() => ok('and every controller is told it stopped', false));
// Background music is not the only thing that can still be sounding: the
// clip on the projector is audible too, and it kept playing behind the
// arming screen with no transport anywhere still pointing at it.
await screen.waitForFunction(
  () => [...document.querySelectorAll('audio:not(#music), video')].every((e) => e.paused),
  null, { timeout: 8000 })
  .then(() => ok('and the clip on the projector stops with it, not just the music', true))
  .catch(() => ok('and the clip on the projector stops with it, not just the music', false));

await ctx.close();
}
}

if (want('the audio mixer: three faders, one meaning each')) {
console.log('\n-- the audio mixer: three faders, one meaning each --');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'mixer-room', passphrase: 'two channels one master' }));
const screen = await ctx.newPage();
trap(screen, 'mixer display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'mixer pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

const setSlider = (page, sel, value) => page.evaluate(([s, v]) => {
  const input = document.querySelector(s);
  input.value = String(v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}, [sel, value]);

await pad.click('.tab[data-tab="mixer"]');
ok('the Mixer tab shows three separate faders', await pad.evaluate(() =>
  !!document.querySelector('#mixer-master') && !!document.querySelector('#mixer-content') && !!document.querySelector('#mixer-music')));

// Content channel: master and the channel's own level multiply together.
// #url-input lives on the Library tab, not the Mixer.
await pad.click('.tab[data-tab="library"]');
await pad.fill('#url-input', `${BASE}/test/fixtures/tone.wav`);
await pad.click('#url-form button[type=submit]');
await screen.waitForFunction(() => { const a = document.querySelector('.layer[data-role="program"] audio'); return a && !a.paused; }, null, { timeout: 8000 });
await pad.click('.tab[data-tab="mixer"]');
await setSlider(pad, '#mixer-master', 0.5);
await setSlider(pad, '#mixer-content', 0.4);
await screen.waitForFunction(() => Math.abs(document.querySelector('.layer[data-role="program"] audio').volume - 0.2) < 0.01, null, { timeout: 5000 });
ok('master (0.5) and the content channel (0.4) multiply, not replace each other (-> 0.2)', true);
await setSlider(pad, '#mixer-content', 1);
await screen.waitForFunction(() => Math.abs(document.querySelector('.layer[data-role="program"] audio').volume - 0.5) < 0.01, null, { timeout: 5000 });
ok('the content channel back at full just leaves the master showing through (-> 0.5)', true);

// Restore the master before touching the music channel, so ducking (which
// reads the actual element volume, not the fader position) is not fighting
// an unrelated master change at the same time.
await setSlider(pad, '#mixer-master', 1);

// Music channel: same relationship, read off the display's own <audio id="music">
// rather than the panel's, and with nothing else sounding so there is no
// ducking factor to also account for.
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await screen.waitForFunction(() => !document.querySelector('.layer[data-role="program"] audio'), null, { timeout: 5000 });
await pad.click('.tab[data-tab="music"]');
await pad.click('#music-load');
await screen.waitForFunction(() => { const el = document.querySelector('audio#music'); return el && !el.paused && el.currentTime > 0; }, null, { timeout: 15000 });
await pad.waitForTimeout(1500);   // past the fade-in, onto a settled level
await pad.click('.tab[data-tab="mixer"]');
await setSlider(pad, '#mixer-master', 0.5);
await setSlider(pad, '#mixer-music', 0.6);
await screen.waitForFunction(() => Math.abs(document.querySelector('audio#music').volume - 0.3) < 0.02, null, { timeout: 5000 });
ok('the master reaches the music channel too, at the same relationship (0.5 x 0.6 -> 0.3)', true);

// Muting silences both channels together, wherever their own faders sit.
await pad.click('#mute');
await screen.waitForFunction(() => document.querySelector('audio#music').volume < 0.01, null, { timeout: 5000 });
ok('mute silences the music channel regardless of its own fader', true);
await pad.click('#mute');

await ctx.close();
}

if (want('stills from the camera, one per panel')) {
console.log('\n-- stills from the camera, one per panel --');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['camera'] });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'still-room', passphrase: 'freeze a frame' }));
const screen = await ctx.newPage();
trap(screen, 'stills display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const phone = await ctx.newPage();
trap(phone, 'stills phone');
await phone.goto(`${BASE}/control.html`);
await phone.waitForSelector('.tile');
await phone.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await phone.click('.tab[data-tab="camera"]');
ok('there is nothing to photograph before the camera is on', await phone.isDisabled('#cam-shot'));
await phone.click('#cam-start');
await phone.waitForFunction(() => document.querySelector('#cam-local')?.videoWidth > 0, null, { timeout: 20000 });
await phone.waitForFunction(() => !document.querySelector('#cam-shot').disabled, null, { timeout: 10000 });

await phone.click('#cam-shot');
await phone.waitForSelector('#cam-shots .shot', { timeout: 10000 });
ok('taking a photo puts a still in the strip', true);
const thumb = await phone.evaluate(() => document.querySelector('#cam-shots .shot img').src.slice(0, 15));
ok('the thumbnail is the frame itself, not a placeholder', thumb === 'data:image/jpeg');

await phone.click('#cam-shots .shot');
await screen.waitForFunction(() => !!document.querySelector('.layer[data-role="program"] .r-image'), null, { timeout: 15000 });
const shown = await screen.evaluate(() => {
  const img = document.querySelector('.layer[data-role="program"] .r-image');
  return { data: img.src.startsWith('data:image/jpeg'), w: img.naturalWidth, h: img.naturalHeight };
});
ok(`a still reaches the projector as an ordinary photo (${shown.w}x${shown.h})`, shown.data && shown.w > 100);

// The point of the feature: four frames caught from one camera, up at once.
await phone.click('.layout-btn[data-layout="4"]');
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-4'), null, { timeout: 8000 });
for (const panel of [1, 2, 3]) {
  await phone.click(`.panel-btn:nth-child(${panel + 1})`);
  await phone.waitForTimeout(400);
  await phone.click('#cam-shot');
  await phone.waitForFunction((n) => document.querySelectorAll('#cam-shots .shot').length === n, panel + 1, { timeout: 10000 });
  // Newest first, so the one just taken is the first in the strip.
  await phone.click('#cam-shots .shot');
  await screen.waitForTimeout(700);
}
const filled = await screen.evaluate(() => {
  const slots = [...document.querySelectorAll('.panel-slot.is-on')];
  return { panels: slots.length, photos: slots.filter((s) => s.querySelector('.r-image')).length,
    distinct: new Set(slots.map((s) => s.querySelector('.r-image')?.src)).size };
});
ok('four stills from one camera sit in four panels at once', filled.panels === 4 && filled.photos === 4);
ok(`and they are four different frames, not four copies of one (${filled.distinct})`, filled.distinct === 4);
const badges = await phone.evaluate(() => [...document.querySelectorAll('#cam-shots .shot')].map((s) => s.querySelector('.shot-where')?.textContent || '-'));
ok(`the strip says which panel each photo is in (${badges.join(' ')})`, badges.join(',') === 'D,C,B,A');

// Each still is its own ink surface, so annotating one does not mark the rest.
const surfaces = await phone.evaluate(() => [...document.querySelectorAll('#cam-shots .shot img')].map((i) => i.src.length));
ok('each still is a distinct item rather than one shared photo', new Set(surfaces).size > 1);

// Stopping the camera is not throwing the photos away.
await phone.click('#cam-start');
await phone.waitForFunction(() => document.querySelector('#cam-status').textContent === 'Off', null, { timeout: 10000 });
ok('the photos outlive the camera feed they came from', (await phone.$$('#cam-shots .shot')).length === 4);
ok('and the projector still holds all four', (await screen.evaluate(() => document.querySelectorAll('.panel-slot.is-on .r-image').length)) === 4);

await phone.click('#cam-shots .shot .shot-del');
await phone.waitForFunction(() => document.querySelectorAll('#cam-shots .shot').length === 3, null, { timeout: 5000 });
ok('discarding a thumbnail tidies the strip', true);
ok('without pulling what the class is looking at off the screen',
  (await screen.evaluate(() => document.querySelectorAll('.panel-slot.is-on .r-image').length)) === 4);
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

if (want('freezing a camera holds its current frame')) {
console.log('\n-- freezing a camera holds its current frame --');
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

if (want('Slides tab: a Now/Next confidence monitor, Markup, and a laser pointer')) {
console.log('\n-- Slides tab: a Now/Next confidence monitor, Markup, and a laser pointer --');
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

// Hiding the cue bar gives the Now/Next boxes more room, and remembers the
// choice per device rather than resetting on every visit.
const widthBefore = await pad.$eval('#deck-now-preview', (n) => n.getBoundingClientRect().width);
ok('the cue bar is visible by default', await pad.isVisible('#preview-pane'));
await pad.click('#preview-toggle');
ok('hiding it removes it from the layout', !(await pad.isVisible('#preview-pane')));
const widthAfter = await pad.$eval('#deck-now-preview', (n) => n.getBoundingClientRect().width);
ok(`the Now/Next boxes actually get the extra room (${Math.round(widthBefore)} -> ${Math.round(widthAfter)})`, widthAfter > widthBefore);
await pad.reload();
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));
ok('the choice survives a reload of the controller', !(await pad.isVisible('#preview-pane')));
await pad.click('#preview-toggle');
ok('and toggling it back shows it again', await pad.isVisible('#preview-pane'));

// The Now/Next split cycles 50/50 -> 75/25 -> 25/75 -> back, and remembers
// the choice the same way the cue-bar visibility does.
await pad.click('.tab[data-tab="slides"]');
ok('the split starts even', await pad.evaluate(() => document.querySelector('.confidence-row').dataset.split === 'even'));
const widthsAt = async () => pad.evaluate(() => {
  const [now, next] = document.querySelectorAll('.confidence-box');
  return { now: now.getBoundingClientRect().width, next: next.getBoundingClientRect().width };
});
const evenWidths = await widthsAt();
await pad.click('#confidence-split');
ok('one tap leans it toward Now', await pad.evaluate(() => document.querySelector('.confidence-row').dataset.split === 'now'));
const nowWidths = await widthsAt();
ok(`and Now is actually wider than Next now (${Math.round(nowWidths.now)} vs ${Math.round(nowWidths.next)})`,
  nowWidths.now > evenWidths.now && nowWidths.now > nowWidths.next);
await pad.click('#confidence-split');
ok('a second tap leans it toward Next instead', await pad.evaluate(() => document.querySelector('.confidence-row').dataset.split === 'next'));
const nextWidths = await widthsAt();
ok(`and Next is actually wider than Now now (${Math.round(nextWidths.next)} vs ${Math.round(nextWidths.now)})`,
  nextWidths.next > evenWidths.next && nextWidths.next > nextWidths.now);
await pad.click('#confidence-split');
ok('a third tap cycles back to even', await pad.evaluate(() => document.querySelector('.confidence-row').dataset.split === 'even'));
await pad.click('#confidence-split');
await pad.reload();
await pad.waitForSelector('.tile');
await pad.click('.tab[data-tab="slides"]');
ok('and a non-default split choice survives a reload too', await pad.evaluate(() => document.querySelector('.confidence-row').dataset.split === 'now'));

// The "Jump to a slide" grid: a caption under each thumbnail (the thumbnail
// alone reads as a smear of colour at ~140px, and its only other label was a
// hover tooltip - nothing on a touchscreen), and a filter to find one by
// title without scrolling past a dozen near-identical rectangles.
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence"))');
await pad.waitForFunction(() => document.querySelector('#deck-grid')?.shadowRoot?.querySelectorAll('.cell').length === 13, null, { timeout: 20000 });
await pad.click('.tab[data-tab="slides"]');
const captions = await pad.evaluate(() => Array.from(document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cap')).map((c) => c.textContent));
ok(`every thumbnail carries a readable caption, not just a hover tooltip (${captions.length})`,
  captions.length === 13 && captions.every((c) => c.length > 0) && captions[4].toLowerCase().includes('calibration'));

// buildGrid() moves each slide's real <svg> into the grid rather than
// rasterizing a copy, so it depends on the exact same Marp DOM polyfill
// renderDeck() already needs for foreignObject content to lay out
// correctly - missing here, a heading rendered at its full, unscaled size
// spills out of the thumbnail instead of shrinking to fit it. Chromium (all
// this suite ever runs against) does not actually exhibit that bug, so this
// cannot reproduce it the way it shows up on WebKit - it only guards against
// a future regression in the bound it can check: nothing about to draw
// outside its own thumbnail.
const heading = await pad.evaluate(() => {
  const cell = document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cell')[1];
  const thumb = cell.querySelector('.thumb').getBoundingClientRect();
  const h = cell.querySelector('h1, h2, h3')?.getBoundingClientRect();
  return h ? { thumb, h } : null;
});
ok(`a slide's heading renders inside its own thumbnail, not spilling past it (heading ${Math.round(heading?.h.width)}x${Math.round(heading?.h.height)} in a ${Math.round(heading?.thumb.width)}x${Math.round(heading?.thumb.height)} box)`,
  !!heading
  && heading.h.left >= heading.thumb.left - 1 && heading.h.top >= heading.thumb.top - 1
  && heading.h.right <= heading.thumb.right + 1 && heading.h.bottom <= heading.thumb.bottom + 1);

await pad.fill('#deck-grid-filter', 'calibration');
await pad.waitForTimeout(150);
const visible = await pad.evaluate(() => Array.from(document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cell')).filter((c) => !c.hidden).map((c) => c.dataset.search));
ok(`filtering by title shows only the matching slides (${JSON.stringify(visible)})`,
  visible.length === 2 && visible.every((s) => s.includes('calibration')));
ok('the empty-state note stays hidden while something matches', await pad.isHidden('#deck-grid-empty'));

await pad.fill('#deck-grid-filter', 'xyzzy nothing matches this');
await pad.waitForTimeout(150);
ok('and a filter matching nothing hides every thumbnail rather than showing them all',
  (await pad.evaluate(() => Array.from(document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cell')).every((c) => c.hidden))));
ok('with a note saying so', await pad.isVisible('#deck-grid-empty'));

await pad.fill('#deck-grid-filter', '');
await pad.waitForTimeout(150);
ok('clearing the filter brings every slide back', (await pad.evaluate(() => Array.from(document.querySelector('#deck-grid').shadowRoot.querySelectorAll('.cell')).every((c) => !c.hidden))));

await ctx.close();
}

if (want('waiting music actually plays')) {
console.log('\n-- waiting music actually plays --');
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

if (want('Waiting Music under a strict (Safari-like) autoplay policy')) {
console.log('\n-- Waiting Music under a strict (Safari-like) autoplay policy --');
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

if (want('audio self-heals on the next gesture if even the Go Live unlock fails')) {
console.log('\n-- audio self-heals on the next gesture if even the Go Live unlock fails --');
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

if (want('version readouts, and a stale device that says so instead of looking like a bug')) {
console.log('\n-- version readouts, and a stale device that says so instead of looking like a bug --');
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

if (want('a relay that will not come up says which relay, and why')) {
console.log('\n-- a relay that will not come up says which relay, and why --');
// "Lost the relay - retrying." was the whole of what a failing connection told
// you: not which URL, not what the browser objected to, not how long it had
// been trying. Two of the three ways this fails could not even get that far -
// they rejected out of createBus, and because both pages use top-level await,
// an unhandled rejection there ABORTS THE REST OF THE MODULE. The display then
// never called render() and the controller never loaded its library: a page
// that looks hung, for what is really a one-line configuration problem.
const dead = await freePort();           // nothing is listening on it, by construction
const relayCfg = (extra) => JSON.stringify({
  transport: 'ws', room: 'no-relay', passphrase: 'x', ...extra,
});

// A page is only "alive" if the module ran past its top-level await: on the
// display that means render() built the program layer, on the controller that
// means the library finished loading.
async function openScreen(cfg, route) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (route) await route(ctx);
  await ctx.addInitScript((c) => localStorage.setItem('podium.config.v2', c), cfg);
  const page = await ctx.newPage();
  const crashes = [];
  page.on('pageerror', (e) => crashes.push(e.message));
  await page.goto(`${BASE}/display.html`);
  return { page, crashes, close: () => ctx.close() };
}
const said = (page, re) => page.waitForFunction(
  (src) => new RegExp(src).test(document.querySelector('#arm-status')?.textContent || ''),
  re.source, { timeout: 20000 }).catch(() => {});
const alive = (page) => page.$$eval('.layer[data-role="program"]', (n) => n.length > 0);

{
  // The socket that never opens. Every cause - closed port, no relay running,
  // a TLS certificate this browser does not trust - arrives as close code 1006
  // with an empty reason, so the message has to enumerate them.
  const { page, crashes, close } = await openScreen(relayCfg({ wsUrl: `ws://127.0.0.1:${dead}/podium` }));
  await said(page, /could not open/);
  const status = (await page.textContent('#arm-status')).trim();
  ok(`a dead relay names the URL it could not open ("${status.slice(0, 90)}…")`,
    /could not open/.test(status) && status.includes(`127.0.0.1:${dead}`));
  ok('and the close code, so a refusal is distinguishable from a timeout', /code 1006/.test(status));
  const log = await page.$eval('.relay-log', (n) => ({ hidden: n.hidden, text: n.textContent }));
  ok('and keeps a timestamped log of the attempts instead of only the last one',
    !log.hidden && /\d·|\d:\d/.test(log.text) && /error/.test(log.text));
  const target = await page.$eval('.relay-target', (n) => n.textContent);
  ok(`and states outright what it is dialling ("${target}")`,
    /Self-hosted WebSocket/.test(target) && target.includes(String(dead)) && /room no-relay/.test(target));
  ok('no unhandled rejection', crashes.length === 0);
  await close();
}

{
  // A relay URL that is not a URL. This one throws before any socket exists.
  const { page, crashes, close } = await openScreen(relayCfg({ wsUrl: 'my-vps.example/podium' }));
  await said(page, /not a URL/);
  const status = (await page.textContent('#arm-status')).trim();
  ok(`a URL with no scheme is named as such, not reported as a network fault ("${status.slice(0, 90)}…")`,
    /is not a URL/.test(status) && /wss:\/\//.test(status));
  ok('and the rest of the page still came up rather than dying at the top-level await', await alive(page));
  ok('no unhandled rejection', crashes.length === 0);
  await close();
}

{
  // The transport adapter's own CDN blocked - the first thing a locked-down
  // campus network does. Nothing here is the app's fault and nothing here used
  // to be reported at all: the import rejected and took the module with it.
  const { page, crashes, close } = await openScreen(
    relayCfg({ transport: 'mqtt', mqttUrl: 'wss://broker.example:8084/mqtt' }),
    (ctx) => ctx.route('https://cdn.jsdelivr.net/**', (route) => route.abort()),
  );
  await said(page, /Could not load/);
  const status = (await page.textContent('#arm-status')).trim();
  ok(`a blocked CDN says what could not be fetched, and which transport needs none ("${status.slice(0, 90)}…")`,
    /Could not load the MQTT client from cdn\.jsdelivr\.net/.test(status) && /Self-hosted WebSocket needs no CDN/.test(status));
  ok('and the page is still alive to be reconfigured', await alive(page));
  ok('no unhandled rejection', crashes.length === 0);
  await close();
}

{
  // mqtt:// is the classic: it is the scheme every broker's own docs use, and
  // a browser cannot speak it. Caught before the client library is even loaded.
  const { page, close } = await openScreen(relayCfg({ transport: 'mqtt', mqttUrl: 'mqtt://broker.example:1883' }));
  await said(page, /WebSocket/);
  const status = (await page.textContent('#arm-status')).trim();
  ok(`a broker URL a browser cannot dial explains why, and shows the shape that works ("${status.slice(0, 90)}…")`,
    /only speak MQTT over a WebSocket/.test(status) && /wss:\/\/broker\.emqx\.io:8084\/mqtt/.test(status));
  await close();
}

{
  // The controller side of the same cliff: a throwing connect() used to leave
  // the library unloaded, so the presenter got an empty frame and no reason.
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const crashes = [];
  await ctx.addInitScript((c) => localStorage.setItem('podium.config.v2', c), relayCfg({ wsUrl: 'my-vps.example/podium' }));
  const pad = await ctx.newPage();
  pad.on('pageerror', (e) => crashes.push(e.message));
  await pad.goto(`${BASE}/control.html`);
  await pad.waitForSelector('#relay-help:not([hidden])', { timeout: 20000 }).catch(() => {});
  const why = (await pad.textContent('#relay-help-why')).trim();
  ok(`the controller explains the relay failure in a banner ("${why.slice(0, 80)}…")`, /is not a URL/.test(why));
  await pad.waitForSelector('.tile', { timeout: 20000 }).catch(() => {});
  ok('and its library still loaded, so it is usable as soon as the URL is fixed',
    (await pad.$$('.tile')).length > 0);
  ok('no unhandled rejection', crashes.length === 0);
  await ctx.close();
}

{
  // And the regression that made all of this harder to read: a stale build was
  // announced on the RELAY's channel, so a page running old code claimed
  // "Cannot reach the relay" while the relay was perfectly fine.
  const { page, close } = await openScreen(
    JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'stale-not-offline', passphrase: 'x' }),
    (ctx) => ctx.route('**/assets/js/protocol.js', async (route) => {
      const res = await route.fetch();
      if (route.request().resourceType() === 'script') {
        await route.fulfill({ response: res, body: (await res.text()).replace(/export const BUILD = \d+;/, 'export const BUILD = 1;') });
        return;
      }
      await route.fulfill({ response: res });
    }),
  );
  await page.waitForSelector('#hud[data-status="online"]', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#arm-build:not([hidden])', { timeout: 15000 }).catch(() => {});
  const build = (await page.textContent('#arm-build')).trim();
  const status = (await page.textContent('#arm-status')).trim();
  ok(`a stale page says it is stale, on its own line ("${build}")`, /build 1 but the server has \d+/.test(build));
  ok(`and does not blame the relay for it ("${status}")`, !/Cannot reach|Lost the relay/.test(status));
  await close();
}
}

if (want('planning in the office, teaching from the plan')) {
console.log('\n-- planning in the office, teaching from the plan --');
// The Saved library lives in localStorage, which never leaves the device that
// wrote it - so a lecture built on a desktop would be invisible on the tablet
// you actually teach from. A plan is therefore a file you carry, and it has to
// be self-contained: the checks that matter are that an uploaded photo and an
// uploaded deck, neither of which exists anywhere on the server, still reach
// the projector after the plan has been through a file and a second device.
const photoFile = writeImageFixture();
const deckFile = path.join(HERE, '..', 'content', 'decks', 'day06-evidence-weighting.md');
const planFile = path.join(HERE, 'fixtures', 'e2e-plan.podium.json');
const roomCfg = JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'planning', passphrase: 'office' });

// --- the office ---
const office = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const desk = await office.newPage();
trap(desk, 'plan');
await desk.goto(`${BASE}/plan.html`);
await desk.waitForSelector('#type-picker .type-btn');
ok('the planning page offers every type the projector can show',
  (await desk.$$('#type-picker .type-btn')).length === (await desk.evaluate(async () => Object.keys((await import('./assets/js/planfile.js')).PLAN_TYPES).length)));

await desk.fill('#plan-title', 'Day 6 — Evidence');
await desk.click('#type-picker .type-btn:has-text("Text sign")');
await desk.fill('#item-fields textarea', 'Welcome');
await desk.fill('#item-fields input[type=text]', 'Title card');
const previewText = await desk.textContent('#item-preview');
ok(`the preview is the projector's own renderer, not a mock-up ("${previewText.trim()}")`, /Welcome/.test(previewText));

await desk.click('#type-picker .type-btn:has-text("Photo")');
await desk.setInputFiles('#item-fields input[type=file]', photoFile);
await desk.waitForFunction(() => /after resizing/.test(document.body.textContent), null, { timeout: 20000 });
// The page autosaves on a debounce, so wait for the write before reading it back.
const settled = () => desk.waitForFunction(() => /^Saved/.test(document.querySelector('#save-state').textContent), null, { timeout: 15000 });
await settled();
const shrunk = await desk.evaluate(async () => {
  const rows = await (await import('./assets/js/store.js')).allPlans();
  const plan = rows.find((r) => r.title === 'Day 6 — Evidence') || rows[0];
  const asset = Object.values(plan.assets)[0];
  return { bytes: asset.data.length, jpeg: asset.data.startsWith('data:image/jpeg') };
});
const cap = await desk.evaluate(async () => (await import('./assets/js/planfile.js')).MAX_ASSET_CHARS);
ok(`a 1400x900 photo is re-encoded small enough to survive one hop over the relay (${(shrunk.bytes / 1024).toFixed(0)} KB, cap ${(cap / 1024).toFixed(0)} KB)`,
  shrunk.jpeg && shrunk.bytes <= cap);

await desk.click('#type-picker .type-btn:has-text("Marp deck")');
await desk.setInputFiles('#item-fields input[type=file]', deckFile);
await desk.waitForFunction(() => /Slide 1 of/.test(document.querySelector('#deck-where')?.textContent || ''), null, { timeout: 20000 });
ok(`an uploaded deck names itself from its front matter ("${await desk.textContent('#order .order-row:nth-child(3) .order-title')}")`,
  /Weighing the Evidence/.test(await desk.textContent('#order .order-row:nth-child(3) .order-title')));
ok(`and its slides can be stepped through here, before class ("${await desk.textContent('#deck-where')}")`,
  /Slide 1 of 13/.test(await desk.textContent('#deck-where')));
await desk.click('#deck-next');
await desk.waitForFunction(() => /Slide 2 of/.test(document.querySelector('#deck-where')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
ok('the stepper moves', /Slide 2 of 13/.test(await desk.textContent('#deck-where')));

// Reordering, which is the whole point of a running order.
await desk.click('#order .order-row:nth-child(3) [title="Move up"]');
ok('an item can be moved up the running order',
  /Weighing the Evidence/.test(await desk.textContent('#order .order-row:nth-child(2) .order-title')));
await desk.click('#order .order-row:nth-child(2) [title="Move down"]');
ok('and back down', /Weighing the Evidence/.test(await desk.textContent('#order .order-row:nth-child(3) .order-title')));

await desk.fill('#item-fields textarea:last-of-type', 'ask about the confound');
await desk.fill('#timer-new-label', 'Group work');
await desk.fill('#timer-new-mins', '8');
await desk.click('#timer-add');
await desk.waitForFunction(() => /Saved/.test(document.querySelector('#save-state').textContent), null, { timeout: 10000 });
ok('the page autosaves rather than making you find a Save button', true);

await settled();
const planJson = await desk.evaluate(async () => {
  const file = await import('./assets/js/planfile.js');
  const store = await import('./assets/js/store.js');
  const rows = await store.allPlans();
  return file.planToJson(rows.find((r) => r.title === 'Day 6 — Evidence') || rows[0]);
});
fs.writeFileSync(planFile, planJson);
ok(`the plan writes as one self-contained file (${(planJson.length / 1024).toFixed(0)} KB, photo and slides inside it)`,
  planJson.includes('data:image/jpeg') && planJson.includes('Weighing the Evidence'));

// It really is reloadable from disk on this machine too.
const desk2 = await office.newPage();
trap(desk2, 'plan reopen');
await desk2.goto(`${BASE}/plan.html`);
await desk2.waitForSelector('#order .order-row');
ok('reopening the planning page finds the lecture where you left it',
  (await desk2.$$('#order .order-row')).length === 3 && (await desk2.inputValue('#plan-title')) === 'Day 6 — Evidence');
await office.close();

// --- the classroom ---
const room = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await room.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), roomCfg);
const screen = await room.newPage();
trap(screen, 'planning display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');

const tablet = await browser.newContext({ viewport: { width: 1024, height: 768 } });
await tablet.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), roomCfg);
const pad = await tablet.newPage();
trap(pad, 'planning control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.setInputFiles('#plan-file', planFile);
// The Library always has a group heading ("Quick"), so wait for the PLAN's.
await pad.waitForFunction(() => document.querySelector('#library h3.group')?.textContent === 'Day 6 — Evidence', null, { timeout: 20000 });
const groupNames = await pad.$$eval('#library h3.group', (n) => n.map((x) => x.textContent));
ok(`the plan's own group leads the Library ("${groupNames[0]}")`, groupNames[0] === 'Day 6 — Evidence');
ok('in the order you put them in, numbered',
  (await pad.$$eval('#library .tile-order', (n) => n.map((x) => x.textContent))).slice(0, 3).join() === '1,2,3');
ok(`the note you wrote in the office rides along ("${await pad.textContent('#library .tile-note')}")`,
  /confound/.test(await pad.textContent('#library .tile-note')));
ok(`and the plan is named in the top bar ("${await pad.textContent('#plan-name')}")`,
  /Day 6/.test(await pad.textContent('#plan-name')));

// The photo: it exists nowhere on the server, so the projector can only be
// showing it if the controller handed it over the encrypted bus.
await pad.click('#library .tile:nth-child(2)');
await pad.waitForTimeout(1200);
const onWall = await screen.evaluate(() => {
  const img = document.querySelector('.layer[data-role="program"] img');
  return img ? { kind: img.src.slice(0, 16), w: img.naturalWidth, h: img.naturalHeight } : null;
});
ok(`a photo that was never on the server reaches the projector (${onWall?.kind}…, ${onWall?.w}x${onWall?.h})`,
  !!onWall && onWall.kind.startsWith('data:image/') && onWall.w > 100 && onWall.h > 100);

// ...while the item that refers to it stays small. That item lives in `state`,
// which is rebroadcast twice a second and is what ink surfaces are keyed by, so
// a data URL inline would bloat every heartbeat and every stored stroke. Ink
// keys are the visible proof: draw on the photo and read the key back off the
// display, where ink is saved.
await pad.click('.tab[data-tab="ink"]');
const padBox = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await pad.mouse.move(padBox.x + padBox.w * 0.4, padBox.y + padBox.h * 0.4);
await pad.mouse.down();
await pad.mouse.move(padBox.x + padBox.w * 0.6, padBox.y + padBox.h * 0.6, { steps: 8 });
await pad.mouse.up();
await pad.waitForTimeout(2200);   // the display saves ink on a trailing debounce
const inkKeys = await screen.evaluate(() => {
  const raw = localStorage.getItem(`podium.ink.${JSON.parse(localStorage.getItem('podium.config.v2')).room}`);
  return Object.keys(JSON.parse(raw || '{}'));
});
const photoKey = inkKeys.find((k) => k.startsWith('image:'));
ok(`ink on that photo is keyed by the reference, not the bytes ("${photoKey}")`,
  !!photoKey && photoKey.startsWith('image:asset:') && photoKey.length < 60);
await pad.click('.tab[data-tab="library"]');

// The deck: same story, markdown rather than pixels.
await pad.click('#library .tile:nth-child(3)');
await pad.waitForTimeout(2500);
const deckOnWall = await screen.evaluate(() => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  if (!host) return null;
  return {
    slides: host.shadowRoot.querySelectorAll('svg[data-marpit-svg]').length,
    showing: !!host.shadowRoot.querySelector('svg.podium-on'),
    status: host.shadowRoot.getElementById('status')?.textContent || '',
  };
});
ok(`a deck carried inside the plan renders on the projector (${deckOnWall?.slides} slides)`,
  deckOnWall?.slides === 13 && deckOnWall.showing && deckOnWall.status === '');

await pad.click('.tab[data-tab="timer"]');
ok(`the plan's saved timers replace the stock presets ("${(await pad.$$eval('#timer-presets .timer-preset', (n) => n.map((x) => x.textContent))).join(', ')}")`,
  (await pad.$$eval('#timer-presets .timer-preset', (n) => n.map((x) => x.textContent))).join() === 'Group work · 8m');

// A tablet gets locked and reopened mid-lecture. Losing the running order at
// that moment would be the worst possible time for it.
await pad.reload();
await pad.waitForSelector('#library h3.group', { timeout: 20000 });
ok('the plan survives a reload of the tablet',
  (await pad.$$eval('#library h3.group', (n) => n.map((x) => x.textContent)))[0] === 'Day 6 — Evidence');

await pad.click('.tab[data-tab="library"]');
await pad.click('#plan-clear');
await pad.waitForFunction(() => document.querySelector('#library h3.group')?.textContent === 'Quick', { timeout: 10000 }).catch(() => {});
ok('removing the plan puts the Library back to this device\u2019s own items',
  (await pad.$$eval('#library h3.group', (n) => n.map((x) => x.textContent)))[0] === 'Quick');
await pad.click('.tab[data-tab="timer"]');
ok('and the stock timer presets come back',
  (await pad.$$eval('#timer-presets .timer-preset', (n) => n.map((x) => x.textContent))).join() === '1m,2m,5m,10m,15m');

// A file that is not a plan must say so rather than half-loading.
fs.writeFileSync(path.join(HERE, 'fixtures', 'not-a-plan.json'), '{"hello":"world"}');
await pad.click('.tab[data-tab="library"]');
await pad.setInputFiles('#plan-file', path.join(HERE, 'fixtures', 'not-a-plan.json'));
await pad.waitForFunction(() => /did not load/.test(document.querySelector('#plan-note').textContent), null, { timeout: 10000 }).catch(() => {});
ok(`a file that is not a plan is refused by name ("${await pad.textContent('#plan-note')}")`,
  /not a Podium lecture plan/.test(await pad.textContent('#plan-note')));

await tablet.close();
await room.close();
}

if (want('more than one clock, and a laser you can pick the colour of')) {
console.log('\n-- more than one clock, and a laser you can pick the colour of --');
const roomCfg = JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'clocks', passphrase: 'tick' });
const room = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await room.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), roomCfg);
const screen = await room.newPage();
trap(screen, 'clocks display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');

const tablet = await browser.newContext({ viewport: { width: 1100, height: 860 } });
await tablet.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), roomCfg);
const pad = await tablet.newPage();
trap(pad, 'clocks control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');

// --- timers ---------------------------------------------------------------
// A class runs more than one clock: eight minutes of group work inside the
// session, a five-minute break with its own end. They have to be independent,
// and you have to be able to see both.
const chips = () => pad.$$eval('.timer-chip', (n) => n.map((x) => x.textContent.trim()));
await pad.click('.tab[data-tab="timer"]');
ok(`a room starts with one unnamed countdown, so "the timer" needs no setting up ("${(await chips())[0]}")`,
  (await chips()).length === 1);

await pad.fill('#timer-label', 'Group work');
await pad.fill('#timer-mins', '8');
await pad.click('#timer-start');
await pad.fill('#timer-label', 'Break');
await pad.fill('#timer-mins', '2');
await pad.click('#timer-add');
await pad.waitForFunction(() => document.querySelectorAll('.timer-chip').length === 2, null, { timeout: 10000 });
await pad.click('#timer-start');
await pad.waitForTimeout(1400);
const both = await chips();
ok(`both clocks are on screen at once, each with its own name and time ("${both.join('", "')}")`,
  both.length === 2 && /Group work7:5/.test(both[0]) && /Break1:5/.test(both[1]));
ok('and they run independently, not as one clock shown twice',
  both[0] !== both[1]);

// Two panels, two different countdowns - which is the point of having more
// than one, and is why a timer item carries the id of the clock it shows.
await pad.click('#timer-show');
await pad.click('.layout-btn[data-layout="2h"]');
await pad.waitForTimeout(300);
await pad.click('.panel-btn:nth-child(2)');
await pad.click('.timer-chip:nth-child(1)');
await pad.click('#timer-show');
await pad.waitForTimeout(900);
const onWall = await screen.$$eval('.r-timer', (nodes) => nodes.map((n) => ({
  label: n.querySelector('.r-timer-label').textContent,
  value: n.querySelector('.r-timer-value').textContent,
})));
ok(`the projector shows two different countdowns side by side (${onWall.map((t) => `${t.label} ${t.value}`).join(' | ')})`,
  onWall.length === 2 && onWall[0].label === 'Break' && onWall[1].label === 'Group work'
  && onWall[0].value !== onWall[1].value);

await pad.click('.timer-chip:nth-child(1)');
ok('the first countdown offers no Remove - it is what everything with no id falls back to',
  await pad.$eval('#timer-remove', (n) => n.hidden));
await pad.click('.timer-chip:nth-child(2)');
ok('...while a later one does', await pad.$eval('#timer-remove', (n) => !n.hidden));
await pad.click('#timer-remove');
await pad.waitForFunction(() => document.querySelectorAll('.timer-chip').length === 1, null, { timeout: 10000 }).catch(() => {});
ok('a countdown can be removed once you are done with it', (await chips()).length === 1);

// --- laser colour ---------------------------------------------------------
// Red disappears into a dark slide or a photograph, which is most of a
// psychology deck.
await pad.click('.layout-btn[data-layout="single"]');
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence"))');
await pad.waitForTimeout(2500);
await pad.click('.tab[data-tab="slides"]');
await pad.waitForSelector('#deck-live:not([hidden])');
ok('three colours to choose from', (await pad.$$('.laser-swatch')).length === 3);

await pad.click('.laser-swatch[data-color="green"]');
await pad.click('#deck-laser');
const frame = await pad.$eval('#deck-now-preview .mirror-frame', (n) => {
  const r = n.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await pad.mouse.move(frame.x + frame.w * 0.5, frame.y + frame.h * 0.5);
await pad.mouse.down();
await pad.mouse.move(frame.x + frame.w * 0.6, frame.y + frame.h * 0.55, { steps: 4 });
await pad.waitForTimeout(400);
const dot = await screen.evaluate(() => {
  const n = document.querySelector('#laser');
  return { on: n.classList.contains('is-on'), color: n.dataset.color, paint: getComputedStyle(n).backgroundImage };
});
ok(`the projector's dot really is the colour you picked (${dot.color})`,
  dot.on && dot.color === 'green' && /rgba?\(60, ?235, ?120/.test(dot.paint));
ok('and the dot on the controller matches it, so you are aiming with the same thing',
  (await pad.$eval('.laser-dot', (n) => n.dataset.color)) === 'green');
await pad.mouse.up();

await pad.click('.laser-swatch[data-color="blue"]');
await pad.reload();
await pad.waitForSelector('.tile');
ok('the choice is remembered - whoever needs green today needs it all term',
  (await pad.$eval('.laser-swatch.is-on', (n) => n.dataset.color)) === 'blue');

// Switching back mid-lecture has to actually reach the projector, not leave
// the last colour stuck on the wall.
await pad.click('.tab[data-tab="slides"]');
await pad.waitForSelector('#deck-live:not([hidden])');
await pad.click('.laser-swatch[data-color="red"]');
await pad.click('#deck-laser');
await pad.mouse.move(frame.x + frame.w * 0.4, frame.y + frame.h * 0.4);
await pad.mouse.down();
await pad.mouse.move(frame.x + frame.w * 0.45, frame.y + frame.h * 0.45, { steps: 4 });
await pad.waitForTimeout(400);
const back = await screen.$eval('#laser', (n) => n.dataset.color);
await pad.mouse.up();
ok(`changing colour again reaches the projector rather than sticking ("${back}")`, back === 'red');

await tablet.close();
await room.close();
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

if (want('getting back to where you were, and an app that survives the Wi-Fi')) {
console.log('\n-- getting back to where you were, and an app that survives the Wi-Fi --');
const roomCfg = JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'recover', passphrase: 'back' });
const room = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await room.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), roomCfg);
const screen = await room.newPage();
trap(screen, 'recover display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');

const tablet = await browser.newContext({ viewport: { width: 1100, height: 900 } });
await tablet.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), roomCfg);
const pad = await tablet.newPage();
trap(pad, 'recover control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');

// --- blank and freeze, on something without pages --------------------------
// Both used to sit behind a "is this paged content" guard, so B did nothing on
// a photo or a video - exactly when you reach for it.
await pad.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await pad.waitForTimeout(700);
await pad.keyboard.press('b');
await pad.waitForTimeout(400);
ok('B blanks the screen even when what is on it has no pages',
  await screen.$eval('#blank', (n) => n.classList.contains('is-on')));
await pad.keyboard.press('b');
await pad.waitForTimeout(300);
await pad.keyboard.press('f');
await pad.waitForTimeout(400);
ok('and F freezes it', await screen.evaluate(() => document.body.classList.contains('is-frozen')));
await pad.keyboard.press('f');
await pad.waitForTimeout(300);

// --- clearing the board is survivable --------------------------------------
const onWall = () => screen.evaluate(() => {
  const cv = document.querySelector('#ink');
  const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 10) n++;
  return n;
});
await pad.click('.tab[data-tab="ink"]');
const box = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await pad.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.3);
await pad.mouse.down();
await pad.mouse.move(box.x + box.w * 0.8, box.y + box.h * 0.7, { steps: 14 });
await pad.mouse.up();
await pad.waitForTimeout(700);
const drawn = await onWall();
ok(`there is ink on the projector to lose (${drawn} px)`, drawn > 500);
await pad.click('#ink-clear');
await pad.waitForTimeout(600);
ok('Clear wipes it in one tap, as it should - this is a frequent, deliberate move',
  (await onWall()) === 0 && !(await pad.$eval('#ink-unclear', (n) => n.hidden)));
await pad.click('#ink-unclear');
await pad.waitForTimeout(800);
ok(`and an accidental one is recoverable: Undo clear puts every stroke back (${await onWall()} px)`,
  Math.abs((await onWall()) - drawn) < 40);

// --- back to where you were ------------------------------------------------
// A deck picked from the Library always stages at slide 0, so an interruption
// used to restart the lecture in front of everyone.
const slideOnWall = () => screen.evaluate(() => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  if (!host?.shadowRoot) return -1;
  return Array.from(host.shadowRoot.querySelectorAll('svg[data-marpit-svg]'))
    .findIndex((svg) => svg.classList.contains('podium-on'));
});
await pad.click('.tab[data-tab="library"]');
ok('nothing to go back to before you have been anywhere', await pad.$eval('#recent-bar', (n) => n.hidden));
await pad.click('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence"))');
await pad.waitForTimeout(3200);
await pad.click('.tab[data-tab="slides"]');
await pad.waitForSelector('#deck-live:not([hidden])');
for (let i = 0; i < 4; i++) { await pad.click('#deck-next'); await pad.waitForTimeout(420); }
ok(`walked into the deck (slide ${(await slideOnWall()) + 1})`, (await slideOnWall()) === 4);

await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Back in 5"))');
await pad.waitForTimeout(900);
const chip = await pad.$eval('.recent-chip', (n) => n.textContent);
ok(`the deck is offered back, at the slide you left it ("${chip}")`, /slide 5 of 13/.test(chip));
await pad.click('.recent-chip');
await pad.waitForTimeout(3200);
ok(`and one tap returns to that exact slide, not slide 1 (slide ${(await slideOnWall()) + 1})`,
  (await slideOnWall()) === 4);
ok('what is on screen is not offered as somewhere to go back to',
  !(await pad.$$eval('.recent-chip', (n) => n.map((x) => x.textContent))).some((t) => /Weighing/.test(t)));

// --- the display survives a reload -----------------------------------------
// It holds the only authoritative copy of the lecture; an accidental refresh
// on the classroom PC used to drop the whole thing to black.
await screen.reload();
await screen.waitForSelector('#arm:not([hidden])');
const resumeNote = (await screen.textContent('#arm-resume-what')).trim();
ok(`the arming screen says what it is coming back to ("${resumeNote}")`, /Weighing the Evidence/.test(resumeNote));

// The room's own reset, offered right there rather than only reachable by
// waiting out the room's usual 12-hour staleness window - this is for a
// different class about to use the same room, not a crash to recover from.
await screen.click('#arm-fresh-session');
ok('clearing the room hides the "coming back to" banner', await screen.$eval('#arm-resume', (n) => n.hidden));
ok('and says so', /Cleared/.test(await screen.textContent('#arm-fresh-session-note')));
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
await screen.waitForTimeout(1500);
ok('going live after clearing starts black, not on the slide it was on', (await slideOnWall()) === -1);

await screen.reload();
await screen.waitForSelector('#arm:not([hidden])');
ok('a second reload has nothing left to offer coming back to either - the clear really persisted',
  await screen.$eval('#arm-resume', (n) => n.hidden));
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');

// --- the offline shell ------------------------------------------------------
const shell = await pad.evaluate(async () => {
  const link = document.querySelector('link[rel=manifest]');
  const res = await fetch(link.href);
  const body = await res.json();
  const icon = await fetch(document.querySelector('link[rel=apple-touch-icon]').href);
  return {
    type: res.headers.get('content-type'),
    start: body.start_url,
    display: body.display,
    icons: body.icons.length,
    maskable: body.icons.some((i) => i.purpose === 'maskable'),
    iconOk: icon.ok && icon.headers.get('content-type') === 'image/png',
    theme: document.querySelector('meta[name=theme-color]')?.content,
  };
});
ok(`the controller is installable: a manifest served as ${shell.type?.split(';')[0]}, ${shell.icons} icons, display ${shell.display}`,
  shell.type?.startsWith('application/manifest+json') && shell.display === 'standalone'
  && shell.start === 'control.html' && shell.icons >= 3 && shell.maskable);
ok('with a real PNG for the iOS home screen, and a theme colour',
  shell.iconOk && shell.theme === '#0b0d10');

await pad.waitForFunction(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return !!reg?.active;
}, null, { timeout: 15000 }).catch(() => {});
const cachedCount = await pad.evaluate(async () => {
  const cache = await caches.open('podium-shell');
  return (await cache.keys()).length;
});
ok(`and an offline shell warmed on the FIRST visit (${cachedCount} files), not the second`, cachedCount > 20);

await tablet.setOffline(true);
await pad.reload().catch(() => {});
await pad.waitForTimeout(1500);
ok('so the controller still opens with no network at all',
  await pad.evaluate(() => !!document.querySelector('.topbar') && document.querySelectorAll('.tab').length > 3));
ok(`and says plainly that the relay is what is missing ("${(await pad.$eval('#status', (n) => n.textContent)).slice(0, 44)}…")`,
  /could not open|Reconnecting|Relay problem/.test(await pad.$eval('#status', (n) => n.textContent)));
await tablet.setOffline(false);

await tablet.close();
await room.close();
}

if (want('the display\'s own keyboard')) {
console.log('\n-- the display\'s own keyboard --');
// Everything here happens on the classroom PC, which in a real room has no
// browser chrome to fall back on.
const c = await browser.newContext();
await c.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'keys-room', passphrase: 'pw' }));
const screen2 = await c.newPage();
trap(screen2, 'keys display');

// Prove the fullscreen request is made inside the click itself. Safari grants
// it only while the gesture is still current, so a single `await` before the
// call - which is how it regressed - loses fullscreen on every Mac while
// leaving Chrome working perfectly.
await screen2.addInitScript(() => {
  window.__fsCalls = [];
  const real = Element.prototype.requestFullscreen;
  Element.prototype.requestFullscreen = function patched(...args) {
    // window.event is set only while an event is actually being dispatched,
    // which is precisely the window Safari grants fullscreen in. An `await`
    // anywhere before the call - the regression - lands here with it unset,
    // because the click's dispatch finished long before the continuation ran.
    window.__fsCalls.push(window.event?.type || null);
    return real.apply(this, args);
  };
});
await screen2.goto(`${BASE}/display.html`);
await screen2.waitForSelector('#arm:not([hidden])');

await screen2.keyboard.press('?');
await screen2.waitForFunction(() => !document.querySelector('#keys').hidden, null, { timeout: 5000 });
ok('? brings up the shortcut card', true);
ok('and it lists the way out', (await screen2.textContent('#keys')).includes('Go live screen'));
await screen2.keyboard.press('Escape');
await screen2.waitForFunction(() => document.querySelector('#keys').hidden, null, { timeout: 5000 });
ok('Esc puts it away', true);

await screen2.click('#arm-button');
await screen2.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
ok('Go live really does go fullscreen', true);
const fsCalls = await screen2.evaluate(() => window.__fsCalls);
ok(`and asks for it inside the click itself, which is the only thing Safari accepts (${JSON.stringify(fsCalls)})`,
  fsCalls.length === 1 && fsCalls[0] === 'click');

await screen2.keyboard.press('f');
await screen2.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5000 });
ok('f drops out of fullscreen', true);
await screen2.keyboard.press('f');
await screen2.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
ok('and f puts it back', true);

await screen2.keyboard.press('e');
await screen2.waitForFunction(() => !document.fullscreenElement && !document.querySelector('#arm').hidden, null, { timeout: 5000 });
ok('e leaves fullscreen and comes back to the Go live screen', true);

// A room or passphrase with an e, f, p or s in it must not fire any of these.
await screen2.keyboard.press('s');
await screen2.waitForSelector('#setup:not([hidden])');
await screen2.click('#d-room');
await screen2.type('#d-room', 'seminar-f');
ok('and the same keys typed into Settings are just text',
  (await screen2.inputValue('#d-room')).endsWith('seminar-f')
  && await screen2.isHidden('#pair') && await screen2.isHidden('#keys'));

// G is a second door onto the same goLive() as the button - a fresh page,
// because the one above has already left the arm screen behind.
const screen3 = await c.newPage();
trap(screen3, 'keys display (G)');
await screen3.addInitScript(() => {
  window.__fsCalls = [];
  const real = Element.prototype.requestFullscreen;
  Element.prototype.requestFullscreen = function patched(...args) {
    window.__fsCalls.push(window.event?.type || null);
    return real.apply(this, args);
  };
});
await screen3.goto(`${BASE}/display.html`);
await screen3.waitForSelector('#arm:not([hidden])');
ok('the shortcut card mentions it', (await screen3.evaluate(() => {
  document.querySelector('#keys').hidden = false;
  const text = document.querySelector('#keys').textContent;
  document.querySelector('#keys').hidden = true;
  return text;
})).includes('Go live'));

await screen3.keyboard.press('g');
await screen3.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5000 });
ok('G goes live, the same as the button', await screen3.evaluate(() => document.querySelector('#arm').hidden));
const fsCallsG = await screen3.evaluate(() => window.__fsCalls);
ok(`asking for fullscreen inside the keypress itself, not after an await (${JSON.stringify(fsCallsG)})`,
  fsCallsG.length === 1 && fsCallsG[0] === 'keydown');

// Once live, G has nothing left to do - pressing it again must not re-request
// fullscreen or re-run the wake lock/audio unlock for no reason.
await screen3.keyboard.press('g');
await screen3.waitForTimeout(400);
ok('and does nothing once the room is already live',
  (await screen3.evaluate(() => window.__fsCalls)).length === 1);
await c.close();
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

if (want('uploading a photo from the device rather than a URL')) {
console.log('\n-- uploading a photo from the device rather than a URL --');
const ctx = await browser.newContext();
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'photo-upload-room', passphrase: 'the meme I wanted' }));
const screen = await ctx.newPage();
trap(screen, 'upload display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'upload pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.setInputFiles('#photo-upload', writeImageFixture());
await screen.waitForFunction(() => {
  const img = document.querySelector('.layer[data-role="program"] img');
  return img && img.complete && img.naturalWidth > 1;
}, null, { timeout: 10000 })
  .then(() => ok('a photo picked from Files/Camera Roll goes live on the display', true))
  .catch(() => ok('a photo picked from Files/Camera Roll goes live on the display', false));

await ctx.close();
}

if (want('a countdown to the end of the track')) {
console.log('\n-- a countdown to the end of the track --');
const ctx = await browser.newContext();
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'trackend-room', passphrase: 'we begin in' }));
const screen = await ctx.newPage();
trap(screen, 'trackend display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'trackend pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tab[data-tab="music"]');
ok('the button is disabled with nothing queued', await pad.evaluate(() => document.querySelector('#music-countdown').disabled));
await pad.click('#music-load');
await screen.waitForFunction(() => {
  const el = document.querySelector('audio#music');
  return el && !el.paused && Number.isFinite(el.duration) && el.duration > 0;
}, null, { timeout: 15000 });
ok('and enabled once something is', !(await pad.evaluate(() => document.querySelector('#music-countdown').disabled)));

await pad.click('#music-countdown');
await screen.waitForSelector('.r-timer', { timeout: 8000 });
ok('shows "We begin in..." by default, not a blank label', /We begin in/.test(await screen.textContent('.r-timer-label')));

// Nudge the track close to its end and watch the number follow it down, then
// pause - freezing musicNow - so the remaining checks are not racing a track
// that is a few seconds from wrapping to the next one (or the same one again).
await screen.evaluate(() => { document.querySelector('audio#music').currentTime = Math.max(0, document.querySelector('audio#music').duration - 6); });
await pad.waitForTimeout(600);
const near = await screen.textContent('.r-timer-value');
ok(`counts down the actual track position, not a fixed number (${near})`, /^0:0[0-6]$/.test(near));
ok('and turns urgent under 30 seconds left, the same as an ordinary timer',
  await screen.evaluate(() => document.querySelector('.r-timer').classList.contains('is-urgent')));
await pad.click('#music-play');
await screen.waitForFunction(() => document.querySelector('audio#music').paused, null, { timeout: 5000 });
const frozen = await screen.textContent('.r-timer-value');

// The controller's own preview has no <audio> of its own, so it has to be
// reading the broadcast musicNow rather than measuring anything locally.
await pad.click('.tab[data-tab="now"]');
await pad.waitForSelector('.r-timer', { timeout: 8000 });
ok(`a controller previews the same real countdown, from musicNow (${frozen})`, (await pad.textContent('.r-timer-value')) === frozen);
await ctx.close();
}

if (want('automated sets: a rotation that runs itself')) {
console.log('\n-- automated sets: a rotation that runs itself --');
const ctx = await browser.newContext();
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'sets-room', passphrase: 'we begin in twenty seconds' }));
const screen = await ctx.newPage();
trap(screen, 'sets display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'sets pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

// Building one: every Library tap goes into the draft instead of going live.
await pad.click('.tab[data-tab="sets"]');
await pad.click('#sets-new');
await pad.fill('#sets-build-name', 'Throwaway');
await pad.click('#sets-build-add');
ok('Add items switches to the Library tab', await pad.evaluate(() => document.querySelector('.tab[data-tab="library"]').classList.contains('is-on')));
await pad.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await pad.click('.tile:has(.tile-title:text-is("Chalkboard"))');
await screen.waitForTimeout(400);
ok('nothing goes live while building', await screen.evaluate(() => !document.querySelector('.r-whiteboard')));

// A live camera is declined rather than added broken (see the /code-review
// note in control.js: it never gets the async WebRTC setup pick() normally
// gives it, so it would sit there forever unresolved).
await pad.click('.tile:has(.tile-title:text-is("Phone camera"))');
await pad.click('.tab[data-tab="sets"]');
ok('a live camera is declined, not added broken', (await pad.$$('#sets-build-entries .set-row')).length === 2);

// Tapping a whole deck tile (as opposed to one specific slide pulled from
// Recent) fetches it and adds every one of its slides as its own entry - the
// actual class complaint was "I could only add individual slides, not a
// whole deck".
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence"))');
await pad.waitForFunction(() => document.querySelector('#sets-add-note')?.textContent.includes('Added all 13 slides'), null, { timeout: 15000 });
await pad.click('.tab[data-tab="sets"]');
ok('the whole deck landed as 13 separate entries', (await pad.$$('#sets-build-entries .set-row')).length === 2 + 13);
ok('each entry is its own slide of the deck, in order', await pad.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('#sets-build-entries .set-row .set-row-title'));
  const deckRows = rows.slice(2).map((r) => r.textContent);
  return deckRows.length === 13 && deckRows[0].includes('Weighing the Evidence') && deckRows[0] !== deckRows[12];
}));
await pad.click('#sets-build-cancel');
ok('cancelling the throwaway draft discards it', !/Throwaway/.test(await pad.textContent('#sets-list')));

// Now build the set the rest of this section actually exercises.
await pad.click('#sets-new');
await pad.fill('#sets-build-name', 'Pre-show');
await pad.click('#sets-build-add');
await pad.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await pad.click('.tile:has(.tile-title:text-is("Chalkboard"))');
await pad.click('.tab[data-tab="sets"]');
ok('the real draft starts clean with just the two tiles picked for it', (await pad.$$('#sets-build-entries .set-row')).length === 2);

const secInputs = await pad.$$('#sets-build-entries .set-row-secs');
await secInputs[0].fill('2'); await secInputs[0].dispatchEvent('change');
await secInputs[1].fill('3'); await secInputs[1].dispatchEvent('change');
await pad.click('#sets-build-save');
ok('saving closes the builder and lists it', await pad.isHidden('#sets-build') && /Pre-show/.test(await pad.textContent('#sets-list')));

// Start it on Panel A - staged like any other item.
await pad.click('.set-saved-row:has(.set-saved-title:text-is("Pre-show")) .set-start-btn:text-is("A")');
await screen.waitForSelector('.r-whiteboard', { timeout: 8000 });
ok('starting it puts the first entry up', true);

const firstBg = await screen.evaluate(() => document.querySelector('.r-whiteboard')?.style.background);
await pad.waitForTimeout(3500);
const secondBg = await screen.evaluate(() => document.querySelector('.r-whiteboard')?.style.background);
ok('it advances itself on schedule, with no controller action', firstBg !== secondBg);

// The running-set remote: jump, pause, resume. These specifically exercise
// a real bug found while building this - the buttons were built once and
// closed over that render's `item`, which state replacement (a fresh object
// every broadcast) made stale after the very next heartbeat.
await pad.click('.tab[data-tab="sets"]');
await pad.waitForSelector('#set-now-title', { timeout: 8000 });
await pad.click('#set-now-next');
await screen.waitForTimeout(500);
const thirdBg = await screen.evaluate(() => document.querySelector('.r-whiteboard')?.style.background);
ok('Next jumps forward too, not just the auto-advance', thirdBg !== secondBg);

await pad.click('#set-now-pause');
await pad.waitForFunction(() => /paused/.test(document.querySelector('#set-now-title').textContent), null, { timeout: 5000 });
ok('Pause freezes the readout', true);
ok('and flips the button to a play glyph', (await pad.textContent('#set-now-pause')) === '▶');
const heldBg = await screen.evaluate(() => document.querySelector('.r-whiteboard')?.style.background);
await pad.waitForTimeout(3500);
ok('and genuinely holds - no auto-advance while paused',
  (await screen.evaluate(() => document.querySelector('.r-whiteboard')?.style.background)) === heldBg);
await pad.click('#set-now-pause');
await pad.waitForFunction(() => !/paused/.test(document.querySelector('#set-now-title').textContent), null, { timeout: 5000 });
ok('pressing it again resumes', true);

// The same saved set can run independently on a second pane at once.
await pad.click('.tab[data-tab="library"]');
await pad.click('.layout-btn[data-layout="2h"]');
await pad.click('.tab[data-tab="sets"]');
await pad.click('.set-saved-row:has(.set-saved-title:text-is("Pre-show")) .set-start-btn:text-is("B")');
await screen.waitForFunction(() => document.querySelectorAll('.panel-slot.is-on').length === 2, null, { timeout: 8000 });
ok('the same saved set can run on a second pane too, independently', true);

// Editing, reordering, and deleting a saved set.
await pad.click('.set-saved-row:has(.set-saved-title:text-is("Pre-show")) button:text-is("Edit")');
await pad.click('#sets-build-entries .set-row:nth-child(2) .set-row-del');
ok('editing a saved set and removing an entry drops it to one', (await pad.$$('#sets-build-entries .set-row')).length === 1);
await pad.click('#sets-build-cancel');
ok('cancel leaves the saved set exactly as it was (still two entries)', /2 items/.test(await pad.textContent('#sets-list')));
await pad.click('.set-saved-row:has(.set-saved-title:text-is("Pre-show")) button:text-is("Delete")');
ok('Delete removes it from the saved list', !/Pre-show/.test(await pad.textContent('#sets-list')));
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

if (want('audience polls: a room full of phones answering')) {
console.log('\n-- audience polls: a room full of phones answering --');
// The relay is the only part of Podium that ever sees an answer in the clear,
// so this drives its endpoints directly, and drives join.html in real browser
// contexts - one per student, because a "student" here is really just a
// separate localStorage, which is what one answer each is keyed by.
const created = await fetch(`${BASE}/poll`, { method: 'POST' }).then((r) => r.json());
ok(`the relay hands back a code and a host token (${created.code})`,
  /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(created.code) && created.token?.length >= 20);

const host = (path, init = {}) => fetch(`${BASE}/poll/${created.code}${path}`, {
  ...init,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}`, ...(init.headers || {}) },
});
const results = () => host('/results').then((r) => r.json());

const ask = (body) => host('', { method: 'PUT', body: JSON.stringify(body) });
await ask({ kind: 'choice', question: 'Which bias is this?', open: true,
  options: ['Construct', 'Method', 'Norming', 'Access'] });

// Three phones. Separate contexts: same browser, different storage, which is
// exactly the distinction "one answer each" rests on.
const phones = [];
for (let i = 0; i < 3; i++) {
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();
  trap(phone, `student ${i + 1}`);
  await phone.goto(`${BASE}/join.html?c=${created.code}`);
  await phone.waitForFunction(() => document.querySelectorAll('.choice').length === 4, null, { timeout: 8000 });
  phones.push({ ctx: phoneCtx, page: phone });
}
ok('a QR link drops a phone straight onto the question, no code to type',
  (await phones[0].page.textContent('#question')) === 'Which bias is this?');
ok('and the options arrive with it', (await phones[0].page.textContent('.choice:nth-child(3)')).includes('Norming'));

await phones[0].page.click('.choice:nth-child(3)');
await phones[1].page.click('.choice:nth-child(3)');
await phones[2].page.click('.choice:nth-child(1)');
await phones[0].page.waitForFunction(() => /Answer sent/.test(document.querySelector('#note')?.textContent || ''), null, { timeout: 5000 });
let tally = await results();
ok(`three phones, three answers, counted where they were meant to go (${JSON.stringify(tally.counts)})`,
  tally.voters === 3 && tally.counts[2] === 2 && tally.counts[0] === 1);
ok('and the phone that answered shows which one it picked',
  await phones[0].page.evaluate(() => document.querySelector('.choice:nth-child(3)')?.getAttribute('aria-pressed') === 'true'));

// Changing your mind before the question closes is not cheating.
await phones[2].page.click('.choice:nth-child(3)');
await phones[2].page.waitForTimeout(400);
tally = await results();
ok(`changing an answer replaces it rather than adding one (${JSON.stringify(tally.counts)})`,
  tally.voters === 3 && tally.counts[2] === 3 && tally.counts[0] === 0);

// A double tap is the same phone saying the same thing twice, not two votes.
await phones[1].page.click('.choice:nth-child(3)');
await phones[1].page.waitForTimeout(300);
ok('and answering twice still counts once', (await results()).voters === 3);

// A new question reaches every phone already holding the page open, with no
// reload and nothing to re-scan - the whole reason the phones hold a stream.
await ask({ kind: 'choice', question: 'And now?', open: true, options: ['Yes', 'No'] });
await phones[0].page.waitForFunction(() => document.querySelector('#question')?.textContent === 'And now?', null, { timeout: 8000 });
ok('a new question arrives on the phones already holding the page open', true);
ok('with the old question\'s options gone', (await phones[0].page.$$('.choice')).length === 2);
tally = await results();
ok('and its own count, not the last question\'s', tally.voters === 0 && tally.counts.join() === '0,0');
ok('while the phone forgets what it picked last time',
  await phones[0].page.evaluate(() => Array.from(document.querySelectorAll('.choice')).every((b) => b.getAttribute('aria-pressed') === 'false')));

// Short typed answers: the same pipeline, a different shape of answer.
await ask({ kind: 'text', question: 'One word for how that felt?', open: true, options: [] });
await phones[0].page.waitForFunction(() => !document.querySelector('#typed')?.hidden, null, { timeout: 8000 });
await phones[0].page.fill('#answer', 'exposed');
await phones[0].page.click('#send');
await phones[1].page.waitForFunction(() => !document.querySelector('#typed')?.hidden, null, { timeout: 8000 });
await phones[1].page.fill('#answer', 'seen');
await phones[1].page.click('#send');
await phones[0].page.waitForFunction(() => /Answer sent/.test(document.querySelector('#note')?.textContent || ''), null, { timeout: 5000 });
tally = await results();
ok(`typed answers come back as the answers themselves (${JSON.stringify(tally.answers)})`,
  tally.answers.length === 2 && tally.answers.includes('exposed') && tally.answers.includes('seen'));

// Closing it stops the room answering, on the phones and at the door alike.
await ask({ kind: 'text', question: 'One word for how that felt?', open: false, options: [] });
await phones[2].page.waitForFunction(() => document.querySelector('#send')?.disabled === true, null, { timeout: 8000 });
ok('closing a question greys it out on every phone still holding it', true);
const refused = await fetch(`${BASE}/poll/${created.code}/vote`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ voter: 'someone-with-curl', answer: 'sneaked in' }),
});
ok('and a closed question refuses an answer sent straight at the relay', refused.status === 409);

// The code is on a projector in front of everyone; the token is not. That
// split is the only thing making "results the room has not seen yet" mean
// anything at all.
const peeking = await fetch(`${BASE}/poll/${created.code}/results`);
ok('the code alone cannot read the answers - that needs the host token', peeking.status === 401);
const rewriting = await fetch(`${BASE}/poll/${created.code}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ question: 'Free marks for everyone?', options: ['Yes'], open: true }),
});
ok('nor can it rewrite the question', rewriting.status === 401);
ok('a wrong code is simply not a poll', (await fetch(`${BASE}/poll/ZZZZ/results`)).status === 404);

// Typing the code by hand, for the phone whose camera would not focus.
const typedCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const typedPhone = await typedCtx.newPage();
trap(typedPhone, 'student typing the code');
await typedPhone.goto(`${BASE}/join.html`);
await typedPhone.fill('#code', created.code.toLowerCase());
await typedPhone.click('#enter button[type="submit"]');
await typedPhone.waitForFunction(() => !document.querySelector('#live')?.hidden, null, { timeout: 8000 });
ok('typing the code in lower case joins the same poll', (await typedPhone.textContent('#question')) === 'One word for how that felt?');
await typedCtx.close();

// A code nobody is running. Deliberately untrapped: the 404 that teaches the
// page to say so is the thing being tested, and a trapped page would report
// it as though something had gone wrong.
const lostCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const lostPhone = await lostCtx.newPage();
await lostPhone.goto(`${BASE}/join.html?c=ZZZZ`);
await lostPhone.waitForFunction(() => !document.querySelector('#enter')?.hidden, null, { timeout: 8000 });
ok('and a code nobody is running says so instead of hanging',
  /No question is running/.test(await lostPhone.textContent('#enter-note')));
await lostCtx.close();

await host('', { method: 'DELETE' });
ok('ending a poll takes the code with it', (await fetch(`${BASE}/poll/${created.code}/results`)).status === 404);
for (const phone of phones) await phone.ctx.close();
}

if (want('the Polls tab: composing and running a poll from the controller')) {
console.log('\n-- the Polls tab: composing and running a poll from the controller --');
// The relay side is covered above; this drives the actual UI a presenter
// uses - compose, stage, watch votes arrive, close, reveal, export, end -
// with "a phone" standing in as a direct call to the relay, same as the
// section above.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'poll-ui-room', passphrase: 'one at a time wherever staged' }));
const screen = await ctx.newPage();
trap(screen, 'poll-tab display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'poll-tab pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tab[data-tab="polls"]');
ok('with nothing running yet, the Polls tab opens straight on the composer',
  await pad.evaluate(() => !document.querySelector('#poll-build').hidden && document.querySelector('#poll-running').hidden));

await pad.fill('#poll-question', 'Which bias is this?');
await pad.fill('#poll-options .poll-option-row:nth-child(1) input', 'Construct');
await pad.fill('#poll-options .poll-option-row:nth-child(2) input', 'Method');
await pad.click('#poll-option-add');
await pad.fill('#poll-options .poll-option-row:nth-child(3) input', 'Norming');
await pad.click('#poll-start');

await pad.waitForFunction(() => !document.querySelector('#poll-running').hidden, null, { timeout: 8000 });
ok('starting a poll stages it and the tab switches to the running view',
  (await pad.textContent('#poll-running-question')) === 'Which bias is this?');
const code = (await pad.textContent('#poll-running-code')).trim();
ok(`the running card shows the same join code the relay handed back (${code})`,
  /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(code));

await screen.waitForFunction(() => document.querySelector('.r-poll-question')?.textContent === 'Which bias is this?', null, { timeout: 5000 });
ok('and it is really staged on the display, not just claimed by the pad',
  await screen.evaluate((c) => document.querySelector('.r-poll-code')?.textContent === c, code));
ok('with a QR code up so a phone never has to type the code',
  await screen.evaluate(() => !!document.querySelector('.r-poll-qr svg')));

// Three "phones" - direct relay calls, exactly what join.html itself would send.
await fetch(`${BASE}/poll/${code}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voter: 's1', answer: 0 }) });
await fetch(`${BASE}/poll/${code}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voter: 's2', answer: 0 }) });
await fetch(`${BASE}/poll/${code}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voter: 's3', answer: 1 }) });
await screen.waitForFunction(() => document.querySelector('.r-poll-status')?.textContent.includes('3 responses'), null, { timeout: 5000 });
ok('the display\'s own polling loop picks up votes cast straight at the relay', true);
await pad.waitForFunction(() => document.querySelector('#poll-running-status')?.textContent.includes('3 responses'), null, { timeout: 5000 });
ok('and the same count reaches the controller a heartbeat later', true);

await pad.click('#poll-toggle-open');
await screen.waitForFunction(() => document.querySelector('.r-poll')?.classList.contains('is-closed'), null, { timeout: 5000 });
ok('closing voting from the controller reaches the display', true);
await pad.waitForFunction(() => document.querySelector('#poll-toggle-open')?.textContent === 'Reopen voting', null, { timeout: 5000 });
const lateVote = await fetch(`${BASE}/poll/${code}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voter: 's4', answer: 0 }) });
ok('and the relay itself is actually closed, not just the label', lateVote.status === 409);

ok('closing voting does not reveal anything by itself - reveal is its own step',
  await screen.evaluate(() => !document.querySelector('.r-poll').classList.contains('is-revealed')));
await pad.click('#poll-toggle-reveal');
await screen.waitForFunction(() => document.querySelector('.r-poll')?.classList.contains('is-revealed'), null, { timeout: 5000 });
const barCounts = await screen.$$eval('.r-poll-bar-label .mono', (els) => els.map((e) => e.textContent));
ok(`revealing shows the real tally on the display (${barCounts.join(',')})`, barCounts.join(',') === '2,1,0');
const padBarCounts = await pad.waitForFunction(() => {
  const spans = document.querySelectorAll('#poll-running-results .poll-bar-label .mono');
  return spans.length === 3 ? Array.from(spans, (e) => e.textContent) : null;
}, null, { timeout: 5000 }).then((h) => h.jsonValue());
ok(`and the controller's own compact results match (${padBarCounts.join(',')})`, padBarCounts.join(',') === '2,1,0');

const [download] = await Promise.all([pad.waitForEvent('download'), pad.click('#poll-export')]);
ok('exporting a poll downloads a CSV', download.suggestedFilename().endsWith('.csv'));

await pad.click('#poll-end');
ok('ending a poll needs a second tap, like other destructive buttons here',
  (await pad.textContent('#poll-end')) !== 'End poll');
await pad.click('#poll-end');
await screen.waitForFunction(() => !document.querySelector('.r-poll'), null, { timeout: 5000 });
ok('the second tap actually clears it off the screen', true);
await pad.waitForSelector('#poll-build:not([hidden])', { timeout: 5000 });
ok('and the composer comes back for the next question', true);
const goneToo = await fetch(`${BASE}/poll/${code}/results`);
ok('while the relay drops the code at the same time, not left dangling', goneToo.status === 404);

await ctx.close();
}

if (want('Polls tab: live results before reveal, hiding an answer, and history')) {
console.log('\n-- Polls tab: live results before reveal, hiding an answer, and history --');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'poll-history-room', passphrase: 'visible to you only' }));
const screen = await ctx.newPage();
trap(screen, 'poll-history display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'poll-history pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tab[data-tab="polls"]');
await pad.selectOption('#poll-kind', 'text');
await pad.fill('#poll-question', 'One word for how that felt?');
await pad.click('#poll-start');
await pad.waitForFunction(() => !document.querySelector('#poll-running').hidden, null, { timeout: 8000 });
const code = (await pad.textContent('#poll-running-code')).trim();

await fetch(`${BASE}/poll/${code}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voter: 's1', answer: 'exposed' }) });
await fetch(`${BASE}/poll/${code}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voter: 's2', answer: 'seen' }) });
await pad.waitForFunction(() => document.querySelectorAll('#poll-running-results .poll-answer-row').length === 2, null, { timeout: 5000 });
ok('the presenter sees answers arrive before ever revealing anything', true);
ok('and the projector shows nothing yet - watching them arrive privately does not leak to the room',
  await screen.evaluate(() => document.querySelector('.r-poll-results').children.length === 0)
  && await screen.evaluate(() => !document.querySelector('.r-poll').classList.contains('is-revealed')));

// Hide whichever row is "exposed" - answer order matches vote order, but
// asserting by content rather than position keeps this from being fragile.
await pad.evaluate(() => {
  const row = Array.from(document.querySelectorAll('#poll-running-results .poll-answer-row')).find((r) => r.textContent.includes('exposed'));
  row.querySelector('.poll-answer-hide').click();
});
// hideAnswer is a protocol command, not a local UI toggle - it has to make a
// round trip to the display and back before the pad's own view reflects it.
await pad.waitForFunction(() => document.querySelector('#poll-running-results .poll-answer-row.is-hidden'), null, { timeout: 5000 });
ok('hiding one answer marks it on the presenter\'s own list without removing it',
  await pad.evaluate(() => document.querySelector('#poll-running-results .poll-answer-row.is-hidden')?.textContent.includes('exposed')));

await pad.click('#poll-toggle-reveal');
await screen.waitForFunction(() => document.querySelector('.r-poll')?.classList.contains('is-revealed'), null, { timeout: 5000 });
const shown = await screen.$$eval('.r-poll-answer', (els) => els.map((e) => e.textContent));
ok(`the hidden answer never reaches the room (shown: ${shown.join(',')})`, shown.length === 1 && shown[0] === 'seen');

await pad.click('#poll-end');
await pad.click('#poll-end');
await pad.waitForSelector('#poll-history .poll-history-row', { timeout: 5000 });
ok('ending it drops it into this session\'s history, question and all',
  /One word for how that felt/.test(await pad.textContent('.poll-history-question')));

await pad.click('.poll-history-row button:has-text("Redisplay")');
await screen.waitForFunction(() => document.querySelector('.r-poll')?.classList.contains('is-revealed'), null, { timeout: 5000 });
ok('redisplay puts the final results straight back up, already revealed', true);
ok('with no QR to scan - the code does not exist on the relay any more',
  await screen.evaluate(() => !document.querySelector('.r-poll-qr svg')));
const stillHidden = await screen.$$eval('.r-poll-answer', (els) => els.map((e) => e.textContent));
ok('and the redisplay still honours which answer was hidden', stillHidden.length === 1 && stillHidden[0] === 'seen');

const historyBefore = await pad.$$eval('.poll-history-row', (n) => n.length);
await pad.click('#poll-end');
await pad.click('#poll-end');
await pad.waitForFunction(() => !document.querySelector('.r-poll'), { timeout: 5000 }).catch(() => {});
await screen.waitForFunction(() => !document.querySelector('.r-poll'), null, { timeout: 5000 });
const historyAfter = await pad.$$eval('.poll-history-row', (n) => n.length);
ok('dismissing a redisplay does not touch the relay or duplicate the history entry', historyAfter === historyBefore);

await pad.click('.poll-history-row button:has-text("Reopen")');
ok('reopen loads the same question back into the composer, ready to run again fresh',
  (await pad.inputValue('#poll-question')) === 'One word for how that felt?');
ok('as a new draft, not the old (deleted) poll', await pad.evaluate(() => document.querySelector('#poll-running').hidden));

await ctx.close();
}

if (want('planning a poll: compose it now, run it later')) {
console.log('\n-- planning a poll: compose it now, run it later --');
const planFile = path.join(HERE, 'fixtures', 'e2e-poll-plan.podium.json');

const office = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const desk = await office.newPage();
trap(desk, 'poll plan');
await desk.goto(`${BASE}/plan.html`);
await desk.waitForSelector('#type-picker .type-btn');
await desk.fill('#plan-title', 'Poll day');
await desk.click('#type-picker .type-btn:has-text("Poll")');
await desk.fill('#item-fields textarea >> nth=0', 'Which bias is this?');
await desk.fill('#item-fields textarea >> nth=1', 'Construct\nMethod\nNorming');
const previewQuestion = await desk.textContent('.r-poll-question');
ok(`the planning page previews a poll with the projector's own renderer ("${previewQuestion.trim()}")`, previewQuestion.trim() === 'Which bias is this?');
await desk.waitForFunction(() => /^Saved/.test(document.querySelector('#save-state').textContent), null, { timeout: 10000 });
const planJson = await desk.evaluate(async () => {
  const file = await import('./assets/js/planfile.js');
  const store = await import('./assets/js/store.js');
  const rows = await store.allPlans();
  return file.planToJson(rows.find((r) => r.title === 'Poll day') || rows[0]);
});
fs.writeFileSync(planFile, planJson);
await office.close();

const room = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await room.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'poll-plan-room', passphrase: 'set up in advance' }));
const screen = await room.newPage();
trap(screen, 'poll plan display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await room.newPage();
trap(pad, 'poll plan pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.setInputFiles('#plan-file', planFile);
await pad.waitForFunction(() => document.querySelector('#library h3.group')?.textContent === 'Poll day', null, { timeout: 20000 });

await pad.click('#library .tile:has(.tile-title:text-is("Which bias is this?"))');
await pad.waitForFunction(() => document.querySelector('.tab[data-tab="polls"]')?.classList.contains('is-on'), null, { timeout: 5000 });
ok('picking a planned poll switches straight to the Polls tab', true);
ok('with the composer open, not a half-formed item on the projector',
  await pad.evaluate(() => !document.querySelector('#poll-build').hidden && document.querySelector('#poll-running').hidden));
ok('and the question carried over from the plan', (await pad.inputValue('#poll-question')) === 'Which bias is this?');
ok('with its options split back out of the one text field the plan stored them in',
  (await pad.$$eval('#poll-options input', (n) => n.map((i) => i.value))).join(',') === 'Construct,Method,Norming');
ok('nothing is actually staged on the projector yet - a plan is a question, not a poll',
  await screen.evaluate(() => !document.querySelector('.r-poll')));

await pad.click('#poll-start');
await pad.waitForFunction(() => !document.querySelector('#poll-running').hidden, null, { timeout: 8000 });
await screen.waitForFunction(() => document.querySelector('.r-poll-question')?.textContent === 'Which bias is this?', null, { timeout: 5000 });
ok('and starting it from there really does create a live poll on the relay', true);

await room.close();
}

if (want('exporting a session includes its polls')) {
console.log('\n-- exporting a session includes its polls --');
// The full "photos, ink, boards" export is covered elsewhere; this only has
// to prove a poll - running or already ended - rides along in the same zip.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'poll-export-room', passphrase: 'polls ride along' }));
const screen = await ctx.newPage();
trap(screen, 'poll-export display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'poll-export pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tab[data-tab="polls"]');
await pad.fill('#poll-question', 'Which bias is this?');
await pad.fill('#poll-options .poll-option-row:nth-child(1) input', 'Construct');
await pad.fill('#poll-options .poll-option-row:nth-child(2) input', 'Method');
await pad.click('#poll-start');
await pad.waitForFunction(() => !document.querySelector('#poll-running').hidden, null, { timeout: 8000 });

const download = pad.waitForEvent('download', { timeout: 20000 });
await pad.click('.tab[data-tab="photos"]');
await pad.click('#photo-export');
const file = await download;
const zipPath = path.join(HERE, 'fixtures', 'poll-export.zip');
await file.saveAs(zipPath);
const names = [];
{
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
ok(`a poll with nothing else running still produces an exportable zip (${names.join(', ')})`,
  names.some((n) => n.startsWith('polls/') && n.endsWith('.csv')) && names.includes('session.txt'));

const csvEntry = names.find((n) => n.startsWith('polls/'));
ok(`named for its question (${csvEntry})`, /which-bias-is-this/i.test(csvEntry));

await ctx.close();
}

if (want('self-hosted authentication gate')) {
console.log('\n-- self-hosted authentication gate --');
// AUTH_PASSWORD is off for the shared server every other section in this
// file talks to - turning it on there would make every other page load in
// this suite need credentials too. A second, disposable instance instead.
const authPort = await freePort();
const authBase = `http://127.0.0.1:${authPort}`;
const authServer = spawn(process.execPath, ['podium-server.js'], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(authPort), STATIC: '../', AUTH_USER: 'podium', AUTH_PASSWORD: 'let-me-in' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
authServer.stderr.on('data', (d) => process.stderr.write(`[auth-server] ${d}`));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('auth relay did not start')), 10000);
  authServer.stdout.on('data', (d) => { if (String(d).includes('podium relay')) { clearTimeout(timer); resolve(); } });
  authServer.on('exit', (code) => reject(new Error(`auth relay exited with ${code}`)));
});

const basic = (user, pass) => ({ headers: { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } });

const gated = ['/', '/index.html', '/display.html', '/control.html', '/plan.html', '/assets/js/control.js', '/config.json'];
for (const p of gated) {
  const res = await fetch(`${authBase}${p}`);
  ok(`${p} is gated without credentials (${res.status})`, res.status === 401);
}

// join.html is the one page a room full of strangers loads - it, what it
// needs to run, and the relay routes it talks to must stay reachable with no
// credentials at all, AUTH_PASSWORD notwithstanding.
const alwaysOpen = ['/join.html', '/assets/js/join.js', '/favicon.ico', '/healthz'];
for (const p of alwaysOpen) {
  const res = await fetch(`${authBase}${p}`);
  ok(`${p} stays reachable with no credentials (${res.status})`, res.status !== 401);
}
ok('a poll can still be created with no credentials, same as join.html needs',
  (await fetch(`${authBase}/poll`, { method: 'POST' })).status === 200);

// The one number a running process will tell anybody without a login, and the
// only way to find out that a deploy flipped the symlink without restarting the
// service - see podium-admin doctor.
const health = await fetch(`${authBase}/healthz`).then((r) => r.text());
const buildOnDisk = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'protocol.js'), 'utf8')
  .match(/BUILD\s*=\s*(\d+)/)[1];
ok(`/healthz names the build this process is actually serving ("${health.trim()}")`,
  new RegExp(`\\bbuild ${buildOnDisk}\\b`).test(health));

ok('the wrong password is refused, not just any Basic header',
  (await fetch(`${authBase}/control.html`, basic('podium', 'nope'))).status === 401);
ok('the right username and password get the page through',
  (await fetch(`${authBase}/control.html`, basic('podium', 'let-me-in'))).status === 200);

authServer.kill();
await new Promise((resolve) => authServer.on('exit', resolve));
}

if (want('signing in to a server with accounts')) {
console.log('\n-- signing in to a server with accounts --');
// A third server, with a DATA_DIR and a real account in it. The shared one has
// neither, deliberately: accounts change how every page load in the suite
// behaves, so the instance that has them is kept to this section.
const acctPort = await freePort();
const acctBase = `http://127.0.0.1:${acctPort}`;
const acctData = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-e2e-data-'));

// The first account cannot come from a web form - a page that lets an
// anonymous visitor make the first admin is a page that hands the box to
// whoever finds it first - so it comes from the CLI, as it would on a real
// install.
execFileSync(process.execPath, ['podium-admin.js', 'user', 'add', 'jon', '--admin', '--name', 'Jon W', '--password-stdin'], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, DATA_DIR: acctData },
  input: 'a good long password\n',
});

const acctServer = spawn(process.execPath, ['podium-server.js'], {
  cwd: path.join(ROOT, 'server'),
  // AUTH_PASSWORD is set on purpose: accounts must win, and the Basic Auth
  // door must be shut while they do.
  env: { ...process.env, PORT: String(acctPort), STATIC: '../', DATA_DIR: acctData, AUTH_PASSWORD: 'should-be-ignored' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
acctServer.stderr.on('data', (d) => process.stderr.write(`[acct-server] ${d}`));
let startupLog = '';
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('accounts relay did not start')), 10000);
  acctServer.stdout.on('data', (d) => {
    startupLog += String(d);
    if (startupLog.includes('podium auth:')) { clearTimeout(timer); resolve(); }
  });
  acctServer.on('exit', (code) => reject(new Error(`accounts relay exited with ${code}`)));
});
ok(`the server says out loud which gate is live ("${startupLog.trim().split('\n').pop()}")`,
  /podium auth: accounts \(AUTH_PASSWORD is set but ignored/.test(startupLog));

ok('the Basic Auth door is shut once there are accounts',
  (await fetch(`${acctBase}/control.html`, {
    headers: { authorization: `Basic ${Buffer.from('podium:should-be-ignored').toString('base64')}` },
  })).status === 401);

const caps = await fetch(`${acctBase}/api/capabilities`).then((r) => r.json());
ok('the capabilities probe is answerable without signing in, and says so',
  caps.podium === true && caps.auth.mode === 'accounts' && caps.auth.required === true && caps.user === null);

// The audience page is the one thing that must never want an account.
const acctCtx = await browser.newContext();
await acctCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${acctPort}/podium`, room: 'acct-room', passphrase: 'signed in and locked' }));

const joiner = await acctCtx.newPage();
trap(joiner, 'acct join');
await joiner.goto(`${acctBase}/join.html`);
ok('a student reaches the join page with no account and no prompt',
  await joiner.isVisible('#enter') && joiner.url().endsWith('/join.html'));
await joiner.close();

// A browser asking for a page it may not have gets a page back, not a native
// credential dialog - which is the whole reason this is a cookie.
const pad = await acctCtx.newPage();
trap(pad, 'acct control');
await pad.goto(`${acctBase}/control.html`);
await pad.waitForSelector('#form');
ok(`asking for the controller signed out lands on the login page (${new URL(pad.url()).pathname})`,
  new URL(pad.url()).pathname === '/login.html');
ok('carrying where you were trying to go', new URL(pad.url()).searchParams.get('next') === '/control.html');
ok('and the login page styles itself, having nothing behind the gate to fetch',
  await pad.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(11, 13, 16)');

await pad.fill('#username', 'jon');
await pad.fill('#password', 'not the password');
await pad.click('#go');
await pad.waitForFunction(() => document.querySelector('#note')?.classList.contains('bad'), null, { timeout: 8000 });
ok(`a wrong password says so and stays put ("${(await pad.textContent('#note')).trim()}")`,
  new URL(pad.url()).pathname === '/login.html');
ok('and clears the password rather than leaving it sitting there', await pad.inputValue('#password') === '');

await pad.fill('#password', 'a good long password');
await Promise.all([pad.waitForURL(/control\.html/), pad.click('#go')]);
ok('the right password lands on the page that was asked for', /control\.html$/.test(pad.url()));

await pad.waitForSelector('#session-badge .session-who');
ok(`the controller says who is signed in ("${await pad.textContent('#session-badge .session-who')}")`,
  (await pad.textContent('#session-badge .session-who')).trim() === 'Jon W');

// --- the library, once there is a disk to keep it on ---------------------
//
// The whole point of the server-side library: a deck reaches the projector
// without a git commit. Uploaded on one page, picked on another, shown on a
// third.
execFileSync(process.execPath, ['podium-admin.js', 'course', 'add', 'psy415', '--title', 'PSY 415'], {
  cwd: path.join(ROOT, 'server'), env: { ...process.env, DATA_DIR: acctData },
});
execFileSync(process.execPath, ['podium-admin.js', 'member', 'add', 'psy415', 'jon', '--role', 'owner'], {
  cwd: path.join(ROOT, 'server'), env: { ...process.env, DATA_DIR: acctData },
});

const desk = await acctCtx.newPage();
trap(desk, 'acct admin');
await desk.goto(`${acctBase}/admin.html`);
await desk.waitForSelector('#admin:not([hidden])');
ok('the admin page opens for a signed-in account', await desk.isVisible('#up-file'));
ok(`and says what it will take (${(await desk.textContent('#upload-help')).slice(0, 40)}…)`,
  /50 MB/.test(await desk.textContent('#upload-help')) && /\.md/.test(await desk.textContent('#upload-help')));

const uploadDeck = path.join(acctData, 'uploaded-deck.md');
fs.writeFileSync(uploadDeck, '# Uploaded In Class\n\nThis never went near git.\n\n---\n\n## The second slide\n');
await desk.setInputFiles('#up-file', uploadDeck);
await desk.fill('#up-title', 'Week 1 lecture');
await desk.selectOption('#up-course', 'psy415');
await desk.waitForSelector('#items .admin-row', { state: 'detached' }).catch(() => {});
await desk.click('#up-go');
// Scoped to the library list: the admin page has rows for people, courses and
// past sessions too, and "the first .admin-row on the page" is not a thing this
// test ever meant.
await desk.waitForSelector('#items .admin-row');
ok(`the upload lands in the library (${(await desk.textContent('#items .admin-row')).replace(/\s+/g, ' ').trim()})`,
  (await desk.textContent('#items .admin-row')).includes('Week 1 lecture'));
ok(`and the page accounts for the disk it used (${await desk.textContent('#usage')})`,
  /1 file, /.test(await desk.textContent('#usage')));

// A file Podium will not serve from its own origin, because a browser would
// run it there with the session cookie in reach.
const notAllowed = path.join(acctData, 'evil.html');
fs.writeFileSync(notAllowed, '<script>alert(1)</script>');
await desk.setInputFiles('#up-file', notAllowed);
await desk.click('#up-go');
await desk.waitForFunction(() => document.querySelector('#up-note')?.classList.contains('is-bad'), null, { timeout: 8000 });
ok(`an html upload is refused with a reason ("${(await desk.textContent('#up-note')).trim()}")`,
  /does not take html/.test(await desk.textContent('#up-note')));

// Now the controller, which has to merge it in beside the shipped manifest.
await pad.reload();
await pad.waitForSelector('#library .tile');
const groupNames = await pad.$$eval('#library .group', (els) => els.map((e) => e.textContent));
ok(`the uploaded deck is filed under its course, not lumped in with the examples (${groupNames.join(', ')})`,
  groupNames.includes('PSY415'));
ok('and the decks that ship with Podium are still there beside it',
  groupNames.includes('Working examples'));

await pad.fill('#lib-filter', 'psy415');
const filteredTitles = await pad.$$eval('#library .tile:not([hidden]) .tile-title', (els) => els.map((e) => e.textContent));
ok(`typing a course code filters the library down to that course (${filteredTitles.join(', ')})`,
  filteredTitles.length === 1 && filteredTitles[0] === 'Week 1 lecture');

// And it has to actually work as a deck: fetched from /media, rendered by the
// same Marp the projector uses.
const acctScreen = await acctCtx.newPage();
trap(acctScreen, 'acct display');
await acctScreen.goto(`${acctBase}/display.html`);
await acctScreen.click('#arm-button');
await acctScreen.waitForSelector('#hud[data-status="online"]');

await pad.click('#library .tile:not([hidden])');
// Read out of the deck's shadow root, the same way the marp-decks section
// does: the rendered slide is not in the host element's light DOM.
await acctScreen.waitForFunction(() => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  const svg = [...(host?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]') || [])]
    .find((s) => s.classList.contains('podium-on'));
  return /Uploaded In Class/.test(svg?.querySelector('section')?.textContent || '');
}, null, { timeout: 25000 });
ok('and picking it puts it on the projector, rendered from the uploaded bytes', true);

// --- plans and settings, the things you stop carrying -------------------

// A lecture built at the desk and sent to the server is on the iPad in class
// without a file in between. That is the whole of phase 3's first half.
const planner = await acctCtx.newPage();
trap(planner, 'acct plan');
await planner.goto(`${acctBase}/plan.html`);
await planner.waitForSelector('#plan-server:not([hidden])');
ok('the planning page offers the server when there is one', true);

await planner.fill('#plan-title', 'Day 6 — sent, not carried');
await planner.fill('#plan-course', 'psy415');
await planner.click('#plan-push');
await planner.waitForFunction(() => /Sent/.test(document.querySelector('#plan-push-note')?.textContent || ''), null, { timeout: 8000 });
ok(`sending it says where it went ("${(await planner.textContent('#plan-push-note')).trim()}")`,
  /shared with psy415/.test(await planner.textContent('#plan-push-note')));

// A course the server has never heard of must not silently become a share.
await planner.fill('#plan-course', 'not-a-real-course');
await planner.click('#plan-push');
await planner.waitForFunction(() => /yours alone/.test(document.querySelector('#plan-push-note')?.textContent || ''), null, { timeout: 8000 });
ok('a course this server does not have is saved privately, and says so rather than guessing',
  /no course "not-a-real-course"/.test(await planner.textContent('#plan-push-note')));

// And in class. Opening the Library tab is what re-reads the list, which is
// the point: this controller was already open before the plan was sent, and
// must not need a reload to see it.
await pad.click('.tab[data-tab="library"]');
await pad.waitForSelector('#plan-server:not([hidden])', { timeout: 8000 });
await pad.waitForFunction(
  () => [...document.querySelectorAll('#plan-server-pick option')].some((o) => o.textContent.includes('sent, not carried')),
  null, { timeout: 8000 },
);
const offered = await pad.$$eval('#plan-server-pick option', (els) => els.map((e) => e.textContent));
ok(`the controller lists what is on the server (${offered.join(', ')})`,
  offered.some((t) => t.includes('Day 6 — sent, not carried')));

await pad.selectOption('#plan-server-pick', { label: 'Day 6 — sent, not carried (psy415)' });
await pad.click('#plan-server-open');
await pad.waitForFunction(() => /Loaded/.test(document.querySelector('#plan-note')?.textContent || ''), null, { timeout: 10000 });
ok(`opening it in class needs no file at all ("${(await pad.textContent('#plan-note')).trim()}")`,
  /Day 6 — sent, not carried/.test(await pad.textContent('#plan-note')));

await planner.close();

// The second half: a device nobody has configured sets itself up from the
// course it belongs to, which is what makes a new iPad a login rather than a
// QR scan and a typed passphrase.
execFileSync(process.execPath, ['podium-admin.js', 'course', 'settings', 'psy415',
  '--transport', 'ws', '--room', 'psy415-live', '--ws-url', `ws://127.0.0.1:${acctPort}/podium`,
  '--passphrase', 'handed over by the server'], {
  cwd: path.join(ROOT, 'server'), env: { ...process.env, DATA_DIR: acctData },
});

// A genuinely fresh browser: no localStorage, no pairing hash, nothing but a
// login.
const freshCtx = await browser.newContext();
const fresh = await freshCtx.newPage();
trap(fresh, 'fresh device');
await fresh.goto(`${acctBase}/control.html`);
await fresh.waitForSelector('#form');
await fresh.fill('#username', 'jon');
await fresh.fill('#password', 'a good long password');
await Promise.all([fresh.waitForURL(/control\.html/), fresh.click('#go')]);

await fresh.waitForSelector('#status[data-status="online"]', { timeout: 20000 });
ok('a device with no settings at all signs in and is simply connected', true);
const adopted = await fresh.evaluate(() => JSON.parse(localStorage.getItem('podium.config.v2') || '{}'));
ok(`it adopted the course's room without anyone typing it (${adopted.room})`, adopted.room === 'psy415-live');
ok('and the passphrase with it, which is what joining the room actually needs',
  adopted.passphrase === 'handed over by the server');
await freshCtx.close();

// Two courses is a choice, and nothing is adopted silently: picking the wrong
// room is a mistake you discover in front of a class.
for (const args of [
  ['course', 'add', 'psy101', '--title', 'PSY 101'],
  ['member', 'add', 'psy101', 'jon', '--role', 'owner'],
  ['course', 'settings', 'psy101', '--transport', 'ws', '--room', 'psy101-live',
    '--ws-url', `ws://127.0.0.1:${acctPort}/podium`, '--passphrase', 'the other room'],
]) {
  execFileSync(process.execPath, ['podium-admin.js', ...args], {
    cwd: path.join(ROOT, 'server'), env: { ...process.env, DATA_DIR: acctData },
  });
}

const twoCtx = await browser.newContext();
const two = await twoCtx.newPage();
trap(two, 'two-course device');
await two.goto(`${acctBase}/control.html`);
await two.waitForSelector('#form');
await two.fill('#username', 'jon');
await two.fill('#password', 'a good long password');
await Promise.all([two.waitForURL(/control\.html/), two.click('#go')]);

await two.waitForSelector('#setup-courses:not([hidden])', { timeout: 15000 });
const choices = await two.$$eval('#setup-course-buttons button', (els) => els.map((e) => e.textContent));
ok(`belonging to two courses offers the choice rather than guessing (${choices.join(', ')})`,
  choices.includes('PSY 415') && choices.includes('PSY 101'));
ok('and adopts neither on its own', await two.evaluate(() => !localStorage.getItem('podium.config.v2')));

await two.click('#setup-course-buttons button:has-text("PSY 101")');
ok('picking one fills the form in and leaves it to be looked at, not saved behind your back',
  await two.inputValue('#c-room') === 'psy101-live'
  && await two.evaluate(() => !localStorage.getItem('podium.config.v2')));
await twoCtx.close();

// --- what happened in the room -----------------------------------------
//
// The display wrote a timeline while the deck above was on screen. Nothing
// else could have: the relay only ever sees ciphertext (see
// server/lectures.js), so a lecture is only ever recorded by the one device
// that holds the decrypted state.
await desk.waitForFunction(async () => {
  const res = await fetch('/api/lectures', { credentials: 'same-origin' });
  if (!res.ok) return false;
  const { lectures } = await res.json();
  return lectures.length === 1 && lectures[0].events > 0;
}, null, { timeout: 20000 });
ok('going live starts a session record, and what went on the projector lands in it', true);

// --- the bulky half: a photo, and the export that outlives the tablet ------
//
// A photo is somebody else's picture more often than not, so the server keeping
// it is a switch you can see rather than a new default nobody was told about.
await pad.click('.tab[data-tab="photos"]');
ok('a server-backed controller offers the choice about keeping photos, and starts with it off',
  await pad.isVisible('#photo-keep-row') && !await pad.isChecked('#photo-keep'));

// Off is the default, so this lecture has to ask for its photos.
await pad.check('#photo-keep');
await pad.click('#photo-panel');
await pad.waitForSelector('#photo-strip .shot', { timeout: 20000 });
await desk.waitForFunction(async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  const { lecture } = await fetch(`/api/lectures/${lectures[0].id}`, { credentials: 'same-origin' })
    .then((r) => r.json());
  return (lecture.files || []).some((f) => f.kind === 'photo');
}, null, { timeout: 20000 });
ok('a photo taken in the room is filed with the lecture as it is taken', true);

// And the export, which is what makes a past lecture downloadable in March
// from a browser that was never in the room.
const acctZip = pad.waitForEvent('download', { timeout: 60000 });
await pad.click('#photo-export');
await (await acctZip).saveAs(path.join(HERE, 'fixtures', 'acct-session.zip'));
await desk.waitForFunction(async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  const { lecture } = await fetch(`/api/lectures/${lectures[0].id}`, { credentials: 'same-origin' })
    .then((r) => r.json());
  return (lecture.files || []).some((f) => f.name === 'session.txt');
}, null, { timeout: 30000 });
ok('and everything the export built is filed with it too', true);

// Ink is the other half of what a lecture keeps, and the half no export is
// needed for: the display files its own strokes at stand-down so the
// annotations outlive the tab even when nobody pressed Export. Drawn after
// the export above deliberately - this is about the display's own filing
// path, not about what the controller rasterized into the zip.
await pad.click('.tab[data-tab="ink"]');
await pad.waitForSelector('#pad');
const acctPad = await pad.$eval('#pad', (n) => {
  const r = n.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await pad.mouse.move(acctPad.x + acctPad.w * 0.25, acctPad.y + acctPad.h * 0.35);
await pad.mouse.down();
for (let i = 1; i <= 10; i++) {
  await pad.mouse.move(acctPad.x + acctPad.w * (0.25 + i * 0.04), acctPad.y + acctPad.h * (0.35 + i * 0.03));
}
await pad.mouse.up();
await acctScreen.waitForFunction(
  () => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 8000 });
ok('ink drawn during a server-backed lecture reaches the display', true);

// E is stand down - the way back out of a lecture without a "quit" key a
// stray press could hit.
await acctScreen.keyboard.press('e');
await desk.waitForFunction(async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures[0]?.endedAt > 0;
}, null, { timeout: 15000 });
ok('and standing down closes it', true);

// And the strokes really are in it. Read back through /media rather than
// trusting the row: a file that exists but holds an empty bySurface is
// exactly the failure this is here to catch - snapshotInk filtered on the
// wrong property for the whole life of the feature, so every lecture filed
// nothing and every suite still passed.
const filedInk = await desk.evaluate(async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  const { lecture } = await fetch(`/api/lectures/${lectures[0].id}`, { credentials: 'same-origin' })
    .then((r) => r.json());
  const row = (lecture.files || []).find((f) => f.name === 'ink.json');
  if (!row) return { found: false };
  const body = await fetch(row.url, { credentials: 'same-origin' }).then((r) => r.json());
  const surfaces = Object.values(body.bySurface || {});
  return { found: true, surfaces: surfaces.length, strokes: surfaces.reduce((n, s) => n + (s.strokes?.length || 0), 0) };
});
ok(`the display files its own ink with the lecture (${filedInk.surfaces} surface(s), ${filedInk.strokes} stroke(s))`,
  filedInk.found && filedInk.surfaces > 0 && filedInk.strokes > 0);

// Everything below this point that reads "the" session - the timeline check,
// the session-zip rebuild - assumes this is the only lecture in the list. Run
// inside the page so it carries the (HttpOnly) session cookie automatically,
// recorded now so the second lecture opened below (purely to prove the photo
// switch resets) can be cleaned back up rather than sitting ahead of this one.
const firstLectureId = await desk.evaluate(async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures[0]?.id;
});

// The ordinary flow is teach, stand down, THEN find the export button - and
// standing down is exactly what clears state.lectureId. An export built in
// that window still has to be filed under the lecture that just ended (see
// lastKnownLectureId in control.js), not silently dropped.
const filedAfterStandDown = [];
pad.on('request', (r) => { if (/\/api\/lectures\/\d+\/files/.test(r.url())) filedAfterStandDown.push(r.url()); });
const postStandDownZip = pad.waitForEvent('download', { timeout: 60000 });
await pad.click('.tab[data-tab="photos"]');
await pad.click('#photo-export');
await (await postStandDownZip).saveAs(path.join(HERE, 'fixtures', 'acct-session-late.zip'));
pad.removeAllListeners('request');
ok(`an export built after standing down still gets filed under the lecture that just ended (${filedAfterStandDown.length} file request(s))`,
  filedAfterStandDown.length > 0);

// The switch on the Photos tab is THIS LECTURE ONLY (see syncKeepPhotosOverride
// in control.js) - checking it above must not silently carry into the next one.
await acctScreen.click('#arm-button');
await acctScreen.waitForSelector('#hud[data-status="online"]');
await desk.waitForFunction(async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures.some((l) => !l.endedAt);
}, null, { timeout: 15000 });
// A couple of the display's ~2s state heartbeats, which is what actually
// carries the new (null, then fresh) lectureId to this controller and runs
// the render pass that re-checks the override - see renderPhotos.
await pad.waitForTimeout(4500);
ok('a new lecture starts with the photo switch back at the device default, not the last one picked',
  !(await pad.isChecked('#photo-keep')));
await acctScreen.keyboard.press('e');

// Clean up the lecture that existed only to prove the reset above, so the
// checks that follow find exactly the one lecture they expect - see
// firstLectureId.
await desk.waitForFunction(async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures.every((l) => l.endedAt);
}, null, { timeout: 15000 });
await desk.evaluate(async (keepId) => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  await Promise.all(lectures.filter((l) => l.id !== keepId)
    .map((l) => fetch(`/api/lectures/${l.id}`, { method: 'DELETE', credentials: 'same-origin' })));
}, firstLectureId);

await desk.reload();
await desk.waitForSelector('#sessions-card:not([hidden]) .admin-row');
const sessionMeta = await desk.textContent('#sessions .admin-meta');
ok(`the admin page lists the session with what it knows about it (${sessionMeta.replace(/\s+/g, ' ').trim()})`,
  /acct-room/.test(sessionMeta) && /moment/.test(sessionMeta));

await desk.click('#sessions .admin-row .admin-small');
await desk.waitForSelector('.timeline-row');
const timeline = await desk.$$eval('.timeline-row .timeline-what', (els) => els.map((e) => e.textContent));
// The deck's own name, not the library tile's: staging a deck titles it from
// its front matter or its first heading (see frontMatterTitle), and the
// timeline records what the item was called on screen rather than inventing a
// second name for the same thing.
ok(`opening it shows what was covered, by name (${timeline.join(', ')})`,
  timeline.includes('Uploaded In Class'));

// Naming one is how "Tue 14:00" becomes something you can find again.
// --- running the place from the admin page ---------------------------------
//
// Everything below was a shell command until phase 5: an account, a course,
// somebody in it, and the room that course connects to.
await desk.waitForSelector('#people-card:not([hidden])');
await desk.fill('#new-user', 'sam');
await desk.fill('#new-name', 'Sam Okafor');
await desk.fill('#new-pass', 'sams password here');
await desk.click('#new-user-go');
// The note text is set synchronously, before addPerson() awaits its own
// refreshPeople() - waiting on the note alone can win a race against the row
// actually landing in the DOM. Wait for the row itself.
await desk.waitForSelector('#people .admin-row:has-text("sam")', { timeout: 8000 });
const peopleRows = await desk.$$eval('#people .admin-row .admin-title', (els) => els.map((e) => e.textContent));
ok(`an account can be made without a shell (${peopleRows.join(', ')})`,
  peopleRows.some((t) => t.includes('Sam Okafor (sam)')));

// Signing yourself out of the page you are standing on is never what the click
// meant, so it is not offered.
const ownRow = await desk.$('#people .admin-row:has(.admin-title:text-is("Jon W (jon)"))');
ok('your own row offers no way to disable or demote yourself',
  await ownRow.$('button:has-text("Disable")') === null
  && await ownRow.$eval('input[type=checkbox]', (i) => i.disabled) === true);

await desk.click('#courses-card .admin-row:has(.admin-title:text-is("PSY 415")) button:has-text("Open")');
await desk.waitForSelector('#courses .session-body');
await desk.selectOption('#courses .session-body select', 'sam');
await desk.click('#courses .session-body button:has-text("Add to the course")');
await desk.waitForFunction(
  () => [...document.querySelectorAll('#courses .session-body .admin-title')].some((e) => e.textContent.includes('(sam)')),
  null, { timeout: 8000 },
);
ok('and put into a course from the same page', true);

// The room a course connects to, which is what makes joining it enough to set
// a device up.
const passField = '#courses .session-body [data-setting="passphrase"]';
ok(`the course's room and key are there to be read by somebody who runs it (${await desk.inputValue('#courses .session-body [data-setting="room"]')})`,
  await desk.inputValue('#courses .session-body [data-setting="room"]') === 'psy415-live'
  && await desk.inputValue(passField) === 'handed over by the server');
const before = await desk.inputValue(passField);
await desk.click('#courses .session-body button:has-text("New passphrase")');
ok('rotating it is one button, because that is how you take a room back',
  await desk.inputValue(passField) !== before);
// Only the field changed - nothing is saved until Save is clicked - but leave
// it reading what the server actually holds rather than a key nobody has.
await desk.fill(passField, before);

ok(`the page says what the box is holding (${(await desk.textContent('#storage-note')).slice(0, 60)}…)`,
  /Library: 1 file/.test(await desk.textContent('#storage-note'))
  && /database:/.test(await desk.textContent('#storage-note')));

const backup = desk.waitForEvent('download', { timeout: 30000 });
await desk.click('#backup-go');
const backupFile = await backup;
ok(`a copy of the database comes out in one click (${backupFile.suggestedFilename()})`,
  /^podium-\d{4}-\d{2}-\d{2}.*\.db$/.test(backupFile.suggestedFilename()));

// The record, rebuilt into the same zip by a page that was never in the room.
const rebuilt = desk.waitForEvent('download', { timeout: 40000 });
await desk.click('#sessions .session-body button:has-text("Download the session")');
const rebuiltFile = await rebuilt;
ok(`a past lecture downloads as a session zip again (${rebuiltFile.suggestedFilename()})`,
  /\.zip$/.test(rebuiltFile.suggestedFilename()));

await desk.fill('#sessions .admin-name', 'Day 6 — Weighing the Evidence');
await desk.dispatchEvent('#sessions .admin-name', 'change');
await desk.waitForFunction(async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures[0]?.title === 'Day 6 — Weighing the Evidence';
}, null, { timeout: 8000 });
ok('and naming it sticks', true);

// A rename the server actually refuses (or a dropped connection) must not
// leave the field looking like it saved when it did not.
expectingLectureRenameForbidden = true;
await desk.route('**/api/lectures/*', (route) => {
  if (route.request().method() === 'PATCH') return route.fulfill({ status: 403, json: { error: 'no' } });
  return route.continue();
});
await desk.fill('#sessions .admin-name', 'A rename that will be refused');
await desk.dispatchEvent('#sessions .admin-name', 'change');
await desk.waitForFunction(
  () => document.querySelector('#sessions .admin-name')?.value === 'Day 6 — Weighing the Evidence',
  null, { timeout: 8000 },
);
ok('a rejected rename reverts the field rather than leaving it looking saved', true);
await desk.unroute('**/api/lectures/*');
expectingLectureRenameForbidden = false;

await desk.close();
await acctScreen.close();

// The hole Basic Auth could never close: a browser will not put an
// Authorization header on a WebSocket handshake, but it sends cookies without
// being asked. So the relay socket is gated now too.
const upgradeStatus = (cookie) => new Promise((resolve) => {
  const req = http.request({
    host: '127.0.0.1', port: acctPort, path: '/podium?room=acct-room',
    headers: {
      connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...(cookie ? { cookie } : {}),
    },
  });
  req.on('upgrade', (res, socket) => { socket.destroy(); resolve('upgraded'); });
  req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', () => resolve('error'));
  req.end();
});
ok(`the relay socket refuses a stranger who knows the room name (${await upgradeStatus('')})`,
  (await upgradeStatus('')) === 401);

const signedInCookie = (await acctCtx.cookies())
  .filter((c) => c.name === 'podium_session').map((c) => `${c.name}=${c.value}`).join('; ');
ok('the session cookie is HttpOnly, so no page script can read or leak it',
  (await acctCtx.cookies()).find((c) => c.name === 'podium_session')?.httpOnly === true);
ok(`and the same socket opens for a signed-in one (${await upgradeStatus(signedInCookie)})`,
  (await upgradeStatus(signedInCookie)) === 'upgraded');

// Which means the controller it came from is really connected, not merely
// showing a page.
await pad.waitForSelector('#status[data-status="online"]', { timeout: 15000 });
ok('so the signed-in controller actually reaches the relay', true);

await Promise.all([pad.waitForURL(/login\.html/), pad.click('#session-badge button')]);
ok('signing out goes back to the login page', /login\.html/.test(pad.url()));
ok('and the controller is behind the gate again',
  (await fetch(`${acctBase}/control.html`)).status === 401);

await acctCtx.close();
acctServer.kill();
await new Promise((resolve) => acctServer.on('exit', resolve));
fs.rmSync(acctData, { recursive: true, force: true });
}

if (want('back to the landing page')) {
console.log('\n-- back to the landing page --');
const ctx = await browser.newContext();
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'landing', passphrase: 'find the way back' }));

// The controller's own PODIUM wordmark is a real link now, not just a label.
const pad = await ctx.newPage();
trap(pad, 'landing control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.topbar .brand');
ok('the controller\'s PODIUM wordmark points at the landing page',
  await pad.getAttribute('.topbar .brand', 'href') === 'index.html');
await Promise.all([pad.waitForURL(/index\.html/), pad.click('.topbar .brand')]);
ok('and following it actually gets there', /index\.html$/.test(pad.url()));

// So does the planning page's.
const desk = await ctx.newPage();
trap(desk, 'landing plan');
await desk.goto(`${BASE}/plan.html`);
await desk.waitForSelector('.topbar .brand');
ok('the planning page\'s PODIUM wordmark points at the landing page',
  await desk.getAttribute('.topbar .brand', 'href') === 'index.html');

// The display has no wordmark to click once it is on the projector - just a
// key, the same as every other way out of it.
const screen = await ctx.newPage();
trap(screen, 'landing display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
await Promise.all([screen.waitForURL(/index\.html/), screen.keyboard.press('b')]);
ok('and B does the same job on the display', /index\.html$/.test(screen.url()));
await ctx.close();
}

if (skipped.length) console.log(`\nskipped ${skipped.length} section${skipped.length === 1 ? '' : 's'} (--only)`);
console.log('\nconsole/page errors: ' + (errors.length ? '\n  - ' + errors.join('\n  - ') : 'none'));
} finally {
  await browser?.close().catch(() => {});
  server.kill();
}
console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length || errors.length ? 1 : 0);
