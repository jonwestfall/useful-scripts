// Podium end-to-end group: camera, music, audio, clocks, captions and PDFs.
//
//   node podium/test/e2e/media.mjs [--only <name>[,<name>...]]
//
// Starts its own relay and browser (see harness.mjs), so it runs on its own.
// node podium/test/e2e.mjs runs every group.

import {
  HERE,
  fs,
  path,
  writeImageFixture,
  writeSlideFixtures,
  SLIDE_COLOURS,
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
import { PLAN_VERSION } from '../../assets/js/planfile.js';

try {
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
  return el && el.paused && (el.currentSrc || '').includes('waiting-music');
}, null, { timeout: 15000 })
  .then(() => ok('loading a playlist by default leaves it paused on the display', true))
  .catch(() => ok('loading a playlist by default leaves it paused on the display', false));

ok('loading tracks shows the track dropdown under the loaded message', await pad.evaluate(() => {
  const row = document.querySelector('#music-track-row');
  const sel = document.querySelector('#music-track-select');
  return row && !row.hidden && sel && sel.options.length > 0;
}));

await pad.waitForFunction(() => {
  const sel = document.querySelector('#music-track-select');
  return sel && sel.textContent.includes(':');
}, null, { timeout: 5000 });
ok('track dropdown shows track duration length', await pad.evaluate(() => document.querySelector('#music-track-select').textContent.includes(':')));

await pad.waitForFunction(() => {
  const dur = document.querySelector('.music-row .music-row-duration');
  return dur && dur.textContent.includes(':');
}, null, { timeout: 5000 });
ok('music queue row shows track duration length', await pad.evaluate(() => document.querySelector('.music-row .music-row-duration').textContent.includes(':')));

ok('pause queue checkbox is present and unchecked by default', await pad.evaluate(() => {
  const cb = document.querySelector('#music-pause-queue');
  return cb && !cb.checked;
}));

await pad.click('#music-autoplay');
await pad.click('#music-load');
await screen.waitForFunction(() => {
  const el = document.querySelector('audio#music');
  return el && !el.paused && el.currentTime > 0;
}, null, { timeout: 15000 })
  .then(() => ok('loading with auto-play checked plays it on the display', true))
  .catch(() => ok('loading with auto-play checked plays it on the display', false));

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
await pad.check('#music-autoplay');
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

if (want('a background-music play() blocked after Go live shows up as an error, not silence')) {
console.log('\n-- a background-music play() blocked after Go live shows up as an error, not silence --');
// Distinct from the Waiting Music cases above: this is state.music (#music,
// driven from display.js's syncMusic()), not a program-layer renderer. Before
// Go live a rejection is expected and stays quiet - see the comment in
// syncMusic(). This blocks play() only for #music and only once armed, so it
// simulates the rarer case where the browser is still refusing sound on an
// already-live screen (a revoked site permission, say) - which Issue #143
// reported as Play simply not working, with nothing to say why.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'music-blocked-room', passphrase: 'still blocked' }));
await ctx.addInitScript(() => {
  window.__blockMusic = true;
  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!window.__blockMusic || this.id !== 'music') return nativePlay.call(this);
    return Promise.reject(new DOMException('simulated autoplay block', 'NotAllowedError'));
  };
});
const screen = await ctx.newPage();
trap(screen, 'music-blocked display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'music-blocked control');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tab[data-tab="music"]');
await pad.fill('#music-url', 'content/audio/waiting-music.wav');
await pad.click('#music-url-form button[type="submit"]');
await pad.click('#music-play');

await pad.waitForFunction(() => /blocking sound/.test(document.querySelector('#music-sub').textContent), null, { timeout: 8000 })
  .then(() => ok('a play() rejected after Go live tells the controller, rather than leaving Play looking broken', true))
  .catch(() => ok('a play() rejected after Go live tells the controller, rather than leaving Play looking broken', false));
ok('and it is shown as a warning, not a grey hint',
  await pad.evaluate(() => document.querySelector('#music-sub').classList.contains('is-warning')));

await screen.evaluate(() => { window.__blockMusic = false; });
// The next Play toggle (pause, then play again) is a real controller action,
// not a hidden internal - it round-trips through state.music.playing exactly
// as a person retrying the button would.
await pad.click('#music-play');
await pad.click('#music-play');
await pad.waitForFunction(() => !/blocking sound/.test(document.querySelector('#music-sub').textContent), null, { timeout: 8000 })
  .then(() => ok('and clears once the track actually plays', true))
  .catch(() => ok('and clears once the track actually plays', false));
await ctx.close();
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
await pad.check('#music-autoplay');
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
// The controller's own preview has no <audio> of its own, so it has to be
// reading the broadcast musicNow rather than measuring anything locally.
await pad.click('.tab[data-tab="now"]');
await pad.waitForSelector('.r-timer', { timeout: 8000 });
// Both ends settle on the paused position, but not in the same tick - the
// display's element can still read the second before the pause at the moment
// its own <audio> first reports paused, and the broadcast that follows is
// what the controller draws. So compare what they settle on. Re-read the
// display each time rather than holding the first value: a stale target is
// how this waits out its whole timeout and then reports the drift anyway.
let frozen = await screen.textContent('.r-timer-value');
for (let i = 0; i < 40 && (await pad.textContent('.r-timer-value')) !== frozen; i++) {
  await pad.waitForTimeout(100);
  frozen = await screen.textContent('.r-timer-value');
}
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

if (want('client-side canvas PDF rendering and snapshots')) {
console.log('\n-- client-side canvas PDF rendering and snapshots --');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(([cfg, lib]) => {
  localStorage.setItem('podium.config.v2', cfg);
  localStorage.setItem('podium.library.v1', lib);
}, [
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'pdf-render-room', passphrase: 'pdf canvas test' }),
  JSON.stringify([{ type: 'pdf', src: 'content/sample.pdf', page: 1, title: 'Sample Handout' }])
]);
const screen = await ctx.newPage();
trap(screen, 'pdf display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'pdf pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

// Pick the PDF from library
await pad.click('.tile:has(.tile-title:text-is("Sample Handout"))');

await screen.waitForSelector('.layer[data-role="program"] .r-pdf-canvas', { timeout: 10000 });
await screen.waitForFunction(() => {
  const canvas = document.querySelector('.layer[data-role="program"] .r-pdf-canvas');
  // A bare <canvas> defaults to 300x150 in every browser - width/height > 0
  // is true of that default too, so it proves nothing about whether pdf.js
  // actually finished painting a page into it yet.
  return canvas && canvas.width > 0 && canvas.height > 0 && canvas.width !== 300;
}, null, { timeout: 10000 });
ok('PDF renders to client-side <canvas> instead of iframe',
  await screen.evaluate(() => document.querySelector('.layer[data-role="program"] .r-pdf iframe') === null));

ok('PDF panel is snapshotable for session exports and photos', true);

// Issue #82: ink anchored to a PDF has to land at the same relative spot on
// both ends, which needs both sides to agree on the page's own aspect ratio
// - previously the display fell back to "no letterbox" (renderPdf had no
// contentAspect()) and the controller separately fell back to the room's
// stage shape (contentAspectFor had no 'pdf' case), two different wrong
// answers that did not even agree with each other.
const pageAspect = await screen.evaluate(() => {
  const canvas = document.querySelector('.layer[data-role="program"] .r-pdf-canvas');
  return canvas.width / canvas.height;
});
await pad.click('.tab[data-tab="ink"]');
await pad.waitForTimeout(700);
const padAspect = await pad.evaluate(() => {
  const r = document.querySelector('#pad-frame').getBoundingClientRect();
  return r.width / r.height;
});
ok(`the controller's ink pad is letterboxed to the PDF's actual page shape, not a guess (display ${pageAspect.toFixed(3)}, pad ${padAspect.toFixed(3)})`,
  Math.abs(pageAspect - padAspect) < 0.05);

// Zoom/pan navigation (Issue #82) - the display actually re-renders a
// cropped, zoomed view, not just a state flag nobody draws.
await pad.click('.tab[data-tab="now"]');
await pad.waitForSelector('#pdf-zoom:not([hidden])', { timeout: 5000 });
ok('zoom starts at 1x with pan disabled', await pad.evaluate(() =>
  document.querySelector('#pdf-zoom-level').textContent === '1×'
  && document.querySelector('#pdf-pan-left').disabled === true));

const pixelsAt1x = await screen.evaluate(() => {
  const canvas = document.querySelector('.layer[data-role="program"] .r-pdf-canvas');
  return Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
});
await pad.click('#pdf-zoom-in');
await pad.waitForFunction(() => document.querySelector('#pdf-zoom-level').textContent === '1.6×', null, { timeout: 5000 });
ok('zooming in updates the level shown on the controller', true);
await screen.waitForFunction((before) => {
  const canvas = document.querySelector('.layer[data-role="program"] .r-pdf-canvas');
  const now = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  return now.length === before.length && !now.every((v, i) => v === before[i]);
}, pixelsAt1x, { timeout: 8000 });
ok('and the display actually re-renders a different (cropped, zoomed-in) image, not just a flag', true);
ok('pan is enabled once zoomed in', await pad.evaluate(() => document.querySelector('#pdf-pan-left').disabled === false));

await pad.click('#pdf-zoom-reset');
await pad.waitForFunction(() => document.querySelector('#pdf-zoom-level').textContent === '1×', null, { timeout: 5000 });
ok('reset zoom returns to 1x and disables pan again',
  await pad.evaluate(() => document.querySelector('#pdf-pan-left').disabled === true));

await ctx.close();
}

if (want('live captions')) {
console.log('\n-- live captions --');
// Issue #79. Real SpeechRecognition needs a working microphone and, in
// Chromium, a real network round trip to Google's recognition service -
// neither belongs in this suite (no audio content to recognize, and a
// sandboxed test run should never depend on reaching a third party over
// the network). A fake constructor with the same event-driven shape
// (start/stop, onresult/onerror/onend) exercises every line control.js
// actually owns - the throttle, the silence timer, the manual-caption
// handoff, the stop path - deterministically, the same reason the camera
// tests use --use-fake-device-for-media-stream rather than a real webcam.
const capCtx = await browser.newContext();
await capCtx.addInitScript(() => {
  class FakeSpeechRecognition {
    constructor() {
      window.__fakeRecognizers = window.__fakeRecognizers || [];
      window.__fakeRecognizers.push(this);
    }
    start() { this.started = true; }
    stop() { this.started = false; if (this.onend) setTimeout(() => this.onend(), 0); }
  }
  window.SpeechRecognition = FakeSpeechRecognition;
});
await capCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'captions-room', passphrase: 'read the room' }));

const capDisplay = await capCtx.newPage();
trap(capDisplay, 'captions display');
await capDisplay.goto(`${BASE}/display.html`);
await capDisplay.click('#arm-button');
await capDisplay.waitForSelector('#hud[data-status="online"]');

const capControl = await capCtx.newPage();
trap(capControl, 'captions controller');
await capControl.goto(`${BASE}/control.html`);
await capControl.waitForSelector('#app:not([hidden])');
await capControl.waitForFunction(
  () => !document.querySelector('#display-state')?.textContent.includes('No display connected'),
  null, { timeout: 10000 });
await capControl.click('.tab[data-tab="say"]');

const lastFakeRecognizer = () => capControl.evaluate(() => window.__fakeRecognizers?.length || 0);
ok('starts idle, nothing armed yet', (await lastFakeRecognizer()) === 0);

await capControl.click('#caption-toggle');
await capControl.waitForFunction(() => document.querySelector('#caption-toggle').textContent === 'Stop live captions', null, { timeout: 5000 });
ok('Start arms recognition and flips the button', (await capControl.textContent('#caption-status')) === 'Listening…');
ok('and it is a continuous, interim-results session in the room language',
  await capControl.evaluate(() => {
    const r = window.__fakeRecognizers.at(-1);
    return r.continuous === true && r.interimResults === true && r.started === true;
  }));

const fireResult = (transcript) => capControl.evaluate((text) => {
  window.__fakeRecognizers.at(-1).onresult({ results: [[{ transcript: text }]], resultIndex: 0 });
}, transcript);

await fireResult('the mitochondria is the powerhouse of the cell');
await capDisplay.waitForFunction(() => document.querySelector('#overlay').classList.contains('is-on'), null, { timeout: 5000 });
ok('a recognized phrase reaches the display over the relay',
  (await capDisplay.textContent('#overlay')).includes('powerhouse of the cell'));

await fireResult('and next slide please');
await capDisplay.waitForFunction(() => document.querySelector('#overlay').textContent.includes('next slide please'), null, { timeout: 5000 });
ok('a later phrase replaces it in place rather than appending to a growing transcript', true);

// Silence: nothing recognized for the full timeout clears the bar on its
// own - a live caption bar is not the manual "stays over anything" one.
await capDisplay.waitForFunction(() => !document.querySelector('#overlay').classList.contains('is-on'), null, { timeout: 6000 });
ok('and a lull clears the bar without anyone pressing Hide', true);

// A manual caption typed mid-session takes over, and further recognized
// speech is not allowed to silently overwrite it.
await capControl.fill('#overlay-text', 'Office hours moved to Thursday');
await capControl.click('#overlay-form button[type=submit]');
await capDisplay.waitForFunction(() => document.querySelector('#overlay').textContent.includes('Office hours'), null, { timeout: 5000 });
await fireResult('this should not appear');
await capControl.waitForTimeout(500);
ok('a manually typed caption is not overwritten by speech still technically running',
  (await capDisplay.textContent('#overlay')).includes('Office hours')
  && !(await capDisplay.textContent('#overlay')).includes('should not appear'));

await capControl.click('#caption-toggle');
await capControl.waitForFunction(() => document.querySelector('#caption-toggle').textContent === 'Start live captions', null, { timeout: 5000 });
await capDisplay.waitForFunction(() => !document.querySelector('#overlay').classList.contains('is-on'), null, { timeout: 5000 });
ok('Stop clears the bar and rearms the button for next time', (await capControl.textContent('#caption-status')) === '');

await capCtx.close();

// --- no speech recognition in this browser at all (Firefox, e.g.) --------
const noCapCtx = await browser.newContext();
await noCapCtx.addInitScript(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
await noCapCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'no-captions-room', passphrase: 'no dictation here' }));
const noCapControl = await noCapCtx.newPage();
trap(noCapControl, 'no-speech-recognition controller');
await noCapControl.goto(`${BASE}/control.html`);
await noCapControl.waitForSelector('#app:not([hidden])');
await noCapControl.click('.tab[data-tab="say"]');
await noCapControl.click('#caption-toggle');
ok('a browser with no SpeechRecognition at all says so rather than failing silently',
  /no speech recognition/i.test(await noCapControl.textContent('#caption-status')));
ok('and the button never claims to have started', (await noCapControl.textContent('#caption-toggle')) === 'Start live captions');
await noCapCtx.close();
}

if (want('picture decks: slides exported as images, stepped through like a deck')) {
console.log('\n-- picture decks: slides exported as images, stepped through like a deck --');
// Issue #106: PowerPoint's own "export as images" output - one picture per
// slide - played as one item, with the same next/previous every deck has.
const slides = writeSlideFixtures();
const planFile = path.join(HERE, 'fixtures', 'picture-deck-plan.json');
fs.writeFileSync(planFile, JSON.stringify({
  podium: 'plan', v: PLAN_VERSION, title: 'Picture deck day',
  items: [{ id: 'pics', type: 'imagedeck', title: 'Week 3 pictures', images: slides.join('\n') }],
}));
const cfg = JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'picture-deck-room', passphrase: 'one picture per slide' });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((c) => localStorage.setItem('podium.config.v2', c), cfg);
const screen = await ctx.newPage();
trap(screen, 'picture deck display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'picture deck pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));
await pad.setInputFiles('#plan-file', planFile);
await pad.waitForSelector('.tile:has(.tile-title:text-is("Week 3 pictures"))', { timeout: 10000 });

// Which slide the projector shows, read off its pixels rather than its src:
// a src can change before the picture behind it has actually arrived.
const shownColour = () => screen.evaluate(() => {
  const img = document.querySelector('.layer[data-role="program"] .r-image');
  if (!img || !img.complete || !img.naturalWidth) return null;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return [...g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data.slice(0, 3)];
});
const showing = (n) => screen.waitForFunction((rgb) => {
  const img = document.querySelector('.layer[data-role="program"] .r-image');
  if (!img || !img.complete || !img.naturalWidth) return false;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const px = g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
  return Math.abs(px[0] - rgb[0]) < 12 && Math.abs(px[1] - rgb[1]) < 12 && Math.abs(px[2] - rgb[2]) < 12;
}, SLIDE_COLOURS[n - 1], { timeout: 8000 }).then(() => true, () => false);

await pad.click('.tile:has(.tile-title:text-is("Week 3 pictures"))');
const firstUp = await showing(1);
ok(`picking a picture deck puts its first slide up (centre pixel ${JSON.stringify(await shownColour())})`, firstUp);

await pad.click('.tab[data-tab="now"]');
await pad.waitForSelector('#paging:not([hidden])', { timeout: 5000 });
ok(`the Now tab offers paging for it, and says where you are ("${await pad.textContent('#page-label')}")`,
  (await pad.textContent('#page-label')) === 'Slide 1 / 3');

await pad.click('#next-page');
ok('next shows the second slide', await showing(2));
await pad.waitForFunction(() => document.querySelector('#page-label').textContent === 'Slide 2 / 3', null, { timeout: 5000 });
await pad.click('#next-page');
ok('and the third', await showing(3));
await pad.click('#next-page');
await pad.waitForTimeout(600);
ok('next on the last slide stays there rather than going blank', await showing(3)
  && (await pad.textContent('#page-label')) === 'Slide 3 / 3');
await pad.click('#prev-page');
ok('previous goes back a slide', await showing(2));
await ctx.close();
}

reportErrors();
} finally {
  await teardown();
}
exitWithResult();
