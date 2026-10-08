// Podium end-to-end group: the deck editor (Issue #226), and the planner's
// lecture archive (Issue #239), Quick Look (Issue #242), the server file
// picker (Issue #241), My Files (Issue #243) and markdown documents (Issue
// #240), which want the same server with accounts.
//
//   node podium/test/e2e/editor.mjs [--only <name>[,<name>...]]
//
// Starts its own relay and browser (see harness.mjs), plus a server with
// accounts and a library, so it runs on its own. node podium/test/e2e.mjs
// runs every group.

import {
  ROOT, fs, path, os, spawn, execFileSync, freePort, BASE, browser, ok, want, trap, expecting,
  reportErrors, teardown, exitWithResult, writeImageFixture,
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
  // Guarded: it also runs in a new tab's first about:blank, which has no storage.
  await ctx.addInitScript((cfg) => { try { localStorage.setItem('podium.config.v2', cfg); } catch { /* about:blank */ } },
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

if (want('the deck editor: pictures and videos, into the library and onto the projector (#226)')) {
console.log('\n-- the deck editor: pictures and videos, into the library and onto the projector (#226) --');
const owen = await signedIn('owen');
const desk = await owen.newPage();
trap(desk, 'editor media (owen)');
await desk.goto(`${base}/index.html`);
const mediaDeck = (await desk.evaluate(async () => (await fetch('/api/library/upload?filename=media.md&course=psy415&title=Media', {
  method: 'POST',
  body: '---\nmarp: true\ntitle: Media week\n---\n\n# Media week\n\n---\n\n## A picture\n\n---\n\n## A video\n\n---\n\n## After the video\n',
})).json())).item;
await desk.goto(`${base}/deck.html?library=${mediaDeck.id}`);
await desk.waitForFunction(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length === 4, null, { timeout: 20000 });
const markdown = () => desk.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));

// A screenshot pasted into the editor.
await pickSlide(desk, 1);
await desk.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#d33'; g.fillRect(0, 0, 320, 200);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
  document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await desk.waitForSelector('#deck-image-dialog:not([hidden])', { timeout: 5000 });
ok(`a pasted picture opens the picture dialog with it chosen ("${await desk.textContent('#deck-image-chosen')}")`, /^pasted-\d{8}-\d{6}\.png · /.test(await desk.textContent('#deck-image-chosen')));
ok('to be kept under the deck\'s course', (await desk.inputValue('#deck-image-course')) === 'psy415');
await desk.click('#deck-image-go');
ok('Add asks for a description first, once', /Describe the picture first/.test(await desk.textContent('#deck-image-note')));
await desk.fill('#deck-image-alt', 'A red rectangle');
await desk.click('#deck-image-go');
await desk.waitForFunction(() => document.querySelector('#deck-image-dialog').hidden, null, { timeout: 10000 });
await until(async () => /!\[A red rectangle\]\(\/media\/[0-9a-f]{64}\/pasted-[\d-]+\.png\)/.test(await markdown()))
  .then(() => ok('the slide links to it in the library, with its description', true))
  .catch(async () => ok(`the slide links to it in the library (${(await markdown()).slice(0, 200)})`, false));
const listed = (await desk.evaluate(() => fetch('/api/library').then((r) => r.json()))).items;
const picture = listed.find((i) => i.type === 'image' && i.deckMedia);
ok('it is in the library as deck media, under the deck\'s course', picture?.course === 'psy415' && picture.group === 'Deck media' && picture.deckMedia === 'Media week');
const again = await desk.evaluate(async (src) => {
  const blob = await (await fetch(src)).blob();
  return (await fetch('/api/library/upload?filename=again.png&course=psy415&deckMedia=Media%20week', { method: 'POST', body: blob })).json();
}, picture.src);
ok('the same picture added again is the same library item', again.existing === true && again.item.id === picture.id);
ok('the preview shows it', await desk.waitForFunction(() => {
  const img = document.querySelector('#deck-preview .r-deck')?.shadowRoot?.querySelector('svg.podium-on img');
  return img && img.complete && img.naturalWidth === 320;
}, null, { timeout: 10000 }).then(() => true).catch(() => false));

// The same picture again, picked from the library this time, onto the last slide.
await pickSlide(desk, 3);
await desk.click('.deck-toolbar [data-cmd="image"]');
await desk.click('#deck-image-dialog [data-from="library"]');
await desk.waitForSelector('#deck-image-library .deck-media-tile', { timeout: 5000 });
ok('the library tab lists the pictures in the library', await desk.locator('#deck-image-library .deck-media-tile').count() >= 1);
await desk.fill('#deck-image-search', 'nothing like this');
ok('and searches them', await desk.locator('#deck-image-library .deck-media-tile').count() === 0);
await desk.fill('#deck-image-search', 'pasted');
await desk.click('#deck-image-library .deck-media-tile');
await desk.selectOption('#deck-image-place', 'bg right:40%');
await desk.click('#deck-image-go');
await until(async () => (await markdown()).includes(`![bg right:40%](${picture.src})`))
  .then(() => ok('picked from the library, it is placed as asked, with no second upload', true))
  .catch(() => ok('picked from the library, it is placed as asked', false));

// Dropped on a slide in the strip, a picture goes on that slide.
await desk.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  c.getContext('2d').fillRect(0, 0, 64, 64);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'square.png', { type: 'image/png' }));
  const cell = document.querySelector('#deck-strip').shadowRoot.querySelectorAll('.cell')[0];
  cell.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, composed: true }));
  cell.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, composed: true }));
});
await desk.waitForSelector('#deck-image-dialog:not([hidden])', { timeout: 5000 });
ok(`a picture dropped on a slide in the strip opens the dialog for that slide ("${await desk.textContent('#deck-image-chosen')}")`,
  /^square\.png/.test(await desk.textContent('#deck-image-chosen')) && /^Slide 1/.test(await desk.textContent('#deck-slide-heading')));
await desk.click('#deck-image-cancel');

// A video slide, from a file.
await pickSlide(desk, 2);
await desk.click('.deck-toolbar [data-cmd="video"]');
await desk.setInputFiles('#deck-video-file', path.join(ROOT, 'test', 'e2e', 'media-fixtures', 'four-colours.webm'));
await desk.fill('#deck-video-start', '0:01');
await desk.press('#deck-video-start', 'Tab');
await desk.click('#deck-video-go');
await desk.waitForFunction(() => document.querySelector('#deck-video-dialog').hidden, null, { timeout: 20000 })
  .catch(async () => ok(`the video dialog finished (${await desk.textContent('#deck-video-note')})`, false));
const md = await markdown();
ok('the slide gets a _video directive pointing into the library', /<!-- _video: \/media\/[0-9a-f]{64}\/four-colours\.webm -->/.test(md));
ok('and where it starts', /_videoStart: "?0:01"?/.test(md));
ok('and a poster, grabbed from that frame', /!\[bg contain\]\(\/media\/[0-9a-f]{64}\/four-colours-poster\.jpg\)/.test(md));
const poster = /!\[bg contain\]\((\/media\/[0-9a-f]{64}\/four-colours-poster\.jpg)\)/.exec(md)?.[1];
const posterColour = poster ? await desk.evaluate((src) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const [r, gr, b] = g.getImageData(Math.round(img.width * 0.6), Math.round(img.height * 0.6), 1, 1).data;
    resolve(r > 150 && gr > 150 ? 'yellow' : r > 150 ? 'red' : gr > 150 ? 'green' : b > 150 ? 'blue' : `rgb(${r},${gr},${b})`);
  };
  img.onerror = () => resolve('unreadable');
  img.src = src;
}), poster) : 'none';
ok(`the poster is the frame at 0:01 (${posterColour})`, posterColour === 'green');
ok('the strip marks it as a video slide', await desk.waitForFunction(() => [...document.querySelector('#deck-strip').shadowRoot.querySelectorAll('.cell')[2].querySelectorAll('.badge')]
  .some((b) => b.textContent === '🎬'), null, { timeout: 5000 }).then(() => true).catch(() => false));
ok('and the slide panel says what it plays', /four-colours\.webm, from 0:01/.test(await desk.textContent('#deck-slide-video-text')));
const videoItems = (await desk.evaluate(() => fetch('/api/library').then((r) => r.json()))).items.filter((i) => i.deckMedia);
ok('the video and its poster are in the library too', videoItems.some((i) => i.type === 'video' && i.filename === 'four-colours.webm') && videoItems.some((i) => i.filename === 'four-colours-poster.jpg'));
ok('nothing to fix before class', !/no poster|not on this server/.test(await desk.textContent('#deck-problems')));
await desk.click('#deck-save');
await waitSaved(desk);

// On the projector, driven from the controller like any video.
const screen = await owen.newPage();
trap(screen, 'editor media display');
await screen.goto(`${base}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await owen.newPage();
trap(pad, 'editor media controller');
await pad.goto(`${base}/control.html`);
await pad.waitForSelector('.tile');
ok('the controller\'s library keeps deck media out of the tiles', await pad.locator('.tile', { hasText: 'four-colours' }).count() === 0);
await pad.click('#lib-deck-media');
ok('until asked for', await pad.locator('.tile', { hasText: 'four-colours' }).count() >= 1);
await pad.click('#lib-deck-media');
await pad.click('.tile:has(.tile-title:text-is("Media"))');
const wallDeck = '.layer[data-role="program"] .r-deck';
await screen.waitForFunction((sel) => (document.querySelector(sel)?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length || 0) === 4, wallDeck, { timeout: 20000 });
await pad.click('.tab[data-tab="now"]');
await pad.click('#next-page');
ok('the pasted picture reaches the projector', await screen.waitForFunction((sel) => {
  const img = document.querySelector(sel)?.shadowRoot?.querySelector('svg.podium-on img');
  return img && img.complete && img.naturalWidth === 320;
}, wallDeck, { timeout: 10000 }).then(() => true).catch(() => false));
ok('a slide with no video has no transport', await pad.isHidden('#transport'));
await pad.click('#next-page');
const wallVideo = (fn) => screen.evaluate(([sel, body]) => {
  const v = document.querySelector(sel)?.shadowRoot?.querySelector('#video-box video');
  return v ? new Function('v', body)(v) : null;
}, [wallDeck, `return (${fn})(v);`]);
// A slide with a background picture is still one slide (Marp draws it as
// three sections; counting those made this four-slide deck six).
await pad.waitForFunction(() => /^Slide 3 \//.test(document.querySelector('#page-label').textContent), null, { timeout: 5000 }).catch(() => {});
ok(`a poster does not add slides to the deck ("${await pad.textContent('#page-label')}")`, /^Slide 3 \/ 4$/.test(await pad.textContent('#page-label')));
await pad.waitForSelector('#transport:not([hidden])', { timeout: 8000 })
  .then(() => ok('on the video slide, the Now tab has the transport', true))
  .catch(() => ok('on the video slide, the Now tab has the transport', false));
await until(async () => await wallVideo('(v) => v.readyState >= 2 && v.classList.contains("has-frame")'))
  .then(() => ok('the display has the video over the slide, ready at its start', true))
  .catch(() => ok('the display has the video over the slide, ready at its start', false));
ok('arriving on the slide does not start it', await wallVideo('(v) => v.paused'));
await pad.click('#play-pause');
await until(async () => await wallVideo('(v) => !v.paused && v.currentTime > 1.3'))
  .then(() => ok('Play plays it on the projector, from 0:01', true))
  .catch(async () => ok(`Play plays it on the projector (${await wallVideo('(v) => `${v.paused} ${v.currentTime}`')})`, false));
await pad.waitForFunction(() => document.querySelector('#play-pause').textContent === '⏸', null, { timeout: 5000 })
  .then(() => ok('and the controller hears that it is playing', true))
  .catch(() => ok('and the controller hears that it is playing', false));
// The clip is four seconds long: pause it straight away, and set its level
// while it is paused - the faders reach it either way.
await pad.click('#play-pause');
await until(async () => await wallVideo('(v) => v.paused'))
  .then(() => ok('Pause pauses it', true))
  .catch(() => ok('Pause pauses it', false));
const pausedAt = await wallVideo('(v) => v.currentTime');
await pad.click('.tab[data-tab="mixer"]');
const fader = (sel, value) => pad.evaluate(([s, v]) => { const input = document.querySelector(s); input.value = String(v); input.dispatchEvent(new Event('input', { bubbles: true })); }, [sel, value]);
await fader('#mixer-master', 1);
await fader('#mixer-content', 0.4);
await until(async () => await wallVideo('(v) => Math.abs(v.volume - 0.4) < 0.01'))
  .then(() => ok('the Mixer\'s content fader sets its volume', true))
  .catch(async () => ok(`the Mixer's content fader sets its volume (${await wallVideo('(v) => v.volume')})`, false));
await pad.click('.tab[data-tab="now"]');
// #182 on a video slide: the controller's copy moves to the paused frame,
// and marking it up then playing on keeps a photo of the frame and the marks.
await until(async () => await pad.evaluate((t) => {
  const v = document.querySelector('#now-preview .r-deck')?.shadowRoot?.querySelector('#video-box video');
  return !!v && Math.abs(v.currentTime - t) < 0.3 && v.readyState >= 2;
}, pausedAt))
  .then(() => ok('the Now tab\'s copy moves to the frame the room is paused on', true))
  .catch(() => ok('the Now tab\'s copy moves to the frame the room is paused on', false));
await pad.click('.tab[data-tab="ink"]');
const inkBox = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await pad.mouse.move(inkBox.x + inkBox.w * 0.2, inkBox.y + inkBox.h * 0.2);
await pad.mouse.down();
await pad.mouse.move(inkBox.x + inkBox.w * 0.5, inkBox.y + inkBox.h * 0.4, { steps: 5 });
await pad.mouse.up();
await screen.waitForFunction(() => document.querySelector('#ink').classList.contains('has-ink'), null, { timeout: 5000 });
const shotsBefore = await pad.evaluate(() => document.querySelectorAll('#photo-strip .shot img').length);
await pad.click('.tab[data-tab="now"]');
await pad.click('#play-pause');
await until(async () => await wallVideo('(v) => !v.paused'));
await pad.waitForFunction((n) => document.querySelectorAll('#photo-strip .shot img').length > n, shotsBefore, { timeout: 10000 })
  .then(async () => ok(`playing a marked-up paused video slide keeps a photo of it ("${await pad.evaluate(() => document.querySelector('#photo-strip .shot img').alt)}")`,
    /^Paused video — /.test(await pad.evaluate(() => document.querySelector('#photo-strip .shot img').alt))))
  .catch(() => ok('playing a marked-up paused video slide keeps a photo of it', false));
await pad.click('#next-page');
await until(async () => await screen.evaluate((sel) => !document.querySelector(sel).shadowRoot.querySelector('#video-box').classList.contains('is-on'), wallDeck))
  .then(() => ok('moving on to the next slide takes the video away', true))
  .catch(() => ok('moving on to the next slide takes the video away', false));
ok('and pauses it', await wallVideo('(v) => v.paused'));
await pad.click('#prev-page');
await until(async () => await wallVideo('(v) => v.readyState >= 2'));
const backAt = await wallVideo('(v) => v.currentTime');
ok(`coming back finds it where it was left (${backAt.toFixed(2)} s, paused first at ${pausedAt.toFixed(2)} s)`, backAt >= pausedAt && await wallVideo('(v) => v.paused'));
await screen.close();
await pad.close();
await owen.close();

// A TA cannot file deck media under the course - they cannot edit its decks.
const tia = await signedIn('tia');
const tiaPage = await tia.newPage();
trap(tiaPage, 'editor media (tia)');
await tiaPage.goto(`${base}/index.html`);
expecting.deckForbidden = true;
const refused = await tiaPage.evaluate(() => fetch('/api/library/upload?filename=x.png&course=psy415&deckMedia=Week%206', { method: 'POST', body: 'not really a png' }).then((r) => r.status));
expecting.deckForbidden = false;
ok(`a TA cannot add pictures to the course's decks (${refused})`, refused === 403);
await tia.close();
}

if (want('the deck editor: templates - built-in, a course\'s and your own (#226)')) {
console.log('\n-- the deck editor: templates - built-in, a course\'s and your own (#226) --');
const owen = await signedIn('owen');
const desk = await owen.newPage();
trap(desk, 'editor templates (owen)');
await desk.goto(`${base}/index.html`);
const tplDeck = (await desk.evaluate(async () => (await fetch('/api/library/upload?filename=templated.md&course=psy415&title=Templated', {
  method: 'POST', body: '---\nmarp: true\ntitle: Templated\n---\n\n# Templated\n\n---\n\n## Second\n',
})).json())).item;
await desk.goto(`${base}/deck.html?library=${tplDeck.id}`);
await desk.waitForFunction(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length === 2, null, { timeout: 20000 });
const card = (title) => desk.locator('.deck-template', { has: desk.locator('.deck-template-title', { hasText: title }) });
const openTemplates = async () => {
  await desk.click('.deck-toolbar [data-cmd="template"]');
  await desk.waitForSelector('#deck-templates-dialog:not([hidden]) .deck-template', { timeout: 10000 });
};

await pickSlide(desk, 0);
await openTemplates();
ok('⧉ Template lists the built-in slide templates', await card('Build list').count() === 1 && await card('Title slide').count() === 1);
ok('and not the whole-deck ones on the Slides tab', await card('Lecture').count() === 0);
await desk.waitForFunction(() => !!document.querySelector('.deck-template .deck-template-thumb')?.shadowRoot?.querySelector('svg[data-marpit-svg]'), null, { timeout: 15000 })
  .then(() => ok('each shows its slide, drawn by Marp', true))
  .catch(() => ok('each shows its slide, drawn by Marp', false));
await card('Build list').locator('[data-act="use"]').click();
await desk.waitForFunction(() => document.querySelector('#deck-strip').shadowRoot.querySelectorAll('.cell').length === 3, null, { timeout: 5000 });
ok(`a slide template goes in after the slide you are on (${(await stripTitles(desk)).join(' | ')})`, (await stripTitles(desk))[1] === 'Three things to remember');
ok('and the cursor goes with it', /^Slide 2/.test(await desk.textContent('#deck-slide-heading')));
await openTemplates();
await card('Picture and caption').locator('[data-act="use"]').click();
await desk.waitForSelector('#deck-image-dialog:not([hidden])', { timeout: 5000 })
  .then(() => ok('"Picture and caption" goes in and asks for its picture', true))
  .catch(() => ok('"Picture and caption" goes in and asks for its picture', false));
await desk.click('#deck-image-cancel');

// The slide you are on, saved for the course.
await pickSlide(desk, 1);
await openTemplates();
ok('saving a template offers the course the deck is in', (await desk.inputValue('#deck-templates-scope')) === 'course:psy415');
ok('named after the slide to begin with', (await desk.inputValue('#deck-templates-name')) === 'Three things to remember');
await desk.fill('#deck-templates-name', 'PSY 415 builds');
await desk.click('#deck-templates-save-go');
await card('PSY 415 builds').waitFor({ timeout: 5000 });
ok('"Save this slide as a template" adds it for the course', /PSY415/.test(await card('PSY 415 builds').locator('.deck-template-badge').textContent()));
desk.once('dialog', (d) => d.accept('PSY 415 build list'));
await card('PSY 415 builds').locator('[data-act="rename"]').click();
await card('PSY 415 build list').waitFor({ timeout: 5000 });
ok('Rename renames it', await card('PSY 415 builds').count() === 0);
await card('Quote').locator('[data-act="copy"]').selectOption('mine');
await desk.locator('.deck-template', { has: desk.locator('.deck-template-badge', { hasText: 'Mine' }) }).first().waitFor({ timeout: 5000 });
ok('a built-in copied to Mine is yours to change', await desk.locator('.deck-template:has(.deck-template-badge:text-is("Mine"))').locator('[data-act="edit"]').count() === 1);
ok('the built-in itself cannot be changed', await card('Quote').first().locator('[data-act="edit"]').count() === 0
  || await desk.locator('.deck-template:has(.deck-template-badge:text-is("Built-in")):has-text("Quote") [data-act="edit"]').count() === 0);
const mineQuote = desk.locator('.deck-template:has(.deck-template-badge:text-is("Mine"))');
await mineQuote.locator('[data-act="delete"]').click();
ok('Delete asks again first', (await mineQuote.locator('[data-act="delete"]').textContent()) === 'Sure?');
await mineQuote.locator('[data-act="delete"]').click();
await desk.waitForFunction(() => !document.querySelector('.deck-template .deck-template-badge.is-mine'), null, { timeout: 5000 })
  .then(() => ok('and then deletes it', true))
  .catch(() => ok('and then deletes it', false));

// Edit opens the template itself in the editor, in a new tab, saved back to it.
const [editor] = await Promise.all([owen.waitForEvent('page'), card('PSY 415 build list').locator('[data-act="edit"]').click()]);
trap(editor, 'editor templates (owen, template tab)');
await editor.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 1, null, { timeout: 20000 });
ok(`Edit opens the template in the editor ("${await editor.textContent('#deck-where')}")`, /^Template · PSY415 · PSY 415 build list \(a slide\)$/.test(await editor.textContent('#deck-where')));
await editor.fill('#deck-slide-notes', 'Reveal these one at a time.');
await editor.click('#deck-slide-class');
await editor.click('#deck-save');
await waitSaved(editor);
const listed = await editor.evaluate(() => fetch('/api/deck-templates').then((r) => r.json()));
ok('and Save writes it back to the template', listed.templates.find((t) => t.title === 'PSY 415 build list')?.markdown.includes('Reveal these one at a time.'));
await editor.close();

// A whole deck from a template, and the open deck saved as one.
await desk.click('#deck-templates-close');
await desk.click('#deck-save-more');
await desk.click('#deck-new-template');
await desk.waitForSelector('#deck-templates-dialog:not([hidden]) .deck-template', { timeout: 10000 });
ok('"New deck from a template" lists the whole-deck templates', await card('Lecture').count() === 1 && await card('Build list').count() === 0);
await desk.fill('#deck-templates-name', 'Owen\'s three-slide deck');
await desk.selectOption('#deck-templates-scope', 'mine');
await desk.click('#deck-templates-save-go');
await card('Owen\'s three-slide deck').waitFor({ timeout: 5000 });
ok('the open deck can be saved as a deck template of your own', await card('Owen\'s three-slide deck').count() === 1);
await card('Lecture').locator('[data-act="use"]').click();
await desk.waitForURL(/from=b%3Alecture|from=b:lecture/, { timeout: 10000 }).catch(() => {});
await desk.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 6, null, { timeout: 20000 })
  .then(() => ok('a deck template starts a new deck, the open one kept as a draft', true))
  .catch(async () => ok(`a deck template starts a new deck (${await stripCount(desk)} slides)`, false));
ok('which is not saved anywhere yet', /New deck/.test(await desk.textContent('#deck-where')));
await owen.close();

// A TA uses the course's templates but does not change them, and never sees
// anyone else's own.
const tia = await signedIn('tia');
const tiaPage = await tia.newPage();
trap(tiaPage, 'editor templates (tia)');
await tiaPage.goto(`${base}/deck.html`);
await tiaPage.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 2, null, { timeout: 20000 });
await tiaPage.click('.deck-toolbar [data-cmd="template"]');
await tiaPage.waitForSelector('#deck-templates-dialog:not([hidden]) .deck-template', { timeout: 10000 });
const tiaCard = tiaPage.locator('.deck-template', { has: tiaPage.locator('.deck-template-title', { hasText: 'PSY 415 build list' }) });
await tiaCard.waitFor({ timeout: 5000 });
ok('a TA sees the course\'s templates', await tiaCard.count() === 1);
ok('can use them, but not change them', await tiaCard.locator('[data-act="use"]').count() === 1
  && await tiaCard.locator('[data-act="edit"], [data-act="rename"], [data-act="delete"]').count() === 0);
ok('and can only save templates for themselves', JSON.stringify(await tiaPage.$$eval('#deck-templates-scope option', (os) => os.map((o) => o.value))) === '["mine"]');
await tiaPage.click('.deck-media-tabs [data-kind="deck"]');
ok('nobody else\'s own templates show', await tiaPage.locator('.deck-template', { hasText: 'Owen\'s three-slide deck' }).count() === 0);
const courseTpl = (await tiaPage.evaluate(() => fetch('/api/deck-templates').then((r) => r.json()))).templates.find((t) => t.title === 'PSY 415 build list');
expecting.deckForbidden = true;
const refused = await tiaPage.evaluate((id) => fetch(`/api/deck-templates/${id}`, { method: 'DELETE' }).then((r) => r.status), courseTpl.id);
expecting.deckForbidden = false;
ok(`and the server refuses a TA deleting one (${refused})`, refused === 403);

// An administrator can hide a built-in for everyone.
const root = await signedIn('root');
const rootPage = await root.newPage();
trap(rootPage, 'editor templates (root)');
await rootPage.goto(`${base}/deck.html`);
await rootPage.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 2, null, { timeout: 20000 });
await rootPage.click('.deck-toolbar [data-cmd="template"]');
await rootPage.waitForSelector('#deck-templates-dialog:not([hidden]) .deck-template', { timeout: 10000 });
const quote = rootPage.locator('.deck-template', { has: rootPage.locator('.deck-template-title', { hasText: 'Quote' }) });
await quote.locator('[data-act="hide"]').click();
await rootPage.waitForFunction(() => [...document.querySelectorAll('.deck-template-badge')].some((b) => b.textContent === 'Built-in · hidden'), null, { timeout: 5000 })
  .then(() => ok('an administrator can hide a built-in, and still sees it, marked hidden', true))
  .catch(() => ok('an administrator can hide a built-in, and still sees it, marked hidden', false));
await tiaPage.click('#deck-templates-close');
await tiaPage.click('.deck-toolbar [data-cmd="template"]');
await tiaPage.waitForSelector('#deck-templates-dialog:not([hidden]) .deck-template', { timeout: 10000 });
await tiaPage.waitForTimeout(500);
ok('then nobody else sees it', await tiaPage.locator('.deck-template', { has: tiaPage.locator('.deck-template-title', { hasText: 'Quote' }) }).count() === 0);
await quote.locator('[data-act="hide"]').click();
await rootPage.waitForFunction(() => ![...document.querySelectorAll('.deck-template-badge')].some((b) => b.textContent === 'Built-in · hidden'), null, { timeout: 5000 });
await tia.close();
await root.close();
}

if (want('the deck editor: versions, an edited deck on the projector, .zip and PDF (#226)')) {
console.log('\n-- the deck editor: versions, an edited deck on the projector, .zip and PDF (#226) --');
const owen = await signedIn('owen');
await owen.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
const desk = await owen.newPage();
trap(desk, 'editor polish (owen)');
await desk.goto(`${base}/index.html`);
const original = '---\nmarp: true\ntitle: Versions\n---\n\n# Versions\n\n---\n\n## One\n\n---\n\n## Two\n';
const vDeck = (await desk.evaluate(async (md) => (await fetch('/api/library/upload?filename=versions.md&course=psy415&title=Versions', { method: 'POST', body: md })).json(), original)).item;
await desk.goto(`${base}/deck.html?library=${vDeck.id}`);
await desk.waitForFunction(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length === 3, null, { timeout: 20000 });

// Two saves, then the first version back.
for (const n of [1, 2]) {
  await pickSlide(desk, 2);
  await desk.click('#deck-add-slide');
  await desk.keyboard.type(`Added ${n}`);
  await desk.waitForTimeout(400);
  await desk.click('#deck-save');
  await waitSaved(desk);
}
await desk.click('#deck-save-more');
ok('a library deck offers its previous versions', await desk.isVisible('#deck-versions'));
await desk.click('#deck-versions');
await desk.waitForSelector('#deck-versions-list li', { timeout: 5000 });
ok(`each save kept the version it replaced (${await desk.locator('#deck-versions-list li').count()})`, await desk.locator('#deck-versions-list li').count() === 2);
ok('saying who saved over it', /Owen Owner saved over it/.test(await desk.textContent('#deck-versions-list li')));
await desk.locator('#deck-versions-list li').last().locator('button').click();
await desk.waitForFunction(() => document.querySelector('#deck-strip').shadowRoot.querySelectorAll('.cell').length === 3, null, { timeout: 5000 })
  .then(() => ok('opening the oldest puts it in the editor', true))
  .catch(() => ok('opening the oldest puts it in the editor', false));
ok('saying how to keep it or undo it', /Save to make it the deck again/.test(await desk.textContent('#deck-warn')));
ok('as unsaved changes, until Save', /Unsaved/.test(await desk.textContent('#deck-save-state')));

// The deck goes up; then it is saved again, and the controller says so.
const screen = await owen.newPage();
trap(screen, 'editor polish display');
await screen.goto(`${base}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await owen.newPage();
trap(pad, 'editor polish controller');
await pad.goto(`${base}/control.html`);
await pad.waitForSelector('.tile');
await pad.click('.tile:has(.tile-title:text-is("Versions"))');
const wall = '.layer[data-role="program"] .r-deck';
const slidesUp = () => screen.evaluate((sel) => document.querySelector(sel)?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length || 0, wall);
await until(async () => (await slidesUp()) === 5);
await pad.click('.tab[data-tab="slides"]');
await pad.click('#deck-next');
await pad.click('#deck-next');
ok('nothing to say while the library has the deck as it went up', await pad.isHidden('#deck-edited'));
await desk.click('#deck-save');
await waitSaved(desk);
await pad.waitForSelector('#deck-edited:not([hidden])', { timeout: 10000 })
  .then(() => ok('saved again in the editor, the controller says the deck on screen was edited', true))
  .catch(() => ok('saved again in the editor, the controller says the deck on screen was edited', false));
ok('and the room still sees the version it went up with', (await slidesUp()) === 5);
await pad.click('#deck-reload');
await until(async () => (await slidesUp()) === 3)
  .then(() => ok('"Reload it" puts the new version up', true))
  .catch(async () => ok(`"Reload it" puts the new version up (${await slidesUp()} slides)`, false));
await pad.waitForFunction(() => /^Slide 3 \//.test(document.querySelector('#deck-count').textContent), null, { timeout: 5000 })
  .then(() => ok('at the slide it was on', true))
  .catch(async () => ok(`at the slide it was on (${await pad.textContent('#deck-count')})`, false));
ok('and the note goes', await pad.isHidden('#deck-edited'));
await screen.close();
await pad.close();

// A picture on a slide, then out as a .zip and back in.
await pickSlide(desk, 1);
await desk.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 200; c.height = 120;
  const g = c.getContext('2d');
  g.fillStyle = '#2a6'; g.fillRect(0, 0, 200, 120);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'green.png', { type: 'image/png' }));
  document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await desk.waitForSelector('#deck-image-dialog:not([hidden])');
await desk.fill('#deck-image-alt', 'A green rectangle');
await desk.click('#deck-image-go');
await desk.waitForFunction(() => document.querySelector('#deck-image-dialog').hidden, null, { timeout: 10000 });
await desk.click('#deck-save');
await waitSaved(desk);
await desk.click('#deck-save-more');
const [zipDownload] = await Promise.all([desk.waitForEvent('download'), desk.click('#deck-download-zip')]);
const zipBytes = fs.readFileSync(await zipDownload.path());
const zipped = await desk.evaluate(async (bytes) => {
  const { readZip } = await import('/assets/js/zip.js');
  const files = await readZip(new Blob([new Uint8Array(bytes)]));
  const md = files.find((f) => f.name.endsWith('.md'));
  return { names: files.map((f) => f.name), md: new TextDecoder().decode(await md.read()) };
}, [...zipBytes]);
ok(`the .zip holds the deck and its picture (${zipped.names.join(', ')})`, zipped.names.some((n) => /\.md$/.test(n)) && zipped.names.includes('media/green.png'));
ok('with the deck pointing at the picture beside it', /!\[A green rectangle\]\(media\/green\.png\)/.test(zipped.md));
await desk.goto(`${base}/deck.html`);
await desk.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 2, null, { timeout: 20000 });
desk.once('dialog', (d) => d.accept());
await desk.setInputFiles('#deck-file', { name: 'versions.zip', mimeType: 'application/zip', buffer: zipBytes });
await desk.waitForFunction(() => /versions\.md/.test(document.querySelector('#deck-where').textContent), null, { timeout: 15000 })
  .then(() => ok('opening the .zip opens the deck in it', true))
  .catch(async () => ok(`opening the .zip opens the deck in it ("${await desk.textContent('#deck-where')}")`, false));
const reopened = await desk.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
ok('its picture back in the library, the deck pointing there', /!\[A green rectangle\]\(\/media\/[0-9a-f]{64}\/green\.png\)/.test(reopened));
ok('and says where the pictures went', /went into the library with no course/.test(await desk.textContent('#deck-warn')));
await desk.waitForFunction(() => {
  const img = document.querySelector('#deck-preview .r-deck')?.shadowRoot?.querySelector('svg.podium-on img');
  return !img || img.complete;
}, null, { timeout: 10000 }).catch(() => {});

// The whole deck as a PDF, a page a slide.
await desk.click('#deck-save-more');
const [pdfDownload] = await Promise.all([desk.waitForEvent('download', { timeout: 60000 }), desk.click('#deck-download-pdf')]);
const pdf = fs.readFileSync(await pdfDownload.path()).toString('latin1');
const pages = (pdf.match(/\/Type \/Page\b/g) || []).length;
const slideCount = await stripCount(desk);
ok(`"Download as a PDF" makes one page a slide (${pages} pages for ${slideCount} slides, ${pdfDownload.suggestedFilename()})`, pdf.startsWith('%PDF') && pages === slideCount && slideCount === 3 && /\.pdf$/.test(pdfDownload.suggestedFilename()));
await owen.close();
}

if (want('the deck editor: pictures inside a lecture plan, with no server (#226)')) {
console.log('\n-- the deck editor: pictures inside a lecture plan, with no server (#226) --');
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const planner = await ctx.newPage();
trap(planner, 'planner (no server)');
await planner.goto(`${BASE}/plan.html`);
await planner.waitForSelector('#type-picker .type-btn');
await planner.click('#type-picker .type-btn:has-text("Marp deck")');
const [editor] = await Promise.all([ctx.waitForEvent('page'), planner.click('button:has-text("Write a new deck")')]);
trap(editor, 'editor (plan, no server)');
await editor.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 2, null, { timeout: 20000 });
await pickSlide(editor, 0);
await editor.click('.deck-toolbar [data-cmd="image"]');
ok('with no server, a deck in a plan can still take a picture from this device', await editor.isVisible('#deck-image-dialog [data-from="device"]')
  && /kept inside the lecture plan/.test(await editor.textContent('#deck-image-dialog .deck-media-offline')));
const png = await editor.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  const g = c.getContext('2d');
  g.fillStyle = '#c33'; g.fillRect(0, 0, 160, 90);
  return [...new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer())];
});
await editor.setInputFiles('#deck-image-file', { name: 'red.png', mimeType: 'image/png', buffer: Buffer.from(png) });
await editor.fill('#deck-image-alt', 'A red box');
await editor.click('#deck-image-go');
await editor.waitForFunction(() => document.querySelector('#deck-image-dialog').hidden, null, { timeout: 10000 })
  .catch(async () => ok(`the picture went in (${await editor.textContent('#deck-image-note')})`, false));
const md = await editor.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
ok('it is kept in the plan, the slide pointing at it by asset:', /!\[A red box\]\(asset:[\w-]+\)/.test(md));
ok('and the editor\'s preview shows it', await editor.waitForFunction(() => {
  const img = document.querySelector('#deck-preview .r-deck')?.shadowRoot?.querySelector('svg.podium-on img');
  return img && img.complete && img.naturalWidth > 0 && img.src.startsWith('data:image/');
}, null, { timeout: 10000 }).then(() => true).catch(() => false));
await editor.click('#deck-save');
await editor.waitForFunction(() => /Saved into the plan/.test(document.querySelector('#deck-save-state').textContent), null, { timeout: 8000 });
ok('handed back, the planner\'s preview shows it too', await planner.waitForFunction(() => {
  const img = document.querySelector('#item-preview .r-deck')?.shadowRoot?.querySelector('svg.podium-on img');
  return img && img.complete && img.naturalWidth > 0 && img.src.startsWith('data:image/');
}, null, { timeout: 10000 }).then(() => true).catch(() => false));
await ctx.close();
}

if (want('the deck editor: decks already on the server, edited where they are')) {
console.log('\n-- the deck editor: decks already on the server, edited where they are --');
const owen = await signedIn('owen');
const planner = await owen.newPage();
trap(planner, 'planner (server decks)');
await planner.goto(`${base}/index.html`);
const oldMd = '---\nmarp: true\ntitle: Old address\n---\n\n# Old address\n\n---\n\n## Two\n';
const oldDeck = (await planner.evaluate(async (md) => (await fetch('/api/library/upload?filename=old-address.md&course=psy415&title=Old%20address', { method: 'POST', body: md })).json(), oldMd)).item;
// How a plan made before the deck editor names a library deck: by its contents.
const oldSrc = `/media/${oldDeck.version}/old-address.md`;

await planner.goto(`${base}/plan.html`);
await planner.waitForSelector('#type-picker .type-btn');
await planner.click('#type-picker .type-btn:has-text("Marp deck")');
await planner.fill('#item-fields input[placeholder="content/decks/week3.md"]', oldSrc);
await planner.press('#item-fields input[placeholder="content/decks/week3.md"]', 'Tab');
await planner.waitForFunction(() => /Slide 1 of 2/.test(document.querySelector('#deck-where')?.textContent || ''), null, { timeout: 20000 });
const [editor] = await Promise.all([owen.waitForEvent('page'), planner.click('button:has-text("Edit this deck")')]);
trap(editor, 'editor (server deck from the planner)');
await editor.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 2, null, { timeout: 20000 });
ok(`a library deck named by its old address opens as the library deck ("${await editor.textContent('#deck-where')}")`, /^Library · PSY415 · old-address\.md$/.test(await editor.textContent('#deck-where')));
await planner.waitForFunction(() => [...document.querySelectorAll('#item-fields input[type=text]')].some((i) => /^\/media\/deck\/\d+\/old-address\.md$/.test(i.value)), null, { timeout: 10000 })
  .then(() => ok('and the lecture now points at the deck\'s own address, so it follows every edit', true))
  .catch(() => ok('and the lecture now points at the deck\'s own address', false));
await pickSlide(editor, 1);
await editor.click('#deck-add-slide');
await editor.keyboard.type('Added in planning');
await editor.waitForTimeout(400);
await editor.click('#deck-save');
await waitSaved(editor);
ok('Save writes it back to the library', (await serverText(editor, oldDeck.src)).includes('Added in planning'));
await planner.waitForFunction(() => /Slide 1 of 3/.test(document.querySelector('#deck-where')?.textContent || ''), null, { timeout: 10000 })
  .then(() => ok('and the planner\'s preview shows the edit', true))
  .catch(async () => ok(`and the planner's preview shows the edit ("${await planner.textContent('#deck-where')}")`, false));
await editor.close();

// During a lecture: the deck on screen, edited from the controller.
const screen = await owen.newPage();
trap(screen, 'server decks display');
await screen.goto(`${base}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await owen.newPage();
trap(pad, 'server decks controller');
await pad.goto(`${base}/control.html`);
await pad.waitForSelector('.tile');
await pad.click('.tile:has(.tile-title:text-is("Old address"))');
const wall = '.layer[data-role="program"] .r-deck';
const slidesUp = () => screen.evaluate((sel) => document.querySelector(sel)?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length || 0, wall);
await until(async () => (await slidesUp()) === 3);
await pad.click('.tab[data-tab="slides"]');
await pad.waitForSelector('#deck-open-editor:not([hidden])', { timeout: 5000 })
  .then(() => ok('the Slides tab offers to edit the deck on screen', true))
  .catch(() => ok('the Slides tab offers to edit the deck on screen', false));
const [quick] = await Promise.all([owen.waitForEvent('page'), pad.click('#deck-open-editor')]);
trap(quick, 'editor (from the controller)');
await quick.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 3, null, { timeout: 20000 });
ok(`it opens in the editor, where it lives ("${await quick.textContent('#deck-where')}")`, /^Library · PSY415 · old-address\.md$/.test(await quick.textContent('#deck-where')));
await pickSlide(quick, 2);
await quick.click('#deck-add-slide');
await quick.keyboard.type('Fixed mid-lecture');
await quick.waitForTimeout(400);
await quick.click('#deck-save');
await waitSaved(quick);
await pad.waitForSelector('#deck-edited:not([hidden])', { timeout: 10000 })
  .then(() => ok('saved, the controller says the deck on screen was edited', true))
  .catch(() => ok('saved, the controller says the deck on screen was edited', false));
await pad.click('#deck-reload');
await until(async () => (await slidesUp()) === 4)
  .then(() => ok('and "Reload it" puts the fix up', true))
  .catch(async () => ok(`and "Reload it" puts the fix up (${await slidesUp()} slides)`, false));
await quick.close();
await screen.close();
await pad.close();
await owen.close();

// A TA presents the course deck, but is not offered an edit they could not save.
const tia = await signedIn('tia');
const tiaScreen = await tia.newPage();
trap(tiaScreen, 'server decks display (tia)');
await tiaScreen.goto(`${base}/display.html`);
await tiaScreen.click('#arm-button');
await tiaScreen.waitForSelector('#hud[data-status="online"]');
const tiaPad = await tia.newPage();
trap(tiaPad, 'server decks controller (tia)');
await tiaPad.goto(`${base}/control.html`);
await tiaPad.waitForSelector('.tile');
await tiaPad.click('.tile:has(.tile-title:text-is("Old address"))');
await tiaPad.click('.tab[data-tab="slides"]');
await tiaPad.waitForSelector('#deck-live:not([hidden])', { timeout: 10000 });
await tiaPad.waitForTimeout(500);
ok('a TA is not offered Edit on a course deck', await tiaPad.isHidden('#deck-open-editor'));
ok('nor ✎ on its tile', await tiaPad.locator('.tile:has(.tile-title:text-is("Old address")) .tile-edit').count() === 0);
ok('nor on a content/decks deck, which only an administrator can save', await tiaPad.locator('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence")) .tile-edit').count() === 0);
await tia.close();

// An administrator can edit content/decks decks where they are.
const root = await signedIn('root');
const rootPad = await root.newPage();
trap(rootPad, 'server decks controller (root)');
await rootPad.goto(`${base}/control.html`);
await rootPad.waitForSelector('.tile');
await rootPad.locator('.tile:has(.tile-title:text-is("Day 6 — Weighing the Evidence")) .tile-edit').waitFor({ timeout: 5000 })
  .then(() => ok('an administrator gets ✎ on a content/decks deck', true))
  .catch(() => ok('an administrator gets ✎ on a content/decks deck', false));
const rootEditor = await root.newPage();
trap(rootEditor, 'editor (root, content deck by address)');
await rootEditor.goto(`${base}/index.html`);
await rootEditor.evaluate(() => fetch('/api/content/files/decks/quick.md', { method: 'PUT', body: '# Quick\n\n---\n\n## Fix\n' }));
await rootEditor.goto(`${base}/deck.html?src=${encodeURIComponent('/content/decks/quick.md')}`);
await rootEditor.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 2, null, { timeout: 20000 });
ok(`a content/decks deck named by its address opens as that file ("${await rootEditor.textContent('#deck-where')}")`, /^content\/decks\/quick\.md$/.test(await rootEditor.textContent('#deck-where')));
await root.close();
}

if (want('the deck editor: Mermaid diagrams, in the editor and on the projector (#235)')) {
console.log('\n-- the deck editor: Mermaid diagrams, in the editor and on the projector (#235) --');
const owen = await signedIn('owen');
// Nothing a diagram needs comes from anywhere but this server.
const elsewhere = [];
owen.on('request', (r) => { if (!/^(data|blob):/.test(r.url()) && !r.url().startsWith(base)) elsewhere.push(r.url()); });
const desk = await owen.newPage();
trap(desk, 'editor diagrams (owen)');
await desk.goto(`${base}/index.html`);
const fence = (body) => `\`\`\`mermaid\n${body}\`\`\`\n`;
const diagramDeck = [
  '---', 'marp: true', 'title: Diagrams', '---', '',
  '# A flowchart', '', fence('flowchart LR\n  A[Stimulus] --> B{Attend?}\n  B -->|yes| C[Encode]\n'),
  '---', '', '<!-- _class: invert -->', '# On a dark slide', '', fence('sequenceDiagram\n  Student->>Podium: Answers\n'),
  '---', '', '<!-- _mermaidTheme: forest -->', '# Its own theme', '', fence('pie title Pets\n  "Dogs" : 3\n  "Cats" : 1\n'),
  '---', '', '# Broken', '', fence('flowchart LR\n  A -->\n'),
  '---', '', '<!-- _mermaidTheme: forest -->', '# The diagram says', '', fence('%%{init: {"theme": "dark"}}%%\nflowchart TD\n  X --> Y\n'),
].join('\n');
const upload = (name, md) => desk.evaluate(async ([file, text]) => {
  const res = await fetch(`/api/library/upload?filename=${file}&course=psy415`, { method: 'POST', body: text });
  return (await res.json()).item;
}, [name, md]);
const plainItem = await upload('no-diagrams.md', '---\nmarp: true\n---\n\n# Just words\n\n```js\nconst x = 1;\n```\n');
const diagramItem = await upload('diagrams.md', diagramDeck);
const fetchedMermaid = (page) => page.evaluate(() => performance.getEntriesByType('resource').some((e) => /mermaid\.esm\.js/.test(e.name)));

await desk.goto(`${base}/deck.html?library=${plainItem.id}`);
await desk.waitForFunction(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length === 1, null, { timeout: 20000 });
ok('a deck with no diagram never fetches the 5 MB diagram bundle', !(await fetchedMermaid(desk)));

await desk.goto(`${base}/deck.html?library=${diagramItem.id}`);
await desk.waitForFunction(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length === 5, null, { timeout: 30000 });
ok('one with a diagram does', await fetchedMermaid(desk));
const strip = await desk.evaluate(() => {
  const root = document.querySelector('#deck-strip').shadowRoot;
  return { drawn: root.querySelectorAll('img.podium-diagram').length, broken: root.querySelectorAll('.podium-diagram-error').length, code: root.querySelectorAll('code.language-mermaid').length };
});
ok(`the strip shows each diagram drawn, not as code (${strip.drawn} drawn, ${strip.broken} broken, ${strip.code} as code)`, strip.drawn === 4 && strip.broken === 1 && strip.code === 0);
await pickSlide(desk, 0);
await desk.waitForFunction(() => !!document.querySelector('#deck-preview .r-deck')?.shadowRoot?.querySelector('img.podium-diagram'), null, { timeout: 10000 })
  .then(() => ok('so does the preview', true))
  .catch(() => ok('so does the preview', false));
const picture = await desk.evaluate(() => {
  const img = document.querySelector('#deck-preview .r-deck').shadowRoot.querySelector('img.podium-diagram');
  const svg = decodeURIComponent(img.getAttribute('src').replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
  return { complete: img.complete && img.naturalWidth > 0, svg: svg.startsWith('<svg'), script: /<script/i.test(svg), alt: img.alt };
});
ok(`each diagram is a picture of its SVG, with no script in it (${picture.alt})`, picture.complete && picture.svg && !picture.script && /flowchart/.test(picture.alt));
const themes = await desk.evaluate(async (md) => {
  const { render } = await import('/assets/js/deck.js');
  return (await render(md)).diagrams.map((d) => d.theme);
}, diagramDeck);
ok(`each in the deck's look unless told otherwise (${themes.join(', ')})`, themes.join() === 'default,dark,forest,default,forest');
await desk.waitForFunction(() => /could not be drawn/.test(document.querySelector('#deck-problems').textContent), null, { timeout: 8000 })
  .then(() => ok('a diagram Mermaid cannot read is listed under "Check before class"', true))
  .catch(() => ok('a diagram Mermaid cannot read is listed under "Check before class"', false));
const problem = await desk.evaluate(() => [...document.querySelectorAll('#deck-problems li')].map((li) => li.textContent).find((t) => /could not be drawn/.test(t)) || '');
ok(`against its slide, saying what is wrong ("${problem.slice(0, 80)}...")`, /^Slide 4:/.test(problem) && /Parse error/.test(problem));
await desk.locator('#deck-problems li', { hasText: 'could not be drawn' }).locator('button').click();
const cursorLine = await desk.evaluate(() => {
  const sel = window.getSelection();
  return sel?.anchorNode?.parentElement?.closest('.cm-line')?.textContent ?? document.querySelector('.cm-activeLine')?.textContent ?? '';
});
ok(`and clicking it goes to the diagram ("${cursorLine.trim()}")`, /flowchart LR|A -->|```mermaid/.test(cursorLine));

// Typing a theme Mermaid does not have is caught before class.
await pickSlide(desk, 0);
await desk.click('.cm-content');
await desk.keyboard.press('Control+Home');
await desk.keyboard.press('Control+End');
await desk.keyboard.type('\n\n---\n\n<!-- _mermaidTheme: drak -->\n# Typo\n');
await desk.waitForFunction(() => /"drak" is not a Mermaid theme/.test(document.querySelector('#deck-problems').textContent), null, { timeout: 8000 })
  .then(() => ok('a misspelt mermaidTheme is flagged as it is typed', true))
  .catch(() => ok('a misspelt mermaidTheme is flagged as it is typed', false));
await desk.keyboard.type('<!-- mermaidT');
await desk.waitForSelector('.cm-tooltip-autocomplete', { timeout: 5000 }).catch(() => {});
ok('and mermaidTheme is offered as a directive', (await desk.textContent('.cm-tooltip-autocomplete').catch(() => '')).includes('mermaidTheme'));
await desk.keyboard.press('Escape');

// The projector, and the controller that drives it.
const screen = await owen.newPage();
trap(screen, 'diagrams display');
await screen.goto(`${base}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await owen.newPage();
trap(pad, 'diagrams controller');
await pad.goto(`${base}/control.html`);
await pad.waitForSelector('.tile');
await pad.locator('.tile', { hasText: 'Diagrams' }).first().click();
const onWall = () => screen.evaluate(() => {
  const root = document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot;
  return root ? { slides: root.querySelectorAll('svg[data-marpit-svg]').length, drawn: root.querySelectorAll('img.podium-diagram').length, broken: root.querySelectorAll('.podium-diagram-error').length } : null;
});
await until(async () => (await onWall())?.drawn === 4, { timeout: 30000 }).catch(() => {});
const wall = await onWall();
ok(`the projector draws the diagrams (${JSON.stringify(wall)})`, wall?.slides === 5 && wall.drawn === 4 && wall.broken === 1);
await pad.waitForFunction(() => /diagram on slide 4 could not be drawn/.test(document.querySelector('#deck-theme')?.textContent || ''), null, { timeout: 15000 })
  .then(() => ok('and the controller warns about the broken one', true))
  .catch(async () => ok(`and the controller warns about the broken one ("${await pad.textContent('#deck-theme').catch(() => '')}")`, false));
ok(`nothing was fetched from anywhere else (${elsewhere.slice(0, 3).join(', ')})`, elsewhere.length === 0);
await screen.close();
await pad.close();
await owen.close();
}

if (want('the deck editor: diagrams from the toolbar, from mermaid.live and out in a .zip (#235)')) {
console.log('\n-- the deck editor: diagrams from the toolbar, from mermaid.live and out in a .zip (#235) --');
// The plain relay: everything here works with no server.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
// "Open in mermaid.live" opens another site; the test answers for it.
const opened = [];
await ctx.route('https://mermaid.live/**', (route) => { opened.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>mermaid.live</title>' }); });
const page = await ctx.newPage();
trap(page, 'editor diagrams (no server)');
await page.goto(`${BASE}/deck.html`);
await page.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length || 0) === 2, null, { timeout: 20000 });
// The whole markdown: CodeMirror only puts the lines on screen in the page.
const doc = () => page.evaluate(async () => {
  const CM = await import('/assets/vendor/codemirror.esm.js');
  return CM.EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString();
});
const drawnInStrip = () => page.evaluate(() => document.querySelector('#deck-strip').shadowRoot.querySelectorAll('img.podium-diagram').length);

await page.click('.cm-content');
await page.keyboard.press('Control+End');
await page.click('#deck-diagram');
const menu = await page.evaluate(() => ({
  starters: [...document.querySelectorAll('#deck-diagram-starters button')].map((b) => b.textContent),
  live: document.querySelector('#deck-diagram-live').disabled,
}));
ok(`◇ Diagram offers diagrams to start from (${menu.starters.join(', ')})`, menu.starters.length >= 6
  && ['Flowchart', 'Sequence', 'Class', 'Pie chart', 'Mind map'].every((k) => menu.starters.includes(k)) && menu.starters.some((k) => /Gantt/.test(k)));
ok('"Open in mermaid.live" waits for the cursor to be in a diagram', menu.live === true);
await page.click('#deck-diagram-starters button:has-text("Pie chart")');
await until(async () => (await drawnInStrip()) === 1, { timeout: 20000 }).catch(() => {});
ok('a starter goes in as a ```mermaid block and is drawn', /```mermaid\npie title/.test(await doc()) && (await drawnInStrip()) === 1);
const coloured = await page.evaluate(() => {
  const line = [...document.querySelectorAll('.cm-content .cm-line')].find((l) => /^pie title/.test(l.textContent));
  return line ? [...line.querySelectorAll('span')].some((sp) => getComputedStyle(sp).color === 'rgb(196, 155, 255)' && /pie/.test(sp.textContent)) : false;
});
ok('and its text is coloured as Mermaid', coloured);

await page.click('#deck-diagram');
ok('with the cursor in it, "Open in mermaid.live" is there', !(await page.evaluate(() => document.querySelector('#deck-diagram-live').disabled)));
const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('#deck-diagram-live')]);
await popup.waitForLoadState().catch(() => {});
const liveUrl = popup.url();
await popup.close();
const backFromLive = await page.evaluate(async (url) => (await import('/assets/js/deck-diagrams.js')).readMermaidLiveLink(url), liveUrl);
ok(`it opens the diagram itself in mermaid.live (${liveUrl.slice(0, 48)}...)`, /^https:\/\/mermaid\.live\/edit#pako:/.test(liveUrl) && /^pie title/.test(backFromLive?.code || ''));

// A mermaid.live link pasted in.
const link = await page.evaluate(async () => (await import('/assets/js/deck-diagrams.js')).mermaidLiveLink('sequenceDiagram\n  Student->>Teacher: Pasted from mermaid.live\n', { theme: 'forest' }));
const paste = (text) => page.evaluate((t) => {
  const dt = new DataTransfer();
  dt.setData('text/plain', t);
  document.querySelector('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, text);
await page.click('.cm-content');
await page.keyboard.press('Control+End');
await page.keyboard.type('\n\n---\n\n');
await paste(link);
await page.waitForSelector('#deck-mermaid-dialog:not([hidden])', { timeout: 5000 })
  .then(() => ok('pasting a mermaid.live link asks: as a diagram, or as the link?', true))
  .catch(() => ok('pasting a mermaid.live link asks: as a diagram, or as the link?', false));
ok('showing the diagram it holds, with its mermaid.live theme', /%%\{init: \{"theme": "forest"\}\}%%\nsequenceDiagram/.test(await page.textContent('#deck-mermaid-preview')));
await page.click('#deck-mermaid-diagram');
await page.waitForFunction(() => /Pasted from mermaid\.live/.test(document.querySelector('.cm-content').textContent), null, { timeout: 5000 }).catch(() => {});
let now = await doc();
ok('"Diagram" puts the diagram in, not the link', /```mermaid\n%%\{init: \{"theme": "forest"\}\}%%\nsequenceDiagram\n {2}Student->>Teacher: Pasted from mermaid\.live\n```/.test(now) && !now.includes('mermaid.live/edit'));
await until(async () => (await drawnInStrip()) === 2, { timeout: 20000 }).catch(() => {});
ok('and it is drawn', (await drawnInStrip()) === 2);
await page.keyboard.press('Control+z');
now = await doc();
ok('undo puts the link back', now.includes(link) && !now.includes('Pasted from mermaid.live'));
await page.keyboard.press('Control+z');
ok('and undo again takes it out', !(await doc()).includes('mermaid.live/edit'));
await paste(link);
await page.waitForSelector('#deck-mermaid-dialog:not([hidden])', { timeout: 5000 }).catch(() => {});
await page.click('#deck-mermaid-link');
ok('"Link" keeps it as the link', (await doc()).includes(link) && await page.isHidden('#deck-mermaid-dialog'));
await paste('https://example.org/not-a-diagram');
await page.waitForTimeout(300);
ok('any other link is just pasted', (await doc()).includes('https://example.org/not-a-diagram') && await page.isHidden('#deck-mermaid-dialog'));

// The built-in slide template.
// The strip catches up with the undos and pastes above first.
const fencesNow = ((await doc()).match(/```mermaid/g) || []).length;
await until(async () => (await drawnInStrip()) === fencesNow, { timeout: 20000 }).catch(() => {});
const before = await stripCount(page);
const diagramsBefore = await drawnInStrip();
await page.click('.deck-toolbar [data-cmd="template"]');
await page.waitForSelector('#deck-templates-dialog:not([hidden]) .deck-template', { timeout: 10000 });
const template = page.locator('.deck-template', { hasText: 'Diagram (Mermaid)' });
ok('there is a "Diagram (Mermaid)" slide template', await template.count() === 1);
await template.locator('[data-act="use"]').click();
await page.waitForFunction((n) => document.querySelector('#deck-strip').shadowRoot.querySelectorAll('.cell').length === n + 1, before, { timeout: 5000 }).catch(() => {});
await until(async () => (await drawnInStrip()) === diagramsBefore + 1, { timeout: 20000 }).catch(() => {});
const total = await drawnInStrip();
ok(`and it goes in drawn (${diagramsBefore} then ${total} diagrams in the strip)`, total === diagramsBefore + 1 && total >= 2);

// Out as a .zip: the code, and a picture of each diagram beside it.
await page.click('#deck-save-more');
const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#deck-download-zip')]);
const zipBytes = fs.readFileSync(await download.path());
const zipped = await page.evaluate(async (bytes) => {
  const { readZip } = await import('/assets/js/zip.js');
  const files = await readZip(new Blob([new Uint8Array(bytes)]));
  const md = files.find((f) => f.name.endsWith('.md'));
  const pngs = await Promise.all(files.filter((f) => f.name.endsWith('.png')).map(async (f) => [...new Uint8Array(await f.read()).slice(0, 4)].join(',')));
  const svgs = await Promise.all(files.filter((f) => f.name.endsWith('.svg')).map(async (f) => new TextDecoder().decode(await f.read()).slice(0, 4)));
  return { names: files.map((f) => f.name), md: new TextDecoder().decode(await md.read()), pngs, svgs };
}, [...zipBytes]);
const pictures = zipped.names.filter((n) => n.startsWith('media/diagrams/'));
ok(`the .zip has an .svg and a .png of each diagram (${pictures.join(', ')})`, pictures.filter((n) => n.endsWith('.svg')).length === total
  && pictures.filter((n) => n.endsWith('.png')).length === total && zipped.pngs.every((sig) => sig === '137,80,78,71') && zipped.svgs.every((t) => t === '<svg'));
ok('and the deck keeps each diagram\'s code', (zipped.md.match(/```mermaid/g) || []).length === total);
const notes = zipped.md.match(/```\n<!-- diagram: media\/diagrams\/slide-\d+-1\.png -->/g) || [];
ok(`with its picture named in a comment after it (${notes.length})`, notes.length === total && notes.every((n) => pictures.includes(n.match(/media\/diagrams\/[^ ]+/)[0])));

// And back in: the code is the diagram; the pictures stay behind.
const whereBefore = await page.textContent('#deck-where');
page.once('dialog', (d) => d.accept());
await page.setInputFiles('#deck-file', { name: 'diagrams.zip', mimeType: 'application/zip', buffer: zipBytes });
await page.waitForFunction((was) => document.querySelector('#deck-where').textContent !== was, whereBefore, { timeout: 15000 }).catch(() => {});
await until(async () => (await drawnInStrip()) === total, { timeout: 20000 }).catch(() => {});
now = await doc();
ok(`opening the .zip brings the diagrams back as code, drawn (${(now.match(/```mermaid/g) || []).length} blocks, ${await drawnInStrip()} drawn, of ${total}; "${await page.textContent('#deck-where')}")`, (now.match(/```mermaid/g) || []).length === total && (await drawnInStrip()) === total);
ok('without the picture comments', !now.includes('<!-- diagram:'));
ok('and without asking to bring the pictures in', !/media\/diagrams/.test(await page.textContent('#deck-warn')));
ok(`nothing went to mermaid.live but the one link opened (${opened.length})`, opened.length === 1);
await ctx.close();
}

if (want('the planner: archiving lectures from your own list (#239)')) {
console.log('\n-- the planner: archiving lectures from your own list (#239) --');
// A class of its own, so the other sections' lectures never get in the count.
admin('course', 'add', 'arc101', '--title', 'Archive 101');
admin('member', 'add', 'arc101', 'owen', '--role', 'owner');
admin('member', 'add', 'arc101', 'tia', '--role', 'member');
const owen = await signedIn('owen');
const planner = await owen.newPage();
trap(planner, 'planner (archive)');
await planner.goto(`${base}/plan.html`);
await planner.waitForSelector('#plan-list');
const make = (title, course) => planner.evaluate(async ([t, c]) => {
  const res = await fetch('/api/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: t, course: c, doc: { podium: 'plan', v: 1, title: t, items: [] } }) });
  return (await res.json()).plan;
}, [title, course]);
const week1 = await make('Archive Week 1', 'arc101');
await make('Archive Week 2', 'arc101');
await make('Archive loose notes', '');
await planner.reload();
const listed = () => planner.evaluate(() => [...document.querySelectorAll('#plan-list .plan-row-title')].map((t) => t.textContent));
await planner.waitForFunction(() => /Archive Week 1/.test(document.querySelector('#plan-list').textContent), null, { timeout: 10000 });
ok('the server\'s lectures are in the list, each with 🗄', (await listed()).filter((t) => t.startsWith('Archive ')).length === 3
  && (await planner.$$('#plan-list .plan-row-archive')).length >= 3);

const row = (title) => planner.locator('#plan-list .plan-row-wrap', { hasText: title });
await row('Archive Week 1').hover();
await row('Archive Week 1').locator('.plan-row-archive').click();
await planner.waitForFunction(() => !/Archive Week 1/.test(document.querySelector('#plan-list').textContent), null, { timeout: 5000 })
  .then(() => ok('🗄 takes a lecture out of the list', true))
  .catch(() => ok('🗄 takes a lecture out of the list', false));
ok(`and says so, with Undo ("${(await planner.textContent('#plan-archive-undo')).trim()}")`, /Archived "Archive Week 1"\. Undo/.test(await planner.textContent('#plan-archive-undo')));
ok('the archive says how many are in it', /🗄 Archive \(1\)/.test(await planner.textContent('#plan-archive-open')));
await planner.click('#plan-archive-undo button');
await planner.waitForFunction(() => /Archive Week 1/.test(document.querySelector('#plan-list').textContent), null, { timeout: 5000 })
  .then(() => ok('Undo puts it back', true))
  .catch(() => ok('Undo puts it back', false));
await row('Archive Week 1').hover();
await row('Archive Week 1').locator('.plan-row-archive').click();
await planner.waitForFunction(() => !/Archive Week 1/.test(document.querySelector('#plan-list').textContent), null, { timeout: 5000 });
const onServer = await planner.evaluate(async (id) => (await (await fetch('/api/plans')).json()).plans.find((p) => p.id === id), week1.id);
ok('it is archived on the server, for this person', onServer?.archived === true);

// Only this person's list.
const tia = await signedIn('tia');
const taPlanner = await tia.newPage();
trap(taPlanner, 'planner (archive, TA)');
await taPlanner.goto(`${base}/plan.html`);
await taPlanner.waitForFunction(() => /Archive Week 2/.test(document.querySelector('#plan-list').textContent), null, { timeout: 10000 });
ok('a co-instructor in the same class still has it in their list', /Archive Week 1/.test(await taPlanner.textContent('#plan-list')));
await taPlanner.close();
await tia.close();

// The archive: search, bring back, open.
await planner.click('#plan-archive-open');
await planner.waitForSelector('#plan-archive-dialog:not([hidden]) .plan-archive-item');
const inArchive = () => planner.evaluate(() => [...document.querySelectorAll('#plan-archive-list .plan-archive-item .plan-row-title')].map((t) => t.textContent));
ok('🗄 Archive lists it', (await inArchive()).includes('Archive Week 1'));
// The search filters as you type, a moment after each keystroke.
const searchShows = (fn, arg) => planner.waitForFunction(fn, arg, { timeout: 5000 }).then(() => true).catch(() => false);
await planner.fill('#plan-archive-search', 'arc101');
ok('searching by class finds it', await searchShows(() => [...document.querySelectorAll('#plan-archive-list .plan-archive-item .plan-row-title')]
  .map((t) => t.textContent).join() === 'Archive Week 1'));
await planner.fill('#plan-archive-search', 'nothing like this');
ok('and a search that matches nothing says so', await searchShows(() => !document.querySelector('#plan-archive-list .plan-archive-item')
  && /No archived lecture matches/.test(document.querySelector('#plan-archive-list').textContent)));
await planner.fill('#plan-archive-search', 'week');
await searchShows(() => /Archive Week 1/.test(document.querySelector('#plan-archive-list').textContent));
await planner.locator('#plan-archive-list .plan-archive-item', { hasText: 'Archive Week 1' }).locator('button:has-text("Unarchive")').click();
await planner.waitForFunction(() => /Archive Week 1/.test(document.querySelector('#plan-list').textContent), null, { timeout: 5000 })
  .then(() => ok('Unarchive brings it back to the list', true))
  .catch(() => ok('Unarchive brings it back to the list', false));
await planner.click('#plan-archive-close');

// Tidying up: a whole class, then several chosen, then older than a date.
await planner.click('#plan-tidy-open');
await planner.waitForSelector('#plan-tidy-dialog:not([hidden])');
await planner.selectOption('#plan-tidy-course', 'arc101');
await planner.waitForFunction(() => /\d/.test(document.querySelector('#plan-tidy-course-count')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
ok(`a class's lectures are counted before anything happens ("${await planner.textContent('#plan-tidy-course-count')}")`,
  /2 lectures in your list filed under ARC101/.test(await planner.textContent('#plan-tidy-course-count')));
await planner.click('#plan-tidy-course-go');
await planner.waitForFunction(() => !/Archive Week/.test(document.querySelector('#plan-list').textContent), null, { timeout: 5000 })
  .then(() => ok('and archived together', true))
  .catch(() => ok('and archived together', false));
await planner.fill('#plan-tidy-date', '2000-01-01');
await planner.dispatchEvent('#plan-tidy-date', 'change');
ok('nothing older than 2000: nothing to archive', await planner.isDisabled('#plan-tidy-older') && /0 lectures/.test(await planner.textContent('#plan-tidy-older-count')));
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
await planner.fill('#plan-tidy-date', tomorrow);
await planner.dispatchEvent('#plan-tidy-date', 'change');
const stillListed = (await listed()).length;
ok(`older than tomorrow counts every lecture still listed (${await planner.textContent('#plan-tidy-older-count')})`,
  new RegExp(`^${stillListed} lecture`).test(await planner.textContent('#plan-tidy-older-count')) && !(await planner.isDisabled('#plan-tidy-older')));
await planner.locator('#plan-tidy-list .plan-archive-item', { hasText: 'Archive loose notes' }).locator('input').check();
ok('choosing one names the button', /Archive 1 lecture/.test(await planner.textContent('#plan-tidy-selected')));
await planner.click('#plan-tidy-selected');
await planner.waitForFunction(() => !/Archive loose notes/.test(document.querySelector('#plan-list').textContent), null, { timeout: 5000 })
  .then(() => ok('Archive selected archives the ones chosen', true))
  .catch(() => ok('Archive selected archives the ones chosen', false));
await planner.click('#plan-tidy-close');

// Opening one from the archive, as it is.
await planner.click('#plan-archive-open');
await planner.waitForSelector('#plan-archive-dialog:not([hidden]) .plan-archive-item');
ok('the archive has all three', (await inArchive()).filter((t) => t.startsWith('Archive ')).length === 3);
await planner.locator('#plan-archive-list .plan-archive-item', { hasText: 'Archive loose notes' }).locator('button:has-text("Open")').click();
await planner.waitForFunction(() => document.querySelector('#plan-title').value === 'Archive loose notes', null, { timeout: 8000 })
  .then(() => ok('Open opens an archived lecture without bringing it back', true))
  .catch(() => ok('Open opens an archived lecture without bringing it back', false));
await planner.waitForSelector('#plan-archived-note:not([hidden])', { timeout: 5000 })
  .then(() => ok('which says it is archived', true))
  .catch(() => ok('which says it is archived', false));
ok('and it is still out of the list', !(await listed()).includes('Archive loose notes'));
await planner.click('#plan-unarchive-this');
await planner.waitForFunction(() => /Archive loose notes/.test(document.querySelector('#plan-list').textContent), null, { timeout: 5000 })
  .then(() => ok('"Unarchive" on it brings it back', true))
  .catch(() => ok('"Unarchive" on it brings it back', false));
ok('and the note goes', await planner.isHidden('#plan-archived-note'));

// Kept on the server: another device, or a reload, agrees.
await planner.reload();
await planner.waitForFunction(() => /Archive loose notes/.test(document.querySelector('#plan-list').textContent), null, { timeout: 10000 });
ok('after a reload the archived ones are still archived', !/Archive Week/.test(await planner.textContent('#plan-list'))
  && /🗄 Archive \(2\)/.test(await planner.textContent('#plan-archive-open')));
const other = await owen.newPage();
trap(other, 'planner (archive, second tab)');
await other.goto(`${base}/plan.html`);
await other.waitForFunction(() => /Archive loose notes/.test(document.querySelector('#plan-list').textContent), null, { timeout: 10000 });
ok('and so does another tab', !/Archive Week/.test(await other.textContent('#plan-list')));
await other.close();
await owen.close();

// With no server: this browser's lectures, archived here.
const solo = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const offline = await solo.newPage();
trap(offline, 'planner (archive, no server)');
await offline.goto(`${BASE}/plan.html`);
await offline.waitForSelector('#plan-list');
await offline.fill('#plan-title', 'Only on this iPad');
await offline.waitForFunction(() => /Only on this iPad/.test(document.querySelector('#plan-list').textContent), null, { timeout: 5000 });
await offline.click('#plan-new');
await offline.waitForFunction(() => document.querySelectorAll('#plan-list .plan-row').length === 2, null, { timeout: 5000 });
const soloRow = offline.locator('#plan-list .plan-row-wrap', { hasText: 'Only on this iPad' });
await soloRow.hover();
await soloRow.locator('.plan-row-archive').click();
await offline.waitForFunction(() => !/Only on this iPad/.test(document.querySelector('#plan-list').textContent), null, { timeout: 5000 });
await offline.reload();
await offline.waitForSelector('#plan-list .plan-row');
ok('with no server, a lecture archived in this browser stays archived', !/Only on this iPad/.test(await offline.textContent('#plan-list'))
  && /🗄 Archive \(1\)/.test(await offline.textContent('#plan-archive-open')));
await offline.click('#plan-archive-open');
await offline.locator('#plan-archive-list .plan-archive-item', { hasText: 'Only on this iPad' }).locator('input').check();
await offline.click('#plan-archive-unarchive-selected');
await offline.waitForFunction(() => /Only on this iPad/.test(document.querySelector('#plan-list').textContent), null, { timeout: 5000 })
  .then(() => ok('and comes back with Unarchive selected', true))
  .catch(() => ok('and comes back with Unarchive selected', false));
await solo.close();
}

if (want('Quick Look: a file privately, in its own tab (#242)')) {
console.log('\n-- Quick Look: a file privately, in its own tab (#242) --');
const owen = await signedIn('owen');
const desk = await owen.newPage();
trap(desk, 'quick look setup');
await desk.goto(`${base}/index.html`);
const lookDeck = await desk.evaluate(async (md) => {
  const res = await fetch('/api/library/upload?filename=quick-look.md&course=psy415&title=Quick%20Look%20deck', { method: 'POST', body: md });
  return (await res.json()).item;
}, exampleDeck);
const lookVideo = await desk.evaluate(async (bytes) => {
  const res = await fetch('/api/library/upload?filename=four-colours.webm&course=psy415&title=Quick%20Look%20video', { method: 'POST', body: new Uint8Array(bytes) });
  return (await res.json()).item;
}, [...fs.readFileSync(path.join(ROOT, 'test', 'e2e', 'media-fixtures', 'four-colours.webm'))]);
const lookPdf = await desk.evaluate(async (bytes) => {
  const res = await fetch('/api/library/upload?filename=handout.pdf&course=psy415&title=Quick%20Look%20handout', { method: 'POST', body: new Uint8Array(bytes) });
  return (await res.json()).item;
}, [...fs.readFileSync(path.join(ROOT, 'content', 'sample.pdf'))]);
await desk.close();

// The room, with the deck up on slide 1.
const screen = await owen.newPage();
trap(screen, 'quick look display');
await screen.goto(`${base}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await owen.newPage();
trap(pad, 'quick look controller');
await pad.goto(`${base}/control.html`);
await pad.waitForSelector('.tile');
const tile = pad.locator('.tile', { hasText: 'Quick Look deck' });
await tile.click();
const wallSlide = () => screen.evaluate(() => {
  const svgs = [...(document.querySelector('.layer[data-role="program"] .r-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]') || [])];
  return svgs.findIndex((svg) => svg.classList.contains('podium-on'));
});
await until(async () => (await wallSlide()) === 0, { timeout: 20000 }).catch(() => {});
ok('the deck is up in the room, on its first slide', (await wallSlide()) === 0);

// ↗ on its tile: the deck in its own tab.
ok('a tile offers ↗ Quick Look', await tile.locator('.tile-look').count() === 1);
const [look] = await Promise.all([owen.waitForEvent('page'), tile.locator('.tile-look').click()]);
trap(look, 'quick look (deck)');
let sockets = 0;
look.on('websocket', () => { sockets += 1; });
await look.waitForFunction(() => /Slide 1 of 4/.test(document.querySelector('#ql-where').textContent), null, { timeout: 20000 })
  .then(() => ok('↗ opens the deck in a new tab', true))
  .catch(async () => ok(`↗ opens the deck in a new tab ("${await look.textContent('#ql-where').catch(() => '')}")`, false));
ok(`a library file opens by its id (${new URL(look.url()).search})`, new URL(look.url()).searchParams.get('library') === String(lookDeck.id));
ok('titled so it is easy to find among tabs', /^Quick Look · Quick Look deck/.test(await look.title()));
ok('with its presenter notes beside it', await look.isVisible('#ql-notes'));
for (let i = 0; i < 3; i++) await look.keyboard.press('ArrowRight');
ok(`→ steps through the builds as in class ("${await look.textContent('#ql-where')}")`, /Slide 2 of 4 · build 2 of 3/.test(await look.textContent('#ql-where')));
ok('and the notes are that slide\'s', /bullet list/.test(await look.textContent('#ql-notes-text')));
await look.keyboard.press('g');
await look.waitForFunction(() => document.querySelector('#ql-grid-cells .ql-cell-deck')?.shadowRoot?.querySelectorAll('svg[data-marpit-svg]').length === 4, null, { timeout: 10000 })
  .then(() => ok('G shows every slide', true))
  .catch(() => ok('G shows every slide', false));
await look.evaluate(() => document.querySelector('#ql-grid-cells .ql-cell-deck').shadowRoot.querySelectorAll('svg[data-marpit-svg]')[3].dispatchEvent(new MouseEvent('click', { bubbles: true })));
ok(`and a click on one goes there ("${await look.textContent('#ql-where')}")`, /Slide 4 of 4/.test(await look.textContent('#ql-where')) && await look.isHidden('#ql-grid'));
await look.click('#ql-checks-toggle');
ok(`Check before class is there too ("${(await look.textContent('#ql-checks-list')).trim().slice(0, 40)}")`, await look.isVisible('#ql-checks') && /Nothing to fix|Slide \d/.test(await look.textContent('#ql-checks-list')));
await look.keyboard.press('Escape');
await screen.waitForTimeout(800);
ok('none of it moved the room: the display is still on slide 1', (await wallSlide()) === 0);
await pad.click('.tab[data-tab="slides"]');
await pad.click('#deck-next');
await until(async () => (await wallSlide()) === 1, { timeout: 8000 }).catch(() => {});
await look.waitForTimeout(500);
ok('and moving the room does not move the tab', (await wallSlide()) === 1 && /Slide 4 of 4/.test(await look.textContent('#ql-where')));
ok(`Quick Look never opened a connection to the room (${sockets} sockets)`, sockets === 0);
await look.close();

// A PDF, page by page, and a video that starts muted.
const pdfLook = await owen.newPage();
trap(pdfLook, 'quick look (pdf)');
await pdfLook.goto(`${base}/quicklook.html?library=${lookPdf.id}`);
await pdfLook.waitForFunction(() => /Page 1 of \d+/.test(document.querySelector('#ql-where').textContent), null, { timeout: 20000 })
  .then(async () => ok(`a library PDF opens page by page ("${await pdfLook.textContent('#ql-where')}")`, true))
  .catch(async () => ok(`a library PDF opens page by page ("${await pdfLook.textContent('#ql-where')}")`, false));
await pdfLook.click('#ql-grid-toggle');
await pdfLook.waitForSelector('#ql-grid-cells .ql-cell canvas', { timeout: 10000 })
  .then(() => ok('with a grid of its pages', true))
  .catch(() => ok('with a grid of its pages', false));
await pdfLook.close();
const videoLook = await owen.newPage();
trap(videoLook, 'quick look (video)');
await videoLook.goto(`${base}/quicklook.html?library=${lookVideo.id}`);
await videoLook.waitForSelector('video.ql-media', { timeout: 10000 });
ok('a video starts muted', await videoLook.evaluate(() => document.querySelector('video.ql-media').muted) && /Unmute/.test(await videoLook.textContent('#ql-mute')));
await videoLook.click('#ql-mute');
ok('and Unmute unmutes it', await videoLook.evaluate(() => !document.querySelector('video.ql-media').muted));
await videoLook.close();
await screen.close();
await pad.close();

// From the deck editor: the deck as it is there, unsaved, and following edits.
const editor = await owen.newPage();
trap(editor, 'quick look (editor)');
await editor.goto(`${base}/deck.html?library=${lookDeck.id}`);
await editor.waitForFunction(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length === 4, null, { timeout: 20000 });
await editor.click('#deck-save-more');
const [rehearsal] = await Promise.all([owen.waitForEvent('page'), editor.click('#deck-rehearse')]);
trap(rehearsal, 'quick look (rehearsal)');
await rehearsal.waitForFunction(() => /Slide 1 of 4/.test(document.querySelector('#ql-where').textContent), null, { timeout: 20000 })
  .then(() => ok('"Open in a new tab to rehearse" opens the deck in Quick Look', true))
  .catch(() => ok('"Open in a new tab to rehearse" opens the deck in Quick Look', false));
ok('saying it follows the editor', /follows your edits/.test(await rehearsal.textContent('#ql-from')));
await rehearsal.keyboard.press('ArrowRight');
await editor.click('#deck-add-slide');
await rehearsal.waitForFunction(() => /of 5/.test(document.querySelector('#ql-where').textContent), null, { timeout: 10000 })
  .then(() => ok('an unsaved new slide in the editor appears in the rehearsal tab', true))
  .catch(async () => ok(`an unsaved new slide in the editor appears in the rehearsal tab ("${await rehearsal.textContent('#ql-where')}")`, false));
ok(`where you were in it ("${await rehearsal.textContent('#ql-where')}")`, /^Slide 2 of 5/.test(await rehearsal.textContent('#ql-where')));
const editorProblems = await editor.evaluate(() => [...document.querySelectorAll('#deck-problems li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
const tabProblems = await rehearsal.evaluate(() => [...document.querySelectorAll('#ql-checks-list li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
ok(`its Check before class matches the editor's (${tabProblems.length} and ${editorProblems.length})`, JSON.stringify(tabProblems) === JSON.stringify(editorProblems));
await rehearsal.close();
await editor.close();
await owen.close();

// From a lecture plan, with no server: handed over on this device.
const solo = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const planner = await solo.newPage();
trap(planner, 'quick look (planner)');
await planner.goto(`${BASE}/plan.html`);
await planner.waitForSelector('#type-picker .type-btn');
await planner.click('#type-picker .type-btn:has-text("Marp deck")');
await planner.setInputFiles('#item-fields input[type=file]', { name: 'inside.md', mimeType: 'text/markdown', buffer: Buffer.from(exampleDeck) });
await planner.waitForFunction(() => /Slide 1 of 4/.test(document.querySelector('#deck-where')?.textContent || ''), null, { timeout: 20000 });
ok('a planner item offers ↗ Quick Look', await planner.locator('#order .order-row button[aria-label^="Quick Look"]').count() === 1);
const [inPlan] = await Promise.all([solo.waitForEvent('page'), planner.click('#order .order-row button[aria-label^="Quick Look"]')]);
trap(inPlan, 'quick look (from the plan)');
await inPlan.waitForFunction(() => /Slide 1 of 4/.test(document.querySelector('#ql-where').textContent), null, { timeout: 20000 })
  .then(() => ok('a deck kept inside the plan opens in Quick Look, handed over with no server', true))
  .catch(async () => ok(`a deck kept inside the plan opens in Quick Look ("${await inPlan.textContent('.ql-stage').catch(() => '')}")`, false));
ok(`a handover is not an address anyone else could open (${new URL(inPlan.url()).hash.slice(0, 18)}…)`, /^#handoff=[0-9a-f]{24}$/.test(new URL(inPlan.url()).hash));
await inPlan.keyboard.press('End');
await inPlan.reload();
await inPlan.waitForFunction(() => /Slide 1 of 4/.test(document.querySelector('#ql-where').textContent), null, { timeout: 10000 })
  .then(() => ok('and a reload of that tab still shows it', true))
  .catch(() => ok('and a reload of that tab still shows it', false));
await solo.close();

// A kiosk's cookie, or nobody signed in, never gets in.
ok('signed out, quicklook.html is not served', [302, 401, 403].includes((await fetch(`${base}/quicklook.html`, { redirect: 'manual' })).status));
}

if (want('Quick Look: an outline beside the page, for documents, decks and PDFs (#253)')) {
console.log('\n-- Quick Look: an outline beside the page, for documents, decks and PDFs (#253) --');
const fixtures = path.join(ROOT, 'test', 'fixtures');
fs.mkdirSync(fixtures, { recursive: true });
const filler = (n) => Array.from({ length: n }, (_, i) => `A line of reading, number ${i + 1}, to give the section some length.`).join('\n\n');
fs.writeFileSync(path.join(fixtures, 'outline-doc.md'),
  `# Memory\n\n${filler(8)}\n\n## Encoding\n\n${filler(14)}\n\n## Retrieval\n\n${filler(14)}\n\n### Cues\n\n${filler(14)}\n`);
fs.writeFileSync(path.join(fixtures, 'outline-deck.md'),
  '---\nmarp: true\n---\n\n# Welcome\n\n---\n\n# Attention\n\nSome words.\n\n---\n\n## Working memory\n\nMore words.\n');
// A three-page PDF with two bookmarks (the second nested), written out by
// hand: nothing in the repo has one, and pdf.js reads this the same way.
{
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>',
    '<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 2 >>',
    '<< /Title (Introduction) /Parent 6 0 R /Dest [3 0 R /Fit] /First 8 0 R /Last 8 0 R /Count 1 >>',
    '<< /Title (The findings) /Parent 7 0 R /Dest [5 0 R /Fit] >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(path.join(fixtures, 'outline.pdf'), pdf, 'latin1');
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const look = await ctx.newPage();
trap(look, 'quick look outline');
const outline = () => look.evaluate(() => ({
  open: !document.querySelector('#ql-outline').hidden,
  button: !document.querySelector('#ql-outline-toggle').hidden,
  entries: [...document.querySelectorAll('#ql-outline-list button')].map((b) => b.textContent.trim()),
  current: document.querySelector('#ql-outline-list button[aria-current="true"]')?.textContent.trim() || '',
}));

// A document: its headings, open beside it, following along.
await look.goto(`${BASE}/quicklook.html?src=test/fixtures/outline-doc.md&type=document`);
await look.waitForFunction(() => document.querySelectorAll('#ql-outline-list button').length === 4, null, { timeout: 20000 })
  .then(() => ok('a document\'s headings are listed in an outline', true))
  .catch(() => ok('a document\'s headings are listed in an outline', false));
let seen = await outline();
ok(`open beside the page, not over it (${JSON.stringify(seen.entries)})`, seen.open && await look.isHidden('#ql-grid')
  && seen.entries.join('|') === 'Memory|Encoding|Retrieval|Cues');
ok('a document no longer offers a Grid', await look.isHidden('#ql-grid-toggle'));
ok(`and the first heading is marked as where you are ("${seen.current}")`, seen.current === 'Memory');
await look.click('#ql-outline-list button:text-is("Retrieval")');
await look.waitForFunction(() => /Retrieval/.test(document.querySelector('#ql-where').textContent), null, { timeout: 5000 })
  .then(() => ok('clicking a heading jumps there', true))
  .catch(async () => ok(`clicking a heading jumps there ("${await look.textContent('#ql-where')}")`, false));
seen = await outline();
ok(`and the outline stays open, marking it ("${seen.current}")`, seen.open && seen.current === 'Retrieval');
await look.keyboard.press('End');
await look.waitForTimeout(300);
ok(`it follows the page as it moves ("${(await outline()).current}")`, (await outline()).current === 'Cues');

// Hidden and shown, and the choice kept.
await look.click('#ql-outline-toggle');
ok('☰ Outline hides it', !(await outline()).open && (await look.getAttribute('#ql-outline-toggle', 'aria-pressed')) === 'false');
await look.reload();
await look.waitForFunction(() => !document.querySelector('#ql-outline-toggle').hidden, null, { timeout: 20000 });
ok('and it stays hidden on this device', !(await outline()).open);
await look.keyboard.press('o');
ok('O shows it again', (await outline()).open);

// A deck: every slide by its title, alongside the grid.
await look.goto(`${BASE}/quicklook.html?src=test/fixtures/outline-deck.md`);
await look.waitForFunction(() => document.querySelectorAll('#ql-outline-list button').length === 3, null, { timeout: 20000 })
  .catch(() => {});
seen = await outline();
ok(`a deck's outline is its slide titles (${JSON.stringify(seen.entries)})`,
  seen.open && seen.entries.join('|') === '1Welcome|2Attention|3Working memory');
ok('and it keeps its Grid of slides', await look.isVisible('#ql-grid-toggle'));
await look.click('#ql-outline-list button:has-text("Working memory")');
ok(`a title goes to its slide ("${await look.textContent('#ql-where')}")`, /Slide 3 of 3/.test(await look.textContent('#ql-where'))
  && (await outline()).current === '3Working memory');

// A PDF: its bookmarks, nested, each to its page.
await look.goto(`${BASE}/quicklook.html?src=test/fixtures/outline.pdf`);
await look.waitForFunction(() => document.querySelectorAll('#ql-outline-list button').length === 2, null, { timeout: 20000 })
  .then(() => ok('a PDF\'s bookmarks are its outline', true))
  .catch(() => ok('a PDF\'s bookmarks are its outline', false));
seen = await outline();
ok(`nested as they are in the file (${JSON.stringify(seen.entries)})`, seen.entries.join('|') === 'Introduction|The findings'
  && await look.evaluate(() => !!document.querySelector('#ql-outline-list li.ql-heading-2 button')));
await look.click('#ql-outline-list button:text-is("The findings")');
ok(`a bookmark goes to its page ("${await look.textContent('#ql-where')}")`, /Page 3 of 3/.test(await look.textContent('#ql-where'))
  && (await outline()).current === 'The findings');

// A PDF without bookmarks: no outline, the grid as before.
await look.goto(`${BASE}/quicklook.html?src=content/sample.pdf`);
await look.waitForFunction(() => /Page 1 of \d+/.test(document.querySelector('#ql-where').textContent), null, { timeout: 20000 });
await look.waitForTimeout(500);
seen = await outline();
ok('a PDF with no bookmarks has no Outline button, and keeps its Grid', !seen.button && !seen.open && await look.isVisible('#ql-grid-toggle'));
await ctx.close();
}

if (want('the planner: choosing files from the server (#241)')) {
console.log('\n-- the planner: choosing files from the server (#241) --');
admin('course', 'add', 'pick101', '--title', 'Picking 101');
admin('member', 'add', 'pick101', 'owen', '--role', 'owner');
admin('member', 'add', 'pick101', 'tia', '--role', 'member');
admin('course', 'add', 'other101', '--title', 'Not yours');
const owen = await signedIn('owen');
const desk = await owen.newPage();
trap(desk, 'picker setup');
await desk.goto(`${base}/index.html`);
const upload = (name, course, title, bytes) => desk.evaluate(async ([n, c, t, b]) => {
  const res = await fetch(`/api/library/upload?filename=${encodeURIComponent(n)}&course=${c}&title=${encodeURIComponent(t)}`, { method: 'POST', body: typeof b === 'string' ? b : new Uint8Array(b) });
  return (await res.json()).item;
}, [name, course, title, bytes]);
const pickDeck = await upload('picker.md', 'pick101', 'Picker deck', exampleDeck);
await upload('picker.pdf', 'pick101', 'Picker handout', [...fs.readFileSync(path.join(ROOT, 'content', 'sample.pdf'))]);
await upload('picker.png', 'pick101', 'Picker photo', [...fs.readFileSync(writeImageFixture())]);
await desk.close();

// Made in the deck editor - opened and saved there.
const editor = await owen.newPage();
trap(editor, 'picker (editor)');
await editor.goto(`${base}/deck.html?library=${pickDeck.id}`);
await editor.waitForFunction(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length === 4, null, { timeout: 20000 });
await editor.click('#deck-add-slide');
await editor.waitForTimeout(400);
await editor.click('#deck-save');
await editor.waitForFunction(() => /^Saved/.test(document.querySelector('#deck-save-state').textContent), null, { timeout: 10000 });
const recentDecks = await editor.evaluate(async () => (await (await fetch('/api/me/recent-decks')).json()).decks);
ok(`the deck editor remembers it as just saved (${recentDecks.map((d) => d.title).join(', ')})`, recentDecks[0]?.libraryId === pickDeck.id && recentDecks[0].saved === true);

// The planner: a deck item, chosen rather than typed.
const planner = await owen.newPage();
trap(planner, 'picker (planner)');
await planner.goto(`${base}/plan.html`);
await planner.waitForSelector('#type-picker .type-btn');
await planner.click('#plan-new');
await planner.waitForTimeout(400);
await planner.click('#type-picker .type-btn:has-text("Marp deck")');
await planner.click('#item-fields button:has-text("Choose from the server")');
await planner.waitForSelector('.fb-dialog .fb-row', { timeout: 10000 });
const firstSection = await planner.evaluate(() => {
  const list = document.querySelector('.fb-dialog .fb-list');
  return { heading: list.querySelector('h3')?.textContent, first: list.querySelector('.fb-row .fb-title')?.textContent, meta: list.querySelector('.fb-row .fb-meta')?.textContent };
});
ok(`what was just made in the deck editor is first (${firstSection.heading}: ${firstSection.first} - ${firstSection.meta})`,
  firstSection.heading === 'Recent in the deck editor' && firstSection.first === 'Picker deck' && /saved in the deck editor/.test(firstSection.meta));
ok('opened on decks, for a deck item', await planner.inputValue('.fb-dialog select') === 'deck');
ok('with ↗ Quick Look and ✎ Edit on a deck you may edit', await planner.locator('.fb-dialog .fb-row').first().locator('button[aria-label^="Quick Look"]').count() === 1
  && await planner.locator('.fb-dialog .fb-row').first().locator('button[aria-label^="Edit"]').count() === 1);
await planner.locator('.fb-dialog .fb-row').first().locator('button:has-text("Use")').click();
await planner.waitForFunction(() => !document.querySelector('.fb-dialog'), null, { timeout: 5000 });
const pathValue = await planner.evaluate(() => [...document.querySelectorAll('#item-fields input[type=text]')].map((i) => i.value).find((v) => v.startsWith('/media/')) || '');
ok(`Use fills the item with the deck's address (${pathValue})`, pathValue === pickDeck.src);
await planner.waitForFunction(() => /Slide 1 of 5/.test(document.querySelector('#deck-where')?.textContent || ''), null, { timeout: 20000 })
  .then(() => ok('and it is the deck as saved, five slides', true))
  .catch(async () => ok(`and it is the deck as saved ("${await planner.textContent('#deck-where')}")`, false));
ok('named after it', /Picker deck/.test(await planner.textContent('#order')));

// Narrowing it down.
await planner.click('#plan-add-from-server');
await planner.waitForSelector('.fb-dialog .fb-row', { timeout: 10000 });
const shownTitles = () => planner.evaluate(() => [...document.querySelectorAll('.fb-dialog .fb-row .fb-title')].map((t) => t.textContent));
await planner.selectOption('.fb-dialog select', 'pdf');
ok(`the kind filter shows only PDFs (${(await shownTitles()).join(', ')})`, (await shownTitles()).length >= 1 && (await shownTitles()).every((t) => /handout|sample|PDF/i.test(t)));
await planner.selectOption('.fb-dialog select', '');
await planner.fill('.fb-dialog input[type=search]', 'pick101');
ok(`search finds a class's files (${(await shownTitles()).join(', ')})`, (await shownTitles()).includes('Picker handout') && (await shownTitles()).includes('Picker photo'));

// Quick add: three files, three items, in order.
const before = await planner.evaluate(() => document.querySelectorAll('#order .order-row').length);
const tick = (title) => planner.locator('.fb-dialog .fb-row', { hasText: title }).filter({ hasNot: planner.locator('.fb-meta:has-text("deck editor")') }).first().locator('input[type=checkbox]').check();
await tick('Picker deck');
await tick('Picker handout');
await tick('Picker photo');
ok('the button counts what is ticked', /Add 3 to the lecture/.test(await planner.textContent('.fb-dialog .fb-foot button')));
await planner.click('.fb-dialog .fb-foot button');
await planner.waitForFunction((n) => document.querySelectorAll('#order .order-row').length === n + 3, before, { timeout: 5000 }).catch(() => {});
const types = await planner.evaluate(() => [...document.querySelectorAll('#order .order-row')].slice(-3).map((r) => r.querySelector('.order-type').textContent));
ok(`quick add puts in one item per file, of the right kind (${types.join(', ')})`, types.join() === 'Marp deck,PDF,Photo');
await planner.close();

// A TA sees their class's files, not another class's.
const tia = await signedIn('tia');
const ta = await tia.newPage();
trap(ta, 'picker (TA)');
await ta.goto(`${base}/index.html`);
await editor.close();
const root = await signedIn('root');
const rootPage = await root.newPage();
await rootPage.goto(`${base}/index.html`);
await rootPage.evaluate(async () => fetch('/api/library/upload?filename=private.md&course=other101&title=Another%20class%20deck', { method: 'POST', body: '---\nmarp: true\n---\n# Theirs\n' }));
await root.close();
await ta.goto(`${base}/plan.html`);
await ta.waitForSelector('#plan-add-from-server');
await ta.click('#plan-add-from-server');
await ta.waitForSelector('.fb-dialog .fb-row', { timeout: 10000 });
const taTitles = await ta.evaluate(() => [...document.querySelectorAll('.fb-dialog .fb-row .fb-title')].map((t) => t.textContent));
ok(`a TA sees their class's files (${taTitles.filter((t) => /Picker/.test(t)).length} of them) and not another class's`, taTitles.includes('Picker handout') && !taTitles.includes('Another class deck'));
ok('and no ✎ on a deck they may not edit', await ta.locator('.fb-dialog .fb-row', { hasText: 'Picker deck' }).first().locator('button[aria-label^="Edit"]').count() === 0);
await tia.close();

// "Add to a lecture…" from the deck editor.
const again = await owen.newPage();
trap(again, 'picker (editor, add to a lecture)');
await again.goto(`${base}/deck.html?library=${pickDeck.id}`);
await again.waitForFunction(() => document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.cell').length === 5, null, { timeout: 20000 });
await again.click('#deck-save-more');
ok('the deck editor offers "Add to a lecture…" for a deck on the server', await again.isVisible('#deck-add-to-lecture'));
const [toPlan] = await Promise.all([owen.waitForEvent('page'), again.click('#deck-add-to-lecture')]);
trap(toPlan, 'picker (planner, from the editor)');
await toPlan.waitForSelector('.fb-dialog .fb-row', { timeout: 15000 });
const ticked = await toPlan.evaluate(() => [...document.querySelectorAll('.fb-dialog .fb-row')].filter((r) => r.querySelector('input:checked')).map((r) => r.querySelector('.fb-title').textContent));
ok(`it opens the planner with that deck ticked (${ticked.join(', ')})`, ticked.length === 1 && ticked[0] === 'Picker deck');
const rows = await toPlan.evaluate(() => document.querySelectorAll('#order .order-row').length);
await toPlan.click('.fb-dialog .fb-foot button');
await toPlan.waitForFunction((n) => document.querySelectorAll('#order .order-row').length === n + 1, rows, { timeout: 5000 })
  .then(() => ok('and Add puts it in the lecture', true))
  .catch(() => ok('and Add puts it in the lecture', false));
ok('the planner\'s address is tidied back to plain', !new URL(toPlan.url()).searchParams.has('add'));
await owen.close();
}

if (want('My Files: everything I have, and what I may do with it (#243)')) {
console.log('\n-- My Files: everything I have, and what I may do with it (#243) --');
// A TA of their own, so changing a password here leaves everyone else's alone.
admin('user', 'add', 'mia', '--name', 'Mia TA', '--password-stdin');
admin('course', 'add', 'mine101', '--title', 'Mine 101');
admin('member', 'add', 'mine101', 'owen', '--role', 'owner');
admin('member', 'add', 'mine101', 'mia', '--role', 'member');
const owen = await signedIn('owen');
const desk = await owen.newPage();
trap(desk, 'my files setup');
await desk.goto(`${base}/index.html`);
await desk.evaluate(async (bytes) => {
  await fetch('/api/library/upload?filename=owen-handout.pdf&course=mine101&title=Owen%20handout', { method: 'POST', body: new Uint8Array(bytes) });
  await fetch('/api/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Shared lecture', course: 'mine101', doc: { podium: 'plan', v: 1, title: 'Shared lecture', items: [] } }) });
}, [...fs.readFileSync(path.join(ROOT, 'content', 'sample.pdf'))]);
await owen.close();

const mia = await signedIn('mia');
const other = await signedIn('mia');          // the same person, on another device
const page = await mia.newPage();
trap(page, 'my files (mia)');
await page.goto(`${base}/index.html`);
const miaUpload = await page.evaluate(async (bytes) => {
  const res = await fetch('/api/library/upload?filename=mia-notes.pdf&course=mine101&title=Mia%20notes', { method: 'POST', body: new Uint8Array(bytes) });
  return (await res.json()).item;
}, [...fs.readFileSync(path.join(ROOT, 'content', 'sample.pdf'))]);

await page.waitForSelector('#session-badge .session-who');
ok('your name in the session badge leads to My Files', await page.getAttribute('#session-badge .session-who', 'href') === 'me.html');
await Promise.all([page.waitForURL((url) => url.pathname === '/me.html'), page.click('#session-badge .session-who')]);
await page.waitForFunction(() => document.querySelector('#me-name')?.textContent === 'Mia TA', null, { timeout: 10000 })
  .then(() => ok('the profile says who you are', true))
  .catch(() => ok('the profile says who you are', false));
const courseLine = await page.textContent('#me-courses');
ok(`and your course, with your role in it ("${courseLine}")`, /MINE101 — member \(TA\)/.test(courseLine));

const row = (title) => page.locator('#files-list .me-row', { hasText: title });
await row('Owen handout').waitFor({ timeout: 10000 });
ok(`a course owner's file is View only to a TA ("${await row('Owen handout').locator('.me-chip').textContent()}")`,
  (await row('Owen handout').locator('.me-chip').textContent()) === 'View only');
ok('with the reason on it', /Added by Owen Owner; you're a member of MINE101/.test(await row('Owen handout').locator('.me-chip').getAttribute('title')));
ok('and nothing offered that would change it', await row('Owen handout').locator('button', { hasText: /Rename|Move|Delete/ }).count() === 0);
ok(`their own upload says Owner ("${await row('Mia notes').locator('.me-chip').textContent()}")`, (await row('Mia notes').locator('.me-chip').textContent()) === 'Owner');
ok('with Rename, Move and Delete', await row('Mia notes').locator('button', { hasText: /^(Rename|Move to…|Delete)$/ }).count() === 3);

page.once('dialog', (d) => d.accept('Mia notes, revised'));
await row('Mia notes').locator('button', { hasText: 'Rename' }).click();
await row('Mia notes, revised').waitFor({ timeout: 5000 })
  .then(() => ok('Rename renames it', true))
  .catch(() => ok('Rename renames it', false));
await row('Mia notes, revised').locator('button', { hasText: 'Move to…' }).click();
await page.waitForSelector('.me-dialog select');
await page.selectOption('.me-dialog select', '');
ok('moving to no course warns who will see it', /everyone who has an account/.test(await page.textContent('.me-dialog')));
await page.click('.me-dialog button:has-text("Move")');
await page.waitForFunction(() => /Moved/.test(document.querySelector('#files-note').textContent), null, { timeout: 5000 }).catch(() => {});
ok('Move refiles it', (await libraryItem(page, miaUpload.id))?.course === null && /No course/.test(await row('Mia notes, revised').textContent()));

await page.selectOption('#files-show', 'view');
ok('Show: View only narrows the list to what you cannot change', await row('Owen handout').count() === 1 && await row('Mia notes, revised').count() === 0);
await page.selectOption('#files-show', 'all');

const [look] = await Promise.all([mia.waitForEvent('page'), row('Owen handout').locator('button', { hasText: '↗' }).click()]);
trap(look, 'my files quick look');
await look.waitForFunction(() => /Page 1 of \d+/.test(document.querySelector('#ql-where')?.textContent || ''), null, { timeout: 20000 })
  .then(() => ok('↗ opens a PDF in Quick Look', true))
  .catch(() => ok('↗ opens a PDF in Quick Look', false));
await look.close();

await page.click('.me-tabs .tab:has-text("Lectures")');
const lecture = page.locator('#lectures-list .me-row', { hasText: 'Shared lecture' });
await lecture.waitFor({ timeout: 10000 })
  .then(() => ok('Lectures lists the lecture shared with them through their course', true))
  .catch(() => ok('Lectures lists the lecture shared with them through their course', false));
ok(`as shared, to open and present, not delete ("${await lecture.locator('.me-chip').textContent().catch(() => '')}")`,
  (await lecture.locator('.me-chip').textContent()) === 'Shared, view & present' && await lecture.locator('button', { hasText: 'Delete' }).count() === 0);
const [present] = await Promise.all([mia.waitForEvent('page'), lecture.locator('button', { hasText: 'Present' }).click()]);
trap(present, 'my files present');
await present.waitForFunction(() => /Loaded “Shared lecture”/.test(document.querySelector('#plan-note')?.textContent || ''), null, { timeout: 15000 })
  .then(() => ok('Present opens it in the controller', true))
  .catch(async () => ok(`Present opens it in the controller ("${await present.textContent('#plan-note').catch(() => '')}")`, false));
ok('and tidies the controller\'s address', !new URL(present.url()).searchParams.has('plan'));
await present.close();
await page.click('.me-tabs .tab:has-text("Recorded lectures")');
await page.waitForFunction(() => !/Looking/.test(document.querySelector('#recorded-list').textContent), null, { timeout: 5000 });
await page.click('.me-tabs .tab:has-text("Deck templates")');
await page.waitForFunction(() => !/Looking/.test(document.querySelector('#templates-list').textContent), null, { timeout: 5000 });
ok('the other tabs load', true);

// The password: the current one is asked for, and every other device signs out.
const otherPage = await other.newPage();
await otherPage.goto(`${base}/index.html`);
const otherStatus = () => otherPage.evaluate(() => fetch('/api/me').then((r) => r.status));
ok('the other device is signed in to begin with', await otherStatus() === 200);
await page.click('#me-password');
expecting.passwordRefused = true;
await page.fill('#pw-current', 'not my password');
await page.fill('#pw-new', 'a fresh long password');
await page.fill('#pw-again', 'a fresh long password');
await page.click('.me-password button[type=submit]');
await page.waitForFunction(() => /not your current password/.test(document.querySelector('#pw-status')?.textContent || ''), null, { timeout: 5000 })
  .then(() => ok('the wrong current password is refused, and says so', true))
  .catch(() => ok('the wrong current password is refused, and says so', false));
expecting.passwordRefused = false;
await page.fill('#pw-current', 'a good long password');
await page.click('.me-password button[type=submit]');
await page.waitForSelector('.me-dialog', { state: 'detached', timeout: 10000 })
  .then(() => ok('the right one changes it', true))
  .catch(() => ok('the right one changes it', false));
ok(`and says what happened ("${await page.textContent('#me-who')}")`, /password changed/.test(await page.textContent('#me-who')));
ok('this browser is still signed in', await page.evaluate(() => fetch('/api/me').then((r) => r.status)) === 200);
ok('the other device is not', await otherStatus() === 401);
await other.close();
await mia.close();

// An administrator sees everything; the page still starts with their own.
const root = await signedIn('root');
const rootPage = await root.newPage();
trap(rootPage, 'my files (root)');
await rootPage.goto(`${base}/me.html`);
await rootPage.waitForFunction(() => document.querySelector('#me-who')?.textContent.includes('Administrator'), null, { timeout: 10000 }).catch(() => {});
ok(`an administrator's Files start on Mine ("${await rootPage.inputValue('#files-show')}")`, await rootPage.inputValue('#files-show') === 'mine');
await root.close();
}

if (want('Documents: a plain .md shown as one page to read (#240)')) {
console.log('\n-- Documents: a plain .md shown as one page to read (#240) --');
const filler = (n) => Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of the reading, long enough to wrap across the page at projector size and take up some room.`).join('\n\n');
const reading = [
  '---', 'title: Reading 3', '---', '',
  '# Memory and forgetting', '',
  '<!-- Open with the bus story. -->', '',
  filler(6), '',
  '| Store | Lasts |', '|---|---|', '| Sensory | < 1 s |', '| Working | ~20 s |', '',
  '- [ ] Read section 2', '- [x] Watch the clip', '',
  '```python', 'def recall(item):', '    return item', '```', '',
  'Forgetting follows $R = e^{-t/S}$ roughly.', '',
  '```mermaid', 'graph LR', '  A[Encode] --> B[Store] --> C[Retrieve]', '```', '',
  '## Part two: interference', '',
  '<!-- Ask who has moved house recently. -->', '',
  filler(10), '',
  '## Part three', '',
  filler(10),
].join('\n');
const owen = await signedIn('owen');
const desk = await owen.newPage();
trap(desk, 'documents setup');
await desk.goto(`${base}/index.html`);
const upload = (name, body) => desk.evaluate(async ([n, b]) => (await (await fetch(`/api/library/upload?filename=${n}&course=psy415&title=${encodeURIComponent(n)}`, { method: 'POST', body: b })).json()).item, [name, body]);
const docItem = await upload('reading3.md', reading);
const marpItem = await upload('slides3.md', '---\nmarp: true\n---\n\n# Still slides\n\n---\n\n## Two\n');
ok(`a plain .md uploaded to the library is a document (${docItem?.type})`, docItem?.type === 'document');
ok(`one that says marp: true is still a deck (${marpItem?.type})`, marpItem?.type === 'deck');
ok('a document has the same stable address a deck has', /^\/media\/deck\/\d+\/reading3\.md$/.test(docItem?.src || ''));
const switched = await desk.evaluate(async (id) => (await (await fetch(`/api/library/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'document' }) })).json()).item, marpItem.id);
ok('a deck can be switched to a document, and back', switched?.type === 'document'
  && (await desk.evaluate(async (id) => (await (await fetch(`/api/library/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'deck' }) })).json()).item?.type, marpItem.id)) === 'deck');
await desk.close();

const screen = await owen.newPage();
trap(screen, 'documents display');
await screen.goto(`${base}/display.html`);
await screen.click('#arm-button');
await screen.waitForSelector('#hud[data-status="online"]');
const pad = await owen.newPage();
trap(pad, 'documents controller');
await pad.goto(`${base}/control.html`);
await pad.waitForSelector('.tile');
const tile = pad.locator('.tile', { hasText: 'reading3.md' });
await tile.click();

const wall = () => screen.evaluate(() => {
  const host = document.querySelector('.layer[data-role="program"] .r-doc');
  const view = host?.shadowRoot?.querySelector('#view');
  if (!view) return null;
  const m = /translate\([\d.]+px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(view.style.transform || '');
  return {
    at: m ? Math.round(-Number(m[1]) / Number(m[2])) : null,
    text: view.textContent,
    html: view.innerHTML,
  };
});
await until(async () => (await wall())?.text?.includes('Memory and forgetting'), { timeout: 20000 }).catch(() => {});
const first = await wall();
ok('it goes up as one page, not as slides', !!first && first.at === 0 && !(await screen.evaluate(() => !!document.querySelector('.layer[data-role="program"] .r-deck'))));
ok('a table, a task list, highlighted code and math all render',
  /<table>/.test(first?.html) && /task-box/.test(first?.html) && /hljs-keyword/.test(first?.html) && /class="katex"/.test(first?.html));
await until(async () => /podium-diagram/.test((await wall())?.html || ''), { timeout: 20000 }).catch(() => {});
ok('and so does a Mermaid diagram', /podium-diagram/.test((await wall())?.html || ''));
ok('the presenter notes are never on the display', !/bus story|moved house/.test((await wall())?.text || ''));

// (This controller does not switch tabs on its own - see its settings.)
await pad.click('.tab[data-tab="now"]');
await pad.waitForSelector('#doc-tools', { state: 'visible', timeout: 10000 })
  .then(() => ok('the Now tab has a document\'s own controls', true))
  .catch(() => ok('the Now tab has a document\'s own controls', false));
await pad.waitForFunction(() => /Screen 1 of \d+/.test(document.querySelector('#page-label')?.textContent || ''), null, { timeout: 10000 })
  .then(async () => ok(`which says where the room is ("${await pad.textContent('#page-label')}")`, true))
  .catch(async () => ok(`which says where the room is ("${await pad.textContent('#page-label')}")`, false));
await pad.waitForFunction(() => /bus story/.test(document.querySelector('#doc-notes')?.textContent || ''), null, { timeout: 10000 })
  .then(() => ok('and shows the note for what is on screen', true))
  .catch(async () => ok(`and shows the note for what is on screen ("${await pad.textContent('#doc-notes')}")`, false));

await pad.click('#next-page');
await until(async () => (await wall())?.at === 612, { timeout: 8000 }).catch(() => {});
ok(`Next scrolls the room most of a screen (${(await wall())?.at})`, (await wall())?.at === 612);
await pad.click('#prev-page');
await until(async () => (await wall())?.at === 0, { timeout: 8000 }).catch(() => {});
ok('and Previous back', (await wall())?.at === 0);

// Ink pinned to the text: drawn at one place in the page, it moves with the
// page and is there again when the page comes back.
const scrubTo = (v) => pad.evaluate((x) => { const s = document.querySelector('#doc-scrub'); s.value = String(x); s.dispatchEvent(new Event('change')); }, v);
await scrubTo(300);
await until(async () => (await wall())?.at === 300, { timeout: 8000 }).catch(() => {});
await pad.click('.tab[data-tab="ink"]');
await pad.waitForTimeout(600);
const box = await pad.$eval('#pad', (n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await pad.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.3);
await pad.mouse.down();
for (let i = 1; i <= 10; i++) await pad.mouse.move(box.x + box.w * (0.3 + i * 0.04), box.y + box.h * 0.3);
await pad.mouse.up();
// The middle row of the ink on the display, in CSS pixels, or null.
const inkRow = () => screen.evaluate(() => {
  const c = document.querySelector('#ink');
  const k = c.width / c.clientWidth;
  const x = Math.round(c.width / 2);
  const d = c.getContext('2d').getImageData(x, 0, 1, c.height).data;
  const rows = [];
  for (let y = 0; y < c.height; y++) if (d[y * 4 + 3] > 0) rows.push(y);
  return rows.length ? rows[Math.floor(rows.length / 2)] / k : null;
});
const displayScale = () => screen.evaluate(() => {
  const view = document.querySelector('.layer[data-role="program"] .r-doc').shadowRoot.querySelector('#view');
  return Number(/scale\(([\d.]+)\)/.exec(view.style.transform)[1]);
});
await until(async () => (await inkRow()) !== null, { timeout: 8000 }).catch(() => {});
const drawnAt = await inkRow();
ok(`ink drawn on a document reaches the display (row ${Math.round(drawnAt)})`, drawnAt !== null);
const sc = await displayScale();
await scrubTo(0);
await until(async () => (await wall())?.at === 0, { timeout: 8000 }).catch(() => {});
await screen.waitForTimeout(700);
const movedTo = await inkRow();
ok(`and scrolls with the text (${Math.round(drawnAt)} → ${Math.round(movedTo)}, expected ${Math.round(drawnAt + 300 * sc)})`,
  movedTo !== null && Math.abs(movedTo - (drawnAt + 300 * sc)) <= 3);
await scrubTo(300);
await until(async () => (await wall())?.at === 300, { timeout: 8000 }).catch(() => {});
await screen.waitForTimeout(700);
ok('and is back where it was drawn when the page is', Math.abs((await inkRow()) - drawnAt) <= 3);
await pad.click('.tab[data-tab="now"]');

const headings = await pad.$$eval('#doc-headings .doc-heading', (bs) => bs.map((b) => b.textContent));
ok(`the controller lists its headings (${headings.join(' / ')})`, headings.join('|') === 'Memory and forgetting|Part two: interference|Part three');
await pad.click('#doc-headings .doc-heading:has-text("Part two")');
// The page glides there; wait for it to come to rest.
const settled = async () => {
  let last = null;
  await until(async () => {
    const now = (await wall())?.at;
    const still = now > 612 && now === last;
    last = now;
    return still;
  }, { timeout: 8000, interval: 250 }).catch(() => {});
  return wall();
};
const jumped = await settled();
const headingTop = await screen.evaluate(() => {
  const view = document.querySelector('.layer[data-role="program"] .r-doc').shadowRoot.querySelector('#view');
  const h = view.querySelector('#doc-h-1');
  return Math.round((h.getBoundingClientRect().top - view.getBoundingClientRect().top) / (view.getBoundingClientRect().width / 1280));
});
ok(`a heading jump lands just above the heading (at ${jumped?.at}, heading at ${headingTop})`, jumped && Math.abs(headingTop - 24 - jumped.at) <= 4);
await pad.waitForFunction(() => /moved house/.test(document.querySelector('#doc-notes')?.textContent || ''), null, { timeout: 8000 })
  .then(() => ok('the notes follow the document as it scrolls', true))
  .catch(async () => ok(`the notes follow the document as it scrolls ("${await pad.textContent('#doc-notes')}")`, false));
ok('and the page label names the section', /Part two/.test(await pad.textContent('#page-label')));

// The controller's mirror and the display agree, at a different window size.
await pad.setViewportSize({ width: 900, height: 1100 });
await pad.waitForTimeout(400);
const mirrorAt = await pad.evaluate(() => {
  const view = document.querySelector('#now-preview .r-doc')?.shadowRoot?.querySelector('#view');
  const m = /translate\([\d.]+px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(view?.style.transform || '');
  return m ? Math.round(-Number(m[1]) / Number(m[2])) : null;
});
ok(`the controller's mirror is at the same place in the page (${mirrorAt} / ${jumped?.at})`, mirrorAt === jumped?.at);

// To the end, and Next stops.
const max = Number(await pad.getAttribute('#doc-scrub', 'max'));
await pad.evaluate((v) => { const s = document.querySelector('#doc-scrub'); s.value = String(v); s.dispatchEvent(new Event('change')); }, max);
await until(async () => (await wall())?.at === max, { timeout: 8000 }).catch(() => {});
ok(`the scrubber goes to the end (${max})`, (await wall())?.at === max && max > 1000);
ok('where Next has nothing left to do', await pad.isDisabled('#next-page'));

// Quick Look shows it as a document too.
await pad.click('.tab[data-tab="library"]');
const [look] = await Promise.all([owen.waitForEvent('page'), tile.locator('.tile-look').click()]);
trap(look, 'documents quick look');
await look.waitForFunction(() => /Screen 1 of [2-9]/.test(document.querySelector('#ql-where')?.textContent || ''), null, { timeout: 20000 })
  .then(async () => ok(`Quick Look opens a document as a page ("${await look.textContent('#ql-where')}")`, true))
  .catch(async () => ok(`Quick Look opens a document as a page ("${await look.textContent('#ql-where')}")`, false));
await look.click('#ql-next');
ok('and scrolls it on its own', /Screen 2 of/.test(await look.textContent('#ql-where')) && (await wall())?.at === max);
await look.close();

// The deck editor's document mode: an outline instead of slides, the page
// as the class sees it, following the cursor, and a switch to slides.
const editor = await owen.newPage();
trap(editor, 'documents editor');
await editor.goto(`${base}/deck.html?library=${docItem.id}`);
await editor.waitForFunction(() => document.body.classList.contains('is-doc'), null, { timeout: 20000 })
  .then(() => ok('a document opens in the deck editor in document mode', true))
  .catch(() => ok('a document opens in the deck editor in document mode', false));
const outline = () => editor.evaluate(() => [...(document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.h') || [])].map((b) => b.textContent));
await editor.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.h').length || 0) === 3, null, { timeout: 15000 }).catch(() => {});
ok(`the slide strip is its outline instead (${(await outline()).join(' / ')})`, (await outline()).join('|') === 'Memory and forgetting|Part two: interference|Part three'
  && (await editor.textContent('#deck-strip-label')) === 'Outline');
ok('what the class sees is the page', await editor.evaluate(() => !!document.querySelector('#deck-preview .r-doc')));
ok('and the slide-only tools are put away', await editor.isHidden('#deck-add-slide') && await editor.isHidden('.deck-toolbar [data-cmd="build"]')
  && await editor.isHidden('.deck-slide-panel') && await editor.isVisible('#doc-look'));
const editorText = () => editor.evaluate(async () => {
  const CM = await import('/assets/vendor/codemirror.esm.js');
  const v = CM.EditorView.findFromDOM(document.querySelector('.cm-editor'));
  return { text: v.state.doc.toString(), line: v.state.doc.lineAt(v.state.selection.main.head).text };
});
const previewAt = () => editor.evaluate(() => {
  const view = document.querySelector('#deck-preview .r-doc')?.shadowRoot?.querySelector('#view');
  const m = /translate\([\d.]+px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(view?.style.transform || '');
  return m ? Math.round(-Number(m[1]) / Number(m[2])) : null;
});
await editor.evaluate(() => [...document.querySelector('#deck-strip').shadowRoot.querySelectorAll('.h')][1].click());
await editor.waitForTimeout(800);
ok(`a heading in the outline puts the cursor on it ("${(await editorText()).line}")`, /^## Part two/.test((await editorText()).line));
ok(`and the page there (${await previewAt()})`, (await previewAt()) > 600);
ok(`the position says which screen (${await editor.textContent('#deck-position')})`, /^Screen \d+ of \d+$/.test(await editor.textContent('#deck-position')));

// The whole document as a PDF, broken into printable pages.
await editor.click('#deck-save-more');
const [docPdf] = await Promise.all([editor.waitForEvent('download', { timeout: 60000 }), editor.click('#deck-download-pdf')]);
const docPdfText = fs.readFileSync(await docPdf.path()).toString('latin1');
const docPages = (docPdfText.match(/\/Type \/Page\b/g) || []).length;
ok(`"Download as a PDF" breaks it into printable pages (${docPages} pages)`, docPdfText.startsWith('%PDF') && docPages >= 2);

// Make it a deck, and back.
await editor.click('#deck-mode-switch');
await editor.waitForFunction(() => !document.body.classList.contains('is-doc'), null, { timeout: 10000 }).catch(() => {});
ok('"Make this a slide deck" adds marp: true to its front matter, and it is slides', /^---\n[\s\S]*?^marp: true$[\s\S]*?\n---\n/m.test((await editorText()).text) && await editor.isVisible('#deck-add-slide'));
await editor.click('#deck-mode-switch');
await editor.waitForFunction(() => document.body.classList.contains('is-doc'), null, { timeout: 10000 }).catch(() => {});
ok('and "Make this a document" takes it away again', !/marp:/.test((await editorText()).text) && await editor.isHidden('#deck-add-slide'));
// An edit, saved back to the library as the document it is.
await editor.evaluate(async () => {
  const CM = await import('/assets/vendor/codemirror.esm.js');
  const v = CM.EditorView.findFromDOM(document.querySelector('.cm-editor'));
  v.dispatch({ changes: { from: v.state.doc.length, insert: '\n\n## Added in the editor\n' } });
});
await editor.waitForFunction(() => (document.querySelector('#deck-strip')?.shadowRoot?.querySelectorAll('.h').length || 0) === 4, null, { timeout: 10000 })
  .then(() => ok('a heading typed in joins the outline', true))
  .catch(() => ok('a heading typed in joins the outline', false));
await editor.click('#deck-save');
await waitSaved(editor);
const savedDoc = await libraryItem(editor, docItem.id);
ok('and Save puts it back in the library, still a document', savedDoc?.type === 'document'
  && (await serverText(editor, savedDoc.src)).includes('## Added in the editor'));
await editor.close();

// The planner: a plain .md is a document whichever item it is put in, and
// either can be switched.
const planner = await owen.newPage();
trap(planner, 'documents planner');
await planner.goto(`${base}/plan.html`);
await planner.click('#plan-new');
await planner.click('#type-picker .type-btn:has-text("Marp deck")');
await planner.setInputFiles('#item-fields input[type=file]', { name: 'reading.md', mimeType: 'text/markdown', buffer: Buffer.from(reading) });
await planner.waitForSelector('#item-fields button:has-text("Show it as slides instead")', { timeout: 8000 }).catch(() => {});
const shownAs = () => planner.textContent('#item-fields button:has-text("Show it as")').catch(() => '');
ok(`a plain .md put in a deck item makes it a document ("${await shownAs()}")`, /as slides instead/.test(await shownAs()));
ok('titled from the file', /Reading 3/.test(await planner.textContent('#order')));
await planner.click('#item-fields button:has-text("Show it as slides instead")');
ok('and it can be switched to slides', /as a document instead/.test(await shownAs()));
await planner.close();
await owen.close();
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
// Issue #231: at iPad width the editor is one column, and the slide strip
// used to make each thumbnail as wide as the window and then cut it off at
// the column's height - only the top-left corner of every slide showed.
await page.setViewportSize({ width: 820, height: 1180 });
await page.waitForTimeout(300);
const strip = await page.evaluate(() => {
  const col = document.querySelector('.deck-strip-col').getBoundingClientRect();
  return [...document.querySelector('#deck-strip').shadowRoot.querySelectorAll('.cell')].map((cell) => {
    const thumb = cell.querySelector('.thumb').getBoundingClientRect();
    const slide = cell.querySelector('svg[data-marpit-svg]').getBoundingClientRect();
    return {
      width: thumb.width,
      inColumn: thumb.top >= col.top && thumb.bottom <= col.bottom,
      slideFits: Math.abs(slide.width - thumb.width) < 6 && Math.abs(slide.height - thumb.height) < 6,
    };
  });
});
ok(`at iPad width the slides are small thumbnails in a row (${strip.map((t) => Math.round(t.width)).join(', ')} px wide)`, strip.length === 2 && strip.every((t) => t.width < 200));
ok('each one whole: inside the strip, and the whole slide inside it', strip.every((t) => t.inColumn && t.slideFits));
await page.setViewportSize({ width: 1440, height: 900 });
await page.click('.deck-toolbar [data-cmd="image"]');
ok('and a picture can only come from an address', await page.isHidden('#deck-image-dialog [data-from="device"]')
  && await page.isVisible('#deck-image-dialog .deck-media-offline'));
await page.click('#deck-image-cancel');
await page.click('.deck-toolbar [data-cmd="template"]');
await page.waitForSelector('#deck-templates-dialog:not([hidden]) .deck-template', { timeout: 10000 });
ok('the built-in templates are there with no server', await page.locator('.deck-template', { hasText: 'Question for the room' }).count() === 1);
ok('with nowhere to save new ones, and saying why', await page.isHidden('#deck-templates-save') && await page.isVisible('.deck-templates-offline'));
await page.locator('.deck-template', { hasText: 'Question for the room' }).locator('[data-act="use"]').click();
await page.waitForFunction(() => document.querySelector('#deck-strip').shadowRoot.querySelectorAll('.cell').length === 3, null, { timeout: 5000 })
  .then(() => ok('and one goes in', true))
  .catch(() => ok('and one goes in', false));
await page.keyboard.press('Control+z');
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
