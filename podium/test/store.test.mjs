// The server's storage and accounts, with no browser and no HTTP.
//
//   node podium/test/store.test.mjs
//
// Everything here runs against a real SQLite file in a temporary directory,
// because the point of these tests is the behaviour of the actual store -
// migrations that run once, a password that cannot be read back, a session
// that stops working when its account does. A mock would be testing itself.

import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning');   // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const api = require('../server/api.js');

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

console.log('\n-- the library: courses --');

ok('a member is told about their course', library.listCourses(db, ta).map((c) => c.code).join() === 'psy415');
ok('with the role they hold in it', library.listCourses(db, ta)[0].role === 'member');
ok('an owner is told they are one', library.listCourses(db, owner)[0].role === 'owner');
ok('someone in no courses is told about none', library.listCourses(db, outsider).length === 0);
ok('an admin sees every course', library.listCourses(db, admin).map((c) => c.code).join() === 'psy415');

db.close();
rmSync(root, { recursive: true, force: true });

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
