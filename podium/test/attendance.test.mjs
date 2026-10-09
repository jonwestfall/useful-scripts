// Taking attendance (Issue #256, phase 2), against a real SQLite file: the
// rotating code, a phone checking in from the roster or as a guest, late
// marks, a shared phone flagged rather than refused, marking by hand, who may
// do what, throttling, and retention forgetting the evidence but not the mark.
//
//   node podium/test/attendance.test.mjs

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

const db = store.open(mkdtempSync(path.join(tmpdir(), 'podium-attend-')));
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password' });
const tia = await accounts.createUser(db, { username: 'tia', password: 'a good long password' });
const sam = await accounts.createUser(db, { username: 'sam', password: 'a good long password' });
courses.create(db, admin, { code: 'psy415', title: 'Cognition' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'tia', role: 'member' });
roster.applyImport(db, owen, 'psy415', 'name,student id,email\nJane Doe,A100123,jane@school.edu\nSam Lee,A200456,sam@school.edu\nBo Kim,A300789,bo@school.edu\nJanet Moss,A400111,\n');
const people = Object.fromEntries(roster.list(db, owen, 'psy415').people.map((p) => [p.name, p]));

const PHONE_A = 'phoneAAAAAAAAAAAAAAAAAA';
const PHONE_B = 'phoneBBBBBBBBBBBBBBBBBB';
const PHONE_C = 'phoneCCCCCCCCCCCCCCCCCC';
const T0 = Date.UTC(2026, 9, 8, 14, 0, 0);

console.log('-- who may take attendance --');
ok('someone outside the course cannot open check-in', status(() => att.openSession(db, sam, { course: 'psy415' })) === 404);
const { session } = att.openSession(db, tia, { course: 'psy415', now: T0 });
ok('a TA can open it, and it is open', session.open && session.course === 'psy415' && session.rotate === 15);
ok('someone outside the course cannot read it', status(() => att.getSession(db, sam, session.id)) === 404);

console.log('\n-- the code on the screen --');
const shown = att.screen(db, { sessionId: session.id, key: session.screenKey, now: T0 });
ok(`the screen gets a six-digit code (${shown.code}) and when it changes`, /^\d{6}$/.test(shown.code) && shown.rotatesInMs > 0 && shown.rotatesInMs <= 15000);
ok('without the screen key there is nothing to see', status(() => att.screen(db, { sessionId: session.id, key: 'nope', now: T0 })) === 404);
const later = att.screen(db, { sessionId: session.id, key: session.screenKey, now: T0 + 15000 }).code;
ok('it changes with the clock', later !== shown.code);
ok('the code showing now is taken', status(() => att.redeemCode(db, { code: later, device: PHONE_A, ip: '1.1.1.1', now: T0 + 15000 })) === 200);
ok('so is the one just before it (one change of grace)', status(() => att.redeemCode(db, { code: shown.code, device: PHONE_A, ip: '1.1.1.1', now: T0 + 15000 })) === 200);
ok('but not one from two changes ago', status(() => att.redeemCode(db, { code: shown.code, device: PHONE_A, ip: '1.1.1.1', now: T0 + 30000 })) === 404);
att.resetThrottle();

const codeAt = (now) => att.screen(db, { sessionId: session.id, key: session.screenKey, now }).code;
const enter = (device, now, ip = '10.0.0.1') => att.redeemCode(db, { code: codeAt(now), device, ip, now });

console.log('\n-- checking in from the roster --');
const a = enter(PHONE_A, T0 + 1000);
ok('a good code says which class it is, and that it has a roster', a.session.course === 'PSY415' && a.session.roster === true && !!a.ticket);
const found = att.searchPeople(db, { ticket: a.ticket, device: PHONE_A, q: 'jan', now: T0 + 2000 });
ok(`a name search finds people by the start of a name (${found.people.map((p) => p.name).join(', ')})`, found.people.length === 2);
ok('and shows only the end of an ID, never an email', found.people[0].idHint === '…123' && !JSON.stringify(found).includes('@'));
ok('one letter finds nobody', att.searchPeople(db, { ticket: a.ticket, device: PHONE_A, q: 'j', now: T0 + 2000 }).people.length === 0);
ok('an ID typed whole finds its person', att.searchPeople(db, { ticket: a.ticket, device: PHONE_A, q: 'a200456', now: T0 + 2000 }).people[0]?.name === 'Sam Lee');
ok('a ticket is no use from another browser', status(() => att.searchPeople(db, { ticket: a.ticket, device: PHONE_B, q: 'jan', now: T0 + 2000 })) === 401);
ok('or once it has run out', status(() => att.searchPeople(db, { ticket: a.ticket, device: PHONE_A, q: 'jan', now: T0 + 11 * 60 * 1000 })) === 401);
const jane = att.checkIn(db, { ticket: a.ticket, device: PHONE_A, ip: '10.0.0.1', rosterId: people['Jane Doe'].id, how: 'scan', now: T0 + 3000 });
ok(`a check-in gives a receipt (${jane.name}, ${jane.status})`, jane.name === 'Jane Doe' && jane.status === 'present' && jane.at === T0 + 3000 && !jane.already);
const again = att.checkIn(db, { ticket: a.ticket, device: PHONE_A, ip: '10.0.0.1', rosterId: people['Jane Doe'].id, now: T0 + 9000 });
ok('checking in twice changes nothing and shows the first receipt', again.already && again.at === T0 + 3000);

console.log('\n-- late --');
const b = enter(PHONE_B, T0 + 4000, '10.0.0.2');
att.changeSession(db, owen, session.id, { lateNow: true }, { now: T0 + 5000 });
const samMark = att.checkIn(db, { ticket: b.ticket, device: PHONE_B, ip: '10.0.0.2', rosterId: people['Sam Lee'].id, now: T0 + 6000 });
ok('with "now marking late" on, a check-in is late', samMark.status === 'late');
att.changeSession(db, owen, session.id, { lateNow: false, lateRule: { after: 10, from: T0 } }, { now: T0 + 7000 });
ok('a rule of ten minutes after the start: not late at nine', att.getSession(db, owen, session.id, { now: T0 + 9 * 60000 }).session.lateApplies === false);
ok('late at ten', att.getSession(db, owen, session.id, { now: T0 + 10 * 60000 }).session.lateApplies === true);
ok('an unreasonable rule is refused', status(() => att.changeSession(db, owen, session.id, { lateRule: { after: -5 } })) === 400);

console.log('\n-- one phone, two people --');
const bo = att.checkIn(db, { ticket: a.ticket, device: PHONE_A, ip: '10.0.0.1', rosterId: people['Bo Kim'].id, now: T0 + 8000 });
ok('a second person from the same phone is still checked in', bo.status === 'present' && !bo.already);
let view = att.getSession(db, owen, session.id, { now: T0 + 8000 });
const flagOf = (name) => view.people.find((p) => p.name === name)?.mark?.flags || [];
ok(`and both are flagged, each naming the other (${JSON.stringify(flagOf('Bo Kim'))})`,
  flagOf('Bo Kim').some((f) => f.kind === 'device' && f.with.includes('Jane Doe'))
  && flagOf('Jane Doe').some((f) => f.kind === 'device' && f.with.includes('Bo Kim')));
ok('a check-in from its own phone is not flagged as a shared phone', !flagOf('Sam Lee').some((f) => f.kind === 'device'));

console.log('\n-- guests --');
const c = enter(PHONE_C, T0 + 20000, '10.0.0.3');
ok('a guest must give an email', status(() => att.checkIn(db, { ticket: c.ticket, device: PHONE_C, guest: { name: 'Visitor' }, now: T0 + 21000 })) === 400);
const guest = att.checkIn(db, { ticket: c.ticket, device: PHONE_C, ip: '10.0.0.3', guest: { name: 'Pat Visitor', email: 'Pat@Else.org' }, now: T0 + 21000 });
ok('a guest checks in with a name and an email', guest.guest && guest.name === 'Pat Visitor');
ok('the same guest twice is one mark', att.checkIn(db, { ticket: c.ticket, device: PHONE_C, ip: '10.0.0.3', guest: { name: 'Pat', email: 'pat@else.org' }, now: T0 + 22000 }).already);
const asGuest = att.checkIn(db, { ticket: c.ticket, device: PHONE_C, ip: '10.0.0.3', guest: { name: 'J. Moss', studentId: 'a400111', email: 'jm@x.org' }, now: T0 + 23000 });
ok('a "guest" who gives the ID of someone on the roster is marked as them', !asGuest.guest && asGuest.name === 'Janet Moss');
view = att.getSession(db, owen, session.id, { now: T0 + 23000 });
ok('the session lists the guest separately, with the email for follow-up', view.guests.length === 1 && view.guests[0].email === 'pat@else.org');

console.log('\n-- by hand --');
const hand = att.markByHand(db, tia, session.id, { rosterId: people['Sam Lee'].id, status: 'excused' }, { now: T0 + 30000 });
ok('a TA can change a mark by hand, and is told what it was', hand.before === 'late' && hand.status === 'excused');
const removed = att.removeMark(db, owen, session.id, view.people.find((p) => p.name === 'Bo Kim').mark.id);
view = att.getSession(db, owen, session.id, { now: T0 + 31000 });
ok(`taking Bo's mark off clears Jane's shared-phone flag (${removed.name})`, !flagOf('Jane Doe').some((f) => f.kind === 'device'));
const byHand = att.markByHand(db, owen, session.id, { rosterId: people['Bo Kim'].id, status: 'present' }, { now: T0 + 32000 });
view = att.getSession(db, owen, session.id, { now: T0 + 32000 });
ok('a hand mark is "hand" and carries no flags', byHand.before === null && view.people.find((p) => p.name === 'Bo Kim').mark.how === 'hand' && !flagOf('Bo Kim').length);
ok('a status has to be a real one', status(() => att.markByHand(db, owen, session.id, { rosterId: people['Bo Kim'].id, status: 'asleep' })) === 400);
ok('counts add up', view.session.counts.present === 4 && view.session.counts.excused === 1);

console.log('\n-- closing and reopening --');
const d = enter(PHONE_B, T0 + 40000, '10.0.0.9');
att.changeSession(db, owen, session.id, { open: false }, { now: T0 + 41000 });
ok('closed, the screen shows no code', att.screen(db, { sessionId: session.id, key: session.screenKey, now: T0 + 41000 }).code === '');
ok('a phone already past the code has a moment to finish', status(() => att.searchPeople(db, { ticket: d.ticket, device: PHONE_B, q: 'jan', now: T0 + 60000 })) === 200);
ok('but not long after', status(() => att.searchPeople(db, { ticket: d.ticket, device: PHONE_B, q: 'jan', now: T0 + 41000 + 3 * 60000 })) === 410);
att.resetThrottle();
ok('and a fresh code is refused', status(() => att.redeemCode(db, { code: codeAt(T0 + 45000), device: PHONE_C, ip: '1.2.3.4', now: T0 + 45000 })) === 404);
const reopened = att.changeSession(db, owen, session.id, { open: true }, { now: T0 + 50000 });
ok('reopening opens the same session', reopened.open && reopened.id === session.id);

console.log('\n-- a lecture has one session --');
const lecture = db.prepare("INSERT INTO lectures (course_id, room, title, started_by, started_at) VALUES (?, 'r', 'Week 7', ?, ?)")
  .run(courses.find(db, 'psy415').id, owen.id, T0).lastInsertRowid;
const first = att.openSession(db, owen, { course: 'psy415', lectureId: lecture, now: T0 });
att.changeSession(db, owen, first.session.id, { open: false }, { now: T0 + 1000 });
const second = att.openSession(db, owen, { course: 'psy415', lectureId: lecture, now: T0 + 2000 });
ok(`opening again in the same lecture reopens it (${first.session.title})`, second.reopened && second.session.id === first.session.id && first.session.title === 'Week 7');
ok('and the controller finds it by lecture', att.currentSession(db, tia, { course: 'psy415', lectureId: lecture }).session?.id === first.session.id);

console.log('\n-- throttling --');
att.resetThrottle();
for (let i = 0; i < 5; i++) status(() => att.redeemCode(db, { code: '000000', device: PHONE_C, ip: '9.9.9.9', now: T0 + i }));
ok('five wrong codes from a phone, then it is told to wait', status(() => att.redeemCode(db, { code: codeAt(T0 + 10), device: PHONE_C, ip: '9.9.9.9', now: T0 + 10 })) === 429);
ok('another phone on the same network is not', status(() => att.redeemCode(db, { code: codeAt(T0 + 10), device: PHONE_A, ip: '9.9.9.9', now: T0 + 10 })) === 200);
ok('and the wait passes', status(() => att.redeemCode(db, { code: codeAt(T0 + 61000), device: PHONE_C, ip: '9.9.9.9', now: T0 + 61000 })) === 200);

console.log('\n-- the network hint --');
{
  const T1 = T0 + 3 * 3600000;
  const { session: s2 } = att.openSession(db, owen, { course: 'psy415', now: T1 });
  const join = (device, ip, name, at) => {
    const code = att.screen(db, { sessionId: s2.id, key: s2.screenKey, now: at }).code;
    const t = att.redeemCode(db, { code, device, ip, now: at });
    return att.checkIn(db, { ticket: t.ticket, device, ip, rosterId: people[name].id, now: at });
  };
  // Two phones on one home connection a minute apart, the rest of the class elsewhere.
  join('phoneDDDDDDDDDDDDDDDDDD', '172.16.0.9', 'Jane Doe', T1 + 1000);
  join('phoneEEEEEEEEEEEEEEEEEE', '172.16.0.9', 'Sam Lee', T1 + 60000);
  join('phoneFFFFFFFFFFFFFFFFFF', '10.9.0.1', 'Bo Kim', T1 + 2000);
  join('phoneGGGGGGGGGGGGGGGGGG', '10.9.0.2', 'Janet Moss', T1 + 3000);
  const v2 = att.getSession(db, owen, s2.id, { now: T1 + 70000 });
  const hint = (name) => v2.people.find((p) => p.name === name).mark.flags;
  ok(`two phones on one address nobody else uses get a weaker "same network" hint (${JSON.stringify(hint('Jane Doe'))})`,
    hint('Jane Doe').some((f) => f.kind === 'network' && f.with.includes('Sam Lee')) && !hint('Jane Doe').some((f) => f.kind === 'device'));
  ok('the others get nothing', !hint('Bo Kim').length && !hint('Janet Moss').length);
  // Everyone on one address is a campus's Wi-Fi, and says nothing.
  const { session: s3 } = att.openSession(db, owen, { course: 'psy415', now: T1 + 3600000 });
  for (const [i, name] of ['Jane Doe', 'Sam Lee', 'Bo Kim'].entries()) {
    const at = T1 + 3600000 + i * 1000;
    const code = att.screen(db, { sessionId: s3.id, key: s3.screenKey, now: at }).code;
    const t = att.redeemCode(db, { code, device: `phone${i}xxxxxxxxxxxxxxxxx`, ip: '10.10.10.10', now: at });
    att.checkIn(db, { ticket: t.ticket, device: `phone${i}xxxxxxxxxxxxxxxxx`, ip: '10.10.10.10', rosterId: people[name].id, now: at });
  }
  ok('a whole room on one address is not flagged', att.getSession(db, owen, s3.id, { now: T1 + 3700000 }).people.every((p) => !p.mark || !p.mark.flags.length));
}

console.log('\n-- retention --');
ok('the retention period is 30 days unless an admin says otherwise', att.retentionDays(db) === 30);
ok('a nonsense period is refused', status(() => att.setRetentionDays(db, 0)) === 400);
att.setRetentionDays(db, 7);
const evidence = () => db.prepare('SELECT COUNT(*) AS n FROM attendance_evidence').get().n;
const marks = () => db.prepare('SELECT COUNT(*) AS n FROM attendance_marks').get().n;
const before = { evidence: evidence(), marks: marks() };
att.prune(db, { now: T0 + 6 * 86400000 });
ok('nothing is forgotten inside the period', evidence() === before.evidence);
att.prune(db, { now: T0 + 8 * 86400000 });
ok(`after it, the device and network hashes go (${before.evidence} → ${evidence()}) and the marks stay (${marks()})`, evidence() === 0 && marks() === before.marks);
ok('and a session left open overnight is closed', !att.getSession(db, owen, session.id, { now: T0 + 8 * 86400000 }).session.open);
ok('nothing stored is an address or a raw token', !JSON.stringify(db.prepare('SELECT * FROM system_settings').all()).includes(PHONE_A));

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
