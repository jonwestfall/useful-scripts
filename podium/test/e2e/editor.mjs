// Podium end-to-end group: the deck editor (Issue #226).
//
//   node podium/test/e2e/editor.mjs [--only <name>[,<name>...]]
//
// Starts its own relay and browser (see harness.mjs), plus a server with
// accounts and a library, so it runs on its own. node podium/test/e2e.mjs
// runs every group.

import {
  ROOT, fs, path, os, spawn, execFileSync, freePort, BASE, browser, ok, want, trap, expecting,
  reportErrors, teardown, exitWithResult,
} from './harness.mjs';

const exampleDeck = fs.readFileSync(path.join(ROOT, 'content', 'decks', 'example-builds.md'), 'utf8');

// A server with a disk: accounts, a course, a library. owen owns PSY 415,
// tia is a TA in it (a plain member), root is an administrator.
const acctPort = await freePort();
const base = `http://127.0.0.1:${acctPort}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-e2e-editor-data-'));
const content = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-e2e-editor-content-'));
const admin = (...args) => execFileSync(process.execPath, ['podium-admin.js', ...args], {
  cwd: path.join(ROOT, 'server'), env: { ...process.env, DATA_DIR: data }, input: 'a good long password\n',
});
admin('user', 'add', 'root', '--admin', '--name', 'Root', '--password-stdin');
admin('user', 'add', 'owen', '--name', 'Owen Owner', '--password-stdin');
admin('user', 'add', 'tia', '--name', 'Tia TA', '--password-stdin');
admin('course', 'add', 'psy415', '--title', 'PSY 415');
admin('member', 'add', 'psy415', 'owen', '--role', 'owner');
admin('member', 'add', 'psy415', 'tia', '--role', 'member');

const server = spawn(process.execPath, ['podium-server.js'], {
  cwd: path.join(ROOT, 'server'),
  env: { ...process.env, PORT: String(acctPort), STATIC: '../', DATA_DIR: data, CONTENT_DIR: content },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[editor-server] ${d}`));
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('the editor test server did not start')), 10000);
  let log = '';
  server.stdout.on('data', (d) => { log += String(d); if (log.includes('podium auth:')) { clearTimeout(timer); resolve(); } });
  server.on('exit', (code) => reject(new Error(`the editor test server exited with ${code}`)));
});

async function signedIn(username) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((cfg) => localStorage.setItem('podium.config.v2', cfg),
    JSON.stringify({ transport: 'ws', wsUrl: `ws://127.0.0.1:${acctPort}/podium`, room: 'editor-room', passphrase: 'decks all the way down' }));
  const page = await ctx.newPage();
  await page.goto(`${base}/login.html?next=/index.html`);
  await page.fill('#username', username);
  await page.fill('#password', 'a good long password');
  await Promise.all([page.waitForURL((url) => url.pathname === '/index.html'), page.click('#go')]);
  await page.close();
  return ctx;
}

const stripCount = (page) => page.evaluate(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0);
const stripTitles = (page) => page.evaluate(() => [...(document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell .cap') || [])].map((c) => c.textContent));
const pickSlide = (page, i) => page.evaluate((n) => document.querySelector('#deck-strip').shadowRoot.querySelectorAll('.cell')[n].click(), i);
const waitSaved = (page) => page.waitForFunction(() => /^Saved/.test(document.querySelector('#deck-save-state').textContent), null, { timeout: 10000 });
const serverText = (page, src) => page.evaluate((u) => fetch(u, { cache: 'no-cache' }).then((r) => r.text()), src);
// Polled from here, in Node - unlike the harness's pollUntil, which runs its
// function inside a page.
async function until(check, { timeout = 15000, interval = 300 } = {}) {
  for (const end = Date.now() + timeout; ; await new Promise((r) => setTimeout(r, interval))) {
    if (await check()) return true;
    if (Date.now() > end) throw new Error('timed out');
  }
}
const libraryItem = (page, id) => page.evaluate((n) => fetch('/api/library').then((r) => r.json()).then((b) => b.items.find((i) => i.id === n)), id);

try {
let deckItem = null;

if (want('the deck editor: a library deck, edited, saved and on the projector (#226)')) {
console.log('\n-- the deck editor: a library deck, edited, saved and on the projector (#226) --');
const owen = await signedIn('owen');
const desk = await owen.newPage();
trap(desk, 'editor (owen)');
await desk.goto(`${base}/index.html`);
const uploadReply = await desk.evaluate(async (md) => {
  const res = await fetch('/api/library/upload?filename=week6.md&course=psy415&title=Week%206', { method: 'POST', body: md });
  return { status: res.status, body: await res.json().catch(() => null) };
}, exampleDeck);
deckItem = uploadReply.body?.item;
ok(`a deck in the library has a stable address (${deckItem.src})`, deckItem.src === `/media/deck/${deckItem.id}/week6.md`);
ok('and says its owner may edit it', (await libraryItem(desk, deckItem.id)).editable === true);

await desk.goto(`${base}/deck.html?library=${deckItem.id}`);
await desk.waitForFunction(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length === 4, null, { timeout: 20000 });
ok(`it opens with every slide in the strip (${(await stripTitles(desk)).join(' | ')})`, (await stripCount(desk)) === 4);
ok(`and says where it lives ("${await desk.textContent('#deck-where')}")`, /Library · PSY415 · week6\.md/.test(await desk.textContent('#deck-where')));
ok('the preview is the projector\'s renderer', await desk.evaluate(() => !!document.querySelector('#deck-preview .r-deck')));
ok('the deck title comes from its front matter', (await desk.inputValue('#deck-title')) === 'Progressive Builds');

await pickSlide(desk, 1);
await desk.waitForFunction(() => /Slide 2 of 4/.test(document.querySelector('#deck-position').textContent));
ok(`picking a slide shows it, fully built ("${await desk.textContent('#deck-position')}")`, /3 of 3 revealed/.test(await desk.textContent('#deck-position')));
ok('and its build is described', /bullets one at a time/.test(await desk.textContent('#deck-build')));
await desk.click('#deck-prev');
ok('◀ steps back through the build', /2 of 3 revealed/.test(await desk.textContent('#deck-position')));

// A new slide after slide 2, typed into.
await desk.click('#deck-add-slide');
await desk.waitForFunction(() => document.querySelector('#deck-strip').shadowRoot.querySelectorAll('.cell').length === 5, null, { timeout: 5000 });
// Its title is selected, so typing names it.
await desk.keyboard.type('Typed into the new slide');
await desk.waitForFunction(() => [...document.querySelector('#deck-strip').shadowRoot.querySelectorAll('.cell .cap')].some((c) => c.textContent === 'Typed into the new slide'), null, { timeout: 5000 });
ok(`+ Slide adds a slide after the one you are on, title ready to type over (${(await stripTitles(desk))[2]})`, (await stripTitles(desk))[2] === 'Typed into the new slide');
await desk.fill('#deck-slide-notes', 'Ask who has tried this.');
await desk.click('#deck-slide-class');
await desk.waitForTimeout(400);
ok('the state says there are unsaved changes', /Unsaved/.test(await desk.textContent('#deck-save-state')));
await desk.click('#deck-save');
await waitSaved(desk);
const saved = await serverText(desk, deckItem.src);
ok('Save writes the deck back to the library', saved.includes('Typed into the new slide') && saved.includes('Ask who has tried this.'));
ok('the new slide is where it was put', saved.indexOf('## Typed into the new slide') > saved.indexOf('## Opt a slide in with one directive'));
const afterSave = await libraryItem(desk, deckItem.id);
ok('the item keeps its id and address, with a new version', afterSave.src === deckItem.src && afterSave.version !== deckItem.version);

// Two tabs, the same deck: the second save is a conflict, not an overwrite.
const other = await owen.newPage();
trap(other, 'editor (owen, second tab)');
await other.goto(`${base}/deck.html?library=${deckItem.id}`);
await other.waitForFunction(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length === 5, null, { timeout: 20000 });
await pickSlide(desk, 0);
await desk.click('#deck-add-slide');
await desk.waitForTimeout(400);
await desk.click('#deck-save');
await waitSaved(desk);
await pickSlide(other, 4);
await other.fill('#deck-slide-notes', 'The other tab\'s note.');
await other.click('#deck-slide-class');
expecting.deckConflict = true;
await other.click('#deck-save');
await other.waitForFunction(() => /Someone else saved/.test(document.querySelector('#deck-warn').textContent), null, { timeout: 8000 })
  .then(() => ok('saving over someone else\'s newer save says so instead of overwriting it', true))
  .catch(() => ok('saving over someone else\'s newer save says so instead of overwriting it', false));
ok('nothing was overwritten', !(await serverText(desk, deckItem.src)).includes('The other tab'));
await other.click('#deck-warn button:has-text("Save mine over theirs")');
await waitSaved(other);
expecting.deckConflict = false;
ok('and "Save mine over theirs" does, on purpose', (await serverText(desk, deckItem.src)).includes('The other tab'));
await other.close();

// The projector picks the edited deck up the next time it is picked.
const screen = await owen.newPage();
trap(screen, 'editor display');
await screen.goto(`${base}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await owen.newPage();
trap(pad, 'editor controller');
await pad.goto(`${base}/control.html`);
await pad.waitForSelector('.tile');
const tile = pad.locator('.tile', { hasText: 'Week 6' });
ok('the controller offers ✎ on a deck its owner may edit', await tile.locator('.tile-edit').count() === 1);
const slidesOnWall = () => screen.evaluate(() => document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length || 0);
await tile.click();
await until(async () => (await slidesOnWall()) === 5).catch(() => {});
const before = await slidesOnWall();
// Five: "Save mine over theirs" above kept the second tab's five-slide version.
ok(`the deck goes up with every slide so far (${before})`, before === 5);

await desk.reload();
await desk.waitForFunction(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length === 5, null, { timeout: 20000 });
await pickSlide(desk, 4);
await desk.click('#deck-add-slide');
await desk.waitForTimeout(400);
await desk.click('#deck-save');
await waitSaved(desk);
await tile.click();
await until(async () => (await slidesOnWall()) === 6)
  .then(() => ok('picked again, the edited deck reaches the projector - not a cached copy of the old one', true))
  .catch(async () => ok(`picked again, the edited deck reaches the projector (${await slidesOnWall()} slides)`, false));
await screen.close();
await pad.close();
await owen.close();
}

if (want('the deck editor: a TA can present a deck but not save over it (#226)')) {
console.log('\n-- the deck editor: a TA can present a deck but not save over it (#226) --');
const tia = await signedIn('tia');
const page = await tia.newPage();
trap(page, 'editor (tia)');
await page.goto(`${base}/index.html`);
if (!deckItem) {
  const owen = await signedIn('owen');
  const p = await owen.newPage();
  await p.goto(`${base}/index.html`);
  deckItem = (await p.evaluate(async (md) => (await fetch('/api/library/upload?filename=week6.md&course=psy415&title=Week%206', { method: 'POST', body: md })).json(), exampleDeck)).item;
  await owen.close();
}
ok('the library says a TA may not edit a course deck', (await libraryItem(page, deckItem.id)).editable === false);
await page.goto(`${base}/deck.html?library=${deckItem.id}`);
await page.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) > 0, null, { timeout: 20000 });
ok(`it opens, and says only an owner can save over it ("${(await page.textContent('#deck-warn')).trim().slice(0, 70)}…")`,
  /only an owner of PSY415/.test(await page.textContent('#deck-warn')));
ok('Save offers a copy instead', (await page.textContent('#deck-save')).trim() === 'Save…');
expecting.deckForbidden = true;
const status = await page.evaluate((id) => fetch(`/api/library/${id}/content`, { method: 'PUT', body: '# mine now' }).then((r) => r.status), deckItem.id);
expecting.deckForbidden = false;
ok('and the server refuses a TA\'s save outright', status === 403);
await page.click('#deck-save');
await page.waitForSelector('#deck-library-dialog:not([hidden])');
ok('a TA\'s copy can only be filed with no course (they own none)', await page.evaluate(() => [...document.querySelectorAll('#deck-library-course option')].map((o) => o.value).join(',')) === '');
await page.click('#deck-library-go');
await page.waitForFunction(() => !/PSY415/.test(document.querySelector('#deck-where').textContent), null, { timeout: 10000 }).catch(() => {});
ok(`the copy is theirs to edit ("${await page.textContent('#deck-where')}")`, /^Library · /.test(await page.textContent('#deck-where')) && !/view only/.test(await page.textContent('#deck-where')));
const pad = await tia.newPage();
trap(pad, 'editor controller (tia)');
await pad.goto(`${base}/control.html`);
await pad.waitForSelector('.tile');
ok('the controller offers no ✎ on the course deck for a TA', await pad.locator('.tile', { hasText: 'Week 6' }).locator('.tile-edit').count() === 0);
await tia.close();
}

if (want('the deck editor: from the planner and back (#226)')) {
console.log('\n-- the deck editor: from the planner and back (#226) --');
const owen = await signedIn('owen');
const planner = await owen.newPage();
trap(planner, 'planner');
await planner.goto(`${base}/plan.html`);
await planner.waitForSelector('#type-picker .type-btn');
await planner.click('#type-picker .type-btn:has-text("Marp deck")');
await planner.setInputFiles('#item-fields input[type=file]', { name: 'inside.md', mimeType: 'text/markdown', buffer: Buffer.from(exampleDeck) });
await planner.waitForFunction(() => /Slide 1 of 4/.test(document.querySelector('#deck-where')?.textContent || ''), null, { timeout: 20000 });
const [editor] = await Promise.all([owen.waitForEvent('page'), planner.click('button:has-text("Edit this deck")')]);
trap(editor, 'editor (from planner)');
await editor.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 4, null, { timeout: 20000 });
ok(`a deck inside a plan opens from the planner ("${await editor.textContent('#deck-where')}")`, /Inside the lecture/.test(await editor.textContent('#deck-where')));
await pickSlide(editor, 3);
await editor.click('#deck-add-slide');
await editor.waitForTimeout(400);
await editor.click('#deck-save');
await editor.waitForFunction(() => /Saved into the plan/.test(document.querySelector('#deck-save-state').textContent), null, { timeout: 8000 })
  .then(() => ok('Save hands it back to the planner', true))
  .catch(() => ok('Save hands it back to the planner', false));
await planner.waitForFunction(() => /Slide 1 of 5/.test(document.querySelector('#deck-where')?.textContent || ''), null, { timeout: 10000 })
  .then(() => ok('and the planner\'s preview shows the new slide', true))
  .catch(async () => ok(`and the planner's preview shows the new slide ("${await planner.textContent('#deck-where')}")`, false));
await editor.close();

// A new deck from the planner, saved into the library, becomes the item's deck.
await planner.click('#type-picker .type-btn:has-text("Marp deck")');
const [fresh] = await Promise.all([owen.waitForEvent('page'), planner.click('button:has-text("Write a new deck")')]);
trap(fresh, 'editor (new from planner)');
await fresh.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 2, null, { timeout: 20000 });
ok('"Write a new deck" opens a new deck', /New deck/.test(await fresh.textContent('#deck-where')));
await fresh.click('#deck-save');
await fresh.waitForSelector('#deck-library-dialog:not([hidden])');
ok('saving it offers the courses this person owns', await fresh.evaluate(() => [...document.querySelectorAll('#deck-library-course option')].map((o) => o.value).join(',')) === 'psy415,');
await fresh.click('#deck-library-go');
await waitSaved(fresh);
await planner.waitForFunction(() => {
  const inputs = [...document.querySelectorAll('#item-fields input[type=text]')];
  return inputs.some((i) => /^\/media\/deck\/\d+\//.test(i.value));
}, null, { timeout: 10000 })
  .then(() => ok('and the planner\'s item now points at that library deck', true))
  .catch(() => ok('and the planner\'s item now points at that library deck', false));
await owen.close();
}

if (want('the deck editor: content/decks, for an administrator (#226)')) {
console.log('\n-- the deck editor: content/decks, for an administrator (#226) --');
const root = await signedIn('root');
const page = await root.newPage();
trap(page, 'editor (root)');
await page.goto(`${base}/index.html`);
await page.evaluate((md) => fetch('/api/content/files/decks/week7.md', { method: 'PUT', body: md }), exampleDeck);
await page.goto(`${base}/deck.html?content=week7.md`);
await page.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 4, null, { timeout: 20000 });
ok(`a content/decks file opens ("${await page.textContent('#deck-where')}")`, /content\/decks\/week7\.md/.test(await page.textContent('#deck-where')));
await page.selectOption('#deck-theme', '');
await page.fill('#deck-footer', 'PSY 415 · Week 7');
await page.press('#deck-footer', 'Tab');
await page.waitForTimeout(400);
await page.click('#deck-save');
await waitSaved(page);
const file = await page.evaluate(() => fetch('/api/content/files/decks/week7.md').then((r) => r.json()));
ok('Save writes it back, footer set from the deck settings', /^footer: "?PSY 415 · Week 7"?$/m.test(file.file.text));
expecting.deckConflict = true;
const stale = await page.evaluate(() => fetch('/api/content/files/decks/week7.md?ifMtime=1', { method: 'PUT', body: 'x' }).then((r) => r.status));
expecting.deckConflict = false;
ok('a save against an older version of the file is refused', stale === 412);
await root.close();
}

if (want('the deck editor: drafts, downloads, completion and checks (#226)')) {
console.log('\n-- the deck editor: drafts, downloads, completion and checks (#226) --');
// The plain relay (no accounts, no library): the editor still works.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
trap(page, 'editor (no server)');
await page.goto(`${BASE}/deck.html`);
await page.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 2, null, { timeout: 20000 });
ok('with no library, the save menu offers no library', await page.isHidden('#deck-save-library'));
await pickSlide(page, 1);
await page.keyboard.type('<!-- _cl');
await page.waitForSelector('.cm-tooltip-autocomplete', { timeout: 5000 }).catch(() => {});
ok('typing a directive offers to complete it', (await page.textContent('.cm-tooltip-autocomplete').catch(() => '')).includes('class'));
await page.keyboard.press('Escape');
await page.keyboard.press('Control+z');
await page.keyboard.type('![](assets/icons/icon-192.png)\n');
await page.waitForFunction(() => /no description/.test(document.querySelector('#deck-problems').textContent), null, { timeout: 5000 })
  .then(() => ok('a picture with no description is listed under "Check before class"', true))
  .catch(() => ok('a picture with no description is listed under "Check before class"', false));
ok('and marked in the editor\'s gutter', await page.evaluate(() => !!document.querySelector('.cm-lint-marker')));

await page.reload();
await page.waitForFunction(() => /unsaved changes to this deck/.test(document.querySelector('#deck-warn').textContent), null, { timeout: 10000 })
  .then(() => ok('a reload offers the unsaved work back', true))
  .catch(() => ok('a reload offers the unsaved work back', false));
await page.click('#deck-warn button:has-text("Restore them")');
await page.waitForFunction(() => /no description/.test(document.querySelector('#deck-problems').textContent), null, { timeout: 5000 })
  .then(() => ok('and restores it', true))
  .catch(() => ok('and restores it', false));
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#deck-save')]);
const body = fs.readFileSync(await download.path(), 'utf8');
ok(`Save, with nowhere to save to, downloads the .md (${download.suggestedFilename()})`, /\.md$/.test(download.suggestedFilename()) && body.includes('assets/icons/icon-192.png'));
await ctx.close();
}

reportErrors();
} finally {
  server.kill();
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(content, { recursive: true, force: true });
  await teardown();
}
exitWithResult();
