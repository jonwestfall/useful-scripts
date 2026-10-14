// Run with: node podium/test/live-signins.test.mjs
// A course that keeps its live pages' sign-ins (courses.liveSignins): who may
// turn it on, who gets the cookies, and that turning it off forgets them.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const courses = require('../server/courses.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const refused = (fn) => { try { fn(); return null; } catch (err) { return err; } };

const dataDir = mkdtempSync(path.join(tmpdir(), 'podium-live-signins-'));
const db = store.open(dataDir);
try {
  const owner = await accounts.createUser(db, { username: 'owner', password: 'owner password here' });
  const ta = await accounts.createUser(db, { username: 'ta', password: 'assistant password' });
  const outsider = await accounts.createUser(db, { username: 'outsider', password: 'outsider password' });
  db.prepare('INSERT INTO courses (code, title, created_at) VALUES (?, ?, ?)').run('psy101', 'PSY 101', Date.now());
  const courseId = db.prepare('SELECT id FROM courses WHERE code = ?').get('psy101').id;
  db.prepare('INSERT INTO course_members (course_id, user_id, role) VALUES (?, ?, ?)').run(courseId, owner.id, 'owner');
  db.prepare('INSERT INTO course_members (course_id, user_id, role) VALUES (?, ?, ?)').run(courseId, ta.id, 'member');
  const lecture = (course) => Number(db.prepare(`INSERT INTO lectures (course_id, room, title, started_by, started_at, last_seen_at)
      VALUES (?, 'room', 'A lecture', ?, ?, ?)`).run(course, owner.id, Date.now(), Date.now()).lastInsertRowid);
  const inCourse = lecture(courseId);
  const inNone = lecture(null);
  const cookie = { name: 'session', value: 'abc', domain: 'library.example.edu', path: '/', expires: -1, session: true };

  ok('off by default: no page in its lectures is handed anything', courses.liveSignins(db, owner, inCourse) === null);
  ok('the course list says so', courses.list(db, owner).find((c) => c.code === 'psy101').liveSignins === false);

  const notOwner = refused(() => courses.setLiveSignins(db, ta, 'psy101', true));
  ok(`only an owner turns it on (${notOwner?.status})`, notOwner?.status === 403);
  ok('an owner can', courses.setLiveSignins(db, owner, 'psy101', true).liveSignins === true);

  const forOwner = courses.liveSignins(db, owner, inCourse);
  ok('on, a page in one of its lectures is handed its sign-ins, starting with none', !!forOwner && forOwner.load().length === 0);
  forOwner.save([cookie]);
  ok('what a page keeps, the next one starts with', courses.liveSignins(db, owner, inCourse).load()[0]?.value === 'abc');
  ok('for anyone in the course', courses.liveSignins(db, ta, inCourse)?.load()[0]?.value === 'abc');
  ok('but never for someone outside it', courses.liveSignins(db, outsider, inCourse) === null);
  ok('nor for a page in a lecture filed under no course', courses.liveSignins(db, owner, inNone) === null);
  ok('nor with nobody signed in (a kiosk)', courses.liveSignins(db, null, inCourse) === null);
  ok('nor for a lecture that does not exist', courses.liveSignins(db, owner, 999999) === null);

  courses.forgetLiveSignins(db, owner, 'psy101');
  ok('"Forget" empties what was kept and leaves it on', courses.liveSignins(db, owner, inCourse)?.load().length === 0);

  courses.liveSignins(db, owner, inCourse).save([cookie]);
  const open = courses.liveSignins(db, owner, inCourse);
  courses.setLiveSignins(db, owner, 'psy101', false);
  ok('turned off, what was kept is gone', db.prepare('SELECT COUNT(*) AS n FROM course_live_cookies').get().n === 0);
  open.save([cookie]);
  ok('and a page still open when it was turned off keeps nothing as it closes', db.prepare('SELECT COUNT(*) AS n FROM course_live_cookies').get().n === 0);

  courses.setLiveSignins(db, owner, 'psy101', true);
  db.prepare('UPDATE courses SET archived_at = ? WHERE id = ?').run(Date.now(), courseId);
  ok('an archived course hands out nothing', courses.liveSignins(db, owner, inCourse) === null);
} finally {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
