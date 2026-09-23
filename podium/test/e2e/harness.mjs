// Shared setup for Podium's end-to-end groups (test/e2e/*.mjs).
//
// Importing this starts a relay on a spare port, serves the pages from it and
// launches a browser - one of each per group, so every group is a separate,
// independent run. Run one group with node podium/test/e2e/<group>.mjs, or all
// of them with node podium/test/e2e.mjs.
//
// It generates its own audio and image fixtures, so there is nothing to download.

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

// test/, not test/e2e/: fixtures and every path a section builds from HERE
// stay where they were before the suite was split into groups.
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(HERE, '..');

async function loadPlaywright() {
  for (const spec of [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    path.join(ROOT, 'node_modules', 'playwright', 'index.mjs'),
    '/opt/node22/lib/node_modules/playwright/index.mjs',
  ].filter(Boolean)) {
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

const { chromium, devices } = await loadPlaywright();
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

// For any check that has to await something in the page (a fetch, a cache).
// page.waitForFunction does NOT await a predicate that returns a Promise: the
// Promise itself is truthy, so an async predicate "passes" on its first call
// without its condition ever being checked. This awaits each attempt through
// evaluate(), which does. Synchronous checks are fine with waitForFunction.
async function pollUntil(page, fn, arg, { timeout = 15000, interval = 300 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > deadline) throw new Error('pollUntil timed out');
    await page.waitForTimeout(interval);
  }
}

// A browser normalizes a hex colour assigned to .style.background into its
// own serialization (rgb(...)) before it is readable back off the element, so
// compare against what THIS browser does with the same hex rather than
// guessing its format.
const bgMatches = (page, selector, hex) => page.evaluate(({ selector, hex }) => {
  const probe = document.createElement('div');
  probe.style.background = hex;
  document.body.append(probe);
  const want = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const got = getComputedStyle(document.querySelector(selector)).backgroundColor;
  return got === want;
}, { selector, hex });

// Iterating on one section without sitting through the other thirty:
//
//   node podium/test/e2e.mjs --only ink        every section with "ink" in its name
//   node podium/test/e2e.mjs --only photos,camera
//
// Sections within a group run in order and some lean on what an earlier one
// in the same group left behind, so a filtered run is a convenience; the
// group's full run is the contract.
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
// Anchored at the end (where = text + " " + url, so the url is always last):
// a sibling route always has more path after the id, which this cannot match.
const LECTURE_RENAME_FORBIDDEN = /403 \(Forbidden\).*\/api\/lectures\/\d+$/;

// A fifth: a display's event flush answered 409 once its shared lecture has
// been ended by another display (see recoverRecording in display.js) - the
// multi-display section deliberately drives this to prove the display that
// was never stood down notices and recovers, rather than beating on a dead
// id forever. Same narrow-flag treatment as the rename case above, and for
// the same reason: matching on status and path alone would also swallow a
// genuine 409 from ending an already-ended lecture twice.
const RECOVERY_CONFLICT = /409 \(Conflict\).*\/api\/lectures\/\d+\/events$/;

// A sixth: a plain member's PUT to /api/templates/<course> forced to answer
// 403, to prove membership is not ownership (see Issue #80's e2e block).
// Anchored the same way as the rename case above, for the same reason - a
// bare status+path match would also swallow a genuine forbidden GET or
// DELETE on this same route.
const TEMPLATE_WRITE_FORBIDDEN = /403 \(Forbidden\).*\/api\/templates\/[^/]+$/;

// A seventh: the display's own poll-results fetch answering 404 once the
// relay has forgotten a poll (Issue #115's e2e section, which kills and
// restarts a relay process on purpose). A fetch()-triggered console error
// carries no location URL at all here (the same reason the favicon case
// below has to match on bare text), so this cannot be anchored on the poll
// route the way the other deliberate cases above are - it is armed only
// for the one narrow window that test creates, same safety net as those.

// An eighth: PUT /api/plans/<id> answering 409 once its updatedAt has moved
// past what this device staged its save against (Issue #117's e2e section,
// which deliberately saves the same plan out from under itself to prove the
// warning). Same text-only match as the poll-lost case above and for the
// same reason: a fetch()-triggered console message here carries no location
// URL to anchor on the way a resource-tag load does.

// Set by the sections that deliberately provoke one of the errors above, for
// exactly as long as that one request is in flight.
const expecting = {
  lectureRenameForbidden: false,
  recoveryConflict: false,
  templateWriteForbidden: false,
  pollLost: false,
  planConflict: false,
};

const trap = (page, tag) => {
  // The console message for a failed fetch and the network response that
  // caused it are two different CDP domains, and PR #86's own CI run showed
  // they do not always reach Playwright's listeners in the browser's true
  // internal order: the url-less console line for a favicon 404 can arrive
  // BEFORE the 'response' event that names it as a favicon, not just after.
  // The old version only ever looked backwards from the console side within
  // a fixed window, so a swap like that flagged a real, expected favicon 404
  // as an error with nothing here to un-flag it. This version matches in
  // whichever order the two events land, within WINDOW_MS of each other.
  const WINDOW_MS = 3000;
  const recentFavicon404s = [];
  const pendingUrllessErrors = []; // { at, entry } - provisionally flagged, awaiting a response to clear them
  const trimFavicon404s = () => {
    const cutoff = Date.now() - WINDOW_MS;
    while (recentFavicon404s.length && recentFavicon404s[0] < cutoff) recentFavicon404s.shift();
  };
  const trimPendingUrlless = () => {
    const cutoff = Date.now() - WINDOW_MS;
    while (pendingUrllessErrors.length && pendingUrllessErrors[0].at < cutoff) pendingUrllessErrors.shift();
  };
  page.on('response', (r) => {
    if (r.status() !== 404) return;
    if (!/\/favicon\.ico(?:\?|$)/.test(r.url())) return;
    trimPendingUrlless();
    const pending = pendingUrllessErrors.shift();
    if (pending) {
      // The console message beat this response here - un-flag it rather
      // than leaving it sitting in errors as a false positive.
      const idx = errors.indexOf(pending.entry);
      if (idx !== -1) errors.splice(idx, 1);
      return;
    }
    recentFavicon404s.push(Date.now());
    trimFavicon404s();
  });
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const where = `${text} ${m.location()?.url || ''}`;
    if (OFFLINE_NOISE.test(where) || DELIBERATE.test(where)) return;
    if (expecting.lectureRenameForbidden && LECTURE_RENAME_FORBIDDEN.test(where)) return;
    if (expecting.recoveryConflict && RECOVERY_CONFLICT.test(where)) return;
    if (expecting.templateWriteForbidden && TEMPLATE_WRITE_FORBIDDEN.test(where)) return;
    if (expecting.planConflict && /responded with a status of 409/.test(text)) return;
    // Killing and restarting a relay process (Issue #115's e2e section) is
    // its own brief burst of expected noise: a connection-refused while the
    // old process is down and the new one is not up yet, then a 404 once it
    // is - text-only, since a fetch()-triggered console message here does
    // not reliably carry a location URL to anchor on the way a resource-tag
    // load does.
    if (expecting.pollLost && /ERR_CONNECTION_REFUSED|responded with a status of 404/.test(text)) return;
    if (!m.location()?.url && text === 'Failed to load resource: the server responded with a status of 404 (Not Found)') {
      trimFavicon404s();
      if (recentFavicon404s.length) { recentFavicon404s.shift(); return; }
      // No favicon 404 response seen yet - it may simply not have arrived
      // here first. Flag it provisionally; the 'response' handler above
      // clears it if a matching favicon 404 shows up within WINDOW_MS. An
      // unrelated url-less 404 with no such response stays flagged, same
      // as always.
      const entry = `${tag} console: ${text}`;
      errors.push(entry);
      pendingUrllessErrors.push({ at: Date.now(), entry });
      return;
    }
    errors.push(`${tag} console: ${text}`);
  });
};

function reportErrors() {
  if (skipped.length) console.log(`\nskipped ${skipped.length} section${skipped.length === 1 ? '' : 's'} (--only)`);
  console.log('\nconsole/page errors: ' + (errors.length ? '\n  - ' + errors.join('\n  - ') : 'none'));
}

async function teardown() {
  await browser?.close().catch(() => {});
  server.kill();
}

function exitWithResult() {
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
  process.exit(fails.length || errors.length ? 1 : 0);
}

export {
  HERE, ROOT, fs, path, os, http, spawn, execFileSync,
  writeImageFixture, writeAlphaImageFixture, freePort,
  devices, PORT, BASE, CFG, browser, ok, errors, want, trap, expecting,
  pollUntil, bgMatches, reportErrors, teardown, exitWithResult,
};
