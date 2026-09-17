// What a device needs to reach the room, kept per course.
//
// This is the piece that turns setting up a new iPad from "scan a QR, then
// type a passphrase" into "log in". A course owns a room name and the
// passphrase every message in it is encrypted under; being a member of that
// course is what gets you both.
//
// Two things follow from that, and neither is an accident:
//
// READING a course's settings means holding the key to its projector. That is
// the point - a TA who may drive the display needs it - but it means adding
// someone to a course hands them that key, and removing them again does not
// take it back. Rotating the passphrase is the way to take it back, and the
// CLI is where that happens.
//
// WRITING them is therefore not a member's business: only a course owner or an
// admin can change a room or a passphrase. A TA who could rotate the key could
// lock the instructor out of their own lecture.
//
// And the larger one, argued out in VPS.md rather than here: with this table
// in it, the server can decrypt its own relay traffic. Podium's "the relay only
// ever moves ciphertext" was always about relays you do not own.

'use strict';

// The only keys a course may carry. An allow-list because these go straight
// into a device's connection config: anything not named here has no business
// arriving from the server and being acted on.
const SETTING_KEYS = [
  'transport', 'room', 'passphrase',
  'supabaseUrl', 'supabaseKey', 'mqttUrl', 'wsUrl',
];

const TRANSPORTS = new Set(['supabase', 'mqtt', 'ws']);

function cleanSettings(raw) {
  const out = {};
  for (const key of SETTING_KEYS) {
    const value = raw?.[key];
    if (typeof value !== 'string' || !value) continue;
    out[key] = value.slice(0, 500);
  }
  if (out.transport && !TRANSPORTS.has(out.transport)) {
    throw Object.assign(new Error(`transport must be one of ${[...TRANSPORTS].join(', ')}`), { status: 400 });
  }
  return out;
}

function parse(text) {
  try { return cleanSettings(JSON.parse(text || '{}')); } catch { return {}; }
}

/**
 * Every course this user could set a device up from: the ones they are a
 * member of that actually have settings stored. An admin sees all of them.
 *
 * The passphrase is in here. That is what the list is FOR - a device adopting
 * these is a device that can join the room - and it is why this route is
 * behind the session gate like everything else.
 */
function forUser(db, user) {
  const rows = user.isAdmin
    ? db.prepare(`SELECT c.code, c.title, s.settings FROM course_settings s
          JOIN courses c ON c.id = s.course_id
         WHERE c.archived_at IS NULL ORDER BY c.code`).all()
    : db.prepare(`SELECT c.code, c.title, s.settings FROM course_settings s
          JOIN courses c ON c.id = s.course_id
          JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = ?
         WHERE c.archived_at IS NULL ORDER BY c.code`).all(user.id);
  return rows
    .map((row) => ({ course: row.code, title: row.title || row.code, settings: parse(row.settings) }))
    .filter((row) => Object.keys(row.settings).length);
}

/** Owner of the course, or an admin. A member is not enough - see the top. */
function mayWrite(db, user, code) {
  if (user.isAdmin) return true;
  const row = db.prepare(`SELECT cm.role FROM course_members cm
      JOIN courses c ON c.id = cm.course_id
     WHERE c.code = ? AND cm.user_id = ?`).get(String(code).trim().toLowerCase(), user.id);
  return row?.role === 'owner';
}

function write(db, user, code, raw) {
  const wanted = String(code || '').trim().toLowerCase();
  const course = db.prepare('SELECT * FROM courses WHERE code = ?').get(wanted);
  // Same answer for "no such course" and "not yours": whether a course exists
  // is not something an outsider should learn from an error message.
  if (!course || !mayWrite(db, user, wanted)) {
    throw Object.assign(new Error(`no course with the code ${code} that you can change`), { status: 403 });
  }
  const settings = cleanSettings(raw);
  db.prepare(`INSERT INTO course_settings (course_id, settings, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(course_id) DO UPDATE SET settings = excluded.settings,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    // A null id is the CLI acting as root, where standing at a shell is the
    // credential and there is no account to attribute the change to. The
    // column is nullable for exactly that; an id of 0 would fail the foreign
    // key, since no such account exists.
    .run(course.id, JSON.stringify(settings), Date.now(), user?.id ?? null);
  return { course: course.code, title: course.title || course.code, settings };
}

module.exports = { forUser, write, mayWrite, cleanSettings, SETTING_KEYS };
