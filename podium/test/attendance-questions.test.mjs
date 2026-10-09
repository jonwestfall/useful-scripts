// Questions with check-in (Issue #256, phase 4), against a real SQLite file:
// the entry ticket answered while checking in, the exit ticket answered later
// by the same phone without picking a name again, the parking lot (named or
// anonymous, and nothing tying an anonymous question to its asker), and what
// the instructor sees: a summary per question, each person's answers, and a
// CSV.
//
//   node podium/test/attendance-questions.test.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning'); // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const courses = require('../server/courses.js');
const roster = require('../server/roster.js');
const att = require('../server/attendance.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };

const db = store.open(mkdtempSync(path.join(tmpdir(), 'podium-attend-questions-')));
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password' });
courses.create(db, admin, { code: 'psy415', title: 'Cognition' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
roster.applyImport(db, owen, 'psy415', 'name,student id\nJane Doe,A1\nSam Lee,A2\n');
const id = (name) => roster.list(db, owen, 'psy415').people.find((p) => p.name === name).id;

const T0 = Date.UTC(2026, 9, 8, 14, 0, 0);
const PHONE_A = 'phoneAAAAAAAAAAAAAAAAAA';
const PHONE_B = 'phoneBBBBBBBBBBBBBBBBBB';

console.log('-- questions are tidied --');
const cleaned = att.cleanQuestions([
  { prompt: '  Which   reading? ', options: ['Ch 3', ' ', 'Ch 4'] },
  { prompt: 'One thing still muddy?', options: ['only one'] },
  { prompt: '' },
  { prompt: 'Three', options: [] },
  { prompt: 'Four is too many' },
]);
ok(`at most three, blanks dropped, a choice needs two options (${JSON.stringify(cleaned.map((q) => [q.id, q.kind, q.options.length]))})`,
  cleaned.length === 3 && cleaned[0].prompt === 'Which reading?' && cleaned[0].kind === 'choice' && cleaned[0].options.join('|') === 'Ch 3|Ch 4'
  && cleaned[1].kind === 'text' && cleaned[2].id === 'q3' && cleaned[2].prompt === 'Three');

const { session } = att.openSession(db, owen, {
  course: 'psy415', now: T0, parking: true,
  questions: { entry: [{ prompt: 'Did you do the reading?', options: ['Yes', 'Some', 'No'] }], exit: [{ prompt: 'One thing you learned' }] },
});
ok('a session is opened with its entry questions and the parking lot', session.phase === 'entry' && session.questions.entry.length === 1
  && session.questions.exit.length === 1 && session.parking === true);

const enter = (device, at) => {
  const code = att.screen(db, { sessionId: session.id, key: session.screenKey, now: at }).code;
  return att.redeemCode(db, { code, device, ip: '10.0.0.1', now: at });
};

console.log('\n-- the entry ticket --');
const a = enter(PHONE_A, T0 + 1000);
ok('a phone is told what it will be asked, before picking a name', a.session.phase === 'entry' && a.session.questions[0].prompt === 'Did you do the reading?' && a.session.parking);
const jane = att.checkIn(db, { ticket: a.ticket, device: PHONE_A, rosterId: id('Jane Doe'), now: T0 + 2000 });
ok('checking in hands back a key for this check-in, and the questions still to answer', /^\d+\.[\w-]{22}$/.test(jane.markKey) && jane.questions.length === 1 && !jane.answered);
ok('a wrong choice is refused', status(() => att.answer(db, { ticket: a.ticket, device: PHONE_A, markKey: jane.markKey, answers: { q1: 7 }, now: T0 + 3000 })) === 400);
const answered = att.answer(db, { ticket: a.ticket, device: PHONE_A, markKey: jane.markKey, answers: { q1: 1 }, now: T0 + 3000 });
ok('the entry ticket is answered', answered.saved === 1 && answered.answered);
ok('a key that is not the server\'s is refused', status(() => att.answer(db, { ticket: a.ticket, device: PHONE_A, markKey: `${jane.markKey.split('.')[0]}.forgedforgedforgedforg`, answers: { q1: 0 } })) === 401);
const b = enter(PHONE_B, T0 + 4000);
const sam = att.checkIn(db, { ticket: b.ticket, device: PHONE_B, rosterId: id('Sam Lee'), now: T0 + 5000 });
ok('Jane\'s key does not answer for Sam\'s phone\'s ticket from another browser', status(() => att.answer(db, { ticket: b.ticket, device: PHONE_A, markKey: jane.markKey, answers: { q1: 0 } })) === 401);
att.answer(db, { ticket: b.ticket, device: PHONE_B, markKey: sam.markKey, answers: { q1: 0 }, now: T0 + 6000 });
att.answer(db, { ticket: b.ticket, device: PHONE_B, markKey: sam.markKey, answers: { q1: 2 }, now: T0 + 7000 });
let review = att.getSession(db, owen, session.id);
ok(`answering again replaces the answer, and the summary counts each choice (${review.summary.entry[0].counts})`,
  review.summary.entry[0].counts.join() === '0,1,1' && review.summary.entry[0].answered === 2);
ok('each person\'s answers are on their mark', review.people.find((p) => p.name === 'Jane Doe').mark.answers.entry.q1 === 'Some');

console.log('\n-- the parking lot --');
const named = att.park(db, { markKey: jane.markKey, device: PHONE_A, text: 'Is the exam cumulative?', now: T0 + 8000 });
const anon = att.park(db, { markKey: sam.markKey, device: PHONE_B, text: '  Can we   get the slides? ', anonymous: true, now: T0 + 9000 });
review = att.getSession(db, owen, session.id);
ok(`a named question carries the asker's name (${review.parking.map((q) => `${q.name || '—'}: ${q.text}`).join('; ')})`,
  review.parking.find((q) => q.id === named.id).name === 'Jane Doe');
ok('an anonymous one has none, and nothing in the database ties it to Sam',
  anon.anonymous && review.parking.find((q) => q.id === anon.id).anonymous
  && JSON.stringify(db.prepare('SELECT * FROM attendance_parking WHERE id = ?').get(anon.id)).indexOf('Sam') === -1
  && db.prepare('SELECT mark_id FROM attendance_parking WHERE id = ?').get(anon.id).mark_id === null);
ok('a phone that never checked in can still ask, anonymously, with a fresh code',
  att.park(db, { ticket: enter('phoneCCCCCCCCCCCCCCCCCCC', T0 + 10000).ticket, device: 'phoneCCCCCCCCCCCCCCCCCCC', text: 'Late question', now: T0 + 10000 }).anonymous);
ok('an empty question is refused', status(() => att.park(db, { markKey: jane.markKey, device: PHONE_A, text: '   ' })) === 400);
att.answerParking(db, owen, session.id, named.id, { answered: true }, { now: T0 + 11000 });
ok('the instructor marks a question answered', !!att.getSession(db, owen, session.id).parking.find((q) => q.id === named.id).answeredAt);
for (let i = 0; i < 5; i++) att.park(db, { markKey: sam.markKey, device: 'phoneDDDDDDDDDDDDDDDDDDD', text: `q${i}`, anonymous: true, now: T0 + 12000 + i });
ok('a burst of questions from one phone is slowed down', status(() => att.park(db, { markKey: sam.markKey, device: 'phoneDDDDDDDDDDDDDDDDDDD', text: 'one more', now: T0 + 13000 })) === 429);
att.changeSession(db, owen, session.id, { parking: false });
ok('with the parking lot closed, nothing more is taken', status(() => att.park(db, { markKey: jane.markKey, device: PHONE_A, text: 'x', now: T0 + 14000 })) === 409);

console.log('\n-- the exit ticket --');
att.changeSession(db, owen, session.id, { open: false }, { now: T0 + 3600000 });
att.changeSession(db, owen, session.id, { open: true, phase: 'exit' }, { now: T0 + 4000000 });
const statusNow = att.status(db, { markKey: jane.markKey, now: T0 + 4000000 });
ok('a phone that checked in learns the exit ticket is open, from its key alone', statusNow.phase === 'exit' && statusNow.open && statusNow.questions[0].prompt === 'One thing you learned' && !statusNow.answered);
const exitTicket = enter(PHONE_A, T0 + 4001000);
ok('the screen\'s code now opens the exit ticket', exitTicket.session.phase === 'exit');
const out = att.answer(db, { ticket: exitTicket.ticket, device: PHONE_A, markKey: jane.markKey, answers: { q1: 'Working memory has limits' }, now: T0 + 4002000 });
ok('Jane answers it without picking her name again', out.saved === 1 && out.name === 'Jane Doe' && out.phase === 'exit');
review = att.getSession(db, owen, session.id);
ok('her entry answer is still there beside it', review.people.find((p) => p.name === 'Jane Doe').mark.answers.entry.q1 === 'Some'
  && review.summary.exit[0].answers[0] === 'Working memory has limits');
ok('the screen says it is the exit ticket', att.screen(db, { sessionId: session.id, key: session.screenKey, now: T0 + 4002000 }).phase === 'exit');

console.log('\n-- the CSV --');
const csv = att.answersCsv(db, owen, session.id);
ok(`one row per answer and per question in the parking lot (${csv.split('\r\n')[0]})`,
  /entry,Did you do the reading\?,Jane Doe,A1,Some/.test(csv) && /exit,One thing you learned,Jane Doe,A1,Working memory has limits/.test(csv)
  && /parking lot,,\(anonymous\),,Can we get the slides\?/.test(csv) && /parking lot,,Jane Doe,,Is the exam cumulative\?/.test(csv));

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
