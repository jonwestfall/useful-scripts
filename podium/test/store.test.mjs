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
const lectures = require('../server/lectures.js');

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
ok('its author can', plans.updatePlan(db, owner, shared.id, { title: 'Day 6, revised' }).title === 'Day 6, revised');
ok('and an admin can', plans.mayWrite(db, admin, shared) === true);

refusedPlan = '';
try { plans.savePlan(db, outsider, { title: 'Sneaking in', courseCode: 'psy415', doc: {} }); }
catch (err) { refusedPlan = err.message; }
ok('a plan cannot be filed under a course you are not in', /no course with the code/.test(refusedPlan));

refusedPlan = '';
try { plans.savePlan(db, owner, { title: 'Enormous', doc: { blob: 'x'.repeat(plans.MAX_DOC_BYTES) } }); }
catch (err) { refusedPlan = err.message; }
ok('a plan too large to store is refused rather than stored', /too large/.test(refusedPlan));

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

console.log('\n-- what happened in the room --');

// The room name is psy415's, which is how a lecture finds its course: the
// display never sends a course code, it sends the room it is in.
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

let refusedDelete = '';
try { lectures.deleteLecture(db, ta, lecture.id); } catch (err) { refusedDelete = err.message; }
ok('a member who can read a lecture still cannot remove it', /only whoever ran this lecture/.test(refusedDelete));
ok('a course owner can, which is the same rule the library runs on',
  !!lectures.deleteLecture(db, owner, lectures.startLecture(db, owner, { room: 'psy415-room' }).id));

// Go live, decide the projector is fine, stand down again: no record.
const glance = lectures.startLecture(db, owner, { room: 'psy415-room' });
const ended = lectures.endLecture(db, owner, glance.id, { at: Date.now() });
ok('a lecture that recorded nothing is discarded rather than kept', ended.discarded === true);
ok('and is really gone', !lectures.getLecture(db, admin, glance.id));

const closed = lectures.endLecture(db, owner, lecture.id, { at: started + 3600000 });
ok('one that recorded something is ended, not discarded', !closed.discarded && closed.endedAt === started + 3600000);

// The second Go live in the same room, after a display whose tab was closed
// without ever standing down.
const abandoned = lectures.startLecture(db, owner, { room: 'lost-power' });
// Backdated so that "ended at the last thing it recorded" is distinguishable
// from both "ended when it started" and "ended now", which a lecture that ran
// for two milliseconds inside a test would not be.
db.prepare('UPDATE lectures SET started_at = ? WHERE id = ?').run(Date.now() - 3600000, abandoned.id);
const lastSeen = Date.now() - 1800000;
lectures.appendEvents(db, owner, abandoned.id, [{ at: lastSeen, kind: 'program', title: 'Half a lecture' }]);
const afterAbandoning = lectures.startLecture(db, owner, { room: 'lost-power' });
ok('going live again in the same room closes the lecture left open',
  lectures.getLecture(db, owner, abandoned.id).endedAt === lastSeen);
ok('at the last thing it recorded, not at now - it did not run until this morning',
  lectures.getLecture(db, owner, abandoned.id).endedAt < afterAbandoning.startedAt - 60000);
ok('and the new one is open', !afterAbandoning.endedAt);
lectures.startLecture(db, owner, { room: 'some-other-room' });
ok('an abandoned lecture that recorded nothing is discarded rather than left as a stub',
  lectures.getLecture(db, owner, elsewhere.id) === null);

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

db.close();
rmSync(root, { recursive: true, force: true });

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
