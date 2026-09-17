// The server's storage and accounts, with no browser and no HTTP.
//
//   node podium/test/store.test.mjs
//
// Everything here runs against a real SQLite file in a temporary directory,
// because the point of these tests is the behaviour of the actual store -
// migrations that run once, a password that cannot be read back, a session
// that stops working when its account does. A mock would be testing itself.

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
ok('a relative path is a safe place to go after signing in', api.safeNext('/control.html') === '/control.html');
ok('a protocol-relative one is not', api.safeNext('//evil.example/x') === '');
ok('an absolute URL is not', api.safeNext('https://evil.example/x') === '');
ok('and neither is one with a newline smuggled into it', api.safeNext('/ok\nSet-Cookie: x') === '');

db.close();
rmSync(root, { recursive: true, force: true });

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
