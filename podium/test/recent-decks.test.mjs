// The planner's "Choose from the server" (Issue #241), against a real SQLite
// file: the decks someone had open in the deck editor lately, and what the
// library says each person may do with each file.
//
//   node podium/test/recent-decks.test.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning'); // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const courses = require('../server/courses.js');
const library = require('../server/library.js');
const recent = require('../server/recent.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };

const db = store.open(mkdtempSync(path.join(tmpdir(), 'podium-recent-')));
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password' });
const tia = await accounts.createUser(db, { username: 'tia', password: 'a good long password' });
const outsider = await accounts.createUser(db, { username: 'outsider', password: 'a good long password' });
courses.create(db, admin, { code: 'psy415', title: 'PSY 415' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'tia', role: 'member' });

const media = (n) => library.rememberMedia(db, owen, { sha256: String(n).repeat(64).slice(0, 64), bytes: 10, contentType: 'text/markdown' });
const courseDeck = library.addItem(db, owen, { courseCode: 'psy415', kind: 'deck', title: 'Week 1', filename: 'week1.md', mediaId: media('a') });
const tiaPdf = library.addItem(db, tia, { courseCode: 'psy415', kind: 'pdf', title: 'TA handout', filename: 'h.pdf', mediaId: media('b') });
const loose = library.addItem(db, owen, { courseCode: '', kind: 'deck', title: 'Loose deck', filename: 'loose.md', mediaId: media('c') });
const srcOf = (user, id) => library.listItems(db, user).find((i) => i.id === id)?.src;

console.log('-- recent decks --');
ok('nothing to begin with', recent.list(db, owen).length === 0);
recent.note(db, owen, { src: srcOf(owen, courseDeck.id), title: 'Week 1' });
recent.note(db, owen, { src: 'content/decks/day06.md', title: 'Day 6', saved: true });
let mine = recent.list(db, owen);
ok(`opened and saved decks are listed, newest first (${mine.map((d) => d.title).join(', ')})`, mine.map((d) => d.title).join() === 'Day 6,Week 1');
ok('a library deck says it is one, with its id and course', mine[1].where === 'library' && mine[1].libraryId === courseDeck.id && mine[1].course === 'psy415');
ok('saved or only opened', mine[0].saved === true && mine[1].saved === false);
recent.note(db, owen, { src: srcOf(owen, courseDeck.id), title: 'Week 1', saved: true });
mine = recent.list(db, owen);
ok('opening it again moves it to the top, once', mine.length === 2 && mine[0].title === 'Week 1' && mine[0].saved === true);
recent.note(db, owen, { src: srcOf(owen, courseDeck.id), title: 'Week 1' });
ok('and saved stays saved after a later open', recent.list(db, owen)[0].saved === true);
ok('/content/decks is the same file as content/decks', recent.note(db, owen, { src: '/content/decks/day06.md' }).src === 'content/decks/day06.md'
  && recent.list(db, owen).filter((d) => d.src === 'content/decks/day06.md').length === 1);
ok('only a deck on this server can be noted', [
  'https://example.org/deck.md', '/media/deck/x/y.md', 'content/decks/../../secret.md', 'content/photos/a.png', '', 'x'.repeat(600),
].every((src) => status(() => recent.note(db, owen, { src })) === 400));
ok('one person\'s list is not another\'s', recent.list(db, tia).length === 0);
recent.note(db, tia, { src: srcOf(owen, courseDeck.id), title: 'Week 1' });
recent.note(db, outsider, { src: srcOf(owen, courseDeck.id), title: 'Week 1' });
ok('a deck someone can no longer see is not listed to them', recent.list(db, tia).length === 1 && recent.list(db, outsider).length === 0);
for (let i = 0; i < 40; i++) recent.note(db, owen, { src: `content/decks/d${i}.md`, title: `D${i}` });
ok('a list, not a history: a dozen at most', recent.list(db, owen).length === 12 && recent.list(db, owen)[0].title === 'D39');
ok('and only a few dozen kept', db.prepare('SELECT COUNT(*) AS n FROM deck_recent WHERE user_id = ?').get(owen.id).n <= 30);

console.log('-- what each person may do with each file --');
const mayFor = (user, id) => library.listItems(db, user).find((i) => i.id === id)?.may;
ok('the owner of a course may change and edit its deck', JSON.stringify(mayFor(owen, courseDeck.id)) === JSON.stringify({ rename: true, move: true, delete: true, edit: true }));
ok('a TA may only use it', JSON.stringify(mayFor(tia, courseDeck.id)) === JSON.stringify({ rename: false, move: false, delete: false, edit: false }));
ok('what a TA added themselves, they may change', mayFor(tia, tiaPdf.id).rename === true && mayFor(tia, tiaPdf.id).edit === false);
ok('and the course owner may too', mayFor(owen, tiaPdf.id).delete === true);
ok('a deck with no course is its author\'s to edit', mayFor(owen, loose.id).edit === true && mayFor(tia, loose.id)?.edit === false && mayFor(tia, loose.id)?.rename === false);
ok('an admin may do anything', Object.values(mayFor(admin, courseDeck.id)).every(Boolean));
ok('and it agrees with the rules the server enforces', library.listItems(db, tia).every((item) => item.may.delete === library.mayDelete(db, tia, item)
  && (item.type !== 'deck' || item.may.edit === library.mayEditDeck(db, tia, item))));

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
