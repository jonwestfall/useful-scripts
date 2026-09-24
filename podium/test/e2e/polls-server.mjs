// Podium end-to-end group: polls, plans, accounts and multi-device rooms.
//
//   node podium/test/e2e/polls-server.mjs [--only <name>[,<name>...]]
//
// Starts its own relay and browser (see harness.mjs), so it runs on its own.
// node podium/test/e2e.mjs runs every group.

import {
  HERE,
  ROOT,
  fs,
  path,
  os,
  http,
  spawn,
  execFileSync,
  writeImageFixture,
  writeSlideFixtures,
  writeMinimalPptxFixture,
  SLIDE_COLOURS,
  freePort,
  PORT,
  BASE,
  browser,
  ok,
  want,
  trap,
  expecting,
  pollUntil,
  bgMatches,
  reportErrors,
  teardown,
  exitWithResult
} from './harness.mjs';
import { createZip } from '../../assets/js/zip.js';

try {
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

// Issue #103: headings, lists, a font choice, a background colour and an
// inline picture with caption, all editable from a declarative field list
// (see PLAN_TYPES.text in planfile.js) with no new editor code of its own.
await desk.fill('#item-fields textarea', '# Group work\nCompare your two coding schemes\n\n- Step one\n- Step two');
let richPreview = await desk.innerHTML('#item-preview');
ok('a heading in the body renders as a real heading, not a plain line', /<h1>Group work<\/h1>/.test(richPreview));
ok('and a bullet list renders as a real list, not <br>-joined text',
  /<ul class="mini-md-list"><li>Step one<\/li><li>Step two<\/li><\/ul>/.test(richPreview));

await desk.locator('#item-fields select').nth(2).selectOption('mono'); // size, align, font
ok('the chosen font reaches the preview', (await desk.getAttribute('#item-preview .r-text', 'data-font')) === 'mono');

await desk.fill('#item-fields input[type=color]', '#224466');
ok('a background colour reaches the preview, the same renderer style the display will use',
  await bgMatches(desk, '#item-preview .r-text', '#224466'));

await desk.setInputFiles('#item-fields input[type=file]', photoFile);
await desk.waitForFunction(() => /after resizing/.test(document.body.textContent), null, { timeout: 20000 });
await desk.locator('#item-fields input[type=text]').last().fill('Figure 1: the setup');
await desk.waitForFunction(() => !!document.querySelector('#item-preview .r-text-image')?.getAttribute('src'), null, { timeout: 10000 });
ok('the uploaded picture shows in the preview, not just a filename', !!(await desk.getAttribute('#item-preview .r-text-image', 'src')));
ok('and its caption underneath', (await desk.textContent('#item-preview .r-text-caption')).includes('Figure 1: the setup'));

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

// Issue #109: which pane the controller focuses once auto-launch has staged
// everything, editable right alongside where each pane itself is set up.
// After planJson above, so nothing here is baked into the file that gets
// loaded on the tablet later in this section.
await desk.click('#plan-layout .layout-btn[data-layout="2h"]');
await desk.check('#plan-autolaunch-enable');
await desk.waitForSelector('#plan-autolaunch-panes .autolaunch-pane-card');
ok('with more than one pane, each offers a way to make it the one that starts focused',
  (await desk.$$('.autolaunch-pane-active')).length === 2);
ok('pane A is the default', await desk.evaluate(() => document.querySelectorAll('.autolaunch-pane-active')[0].classList.contains('is-on')));

await desk.locator('.autolaunch-pane-active').nth(1).click();
ok('picking pane B moves the choice there, not both at once', await desk.evaluate(() => {
  const btns = document.querySelectorAll('.autolaunch-pane-active');
  return !btns[0].classList.contains('is-on') && btns[1].classList.contains('is-on');
}));

// Shrinking back to one pane leaves nothing to choose between.
await desk.click('#plan-layout .layout-btn[data-layout="single"]');
ok('and with a single pane the button disappears entirely, not just the extra ones',
  (await desk.$$('.autolaunch-pane-active')).length === 0);

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

// Auto-launch on plan load (Issue #52)
const autoPlanFile = path.join(HERE, 'fixtures', 'e2e-autolaunch-plan.podium.json');
fs.writeFileSync(autoPlanFile, JSON.stringify({
  podium: 'plan',
  v: 1,
  title: 'Auto-launch demo',
  layout: '2h',
  timers: [{ id: 't-intro', label: 'Intro Countdown', mins: 3 }],
  items: [
    { id: 'i-welcome', type: 'text', title: 'Welcome sign', body: 'Welcome to Class' },
    { id: 'i-note', type: 'text', title: 'Panel B note', body: 'Group work starts now' },
  ],
  autoLaunch: {
    enabled: true,
    initialState: 'live',
    // Issue #109: which pane the controller's own picker focuses once
    // everything above has landed - here, deliberately not A, so this
    // actually proves the choice rather than matching the default.
    activePane: 'B',
    panes: {
      A: { type: 'item', itemId: 'i-welcome' },
      B: { type: 'item', itemId: 'i-note' },
    },
    timer: {
      timerId: 't-intro',
    },
  },
}));

await pad.setInputFiles('#plan-file', autoPlanFile);
await pad.waitForFunction(() => document.querySelector('#library h3.group')?.textContent === 'Auto-launch demo', null, { timeout: 20000 });
await screen.waitForFunction(() => {
  const t = document.querySelector('.layer[data-role="program"] .r-text');
  return t && /Welcome to Class/.test(t.textContent);
}, null, { timeout: 15000 });
ok('auto-launch puts initial item live on screen upon plan load', true);
await screen.waitForFunction(() => {
  const t = document.querySelector('[data-panel="b"] .r-text');
  return t && /Group work starts now/.test(t.textContent);
}, null, { timeout: 15000 });
ok('and stages panel B at the same time, from the same plan', true);

await pad.waitForFunction(() => {
  const btns = document.querySelectorAll('#panel-picker .panel-btn');
  return btns[1]?.classList.contains('is-on');
}, null, { timeout: 5000 });
ok('the plan chose panel B to focus on load, not the default A (Issue #109)', true);

// Issue #131: a plan can start in picture-in-picture, naming which pane fills
// the screen, which is the inset, and where the inset sits - here all four
// deliberately away from the defaults (A main, B inset, top right, 20%).
const pipPlanFile = path.join(HERE, 'fixtures', 'e2e-autolaunch-pip.podium.json');
fs.writeFileSync(pipPlanFile, JSON.stringify({
  podium: 'plan',
  v: 1,
  title: 'PiP auto-launch demo',
  layout: 'pip',
  pip: { main: 'B', inset: 'A', corner: 'bl', size: 30 },
  items: [
    { id: 'i-cam', type: 'text', title: 'Inset', body: 'Small corner pane' },
    { id: 'i-main', type: 'text', title: 'Main', body: 'Full screen pane' },
  ],
  autoLaunch: {
    enabled: true,
    initialState: 'live',
    panes: {
      A: { type: 'item', itemId: 'i-cam' },
      B: { type: 'item', itemId: 'i-main' },
    },
  },
}));
await pad.setInputFiles('#plan-file', pipPlanFile);
await pad.waitForFunction(() => document.querySelector('#library h3.group')?.textContent === 'PiP auto-launch demo', null, { timeout: 20000 });
await screen.waitForFunction(() => document.querySelector('#stage').classList.contains('layout-pip')
  && /Full screen pane/.test(document.querySelector('[data-panel="b"] .r-text')?.textContent || '')
  && /Small corner pane/.test(document.querySelector('.layer[data-role="program"] .r-text')?.textContent || ''), null, { timeout: 15000 });
ok('a plan saved in picture-in-picture starts the display in it (Issue #131)', true);
const pipGeom = await screen.evaluate(() => {
  const box = (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  return { stage: box(document.querySelector('#stage')), a: box(document.querySelector('[data-panel="a"]')), b: box(document.querySelector('[data-panel="b"]')) };
});
ok(`with the plan's pane B full screen (${pipGeom.b.w}x${pipGeom.b.h} vs stage ${pipGeom.stage.w}x${pipGeom.stage.h})`,
  Math.abs(pipGeom.b.w - pipGeom.stage.w) < 2 && Math.abs(pipGeom.b.h - pipGeom.stage.h) < 2);
ok(`and pane A as a ~30% inset in the bottom-left corner (${(pipGeom.a.w / pipGeom.stage.w * 100).toFixed(0)}% wide)`,
  Math.abs(pipGeom.a.w / pipGeom.stage.w - 0.3) < 0.03
  && pipGeom.a.x / pipGeom.stage.w < 0.08
  && (pipGeom.stage.h - (pipGeom.a.y + pipGeom.a.h)) / pipGeom.stage.h < 0.08);

await tablet.close();
await room.close();
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
await typedPhone.waitForFunction(() => document.querySelector('#question')?.textContent === 'One word for how that felt?', null, { timeout: 8000 });
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

if (want('poll votes are lost on relay restart, with no warning')) {
console.log('\n-- Issue #115: poll votes are lost on relay restart, with no warning --');
// A poll's votes and its code live only in the relay's memory (see the
// comment over `const polls` in podium-server.js) - a real restart, on its
// own port so nothing else in this suite feels it, is what actually
// reproduces "the relay forgot every open poll" rather than faking a 404.
const pollPort = await freePort();
const pollBase = `http://127.0.0.1:${pollPort}`;
let pollServer = spawn(process.execPath, ['podium-server.js'], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(pollPort), STATIC: '../' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('relay did not start')), 10000);
  pollServer.stdout.on('data', (d) => { if (String(d).includes('podium relay')) { clearTimeout(timer); resolve(); } });
  pollServer.on('exit', (code) => reject(new Error(`relay exited with ${code}`)));
});

const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${pollPort}/podium`, room: 'poll-restart-room', passphrase: 'gone when the box reboots' }));
const screen = await ctx.newPage();
trap(screen, 'poll-restart display');
await screen.goto(`${pollBase}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'poll-restart pad');
await pad.goto(`${pollBase}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

await pad.click('.tab[data-tab="polls"]');
await pad.selectOption('#poll-kind', 'text');
await pad.fill('#poll-question', 'Still with me?');
await pad.click('#poll-start');
await pad.waitForFunction(() => !document.querySelector('#poll-running').hidden, null, { timeout: 8000 });
await screen.waitForFunction(() => document.querySelector('.r-poll-question')?.textContent === 'Still with me?', null, { timeout: 5000 });
await fetch(`${pollBase}/poll/${(await pad.textContent('#poll-running-code')).trim()}/vote`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voter: 's1', answer: 'here' }) });
await screen.waitForFunction(() => document.querySelector('.r-poll-status')?.textContent.includes('1 response'), null, { timeout: 5000 });
ok('a vote is in before the relay goes down', true);

// A real restart: kill this dedicated process and bring up a fresh one on
// the exact same port. The new process's `polls` Map starts empty - there
// is nothing anywhere to reconnect to for the poll that was running.
expecting.pollLost = true;
pollServer.kill();
await new Promise((resolve) => pollServer.on('exit', resolve));
pollServer = spawn(process.execPath, ['podium-server.js'], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(pollPort), STATIC: '../' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('relay did not restart')), 10000);
  pollServer.stdout.on('data', (d) => { if (String(d).includes('podium relay')) { clearTimeout(timer); resolve(); } });
  pollServer.on('exit', (code) => reject(new Error(`relay exited with ${code}`)));
});

await screen.waitForFunction(() => /votes and join code are gone/.test(document.querySelector('.r-poll-hint')?.textContent || ''), null, { timeout: 5000 });
ok('the display notices within one tick and says so plainly, not a blank retry loop', true);
ok('and pulls the now-useless QR down rather than leaving it up to be scanned',
  await screen.evaluate(() => !document.querySelector('.r-poll-qr svg')));

await pad.waitForFunction(() => /votes and join code are gone/.test(document.querySelector('#poll-running-status')?.textContent || ''), null, { timeout: 5000 });
ok('the presenter\'s own controller says the same thing, not just the projector', true);
ok('and hides Close/Reopen voting and the join link - both would only fail against a poll that no longer exists',
  await pad.evaluate(() => document.querySelector('#poll-toggle-open').hidden && document.querySelector('#poll-copy-link').hidden));
// The console event for that 404 can reach here after this point returns
// (see the favicon case above for the same CDP-ordering reason), so this
// waits a beat before disarming rather than racing it.
await pad.waitForTimeout(1500);
expecting.pollLost = false;

await ctx.close();
pollServer.kill();
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

ok('Word cloud view button is available for short-answer text polls',
  await pad.evaluate(() => !document.querySelector('#poll-toggle-view').hidden));
await pad.click('#poll-toggle-view');
await screen.waitForFunction(() => document.querySelector('.r-poll-cloud'), null, { timeout: 5000 });
ok('toggling to word cloud renders .r-poll-cloud on the projector',
  await screen.evaluate(() => document.querySelector('.r-poll-cloud') !== null));
ok('word cloud reflects the non-hidden answer ("seen")',
  await screen.evaluate(() => document.querySelector('.r-poll-cloud-word')?.textContent.includes('seen')));
await pad.waitForFunction(() => document.querySelector('#poll-toggle-view')?.textContent.includes('List view'), null, { timeout: 5000 });
ok('and the Word cloud button on the pad now reads List view', true);
await pad.click('#poll-toggle-view');
await screen.waitForFunction(() => document.querySelector('.r-poll-answer'), null, { timeout: 5000 });
ok('toggling back restores the list view',
  await screen.evaluate(() => document.querySelectorAll('.r-poll-answer').length === 1));

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
await desk.fill('#item-fields .poll-option-row:nth-child(1) input', 'Construct');
await desk.fill('#item-fields .poll-option-row:nth-child(2) input', 'Method');
await desk.click('#item-fields button:has-text("+ Option")');
await desk.fill('#item-fields .poll-option-row:nth-child(3) input', 'Norming');
await desk.fill('#item-duration', '15');

await desk.click('#type-picker .type-btn:has-text("Text sign")');
await desk.fill('#item-duration', '20');
ok('item durations create cumulative timestamps in running order',
  await desk.evaluate(() => {
    const times = Array.from(document.querySelectorAll('.order-time')).map((t) => t.textContent);
    return times.includes('0:00 - 0:15 (15m)') && times.includes('0:15 - 0:35 (20m)');
  }));
ok('pacing summary bar tracks planned duration against target',
  await desk.evaluate(() => document.querySelector('#plan-pacing-summary').textContent.includes('35 min planned') && document.querySelector('#plan-pacing-summary').textContent.includes('15m remaining')));

await desk.selectOption('#plan-target-mins', '30');
ok('changing target duration recalculates over budget warning',
  await desk.evaluate(() => document.querySelector('#plan-pacing-summary').textContent.includes('5m over budget!')));

await desk.click('#order li:first-child .order-open');
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

if (want('exporting a session to a single merged PDF')) {
console.log('\n-- exporting a session to a single merged PDF --');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'pdf-merged-room', passphrase: 'pdf merge test' }));
const screen = await ctx.newPage();
trap(screen, 'pdf-merge display');
await screen.goto(`${BASE}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await ctx.newPage();
trap(pad, 'pdf-merge pad');
await pad.goto(`${BASE}/control.html`);
await pad.waitForSelector('.tile');
await pad.waitForFunction(() => document.querySelector('#display-state')?.textContent.startsWith('Display connected'));

// Create a poll
await pad.click('.tab[data-tab="polls"]');
await pad.fill('#poll-question', 'Which outcome is expected?');
await pad.fill('#poll-options .poll-option-row:nth-child(1) input', 'Higher yield');
await pad.fill('#poll-options .poll-option-row:nth-child(2) input', 'Lower cost');
await pad.click('#poll-start');
await pad.waitForFunction(() => !document.querySelector('#poll-running').hidden, null, { timeout: 8000 });

// Switch to whiteboard and draw ink
await pad.click('.tab[data-tab="library"]');
await pad.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await pad.waitForFunction(() => !!document.querySelector('.tab[data-tab="ink"]'), null, { timeout: 5000 });
await pad.click('.tab[data-tab="ink"]');
await pad.waitForSelector('#pad');
const box = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await pad.mouse.move(box.x + box.w * 0.2, box.y + box.h * 0.3);
await pad.mouse.down();
for (let i = 1; i <= 10; i++) await pad.mouse.move(box.x + box.w * (0.2 + i * 0.05), box.y + box.h * (0.3 + i * 0.04));
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink')?.classList.contains('has-ink'), null, { timeout: 5000 });

await pad.click('.tab[data-tab="photos"]');
await pad.waitForFunction(() => !document.querySelector('#photo-export-pdf').disabled, null, { timeout: 8000 });

const downloadPromise = pad.waitForEvent('download', { timeout: 20000 });
await pad.click('#photo-export-pdf');
const file = await downloadPromise;
ok('Download as PDF button triggers a .pdf file download', file.suggestedFilename().endsWith('.pdf'));

const pdfPath = path.join(HERE, 'fixtures', 'session-export.pdf');
await file.saveAs(pdfPath);
const buf = fs.readFileSync(pdfPath);
const pdfText = buf.toString('latin1');

ok('PDF starts with standard PDF 1.4 header', pdfText.startsWith('%PDF-1.4'));
ok('PDF contains embedded JPEG pages and DCTDecode filter', pdfText.includes('/Filter /DCTDecode'));
ok('PDF contains metadata trailer and EOF marker', pdfText.includes('%%EOF'));

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
// The admin ZIP import writes into the content folders; pointed somewhere
// disposable so it never touches the repo's own content/.
const acctContent = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-e2e-content-'));

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
  env: { ...process.env, PORT: String(acctPort), STATIC: '../', DATA_DIR: acctData, CONTENT_DIR: acctContent, AUTH_PASSWORD: 'should-be-ignored' },
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

// The showcase page is the other thing that must never want an account - it
// is what sells Podium to someone who has not signed in yet. Unlike the
// gated pages above, this is the accounts-only exception (publicPaths in
// server/api.js), so it says nothing about the AUTH_PASSWORD server tested
// above, which keeps '/' behind Basic Auth exactly as it always has.
ok('/ is reachable with no credentials, even with accounts configured',
  (await fetch(`${acctBase}/`)).status === 200);
ok('/index.html is too',
  (await fetch(`${acctBase}/index.html`)).status === 200);

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

// A guest lecturer is the same exception, for the same reason (Issue #77) -
// see AUTH_OPEN_PATHS in podium-server.js.
ok('a guest pairing link is reachable with no account either',
  (await fetch(`${acctBase}/guest.html`)).status === 200);
ok('and so is the script it needs to actually join the room',
  (await fetch(`${acctBase}/assets/js/guest.js`)).status === 200);

// A visitor who has never signed in sees the showcase itself, and a way in -
// not the surfaces, which would 401 the moment they were clicked.
const visitor = await acctCtx.newPage();
trap(visitor, 'acct showcase, signed out');
await visitor.goto(`${acctBase}/index.html`);
await visitor.waitForSelector('#topbar-nav:not([hidden])');
ok('a signed-out visitor sees Sign in, not the surfaces',
  await visitor.isVisible('.landing-signin')
  && !(await visitor.isVisible('#topbar-nav a[href="control.html"]')));
ok('and the hero\'s own call to action is the same Sign in link',
  (await visitor.getAttribute('#hero-cta a', 'href') || '').startsWith('login.html?next='));
await visitor.close();

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

// Signed in, the same showcase page now offers the surfaces and an admin
// link (jon is an administrator) instead of the Sign in prompt above. A
// fresh tab, sharing acctCtx's cookie jar, so `pad` stays parked on
// control.html for the library steps that follow.
const home = await acctCtx.newPage();
trap(home, 'acct showcase, signed in');
await home.goto(`${acctBase}/index.html`);
await home.waitForSelector('#topbar-nav:not([hidden])');
ok('signed in, the showcase offers the surfaces instead of Sign in',
  await home.isVisible('#topbar-nav a[href="control.html"]')
  && await home.isVisible('#topbar-nav a[href="admin.html"]')
  && !(await home.isVisible('.landing-signin')));
ok('and says who is signed in, same as every other gated page',
  (await home.textContent('#session-badge .session-who')).trim() === 'Jon W');
await home.close();

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
await desk.click('#tab-library');
await desk.waitForSelector('#panel-library:not([hidden])');
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

// Issue #82: a PDF uploaded straight from the controller's Library tab -
// unlike a deck or a photo it cannot be sent peer to peer, so this button
// only exists here (server-backed) and goes through the same upload route
// admin.html's own does.
await pad.click('.tab[data-tab="library"]');
await pad.waitForSelector('#pdf-upload-row:not([hidden])', { timeout: 5000 });
await pad.setInputFiles('#pdf-upload', path.join(ROOT, 'content', 'sample.pdf'));
await pad.waitForFunction(() => /Added/.test(document.querySelector('#pdf-upload-note')?.textContent || ''), null, { timeout: 8000 });
ok(`uploading a PDF from the controller adds it to the library ("${(await pad.textContent('#pdf-upload-note')).trim()}")`,
  /Added/.test(await pad.textContent('#pdf-upload-note')));
const uploadedPdfInLibrary = await pad.evaluate(async () => {
  const res = await fetch('/api/library', { credentials: 'same-origin' });
  const { items } = await res.json();
  return items.some((i) => i.type === 'pdf' && i.title === 'sample');
});
ok('and it is really on the server, filed as a pdf item', uploadedPdfInLibrary);

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

// Issue #108: a PDF/video/audio item can upload straight to this server's
// library from the planner too, not just from the controller - the same
// endpoint (Issue #82's #pdf-upload above), just reached from the desk.
await planner.click('#type-picker .type-btn:has-text("PDF")');
await planner.waitForSelector('#item-fields input[type=file]');
await planner.setInputFiles('#item-fields input[type=file]', path.join(ROOT, 'content', 'sample.pdf'));
// Two text inputs share this panel (Title, then the src path/URL field) -
// index into the src one specifically, not whichever text input is first.
await planner.waitForFunction(
  () => (document.querySelectorAll('#item-fields input[type=text]')[1]?.value || '').startsWith('/media/'),
  null, { timeout: 8000 },
);
ok('uploading a PDF from the planner fills the path field with a real server URL, not just a filename',
  /^\/media\//.test(await planner.inputValue('#item-fields input[type=text] >> nth=1')));
const plannerUploadedPdf = await planner.evaluate(async () => {
  const res = await fetch('/api/library', { credentials: 'same-origin' });
  const { items } = await res.json();
  return items.some((i) => i.type === 'pdf' && i.title === 'sample');
});
ok('and it really landed in the library, the same place the controller\'s own upload does', plannerUploadedPdf);
await planner.click('#plan-new');
// newPlan() is async and re-renders the header only once it is done - wait for
// the PDF row to leave the running order, not for an empty course field that
// was already empty, or the title typed next gets wiped by that re-render.
await planner.waitForFunction(() => !document.querySelector('#order .order-row'), null, { timeout: 5000 });

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

// -- Issue #88: overwrite and delete a plan already on the server ------------
//
// planner's second push above (the "not-a-real-course" one) is the plan under
// test here - a private one nothing else in this section reads from, so
// updating and deleting it cannot disturb "Day 6 — sent, not carried" itself,
// which the controller just opened and the rest of this section still needs.
ok('pushing a second time left Update visible for what it just created',
  await planner.isVisible('#plan-push-update'));

await planner.fill('#plan-title', 'Day 6 — sent, not carried (revised)');
await planner.click('#plan-push-update');
await planner.waitForFunction(() => /Updated/.test(document.querySelector('#plan-push-note')?.textContent || ''), null, { timeout: 8000 });

const afterUpdate = await planner.evaluate(async () => {
  const res = await fetch('/api/plans', { credentials: 'same-origin' });
  return (await res.json()).plans;
});
ok('Update overwrote the same server row rather than creating another (still 2 of planner\'s own plans)',
  afterUpdate.filter((p) => /sent, not carried/.test(p.title)).length === 2);
ok('and the title on the server actually changed',
  afterUpdate.some((p) => p.title === 'Day 6 — sent, not carried (revised)'));

const revisedId = afterUpdate.find((p) => p.title === 'Day 6 — sent, not carried (revised)').id;
await planner.selectOption('#plan-pull-pick', String(revisedId));
await planner.click('#plan-pull-delete');
await planner.waitForFunction(() => /Tap again to delete/.test(document.querySelector('#plan-pull-delete')?.textContent || ''), null, { timeout: 3000 });
ok('deleting a server plan asks twice, like other destructive buttons here', true);
await planner.click('#plan-pull-delete');
await planner.waitForFunction(() => /Removed/.test(document.querySelector('#plan-push-note')?.textContent || ''), null, { timeout: 8000 });

const afterDelete = await planner.evaluate(async () => {
  const res = await fetch('/api/plans', { credentials: 'same-origin' });
  return (await res.json()).plans;
});
ok('the deleted plan is actually gone from the server, not just the picker',
  !afterDelete.some((p) => p.id === revisedId));
ok('and the OTHER plan this section still needs is untouched',
  afterDelete.some((p) => p.title === 'Day 6 — sent, not carried'));
ok('Update button hides itself once the plan it pointed at is gone',
  await planner.isHidden('#plan-push-update'));
ok('and the button re-arms for the next lecture rather than staying locked',
  await planner.isEnabled('#plan-pull-delete') && await planner.textContent('#plan-pull-delete') === 'Delete from server');

// -- Issue #117: warn before one save silently erases another -------------
//
// A second device (or tab) saving the same plan in between is simulated by
// calling the API directly, exactly what actually happens when someone else
// is the one who does it - this page's own Update button has no way to tell
// the difference, which is the point.
await planner.click('#plan-new');
await planner.waitForFunction(() => document.querySelector('#plan-course').value === '', null, { timeout: 5000 });
await planner.fill('#plan-title', 'Two tabs, one lecture');
await planner.fill('#plan-course', 'psy415');
await planner.click('#plan-push');
await planner.waitForFunction(() => /Sent/.test(document.querySelector('#plan-push-note')?.textContent || ''), null, { timeout: 8000 });
const conflictPlanId = await planner.evaluate(async () => {
  const res = await fetch('/api/plans', { credentials: 'same-origin' });
  const { plans: rows } = await res.json();
  return rows.find((p) => p.title === 'Two tabs, one lecture').id;
});
await planner.evaluate(async (id) => {
  await fetch(`/api/plans/${id}`, {
    method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Two tabs, one lecture (saved from the other tab)' }),
  });
}, conflictPlanId);

await planner.fill('#plan-title', 'Two tabs, one lecture (this one)');
// Both clicks below stage their PUT against the same now-stale
// updatedAt (declining does not update it, so the retry after accepting
// hits the same 409 before its own force-retry gets past it) - two
// deliberate conflicts, not one.
expecting.planConflict = true;
planner.once('dialog', (d) => d.dismiss());
await planner.click('#plan-push-update');
await planner.waitForFunction(() => /Not sent/.test(document.querySelector('#plan-push-note')?.textContent || ''), null, { timeout: 8000 });
ok('declining the overwrite prompt leaves the server copy alone, not silently applied anyway', true);
const stillTheOtherTabs = await planner.evaluate(async (id) => {
  const res = await fetch(`/api/plans/${id}`, { credentials: 'same-origin' });
  return (await res.json()).plan.title;
}, conflictPlanId);
ok('the server still has what the "other tab" saved, not this one\'s title',
  stillTheOtherTabs === 'Two tabs, one lecture (saved from the other tab)');

planner.once('dialog', (d) => d.accept());
await planner.click('#plan-push-update');
await planner.waitForFunction(() => /Updated/.test(document.querySelector('#plan-push-note')?.textContent || ''), null, { timeout: 8000 });
expecting.planConflict = false;
const afterForce = await planner.evaluate(async (id) => {
  const res = await fetch(`/api/plans/${id}`, { credentials: 'same-origin' });
  return (await res.json()).plan.title;
}, conflictPlanId);
ok('agreeing to overwrite it forces the save through, this device\'s title now on the server',
  afterForce === 'Two tabs, one lecture (this one)');

await planner.selectOption('#plan-pull-pick', String(conflictPlanId));
await planner.click('#plan-pull-delete');
await planner.waitForFunction(() => /Tap again to delete/.test(document.querySelector('#plan-pull-delete')?.textContent || ''), null, { timeout: 3000 });
await planner.click('#plan-pull-delete');
await planner.waitForFunction(() => /Removed/.test(document.querySelector('#plan-push-note')?.textContent || ''), null, { timeout: 8000 });

// -- Issue #80: a course's plan template ----------------------------------
await planner.fill('#plan-course', 'psy415');
ok('no template yet, so "New lecture from template" is not offered', await planner.isHidden('#plan-new-from-template'));
ok('but the row itself is, once a course is named, so Save is reachable', await planner.isVisible('#plan-template-row'));

await planner.fill('#plan-title', "This week's shape");
await planner.click('#plan-save-template');
await planner.waitForFunction(() => /can start from this/.test(document.querySelector('#plan-template-note')?.textContent || ''), null, { timeout: 8000 });
ok('saving the current lecture as psy415\'s template works', true);
ok('and "New lecture from template" now offers it', await planner.isVisible('#plan-new-from-template'));
ok('and Remove appears alongside Save now that there is something to remove',
  await planner.isVisible('#plan-remove-template'));

await planner.click('#plan-new');
// newPlan() is async (it autosaves the outgoing lecture first) and its click
// handler is not awaited by the DOM, so the blank plan's own render can land
// AFTER a fill immediately following the click - wait for the course field to
// actually go blank (emptyPlan() gives it '', unlike title's 'Untitled
// lecture' default) before touching it again.
await planner.waitForFunction(() => document.querySelector('#plan-course').value === '', null, { timeout: 5000 });
await planner.fill('#plan-course', 'psy415');
await planner.click('#plan-new-from-template');
await planner.waitForFunction(() => document.querySelector('#plan-title').value === "This week's shape", null, { timeout: 5000 });
ok('starting a new lecture from the template loads its content, not a blank one', true);
ok('and carries the course forward with it', await planner.inputValue('#plan-course') === 'psy415');

// A plain member may use the template but not change it - same bar course
// ownership already sets on the connection settings above. A context of its
// own: acctCtx's cookie jar is shared by every other page still in play here
// (desk, pad, acctScreen, planner), and signing in as a second account in it
// would silently swap who THEY are authenticated as for the rest of the
// section, the same reason freshCtx and twoCtx get their own below.
const taCtx = await browser.newContext();
const memberPlanner = await taCtx.newPage();
trap(memberPlanner, 'acct plan (member)');
execFileSync(process.execPath, ['podium-admin.js', 'user', 'add', 'ta', '--name', 'A TA', '--password-stdin'], {
  cwd: path.join(ROOT, 'server'), env: { ...process.env, DATA_DIR: acctData }, input: 'a good long password too\n',
});
execFileSync(process.execPath, ['podium-admin.js', 'member', 'add', 'psy415', 'ta', '--role', 'member'], {
  cwd: path.join(ROOT, 'server'), env: { ...process.env, DATA_DIR: acctData },
});
await memberPlanner.goto(`${acctBase}/login.html`);
await memberPlanner.fill('#username', 'ta');
await memberPlanner.fill('#password', 'a good long password too');
await Promise.all([memberPlanner.waitForURL(/index\.html/), memberPlanner.click('#go')]);
await memberPlanner.goto(`${acctBase}/plan.html`);
await memberPlanner.fill('#plan-course', 'psy415');
ok('a member sees the template is there to use',
  await memberPlanner.waitForSelector('#plan-new-from-template:not([hidden])', { timeout: 5000 }).then(() => true, () => false));
expecting.templateWriteForbidden = true;
await memberPlanner.click('#plan-save-template');
await memberPlanner.waitForFunction(() => (document.querySelector('#plan-template-note')?.textContent || '').length > 0, null, { timeout: 8000 });
expecting.templateWriteForbidden = false;
ok('but may not overwrite it - membership is not ownership',
  /you can change/.test(await memberPlanner.textContent('#plan-template-note')));
await taCtx.close();

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
await pollUntil(desk, async () => {
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
await pollUntil(desk, async () => {
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
await pollUntil(desk, async () => {
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

// Pin down WHICH lecture before standing down. Everything below reads the
// list back, and once this one closes a later lecture can sit at index 0 -
// so hold the id rather than an index that only happens to point here now.
const inkLectureId = await desk.evaluate(async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures.find((l) => !l.endedAt)?.id;
});

// What the display's own upload did, watched from outside it: a stand-down
// that files nothing and one whose upload was turned down look identical in
// the lecture's file list, and they are opposite bugs.
const inkPosts = [];
acctScreen.on('response', (r) => {
  if (/\/api\/lectures\/\d+\/files\?name=ink\.json/.test(r.url())) inkPosts.push(r.status());
});

// E is stand down - the way back out of a lecture without a "quit" key a
// stray press could hit.
await acctScreen.keyboard.press('e');
await pollUntil(desk, async (id) => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures.find((l) => l.id === id)?.endedAt > 0;
}, inkLectureId, { timeout: 15000 });
ok('and standing down closes it', true);

// And the strokes really are in it. Read back through /media rather than
// trusting the row: a file that exists but holds an empty bySurface is
// exactly the failure this is here to catch - snapshotInk filtered on the
// wrong property for the whole life of the feature, so every lecture filed
// nothing and every suite still passed.
const filedInk = await desk.evaluate(async (id) => {
  // The row appears when the upload lands, which is not the same instant as
  // the endedAt the wait above watched for - poll rather than take one look.
  const deadline = Date.now() + 15000;
  for (;;) {
    const { lecture } = await fetch(`/api/lectures/${id}`, { credentials: 'same-origin' })
      .then((r) => r.json());
    const row = (lecture.files || []).find((f) => f.name === 'ink.json');
    if (row) {
      const body = await fetch(row.url, { credentials: 'same-origin' }).then((r) => r.json());
      const surfaces = Object.values(body.bySurface || {});
      return {
        found: true,
        surfaces: surfaces.length,
        strokes: surfaces.reduce((n, s) => n + (s.strokes?.length || 0), 0),
      };
    }
    if (Date.now() > deadline) {
      // Say what IS filed: "no ink.json" plus the names beside it is a
      // diagnosis, where a bare undefined is a second debugging session.
      return { found: false, surfaces: 0, strokes: 0, filed: (lecture.files || []).map((f) => f.name) };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}, inkLectureId);
acctScreen.removeAllListeners('response');
ok(filedInk.found
  ? `the display files its own ink with the lecture (${filedInk.surfaces} surface(s), ${filedInk.strokes} stroke(s))`
  : `the display files its own ink with the lecture (no ink.json; upload: ${inkPosts.join(', ') || 'never sent'}; filed: ${filedInk.filed.join(', ') || 'nothing'})`,
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
await pollUntil(desk, async () => {
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
await pollUntil(desk, async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures.every((l) => l.endedAt);
}, null, { timeout: 15000 });
await desk.evaluate(async (keepId) => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  await Promise.all(lectures.filter((l) => l.id !== keepId)
    .map((l) => fetch(`/api/lectures/${l.id}`, { method: 'DELETE', credentials: 'same-origin' })));
}, firstLectureId);

await desk.reload();
await desk.waitForSelector('#admin:not([hidden])');
await desk.click('#tab-sessions');
await desk.waitForSelector('#panel-sessions:not([hidden]) .admin-row');
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
await desk.click('#tab-people');
await desk.waitForSelector('#panel-people:not([hidden])');
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

await desk.click('#tab-courses');
await desk.waitForSelector('#panel-courses:not([hidden])');
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

await desk.click('#tab-storage');
await desk.waitForSelector('#panel-storage:not([hidden])');

// 2 files: the deck uploaded earlier in this section, plus the PDF uploaded
// from the controller's own Library tab (Issue #82).
ok(`the page says what the box is holding (${(await desk.textContent('#storage-note')).slice(0, 60)}…)`,
  /Library: 2 files/.test(await desk.textContent('#storage-note'))
  && /database:/.test(await desk.textContent('#storage-note')));

const backup = desk.waitForEvent('download', { timeout: 30000 });
await desk.click('#backup-go');
const backupFile = await backup;
ok(`a copy of the database comes out in one click (${backupFile.suggestedFilename()})`,
  /^podium-\d{4}-\d{2}-\d{2}.*\.db$/.test(backupFile.suggestedFilename()));

// The record, rebuilt into the same zip by a page that was never in the room.
const rebuilt = desk.waitForEvent('download', { timeout: 40000 });
await desk.click('#tab-sessions');
await desk.waitForSelector('#panel-sessions:not([hidden])');
await desk.click('#sessions .session-body button:has-text("Download the session")');
const rebuiltFile = await rebuilt;
ok(`a past lecture downloads as a session zip again (${rebuiltFile.suggestedFilename()})`,
  /\.zip$/.test(rebuiltFile.suggestedFilename()));

await desk.fill('#sessions .admin-name', 'Day 6 — Weighing the Evidence');
await desk.dispatchEvent('#sessions .admin-name', 'change');
await pollUntil(desk, async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures[0]?.title === 'Day 6 — Weighing the Evidence';
}, null, { timeout: 8000 });
ok('and naming it sticks', true);

// A rename the server actually refuses (or a dropped connection) must not
// leave the field looking like it saved when it did not.
expecting.lectureRenameForbidden = true;
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
expecting.lectureRenameForbidden = false;

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

// --- Issue #106: a whole folder at once, reviewed before it is imported ---
{
  const slidePngs = writeSlideFixtures().map((rel) => fs.readFileSync(path.join(ROOT, rel)));
  const zipFile = async (name, entries) => {
    const file = path.join(acctData, name);
    fs.writeFileSync(file, Buffer.from(await (await createZip(entries)).arrayBuffer()));
    return file;
  };

  // The planner: into the server library, and this lecture's running order.
  const pptxBytes = fs.readFileSync(await writeMinimalPptxFixture());
  const lectureZip = await zipFile('Week 9.zip', [
    ...slidePngs.map((data, i) => ({ name: `Memory/Slide${i + 1}.png`, data })),
    // Not byte-identical to the sample.pdf uploaded above, which the import
    // would rightly call "already in library".
    { name: 'handout.pdf', data: Buffer.concat([fs.readFileSync(path.join(ROOT, 'content', 'sample.pdf')), Buffer.from('\n% zip import\n')]) },
    // Issue #107: a real .pptx converts and imports like any other PDF now;
    // .odp is not one of the formats this converts, so it is what still
    // proves the "needs your input" path.
    { name: 'Old deck.pptx', data: pptxBytes },
    { name: 'Old talk.odp', data: 'not really an odp' },
    { name: '__MACOSX/._Slide1.png', data: 'junk' },
  ]);
  const zipPlanner = await acctCtx.newPage();
  trap(zipPlanner, 'zip planner');
  await zipPlanner.goto(`${acctBase}/plan.html`);
  await zipPlanner.waitForSelector('#plan-zip-box:not([hidden])', { timeout: 10000 });
  ok('the planner offers a ZIP import once it knows there is a server library', true);
  const orderBefore = await zipPlanner.$$eval('#order > li', (n) => n.length);
  await zipPlanner.setInputFiles('#plan-zip .zip-file', lectureZip);
  await zipPlanner.waitForSelector('#plan-zip .zip-review:not([hidden]) .zip-row', { timeout: 15000 });
  const rows = await zipPlanner.$$eval('#plan-zip .zip-items .zip-row', (n) => n.map((r) => ({
    kind: r.dataset.kind, title: r.querySelector('.zip-title').value, on: r.querySelector('input[type=checkbox]').checked,
  })));
  ok(`the review screen lists a picture deck, a PDF and a PowerPoint file - already shown as the PDF it will become (${rows.map((r) => `${r.kind}:${r.title}`).join(', ')})`,
    rows.length === 3 && rows.some((r) => r.kind === 'imagedeck' && r.title === 'Memory')
    && rows.filter((r) => r.kind === 'pdf').map((r) => r.title).sort().join() === 'Old deck,handout');
  ok('and says the OpenDocument file needs a decision rather than dropping it',
    /1 needs your input/.test(await zipPlanner.textContent('#plan-zip .zip-needs-head'))
    && /not converted/.test(await zipPlanner.textContent('#plan-zip .zip-needs')));
  ok('the course picker offers this account\'s course', (await zipPlanner.$$eval('#plan-zip .zip-course option', (o) => o.map((x) => x.value))).includes('psy415'));
  const thumbLoaded = await zipPlanner.waitForFunction(() => {
    const img = document.querySelector('#plan-zip .zip-row[data-kind="imagedeck"] img.zip-thumb');
    return img?.complete && img.naturalWidth === 320;
  }, null, { timeout: 10000 }).then(() => true, () => false);
  ok('the deck shows a thumbnail of its first slide, read from the staged upload', thumbLoaded);
  ok(`the button counts what will be imported ("${await zipPlanner.textContent('#plan-zip .zip-commit')}")`,
    (await zipPlanner.textContent('#plan-zip .zip-commit')) === 'Import 3 items');
  await zipPlanner.fill('#plan-zip .zip-row[data-kind="imagedeck"] .zip-title', 'Memory systems');
  await zipPlanner.selectOption('#plan-zip .zip-course', 'psy415');
  await zipPlanner.click('#plan-zip .zip-commit');
  await zipPlanner.waitForSelector('#plan-zip .zip-result', { timeout: 30000 });
  const importResultText = await zipPlanner.textContent('#plan-zip .zip-result');
  ok(`importing reports what arrived (${importResultText.replace(/\s+/g, ' ').slice(0, 100)}…)`,
    /Imported Memory systems/.test(importResultText) && /Imported handout/.test(importResultText));
  // Whether the PowerPoint file actually converts depends on this machine
  // having LibreOffice's Impress component installed, not just the bare
  // `soffice` binary (see docs/vps.md) - a real conversion is proven,
  // everywhere, by pptx-convert.test.mjs (which skips gracefully without
  // it) and the deterministic failure path by zip-staging.test.mjs (which
  // needs no LibreOffice at all). Here, on whatever machine this actually
  // runs on, it is either a real success or a clean, reported failure -
  // never silently dropped, and never something that crashes the import.
  const pptxConverted = /Imported Old deck/.test(importResultText);
  ok(pptxConverted ? 'and the PowerPoint file, actually converted rather than just renamed'
    : 'or, without Impress installed here, fails cleanly and says so rather than crashing the whole import',
  pptxConverted || /Failed: Old deck/.test(importResultText));
  const importedCount = pptxConverted ? 3 : 2;
  await zipPlanner.waitForFunction((n) => document.querySelectorAll('#order > li').length === n, orderBefore + importedCount, { timeout: 5000 });
  ok(`and the ${importedCount} successfully imported item(s) join this lecture's running order`, true);
  const libDeck = await zipPlanner.evaluate(async () => {
    const { items } = await (await fetch('/api/library', { credentials: 'same-origin' })).json();
    const deck = items.find((i) => i.type === 'imagedeck' && i.title === 'Memory systems');
    if (!deck) return null;
    const slide = await fetch(deck.images[0], { credentials: 'same-origin' });
    return { course: deck.course, slides: deck.images.length, served: slide.status, type: slide.headers.get('content-type') };
  });
  ok(`the picture deck is in the library under the chosen course, its slides served (${JSON.stringify(libDeck)})`,
    libDeck?.course === 'psy415' && libDeck.slides === 3 && libDeck.served === 200 && libDeck.type === 'image/png');
  if (pptxConverted) {
    const pptxItem = await zipPlanner.evaluate(async () => {
      const { items } = await (await fetch('/api/library', { credentials: 'same-origin' })).json();
      const item = items.find((i) => i.title === 'Old deck');
      if (!item) return null;
      const media = await fetch(item.src, { credentials: 'same-origin' });
      const bytes = new Uint8Array(await media.arrayBuffer());
      return { type: item.type, filename: item.filename, status: media.status, contentType: media.headers.get('content-type'), magic: String.fromCharCode(...bytes.slice(0, 5)) };
    });
    ok(`the PowerPoint file landed in the library as a real, served PDF, not the original bytes under a new name (${JSON.stringify(pptxItem)})`,
      pptxItem?.type === 'pdf' && pptxItem.filename === 'Old deck.pdf' && pptxItem.status === 200 && pptxItem.contentType === 'application/pdf' && pptxItem.magic === '%PDF-');
  }
  await zipPlanner.click('#plan-zip .zip-done');

  // And it plays: picked from the controller's Library, served from /media.
  const zipScreen = await acctCtx.newPage();
  trap(zipScreen, 'zip display');
  await zipScreen.goto(`${acctBase}/display.html`);
  await zipScreen.click('#arm-button');
  await zipScreen.waitForSelector('#hud[data-status="online"]');
  await pad.reload();
  await pad.waitForSelector('#library .tile');
  await pad.fill('#lib-filter', 'Memory systems');
  await pad.click('#library .tile:not([hidden]):has(.tile-title:text-is("Memory systems"))');
  const firstSlide = await zipScreen.waitForFunction((rgb) => {
    const img = document.querySelector('.layer[data-role="program"] .r-image');
    if (!img || !img.complete || !img.naturalWidth) return false;
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const px = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
    return Math.abs(px[0] - rgb[0]) < 12 && Math.abs(px[1] - rgb[1]) < 12 && Math.abs(px[2] - rgb[2]) < 12;
  }, SLIDE_COLOURS[0], { timeout: 10000 }).then(() => true, () => false);
  ok('the imported picture deck plays from the controller\'s Library, first slide first', firstSlide);
  await pad.fill('#lib-filter', '');
  await zipScreen.close();

  // The same ZIP again: what is already there is said so, and left unticked -
  // except the PowerPoint file, which is never hash-checked for this (see
  // zip-staging.js's stage()) and so is offered again rather than flagged.
  await zipPlanner.setInputFiles('#plan-zip .zip-file', lectureZip);
  await zipPlanner.waitForSelector('#plan-zip .zip-review:not([hidden]) .zip-row', { timeout: 15000 });
  const deckRow = '#plan-zip .zip-row[data-kind="imagedeck"]';
  ok(`uploading it again flags the deck as already in the library ("${(await zipPlanner.textContent(`${deckRow} .zip-flag`)).trim()}")`,
    /Already in library as “Memory systems”/.test(await zipPlanner.textContent(`${deckRow} .zip-flag`))
    && !(await zipPlanner.isChecked(`${deckRow} input[type=checkbox]`)));
  const pdfRows = await zipPlanner.$$eval('#plan-zip .zip-row[data-kind="pdf"]', (rows) => rows.map((r) => ({
    title: r.querySelector('.zip-title').value, on: r.querySelector('input[type=checkbox]').checked,
  })));
  ok('but the PowerPoint file is offered again, a known gap rather than a silent duplicate',
    pdfRows.find((r) => r.title === 'Old deck')?.on === true);
  ok('so it is the only thing left to import', (await zipPlanner.textContent('#plan-zip .zip-commit')) === 'Import 1 item');
  await zipPlanner.click('#plan-zip .zip-cancel');
  ok('Cancel puts the upload button back', await zipPlanner.isVisible('#plan-zip .zip-pick'));
  // The DELETE goes out after the screen resets, so give it a moment.
  const stagedNow = () => (fs.existsSync(path.join(acctData, 'zip-staging')) ? fs.readdirSync(path.join(acctData, 'zip-staging')).length : 0);
  for (let i = 0; i < 50 && stagedNow(); i++) await zipPlanner.waitForTimeout(100);
  ok('and nothing is left staged on the server', stagedNow() === 0);
  await zipPlanner.close();

  // The admin page: into the content folders, with a clash numbered.
  fs.mkdirSync(path.join(acctContent, 'photos'), { recursive: true });
  fs.writeFileSync(path.join(acctContent, 'photos', 'campus.png'), 'already here');
  const contentZip = await zipFile('Unit 4.zip', [
    { name: 'campus.png', data: slidePngs[0] },
    { name: 'Talk/index.html', data: '<link rel="stylesheet" href="css/talk.css"><h1>Talk</h1>' },
    { name: 'Talk/css/talk.css', data: 'h1 { color: red; }' },
    { name: 'Deck/Slide1.png', data: slidePngs[1] },
    { name: 'Deck/Slide2.png', data: slidePngs[2] },
  ]);
  const zipDesk = await acctCtx.newPage();
  trap(zipDesk, 'zip admin');
  await zipDesk.goto(`${acctBase}/admin.html`);
  await zipDesk.waitForSelector('#admin:not([hidden])');
  await zipDesk.click('#tab-content');
  await zipDesk.click('.content-subtab[data-pane="tab-pane-files"]');
  await zipDesk.setInputFiles('#content-zip-import .zip-file', contentZip);
  await zipDesk.waitForSelector('#content-zip-import .zip-review:not([hidden]) .zip-row', { timeout: 15000 });
  const campusRow = '#content-zip-import .zip-row[data-kind="photo"]';
  ok(`the admin review shows a taken name with its new number before import ("${(await zipDesk.textContent(`${campusRow} .zip-flag`)).trim()}")`,
    /content\/photos\/campus-2\.png/.test(await zipDesk.textContent(`${campusRow} .zip-flag`)));
  ok('an exported web deck is one row, not a stylesheet and a page',
    (await zipDesk.$$eval('#content-zip-import .zip-row[data-kind="webdeck"]', (n) => n.length)) === 1);
  // Split the picture deck into separate photos, to prove the choice is honoured.
  await zipDesk.selectOption('#content-zip-import .zip-row[data-kind="imagedeck"] .zip-kind', 'photo');
  ok(`splitting the deck into photos changes the count ("${await zipDesk.textContent('#content-zip-import .zip-commit')}")`,
    (await zipDesk.textContent('#content-zip-import .zip-commit')) === 'Import 4 items');
  await zipDesk.click('#content-zip-import .zip-commit');
  await zipDesk.waitForSelector('#content-zip-import .zip-result', { timeout: 20000 });
  ok('the clash was numbered, and the original left alone',
    fs.readFileSync(path.join(acctContent, 'photos', 'campus.png'), 'utf8') === 'already here'
    && fs.existsSync(path.join(acctContent, 'photos', 'campus-2.png')));
  ok('the web deck kept its folder layout',
    fs.existsSync(path.join(acctContent, 'slides', 'Talk', 'index.html')) && fs.existsSync(path.join(acctContent, 'slides', 'Talk', 'css', 'talk.css')));
  ok('and the split deck became two photos',
    fs.existsSync(path.join(acctContent, 'photos', 'Slide1.png')) && fs.existsSync(path.join(acctContent, 'photos', 'Slide2.png')));
  const manifestItems = JSON.parse(fs.readFileSync(path.join(acctContent, 'manifest.json'), 'utf8')).items;
  ok(`each import was added to the Library manifest under the ZIP's name (${manifestItems.map((i) => i.type).join(', ')})`,
    manifestItems.length === 4 && manifestItems.every((i) => i.group === 'Unit 4'));
  await zipDesk.click('.content-subtab[data-pane="tab-pane-manifest"]');
  await zipDesk.waitForFunction(() => /Talk/.test(document.querySelector('#manifest-items-list')?.textContent || ''), null, { timeout: 5000 });
  ok('and the manifest list on the page shows them without a reload', true);

  // Only an administrator writes into the content folders.
  // From here rather than a page: the 403 is the point, not console noise.
  const taLogin = await fetch(`${acctBase}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ta', password: 'a good long password too' }),
  });
  const taCookie = (taLogin.headers.get('set-cookie') || '').split(';')[0];
  const memberPost = (await fetch(`${acctBase}/api/import/zip?surface=admin&filename=x.zip`, {
    method: 'POST', headers: { cookie: taCookie }, body: 'PK',
  })).status;
  ok(`a non-admin account cannot import into the content folders (${memberPost})`, memberPost === 403);
  await zipDesk.close();
}

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
fs.rmSync(acctContent, { recursive: true, force: true });
}

if (want('multiple displays and multiple controllers share one room')) {
console.log('\n-- multiple displays and multiple controllers share one room --');
// Its own server: recording state (lectureId, the heartbeat, the event
// queue) lives in each DISPLAY's own module scope, never in the shared
// broadcast state a controller reads (see wireState in display.js) - so the
// only way to find out whether two displays sharing a room actually cope
// with that is to run two of them for real, against a server that keeps
// sessions.
const multiPort = await freePort();
const multiBase = `http://127.0.0.1:${multiPort}`;
const multiData = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-e2e-multi-'));
execFileSync(process.execPath, ['podium-admin.js', 'user', 'add', 'mo', '--admin', '--name', 'Mo', '--password-stdin'], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, DATA_DIR: multiData },
  input: 'also a good long password\n',
});
const multiServer = spawn(process.execPath, ['podium-server.js'], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(multiPort), STATIC: '../', DATA_DIR: multiData },
  stdio: ['ignore', 'pipe', 'pipe'],
});
multiServer.stderr.on('data', (d) => process.stderr.write(`[multi-server] ${d}`));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('multi-display relay did not start')), 10000);
  let log = '';
  multiServer.stdout.on('data', (d) => { log += String(d); if (log.includes('podium auth:')) { clearTimeout(timer); resolve(); } });
  multiServer.on('exit', (code) => reject(new Error(`multi-display relay exited with ${code}`)));
});

// One context for everything below: cookies are per-context, and logging in
// once on the first page is what leaves every later page in it already
// signed in - the same shortcut the accounts section above relies on for
// admin.html.
const multiCtx = await browser.newContext();
await multiCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${multiPort}/podium`, room: 'lecture-hall', passphrase: 'two projectors, one class' }));

const ctrlA = await multiCtx.newPage();
trap(ctrlA, 'multi controller A');
await ctrlA.goto(`${multiBase}/control.html`);
await ctrlA.waitForSelector('#form');
await ctrlA.fill('#username', 'mo');
await ctrlA.fill('#password', 'also a good long password');
await Promise.all([ctrlA.waitForURL(/control\.html/), ctrlA.click('#go')]);
await ctrlA.waitForSelector('#app:not([hidden])');

// Two displays, same room, same account - the actual scenario issue #26
// asks about: an overflow screen in the back of a lecture hall, or a second
// projector for an adjoining room, both fed by the one iPad up front.
const dispA = await multiCtx.newPage();
trap(dispA, 'multi display A');
await dispA.goto(`${multiBase}/display.html`);
await dispA.click('#arm-button');
await dispA.waitForSelector('#hud[data-status="online"]');
const dispB = await multiCtx.newPage();
trap(dispB, 'multi display B');
await dispB.goto(`${multiBase}/display.html`);
await dispB.click('#arm-button');
await dispB.waitForSelector('#hud[data-status="online"]');

// Content fan-out: one command from the controller, both displays act on
// it - the part live testing had already shown working, checked here too
// so a future regression here fails a suite instead of a projector. A real
// layout change, not freeze: this also has to be the lecture's first
// recorded moment, or standing down below finds nothing ever happened and
// DISCARDS the record outright (see endLecture's own !events && !polls
// branch) rather than simply ending it - exactly the ambiguity a real
// class never has, since something is always on screen by the time anyone
// stands down.
await ctrlA.click('.layout-btn[data-layout="2h"]');
await Promise.all([dispA, dispB].map((d) => d.waitForFunction(
  () => document.querySelector('#stage')?.className === 'layout-2h', null, { timeout: 8000 })));
ok('one command from the controller reaches both displays', true);

// Each display opened its own recording independently (see startRecording) -
// the two must have landed on the SAME lecture, not a pair of half-empty
// ones each holding half the class. startLecture's own dedup (same account,
// same room, no other open lecture) is what is actually under test here.
const openLectures = () => ctrlA.evaluate(async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures.filter((l) => !l.endedAt);
});
await pollUntil(ctrlA, async () => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures.some((l) => !l.endedAt);
}, null, { timeout: 15000 });
const sharedLecture = await openLectures();
ok(`two displays going live in the same room share one lecture, not two (${sharedLecture.length})`,
  sharedLecture.length === 1);
const sharedId = sharedLecture[0].id;

// Wait out noteSurface's own settle-then-flush pipeline (RECORD_MIN_GAP_MS
// then RECORD_FLUSH_MS in display.js) so the layout change above is actually
// on the server, not just queued, before anyone stands down.
await ctrlA.waitForFunction((id) => fetch(`/api/lectures/${id}`, { credentials: 'same-origin' })
  .then((r) => r.json()).then(({ lecture }) => lecture.events > 0), sharedId, { timeout: 20000 });

// A second controller, same room - the other half of #26. Existing coverage
// (see "a second controller stays in step with the first") already proves
// this for a single display; worth the one extra assertion here to show it
// still holds with two displays answering it.
const ctrlB = await multiCtx.newPage();
trap(ctrlB, 'multi controller B');
await ctrlB.goto(`${multiBase}/control.html`);
await ctrlB.waitForSelector('#app:not([hidden])');
await ctrlB.waitForFunction(
  () => !document.querySelector('#display-state')?.textContent.includes('No display connected'),
  null, { timeout: 10000 });
ok('a second controller joining the same room sees two displays\' worth of state, correctly, as one', true);

// Now the part live testing could not have caught: standing down is a LOCAL
// action (the 'e' key, read only by the machine it is pressed on - see
// standDown) but the lecture it closes is shared. Before the fix, display B
// - still armed, still believing it is recording - would heartbeat and post
// events into a lecture that no longer exists, forever, with nothing on
// screen ever saying so.
await dispA.keyboard.press('e');
await ctrlA.waitForFunction((id) => fetch(`/api/lectures/${id}`, { credentials: 'same-origin' })
  .then((r) => r.json()).then(({ lecture }) => lecture?.endedAt > 0), sharedId, { timeout: 15000 });
ok('one display standing down ends the shared lecture', true);
ok('the other display never stood itself down', await dispB.evaluate(() => document.body.classList.contains('is-live')));

// B does not know yet - nothing broadcasts a stand-down (see the comment on
// session-end in display.js for why that gap is exactly what the Finish
// Session button is for). Force it to try to record something anyway: this
// is what a real class does, a slide or two after the front of the room has
// already quietly ended.
expecting.recoveryConflict = true;
await ctrlA.click('.layout-btn[data-layout="4"]');
await ctrlA.waitForFunction(
  () => document.querySelector('.layout-btn[data-layout="4"]')?.classList.contains('is-on'),
  null, { timeout: 8000 });
await dispB.waitForFunction(
  () => document.querySelector('#stage')?.className === 'layout-4', null, { timeout: 8000 });

// B's next event flush against the dead id comes back 404/409, and
// recoverRecording opens a fresh lecture rather than writing into a void for
// the rest of class - see lectureGone/recoverRecording in display.js. The
// original persists (ended, not discarded - it holds the layout-2h moment
// recorded above), so a genuinely new id is what proves this, not a reused
// one: sharedId's own row is never touched by this recovery.
await pollUntil(ctrlA, async (deadId) => {
  const { lectures } = await fetch('/api/lectures', { credentials: 'same-origin' }).then((r) => r.json());
  return lectures.some((l) => !l.endedAt && l.id !== deadId);
}, sharedId, { timeout: 30000 });
expecting.recoveryConflict = false;
const healedLecture = (await openLectures())[0];
ok(`the display nobody stood down recovers its own fresh lecture rather than recording into a void (id ${healedLecture?.id})`,
  !!healedLecture && healedLecture.id !== sharedId);

// The manual way to end class from the controller (see #26's second half),
// exercised from the SECOND controller on purpose - either one can end it,
// not just whichever opened the tab first.
await ctrlB.click('.tab[data-tab="photos"]');
await ctrlB.waitForSelector('#finish-session:not([disabled])', { timeout: 10000 });
await ctrlB.click('#finish-session');
await ctrlB.click('#finish-session');
await dispB.waitForFunction(() => !document.querySelector('#arm').hidden, null, { timeout: 10000 });
ok('Finish session & save, from either controller, stands the last live display down', true);
await ctrlA.waitForFunction((id) => fetch(`/api/lectures/${id}`, { credentials: 'same-origin' })
  .then((r) => r.json()).then(({ lecture }) => lecture?.endedAt > 0), healedLecture.id, { timeout: 15000 });
ok('and the lecture it was recording ends with it', true);

await multiCtx.close();
multiServer.kill();
await new Promise((resolve) => multiServer.on('exit', resolve));
fs.rmSync(multiData, { recursive: true, force: true });
}

if (want('guest pairing: Simple Mode')) {
console.log('\n-- guest pairing: Simple Mode --');
// Issue #77: a substitute's clicker. Its own room on the main server - no
// accounts needed, guest.html works wherever the existing full pairing QR
// already does (see the comment on AUTH_OPEN_PATHS in podium-server.js).
const gCtx = await browser.newContext();
await gCtx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
  JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${PORT}/podium`, room: 'guest-room', passphrase: 'hand this to a substitute' }));

const gDisplay = await gCtx.newPage();
trap(gDisplay, 'guest display');
await gDisplay.goto(`${BASE}/display.html`);
await gDisplay.click('#arm-button');
await gDisplay.waitForSelector('#hud[data-status="online"]');

const gControl = await gCtx.newPage();
trap(gControl, 'guest instructor controller');
await gControl.goto(`${BASE}/control.html`);
await gControl.waitForSelector('#app:not([hidden])');
await gControl.waitForFunction(
  () => !document.querySelector('#display-state')?.textContent.includes('No display connected'),
  null, { timeout: 10000 });

// --- the pairing sheet offers a guest link without touching this device's
// own settings (see showPairing in display.js). Reached with the P key
// rather than #pair-button/#standby-pair: both those buttons live on sheets
// that hide once a controller is connected and live, which this display
// already is - P works regardless (see display.js's keydown handler). -----
await gDisplay.keyboard.press('p');
await gDisplay.waitForSelector('#pair:not([hidden])');
ok('the pairing sheet defaults to full control, same as it always has',
  await gDisplay.evaluate(() => document.querySelector('#pair-mode-full').classList.contains('is-on')
    && document.querySelector('#pair-url').textContent.includes('control.html')));
await gDisplay.click('#pair-mode-guest');
ok('switching to guest mode swaps the link to guest.html, not control.html',
  (await gDisplay.textContent('#pair-url')).includes('guest.html'));
ok('and says what a guest link can actually do', /advance slides, blank the screen/.test(await gDisplay.textContent('#pair-warn')));
await gDisplay.click('#pair-close');

// --- a real deck live, so Next/Previous has somewhere to go --------------
const waitForGuestSlide = (i) => gDisplay.waitForFunction((want) => {
  const host = document.querySelector('.layer[data-role="program"] .r-deck');
  const svgs = [...(host?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]') || [])];
  return svgs.findIndex((s) => s.classList.contains('podium-on')) === want;
}, i, { timeout: 15000 });
await gControl.click('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence"))');
await waitForGuestSlide(0);

// --- the guest device itself - reached exactly the way a scanned QR would
// leave it: this context's localStorage already carries the room, so
// opening the page is the whole of "pairing". ------------------------------
const gGuest = await gCtx.newPage();
trap(gGuest, 'guest clicker');
await gGuest.goto(`${BASE}/guest.html`);
await gGuest.waitForSelector('#app:not([hidden])');
await gGuest.waitForFunction(() => document.querySelector('#status')?.dataset.status === 'online', null, { timeout: 10000 });
await gGuest.waitForFunction(() => !document.querySelector('#display-state')?.textContent.includes('No display connected'),
  null, { timeout: 10000 });
// itemTitle prefers the deck's own frontmatter title over the library
// manifest's entry title (see the deck's own front matter) - "Weighing the
// Evidence" is what actually lands in state.program.title, not the manifest
// name the tile was picked from.
await gGuest.waitForFunction(() => document.querySelector('#guest-now')?.textContent.includes('Weighing the Evidence'), null, { timeout: 10000 });
ok('the guest device sees the live deck with no setup of its own', true);
ok('Next/Previous are live for a deck', !(await gGuest.isDisabled('#guest-next')) && !(await gGuest.isDisabled('#guest-prev')));

await gGuest.click('#guest-next');
await waitForGuestSlide(1);
ok('Next goes straight to the projector - no cueing concept, no TAKE', true);

// --- Blank -----------------------------------------------------------------
await gGuest.click('#guest-blank');
await gDisplay.waitForFunction(() => document.querySelector('#blank').classList.contains('is-on'), null, { timeout: 5000 });
ok('Blank from the guest device cuts the room to black', true);
await gGuest.click('#guest-blank');
await gDisplay.waitForFunction(() => !document.querySelector('#blank').classList.contains('is-on'), null, { timeout: 5000 });
ok('and toggles back', true);

// --- Laser -------------------------------------------------------------
await gGuest.click('#guest-laser');
ok('Laser arms and offers colour swatches', await gGuest.isVisible('#guest-laser-colors'));
await gGuest.locator('#guest-pad').scrollIntoViewIfNeeded();
const padBox = await gGuest.$eval('#guest-pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await gGuest.mouse.move(padBox.x + padBox.w * 0.5, padBox.y + padBox.h * 0.5);
await gGuest.mouse.down();
await gDisplay.waitForFunction(() => document.querySelector('#laser').classList.contains('is-on'), null, { timeout: 5000 });
ok('a laser dot reaches the projector from the guest device', true);
await gGuest.mouse.up();
await gDisplay.waitForFunction(() => !document.querySelector('#laser').classList.contains('is-on'), null, { timeout: 3000 });

// --- graceful degradation: sharing the room with a frozen, mid-cue full
// controller must not touch what it has staged (Issue #77's last bullet) --
await gControl.click('#freeze');
await gDisplay.waitForFunction(() => document.body.classList.contains('is-frozen'), null, { timeout: 5000 });
await gControl.click('.tile:has(.tile-title:text-is("Whiteboard"))');
await gControl.waitForFunction(() => document.querySelector('#preview-label')?.textContent === 'Cued', null, { timeout: 5000 });
ok('the instructor cues the Whiteboard while frozen', await gControl.$eval('#preview-stage', (n) => n.innerHTML.includes('r-whiteboard')));

await gGuest.click('#guest-next');
await waitForGuestSlide(2);
ok('the guest advancing the deck still goes straight to the projector, freeze or not', true);
ok('and never touches what the instructor has cued',
  await gControl.$eval('#preview-stage', (n) => n.innerHTML.includes('r-whiteboard'))
  && (await gControl.textContent('#preview-label')) === 'Cued');

await gControl.click('#take');
await gDisplay.waitForFunction(() => !!document.querySelector('.layer[data-role="program"] .r-whiteboard'), null, { timeout: 5000 });
ok('TAKE still works normally afterward - the guest device changed nothing about how freeze/cue behaves', true);

await gCtx.close();
}

reportErrors();
} finally {
  await teardown();
}
exitWithResult();
