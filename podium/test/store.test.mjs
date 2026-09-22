// The server's storage and accounts, with no browser and no HTTP.
//
//   node podium/test/store.test.mjs
//
// Everything here runs against a real SQLite file in a temporary directory,
// because the point of these tests is the behaviour of the actual store -
// migrations that run once, a password that cannot be read back, a session
// that stops working when its account does. A mock would be testing itself.

import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning');   // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const api = require('../server/api.js');
const lectures = require('../server/lectures.js');
const courses = require('../server/courses.js');
const doctor = require('../server/doctor.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

const root = mkdtempSync(path.join(tmpdir(), 'podium-store-'));
const dataDir = path.join(root, 'data');

console.log('-- opening and migrating --');

let db = store.open(dataDir);
ok('opening a fresh data directory produces a database', !!db);
ok('and the file is really on disk', existsSync(path.join(dataDir, 'podium.db')));
ok(`migrated to the current schema version (${store.SCHEMA_VERSION})`,
  db.prepare('PRAGMA user_version').get().user_version === store.SCHEMA_VERSION);

// Re-opening is the every-restart case, and the one that would corrupt things
// if migrations were not guarded by user_version.
db.close();
db = store.open(dataDir);
ok('re-opening an existing database does not re-run its migrations',
  !!db && db.prepare('PRAGMA user_version').get().user_version === store.SCHEMA_VERSION);

ok('a data directory of null means "store nothing" rather than an error', store.open(null) === null);
ok('DATA_DIR unset is the same answer', store.dataDirFromEnv({}) === null);
ok('DATA_DIR set resolves to an absolute path',
  path.isAbsolute(store.dataDirFromEnv({ DATA_DIR: 'relative/bits' })));

// { create: false } is podium-admin doctor's own open path - it must not
// conjure a fresh database into existence for a DATA_DIR that is missing or
// mistyped, which is exactly the box doctor is trying to diagnose.
const notYetADataDir = path.join(root, 'not-yet-a-data-dir');
let noCreateFailure = '';
try { store.open(notYetADataDir, { create: false }); } catch (err) { noCreateFailure = err.message; }
ok('create:false on a directory with no database throws rather than creating one',
  /no database/.test(noCreateFailure));
ok('and it really created nothing there', !existsSync(notYetADataDir));

const alreadyThereDir = path.join(root, 'already-there-data-dir');
store.open(alreadyThereDir).close();
const reopened = store.open(alreadyThereDir, { create: false });
ok('but create:false against a database that already exists opens it exactly as normal',
  reopened.prepare('PRAGMA user_version').get().user_version === store.SCHEMA_VERSION);
reopened.close();

// Whether a database exists is what decides whether the account gate governs,
// so "configured but unusable" must never look like "deliberately stateless".
// The first would hand an unprotected site to whoever asked next.
let openFailure = '';
try { store.open(path.join(root, 'data', 'podium.db', 'inside-a-file')); }
catch (err) { openFailure = err.message; }
ok(`a configured directory that cannot be opened throws instead of returning null (${openFailure.slice(0, 40)}…)`,
  /could not open the database/.test(openFailure));

// A rollback that goes one release too far: the schema is from the future and
// this code has never seen it.
db.exec(`PRAGMA user_version = ${store.SCHEMA_VERSION + 5}`);
let fromTheFuture = '';
try { store.migrate(db); } catch (err) { fromTheFuture = err.message; }
ok(`a database newer than the code is refused rather than written to (${fromTheFuture.slice(0, 48)}…)`,
  /newer release/.test(fromTheFuture));
db.exec(`PRAGMA user_version = ${store.SCHEMA_VERSION}`);

// A migration that dies partway must leave nothing behind. Without a
// transaction it would commit the tables it managed before the failure while
// leaving the version where it was - and every restart afterwards would rerun
// the migration and fail on a table that already exists, permanently.
const { DatabaseSync } = require('node:sqlite');
const broken = new DatabaseSync(path.join(root, 'half-migrated.db'));
broken.exec('CREATE TABLE courses (nothing_like_the_real_one TEXT)');   // migration 1 will collide here
let partial = '';
try { store.migrate(broken); } catch (err) { partial = err.message; }
ok(`a migration that fails partway says which one (${partial.slice(0, 40)}…)`,
  /migration to schema version 1 failed/.test(partial));
ok('leaves the version where it was, so the next start tries again cleanly',
  broken.prepare('PRAGMA user_version').get().user_version === 0);
ok('and rolls back the tables it did manage to create',
  broken.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().n === 0);
broken.close();

console.log('\n-- accounts --');

const jon = await accounts.createUser(db, {
  username: 'Jon', password: 'correct horse battery', displayName: 'Jon W', isAdmin: true,
});
ok('a username is stored folded to lower case, so JON and jon are one account', jon.username === 'jon');
ok('and the admin flag survives the round trip', jon.isAdmin === true);
ok('an account is found case-insensitively', !!accounts.findUser(db, 'JON'));

ok('there is now one account that can log in', accounts.countEnabledUsers(db) === 1);

const stored = accounts.findUser(db, 'jon').password_hash;
ok('the password is not stored anywhere in the row', !JSON.stringify(accounts.findUser(db, 'jon')).includes('correct horse'));
ok('it is stored as scrypt with its parameters attached', /^scrypt\$16384\$8\$1\$/.test(stored));
ok('the right password verifies', await accounts.verifyPassword('correct horse battery', stored));
ok('a wrong one does not', !(await accounts.verifyPassword('correct horse batteries', stored)));
ok('and neither does a malformed stored value, rather than throwing',
  !(await accounts.verifyPassword('anything', 'not-a-hash')));

let rejected = '';
try { await accounts.createUser(db, { username: 'jon', password: 'another one entirely' }); }
catch (err) { rejected = err.message; }
ok(`a duplicate username is refused (${rejected})`, /already an account/.test(rejected));

rejected = '';
try { await accounts.createUser(db, { username: 'no spaces here', password: 'a password' }); }
catch (err) { rejected = err.message; }
ok('a username with spaces is refused', /username must be/.test(rejected));

rejected = '';
try { await accounts.createUser(db, { username: 'shorty', password: 'short' }); }
catch (err) { rejected = err.message; }
ok('a password under eight characters is refused', /at least 8/.test(rejected));

console.log('\n-- signing in --');

const bad = await accounts.login(db, 'jon', 'not it', { ip: '10.0.0.1' });
ok('the wrong password does not sign anyone in', bad.ok === false && !bad.token);

const missing = await accounts.login(db, 'nobody-at-all', 'not it', { ip: '10.0.0.2' });
ok('an account that does not exist fails the same way, with nothing that says which',
  missing.ok === false && JSON.stringify(missing) === JSON.stringify({ ok: false }));

const good = await accounts.login(db, 'jon', 'correct horse battery', { ip: '10.0.0.1', userAgent: 'test' });
ok('the right password does', good.ok === true && typeof good.token === 'string' && good.token.length >= 32);
ok('and says who it signed in', good.user.username === 'jon');

ok('the token itself is never written down, only its hash',
  !db.prepare('SELECT token_sha256 FROM auth_sessions').get().token_sha256.includes(good.token));

ok('a session token names its user', accounts.sessionUser(db, good.token)?.username === 'jon');
ok('a token nobody issued does not', accounts.sessionUser(db, 'made-up-token') === null);
ok('and neither does an empty one', accounts.sessionUser(db, '') === null);

console.log('\n-- sessions end when they should --');

// Reaching in to age the row is the only way to test ninety days without
// waiting ninety days; the query it stands in for is the one the server runs.
db.prepare('UPDATE auth_sessions SET expires_at = ?').run(Date.now() - 1000);
ok('an expired session stops naming anyone', accounts.sessionUser(db, good.token) === null);
ok('and is cleaned up as it is rejected, rather than lingering',
  db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n === 0);

const second = await accounts.login(db, 'jon', 'correct horse battery', { ip: '10.0.0.1' });
accounts.setDisabled(db, 'jon', true);
ok('disabling an account drops every session it had',
  db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n === 0);
ok('and it can no longer sign in', (await accounts.login(db, 'jon', 'correct horse battery', { ip: '10.0.0.1' })).ok === false);
ok('a disabled account is not counted as one that can log in', accounts.countEnabledUsers(db) === 0);
// The switch that decides whether the cookie gate governs counts EVERY
// account, not just the ones that can sign in. Otherwise disabling your last
// account - something you would do precisely because something was wrong -
// would drop the instance to AUTH_PASSWORD, or with the installer's defaults
// to no gate at all. Locking yourself out must not let everyone else in.
ok('with every account disabled the instance still has accounts, so the gate stays up',
  accounts.countUsers(db) > 0 && accounts.countEnabledUsers(db) === 0);

accounts.setDisabled(db, 'jon', false);
ok('re-enabling brings it back', accounts.countEnabledUsers(db) === 1);
ok('but not its old sessions', accounts.sessionUser(db, second.token) === null);

const third = await accounts.login(db, 'jon', 'correct horse battery', { ip: '10.0.0.1' });
await accounts.setPassword(db, 'jon', 'a whole new password');
ok('changing a password signs every device out', accounts.sessionUser(db, third.token) === null);
ok('the old password stops working', (await accounts.login(db, 'jon', 'correct horse battery', { ip: '10.0.0.1' })).ok === false);
ok('the new one works', (await accounts.login(db, 'jon', 'a whole new password', { ip: '10.0.0.1' })).ok === true);

const fourth = await accounts.login(db, 'jon', 'a whole new password', { ip: '10.0.0.1' });
accounts.endSession(db, fourth.token);
ok('signing out ends that session and not the others', accounts.sessionUser(db, fourth.token) === null);

console.log('\n-- too many attempts --');

// A fresh username and address, so the earlier failures in this file cannot
// be what trips it.
await accounts.createUser(db, { username: 'target', password: 'a fine long password' });
let locked = null;
for (let i = 0; i < 12; i++) {
  locked = await accounts.login(db, 'target', 'wrong every time', { ip: '10.9.9.9' });
}
ok(`repeated failures start being refused outright (${locked.retryAfterMs ? 'locked out' : 'still guessing'})`,
  locked.ok === false && locked.retryAfterMs > 0);
ok('and the lockout holds even once the password is right',
  (await accounts.login(db, 'target', 'a fine long password', { ip: '10.9.9.9' })).ok === false);

console.log('\n-- the bits the gate is built from --');

ok('a cookie header is parsed into its parts',
  api.parseCookies('a=1; podium_session=abc; b=2').podium_session === 'abc');
ok('a header with no cookies at all is empty rather than broken',
  Object.keys(api.parseCookies('')).length === 0);
// decodeURIComponent throws on a malformed escape, and a Cookie header is
// whatever a stranger sends. Thrown from the static gate, where nothing is
// catching, one header would have been enough to take the process down.
let cookieCrash = null;
try { cookieCrash = api.parseCookies('podium_session=%').podium_session; }
catch (err) { cookieCrash = `threw: ${err.message}`; }
ok(`a malformed percent escape is survived rather than thrown (${cookieCrash})`,
  typeof cookieCrash === 'string' && !cookieCrash.startsWith('threw:'));
ok('and whatever it decodes to is not a session anybody holds',
  accounts.sessionUser(db, api.parseCookies('podium_session=%').podium_session) === null);
ok('a truncated escape at the end of a value is survived too',
  api.parseCookies('podium_session=abc%E0%A4').podium_session !== undefined);
// nginx appends the address it actually saw to whatever the client sent, so
// the header reads "<what the client claimed>, <the real peer>". Reading the
// front of that is reading a value the attacker picked - and a login throttle
// keyed on an attacker-chosen value is no throttle at all, because a fresh one
// can be invented for every attempt.
const ipOf = (headers, socket = '10.1.1.1') =>
  api.clientIp({ headers, socket: { remoteAddress: socket } });
ok(`the real peer is the LAST entry a proxy appended, not the first (${ipOf({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' })})`,
  ipOf({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' }) === '203.0.113.9');
ok('so a spoofed chain cannot mint a new identity per login attempt',
  ipOf({ 'x-forwarded-for': 'fake-1, fake-2, 203.0.113.9' }) === '203.0.113.9');
ok('one entry means one proxy and that entry is the client',
  ipOf({ 'x-forwarded-for': '203.0.113.9' }) === '203.0.113.9');
ok('with no proxy in front, the socket is the answer', ipOf({}) === '10.1.1.1');
ok('and an empty header falls back to the socket rather than to nothing',
  ipOf({ 'x-forwarded-for': '  ,  ' }) === '10.1.1.1');

ok('a relative path is a safe place to go after signing in', api.safeNext('/control.html') === '/control.html');
ok('a protocol-relative one is not', api.safeNext('//evil.example/x') === '');
ok('an absolute URL is not', api.safeNext('https://evil.example/x') === '');
ok('and neither is one with a newline smuggled into it', api.safeNext('/ok\nSet-Cookie: x') === '');

console.log('\n-- the library: what may be uploaded --');

const library = require('../server/library.js');

ok('a markdown file is a deck', library.uploadKindFor('week1.md')?.kind === 'deck');
ok('an extension in capitals is the same extension', library.uploadKindFor('SCAN.PDF')?.kind === 'pdf');
ok('a jpeg is an image', library.uploadKindFor('photo.jpeg')?.kind === 'image');
// The allow-list exists because uploads are served from the app's own origin.
// Anything a browser would execute there could read the session cookie.
ok('html is refused', library.uploadKindFor('evil.html') === null);
ok('svg is refused, being a script container with a picture extension', library.uploadKindFor('evil.svg') === null);
ok('javascript is refused', library.uploadKindFor('evil.js') === null);
ok('a file with no extension at all is refused', library.uploadKindFor('README') === null);
ok('and so is a double extension that ends badly', library.uploadKindFor('deck.md.html') === null);

console.log('\n-- the library: storing bytes --');

const owner = await accounts.createUser(db, { username: 'owner', password: 'owner password here' });
const ta = await accounts.createUser(db, { username: 'ta', password: 'assistant password' });
const outsider = await accounts.createUser(db, { username: 'outsider', password: 'outsider password' });
const admin = await accounts.createUser(db, { username: 'root', password: 'admin password here', isAdmin: true });

db.prepare('INSERT INTO courses (code, title, created_at) VALUES (?, ?, ?)').run('psy415', 'PSY 415', Date.now());
const courseId = db.prepare('SELECT id FROM courses WHERE code = ?').get('psy415').id;
db.prepare('INSERT INTO course_members (course_id, user_id, role) VALUES (?, ?, ?)').run(courseId, owner.id, 'owner');
db.prepare('INSERT INTO course_members (course_id, user_id, role) VALUES (?, ?, ?)').run(courseId, ta.id, 'member');

const deck = Buffer.from('# A deck\n\nwith a slide on it\n');
const uploaded = await library.storeUpload(dataDir, Readable.from([deck]));
ok(`an upload is stored under the sha-256 of its own bytes (${uploaded.sha256.slice(0, 12)}…)`,
  uploaded.sha256 === createHash('sha256').update(deck).digest('hex') && uploaded.bytes === deck.length);
ok('and the file is really where that says it is', existsSync(library.mediaPath(dataDir, uploaded.sha256)));

const again = await library.storeUpload(dataDir, Readable.from([deck]));
ok('the same bytes uploaded twice are the same file, not two', again.sha256 === uploaded.sha256);
ok('and nothing is left behind from the second attempt',
  readdirSync(path.join(dataDir, 'media', uploaded.sha256.slice(0, 2))).length === 1);

let tooBig = '';
try { await library.storeUpload(dataDir, Readable.from([Buffer.alloc(2048)]), { limit: 1024 }); }
catch (err) { tooBig = err.message; }
ok(`a file past the cap is refused (${tooBig})`, /larger than/.test(tooBig));
ok('and the half-written file is cleaned up rather than left in the media directory',
  readdirSync(path.join(dataDir, 'media')).every((name) => !name.startsWith('.incoming-')));

const mediaId = library.rememberMedia(db, owner, { ...uploaded, contentType: 'text/markdown' });
ok('the same bytes recorded twice reuse one row',
  library.rememberMedia(db, owner, { ...uploaded, contentType: 'text/markdown' }) === mediaId);

console.log('\n-- the library: who sees what --');

const forCourse = library.addItem(db, owner, {
  courseCode: 'psy415', kind: 'deck', title: 'Week 1', group: '', filename: 'week1.md', mediaId,
});
const forEveryone = library.addItem(db, owner, {
  courseCode: '', kind: 'text', title: 'Shared sign', props: { body: 'Back in 5' },
});

ok('an item carries the course it was filed under', forCourse.course === 'psy415');
ok('and a URL for its bytes, named by hash', forCourse.src === `/media/${uploaded.sha256}/week1.md`);
ok('an item with no media has no src', !('src' in forEveryone));
ok('type-specific fields survive the round trip', forEveryone.body === 'Back in 5');
ok('the group is left empty rather than defaulted, so the client can file it by course',
  forCourse.group === '');

const seenBy = (user) => library.listItems(db, user).map((i) => i.title).sort();
ok(`a course member sees the course's items (${seenBy(ta).join(', ')})`,
  JSON.stringify(seenBy(ta)) === JSON.stringify(['Shared sign', 'Week 1']));
ok(`someone outside the course sees only what is shared with everyone (${seenBy(outsider).join(', ')})`,
  JSON.stringify(seenBy(outsider)) === JSON.stringify(['Shared sign']));
ok('an admin sees everything', JSON.stringify(seenBy(admin)) === JSON.stringify(['Shared sign', 'Week 1']));

ok('a member may fetch the bytes behind an item they can see',
  library.mayReadMedia(db, ta, uploaded.sha256) === true);
ok('and someone outside the course may not, sha-256 in the URL or not',
  library.mayReadMedia(db, outsider, uploaded.sha256) === false);
ok('a hash nobody uploaded is not readable by anyone',
  library.mayReadMedia(db, admin, 'f'.repeat(64)) === false);

let refused = '';
try { library.addItem(db, outsider, { courseCode: 'psy415', kind: 'text', title: 'Sneaking in' }); }
catch (err) { refused = err.message; }
// The same answer a genuinely missing course gives: whether a course exists is
// not something a non-member should be able to probe for.
ok(`someone outside a course cannot file anything into it (${refused})`, /no course with the code/.test(refused));

console.log('\n-- the library: what a caller may not overwrite --');

// props is whatever the caller sent when the item was created. Spread after
// the row it would let a caller rewrite the item's own identity - including
// the two fields permission checks read back.
const spoofed = library.addItem(db, ta, {
  courseCode: 'psy415', kind: 'text', title: 'Real title',
  props: { id: 9999, type: 'web', title: 'Spoofed', course: 'not-a-course', createdBy: admin.id, src: 'https://evil.example' },
});
ok('a prop cannot rewrite the item id', spoofed.id !== 9999);
ok('or its type', spoofed.type === 'text');
ok('or its title', spoofed.title === 'Real title');
ok('or the course that decides who can see it', spoofed.course === 'psy415');
ok('or who uploaded it, which is who may remove it', spoofed.createdBy === ta.id);

// A src prop on an item with no media of its own is not an attack, it is how
// an item that points at an external URL works at all. What must not be
// writable is the URL of an item whose bytes this server is holding.
ok('an item with no media keeps the src it was given, which is how a web link works',
  spoofed.src === 'https://evil.example');
const backed = library.addItem(db, owner, {
  courseCode: '', kind: 'deck', title: 'Real deck', filename: 'real.md', mediaId,
  props: { src: 'https://evil.example/not-the-bytes' },
});
ok('but an item backed by stored bytes always points at those bytes',
  backed.src === `/media/${uploaded.sha256}/real.md`);
// Removed again straight away: it exists only for the assertion above, and
// leaving it pointing at the shared media would change what the usage and
// deletion checks below are measuring.
library.deleteItem(db, owner, backed.id);

console.log('\n-- the library: who may remove --');

ok('the person who uploaded it may', library.mayDelete(db, owner, forCourse) === true);
ok('an admin may', library.mayDelete(db, admin, forCourse) === true);
ok('a course owner may', library.mayDelete(db, { ...owner, isAdmin: false }, forCourse) === true);
// The decision from the interview: a TA can add to the library and present
// from it, but shared materials disappearing by accident is worth making hard.
ok('an ordinary course member may not', library.mayDelete(db, ta, forCourse) === false);
ok('and someone outside the course certainly may not', library.mayDelete(db, outsider, forCourse) === false);

let stopped = '';
try { library.deleteItem(db, ta, forCourse.id); } catch (err) { stopped = err.message; }
ok('trying anyway is refused rather than quietly ignored', /can remove it/.test(stopped));
ok('and the item is still there', library.getItem(db, ta, forCourse.id) !== null);

library.deleteItem(db, owner, forCourse.id);
ok('removing it takes it out of the listing', !seenBy(ta).includes('Week 1'));
ok('and out of reach of anyone asking for it by id', library.getItem(db, ta, forCourse.id) === null);
ok('the bytes stay on disk, because another item may still point at them',
  existsSync(library.mediaPath(dataDir, uploaded.sha256)));
ok('but they stop counting towards what is in use', library.usage(db).files === 0);

console.log('\n-- the library: editing is not the same as seeing --');

const ownerItem = library.addItem(db, owner, {
  courseCode: 'psy415', kind: 'text', title: 'Owner\'s sign', props: { body: 'x' },
});
let notYours = '';
try { library.renameItem(db, ta, ownerItem.id, { title: 'Renamed by a TA' }); }
catch (err) { notYours = err.message; }
ok(`a member who can see an item still cannot rename it (${notYours.slice(0, 32)}…)`, /can change it/.test(notYours));

// The sharper version: re-filing changes who can see a thing, so it needs the
// same standing as removing it.
notYours = '';
try { library.renameItem(db, ta, ownerItem.id, { courseCode: '' }); }
catch (err) { notYours = err.message; }
ok('and certainly cannot move it out of its course, where everyone would see it',
  /can change it/.test(notYours) && library.getItem(db, owner, ownerItem.id).course === 'psy415');

ok('the person who added it can rename it',
  library.renameItem(db, owner, ownerItem.id, { title: 'Renamed' }).title === 'Renamed');

console.log('\n-- the library: bytes nothing points at --');

const orphanBytes = Buffer.from('an upload whose item never happened\n');
const orphan = await library.storeUpload(dataDir, Readable.from([orphanBytes]));
library.rememberMedia(db, owner, { ...orphan, contentType: 'text/markdown' });
ok('an upload with no item is forgotten, file and row together',
  library.forgetMediaIfUnused(db, dataDir, orphan.sha256)
  && !existsSync(library.mediaPath(dataDir, orphan.sha256)));

// Content addressing is what makes that safe - the same bytes may be somebody
// else's file too.
const sharedBytes = await library.storeUpload(dataDir, Readable.from([deck]));
const sharedId = library.rememberMedia(db, owner, { ...sharedBytes, contentType: 'text/markdown' });
library.addItem(db, owner, { courseCode: '', kind: 'deck', title: 'Still referenced', filename: 'a.md', mediaId: sharedId });
ok('but bytes a live item still points at are left exactly where they are',
  library.forgetMediaIfUnused(db, dataDir, sharedBytes.sha256) === false
  && existsSync(library.mediaPath(dataDir, sharedBytes.sha256)));

ok('recording the same bytes twice is one row, even racing',
  library.rememberMedia(db, owner, { ...sharedBytes, contentType: 'text/markdown' }) === sharedId);

console.log('\n-- the library: courses --');

ok('a member is told about their course', library.listCourses(db, ta).map((c) => c.code).join() === 'psy415');
ok('with the role they hold in it', library.listCourses(db, ta)[0].role === 'member');
ok('an owner is told they are one', library.listCourses(db, owner)[0].role === 'owner');
ok('someone in no courses is told about none', library.listCourses(db, outsider).length === 0);
ok('an admin sees every course', library.listCourses(db, admin).map((c) => c.code).join() === 'psy415');

console.log('\n-- plans: a draft is not a publication --');

const plans = require('../server/plans.js');

const draft = plans.savePlan(db, owner, { title: 'Half-written', doc: { v: 1, items: [] } });
const shared = plans.savePlan(db, owner, { title: 'Day 6 running order', courseCode: 'psy415', doc: { v: 1, items: [{ id: 'a' }] } });

// The rule that is the OPPOSITE of the library's, and the reason this section
// exists: there, no course means everyone; here it means nobody but you.
const plansSeenBy = (user) => plans.listPlans(db, user).map((p) => p.title).sort();
ok(`its author sees both (${plansSeenBy(owner).join(', ')})`,
  JSON.stringify(plansSeenBy(owner)) === JSON.stringify(['Day 6 running order', 'Half-written']));
ok(`a course member sees only the one filed under the course (${plansSeenBy(ta).join(', ')})`,
  JSON.stringify(plansSeenBy(ta)) === JSON.stringify(['Day 6 running order']));
ok('someone outside the course sees neither, unlike a library item with no course',
  plansSeenBy(outsider).length === 0);
ok('an admin sees both', plansSeenBy(admin).length === 2);

ok('a listing carries names, not documents', plans.listPlans(db, owner)[0].doc === undefined);
ok('asking for one by id gets the document back whole',
  JSON.stringify(plans.getPlan(db, owner, shared.id).doc) === JSON.stringify({ v: 1, items: [{ id: 'a' }] }));
ok('a plan nobody shared is not reachable by id either', plans.getPlan(db, outsider, draft.id) === null);

// Sharing a plan is sharing it to be read and taught from, not handed over.
let refusedPlan = '';
try { plans.updatePlan(db, ta, shared.id, { title: 'Rewritten by a TA' }); }
catch (err) { refusedPlan = err.message; }
ok(`a course member can open a shared plan but not rewrite it (${refusedPlan.slice(0, 30)}…)`,
  /only the person who wrote this plan/.test(refusedPlan));
ok('not even a course owner, if they did not write it',
  plans.mayWrite(db, { ...owner, id: ta.id, isAdmin: false }, shared) === false);
const revised = plans.updatePlan(db, owner, shared.id, { title: 'Day 6, revised' });
ok('its author can', revised.title === 'Day 6, revised');
ok('and an admin can', plans.mayWrite(db, admin, shared) === true);

// Issue #117: two devices (or two tabs) editing the same plan is not a
// locking error, it is instructors actually doing this - the one that saves
// second must be told, not silently win and erase the first one's changes.
//
// Forced ahead by a raw UPDATE, rather than relying on a second real
// updatePlan() call to land in a later millisecond than revised.updatedAt -
// two Date.now() calls back to back can tie, which would make the "stale"
// case below flaky rather than reliably stale.
const nudgedUpdatedAt = revised.updatedAt + 5000;
db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(nudgedUpdatedAt, shared.id);
ok('a save staged against the current updatedAt goes through',
  plans.updatePlan(db, owner, shared.id, { title: 'Day 6, still current', baseUpdatedAt: nudgedUpdatedAt }).title === 'Day 6, still current');
refusedPlan = '';
try { plans.updatePlan(db, owner, shared.id, { title: 'From a stale tab', baseUpdatedAt: revised.updatedAt }); }
catch (err) { refusedPlan = err.message; }
ok(`a save staged against an updatedAt someone else already moved past is refused, not silently applied (${refusedPlan})`,
  /changed on the server/.test(refusedPlan));
ok('and the conflicting save never actually landed',
  plans.getPlan(db, owner, shared.id).title === 'Day 6, still current');
ok('a save with no base at all (an older client, or a script) is not checked, the same as before this existed',
  plans.updatePlan(db, owner, shared.id, { title: 'Day 6, once more' }).title === 'Day 6, once more');

refusedPlan = '';
try { plans.savePlan(db, outsider, { title: 'Sneaking in', courseCode: 'psy415', doc: {} }); }
catch (err) { refusedPlan = err.message; }
ok('a plan cannot be filed under a course you are not in', /no course with the code/.test(refusedPlan));

refusedPlan = '';
try { plans.savePlan(db, owner, { title: 'Enormous', doc: { blob: 'x'.repeat(plans.MAX_DOC_BYTES) } }); }
catch (err) { refusedPlan = err.message; }
ok('a plan too large to store is refused rather than stored', /too large/.test(refusedPlan));

// The same rail library.js's courseIdFor enforces: filing something new under
// an archived course must be refused outright, not left to succeed into a
// plan that immediately disappears from its own sharing scope (VISIBLE
// already excludes archived courses for a member).
courses.update(db, admin, 'psy415', { archived: true });
refusedPlan = '';
try { plans.savePlan(db, owner, { title: 'Too late', courseCode: 'psy415', doc: {} }); }
catch (err) { refusedPlan = err.message; }
ok('a plan cannot be filed under an archived course either', /archived/.test(refusedPlan));
courses.update(db, admin, 'psy415', { archived: false });

plans.deletePlan(db, owner, draft.id);
ok('removing a plan takes it out of the listing', !plansSeenBy(owner).includes('Half-written'));

console.log('\n-- settings: the key to the projector --');

const settings = require('../server/settings.js');

ok('unknown keys are dropped rather than passed through to a device',
  JSON.stringify(settings.cleanSettings({ room: 'r', passphrase: 'p', evil: 'x' })) === JSON.stringify({ room: 'r', passphrase: 'p' }));
let badTransport = '';
try { settings.cleanSettings({ transport: 'carrier-pigeon' }); } catch (err) { badTransport = err.message; }
ok('and a transport Podium does not speak is refused', /transport must be one of/.test(badTransport));

// Writing a room or a passphrase is an owner's business. A TA who could
// rotate the key could lock the instructor out of their own lecture.
ok('a course owner may write its settings', settings.mayWrite(db, owner, 'psy415') === true);
ok('an ordinary member may not', settings.mayWrite(db, ta, 'psy415') === false);
ok('an admin may', settings.mayWrite(db, admin, 'psy415') === true);

let refusedWrite = '';
try { settings.write(db, ta, 'psy415', { room: 'hijacked' }); } catch (err) { refusedWrite = err.message; }
ok('and trying anyway is refused', /that you can change/.test(refusedWrite));
refusedWrite = '';
try { settings.write(db, outsider, 'psy415', { room: 'hijacked' }); } catch (err) { refusedWrite = err.message; }
ok('an outsider gets the same answer a missing course would give, learning nothing',
  /no course with the code psy415 that you can change/.test(refusedWrite));

settings.write(db, owner, 'psy415', {
  transport: 'ws', room: 'psy415-room', passphrase: 'the room key', wsUrl: 'ws://localhost/podium',
});

// The point of the whole phase: a TA logging in gets a working config, key
// included, because that is what driving the projector requires.
const forTa = settings.forUser(db, ta);
ok(`a member's device is handed the course's settings (${forTa.map((c) => c.course).join(', ')})`,
  forTa.length === 1 && forTa[0].course === 'psy415');
ok('including the passphrase, which is the whole point and the whole trade',
  forTa[0].settings.passphrase === 'the room key');
ok('someone outside the course is handed nothing', settings.forUser(db, outsider).length === 0);
ok('an admin is handed every course that has settings', settings.forUser(db, admin).length === 1);

settings.write(db, owner, 'psy415', { transport: 'ws', room: 'psy415-room', passphrase: 'rotated', wsUrl: 'ws://localhost/podium' });
ok('rotating the passphrase is how you take it back from someone who has left',
  settings.forUser(db, ta)[0].settings.passphrase === 'rotated');

// includeArchived is what lets an admin manage an archived course's settings
// (podium-admin.js's `course settings` CLI command, and admin.html's own
// card) without first reading back nothing and then saving over everything
// that was there - see the comment on forUser for why it defaults off.
courses.update(db, admin, 'psy415', { archived: true });
ok('forUser excludes an archived course by default - the safe answer for courseIdForRoom and an ordinary device',
  !settings.forUser(db, admin).some((c) => c.course === 'psy415'));
const archivedPsy415 = settings.forUser(db, admin, { includeArchived: true }).find((c) => c.course === 'psy415');
ok('but includeArchived finds it with everything still there, not just the field about to be changed',
  archivedPsy415?.settings.room === 'psy415-room' && archivedPsy415.settings.passphrase === 'rotated');
courses.update(db, admin, 'psy415', { archived: false });

console.log('\n-- what happened in the room --');

// The room name is psy415's, which is how a lecture finds its course: the
// display never sends a course code, it sends the room it is in.
// A display that stopped saying it was there: the shape every "abandoned
// lecture" case below actually has in the wild. Go live now RESUMES a lecture
// still inside the idle window rather than replacing it (that is the reload
// case), so a test about sweeping one up has to make it genuinely quiet
// first rather than merely old.
const goQuiet = (id, when) => db.prepare('UPDATE lectures SET last_seen_at = ? WHERE id = ?').run(when, id);

const lecture = lectures.startLecture(db, owner, { room: 'psy415-room' });
ok('starting a lecture files it under the course whose settings name that room',
  lecture.course === 'psy415');
ok('and records who started it', lecture.ownerId === owner.id && !lecture.endedAt);

const elsewhere = lectures.startLecture(db, owner, { room: 'some-other-room' });
ok('a room no course claims produces a lecture with no course at all', elsewhere.course === null);

ok('a member of the course can see it', lectures.listLectures(db, ta).some((l) => l.id === lecture.id));
ok('and cannot see the one held in a room that belongs to nobody',
  !lectures.listLectures(db, ta).some((l) => l.id === elsewhere.id));
ok('somebody outside the course sees neither', lectures.listLectures(db, outsider).length === 0);
ok('an admin sees both', lectures.listLectures(db, admin).length === 2);

// Two courses that end up sharing a room setting - a copy-pasted config, most
// likely - must not have a lecture guess between them. Picking whichever
// sorts first would expose it to the wrong course's members; no course id at
// all is the safe answer, the same one an unclaimed room gives.
courses.create(db, admin, { code: 'ambig-a', title: 'Ambiguous A' });
courses.create(db, admin, { code: 'ambig-b', title: 'Ambiguous B' });
courses.addMember(db, admin, 'ambig-a', { username: owner.username, role: 'owner' });
courses.addMember(db, admin, 'ambig-b', { username: owner.username, role: 'owner' });
settings.write(db, owner, 'ambig-a', { transport: 'ws', room: 'shared-room', passphrase: 'a', wsUrl: 'ws://localhost/podium' });
settings.write(db, owner, 'ambig-b', { transport: 'ws', room: 'shared-room', passphrase: 'b', wsUrl: 'ws://localhost/podium' });
const ambiguous = lectures.startLecture(db, owner, { room: 'shared-room' });
ok('a room two courses both claim resolves to neither, rather than guessing which one', ambiguous.course === null);

const started = Date.now();
lectures.appendEvents(db, owner, lecture.id, [
  { at: started, kind: 'program', title: 'Week 6', detail: { type: 'deck', slide: 1 } },
  { at: started + 60000, kind: 'program', title: 'Week 6', detail: { type: 'deck', slide: 12 } },
]);
const readBack = lectures.getLecture(db, ta, lecture.id);
ok('the timeline reads back in order, to anyone who can see the lecture',
  readBack.timeline.length === 2 && readBack.timeline[0].detail.slide === 1);
ok('and the detail survives the round trip as an object, not a string',
  readBack.timeline[1].detail.slide === 12);

// The display's clock is not the one the timeline is read against.
lectures.appendEvents(db, owner, lecture.id, [
  { at: started + 40 * 24 * 3600 * 1000, kind: 'program', title: 'Tomorrow' },
  { at: 1, kind: 'program', title: 'Long ago' },
]);
const clamped = lectures.getLecture(db, owner, lecture.id).timeline;
ok('an event dated after now is pulled back to now, not stored as the future',
  clamped[3].at <= Date.now() && clamped[3].title === 'Tomorrow');
ok('and one dated before the lecture began is pulled forward to its start',
  clamped.find((e) => e.title === 'Long ago').at === lecture.startedAt);

// A retried flush - the display cannot tell "the request never arrived" from
// "the response got lost" - resends the same batch, id and all. That must
// cost nothing, not a duplicate row.
const retryAt = Date.now();
const first = lectures.appendEvents(db, owner, lecture.id, [
  { id: 'evt-retry-1', at: retryAt, kind: 'program', title: 'Slide the network ate the reply for' },
]);
ok('a freshly filed event is stored', first.stored === 1);
const retried = lectures.appendEvents(db, owner, lecture.id, [
  { id: 'evt-retry-1', at: retryAt, kind: 'program', title: 'Slide the network ate the reply for' },
]);
ok('and resending the exact same batch (a retry) stores nothing the second time', retried.stored === 0);
ok('so the timeline holds one row for it, not two',
  lectures.getLecture(db, owner, lecture.id).timeline.filter((e) => e.title.startsWith('Slide the network ate')).length === 1);

// An id is a courtesy from the display, not a requirement - an older one, or
// any path that does not generate one, must keep working exactly as before.
const noIdBatch = [{ at: Date.now(), kind: 'program', title: 'No client id at all' }];
lectures.appendEvents(db, owner, lecture.id, noIdBatch);
const noIdAgain = lectures.appendEvents(db, owner, lecture.id, noIdBatch);
ok('an event with no id is never deduplicated against another event with no id',
  noIdAgain.stored === 1
  && lectures.getLecture(db, owner, lecture.id).timeline.filter((e) => e.title === 'No client id at all').length === 2);

// Two DIFFERENT lectures reusing the same id (two displays, or the same
// display's counter starting over) must not collide with each other.
// A room of its own, so this does not interact with the room-reuse (stale
// lecture closing) tests further down the file, which use 'some-other-room'.
const otherLecture = lectures.startLecture(db, owner, { room: 'dedup-test-room' });
lectures.appendEvents(db, owner, otherLecture.id, [{ id: 'evt-retry-1', at: Date.now(), kind: 'program', title: 'A different lecture, same id' }]);
ok('the same client id in a different lecture is a different event, not a collision',
  lectures.getLecture(db, owner, otherLecture.id).timeline.some((e) => e.title === 'A different lecture, same id'));

let refusedEvents = '';
try { lectures.appendEvents(db, outsider, lecture.id, [{ kind: 'program', title: 'sneak' }]); }
catch (err) { refusedEvents = err.message; }
ok('someone who cannot see a lecture cannot write to it either, and is told no more than that',
  /no such lecture/.test(refusedEvents));

// A TA's controller ending a poll is the case this permission exists for: the
// display may well be signed in as somebody else entirely.
lectures.recordPoll(db, ta, lecture.id, {
  pollId: 'p1', kind: 'choice', question: 'Which is the confound?',
  options: ['a', 'b'], counts: [3, 9], voters: 12, endedAt: started + 120000,
});
lectures.recordPoll(db, ta, lecture.id, {
  pollId: 'p1', kind: 'choice', question: 'Which is the confound?',
  options: ['a', 'b'], counts: [3, 11], voters: 14, endedAt: started + 121000,
});
const withPoll = lectures.getLecture(db, owner, lecture.id);
ok('a poll a TA ended is filed under the instructor\'s lecture', withPoll.pollResults.length === 1);
ok('and the same poll sent twice updates rather than duplicating',
  withPoll.pollResults[0].voters === 14 && withPoll.pollResults[0].counts[1] === 11);
ok('the tally comes back in the shape the CSV exporter wants',
  withPoll.pollResults[0].options[0] === 'a' && Array.isArray(withPoll.pollResults[0].answers));

// Same voter count, different results - a voter changing their answer
// without changing the total, or two controllers racing to end the same
// poll. >= alone would let whichever lands last win regardless of which is
// actually newer; ended_at is the tiebreaker that decides it instead.
//
// Real Date.now() values throughout, not large synthetic offsets from
// `started`: recordPoll clamps endedAt to [lecture.started_at, now] the same
// way endLecture does, so an offset far enough in the future to distinguish
// "older" from "newer" would collapse to the same clamped value as its
// neighbours instead of preserving the ordering this test depends on.
const tieFirst = Date.now();
lectures.recordPoll(db, ta, lecture.id, {
  pollId: 'p2', kind: 'choice', question: 'Tie test', options: ['a', 'b'], counts: [5, 5], voters: 10, endedAt: tieFirst,
});
lectures.recordPoll(db, ta, lecture.id, {
  // A stale retry: same count, but an OLDER ended_at - must not win.
  pollId: 'p2', kind: 'choice', question: 'Tie test', options: ['a', 'b'], counts: [10, 0], voters: 10, endedAt: tieFirst - 1,
});
ok('a same-count retry with an OLDER ended_at cannot overwrite the tally it is retrying',
  lectures.getLecture(db, owner, lecture.id).pollResults.find((p) => p.pollId === 'p2').counts[0] === 5);
const tieNewer = Date.now();
lectures.recordPoll(db, ta, lecture.id, {
  // Genuinely newer, still tied on count - must win.
  pollId: 'p2', kind: 'choice', question: 'Tie test', options: ['a', 'b'], counts: [4, 6], voters: 10, endedAt: tieNewer,
});
ok('but a same-count result with a NEWER ended_at does overwrite it',
  lectures.getLecture(db, owner, lecture.id).pollResults.find((p) => p.pollId === 'p2').counts[0] === 4);
lectures.recordPoll(db, ta, lecture.id, {
  // A strictly lower count, however new, must still lose - a poll only gains votes.
  pollId: 'p2', kind: 'choice', question: 'Tie test', options: ['a', 'b'], counts: [0, 1], voters: 1, endedAt: Date.now(),
});
ok('and a lower voter count never wins even with the newest ended_at of all',
  lectures.getLecture(db, owner, lecture.id).pollResults.find((p) => p.pollId === 'p2').voters === 10);

// Counts and voters come straight from the request; `Number(n) || 0` alone
// lets a negative one through unchanged (only 0/NaN/'' fall back to 0), which
// would store and later display as a negative tally.
lectures.recordPoll(db, ta, lecture.id, {
  pollId: 'p3', kind: 'choice', question: 'Negative input', options: ['a', 'b'], counts: [-5, 3], voters: -2, endedAt: Date.now(),
});
const negativePoll = lectures.getLecture(db, owner, lecture.id).pollResults.find((p) => p.pollId === 'p3');
ok('a negative vote count is clamped to zero rather than stored as sent',
  negativePoll.counts[0] === 0 && negativePoll.counts[1] === 3);
ok('and a negative voters total is clamped the same way', negativePoll.voters === 0);

let refusedDelete = '';
try { lectures.deleteLecture(db, ta, lecture.id); } catch (err) { refusedDelete = err.message; }
ok('a member who can read a lecture still cannot remove it', /only whoever ran this lecture/.test(refusedDelete));
// A room of its own: `lecture` above is still open in psy415-room, and
// starting a new lecture in a room that already has one open auto-closes the
// old one as stale (see startLecture) - not what this delete-permission
// check is testing.
ok('a course owner can, which is the same rule the library runs on',
  !!lectures.deleteLecture(db, owner, lectures.startLecture(db, owner, { room: 'delete-test-room' }).id));

// Go live, decide the projector is fine, stand down again: no record. Its own
// room, not psy415-room's: that one still has `lecture` open below it, and
// starting a new lecture in a room that already has one auto-closes the old
// one as stale (see startLecture) - exactly what this block is not testing.
const glance = lectures.startLecture(db, owner, { room: 'glance-room' });
const ended = lectures.endLecture(db, owner, glance.id, { at: Date.now() });
ok('a lecture that recorded nothing is discarded rather than kept', ended.discarded === true);
ok('and is really gone', !lectures.getLecture(db, admin, glance.id));

// Not an hour after it started (that would be in the future relative to this
// test run, and endLecture now clamps `at` to the lecture's own lifetime) -
// just a specific timestamp, to prove it is honoured rather than silently
// replaced with "now".
const closeAt = Date.now();
const closed = lectures.endLecture(db, owner, lecture.id, { at: closeAt });
ok('one that recorded something is ended, not discarded', !closed.discarded && closed.endedAt === closeAt);

// A batch delayed past /end, or a controller's poll tally arriving after
// stand-down, has no open lecture left to extend - unlike a file upload,
// which stays available after the fact for the post-class export.
let refusedEventsAfterEnd = '';
try { lectures.appendEvents(db, owner, lecture.id, [{ kind: 'program', title: 'too late' }]); }
catch (err) { refusedEventsAfterEnd = err.message; }
ok('a batch of events delivered after the lecture has ended is refused, not silently reopening the timeline',
  /already ended/.test(refusedEventsAfterEnd));
let refusedPollAfterEnd = '';
try {
  lectures.recordPoll(db, owner, lecture.id, {
    pollId: 'late-poll', kind: 'choice', options: ['a'], counts: [1], voters: 1, endedAt: Date.now(),
  });
} catch (err) { refusedPollAfterEnd = err.message; }
ok('a poll tally delivered after the lecture has ended is refused the same way',
  /already ended/.test(refusedPollAfterEnd));

// Ending is not the same permission as writing to the timeline: appendEvents
// and recordPoll deliberately lean on visibility alone (a TA's controller
// files a poll under the instructor's lecture), but stopping someone else's
// live session is the same act as deleting it and needs the same narrower
// rule, or any course member could end a lecture they did not start.
const forcedStop = lectures.startLecture(db, owner, { room: 'psy415-room' });
lectures.appendEvents(db, owner, forcedStop.id, [{ kind: 'program', title: 'still going' }]);
let refusedEnd = '';
try { lectures.endLecture(db, ta, forcedStop.id); } catch (err) { refusedEnd = err.message; }
ok('a member who can see a live lecture still cannot end it out from under whoever is running it',
  /only whoever ran this lecture/.test(refusedEnd));
ok('and it really is still open', !lectures.getLecture(db, owner, forcedStop.id).endedAt);
lectures.endLecture(db, owner, forcedStop.id, { at: Date.now() });

// A stale /end - a display that never learned a fresher Go live already
// closed this lecture as stale, or one retrying a request it never saw the
// response to - must not re-date an already-ended record.
const reEnded = lectures.endLecture(db, owner, lecture.id, { at: closeAt + 999999 });
ok('ending an already-ended lecture a second time is a no-op, not a later end time',
  reEnded.endedAt === closeAt);

// A caller sending an `at` outside the lecture's own lifetime - a bad clock,
// or a bogus value - must not be able to record it as still open (a falsy
// endedAt from `at: 0`) or as having run into the future.
const clampLecture = lectures.startLecture(db, owner, { room: 'clamp-room' });
lectures.appendEvents(db, owner, clampLecture.id, [{ kind: 'program', title: 'anything, so this is not discarded' }]);
const closedAtZero = lectures.endLecture(db, owner, clampLecture.id, { at: 0 });
ok('ending a lecture with at:0 clamps to when it started, not to "still open"',
  closedAtZero.endedAt === clampLecture.startedAt);
const futureLecture = lectures.startLecture(db, owner, { room: 'clamp-room-2' });
lectures.appendEvents(db, owner, futureLecture.id, [{ kind: 'program', title: 'anything, so this is not discarded' }]);
const beforeFutureClose = Date.now();
const closedInFuture = lectures.endLecture(db, owner, futureLecture.id, { at: Date.now() + 3600000 });
ok('and an at in the future clamps to now, not to a lecture that ran ahead of the clock',
  closedInFuture.endedAt >= beforeFutureClose && closedInFuture.endedAt <= Date.now());

// recordPoll's own endedAt needs the same clamp: startLecture's stale-close
// logic uses the latest poll's ended_at (see the "poll but no timeline
// event" test above), so a future value from a controller with a fast clock
// could make a stale lecture appear to end after it was even asked about.
const clampPollLecture = lectures.startLecture(db, owner, { room: 'clamp-room-3' });
lectures.recordPoll(db, owner, clampPollLecture.id, {
  pollId: 'clamp-poll', kind: 'choice', options: ['a'], counts: [1], voters: 1, endedAt: Date.now() + 3600000,
});
const clampedPoll = lectures.getLecture(db, owner, clampPollLecture.id).pollResults[0];
ok('a poll ended in the future has its own endedAt clamped to now',
  clampedPoll.endedAt <= Date.now());

// The second Go live in the same room, after a display whose tab was closed
// without ever standing down.
const abandoned = lectures.startLecture(db, owner, { room: 'lost-power' });
// Backdated so that "ended at the last thing it recorded" is distinguishable
// from both "ended when it started" and "ended now", which a lecture that ran
// for two milliseconds inside a test would not be.
db.prepare('UPDATE lectures SET started_at = ? WHERE id = ?').run(Date.now() - 3600000, abandoned.id);
const lastSeen = Date.now() - 1800000;
lectures.appendEvents(db, owner, abandoned.id, [{ at: lastSeen, kind: 'program', title: 'Half a lecture' }]);
goQuiet(abandoned.id, lastSeen);
const afterAbandoning = lectures.startLecture(db, owner, { room: 'lost-power' });
ok('going live again in the same room closes the lecture left open',
  lectures.getLecture(db, owner, abandoned.id).endedAt === lastSeen);
ok('at the last thing it recorded, not at now - it did not run until this morning',
  lectures.getLecture(db, owner, abandoned.id).endedAt < afterAbandoning.startedAt - 60000);
ok('and the new one is open', !afterAbandoning.endedAt);

// The case that is NOT an abandoned lecture, and the reason the sweep is
// dated rather than unconditional: a display reloads mid-class. Its state
// survives (see "surviving a reload" in display.js) but its lecture id does
// not, so the teacher presses Go live again to carry on with the same class.
// Replacing the record there splits one lecture's timeline in half.
const reloadRoom = 'reloaded-mid-class';
const beforeReload = lectures.startLecture(db, owner, { room: reloadRoom });
lectures.appendEvents(db, owner, beforeReload.id, [{ kind: 'program', title: 'Before the tab reloaded' }]);
const afterReload = lectures.startLecture(db, owner, { room: reloadRoom });
ok('going live again while the display is still being heard from resumes that lecture',
  afterReload.id === beforeReload.id && afterReload.resumed === true);
ok('and it is still open, with its timeline intact rather than started over',
  !afterReload.endedAt && lectures.getLecture(db, owner, afterReload.id).timeline.length === 1);
lectures.appendEvents(db, owner, afterReload.id, [{ kind: 'program', title: 'And after it' }]);
ok('so both halves of the class are one record',
  lectures.getLecture(db, owner, beforeReload.id).timeline.length === 2);

// Starting black is the way to say "this is a new class, not the same one" -
// the arming screen's own "Clear this room's saved session".
const insisted = lectures.startLecture(db, owner, { room: reloadRoom, resume: false });
ok('but asking for a fresh session opens a new record instead of resuming',
  insisted.id !== beforeReload.id && !insisted.resumed);
ok('and closes the one it replaced', !!lectures.getLecture(db, owner, beforeReload.id).endedAt);

// The heartbeat, and what happens when it stops. This is the answer to every
// way a class ends without anybody saying so: a closed laptop, a crash, a
// machine carried out of the room.
const beating = lectures.startLecture(db, owner, { room: 'still-teaching' });
lectures.appendEvents(db, owner, beating.id, [{ kind: 'program', title: 'A long worked example' }]);
const quiet = lectures.startLecture(db, owner, { room: 'went-home' });
lectures.appendEvents(db, owner, quiet.id, [{ at: Date.now() - 1800000, kind: 'program', title: 'Thursday' }]);
goQuiet(quiet.id, Date.now() - 1800000);
lectures.keepAlive(db, owner, beating.id);
const swept = lectures.closeIdleLectures(db, dataDir);
ok(`the sweep closes a lecture nobody has been heard from in (${swept.closed} closed, ${swept.discarded} discarded)`,
  !!lectures.getLecture(db, owner, quiet.id).endedAt);
ok('and dates it to when the display was last there, not to when the sweep noticed',
  lectures.getLecture(db, owner, quiet.id).endedAt < Date.now() - 1700000);
ok('while one that is still saying "still here" is left alone',
  !lectures.getLecture(db, owner, beating.id).endedAt);

// A quiet lecture that recorded nothing is not worth a row, the same rule
// stand-down and Go live already apply.
const glanceGone = lectures.startLecture(db, owner, { room: 'glance-and-gone' });
goQuiet(glanceGone.id, Date.now() - 3600000);
lectures.closeIdleLectures(db, dataDir);
ok('and one that recorded nothing at all is discarded, not closed',
  lectures.getLecture(db, admin, glanceGone.id) === null);

let refusedBeat = '';
try { lectures.keepAlive(db, owner, quiet.id); } catch (err) { refusedBeat = err.message; }
ok('a heartbeat for a lecture that has already ended is refused rather than reopening it',
  /already ended/.test(refusedBeat));
lectures.endLecture(db, owner, beating.id, { at: Date.now() });

// A stale lecture that ran a poll but never got a timeline event recorded -
// a display left on the arming screen while a controller ran a poll through
// it - still has a real end time: the poll's, not the moment it happened to
// go live. Before this was fixed, the fallback below only ever looked at the
// last EVENT and fell all the way back to started_at, understating how long
// the room was actually in use.
const pollOnly = lectures.startLecture(db, owner, { room: 'poll-only-room' });
db.prepare('UPDATE lectures SET started_at = ? WHERE id = ?').run(Date.now() - 3600000, pollOnly.id);
const pollOnlyEndedAt = Date.now() - 1800000;
lectures.recordPoll(db, owner, pollOnly.id, {
  pollId: 'stale-p1', kind: 'choice', question: 'Any questions?', options: ['a'], counts: [1], voters: 1,
  endedAt: pollOnlyEndedAt,
});
goQuiet(pollOnly.id, pollOnlyEndedAt);
lectures.startLecture(db, owner, { room: 'poll-only-room' });
ok('a stale lecture with a poll but no timeline event closes at the poll\'s end time, not its own start',
  lectures.getLecture(db, owner, pollOnly.id).endedAt === pollOnlyEndedAt);

goQuiet(elsewhere.id, Date.now() - 3600000);
lectures.startLecture(db, owner, { room: 'some-other-room' });
ok('an abandoned lecture that recorded nothing is discarded rather than left as a stub',
  lectures.getLecture(db, owner, elsewhere.id) === null);

// A photo can exist before the first timeline event or poll - fileInk and a
// photo upload both happen independently of appendEvents - so the same
// discard has to release media too, not just leave it orphaned on disk.
const glancedRoom = 'glanced-at-room';
const glanced = lectures.startLecture(db, owner, { room: glancedRoom, dataDir });
const glancedPhoto = await library.storeUpload(dataDir, Readable.from([Buffer.from('checked the projector works')]));
lectures.addFile(db, owner, glanced.id, {
  name: 'photos/01-check.jpg', kind: 'photo',
  sha256: glancedPhoto.sha256, bytes: glancedPhoto.bytes, contentType: 'image/jpeg', dataDir,
});
ok('the file is there before anything discards the lecture', existsSync(library.mediaPath(dataDir, glancedPhoto.sha256)));
// Going live again in the same room is the abandoned-lecture path; standing
// down normally with nothing recorded (endLecture) is the other one.
goQuiet(glanced.id, Date.now() - 3600000);
lectures.startLecture(db, owner, { room: glancedRoom, dataDir });
ok('a lecture discarded for recording nothing does not leak the bytes its files pointed at',
  !existsSync(library.mediaPath(dataDir, glancedPhoto.sha256)));

const glancedAgain = lectures.startLecture(db, owner, { room: glancedRoom, dataDir });
const glancedPhoto2 = await library.storeUpload(dataDir, Readable.from([Buffer.from('checked it again')]));
lectures.addFile(db, owner, glancedAgain.id, {
  name: 'photos/01-check.jpg', kind: 'photo',
  sha256: glancedPhoto2.sha256, bytes: glancedPhoto2.bytes, contentType: 'image/jpeg', dataDir,
});
lectures.endLecture(db, owner, glancedAgain.id, { dataDir });
ok('and standing down with nothing recorded releases the same way',
  !existsSync(library.mediaPath(dataDir, glancedPhoto2.sha256)));

// The cap exists so that one wedged display cannot fill the disk.
const flood = lectures.startLecture(db, owner, { room: 'psy415-room' });
let kept = 0;
for (let i = 0; i < Math.ceil((lectures.MAX_EVENTS + 200) / lectures.MAX_EVENTS_PER_POST); i++) {
  kept += lectures.appendEvents(db, owner, flood.id, Array.from(
    { length: lectures.MAX_EVENTS_PER_POST }, (_, n) => ({ kind: 'program', title: `item ${i}-${n}` }),
  )).stored;
}
ok(`the timeline stops at the cap (${kept} stored)`, kept === lectures.MAX_EVENTS);
ok('and says so, so a record that stops halfway is not read as a lecture that ended there',
  lectures.getLecture(db, owner, flood.id).truncated === true);
lectures.deleteLecture(db, owner, flood.id);
ok('removing a lecture takes its timeline with it',
  db.prepare('SELECT COUNT(*) AS n FROM lecture_events WHERE lecture_id = ?').get(flood.id).n === 0);

console.log('\n-- what a session keeps: photos, ink, exported pages --');

const session4b = lectures.startLecture(db, owner, { room: 'psy415-room' });
const photoBytes = Buffer.from('not really a jpeg, but bytes are bytes');
const photo = await library.storeUpload(dataDir, Readable.from([photoBytes]));

ok('an unknown extension is refused before a byte is read', lectures.keepableType('lecture.html') === null);
ok('and .svg with it, for the same reason the library refuses it', lectures.keepableType('board.svg') === null);
ok('a png is taken, with the type coming from the name rather than the caller',
  lectures.keepableType('slides/day-6/slide-01.PNG') === 'image/png');

lectures.addFile(db, owner, session4b.id, {
  name: 'photos/01-a worksheet.jpg', kind: 'photo',
  sha256: photo.sha256, bytes: photo.bytes, contentType: 'image/jpeg', dataDir,
});
const withFile = lectures.getLecture(db, owner, session4b.id);
ok(`the file comes back with the lecture (${withFile.files[0]?.name})`,
  withFile.files.length === 1 && withFile.files[0].kind === 'photo');
ok('under a content-addressed url, the same shape the library uses',
  withFile.files[0].url === `/media/${photo.sha256}/01-a%20worksheet.jpg`);

// The name is the path inside the zip and the only thing a caller picks, so it
// is cleaned rather than trusted.
const climbed = await library.storeUpload(dataDir, Readable.from([Buffer.from('another file')]));
const named = lectures.addFile(db, owner, session4b.id, {
  name: '../../etc/photos/../sneaky.png', kind: 'photo',
  sha256: climbed.sha256, bytes: climbed.bytes, contentType: 'image/png', dataDir,
});
ok(`a name that tries to climb out of the zip is cleaned, not obeyed (${named.name})`,
  !named.name.includes('..') && named.name.endsWith('sneaky.png'));

// A TA's controller files a photo under the instructor's lecture: the same
// permission the poll route runs on.
ok('a member of the course can file a photo too',
  !!lectures.addFile(db, ta, session4b.id, {
    name: 'photos/02-the board.jpg', kind: 'photo',
    sha256: photo.sha256, bytes: photo.bytes, contentType: 'image/jpeg', dataDir,
  }));
let refusedFile = '';
try {
  lectures.addFile(db, outsider, session4b.id, {
    name: 'photos/03-nope.jpg', kind: 'photo',
    sha256: photo.sha256, bytes: photo.bytes, contentType: 'image/jpeg', dataDir,
  });
} catch (err) { refusedFile = err.message; }
ok('an outsider cannot, and learns nothing about whether the lecture exists',
  /no such lecture/.test(refusedFile));

// The same photo filed twice is one set of bytes: media is shared with the
// library, which is exactly why forgetMediaIfUnused had to learn about this.
ok('the same bytes filed twice are stored once',
  db.prepare('SELECT COUNT(*) AS n FROM media WHERE sha256 = ?').get(photo.sha256).n === 1);

ok('anyone who can see the lecture can fetch its files', library.mayReadMedia(db, ta, photo.sha256));
ok('and someone who cannot, cannot', !library.mayReadMedia(db, outsider, photo.sha256));

// A rejected upload - over the space cap here - must not leave its bytes
// orphaned: storeUpload has already written them by the time addFile's own
// caps can refuse, and the caller (receiveLectureFile in api.js) cleans up
// with forgetMediaIfUnused, which can only find bytes that already have a
// media row. addFile registers that row before checking the caps for exactly
// this reason.
const tooBigUpload = await library.storeUpload(dataDir, Readable.from([Buffer.from('a file that claims to be enormous')]));
let refusedForSpace = '';
try {
  lectures.addFile(db, owner, session4b.id, {
    name: 'photos/too-big.jpg', kind: 'photo',
    sha256: tooBigUpload.sha256, bytes: lectures.MAX_LECTURE_BYTES + 1, contentType: 'image/jpeg', dataDir,
  });
} catch (err) { refusedForSpace = err.message; }
ok('a file that would bust the space cap is refused', /space one session may use/.test(refusedForSpace));
ok('but its media row already exists, so the cleanup path that follows can actually find it',
  !!db.prepare('SELECT 1 AS ok FROM media WHERE sha256 = ?').get(tooBigUpload.sha256));
ok('and forgetMediaIfUnused does remove it - nothing else points at these bytes',
  library.forgetMediaIfUnused(db, dataDir, tooBigUpload.sha256) && !existsSync(library.mediaPath(dataDir, tooBigUpload.sha256)));

// Re-exporting replaces rather than accumulating, and frees what it replaced.
const redone = await library.storeUpload(dataDir, Readable.from([Buffer.from('a better rasterization')]));
lectures.addFile(db, owner, session4b.id, {
  name: 'photos/01-a worksheet.jpg', kind: 'photo',
  sha256: redone.sha256, bytes: redone.bytes, contentType: 'image/jpeg', dataDir,
});
ok('exporting again replaces a file rather than adding a second of it',
  lectures.getLecture(db, owner, session4b.id).files.filter((f) => f.name === 'photos/01-a worksheet.jpg').length === 1);
ok('and the bytes it replaced are still there, because another file still points at them',
  existsSync(library.mediaPath(dataDir, photo.sha256)));

// A library item sharing a photo's bytes: removing the lecture must not take
// the library's copy with it, and vice versa.
const sharedItem = library.addItem(db, owner, {
  kind: 'image', title: 'The same worksheet', filename: 'worksheet.jpg',
  mediaId: library.rememberMedia(db, owner, { sha256: redone.sha256, bytes: redone.bytes, contentType: 'image/jpeg' }),
});
lectures.deleteLecture(db, owner, session4b.id, { dataDir });
ok('removing a lecture takes its files with it',
  db.prepare('SELECT COUNT(*) AS n FROM lecture_files').get().n === 0);
ok('but not bytes the library is still using',
  existsSync(library.mediaPath(dataDir, redone.sha256)) && !!library.getItem(db, owner, sharedItem.id));
ok('while bytes nothing points at any more do go',
  !existsSync(library.mediaPath(dataDir, photo.sha256)));

console.log('\n-- the retention control --');

const longAgo = lectures.startLecture(db, owner, { room: 'psy415-room' });
db.prepare('UPDATE lectures SET started_at = ? WHERE id = ?')
  .run(Date.now() - 200 * 24 * 3600 * 1000, longAgo.id);
lectures.appendEvents(db, owner, longAgo.id, [{ kind: 'program', title: 'Week 2, two terms ago' }]);
const aged = await library.storeUpload(dataDir, Readable.from([Buffer.from('a photo from last year')]));
lectures.addFile(db, owner, longAgo.id, {
  name: 'photos/01-last year.jpg', kind: 'photo',
  sha256: aged.sha256, bytes: aged.bytes, contentType: 'image/jpeg', dataDir,
});

const recent = lectures.startLecture(db, owner, { room: 'some-other-room' });
const fresh = await library.storeUpload(dataDir, Readable.from([Buffer.from('a photo from this week')]));
lectures.addFile(db, owner, recent.id, {
  name: 'photos/01-this week.jpg', kind: 'photo',
  sha256: fresh.sha256, bytes: fresh.bytes, contentType: 'image/jpeg', dataDir,
});

ok('no retention set means nothing is ever removed', lectures.pruneFiles(db, dataDir, { days: 0 }).removed === 0);

const pruned = lectures.pruneFiles(db, dataDir, { days: 90 });
ok(`pruning drops the files of lectures past the cut-off (${pruned.removed} file, ${pruned.bytes} bytes)`,
  pruned.removed === 1 && pruned.bytes === aged.bytes);
ok('and the bytes really leave the disk', !existsSync(library.mediaPath(dataDir, aged.sha256)));
ok('a recent lecture keeps its photos', existsSync(library.mediaPath(dataDir, fresh.sha256)));

// The whole point of the asymmetry: the bulk ages out, the record does not.
const survivor = lectures.getLecture(db, owner, longAgo.id);
ok('the pruned lecture is still there, with its timeline intact',
  !!survivor && survivor.timeline.length === 1 && survivor.files.length === 0);

ok('usage counts what the sessions are actually costing',
  lectures.usage(db).files === 1 && lectures.usage(db).bytes === fresh.bytes);

// GET /api/lectures bolts usage onto a response whose lecture LIST is already
// scoped to what the caller may see - the figure has to match, or a course
// member learns the size of every private session on the box. Passing a user
// scopes it the same way; omitting one (as the admin-only Storage route and
// the CLI do) still gets the real total.
ok("a non-admin's own usage matches the global total when every file is theirs",
  lectures.usage(db, owner).files === 1 && lectures.usage(db, owner).bytes === fresh.bytes);
ok('but someone who cannot see that lecture at all sees none of its usage',
  lectures.usage(db, ta).files === 0 && lectures.usage(db, ta).bytes === 0);
ok('an admin passed explicitly still gets the real total, not a scoped one',
  lectures.usage(db, admin).files === 1);

// The store is content-addressed: the same bytes can be filed under a second
// name in the same lecture (a photo re-uploaded, say). Counted by
// lecture_files row rather than by the distinct media row underneath, a
// member's own usage would show those bytes twice - inflated past what is
// actually on disk, and out of step with the admin-only global total right
// above, which already counts by media row.
lectures.addFile(db, owner, recent.id, {
  name: 'photos/02-this week again.jpg', kind: 'photo',
  sha256: fresh.sha256, bytes: fresh.bytes, contentType: 'image/jpeg', dataDir,
});
ok("a non-admin's usage counts shared bytes once, not once per file that points at them",
  lectures.usage(db, owner).files === 1 && lectures.usage(db, owner).bytes === fresh.bytes);
// Cleaned back up so the removeFile tests just below see the single file
// they expect, rather than the second name added only to prove the count above.
lectures.removeFile(db, owner, recent.id, 'photos/02-this week again.jpg', { dataDir });

// removeFile is the other half of addFile's upsert: a name a later export no
// longer produces AT ALL (a photo the keep-switch has since turned off, one
// aged out of history) rather than one it is replacing by landing on the
// same name.
const removedFile = lectures.removeFile(db, owner, recent.id, 'photos/01-this week.jpg', { dataDir });
ok('removeFile takes the named file out of the lecture',
  removedFile.removed === true && lectures.getLecture(db, owner, recent.id).files.length === 0);
ok('and frees the bytes nothing else points at', !existsSync(library.mediaPath(dataDir, fresh.sha256)));
ok('removing a name that was never there is a harmless no-op',
  lectures.removeFile(db, owner, recent.id, 'photos/never-existed.jpg', { dataDir }).removed === false);

console.log('\n-- running the place: accounts and courses --');

// The rail that matters most: an instance with no enabled administrator cannot
// be administered from a browser at all. Earlier sections left more than one
// admin behind, so this starts by getting down to the case being tested.
for (const person of accounts.listUsers(db)) {
  if (person.isAdmin && person.username !== 'root') accounts.setAdmin(db, person.username, false);
}
ok('there is one administrator to lose', accounts.countEnabledAdmins(db) === 1);
let stranded = '';
try { accounts.assertAnotherAdminRemains(db, 'root', 'disabling it'); } catch (err) { stranded = err.message; }
ok(`disabling the only administrator is refused from the browser path (${stranded.slice(0, 48)}…)`,
  /only administrator who can sign in/.test(stranded));
ok('but the CLI path is not held to it - a shell is the credential, and "that account is compromised" must work',
  (() => { accounts.setDisabled(db, 'root', true); const off = accounts.countEnabledAdmins(db) === 0;
    accounts.setDisabled(db, 'root', false); return off; })());

const sidekick = await accounts.createUser(db, { username: 'sam', password: 'sams password here' });
accounts.setAdmin(db, 'sam', true);
ok('with a second administrator the rail lets go', (() => {
  try { accounts.assertAnotherAdminRemains(db, 'root', 'disabling it'); return true; } catch { return false; }
})());
accounts.setAdmin(db, 'sam', false);
ok('and comes back when the second one is demoted', (() => {
  try { accounts.assertAnotherAdminRemains(db, 'root', 'disabling it'); return false; } catch { return true; }
})());

ok('an account listing says when each was last seen and how many sessions it holds',
  accounts.listUsers(db).every((row) => 'lastSeen' in row && 'activeSessions' in row));
ok('and never carries a password hash anywhere near the browser',
  !JSON.stringify(accounts.listUsers(db)).includes('scrypt$'));

// Courses: made by admins, run by owners.
const made = courses.create(db, admin, { code: 'PSY101', title: 'PSY 101' });
ok(`a course code is folded to lower case, because it is typed into a filter box (${made.code})`,
  made.code === 'psy101');
let refusedCourse = '';
try { courses.create(db, ta, { code: 'sneaky' }); } catch (err) { refusedCourse = err.message; }
ok('a member cannot invent a course to file things under', /only an administrator/.test(refusedCourse));
refusedCourse = '';
try { courses.create(db, admin, { code: 'not a code' }); } catch (err) { refusedCourse = err.message; }
ok('nor can an administrator invent one that cannot be typed', /course code is 1-64/.test(refusedCourse));
refusedCourse = '';
try { courses.create(db, admin, { code: 'psy101' }); } catch (err) { refusedCourse = err.message; }
ok('and the same code twice is refused rather than silently merged', /already a course/.test(refusedCourse));

courses.addMember(db, admin, 'psy101', { username: 'sam', role: 'owner' });
courses.addMember(db, admin, 'psy101', { username: 'ta' });
const sam = accounts.publicUser(accounts.findUser(db, 'sam'));
ok('an owner sees who else is in their course', (courses.list(db, sam).find((c) => c.code === 'psy101')?.people || []).length === 2);
ok('a plain member is not handed the membership list',
  courses.list(db, ta).find((c) => c.code === 'psy101')?.people === undefined);

let refusedMember = '';
try { courses.addMember(db, ta, 'psy101', { username: 'outsider' }); } catch (err) { refusedMember = err.message; }
ok('and cannot add anybody', /that you can change/.test(refusedMember));
refusedMember = '';
try { courses.removeMember(db, sam, 'psy101', 'sam'); } catch (err) { refusedMember = err.message; }
ok('an owner cannot remove the last owner and leave a course nobody runs',
  /only owner of psy101/.test(refusedMember));

// "Make a member" on your own row is a demotion by another name - the page
// offers it as exactly that - so it has to be caught by the same rail
// removeMember enforces, not just the Remove button.
let refusedDemote = '';
try { courses.addMember(db, sam, 'psy101', { username: 'sam', role: 'member' }); } catch (err) { refusedDemote = err.message; }
ok('and the same rail catches demoting the last owner via "Make a member", not just Remove',
  /only owner of psy101/.test(refusedDemote));
ok('sam is still an owner after the refused attempt',
  courses.list(db, sam).find((c) => c.code === 'psy101')?.role === 'owner');

ok('but can remove a member', courses.removeMember(db, sam, 'psy101', 'ta').length === 1);

// Archiving is as close to deleting as Podium gets, and deliberately keeps
// everything filed under the course.
courses.addMember(db, admin, 'psy101', { username: 'ta' });

// One of each kind of thing a course can hold, so archiving is checked against
// all three access paths Copilot found only some of - not just membership.
const archLibItem = library.addItem(db, sam, { kind: 'text', title: 'Syllabus', courseCode: 'psy101', props: {} });
const archPlan = plans.savePlan(db, sam, { title: 'Week 1', courseCode: 'psy101', doc: '{}' });
const psy101Id = db.prepare('SELECT id FROM courses WHERE code = ?').get('psy101').id;
db.prepare('INSERT INTO lectures (course_id, room, title, started_by, started_at) VALUES (?, ?, ?, ?, ?)')
  .run(psy101Id, 'psy101-room', 'Week 1 lecture', sam.id, Date.now());
const archLecture = db.prepare('SELECT id FROM lectures WHERE room = ?').get('psy101-room');

courses.update(db, admin, 'psy101', { archived: true });
ok('an archived course is still listed to an administrator, who is the one who can bring it back',
  courses.list(db, admin).find((c) => c.code === 'psy101')?.archived === true);
ok('and is not listed to its members any more', !courses.list(db, ta).some((c) => c.code === 'psy101'));
ok('nothing filed under it is touched',
  db.prepare('SELECT COUNT(*) AS n FROM course_members WHERE course_id = (SELECT id FROM courses WHERE code = ?)')
    .get('psy101').n === 2);

// The three access paths archiving is supposed to close for a plain member -
// ta is a member of psy101 throughout, never the item's owner, so this is
// purely the membership branch of each VISIBLE.
ok('a library item filed under an archived course stops being listed to a member',
  !library.listItems(db, ta).some((it) => it.id === archLibItem.id));
ok('and a plan filed under it does the same',
  !plans.listPlans(db, ta).some((pl) => pl.id === archPlan.id));
ok('and so does a lecture held in it',
  !lectures.listLectures(db, ta).some((l) => l.id === archLecture.id));
ok('an administrator still sees all three', library.listItems(db, admin).some((it) => it.id === archLibItem.id)
  && plans.listPlans(db, admin).some((pl) => pl.id === archPlan.id)
  && lectures.listLectures(db, admin).some((l) => l.id === archLecture.id));
ok('the plan is still there for its own author, the same as leaving the course would leave it',
  plans.listPlans(db, sam).some((pl) => pl.id === archPlan.id));

courses.update(db, admin, 'psy101', { archived: false });
ok('bringing it back is the same gesture in reverse', courses.list(db, ta).some((c) => c.code === 'psy101'));
ok('and all three are visible to the member again',
  library.listItems(db, ta).some((it) => it.id === archLibItem.id)
  && plans.listPlans(db, ta).some((pl) => pl.id === archPlan.id)
  && lectures.listLectures(db, ta).some((l) => l.id === archLecture.id));

// mayReadMedia's lecture-media branch is hand-duplicated SQL (see the comment
// there), not a reuse of lectures.js's VISIBLE - so it gets its own check
// rather than trusting that the two stayed in sync.
const archUpload = await library.storeUpload(dataDir, Readable.from([Buffer.from('a slide from an archived course')]));
lectures.addFile(db, sam, archLecture.id, {
  name: 'photos/01-slide.jpg', kind: 'photo',
  sha256: archUpload.sha256, bytes: archUpload.bytes, contentType: 'image/jpeg', dataDir,
});
ok('a member can read a session file from that lecture while the course is active',
  library.mayReadMedia(db, ta, archUpload.sha256));
courses.update(db, admin, 'psy101', { archived: true });
ok('but not once the course is archived',
  !library.mayReadMedia(db, ta, archUpload.sha256));
ok('an administrator still can', library.mayReadMedia(db, admin, archUpload.sha256));

// Reading is one thing; filing something NEW under an archived course while
// it is archived is worse than a write that silently vanishes - VISIBLE
// already refuses to list it back, so the write has to be refused outright
// instead of succeeding into a row nothing can ever read.
let refusedArchivedWrite = '';
try { library.addItem(db, sam, { kind: 'text', title: 'Too late', courseCode: 'psy101', props: {} }); }
catch (err) { refusedArchivedWrite = err.message; }
ok('filing something new under an archived course is refused, not silently unreadable',
  /archived/.test(refusedArchivedWrite));
let refusedArchivedWriteAdmin = '';
try { library.addItem(db, admin, { kind: 'text', title: 'Too late', courseCode: 'psy101', props: {} }); }
catch (err) { refusedArchivedWriteAdmin = err.message; }
ok('even an administrator cannot file something new under an archived course',
  /archived/.test(refusedArchivedWriteAdmin));

courses.update(db, admin, 'psy101', { archived: false });
ok('and the member again once it is brought back', library.mayReadMedia(db, ta, archUpload.sha256));

console.log('\n-- the doctor --');

const seen = (found, title) => found.find((item) => item.title === title);

ok('a healthy database passes its own checks',
  doctor.checkSchema(db).level === 'ok' && doctor.checkIntegrity(db).level === 'ok');
ok('and a data directory nobody else can read passes too',
  doctor.checkPermissions(dataDir).level === 'ok');

// The two failures this command exists to catch on a real box.
const looseDir = path.join(root, 'loose');
mkdirSync(looseDir, { recursive: true, mode: 0o755 });
chmodSync(looseDir, 0o755);
ok(`a world-readable data directory is called out (${doctor.checkPermissions(looseDir).detail})`,
  doctor.checkPermissions(looseDir).level === 'bad');

ok('an instance with an administrator who can sign in is fine',
  doctor.checkAccounts(db).level === 'ok');
const admins = accounts.listUsers(db).filter((row) => row.isAdmin && !row.disabled);
for (const person of admins) accounts.setDisabled(db, person.username, true);
ok('one with none is not, because nobody can manage it from a browser',
  doctor.checkAccounts(db).level === 'bad');
for (const person of admins) accounts.setDisabled(db, person.username, false);

// Accounts take precedence over AUTH_PASSWORD when there are any (see
// podium-server.js), but with zero accounts at all AUTH_PASSWORD is exactly
// the supported fallback the pages use instead - not the wide-open case this
// check exists to catch. That needs a database with no accounts whatsoever,
// not merely disabled ones (which is the case just above, and correctly
// stays 'bad' even with a password set, since disabled admins still can't
// sign in).
const noAccountsDir = mkdtempSync(path.join(tmpdir(), 'podium-doctor-noaccounts-'));
const noAccountsDb = store.open(noAccountsDir);
ok('with zero accounts and no password, still the wide-open case',
  doctor.checkAccounts(noAccountsDb).level === 'bad');
ok('but a configured shared password makes the same instance a healthy one',
  doctor.checkAccounts(noAccountsDb, { AUTH_PASSWORD: 'shared secret' }).level === 'ok');
noAccountsDb.close();
rmSync(noAccountsDir, { recursive: true, force: true });

// Bytes on disk with nothing pointing at them: harmless, and the shape a
// hand-edited data directory leaves.
const strayShard = path.join(dataDir, 'media', 'zz');
mkdirSync(strayShard, { recursive: true });
writeFileSync(path.join(strayShard, 'z'.repeat(64)), 'not known to the database');
ok(`an unreferenced file on disk is a warning, not a failure (${doctor.checkMedia(db, dataDir).detail})`,
  doctor.checkMedia(db, dataDir).level === 'warn');

// A row pointing at bytes that are not there is the other way round, and is
// the one that means something went missing.
const ghost = createHash('sha256').update('a file that was deleted by hand').digest('hex');
db.prepare('INSERT INTO media (sha256, bytes, content_type, created_at) VALUES (?, ?, ?, ?)')
  .run(ghost, 10, 'image/png', Date.now());
ok('a stored file missing from disk is a failure',
  doctor.checkMedia(db, dataDir).level === 'bad');
db.prepare('DELETE FROM media WHERE sha256 = ?').run(ghost);

// A directory sitting where a file should be: fs.existsSync alone would call
// this "present", but nothing can ever read image bytes out of a directory,
// so this is exactly the missing-from-disk failure above, not a pass.
const dirGhost = createHash('sha256').update('a path that is a directory, not a file').digest('hex');
const dirGhostPath = library.mediaPath(dataDir, dirGhost);
mkdirSync(dirGhostPath, { recursive: true });
db.prepare('INSERT INTO media (sha256, bytes, content_type, created_at) VALUES (?, ?, ?, ?)')
  .run(dirGhost, 10, 'image/png', Date.now());
ok('a directory standing in for a stored file is treated as missing, not present',
  doctor.checkMedia(db, dataDir).level === 'bad');
db.prepare('DELETE FROM media WHERE sha256 = ?').run(dirGhost);
rmSync(dirGhostPath, { recursive: true, force: true });

// A media row neither the library nor a lecture points at: forgetMediaIfUnused
// checks exactly those two tables to decide "nothing wants this any more", so
// a row that never got as far as either one - a crash between rememberMedia
// and the row that would reference it - is invisible to it, and to the
// missing-from-disk check above too, since the bytes genuinely are there.
const orphanSha = createHash('sha256').update('bytes nobody ever filed anywhere').digest('hex');
const orphanShard = path.join(dataDir, 'media', orphanSha.slice(0, 2));
mkdirSync(orphanShard, { recursive: true });
writeFileSync(path.join(orphanShard, orphanSha), 'orphaned bytes');
db.prepare('INSERT INTO media (sha256, bytes, content_type, created_at) VALUES (?, ?, ?, ?)')
  .run(orphanSha, 14, 'text/plain', Date.now());
ok('a media row neither the library nor a lecture points at is flagged too',
  /database row\(s\)/.test(doctor.checkMedia(db, dataDir).detail) && doctor.checkMedia(db, dataDir).level === 'warn');
db.prepare('DELETE FROM media WHERE sha256 = ?').run(orphanSha);

const report = await doctor.run({
  db, dataDir, releaseDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  healthUrl: '', certPath: '',
});
ok(`the whole run answers every check (${report.map((item) => item.title).join(', ')})`,
  ['node', 'schema', 'database', 'accounts', 'media', 'storage', 'permissions', 'disk', 'build', 'certificate', 'service']
    .every((title) => !!seen(report, title)));
ok('and reads the build out of the release it is part of',
  /build \d+/.test(seen(report, 'build').detail));
// The question somebody actually opens this report to answer. A build number
// on its own does not answer "what are you running" in words anybody says out
// loud, and with the VPS deployment there is now a box to ask it about.
ok(`and names the release, not just the build (${seen(report, 'build').detail})`,
  /Podium \d+\.\d+/.test(seen(report, 'build').detail));

const lines = [];
const code = doctor.report(report, (line) => lines.push(line));
ok('a run with nothing broken exits 0 even when it has warnings',
  code === (report.some((item) => item.level === 'bad') ? 1 : 0));
ok('and every finding gets a line somebody can read', lines.length >= report.length);

// A database that will not open at all - the recovery scenario doctor exists
// for - has to be a finding, not a crash that pre-empts every other check.
const openError = new Error('this database is at schema version 999 but this release only knows 5');
const brokenReport = await doctor.run({
  db: null, openError, dataDir,
  releaseDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  healthUrl: '', certPath: '',
});
ok(`an unopenable database is reported, not thrown (${seen(brokenReport, 'database').detail.slice(0, 40)}…)`,
  seen(brokenReport, 'database').level === 'bad' && /schema version 999/.test(seen(brokenReport, 'database').detail));
ok('and the checks that do not need the database still run',
  seen(brokenReport, 'node') && seen(brokenReport, 'permissions') && seen(brokenReport, 'disk'));

// checkStorage reads whatever env object it is handed - the CLI's job (see
// envFile() in podium-admin.js) is making sure that object actually has
// LECTURE_RETENTION_DAYS on it even when the shell running `doctor` never
// sourced podium.env itself.
ok('with no retention configured, storage says everything is kept',
  /everything kept/.test(doctor.checkStorage(db, {}).detail));
ok('and with it set, storage says for how long',
  /kept 180 days/.test(doctor.checkStorage(db, { LECTURE_RETENTION_DAYS: '180' }).detail));
// pruneFiles (lectures.js) treats anything <= 0 as no retention at all - so
// doctor has to agree, rather than reading a negative value as truthy and
// reporting "kept -1 days" as a clean bill of health.
ok('a negative retention value is treated the same as none set, not reported as valid',
  /everything kept/.test(doctor.checkStorage(db, { LECTURE_RETENTION_DAYS: '-1' }).detail));

// checkBackup (Issue #114): a box can look completely healthy right up until
// the disk it is on is gone, if nobody ever wired up the nightly job. Only
// the filename's own timestamp is trusted for age - never mtime, which a
// restore or `cp -p` can carry over from the original.
console.log('\n-- doctor: has a backup ever actually run --');
const missingBackupDir = path.join(root, 'no-such-backup-dir');
ok('a BACKUP_DIR that does not exist yet is a warning, not a crash',
  doctor.checkBackup({ BACKUP_DIR: missingBackupDir }).level === 'warn'
  && /no backup has ever run/.test(doctor.checkBackup({ BACKUP_DIR: missingBackupDir }).detail));

const backupDir = mkdtempSync(path.join(tmpdir(), 'podium-backup-'));
ok('an existing but empty backup directory is the same warning',
  doctor.checkBackup({ BACKUP_DIR: backupDir }).level === 'warn'
  && /no backup has ever run/.test(doctor.checkBackup({ BACKUP_DIR: backupDir }).detail));

const stampFor = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
writeFileSync(path.join(backupDir, `podium-${stampFor(new Date())}.tar.gz`), 'x');
ok('a fresh archive from just now is a clean bill of health',
  doctor.checkBackup({ BACKUP_DIR: backupDir }).level === 'ok');

const staleDir = mkdtempSync(path.join(tmpdir(), 'podium-backup-stale-'));
const staleWhen = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
writeFileSync(path.join(staleDir, `podium-${stampFor(staleWhen)}.tar.gz`), 'x');
ok(`an archive whose own name says it is days old is flagged, not silently accepted (${doctor.checkBackup({ BACKUP_DIR: staleDir }).detail})`,
  doctor.checkBackup({ BACKUP_DIR: staleDir }).level === 'warn' && /day\(s\) old/.test(doctor.checkBackup({ BACKUP_DIR: staleDir }).detail));

writeFileSync(path.join(staleDir, `podium-${stampFor(new Date())}.tar.gz`), 'x');
ok('a newer archive landing later brings it back to ok, without needing the stale one removed',
  doctor.checkBackup({ BACKUP_DIR: staleDir }).level === 'ok');

rmSync(backupDir, { recursive: true, force: true });
rmSync(staleDir, { recursive: true, force: true });

console.log('\n-- doctor, from the command line --');

// The CLI itself: does `podium-admin.js doctor` actually load podium.env for
// the retention line, and does it survive a database it cannot open. Spawned
// rather than called in-process because both of these are about main()'s own
// wiring (envFile(), the try/catch around store.open()), not about doctor.js.
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');
const envFile = path.join(root, 'podium-cli.env');
// No PORT here on purpose: setting one makes doctor try to reach a real
// service at that port for the build/health checks, which nothing is
// listening on in this test and would turn this into a check of the
// network rather than of the env-file loading this is actually testing.
writeFileSync(envFile, `LECTURE_RETENTION_DAYS=42\n`);
const cliOut = execFileSync(process.execPath, ['podium-admin.js', 'doctor'], {
  cwd: cliRoot, env: { ...process.env, DATA_DIR: dataDir, PODIUM_ENV: envFile },
}).toString();
ok(`the CLI reads the retention setting out of podium.env (storage line: "${cliOut.match(/storage.*/)?.[0]}")`,
  /kept 42 days/.test(cliOut));

const crashDir = mkdtempSync(path.join(tmpdir(), 'podium-doctor-crash-'));
{
  const crashDb = store.open(crashDir);
  crashDb.exec('PRAGMA user_version = 999');
  crashDb.close();
}
let crashOut = '';
let crashStatus = 0;
try {
  execFileSync(process.execPath, ['podium-admin.js', 'doctor'], {
    cwd: cliRoot, env: { ...process.env, DATA_DIR: crashDir },
  });
} catch (err) {
  crashOut = String(err.stdout || '');
  crashStatus = err.status;
}
ok('doctor on a database from a newer release reports it rather than crashing',
  crashStatus === 1 && /will not open/.test(crashOut) && /schema version 999/.test(crashOut));

// The other recovery scenario doctor exists for: DATA_DIR is missing or
// mistyped. store.open()'s ordinary path would create a fresh, empty
// database right there and report a clean bill of health on the wrong
// directory - doctor asks for a non-creating open instead, specifically so
// this reports the real problem rather than quietly manufacturing "fine".
const missingDir = path.join(root, 'missing-data-dir-for-doctor');
let missingOut = '';
let missingStatus = 0;
try {
  execFileSync(process.execPath, ['podium-admin.js', 'doctor'], {
    cwd: cliRoot, env: { ...process.env, DATA_DIR: missingDir },
  });
} catch (err) {
  missingOut = String(err.stdout || '');
  missingStatus = err.status;
}
ok('doctor on a missing/mistyped DATA_DIR reports it rather than quietly creating one',
  missingStatus === 1 && /no database/.test(missingOut));
ok('and it really did not create anything there', !existsSync(missingDir));
ok('and every other command still fails loudly on the same database, as it always has', (() => {
  try {
    execFileSync(process.execPath, ['podium-admin.js', 'user', 'list'], {
      cwd: cliRoot, env: { ...process.env, DATA_DIR: crashDir }, stdio: 'pipe',
    });
    return false;
  } catch (err) {
    return err.status === 1 && /schema version 999/.test(String(err.stderr || ''));
  }
})());
rmSync(crashDir, { recursive: true, force: true });

console.log('\n--- audit logs ---');
accounts.logEvent(db, { userId: admin.id, username: admin.username, action: 'test_action', details: { foo: 'bar' }, now: 1000 });
accounts.logEvent(db, { userId: null, username: null, action: 'anon_action', now: 2000 });
ok('logs inserted', db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n >= 2);
const logCountBeforePrune = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
accounts.pruneLogs(db, 1500);
ok('logs pruned older than cutoff', db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n === logCountBeforePrune - 1);

db.close();
rmSync(root, { recursive: true, force: true });

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
