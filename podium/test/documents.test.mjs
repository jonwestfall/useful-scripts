// Markdown documents (Issue #240): telling a document from a deck, the
// library's kinds and the switch between them, a document in the room's state,
// and the page itself - its safety, its outline and its presenter notes.
//
//   node podium/test/documents.test.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning'); // the node:sqlite experimental notice
// The Marp bundle defines a custom element as it loads; Node has no DOM.
globalThis.HTMLElement ??= class {};

const { isMarpDeck } = await import('../assets/js/deck-source.js');
const { initialState, applyCommand, inkSurfaceKey, stripDeckNotes, DOC_VIEW } = await import('../assets/js/protocol.js');
const { renderDoc, docTitle, docLook, splitFrontMatter, notesInView, headingAt, headingAtTop } = await import('../assets/js/doc.js');
const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const courses = require('../server/courses.js');
const library = require('../server/library.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };

console.log('-- deck or document: marp: true decides --');
const cases = [
  ['---\nmarp: true\n---\n# a', true],
  ['---\nmarp:true\n---\n', true],
  ['---\r\nmarp: true\r\n---\r\n# Windows', true],
  ['---\ntheme: gaia\nmarp: true # a comment\n---\n', true],
  ["---\nmarp: 'true'\n---\n", true],
  ['---\nmarp: false\n---\n', false],
  ['---\ntitle: A reading\n---\n# Hi', false],
  ['# No front matter\n\nmarp: true', false],
  ['', false],
  ['---\nnotmarp: true\n---\n', false],
];
for (const [md, want] of cases) {
  ok(`${JSON.stringify(md.slice(0, 28))} is ${want ? 'a deck' : 'a document'}`, isMarpDeck(md) === want);
}
ok('the server files them by the same rule', cases.every(([md, want]) => library.markdownKind(md) === (want ? 'deck' : 'document')));

console.log('\n-- the library: kinds, and switching between them --');
const db = store.open(mkdtempSync(path.join(tmpdir(), 'podium-docs-')));
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password' });
const tia = await accounts.createUser(db, { username: 'tia', password: 'a good long password' });
courses.create(db, admin, { code: 'psy415', title: 'PSY 415' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'tia', role: 'member' });
const media = (n) => library.rememberMedia(db, owen, { sha256: String(n).repeat(64).slice(0, 64), bytes: 10, contentType: 'text/markdown' });
const oldDeck = library.addItem(db, owen, { courseCode: 'psy415', kind: 'deck', title: 'An old deck', filename: 'old.md', mediaId: media('a') });
const reading = library.addItem(db, owen, { courseCode: 'psy415', kind: 'document', title: 'Reading', filename: 'reading.md', mediaId: media('b') });
const pdf = library.addItem(db, owen, { courseCode: 'psy415', kind: 'pdf', title: 'Handout', filename: 'h.pdf', mediaId: media('c') });
ok('a deck already in the library stays a deck', library.getItem(db, owen, oldDeck.id).type === 'deck');
ok('a document has the stable address a deck has', /^\/media\/deck\/\d+\/reading\.md$/.test(reading.src));
ok('and says who may edit it, as a deck does', library.listItems(db, owen).find((i) => i.id === reading.id)?.editable === true);
ok('a document can be switched to a deck', library.renameItem(db, owen, reading.id, { kind: 'deck' }).type === 'deck');
ok('and back', library.renameItem(db, owen, reading.id, { kind: 'document' }).type === 'document');
ok('a PDF cannot be switched to either', status(() => library.renameItem(db, owen, pdf.id, { kind: 'document' })) === 400);
ok('nor markdown to anything else', status(() => library.renameItem(db, owen, reading.id, { kind: 'web' })) === 400);
ok('a TA cannot switch a course owner\'s file', status(() => library.renameItem(db, tia, reading.id, { kind: 'deck' })) === 403
  && library.getItem(db, tia, reading.id).type === 'document');

console.log('\n-- a document in the room --');
const state = initialState();
applyCommand(state, { op: 'stage', item: { type: 'document', deckId: 'abc', title: 'Reading', height: 3000, at: 99999, look: 'sepia' }, where: 'program' });
const doc = state.program;
ok(`a position past the end is held to the last screenful (${doc.at})`, doc.at === 3000 - DOC_VIEW);
ok('an unknown look is left to the file', doc.look === '');
applyCommand(state, { op: 'nav', dir: 'goto', value: 0 });
applyCommand(state, { op: 'nav', dir: 'next' });
ok(`Next moves most of a screen (${doc.at})`, doc.at === Math.round(DOC_VIEW * 0.85));
applyCommand(state, { op: 'nav', dir: 'goto', value: -50 });
ok('nothing goes above the top', doc.at === 0);
ok('Previous at the top changes nothing', applyCommand(state, { op: 'nav', dir: 'prev' }) === false);
applyCommand(state, { op: 'nav', dir: 'goto', value: 2000 });
ok('its pictures arriving can make it taller', applyCommand(state, { op: 'doc-height', deckId: 'abc', height: 5000 }) && doc.height === 5000 && doc.at === 2000);
applyCommand(state, { op: 'doc-height', deckId: 'abc', height: 1000 });
ok('or shorter, keeping the room on the page', doc.height === 1000 && doc.at === 1000 - DOC_VIEW);
ok('only for that document', applyCommand(state, { op: 'doc-height', deckId: 'other', height: 9000 }) === false && doc.height === 1000);
applyCommand(state, { op: 'stage', item: { type: 'document', deckId: 'x', height: 'lots', at: 'nowhere' }, where: 'program' });
ok('nonsense sizes and positions become sensible ones', state.program.height === DOC_VIEW && state.program.at === 0);
ok('ink on a document is kept per position until it is pinned to the text', inkSurfaceKey({ type: 'document', deckId: 'abc', at: 612 }) === 'document:abc:612');
ok('a viewer is sent a document without its presenter notes',
  stripDeckNotes('# Hi\n<!-- the secret plan -->\nText') === '# Hi\n\nText');

console.log('\n-- the page --');
ok('its title is its front matter\'s, else its first heading', docTitle('---\ntitle: Week 3\n---\n# Other') === 'Week 3' && docTitle('Intro\n\n## The *real* one\n') === 'The real one');
ok('light unless it says dark, and an item\'s own choice wins', docLook('# x') === 'light' && docLook('---\ntheme: dark\n---\n') === 'dark' && docLook('---\ntheme: dark\n---\n', 'light') === 'light');
ok('front matter is read and kept off the page', splitFrontMatter('---\na: 1\nb: "two"\n---\nbody').meta.b === 'two' && splitFrontMatter('---\na: 1\n---\nbody').body === 'body');

const md = [
  '---', 'title: Safety', 'mermaidTheme: forest', '---',
  '# One', '', '<!-- First note -->', '',
  'Some $x^2$ and $5 or $6.', '',
  '<div class="callout" onclick="steal()">kept <script>alert(1)</script></div>', '',
  '<a href="javascript:alert(1)">raw link</a>', '',
  '[md link](javascript:alert(2)) and <img src="x" onerror="alert(3)">', '',
  '## Two <!-- inline note -->', '',
  '- [x] done', '- [ ] not yet', '',
  '<!--  -->', '',
  '### Three', '',
].join('\n');
const page = await renderDoc(md, 'safety');
ok('no script survives', !/<script/i.test(page.html) && !/alert\(1\)/.test(page.html));
ok('no event attribute survives', !/onclick|onerror/i.test(page.html));
ok('no javascript: link survives', !/href="javascript:/i.test(page.html));
ok('allowed layout HTML is kept', /<div class="callout">kept/.test(page.html));
ok(`the outline is its headings, in order (${page.outline.map((h) => `${h.level}:${h.text}`).join(', ')})`,
  page.outline.map((h) => `${h.level}:${h.text}`).join('|') === '1:One|2:Two|3:Three' && page.outline[1].anchor === 'doc-h-1' && /id="doc-h-1"/.test(page.html));
ok(`comments become presenter notes (${JSON.stringify(page.notes)})`, page.notes.join('|') === 'First note|inline note');
ok('which are never in the page, only marked where they fall', !/First note|inline note/.test(page.html) && (page.html.match(/class="podium-note"/g) || []).length === 2);
ok('maths is drawn, and money is left alone', /class="katex"/.test(page.html) && /\$5 or \$6/.test(page.html));
ok('task lists are boxes nobody can tick', (page.html.match(/type="checkbox" disabled/g) || []).length === 2 && /disabled checked/.test(page.html));
ok('its mermaidTheme is carried for the diagrams', /data-mermaid-theme="forest"/.test(page.html));
ok('a dark document is marked dark', /class="podium-doc is-dark"/.test((await renderDoc('---\ntheme: dark\n---\nHi', 'dark')).html));

console.log('\n-- the notes and headings for what is on screen --');
const notes = [{ text: 'a', y: 100 }, { text: 'b', y: 900 }, { text: 'c', y: 1200 }, { text: 'd', y: 2500 }];
ok('the notes within the screen', notesInView(notes, 0).map((n) => n.text).join() === 'a');
ok('and the nearest one above it, for the section still up', notesInView(notes, 1000).map((n) => n.text).join() === 'b,c');
ok('none, before the first', notesInView([{ text: 'late', y: 2000 }], 0).length === 0);
const heads = [{ text: 'One', y: 0 }, { text: 'Two', y: 1661 }];
ok('a heading jump lands just above it', headingAt(heads[1], 5000) === 1637);
ok('but never past the end', headingAt(heads[1], 2000) === 2000 - DOC_VIEW);
ok('the heading the screen is under', headingAtTop(heads, 1700)?.text === 'Two' && headingAtTop(heads, 1000)?.text === 'One');

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
