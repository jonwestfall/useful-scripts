// My Files (Issue #243), against a real SQLite file: changing your own
// password, your courses as the admin set them, moving a file between
// courses, and who added each file.
//
//   node podium/test/my-files.test.mjs

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

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };
const statusAsync = async (fn) => { try { await fn(); return 200; } catch (err) { return err.status || 500; } };

const db = store.open(mkdtempSync(path.join(tmpdir(), 'podium-myfiles-')));
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password', displayName: 'Owen O' });
const tia = await accounts.createUser(db, { username: 'tia', password: 'a good long password', displayName: 'Tia T' });
courses.create(db, admin, { code: 'psy415', title: 'PSY 415' });
courses.create(db, admin, { code: 'psy300', title: 'PSY 300' });
courses.create(db, admin, { code: 'old100', title: 'Old 100' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'tia', role: 'member' });
courses.addMember(db, admin, 'old100', { username: 'tia', role: 'owner' });
courses.update(db, admin, 'old100', { archived: true });

console.log('-- profile: my courses as the admin set them --');
const tiaCourses = courses.memberships(db, tia);
ok(`a TA's courses, with their role in each (${tiaCourses.map((c) => `${c.code}:${c.role}${c.archived ? ':archived' : ''}`).join(', ')})`,
  tiaCourses.length === 2 && tiaCourses[0].code === 'psy415' && tiaCourses[0].role === 'member' && !tiaCourses[0].archived);
ok('an archived course is listed after, marked', tiaCourses[1].code === 'old100' && tiaCourses[1].archived === true);
ok('a course they are not in is not listed', !tiaCourses.some((c) => c.code === 'psy300'));
ok('an admin\'s own memberships, not every course', courses.memberships(db, admin).length === 0);

console.log('\n-- files: who added each, and moving one --');
const media = (n) => library.rememberMedia(db, owen, { sha256: String(n).repeat(64).slice(0, 64), bytes: 2048, contentType: 'application/pdf' });
const owenPdf = library.addItem(db, owen, { courseCode: 'psy415', kind: 'pdf', title: 'Syllabus', filename: 's.pdf', mediaId: media('a') });
const tiaPdf = library.addItem(db, tia, { courseCode: 'psy415', kind: 'pdf', title: 'TA handout', filename: 'h.pdf', mediaId: media('b') });
const seen = library.listItems(db, tia);
ok(`each file says who added it, by name (${seen.map((i) => i.createdByName).join(', ')})`,
  seen.find((i) => i.id === owenPdf.id)?.createdByName === 'Owen O' && seen.find((i) => i.id === tiaPdf.id)?.createdByName === 'Tia T');
ok('and its size', seen.find((i) => i.id === owenPdf.id)?.bytes === 2048);
ok('a TA may move their own file to no course', status(() => library.renameItem(db, tia, tiaPdf.id, { courseCode: '' })) === 200
  && library.getItem(db, tia, tiaPdf.id).course === null);
ok('and back under their course', status(() => library.renameItem(db, tia, tiaPdf.id, { courseCode: 'psy415' })) === 200
  && library.getItem(db, tia, tiaPdf.id).course === 'psy415');
ok('but not under a course they are not in - refused, without saying it exists', status(() => library.renameItem(db, tia, tiaPdf.id, { courseCode: 'psy300' })) === 400
  && library.getItem(db, tia, tiaPdf.id).course === 'psy415');
ok('nor under an archived one of their own', status(() => library.renameItem(db, tia, tiaPdf.id, { courseCode: 'old100' })) === 409);
ok('nor move a course owner\'s file at all', status(() => library.renameItem(db, tia, owenPdf.id, { courseCode: '' })) === 403);
ok('which the list already said', seen.find((i) => i.id === owenPdf.id)?.may.move === false && seen.find((i) => i.id === tiaPdf.id)?.may.move === true);

console.log('\n-- changing your own password --');
const ip = '203.0.113.9';
const here = accounts.startSession(db, tia.id, 'here');
const elsewhere = accounts.startSession(db, tia.id, 'elsewhere');
const owenSession = accounts.startSession(db, owen.id, 'owen');
ok('a too-short new password is refused before anything is checked', await statusAsync(() => accounts.changeOwnPassword(db, tia, 'a good long password', 'short', { ip })) === 400);
const wrong = await accounts.changeOwnPassword(db, tia, 'not my password', 'a brand new password', { ip });
ok('the wrong current password is refused', wrong.ok === false && !wrong.retryAfterMs);
ok('and changes nothing', !!accounts.sessionUser(db, elsewhere) && (await accounts.login(db, 'tia', 'a good long password', { ip: '198.51.100.1' })).ok);
const changed = await accounts.changeOwnPassword(db, tia, 'a good long password', 'a brand new password', { ip, userAgent: 'here' });
ok('the right one changes it, and hands back a fresh session', changed.ok === true && typeof changed.token === 'string');
ok('which works', accounts.sessionUser(db, changed.token)?.username === 'tia');
ok('while every other session of theirs has ended', !accounts.sessionUser(db, here) && !accounts.sessionUser(db, elsewhere));
ok('and nobody else\'s', accounts.sessionUser(db, owenSession)?.username === 'owen');
ok('the new password signs in, the old one does not',
  (await accounts.login(db, 'tia', 'a brand new password', { ip: '198.51.100.2' })).ok
  && !(await accounts.login(db, 'tia', 'a good long password', { ip: '198.51.100.3' })).ok);
const audit = db.prepare("SELECT action FROM audit_logs WHERE username = 'tia' AND action LIKE 'password_%' ORDER BY id").all().map((r) => r.action);
ok(`both attempts are in the audit log (${audit.join(', ')})`, audit.join() === 'password_change_failure,password_changed_self');

let throttled = null;
for (let i = 0; i < 10 && !throttled; i += 1) {
  const attempt = await accounts.changeOwnPassword(db, owen, `guess ${i}`, 'another long password', { ip: '192.0.2.50' });
  if (attempt.retryAfterMs) throttled = attempt;
}
ok('guessing at it is throttled the same as a login', !!throttled);
const blocked = await accounts.changeOwnPassword(db, owen, 'a good long password', 'another long password', { ip: '192.0.2.50' });
ok('even the right password, until the lockout passes', blocked.ok === false && blocked.retryAfterMs > 0);
ok('and the login form is throttled for that account too', !!(await accounts.login(db, 'owen', 'a good long password', { ip: '192.0.2.51' })).retryAfterMs);

console.log('\n-- appearance: light or dark on every page, per account --');
ok('nobody has chosen until they do', owen.theme === '' && accounts.findUser(db, 'owen') && accounts.publicUser(accounts.findUser(db, 'owen')).theme === '');
ok('a choice is kept on the account', accounts.setTheme(db, owen, 'light') === 'light'
  && accounts.publicUser(accounts.findUser(db, 'owen')).theme === 'light');
ok('and comes back with their session, wherever they sign in', accounts.sessionUser(db, accounts.startSession(db, owen.id, 'test'))?.theme === 'light');
ok('it is theirs alone', accounts.publicUser(accounts.findUser(db, 'tia')).theme === '');
ok('only auto, light or dark', status(() => accounts.setTheme(db, owen, 'purple')) === 400
  && accounts.publicUser(accounts.findUser(db, 'owen')).theme === 'light');

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
