// Location and receipts for attendance (Issue #256, phase 5), against a real
// SQLite file: a session that asks phones to be near the room (the distance
// worked out, only it kept, and pruned like the rest of the evidence), the
// server's defaults for the code's rotation and the radius, and emailed
// receipts - a course switch only its owners turn, and the message itself.
//
//   node podium/test/attendance-location.test.mjs

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
const err = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const db = store.open(mkdtempSync(path.join(tmpdir(), 'podium-attend-location-')));
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password' });
const tia = await accounts.createUser(db, { username: 'tia', password: 'a good long password' });
courses.create(db, admin, { code: 'psy415', title: 'Cognition' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'tia', role: 'member' });
roster.applyImport(db, owen, 'psy415', 'name,student id,email\nJane Doe,A1,jane@school.edu\nSam Lee,A2,\n');
const id = (name) => roster.list(db, owen, 'psy415').people.find((p) => p.name === name).id;

const T0 = Date.UTC(2026, 9, 8, 14, 0, 0);
// The room, and points a known distance north of it (1e-5 degrees of latitude is about 1.11 m).
const ROOM = { lat: 41.8781, lng: -87.6298 };
const north = (m) => ({ lat: ROOM.lat + m / 111195, lng: ROOM.lng });

console.log('-- distance --');
ok(`100 m north is 100 m (${Math.round(att.distanceM(ROOM, north(100)))})`, Math.round(att.distanceM(ROOM, north(100))) === 100);
ok('a degree of longitude at 41.9°N is about 82.8 km', Math.abs(att.distanceM(ROOM, { lat: ROOM.lat, lng: ROOM.lng + 1 }) - 82800) < 300);

console.log('\n-- defaults --');
ok('15 seconds and 100 m unless an admin says otherwise', JSON.stringify(att.defaults(db)) === JSON.stringify({ rotate: 15, radius: 100 }));
ok('only the offered choices are taken', err(() => att.setDefaults(db, { rotate: 7 }))?.status === 400 && err(() => att.setDefaults(db, { radius: 3 }))?.status === 400);
att.setDefaults(db, { rotate: 30, radius: 200 });
const { session: plain } = att.openSession(db, owen, { course: 'psy415', now: T0 });
ok('a new session takes the server\'s rotation', plain.rotate === 30 && plain.geofence === null);
att.setDefaults(db, { rotate: 15, radius: 100 });
att.changeSession(db, owen, plain.id, { open: false }, { now: T0 + 1000 });

console.log('\n-- near the room --');
ok('a room point that makes no sense is refused', err(() => att.openSession(db, owen, { course: 'psy415', geofence: { lat: 200, lng: 0 } }))?.status === 400);
const { session } = att.openSession(db, owen, { course: 'psy415', geofence: { ...ROOM, radius: 100 }, now: T0 + 2000 });
ok('a session can ask phones to be within 100 m of a point', session.geofence?.radius === 100);
const enter = (device, at) => {
  const code = att.screen(db, { sessionId: session.id, key: session.screenKey, now: at }).code;
  return att.redeemCode(db, { code, device, ip: '10.0.0.1', now: at });
};
const a = enter('phoneAAAAAAAAAAAAAAAAAA', T0 + 3000);
ok('the phone is told a radius, never the room\'s point', a.session.where?.radius === 100 && !JSON.stringify(a.session).includes(String(ROOM.lat)));
const noLocation = err(() => att.checkIn(db, { ticket: a.ticket, device: 'phoneAAAAAAAAAAAAAAAAAA', rosterId: id('Jane Doe'), now: T0 + 4000 }));
ok(`no location (or permission refused) is refused, saying why (${noLocation?.message.slice(0, 50)}…)`, noLocation?.status === 403 && noLocation.needs === 'location');
const far = err(() => att.checkIn(db, { ticket: a.ticket, device: 'phoneAAAAAAAAAAAAAAAAAA', rosterId: id('Jane Doe'), location: { ...north(400), accuracy: 20 }, now: T0 + 5000 }));
ok(`400 m away is refused with the distance (${far?.message.slice(0, 60)}…)`, far?.status === 403 && far.needs === 'nearer' && /about 400 m/.test(far.message));
const jane = att.checkIn(db, { ticket: a.ticket, device: 'phoneAAAAAAAAAAAAAAAAAA', rosterId: id('Jane Doe'), location: { ...north(150), accuracy: 60 }, now: T0 + 6000 });
ok('150 m away with a phone that says it is good to 60 m is let in: indoors, locations are rough', jane.status === 'present');
const b = enter('phoneBBBBBBBBBBBBBBBBBB', T0 + 7000);
const sam = att.checkIn(db, { ticket: b.ticket, device: 'phoneBBBBBBBBBBBBBBBBBB', rosterId: id('Sam Lee'), location: { ...north(20), accuracy: 5000 }, now: T0 + 8000 });
ok('a wildly inaccurate fix gets no more slack than the radius itself', sam.status === 'present'
  && err(() => att.checkIn(db, { ticket: b.ticket, device: 'phoneBBBBBBBBBBBBBBBBBB', guest: { name: 'Far', email: 'far@x.org' }, location: { ...north(250), accuracy: 5000 }, now: T0 + 8500 }))?.status === 403);
let view = att.getSession(db, owen, session.id);
const distanceOf = (name) => view.people.find((p) => p.name === name).mark.distance;
ok(`the review shows how far each was (${distanceOf('Jane Doe')} m, ${distanceOf('Sam Lee')} m)`, distanceOf('Jane Doe') === 150 && distanceOf('Sam Lee') === 20);
ok('and no coordinates are stored anywhere for a student',
  !JSON.stringify(db.prepare('SELECT * FROM attendance_evidence').all()).includes(String(north(150).lat).slice(0, 7))
  && !JSON.stringify(db.prepare('SELECT * FROM attendance_marks').all()).includes('41.87'));
att.markByHand(db, tia, session.id, { rosterId: id('Sam Lee'), status: 'late' });
ok('a hand mark needs no location', att.getSession(db, owen, session.id).people.find((p) => p.name === 'Sam Lee').mark.status === 'late');
att.prune(db, { days: 30, now: T0 + 31 * 86400000 });
view = att.getSession(db, owen, session.id, { now: T0 + 31 * 86400000 });
ok('the distances go with the rest of the evidence after the retention period', distanceOf('Jane Doe') === null && view.people.find((p) => p.name === 'Jane Doe').mark.status === 'present');
att.changeSession(db, owen, session.id, { geofence: null });
ok('and the requirement can be taken off', att.getSession(db, owen, session.id).session.geofence === null);

console.log('\n-- emailed receipts --');
ok('a course sends none until an owner turns them on', att.receiptsOn(db, courses.find(db, 'psy415').id) === false
  && att.receiptEmail(db, jane) === null);
ok('a TA cannot turn them on', err(() => att.setReceipts(db, tia, 'psy415', true))?.status === 403);
att.setReceipts(db, owen, 'psy415', true);
const email = att.receiptEmail(db, jane, { timeZone: 'America/Chicago' });
ok(`with them on, a check-in's receipt goes to the roster's address (${email?.to}: ${email?.subject})`,
  email?.to === 'jane@school.edu' && /^Checked in: PSY415, Thu, Oct 8, 2026, 9:00 AM$/.test(email.subject));
ok('saying who, what class, when, how marked, and what to do if it was not them',
  /Checked in as: Jane Doe/.test(email.text) && /Class: PSY415 — Cognition/.test(email.text) && /Marked: present/.test(email.text) && /If that was not you, tell your instructor/.test(email.text));
ok('nobody with no address on file gets one', att.receiptEmail(db, sam) === null);
ok('and a repeated check-in sends nothing new', att.receiptEmail(db, { ...jane, already: true }) === null);
ok('the course\'s session list says receipts are on', att.listSessions(db, owen, 'psy415').receipts === true);

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
