// Who is asking.
//
// Podium's room passphrase says what a device may DO once it is talking to the
// display; it has never said anything about who may load the pages in the
// first place. On a box with a plain domain that second question needs its own
// answer, and on a box that now remembers things it needs one with a name
// attached.
//
// Deliberately a cookie rather than HTTP Basic Auth. Browsers attach cookies
// to every same-origin request automatically - subresources, webmanifests,
// icons, service-worker fetches - with no native prompt and no per-path
// exceptions in the proxy. Basic Auth does none of that reliably (Safari in
// particular), which is why the instance this was written for had to give up
// its offline shell to get a login. See VPS.md.

'use strict';

const crypto = require('node:crypto');

// 128 * N * r = 16 MB per hash, comfortably under Node's 32 MB scrypt default.
// The parameters travel inside the stored string so they can be raised later
// without invalidating everyone who already has a password.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const SESSION_MS = 90 * 24 * 60 * 60 * 1000;
// A page load is a dozen requests; touching the row on each one would be a
// dozen writes for nothing. An hour's resolution is plenty for "last seen".
const SESSION_TOUCH_MS = 60 * 60 * 1000;

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Hashed once at startup, from bytes nobody will ever type, and verified
// against whenever there is no real account to verify against. See login().
// The fallback is deliberately unparseable rather than a valid hash of
// anything: if hashing itself failed, "no password matches" is the answer.
const NO_SUCH_ACCOUNT = (async () => hashPassword(crypto.randomBytes(32).toString('hex')))()
  .catch(() => 'scrypt$unusable');

const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    (err, key) => (err ? reject(err) : resolve(key)));
});

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, want] = parts;
  let got;
  try {
    got = await new Promise((resolve, reject) => {
      const expected = Buffer.from(want, 'base64url');
      crypto.scrypt(String(password), Buffer.from(salt, 'base64url'), expected.length,
        { N: Number(n), r: Number(r), p: Number(p) },
        (err, key) => (err ? reject(err) : resolve(key)));
    });
  } catch {
    return false;                       // unreadable parameters: not a match
  }
  const expected = Buffer.from(want, 'base64url');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

function normalizeUsername(raw) {
  return String(raw || '').trim().toLowerCase();
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    isAdmin: !!row.is_admin,
  };
}

// --- users -------------------------------------------------------------------

async function createUser(db, { username, password, displayName = '', isAdmin = false }) {
  const name = normalizeUsername(username);
  if (!USERNAME_RE.test(name)) {
    throw Object.assign(new Error('username must be 1-64 characters of a-z, 0-9, dot, dash or underscore'), { status: 400 });
  }
  if (String(password || '').length < 8) {
    throw Object.assign(new Error('password must be at least 8 characters'), { status: 400 });
  }
  const hash = await hashPassword(password);
  try {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(name, String(displayName || '').slice(0, 120), hash, isAdmin ? 1 : 0, Date.now());
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid));
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) {
      throw Object.assign(new Error(`there is already an account called ${name}`), { status: 409 });
    }
    throw err;
  }
}

const findUser = (db, username) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(username));

const listUsers = (db) =>
  db.prepare(`SELECT u.*,
        (SELECT MAX(s.last_seen_at) FROM auth_sessions s WHERE s.user_id = u.id) AS last_seen,
        (SELECT COUNT(*) FROM auth_sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS live_sessions
      FROM users u ORDER BY u.username`).all(Date.now()).map((row) => ({
    ...publicUser(row),
    disabled: !!row.disabled_at,
    createdAt: row.created_at,
    // When this account was last seen using the place, and how many
    // still-valid login tokens it holds - NOT a device count, whatever it
    // looks like at a glance: startSession mints a fresh token on every
    // sign-in, so re-authenticating on the SAME device (a token that
    // expired, a second tab) grows this the same as a genuinely different
    // device would. Good enough to notice "several logins nobody
    // recognizes"; not a census of hardware.
    lastSeen: row.last_seen || null,
    activeSessions: row.live_sessions,
  }));

/**
 * Whether this instance has accounts at all - DISABLED ONES INCLUDED.
 *
 * This is the switch that decides the whole authentication story: accounts
 * existing is what makes the cookie gate govern, and what makes AUTH_PASSWORD
 * stop being consulted. Counting only the enabled ones would mean that
 * disabling your last account - a thing you would do precisely because
 * something was wrong - dropped the instance back to AUTH_PASSWORD, or with
 * the installer's defaults to no gate at all. Locking yourself out must never
 * be the same gesture as letting everyone else in.
 *
 * With every account disabled the mode stays "accounts" and nobody can sign
 * in, which is the right way to fail. `podium-admin user enable` is the way
 * back.
 */
const countUsers = (db) => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

/** Accounts that can actually sign in right now. Not the gate switch. */
const countEnabledUsers = (db) =>
  db.prepare('SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL').get().n;

/** Accounts that can sign in AND administer. The number that must not reach 0. */
const countEnabledAdmins = (db) =>
  db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled_at IS NULL').get().n;

/**
 * Refuse to take away the last way in - from a BROWSER.
 *
 * An instance with no enabled admin cannot be administered from the admin page
 * at all: no accounts can be made, no courses, no settings. The way back is a
 * shell on the box and podium-admin, which is a fine answer for an emergency
 * and a poor one for a Tuesday-afternoon mis-click, so the two gestures that
 * could cause it - disabling an admin and demoting one - are refused there.
 *
 * Called by the API and NOT by setDisabled/setAdmin below, which is the whole
 * point: standing at a shell is the credential the CLI runs on, and "that
 * account is compromised, turn it off now" must not be a thing Podium argues
 * with. The rail is on the path where a slip is plausible, not on the path
 * that exists to recover from one.
 */
function assertAnotherAdminRemains(db, username, what) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(username));
  if (!row || !row.is_admin || row.disabled_at) return;   // not an enabled admin: nothing to lose
  if (countEnabledAdmins(db) > 1) return;
  throw Object.assign(new Error(
    `${row.username} is the only administrator who can sign in, so ${what} would leave nobody able`
    + ' to manage this Podium from a browser. Make another administrator first.',
  ), { status: 409 });
}

/** Grant or take away administrator rights. */
function setAdmin(db, username, isAdmin) {
  const name = normalizeUsername(username);
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
  if (!row) throw Object.assign(new Error(`no account called ${name}`), { status: 404 });
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, row.id);
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(row.id));
}

/** The name shown beside a session badge; nothing depends on it. */
function setDisplayName(db, username, displayName) {
  const name = normalizeUsername(username);
  const { changes } = db.prepare('UPDATE users SET display_name = ? WHERE username = ?')
    .run(String(displayName || '').slice(0, 120), name);
  if (!changes) throw Object.assign(new Error(`no account called ${name}`), { status: 404 });
}

async function setPassword(db, username, password) {
  if (String(password || '').length < 8) {
    throw Object.assign(new Error('password must be at least 8 characters'), { status: 400 });
  }
  const hash = await hashPassword(password);
  const { changes } = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?')
    .run(hash, normalizeUsername(username));
  if (!changes) {
    throw Object.assign(new Error(`no account called ${normalizeUsername(username)}`), { status: 404 });
  }
  // Every existing login for that account stops working, which is the entire
  // reason someone changes a password in a hurry.
  db.prepare('DELETE FROM auth_sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)')
    .run(normalizeUsername(username));
}

function setDisabled(db, username, disabled) {
  const name = normalizeUsername(username);
  const { changes } = db.prepare('UPDATE users SET disabled_at = ? WHERE username = ?')
    .run(disabled ? Date.now() : null, name);
  if (!changes) throw Object.assign(new Error(`no account called ${name}`), { status: 404 });
  if (disabled) {
    db.prepare('DELETE FROM auth_sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(name);
  }
}

// --- login throttling --------------------------------------------------------
//
// This is an internet-facing password form on a box with one or two accounts.
// In memory is the right place for this: it costs nothing, it forgets on
// restart (which is fine - an attacker cannot make the process restart), and
// it keeps the database out of the path of a flood.

const MAX_FAILURES = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
// Bounded, because the keys are attacker-chosen: a flood of made-up usernames
// would otherwise grow this map for fifteen minutes at a time.
const MAX_TRACKED = 5000;
const failures = new Map();

function throttledFor(key, now = Date.now()) {
  const entry = failures.get(key);
  if (!entry) return 0;
  if (entry.until <= now) { failures.delete(key); return 0; }
  return entry.count >= MAX_FAILURES ? entry.until - now : 0;
}

function noteFailure(key, now = Date.now()) {
  const entry = failures.get(key);
  if (!entry || entry.until <= now) {
    failures.set(key, { count: 1, until: now + LOCKOUT_MS });
  } else {
    entry.count += 1;
    entry.until = now + LOCKOUT_MS;
  }
  if (failures.size > MAX_TRACKED) {
    for (const [k, v] of failures) if (v.until <= now) failures.delete(k);
    // Still over the cap means the entries are all live, so expiry alone
    // cannot help. A Map iterates in insertion order, so this drops the
    // longest-standing counters first. It does mean a patient attacker can
    // push their own counter out - but a bounded, occasionally-forgetful
    // throttle beats one that grows until the process dies.
    while (failures.size > MAX_TRACKED) {
      failures.delete(failures.keys().next().value);
    }
  }
}

const clearFailures = (key) => failures.delete(key);

// --- sessions ----------------------------------------------------------------

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function startSession(db, userId, userAgent = '', now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO auth_sessions
      (token_sha256, user_id, created_at, expires_at, last_seen_at, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .run(tokenHash(token), userId, now, now + SESSION_MS, now, String(userAgent || '').slice(0, 200));
  return token;
}

/**
 * The user behind a cookie, or null. Slides the expiry forward as it goes, so
 * a device used every week stays logged in and one abandoned in a drawer does
 * not.
 *
 * `onSlide` fires when the expiry actually moved, because the row sliding is
 * only half the job: the browser was told `Max-Age` once, at login, and
 * nothing since. Without re-issuing the cookie, a controller used every day
 * would still be signed out ninety days later - the server would happily have
 * kept the session, and the browser would have thrown the key away.
 */
function sessionUser(db, token, { now = Date.now(), onSlide } = {}) {
  if (!token) return null;
  const hash = tokenHash(token);
  const row = db.prepare(`SELECT s.expires_at, s.last_seen_at, u.*
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_sha256 = ?`).get(hash);
  if (!row) return null;
  if (row.expires_at <= now || row.disabled_at) {
    db.prepare('DELETE FROM auth_sessions WHERE token_sha256 = ?').run(hash);
    return null;
  }
  if (now - row.last_seen_at > SESSION_TOUCH_MS) {
    db.prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_sha256 = ?')
      .run(now, now + SESSION_MS, hash);
    onSlide?.();
  }
  return publicUser(row);
}

const endSession = (db, token) =>
  db.prepare('DELETE FROM auth_sessions WHERE token_sha256 = ?').run(tokenHash(token || ''));

const pruneSessions = (db, now = Date.now()) =>
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now).changes;

/**
 * Check a username and password, and on success hand back a fresh session
 * token. Returns null for every kind of failure, on purpose: "no such account"
 * and "wrong password" must be indistinguishable from outside.
 */
async function login(db, username, password, { userAgent = '', ip = '' } = {}) {
  const name = normalizeUsername(username);
  const now = Date.now();
  for (const key of [`u:${name}`, `ip:${ip}`]) {
    if (throttledFor(key, now)) return { ok: false, retryAfterMs: throttledFor(key, now) };
  }
  const row = findUser(db, name);
  // Verify against a fixed unusable hash when there is no account to verify
  // against, so a username nobody has costs exactly ONE scrypt - the same as a
  // wrong password for a real one. Hashing a throwaway here instead would cost
  // two, and the difference is measurable from outside: it would turn this
  // into the account-enumeration oracle the fixed answer below exists to
  // prevent.
  const stored = row && !row.disabled_at ? row.password_hash : await NO_SUCH_ACCOUNT;
  const good = await verifyPassword(password, stored);
  if (!good || !row || row.disabled_at) {
    noteFailure(`u:${name}`, now);
    noteFailure(`ip:${ip}`, now);
    return { ok: false };
  }
  clearFailures(`u:${name}`);
  clearFailures(`ip:${ip}`);
  return { ok: true, token: startSession(db, row.id, userAgent, now), user: publicUser(row) };
}

module.exports = {
  hashPassword, verifyPassword, normalizeUsername, publicUser,
  createUser, findUser, listUsers, countUsers, countEnabledUsers, countEnabledAdmins,
  setPassword, setDisabled, setAdmin, setDisplayName, assertAnotherAdminRemains,
  startSession, sessionUser, endSession, pruneSessions, login,
  SESSION_MS,
};
