// Searching across sessions (Issue #159, phase 1), against a real SQLite file:
// caption lines, what was on screen, notes and poll questions are found by
// word, stem and phrase, ranked, and only ever from a lecture the account can
// already see; removing a lecture takes its hits with it; and a database from
// before the index is backfilled the first time it is opened.
//
//   node podium/test/lecture-search.test.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning'); // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const courses = require('../server/courses.js');
const settings = require('../server/settings.js');
const lectures = require('../server/lectures.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };
const text = (hit) => hit.snippet.map((p) => (p.hit ? `[${p.text}]` : p.text)).join('');

const dir = mkdtempSync(path.join(tmpdir(), 'podium-search-'));
let db = store.open(dir);
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password' });
const tara = await accounts.createUser(db, { username: 'tara', password: 'a good long password' });
const olga = await accounts.createUser(db, { username: 'olga', password: 'a good long password' });
courses.create(db, admin, { code: 'psy415', title: 'Cognition' });
courses.create(db, admin, { code: 'psy101', title: 'Intro' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'tara', role: 'ta' });
courses.addMember(db, admin, 'psy101', { username: 'owen', role: 'owner' });
settings.write(db, owen, 'psy415', { transport: 'ws', room: 'room-415', passphrase: 'k', wsUrl: 'ws://localhost/podium' });
settings.write(db, owen, 'psy101', { transport: 'ws', room: 'room-101', passphrase: 'k', wsUrl: 'ws://localhost/podium' });

const T0 = Date.UTC(2026, 8, 1, 14, 0, 0);
const run = (user, room, at, events) => {
  const l = lectures.startLecture(db, user, { room, resume: false, now: at });
  lectures.appendEvents(db, user, l.id, events.map(([dt, kind, title, detail], i) => ({ id: `e${l.id}x${i}`, at: at + dt * 1000, kind, title, detail })));
  return l;
};

const week1 = run(owen, 'room-415', T0, [
  [0, 'program', 'Working memory: Baddeley and Hitch'],
  [60, 'caption', 'So the phonological loop is the part that rehearses words', { text: 'So the phonological loop is the part that rehearses words', live: true }],
  [120, 'caption', 'Remembering a phone number is the classic example', { text: 'Remembering a phone number is the classic example of the loop at work, and the café menu is another', live: true }],
  [180, 'note', 'Ran over on the loop section'],
]);
lectures.recordPoll(db, owen, week1.id, { pollId: 'p1', kind: 'choice', question: 'Which component stores images?', results: { counts: [3, 9] }, voters: 12, endedAt: T0 + 200000 });
// The same poll filed again (a second controller, a retry) is an upsert.
lectures.recordPoll(db, owen, week1.id, { pollId: 'p2', kind: 'choice', question: 'Which component stores smells?', results: { counts: [1, 1] }, voters: 2, endedAt: T0 + 205000 });
lectures.recordPoll(db, owen, week1.id, { pollId: 'p2', kind: 'choice', question: 'Which component stores sounds?', results: { counts: [5, 9] }, voters: 14, endedAt: T0 + 210000 });
const week2 = run(owen, 'room-415', T0 + 7 * 864e5, [
  [0, 'program', 'Long-term memory'],
  [30, 'caption', 'Last week we saw how the loop holds a phone number for a few seconds', { text: 'Last week we saw how the loop holds a phone number for a few seconds', live: true }],
]);
const intro = run(owen, 'room-101', T0 + 864e5, [[0, 'caption', 'Memory is the theme of chapter seven', { text: 'Memory is the theme of chapter seven' }]]);
const olgas = run(olga, 'her-room', T0, [[0, 'caption', 'My own phone number lecture', { text: 'My own phone number lecture' }]]);

console.log('-- the query --');
ok(`words are quoted, so FTS syntax is only text (${lectures.ftsQuery('memory AND (loop')})`, lectures.ftsQuery('memory AND (loop') === '"memory" "AND" "loop"');
ok(`a phrase, a prefix and a word left out (${lectures.ftsQuery('"phone  number" memor* -cafe')})`, lectures.ftsQuery('"phone  number" memor* -cafe') === '"phone number" "memor"* NOT "cafe"');
ok('nothing searchable is no query', lectures.ftsQuery('  -only "" ** ') === null);
ok('and an empty search is refused', status(() => lectures.searchLectures(db, owen, '   ')) === 400);

console.log('\n-- finding things --');
let r = lectures.searchLectures(db, owen, 'phone number');
ok(`both of Owen's sessions that mention it, and not Olga's (${r.results.map((x) => x.lecture.id)})`,
  r.results.length === 2 && r.results.every((x) => x.lecture.ownerId === owen.id) && !r.results.some((x) => x.lecture.id === olgas.id));
const hit = r.results.find((x) => x.lecture.id === week1.id).hits[0];
ok(`a hit lands on its moment: the event and when (${hit.eventId} at +${(hit.at - T0) / 1000}s)`, hit.kind === 'caption' && hit.at === T0 + 120000 && Number.isInteger(hit.eventId));
ok(`with the matched words marked (${text(hit)})`, /\[phone\] \[number\]/.test(text(hit)));
ok('a caption is found by its whole line, not just the 200-character title', lectures.searchLectures(db, owen, 'café menu').results[0]?.lecture.id === week1.id);
ok('accents fold: cafe finds café', lectures.searchLectures(db, owen, 'cafe').results.length === 1);
r = lectures.searchLectures(db, owen, 'remember');
ok(`stems: "remember" finds "Remembering" (${r.results.length})`, r.results.length === 1 && /\[Remembering\]/.test(text(r.results[0].hits[0])));
ok('a slide title is found', lectures.searchLectures(db, owen, 'Baddeley').results[0]?.hits[0].kind === 'program');
ok('a note is found', lectures.searchLectures(db, owen, 'ran over').results[0]?.hits[0].kind === 'note');
r = lectures.searchLectures(db, owen, 'component images');
ok(`a poll question is found, once (${JSON.stringify(r.results[0]?.hits.map((h) => h.kind))})`, r.results[0]?.hits.length === 1 && r.results[0].hits[0].kind === 'poll' && r.results[0].hits[0].pollId > 0);
ok('a phrase must be in order', lectures.searchLectures(db, owen, '"number phone"').results.length === 0);
ok('a prefix: phonolog* finds phonological', lectures.searchLectures(db, owen, 'phonolog*').results.length === 1);
ok('leaving a word out', lectures.searchLectures(db, owen, 'phone -cafe').results.map((x) => x.lecture.id).join() === String(week2.id));
r = lectures.searchLectures(db, owen, 'loop');
ok(`ranked: the session that says it most comes first (${r.results.map((x) => `${x.lecture.id}:${x.hits.length}`)})`, r.results[0].lecture.id === week1.id && r.results[0].hits.length === 3);
ok('and its hits are in the order they happened', r.results[0].hits.every((h, i, a) => !i || a[i - 1].at <= h.at));

console.log('\n-- whose sessions --');
ok('a course filter narrows it', lectures.searchLectures(db, owen, 'memory', { course: 'PSY101' }).results.map((x) => x.lecture.id).join() === String(intro.id));
ok('a TA finds the course\'s sessions', lectures.searchLectures(db, tara, 'phone').results.length === 2);
ok('but not another course of the instructor\'s', lectures.searchLectures(db, tara, 'chapter seven').results.length === 0);
ok('nobody else\'s sessions, ever', lectures.searchLectures(db, olga, 'loop').results.length === 0);
ok('an admin sees everything', lectures.searchLectures(db, admin, 'phone').results.length === 3);
courses.update(db, admin, 'psy415', { archived: true });
ok('an archived course\'s sessions are not searched by its members', lectures.searchLectures(db, tara, 'phone').results.length === 0);
ok('though whoever ran them still finds their own', lectures.searchLectures(db, owen, 'phone').results.length === 2);
courses.update(db, admin, 'psy415', { archived: false });

console.log('\n-- keeping up --');
ok('a poll filed again is re-indexed with its new question', lectures.searchLectures(db, owen, 'sounds').results.length === 1
  && lectures.searchLectures(db, owen, 'smells').results.length === 0);
lectures.deleteLecture(db, owen, week2.id, { dataDir: dir });
ok('removing a lecture takes its hits with it', lectures.searchLectures(db, owen, 'phone').results.map((x) => x.lecture.id).join() === String(week1.id)
  && db.prepare('SELECT COUNT(*) AS n FROM lecture_search WHERE lecture_id = ?').get(week2.id).n === 0);

console.log('\n-- a database from before the index --');
const version = db.prepare('PRAGMA user_version').get().user_version;
db.exec(`DROP TRIGGER lecture_search_event_in; DROP TRIGGER lecture_search_event_out;
  DROP TRIGGER lecture_search_poll_in; DROP TRIGGER lecture_search_poll_change; DROP TRIGGER lecture_search_poll_out;
  DROP TABLE lecture_search; PRAGMA user_version = ${version - 1};`);
db.prepare("INSERT INTO lecture_events (lecture_id, at, kind, title, detail) VALUES (?, ?, 'caption', 'short', ?)")
  .run(week1.id, T0 + 300000, JSON.stringify({ text: 'Recorded before search existed: mnemonic devices' }));
db.close();
db = store.open(dir);
ok('reopened, it is migrated again', db.prepare('PRAGMA user_version').get().user_version === version);
ok('and what was recorded before is searchable', lectures.searchLectures(db, owen, 'mnemonic').results[0]?.hits[0].at === T0 + 300000
  && lectures.searchLectures(db, owen, 'sounds').results.length === 1);

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
