// Reviewing attendance after class (Issue #256, phase 3), against a real
// SQLite file: a session's review (absent once closed, only for people who
// were on the roster then), the history of every change and who made it,
// flags dismissed, a guest put on the roster in one step, a session deleted,
// the term grid and its totals, and the three CSV exports - long, grid and
// Canvas - plus the lecture timeline's attendance lines.
//
//   node podium/test/attendance-review.test.mjs

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
const lectures = require('../server/lectures.js');
const att = require('../server/attendance.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };

const db = store.open(mkdtempSync(path.join(tmpdir(), 'podium-attend-review-')));
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password', displayName: 'Owen Owner' });
const tia = await accounts.createUser(db, { username: 'tia', password: 'a good long password', displayName: 'Tia TA' });
courses.create(db, admin, { code: 'psy415', title: 'Cognition' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'tia', role: 'member' });

const DAY = 86400000;
const T0 = Date.UTC(2026, 8, 1, 14, 0, 0);   // Tue 1 Sep 2026, 14:00 UTC
// On the roster from before term.
roster.applyImport(db, owen, 'psy415', 'name,student id,email\nJane Doe,A1,jane@school.edu\nSam Lee,A2,sam@school.edu\nBo Kim,A3,\n', { now: T0 - DAY });
const id = (name) => roster.list(db, owen, 'psy415').people.find((p) => p.name === name).id;

const checkIn = (session, device, who, at) => {
  const code = att.screen(db, { sessionId: session.id, key: session.screenKey, now: at }).code;
  const t = att.redeemCode(db, { code, device, ip: `10.0.0.${device.length}`, now: at });
  return att.checkIn(db, { ticket: t.ticket, device, ip: `10.0.0.${device.length}`, ...who, now: at });
};
const PHONE_A = 'phoneAAAAAAAAAAAAAAAAAA';
const PHONE_B = 'phoneBBBBBBBBBBBBBBBBBBB';

// Week 1: Jane and (on her phone) Bo; Sam missing. A guest, Pat.
const lecture = db.prepare("INSERT INTO lectures (course_id, room, title, started_by, started_at) VALUES (?, 'r', 'Week 1', ?, ?)")
  .run(courses.find(db, 'psy415').id, owen.id, T0).lastInsertRowid;
const w1 = att.openSession(db, owen, { course: 'psy415', lectureId: lecture, now: T0 }).session;
checkIn(w1, PHONE_A, { rosterId: id('Jane Doe') }, T0 + 60000);
checkIn(w1, PHONE_A, { rosterId: id('Bo Kim') }, T0 + 70000);
checkIn(w1, PHONE_B, { guest: { name: 'Pat Visitor', studentId: 'A9', email: 'pat@school.edu' } }, T0 + 80000);

console.log('-- reviewing a session --');
let review = att.getSession(db, owen, w1.id, { now: T0 + 90000 });
const row = (name) => review.people.find((p) => p.name === name);
ok('while check-in is open, someone not checked in is not yet absent', !row('Sam Lee').mark && !row('Sam Lee').absent);
att.changeSession(db, owen, w1.id, { open: false }, { now: T0 + 3600000 });
review = att.getSession(db, owen, w1.id, { now: T0 + 3600000 });
ok('once closed, they are absent without anyone marking them', row('Sam Lee').absent === true && !row('Sam Lee').mark);
ok('an owner may put a guest on the roster; the session says so', review.mayEditRoster === true && att.getSession(db, tia, w1.id).mayEditRoster === false);

console.log('\n-- history --');
att.markByHand(db, tia, w1.id, { rosterId: id('Sam Lee'), status: 'excused' }, { now: T0 + DAY / 2 });
att.changeMark(db, owen, w1.id, row('Bo Kim').mark.id, { status: 'late' }, { now: T0 + DAY / 2 + 1000 });
review = att.getSession(db, owen, w1.id, { now: T0 + DAY });
const history = review.history;
ok(`every change is in the session's history, newest first (${history.map((h) => `${h.by}: ${h.action} ${h.name} ${h.before ?? ''}→${h.after ?? ''}`).join('; ')})`,
  history.length === 2 && history[0].by === 'Owen Owner' && history[0].before === 'present' && history[0].after === 'late'
  && history[1].by === 'Tia TA' && history[1].action === 'marked' && history[1].after === 'excused');
ok('and an edited mark says by whom', row('Bo Kim').mark.edited && row('Bo Kim').mark.editedBy === 'Owen Owner');
att.changeMark(db, owen, w1.id, row('Bo Kim').mark.id, { status: 'late' }, { now: T0 + DAY });
ok('setting a mark to what it already is adds nothing to the history', att.getSession(db, owen, w1.id).history.length === 2);

console.log('\n-- flags --');
ok('Jane and Bo are flagged for sharing a phone', row('Jane Doe').mark.flags.some((f) => f.kind === 'device') && !row('Jane Doe').mark.dismissed);
att.dismissFlags(db, owen, w1.id, row('Jane Doe').mark.id, { now: T0 + DAY });
review = att.getSession(db, owen, w1.id);
ok('dismissing keeps the flag on record but marks it looked at, by whom', row('Jane Doe').mark.flags.length === 1 && row('Jane Doe').mark.dismissed?.by === 'Owen Owner');
ok('and the history says so', review.history[0].action === 'flags_dismissed' && review.history[0].name === 'Jane Doe');
ok('the course\'s session list counts what is still flagged', att.listSessions(db, owen, 'psy415').sessions[0].flagged === 1);

console.log('\n-- the timeline of a recorded lecture --');
lectures.noteAttendance(db, lecture, { at: T0 + 100, title: 'Attendance closed · 3 checked in of 3', detail: { count: 3 } });
const timeline = lectures.getLecture(db, owen, lecture).timeline;
ok(`a lecture's timeline can carry attendance lines (${timeline.map((e) => `${e.kind}: ${e.title}`).join('; ')})`,
  timeline.some((e) => e.kind === 'attendance' && e.detail.count === 3));
db.prepare('UPDATE lectures SET ended_at = ? WHERE id = ?').run(T0 + 7200000, lecture);
ok('but not once the lecture has ended', lectures.noteAttendance(db, lecture, { title: 'late' }) === false);

console.log('\n-- week 2, a new student, and a guest put on the roster --');
const w2 = att.openSession(db, owen, { course: 'psy415', now: T0 + 7 * DAY }).session;
checkIn(w2, PHONE_B, { guest: { name: 'Pat Visitor', studentId: 'A9', email: 'pat@school.edu' } }, T0 + 7 * DAY + 1000);
checkIn(w2, PHONE_A, { rosterId: id('Jane Doe') }, T0 + 7 * DAY + 2000);
// Ann joins the roster after week 1.
roster.add(db, owen, 'psy415', { name: 'Ann New', studentId: 'A4' }, { now: T0 + 3 * DAY });
att.changeSession(db, owen, w2.id, { open: false }, { now: T0 + 7 * DAY + 3600000 });
const guestMark = att.getSession(db, owen, w2.id).guests[0].mark.id;
ok('a TA cannot put a guest on the roster', status(() => att.addGuestToRoster(db, tia, w2.id, guestMark)) === 403);
const added = att.addGuestToRoster(db, owen, w2.id, guestMark, { now: T0 + 8 * DAY });
ok(`an owner can, in one step, and both of Pat's check-ins become Pat's (${added.linked} linked)`,
  added.person.source === 'guest' && added.person.name === 'Pat Visitor' && added.linked === 2);
ok('the guest list is empty now', att.getSession(db, owen, w1.id).guests.length === 0 && att.getSession(db, owen, w2.id).guests.length === 0);
ok('a mark already on the roster cannot be added again', status(() => att.addGuestToRoster(db, owen, w2.id, guestMark)) === 409);

console.log('\n-- the term grid --');
const g = att.grid(db, owen, 'psy415', { now: T0 + 30 * DAY });
const cells = (name) => g.rows.find((r) => r.name === name)?.cells.join(',');
ok(`two sessions, dated (${g.sessions.map((s) => s.label).join(', ')})`, g.sessions.length === 2 && g.sessions[0].label === '2026-09-01' && g.sessions[1].label === '2026-09-08');
ok(`Jane: present, present (${cells('Jane Doe')})`, cells('Jane Doe') === 'present,present');
ok(`Bo: late, then absent for not checking in (${cells('Bo Kim')})`, cells('Bo Kim') === 'late,absent');
ok(`Sam: excused, absent (${cells('Sam Lee')})`, cells('Sam Lee') === 'excused,absent');
ok(`Ann, added after week 1, is not absent from it (${cells('Ann New')})`, cells('Ann New') === ',absent');
ok(`Pat, put on the roster, has both weeks (${cells('Pat Visitor')})`, cells('Pat Visitor') === 'present,present');
const totals = (name) => g.rows.find((r) => r.name === name).totals;
ok(`totals and rate: Bo 1 late, 1 absent, 50% (${JSON.stringify(totals('Bo Kim'))})`, totals('Bo Kim').late === 1 && totals('Bo Kim').absent === 1 && totals('Bo Kim').rate === 0.5);
ok('an excused class counts for nothing either way: Sam 0%', totals('Sam Lee').rate === 0 && totals('Sam Lee').excused === 1);
ok('a date range narrows it', att.grid(db, owen, 'psy415', { from: T0 + 2 * DAY, now: T0 + 30 * DAY }).sessions.length === 1);
ok('dates are the reader\'s: a 7 pm class in UTC-10 is still that day',
  att.grid(db, owen, 'psy415', { tz: 600, now: T0 + 30 * DAY }).sessions[0].label === '2026-09-01'
  && att.grid(db, owen, 'psy415', { tz: 900, now: T0 + 30 * DAY }).sessions[0].label === '2026-08-31');

console.log('\n-- exports --');
const long = att.exportCsv(db, tia, 'psy415', { format: 'long', now: T0 + 30 * DAY });
const longLines = long.replace(/^\uFEFF/, '').trim().split('\r\n');
ok(`long: a TA may export it, one row per person per session (${longLines.length - 1} rows)`, longLines[0].startsWith('date,session,name,student id,email,on roster,status,how,checked in at,flags')
  && longLines.length - 1 === 9);
ok('with how, and absents that were never checked in', longLines.some((l) => /Bo Kim,A3,,yes,absent,not checked in/.test(l)) && longLines.some((l) => /Jane Doe.*present,code,14:01,same phone \(dismissed\)/.test(l)));
const gridCsv = att.exportCsv(db, owen, 'psy415', { format: 'grid', now: T0 + 30 * DAY }).replace(/^\uFEFF/, '').trim().split('\r\n');
ok(`grid: P/L/A/E per session and the totals (${gridCsv[0]})`, gridCsv[0] === 'name,student id,email,guest,2026-09-01,2026-09-08,present,late,absent,excused,rate'
  && gridCsv.includes('Bo Kim,A3,,,L,A,0,1,1,0,50%'));
const canvas = att.exportCsv(db, owen, 'psy415', { format: 'canvas', now: T0 + 30 * DAY }).replace(/^\uFEFF/, '').trim().split('\r\n');
ok(`canvas: Canvas's columns, a Points Possible row (${canvas.slice(0, 2).join(' | ')})`,
  canvas[0] === 'Student,ID,SIS User ID,SIS Login ID,Section,Attendance 2026-09-01,Attendance 2026-09-08' && canvas[1] === 'Points Possible,,,,,1,1');
ok('present 1, late 0.5, excused EX, absent 0 by default', canvas.includes('Bo Kim,,A3,,,0.5,0') && canvas.includes('Sam Lee,,A2,,,EX,0'));
const custom = att.exportCsv(db, owen, 'psy415', { format: 'canvas', points: { present: 2, late: 1, excused: 2 }, now: T0 + 30 * DAY });
ok('and what each is worth can be set', /Bo Kim,,A3,,,1,0/.test(custom) && /Sam Lee,,A2,,,2,0/.test(custom) && /Points Possible,,,,,2,2/.test(custom));
ok('nonsense points are refused', status(() => att.exportCsv(db, owen, 'psy415', { format: 'canvas', points: { late: 'lots' } })) === 400);

console.log('\n-- deleting a session --');
const oops = att.openSession(db, owen, { course: 'psy415', now: T0 + 9 * DAY }).session;
ok('a TA cannot delete a session', status(() => att.deleteSession(db, tia, oops.id)) === 403);
att.deleteSession(db, owen, oops.id);
ok('an owner can, and it is gone with its marks', status(() => att.getSession(db, owen, oops.id)) === 404 && att.listSessions(db, owen, 'psy415').sessions.length === 2);

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
