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
    throw new Error('username must be 1-64 characters of a-z, 0-9, dot, dash or underscore');
  }
  if (String(password || '').length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  const hash = await hashPassword(password);
  try {
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(name, String(displayName || '').slice(0, 120), hash, isAdmin ? 1 : 0, Date.now());
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid));
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw new Error(`there is already an account called ${name}`);
    throw err;
  }
}

const findUser = (db, username) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(normalizeUsername(username));

const listUsers = (db) =>
  db.prepare('SELECT * FROM users ORDER BY username').all().map((row) => ({
    ...publicUser(row),
    disabled: !!row.disabled_at,
    createdAt: row.created_at,
  }));

/**
 * Whether this instance has anyone who can log in. This is the switch that
 * decides the whole authentication story: accounts existing is what makes the
 * cookie gate govern, and what makes AUTH_PASSWORD stop being consulted.
 */
const countEnabledUsers = (db) =>
  db.prepare('SELECT COUNT(*) AS n FROM users WHERE disabled_at IS NULL').get().n;

async function setPassword(db, username, password) {
  if (String(password || '').length < 8) throw new Error('password must be at least 8 characters');
  const hash = await hashPassword(password);
  const { changes } = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?')
    .run(hash, normalizeUsername(username));
  if (!changes) throw new Error(`no account called ${normalizeUsername(username)}`);
  // Every existing login for that account stops working, which is the entire
  // reason someone changes a password in a hurry.
  db.prepare('DELETE FROM auth_sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)')
    .run(normalizeUsername(username));
}

function setDisabled(db, username, disabled) {
  const name = normalizeUsername(username);
  const { changes } = db.prepare('UPDATE users SET disabled_at = ? WHERE username = ?')
    .run(disabled ? Date.now() : null, name);
  if (!changes) throw new Error(`no account called ${name}`);
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
  if (failures.size > 5000) {
    for (const [k, v] of failures) if (v.until <= now) failures.delete(k);
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
 */
function sessionUser(db, token, now = Date.now()) {
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
  const stored = row && !row.disabled_at
    ? row.password_hash
    // Hash anyway against a throwaway value, so a missing account costs the
    // same wall-clock time as a wrong password and cannot be probed for.
    : await hashPassword(crypto.randomBytes(8).toString('hex'));
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
  createUser, findUser, listUsers, countEnabledUsers, setPassword, setDisabled,
  startSession, sessionUser, endSession, pruneSessions, login,
  SESSION_MS,
};
