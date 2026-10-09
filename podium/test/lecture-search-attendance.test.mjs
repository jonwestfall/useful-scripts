// Searching what attendance asked and was asked (Issue #159, phase 3), against
// a real SQLite file: a check-in's entry and exit questions and the parking
// lot are found alongside the lecture they were taken in - or on their own
// when no lecture was recorded - only ever by a member of that course (or an
// admin), never naming an anonymous asker, and kept up to date as questions
// change and check-ins are removed.
//
//   node podium/test/lecture-search-attendance.test.mjs

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
const roster = require('../server/roster.js');
const lectures = require('../server/lectures.js');
const att = require('../server/attendance.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const find = (user, q, opts) => lectures.searchLectures(db, user, q, opts).results;
const hitsOf = (results) => results.flatMap((r) => r.hits);

const dir = mkdtempSync(path.join(tmpdir(), 'podium-search-attend-'));
let db = store.open(dir);
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password' });
const tara = await accounts.createUser(db, { username: 'tara', password: 'a good long password' });
const olga = await accounts.createUser(db, { username: 'olga', password: 'a good long password' });
courses.create(db, admin, { code: 'psy415', title: 'Cognition' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'tara', role: 'ta' });
settings.write(db, owen, 'psy415', { transport: 'ws', room: 'room-415', passphrase: 'k', wsUrl: 'ws://localhost/podium' });
roster.applyImport(db, owen, 'psy415', 'name,student id\nJane Doe,A1\n');
const jane = roster.list(db, owen, 'psy415').people.find((p) => p.name === 'Jane Doe').id;

const T0 = Date.UTC(2026, 9, 1, 14, 0, 0);
const lecture = lectures.startLecture(db, owen, { room: 'room-415', resume: false, now: T0 });
const { session } = att.openSession(db, owen, {
  course: 'psy415', lectureId: lecture.id, now: T0 + 1000, parking: true,
  questions: { entry: [{ prompt: 'Did you finish the chapter on attention?', options: ['Yes', 'No'] }], exit: [{ prompt: 'What is still muddy about the spotlight model?' }] },
});

// One question in Jane's name, one anonymous, as the room would ask them.
const enter = (device, at) => {
  const code = att.screen(db, { sessionId: session.id, key: session.screenKey, now: at }).code;
  return att.redeemCode(db, { code, device, ip: '10.0.0.1', now: at });
};
const a = enter('phoneAAAAAAAAAAAAAAAAAA', T0 + 2000);
const mark = att.checkIn(db, { ticket: a.ticket, device: 'phoneAAAAAAAAAAAAAAAAAA', rosterId: jane, now: T0 + 3000 });
att.park(db, { markKey: mark.markKey, device: 'phoneAAAAAAAAAAAAAAAAAA', text: 'Is the spotlight the same as the zoom lens?', now: T0 + 4000 });
const b = enter('phoneBBBBBBBBBBBBBBBBBB', T0 + 5000);
att.park(db, { ticket: b.ticket, device: 'phoneBBBBBBBBBBBBBBBBBB', text: 'Could we get the slides about inattentional blindness?', anonymous: true, now: T0 + 6000 });

// And a check-in taken with no recorded lecture at all.
const { session: bare } = att.openSession(db, owen, {
  course: 'psy415', title: 'Make-up lab', now: T0 + 864e5,
  questions: { entry: [{ prompt: 'Which stroop condition was slowest?' }] },
});

console.log('-- found with the lecture --');
let r = find(owen, 'chapter attention');
ok(`a check-in's questions are found, in the lecture it was taken in (${JSON.stringify(r.map((x) => x.lecture?.id))})`,
  r.length === 1 && r[0].lecture?.id === lecture.id && r[0].hits[0].kind === 'questions' && r[0].hits[0].attendanceId === session.id);
ok('both its entry and its exit questions', find(owen, 'muddy spotlight model')[0]?.hits[0].kind === 'questions');
r = find(owen, 'zoom lens');
ok(`a parking-lot question is found, saying who asked it (${r[0]?.hits[0].who})`, r[0]?.lecture?.id === lecture.id && r[0].hits[0].kind === 'parking' && r[0].hits[0].who === 'Jane Doe' && r[0].hits[0].parkingId > 0);
r = find(owen, 'inattentional blindness');
ok('an anonymous one is found with no name at all', r[0]?.hits[0].kind === 'parking' && !('who' in r[0].hits[0]));
ok('and its words are marked like any other hit', r[0]?.hits[0].snippet.some((p) => p.hit && /inattentional/i.test(p.text)));
ok('one search finds a check-in\'s questions and its parking lot together',
  new Set(hitsOf(find(owen, 'spotlight')).map((h) => h.kind)).size === 2);

console.log('\n-- found on its own --');
r = find(owen, 'stroop');
ok(`a check-in with no recorded lecture is a result of its own (${JSON.stringify(r[0]?.attendance)})`,
  r.length === 1 && !r[0].lecture && r[0].attendance?.id === bare.id && r[0].attendance.title === 'Make-up lab' && r[0].attendance.course === 'psy415');
ok('a course filter finds it under its course', find(owen, 'stroop', { course: 'psy415' }).length === 1 && find(owen, 'stroop', { course: 'psy101' }).length === 0);

console.log('\n-- who finds them --');
ok('the course\'s TA finds them', find(tara, 'zoom lens').length === 1 && find(tara, 'stroop').length === 1);
ok('nobody outside the course does', find(olga, 'zoom lens').length === 0 && find(olga, 'stroop').length === 0);
ok('an admin does', find(admin, 'zoom lens').length === 1);
// A lecture of Owen's own, filed under no course, with a check-in of the
// course taken in it: the TA may read the check-in but not the lecture, so
// the search does not hand her a lecture she cannot open.
const privateLecture = lectures.startLecture(db, owen, { room: 'owens-office', resume: false, now: T0 + 2 * 864e5 });
att.openSession(db, owen, { course: 'psy415', lectureId: privateLecture.id, now: T0 + 2 * 864e5, questions: { entry: [{ prompt: 'Office hours: what is priming?' }] } });
ok('a check-in in a lecture only its owner can see is found by the owner', find(owen, 'priming')[0]?.lecture?.id === privateLecture.id);
ok('and not by the TA, who could not open that lecture', find(tara, 'priming').length === 0);

console.log('\n-- keeping up --');
att.changeSession(db, owen, bare.id, { questions: { entry: [{ prompt: 'Which flanker condition was slowest?' }] } });
ok('changing a check-in\'s questions re-indexes them', find(owen, 'stroop').length === 0 && find(owen, 'flanker').length === 1);
att.deleteSession(db, owen, session.id);
ok('removing a check-in takes its questions and its parking lot with it',
  find(owen, 'zoom lens').length === 0 && find(owen, 'chapter attention').length === 0 && find(owen, 'blindness').length === 0);

console.log('\n-- a database from before this phase --');
const { session: older } = att.openSession(db, owen, { course: 'psy415', title: 'Week 9', now: T0 + 9 * 864e5, questions: { exit: [{ prompt: 'Name one heuristic' }] } });
const version = db.prepare('PRAGMA user_version').get().user_version;
db.exec(`DROP TRIGGER lecture_search_questions_in; DROP TRIGGER lecture_search_questions_change; DROP TRIGGER lecture_search_questions_out;
  DROP TRIGGER lecture_search_parking_in; DROP TRIGGER lecture_search_parking_change; DROP TRIGGER lecture_search_parking_out;
  DELETE FROM lecture_search WHERE rowid % 4 >= 2; PRAGMA user_version = ${version - 1};`);
ok('(with the attendance rows taken out of the index)', find(owen, 'heuristic').length === 0);
db.close();
db = store.open(dir);
ok('reopened, what attendance asked before is searchable', find(owen, 'heuristic')[0]?.attendance?.id === older.id
  && find(owen, 'flanker').length === 1);

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
