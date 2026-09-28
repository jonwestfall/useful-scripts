// Unattended signage, admin-managed (Issue #151).
//
// A kiosk profile is a room set aside for a display nobody is running - see
// the migration in store.js for the schema and the reasoning behind
// provision_token. Managing one is an administrator's job outright, not an
// owner-or-admin split the way a course's settings are: there is no "kiosk
// owner" concept, and a device nobody is watching is exactly the wrong place
// to let membership decide who can repoint it.
//
// What this still does NOT do: push a plan onto the live room over the bus
// itself - that would need a real bus client running server-side (the
// passphrase a room is encrypted under is derived and held client-side; a
// Node-side bus client would be new infrastructure, not a small addition).
// What it DOES do (Issue #152) is answer "what should be showing right now"
// for a device that asks: resolvePlanId below evaluates a kiosk's schedule
// against the current moment, and sessionPlan hands back the actual plan
// document that names - the device (display.js's own adoptPlanLocally, not
// a controller) is what turns that into pixels, by polling and loading it
// itself. See KIOSK_SCHEDULE_POLL_MS's own comment in display.js for why
// polling rather than a push was the right call here.

'use strict';

const crypto = require('node:crypto');
const settings = require('./settings.js');
const plans = require('./plans.js');

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
    schedule: JSON.parse(r.schedule || '[]'),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revoked: !!r.revoked_at,
    revokedAt: r.revoked_at,
  };
}

// A day-of-week/time-range list, deliberately no more than that (Issue #152:
// "a simple day-of-week/time-range list is probably enough for v1, not a
// full calendar/recurrence engine"). Capped the same way a course's settings
// values are - an allow-list of shape, not a place for anything a browser
// didn't put there on purpose to survive.
const MAX_SCHEDULE_ENTRIES = 50;

function cleanSchedule(raw) {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_SCHEDULE_ENTRIES) {
    throw Object.assign(new Error(`a schedule may not hold more than ${MAX_SCHEDULE_ENTRIES} entries`), { status: 400 });
  }
  return list.map((entry, i) => {
    const day = entry?.day === null || entry?.day === undefined ? null : Number(entry.day);
    if (day !== null && (!Number.isInteger(day) || day < 0 || day > 6)) {
      throw Object.assign(new Error(`entry ${i + 1}: day must be 0-6 (Sunday-Saturday) or left blank for every day`), { status: 400 });
    }
    const startMin = Number(entry?.startMin);
    const endMin = Number(entry?.endMin);
    if (!Number.isInteger(startMin) || startMin < 0 || startMin > 1439
      || !Number.isInteger(endMin) || endMin < 0 || endMin > 1439) {
      throw Object.assign(new Error(`entry ${i + 1}: start and end must be real times of day`), { status: 400 });
    }
    if (startMin >= endMin) {
      throw Object.assign(new Error(`entry ${i + 1}: end must be after start - a window cannot cross midnight in v1`), { status: 400 });
    }
    const planId = Number(entry?.planId);
    if (!Number.isInteger(planId) || planId <= 0) {
      throw Object.assign(new Error(`entry ${i + 1}: needs a plan to show`), { status: 400 });
    }
    const id = typeof entry?.id === 'string' && entry.id ? entry.id.slice(0, 40) : crypto.randomBytes(6).toString('base64url');
    return { id, day, startMin, endMin, planId };
  });
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

function create(db, user, { name, settings: raw, planId, schedule } = {}) {
  const clean = settings.cleanSettings(raw);
  const cleanedSchedule = cleanSchedule(schedule) ?? [];
  const now = Date.now();
  const { lastInsertRowid } = db.prepare(`INSERT INTO kiosks
      (name, settings, provision_token, plan_id, schedule, created_at, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(cleanName(name), JSON.stringify(clean), provisionToken(),
      planId ? Number(planId) : null, JSON.stringify(cleanedSchedule), now, now, user?.id ?? null);
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
function update(db, user, id, { name, settings: raw, planId, revoked, schedule } = {}) {
  const existing = db.prepare('SELECT id FROM kiosks WHERE id = ?').get(Number(id));
  if (!existing) throw Object.assign(new Error('no such kiosk'), { status: 404 });
  const sets = ['updated_at = ?', 'updated_by = ?'];
  const values = [Date.now(), user?.id ?? null];
  if (name !== undefined) { sets.push('name = ?'); values.push(cleanName(name)); }
  if (raw !== undefined) { sets.push('settings = ?'); values.push(JSON.stringify(settings.cleanSettings(raw))); }
  if (planId !== undefined) { sets.push('plan_id = ?'); values.push(planId ? Number(planId) : null); }
  if (revoked !== undefined) { sets.push('revoked_at = ?'); values.push(revoked ? Date.now() : null); }
  if (schedule !== undefined) { sets.push('schedule = ?'); values.push(JSON.stringify(cleanSchedule(schedule))); }
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

/**
 * Which plan should be showing on this kiosk right now (Issue #152) - the
 * first schedule entry whose day and time window contains `now`, list order
 * deciding ties the same an admin would read them top to bottom; the
 * kiosk's own plan_id if none match or no schedule is set at all, same as
 * before #152 existed. `now` is a real parameter (not always Date.now())
 * purely so a test can pin it rather than racing the clock.
 */
function resolvePlanId(kiosk, now = Date.now()) {
  // now travels as an epoch number everywhere else in this file (sessionKiosk,
  // startKioskSession) - accepting that same shape here, not a Date, is what
  // lets sessionPlan below hand its own `now` straight through to both.
  const d = new Date(now);
  const minuteOfDay = d.getHours() * 60 + d.getMinutes();
  const day = d.getDay();
  const hit = kiosk.schedule.find((e) => (e.day === null || e.day === day) && minuteOfDay >= e.startMin && minuteOfDay < e.endMin);
  return hit ? hit.planId : kiosk.planId;
}

/**
 * What display.js's own poll asks for (Issue #152): the kiosk behind this
 * session, which plan resolvePlanId says it should be showing right now, and
 * that plan's actual document - null throughout if the cookie does not name
 * a live kiosk, and a null `plan` specifically if nothing is assigned or
 * whatever was resolved has since been deleted (getPlanForKiosk already
 * treats a deleted plan as gone). The device is what decides whether that
 * differs from what it already has loaded and is worth reloading for.
 */
function sessionPlan(db, token, opts) {
  const session = sessionKiosk(db, token, opts);
  if (!session) return null;
  const kiosk = get(db, session.id);
  const planId = resolvePlanId(kiosk, opts?.now);
  const plan = planId ? plans.getPlanForKiosk(db, planId) : null;
  return { planId: plan ? planId : null, plan };
}

module.exports = {
  list, get, create, update, provision, sessionKiosk, sessionConfig, resolvePlanId, sessionPlan,
  SESSION_MS,
};
