// Unattended signage, admin-managed (Issue #151).
//
// A kiosk profile is a room set aside for a display nobody is running - see
// the migration in store.js for the schema and the reasoning behind
// provision_token. Managing one is an administrator's job outright, not an
// owner-or-admin split the way a course's settings are: there is no "kiosk
// owner" concept, and a device nobody is watching is exactly the wrong place
// to let membership decide who can repoint it.
//
// What this deliberately does NOT do: push the assigned plan onto the live
// room. That would need something that connects to the room's own encrypted
// bus and stages a command - a real client, the same as control.js is - and
// nothing server-side does that today (the passphrase a room is encrypted
// under is derived and held client-side; a Node-side bus client would be new
// infrastructure, not a small addition). `planId` here is admin-visible
// bookkeeping - what SHOULD be showing - left for a device, or whoever sets
// one up, to actually load once via the ordinary planner. Issue #152's
// scheduling work will need the same "what should be showing right now"
// question answered for real; better to design that once, there, than twice.

'use strict';

const crypto = require('node:crypto');
const settings = require('./settings.js');

function provisionToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function row(r) {
  return {
    id: r.id,
    name: r.name,
    settings: JSON.parse(r.settings || '{}'),
    provisionToken: r.provision_token,
    planId: r.plan_id,
    planTitle: r.plan_title || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revoked: !!r.revoked_at,
    revokedAt: r.revoked_at,
  };
}

const SELECT = 'SELECT k.*, p.title AS plan_title FROM kiosks k LEFT JOIN plans p ON p.id = k.plan_id';

function list(db) {
  return db.prepare(`${SELECT} ORDER BY k.name`).all().map(row);
}

function get(db, id) {
  const r = db.prepare(`${SELECT} WHERE k.id = ?`).get(Number(id));
  return r ? row(r) : null;
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 200) || 'Untitled kiosk';
}

function create(db, user, { name, settings: raw, planId } = {}) {
  const clean = settings.cleanSettings(raw);
  const now = Date.now();
  const { lastInsertRowid } = db.prepare(`INSERT INTO kiosks
      (name, settings, provision_token, plan_id, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(cleanName(name), JSON.stringify(clean), provisionToken(),
      planId ? Number(planId) : null, now, now, user?.id ?? null);
  return get(db, lastInsertRowid);
}

/**
 * `revoked`, like `courses.update`'s own `archived`, is a plain toggle here
 * rather than a separate route: true stops any future provisioning attempt
 * AND kicks every device already provisioned into this profile - the next
 * time any of them touches display.html, sessionKiosk's own check against
 * this same column fails and it lands on the login page, same as a stranger
 * who was never provisioned at all. false un-revokes, handing the SAME
 * provisioning token back out and letting every still-remembered session
 * back in without re-provisioning anything. The row is never deleted by
 * either direction - an admin working out "which of these devices is the
 * one that walked off" needs it to still be there, revoked or not.
 */
function update(db, user, id, { name, settings: raw, planId, revoked } = {}) {
  const existing = db.prepare('SELECT id FROM kiosks WHERE id = ?').get(Number(id));
  if (!existing) throw Object.assign(new Error('no such kiosk'), { status: 404 });
  const sets = ['updated_at = ?', 'updated_by = ?'];
  const values = [Date.now(), user?.id ?? null];
  if (name !== undefined) { sets.push('name = ?'); values.push(cleanName(name)); }
  if (raw !== undefined) { sets.push('settings = ?'); values.push(JSON.stringify(settings.cleanSettings(raw))); }
  if (planId !== undefined) { sets.push('plan_id = ?'); values.push(planId ? Number(planId) : null); }
  if (revoked !== undefined) { sets.push('revoked_at = ?'); values.push(revoked ? Date.now() : null); }
  values.push(Number(id));
  db.prepare(`UPDATE kiosks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return get(db, id);
}

const sessionTokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// No expiry (see kiosk_sessions' own comment in store.js) - a kiosk reboots
// on its own, forever, with nobody there to sign it back in. SESSION_MS is
// how long the COOKIE itself is allowed to sit unused in the browser before
// the browser throws it away on its own; sessionKiosk slides it forward on
// use the same way accounts.sessionUser slides a user's, so a kiosk that
// reboots at least this often never actually reaches it.
const SESSION_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 60 * 60 * 1000;

function startKioskSession(db, kioskId, userAgent = '', now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO kiosk_sessions (token_sha256, kiosk_id, created_at, last_seen_at, user_agent)
      VALUES (?, ?, ?, ?, ?)`)
    .run(sessionTokenHash(token), kioskId, now, now, String(userAgent || '').slice(0, 200));
  return token;
}

/**
 * The kiosk behind a session cookie, or null - what gate() in api.js checks
 * to let an already-provisioned device back onto display.html with no
 * account of its own. `revoked_at IS NULL` is checked live, on every call,
 * against the PROFILE, not just at the moment the session was minted - that
 * live check is what gives revoke real teeth: a device that has been
 * running for months stops being let in on the very next request after an
 * administrator revokes it, without this needing to know which sessions
 * that profile even has.
 */
function sessionKiosk(db, token, { now = Date.now(), onSlide } = {}) {
  if (!token) return null;
  const hash = sessionTokenHash(token);
  const r = db.prepare(`SELECT s.last_seen_at, k.id, k.revoked_at FROM kiosk_sessions s
      JOIN kiosks k ON k.id = s.kiosk_id WHERE s.token_sha256 = ?`).get(hash);
  if (!r || r.revoked_at) return null;
  if (now - r.last_seen_at > SESSION_TOUCH_MS) {
    db.prepare('UPDATE kiosk_sessions SET last_seen_at = ? WHERE token_sha256 = ?').run(now, hash);
    onSlide?.();
  }
  return { id: r.id };
}

/**
 * What a device that scans a kiosk's provisioning link actually gets: the
 * connection settings, with `kiosk: true` set for it - never the profile's
 * id, name or plan, none of which the device has any use for - PLUS a fresh
 * session token, which is the credential that actually gets it past the
 * accounts gate on every later visit to display.html (see sessionKiosk).
 * Public on purpose (no session, no account checked here to CALL this): the
 * provisioning token itself is the only credential a blank device can
 * possibly hold, the same trust the room passphrase already carries once it
 * has been handed to anyone. A revoked or unknown token answers the same as
 * each other - null - so a guess at one teaches nothing about whether a
 * kiosk like it ever existed.
 */
function provision(db, token, userAgent = '') {
  const r = db.prepare('SELECT id, settings FROM kiosks WHERE provision_token = ? AND revoked_at IS NULL')
    .get(String(token || ''));
  if (!r) return null;
  return {
    config: { ...JSON.parse(r.settings || '{}'), kiosk: true },
    sessionToken: startKioskSession(db, r.id, userAgent),
  };
}

/**
 * The connection settings for whichever kiosk a session cookie names, or
 * null - what a device asks for on every load once it is past gate() (see
 * fromKioskSession in config.js). Unlike provision(), this never touches the
 * one-time token: it is what lets a device that rebooted with nothing but
 * its cookie find out what it is again, without the passphrase ever having
 * to sit in a URL a second time.
 */
function sessionConfig(db, token, opts) {
  const kiosk = sessionKiosk(db, token, opts);
  if (!kiosk) return null;
  const r = db.prepare('SELECT settings FROM kiosks WHERE id = ?').get(kiosk.id);
  return { ...JSON.parse(r.settings || '{}'), kiosk: true };
}

module.exports = {
  list, get, create, update, provision, sessionKiosk, sessionConfig,
  SESSION_MS,
};
