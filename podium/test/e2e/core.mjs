// Podium end-to-end group: switching, connection, settings, offline and the display basics.
//
//   node podium/test/e2e/core.mjs [--only <name>[,<name>...]]
//
// Starts its own relay and browser (see harness.mjs), so it runs on its own.
// node podium/test/e2e.mjs runs every group.

import {
  HERE,
  ROOT,
  fs,
  path,
  writeImageFixture,
  freePort,
  devices,
  PORT,
  BASE,
  CFG,
  browser,
  ok,
  want,
  trap,
  bgMatches,
  reportErrors,
  teardown,
  exitWithResult
} from './harness.mjs';

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg), CFG);

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
await setupPad.click('#text-open-editor');
await setupPad.fill('#msg-body', 'Before the presenter arrives');
await setupPad.click('#message-editor-show');
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
ok('all presentation options default on (including haptics)',
  (await pad.isChecked('#pref-poll-url')) && (await pad.isChecked('#pref-blank-on-connect')) && (await pad.isChecked('#pref-keep-awake')) && (await pad.isChecked('#pref-haptics')));

await pad.uncheck('#pref-keep-awake');
await pad.waitForFunction(() => window.__wakeLog.includes('release'), null, { timeout: 5000 });
ok('unchecking Keep awake actually releases the lock, not just the checkbox', true);
await pad.check('#pref-keep-awake');
await pad.waitForFunction(() => window.__wakeLog.filter((s) => s === 'request:screen').length >= 2, null, { timeout: 5000 });
ok('and re-checking it requests a fresh one', true);

await pad.uncheck('#pref-haptics');
ok('unchecking haptics persists to presentation preferences',
  await pad.evaluate(() => JSON.parse(localStorage.getItem('podium.presentation.v1')).haptics === false));
await pad.check('#pref-haptics');

await pad.uncheck('#pref-poll-url');
ok('a preference is saved the moment it changes, with no Save button of its own',
  await pad.evaluate(() => JSON.parse(localStorage.getItem('podium.presentation.v1')).showPollUrl === false));

ok('theme defaults to dark', await pad.evaluate(() => (document.documentElement.dataset.theme || 'dark') === 'dark'));
await pad.selectOption('#pref-theme', 'light');
ok('picking light theme applies data-theme="light" immediately and persists',
  await pad.evaluate(() => document.documentElement.dataset.theme === 'light' && JSON.parse(localStorage.getItem('podium.presentation.v1')).theme === 'light'));
await pad.selectOption('#pref-theme', 'dark');

// Controller tabs (Issue #76): hide one, reorder another, and check both the
// main tab bar and the "More" menu actually reflect it - not just the saved
// preference, which the unit tests in tabsettings.test.mjs already cover.
// #app (the live tab bar) is hidden behind #setup while Settings is open
// (see showSetup()), so the parts of this that click the live bar happen
// after closing it, same as the poll-url re-check further down does.
ok('the tab order settings list has one row per tab',
  await pad.evaluate(() => document.querySelectorAll('#tab-order-list .tab-order-row').length === 12));

await pad.uncheck('.tab-order-row:has-text("Camera") input[type=checkbox]');
ok('hiding a tab persists to presentation preferences',
  await pad.evaluate(() => JSON.parse(localStorage.getItem('podium.presentation.v1')).hiddenTabs.includes('camera')));
ok('and the Camera tab itself is marked hidden, reading its own attribute rather than what is visible right now',
  await pad.evaluate(() => document.querySelector('.tab[data-tab="camera"]').hidden === true));

const orderBefore = await pad.$$eval('.tabs .tab[data-tab]', (els) => els.map((e) => e.dataset.tab));
await pad.click('.tab-order-row:has-text("Slides") .tab-order-move button:first-child');
const orderAfter = await pad.$$eval('.tabs .tab[data-tab]', (els) => els.map((e) => e.dataset.tab));
ok(`moving Slides up actually reorders the live tab bar (${orderBefore.join(',')} -> ${orderAfter.join(',')})`,
  orderAfter[0] === 'slides' && orderAfter[1] === 'library' && orderAfter.length === orderBefore.length);

await pad.click('#setup-close');
await pad.waitForSelector('#app:not([hidden])', { timeout: 15000 });
ok('"More" appears now that Camera is really out of the bar', await pad.isVisible('#tabs-more'));

await pad.click('#tabs-more');
ok('More lists the hidden tab by name', await pad.evaluate(() =>
  Array.from(document.querySelectorAll('#tabs-more-menu button')).some((b) => b.textContent === 'Camera')));
await pad.click('#tabs-more-menu button:has-text("Camera")');
ok('picking it from the menu actually switches to it, same as tapping a visible tab would',
  await pad.evaluate(() => !document.querySelector('[data-panel="camera"]').hidden));
ok('and closes the menu behind it', await pad.isHidden('#tabs-more-menu'));

// Undo both changes, the same courtesy the poll-url re-check below pays -
// nothing later in this run should have to know a tab was ever hidden or moved.
await pad.click('#open-settings');
await pad.click('.settings-tabs .tab[data-settings-tab="presentation"]');
await pad.check('.tab-order-row:has-text("Camera") input[type=checkbox]');
await pad.click('.tab-order-row:has-text("Slides") .tab-order-move button:nth-child(2)');
ok('restored order and visibility match what the bar shipped with', await pad.evaluate(() => {
  const p = JSON.parse(localStorage.getItem('podium.presentation.v1'));
  return !p.hiddenTabs.includes('camera') && p.tabOrder[0] === 'library' && p.tabOrder[1] === 'slides';
}));
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
  ok('and the release it is, beside it', /^\d+\.\d+$/.test((await screen.textContent('#version-number')).trim()));
  // The gap this closes: the controller could tell you the DISPLAY's build,
  // and only while one was connected, but never said a word about its own.
  // It is the device in your hand and the one a bug report comes from.
  await pad.click('#open-settings');
  await pad.waitForSelector('#control-build');
  const ownLine = (await pad.textContent('#control-build')).trim();
  ok(`the controller states its own version and build in Settings ("${ownLine.split('\n')[0].trim()}")`,
    /^\d+\.\d+$/.test((await pad.textContent('#control-version')).trim())
    && /^\d+$/.test((await pad.textContent('#control-build-number')).trim()));
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
      try {
        const res = await route.fetch();
        if (route.request().resourceType() === 'script') {
          await route.fulfill({ response: res, body: (await res.text()).replace(/export const BUILD = \d+;/, 'export const BUILD = 1;') });
          return;
        }
        await route.fulfill({ response: res });
      } catch { /* ignore disposed */ }
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

if (want('long presenter notes do not hijack the Slides tab scroll')) {
console.log('\n-- long presenter notes do not hijack the Slides tab scroll --');
// Issue #95: on an iPhone, a slide with a lot of presenter text pushed the
// "jump to a slide" thumbnail grid (and its section chips) far down the
// panel. Both auto-scroll-to-active-item to keep them in view, but neither
// used to remember having already done so - every re-render (a heartbeat,
// a build step within the same slide) fired scrollIntoView again, undoing
// a presenter's own manual scroll back up to read notes or reach Prev/
// Next a moment later. Reproduced on an actual iPhone-sized viewport,
// against the shape of deck that triggers it: three slides each with their
// own heading (so there is more than one section chip to jump between),
// the middle one with several build fragments and presenter notes long
// enough to force real scrolling.
const notesParagraph = 'This is the kind of long presenter note a real lecture slide carries - a full talking-track paragraph, not a one-line reminder, repeated here just to force the notes box tall enough to actually need scrolling. ';
const longNotes = notesParagraph.repeat(10);
const notesFixture = path.join(HERE, 'fixtures', 'long-presenter-notes.md');
fs.writeFileSync(notesFixture, [
  '---', 'marp: true', 'paginate: true', '---', '',
  '# Opening', '', 'Welcome to class.', '',
  '---', '<!-- _class: build -->',
  '# The Main Point', '',
  '- First idea', '- Second idea', '- Third idea', '',
  '<!--', longNotes, '-->', '',
  '---',
  '# Wrap Up', '', 'Thanks for coming.', '',
].join('\n'));

const notesCtx = await browser.newContext({ ...devices['iPhone 13'] });
await notesCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'notes-scroll-room', passphrase: 'read the room, not the scrollbar' }));

const notesDisplay = await notesCtx.newPage();
trap(notesDisplay, 'notes-scroll display');
await notesDisplay.goto(`${BASE}/display.html`);
await notesDisplay.click('#arm-button');
await notesDisplay.waitForSelector('#hud[data-status="online"]');

const notesControl = await notesCtx.newPage();
trap(notesControl, 'notes-scroll controller (iPhone)');
await notesControl.goto(`${BASE}/control.html`);
await notesControl.waitForSelector('#app:not([hidden])');
await notesControl.waitForFunction(
  () => !document.querySelector('#display-state')?.textContent.includes('No display connected'),
  null, { timeout: 10000 });

await notesControl.setInputFiles('#deck-file', notesFixture);
await notesControl.waitForFunction(() => document.querySelector('#deck-file-note')?.textContent.includes('3 slides'), null, { timeout: 15000 });
await notesControl.click('.tab[data-tab="slides"]');
await notesControl.click('#deck-next');
await notesControl.waitForFunction(() => document.querySelector('#deck-count')?.textContent.startsWith('Slide 2'), null, { timeout: 10000 });
await notesControl.waitForFunction(() => (document.querySelector('#deck-notes')?.textContent.length || 0) > 500, null, { timeout: 10000 });

const panelsOverflow = await notesControl.evaluate(() => {
  const p = document.querySelector('.panels');
  return p.scrollHeight - p.clientHeight;
});
ok(`the long notes actually overflow the panel on this device (${panelsOverflow}px)`, panelsOverflow > 100);

// A real click auto-scrolls its own target into view as part of Playwright's
// actionability checks - that would contaminate exactly the measurement
// this test is making, so #deck-next is clicked in-page instead, the same
// way a real tap does not scroll anything on its own.
const clickDeckNext = () => notesControl.evaluate(() => document.querySelector('#deck-next').click());

await clickDeckNext(); // onto slide 2's own build fragments
await notesControl.waitForFunction(() => document.querySelector('#deck-count')?.textContent.includes('build 1'), null, { timeout: 10000 });

// The presenter scrolls back up to read notes / reach Prev-Next, exactly
// the recovery the bug report describes ("pulling down from the gutter
// allows you to scroll back up temporarily").
await notesControl.evaluate(() => { document.querySelector('.panels').scrollTop = 0; });
ok('scrolled back to the top manually', (await notesControl.evaluate(() => document.querySelector('.panels').scrollTop)) === 0);

// Advance through the rest of this slide's build fragments (three bullets,
// so 1/3 -> 2/3 -> 3/3) - same slide, same section, nothing that should
// re-arm either auto-scroll.
for (let i = 0; i < 2; i++) await clickDeckNext();
await notesControl.waitForFunction(() => document.querySelector('#deck-count')?.textContent.includes('build 3'), null, { timeout: 10000 });
ok('advancing through the rest of the slide\'s own builds does not creep the scroll back down',
  (await notesControl.evaluate(() => document.querySelector('.panels').scrollTop)) === 0);

// A genuine slide change (a new section) is still allowed to follow once -
// this is a guard against repeating, not a ban on the feature.
await clickDeckNext(); // onto slide 3, a new section
await notesControl.waitForFunction(() => document.querySelector('#deck-count')?.textContent.startsWith('Slide 3'), null, { timeout: 10000 });
await notesControl.waitForTimeout(500); // the scrollIntoView above is smooth, not instant
ok('a genuine slide/section change is still followed once, unlike the repeated re-fire this fixes',
  (await notesControl.evaluate(() => document.querySelector('.panels').scrollTop)) > 0);

await notesCtx.close();
}

if (want('Settings Save/Close reachable on a phone')) {
console.log('\n-- Settings Save/Close reachable on a phone --');
// Issue #96: the Settings sheet is long enough that on a phone, reaching
// Save or Close means scrolling past all of it. A copy near the top,
// shown only under the same max-width:640px breakpoint the rest of the
// controller's own mobile layout already uses, calls the exact same
// handlers rather than duplicating the save/close logic.
const smallCtx = await browser.newContext({ ...devices['iPhone 13'] });
await smallCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'settings-top-room', passphrase: 'reach it without scrolling' }));
const small = await smallCtx.newPage();
trap(small, 'settings top actions (iPhone)');
await small.goto(`${BASE}/control.html`);
await small.waitForSelector('#app:not([hidden])');

await small.click('#open-settings');
await small.waitForSelector('#setup:not([hidden])');
ok('the top actions row is shown on a phone-width screen', await small.isVisible('.setup-top-actions'));
ok('Save is visible by default (Connection is the starting tab)', await small.isVisible('#setup-save-top'));
ok('Close is offered too, same as the one at the bottom, while this device is configured',
  await small.isVisible('#setup-close-top') && await small.isVisible('#setup-close'));

await small.click('.tab[data-settings-tab="presentation"]');
ok('Save hides on the Presentation tab - there is nothing there to submit', await small.isHidden('#setup-save-top'));
await small.click('.tab[data-settings-tab="connection"]');
ok('and comes back on Connection', await small.isVisible('#setup-save-top'));

// The top Save button reaches the SAME form validation as the real one -
// not a silent no-op, and not a second copy of the check.
await small.fill('#c-pass', '');
await small.click('#setup-save-top');
ok('the top Save button runs the real form validation, not a shortcut around it',
  (await small.textContent('#setup-error')).includes('Fill in the fields'));
ok('and does not navigate away on a rejected save', await small.isVisible('#setup:not([hidden])'));

await Promise.all([small.waitForNavigation({ timeout: 15000 }), small.click('#setup-close-top')]);
await small.waitForSelector('#app:not([hidden])', { timeout: 15000 });
ok('the top Close button reloads back to the app, same as the bottom one', true);

// A normal (non-phone) viewport never shows this row at all - the real
// Save/Close are already in easy reach down there.
await small.setViewportSize({ width: 1280, height: 900 });
await small.click('#open-settings');
await small.waitForSelector('#setup:not([hidden])');
ok('and stays hidden on a screen wide enough not to need it', await small.isHidden('.setup-top-actions'));

await smallCtx.close();
}

if (want('full-screen message editor')) {
console.log('\n-- full-screen message editor (Issue #103) --');
// The Say tab's old plain textarea+size form is now a "Compose a
// message..." button that opens a real editor - headings, bulleted or
// numbered lists, a font, a background colour and an inline picture with
// caption - previewed live with the projector's own renderer before any
// of it reaches the display.
const msgCtx = await browser.newContext();
await msgCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'message-editor-room', passphrase: 'compose it first' }));

const msgScreen = await msgCtx.newPage();
trap(msgScreen, 'message editor display');
await msgScreen.goto(`${BASE}/display.html`);
await msgScreen.click('#arm-button');
await msgScreen.waitForSelector('#hud[data-status="online"]');

const msgPad = await msgCtx.newPage();
trap(msgPad, 'message editor pad');
await msgPad.goto(`${BASE}/control.html`);
await msgPad.waitForSelector('.tile');
await msgPad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));
await msgPad.click('.tab[data-tab="say"]');

ok('the Say tab offers a Compose button rather than a bare textarea', await msgPad.isVisible('#text-open-editor'));
await msgPad.click('#text-open-editor');
await msgPad.waitForSelector('#message-editor:not([hidden])');
ok('opening it shows the editor sheet', await msgPad.isVisible('#message-editor .card'));

const msgImage = writeImageFixture();
await msgPad.fill('#msg-body', '# Group work\nCompare your two coding schemes\n\n1. Read the prompt\n2. Discuss in pairs');
await msgPad.selectOption('#msg-size', 's');
await msgPad.selectOption('#msg-align', 'left');
await msgPad.selectOption('#msg-font', 'display');
await msgPad.click('#msg-bg-swatches .bg-swatch[title="Navy"]');
await msgPad.setInputFiles('#msg-image', msgImage);
await msgPad.waitForFunction(() => /attached/.test(document.querySelector('#msg-image-note')?.textContent || ''), null, { timeout: 10000 });
await msgPad.fill('#msg-caption', 'Figure 1: the setup');

const liveHtml = await msgPad.innerHTML('#message-preview-box');
ok('the live preview is the projector\'s own renderer, updated as you type - heading', /<h1>Group work<\/h1>/.test(liveHtml));
ok('...a numbered list', /<ol class="mini-md-list"><li>Read the prompt<\/li><li>Discuss in pairs<\/li><\/ol>/.test(liveHtml));
ok('...the chosen font', (await msgPad.getAttribute('#message-preview-box .r-text', 'data-font')) === 'display');
ok('...the chosen size', (await msgPad.getAttribute('#message-preview-box .r-text', 'data-size')) === 's');
ok('...the chosen background', await bgMatches(msgPad, '#message-preview-box .r-text', '#0b1e3d'));
ok('...the picture', !!(await msgPad.getAttribute('#message-preview-box .r-text-image', 'src')));
ok('...and its caption', (await msgPad.textContent('#message-preview-box .r-text-caption')).includes('Figure 1: the setup'));
ok('picking a preset swatch marks it selected, not the custom picker',
  (await msgPad.evaluate(() => document.querySelector('.bg-swatch[title="Navy"]').classList.contains('is-on')))
  && !(await msgPad.evaluate(() => document.querySelector('#msg-bg-custom-label').classList.contains('is-on'))));

// The custom colour picker is a real alternative to the presets, not a dead end.
await msgPad.evaluate(() => {
  const input = document.querySelector('#msg-bg-custom');
  input.value = '#552266';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
ok('a custom colour deselects every preset swatch',
  await msgPad.evaluate(() => ![...document.querySelectorAll('.bg-swatch')].some((b) => b.classList.contains('is-on'))));
ok('and switches the custom picker on instead', await msgPad.evaluate(() => document.querySelector('#msg-bg-custom-label').classList.contains('is-on')));
ok('the preview reflects the custom colour', await bgMatches(msgPad, '#message-preview-box .r-text', '#552266'));

// Cancel closes without staging anything to the projector.
await msgPad.click('#message-editor-cancel');
ok('Cancel closes the editor', await msgPad.isHidden('#message-editor'));
ok('and nothing was staged - the display still has no message', !(await msgScreen.evaluate(() => !!document.querySelector('.layer[data-role="program"] .r-text'))));

// Escape does the same.
await msgPad.click('#text-open-editor');
await msgPad.waitForSelector('#message-editor:not([hidden])');
await msgPad.keyboard.press('Escape');
ok('Escape closes the editor too', await msgPad.isHidden('#message-editor'));
ok('still nothing staged', !(await msgScreen.evaluate(() => !!document.querySelector('.layer[data-role="program"] .r-text'))));

// Clicking the backdrop, outside the card, does the same.
await msgPad.click('#text-open-editor');
await msgPad.waitForSelector('#message-editor:not([hidden])');
await msgPad.click('#message-editor', { position: { x: 4, y: 4 } });
ok('clicking outside the card closes it without staging',
  (await msgPad.isHidden('#message-editor')) && !(await msgScreen.evaluate(() => !!document.querySelector('.layer[data-role="program"] .r-text'))));

// Show actually stages it, and what lands on the projector is exactly what
// the preview promised - same renderer, same fields, all the way from the
// editor's form fields to normalizeItem's 'text' branch to the display.
await msgPad.click('#text-open-editor');
await msgPad.waitForSelector('#message-editor:not([hidden])');
await msgPad.click('#message-editor-show');
ok('Show closes the editor', await msgPad.isHidden('#message-editor'));
await msgScreen.waitForSelector('.layer[data-role="program"] .r-text', { timeout: 5000 });
const onScreen = await msgScreen.innerHTML('.layer[data-role="program"] .r-text');
ok('the heading reaches the projector', /<h1>Group work<\/h1>/.test(onScreen));
ok('the numbered list reaches the projector', /<ol class="mini-md-list"><li>Read the prompt<\/li><li>Discuss in pairs<\/li><\/ol>/.test(onScreen));
ok('the picture and caption reach the projector',
  !!(await msgScreen.getAttribute('.layer[data-role="program"] .r-text-image', 'src'))
  && (await msgScreen.textContent('.layer[data-role="program"] .r-text-caption')).includes('Figure 1: the setup'));
ok('the font/size/background reach the projector, the same values chosen in the editor',
  (await msgScreen.getAttribute('.layer[data-role="program"] .r-text', 'data-font')) === 'display'
  && (await msgScreen.getAttribute('.layer[data-role="program"] .r-text', 'data-size')) === 's'
  && await bgMatches(msgScreen, '.layer[data-role="program"] .r-text', '#552266'));

await msgCtx.close();
}

if (want('a local-storage write failure shows a warning on both control and display')) {
console.log('\n-- Issue #116: a failed local save is surfaced, not silent --');
// Storage.prototype.setItem is patched to throw for every page in this
// context - the same shape of failure quota or private browsing produces -
// so this proves the actual banner, not just that safeStorageSet caught
// something somewhere.
const failCtx = await browser.newContext();
await failCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'storage-fail-room', passphrase: 'nothing is actually being kept' }));
await failCtx.addInitScript(() => {
  Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
});

const failScreen = await failCtx.newPage();
trap(failScreen, 'storage-fail display');
await failScreen.goto(`${BASE}/display.html`);
await failScreen.click('#arm-button');
await failScreen.waitForSelector('#hud[data-status="online"]');
ok('the display banner is not shown before anything has actually failed to save',
  await failScreen.evaluate(() => document.querySelector('#storage-warn').hidden));

const failPad = await failCtx.newPage();
trap(failPad, 'storage-fail pad');
await failPad.goto(`${BASE}/control.html`);
await failPad.waitForSelector('.tile');
await failPad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

// Nothing is live yet, so picking a tile puts it straight on screen -
// changing display's state, which schedules its debounced crash-recovery
// snapshot (saveStateSoon -> saveStateNow, 1200ms).
await failPad.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await failScreen.waitForSelector('.r-whiteboard');
await failScreen.waitForFunction(() => !document.querySelector('#storage-warn').hidden, null, { timeout: 5000 });
ok('the display shows its own banner once its crash-recovery save actually fails', true);

// A plain write on the controller (preview-toggle persists whether the cue
// bar is shown) exercises the same safeStorageSet() path there, independently.
await failPad.click('#preview-toggle');
await failPad.waitForFunction(() => !document.querySelector('#storage-warning').hidden, null, { timeout: 5000 });
ok('the controller shows its own banner too, not borrowed from the display', true);
ok('with a real, specific detail line, not just "something is wrong"',
  /reload or crash/.test(await failPad.textContent('#storage-warning-detail')));

await failCtx.close();
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

reportErrors();
} finally {
  await teardown();
}
exitWithResult();
