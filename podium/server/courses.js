// Courses, and who is in them.
//
// A course is Podium's only unit of sharing, and it is deliberately a small
// one: a code, a title, and a list of people with a role each. Everything else
// in the server hangs off that - a library item filed under a course is visible
// to its members, a plan filed under one is shared with them, a room named in
// its settings hands them the passphrase, and a lecture held in that room is
// filed there. So this file is short and the rules it enforces are worth being
// exact about.
//
// Two roles, and the difference between them is the difference between using a
// course and running one:
//
//   member  read the course's things, drive its projector, add to its library
//   owner   all of that, plus membership and the room's connection settings
//
// Creating and archiving courses is an ADMIN's business, not an owner's. A
// course is the thing access is granted by, so being able to invent one is
// being able to invent a place to put things where the instance's admin never
// looks; and archiving one hides everything filed under it from everyone.

'use strict';

const accounts = require('./accounts.js');

const CODE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const clean = (code) => String(code || '').trim().toLowerCase();

// A course's default watermark (Issue #157). The same three fields, and the
// same limits, as state.watermark on a display (see the 'watermark' op in
// protocol.js) - a lecture hands this straight to one, so anything it would
// refuse has no business being stored here either. The logo's cap matches
// MAX_ASSET_CHARS in planfile.js: the display keeps it in the same asset
// store every other picture goes through, and serves it to a second display
// over the relay the same way.
const MAX_BRANDING_TEXT = 120;
const MAX_BRANDING_IMAGE_CHARS = 160 * 1024;
const BRANDING_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

function cleanBranding(raw) {
  const text = String(raw?.text || '').trim().slice(0, MAX_BRANDING_TEXT);
  const image = typeof raw?.image === 'string' ? raw.image : '';
  if (image && (image.length > MAX_BRANDING_IMAGE_CHARS || !BRANDING_IMAGE_RE.test(image))) {
    throw Object.assign(new Error(
      `a course logo has to be a PNG, JPEG, GIF or WebP picture under ${Math.round(MAX_BRANDING_IMAGE_CHARS / 1024)} KB`,
    ), { status: 400 });
  }
  return { text, image, position: raw?.position === 'tl' ? 'tl' : 'br' };
}

function parseBranding(text) {
  try { return cleanBranding(JSON.parse(text || '{}')); } catch { return { text: '', image: '', position: 'br' }; }
}

const hasBranding = (branding) => !!(branding?.text || branding?.image);

function courseRow(row) {
  return {
    code: row.code,
    title: row.title || row.code,
    createdAt: row.created_at,
    archived: !!row.archived_at,
    members: row.member_count ?? 0,
  };
}

const SELECT_COURSES = `
  SELECT c.*, (SELECT COUNT(*) FROM course_members cm WHERE cm.course_id = c.id) AS member_count
    FROM courses c`;

function find(db, code) {
  const row = db.prepare(`${SELECT_COURSES} WHERE c.code = ?`).get(clean(code));
  if (!row) throw Object.assign(new Error(`no course with the code ${code}`), { status: 404 });
  return row;
}

/**
 * The role this account has in a course: 'owner', 'member', or null.
 *
 * An admin is treated as an owner everywhere, which is the same shortcut the
 * library, plans and settings already take - there is no separate "instance
 * owner" role and inventing one here would make four files disagree.
 */
function roleOf(db, user, code) {
  if (user.isAdmin) return 'owner';
  const row = db.prepare(`SELECT cm.role FROM course_members cm
      JOIN courses c ON c.id = cm.course_id
     WHERE c.code = ? AND cm.user_id = ?`).get(clean(code), user.id);
  return row?.role || null;
}

const mayManage = (db, user, code) => roleOf(db, user, code) === 'owner';

/**
 * Every course this account has any business seeing, with its members when it
 * may see those. An admin sees all of them, archived included - hiding an
 * archived course from the page that unarchives it would be a trap.
 */
function list(db, user) {
  const rows = user.isAdmin
    ? db.prepare(`${SELECT_COURSES} ORDER BY c.archived_at IS NOT NULL, c.code`).all()
    : db.prepare(`${SELECT_COURSES}
          JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = ?
         WHERE c.archived_at IS NULL ORDER BY c.code`).all(user.id);
  return rows.map((row) => ({
    ...courseRow(row),
    role: user.isAdmin ? 'owner' : roleOf(db, user, row.code),
    // Only to somebody who runs the course. Who else teaches a class is not a
    // secret, but it is not every member's business either, and a list of every
    // account on the instance assembled from course pages is exactly the kind
    // of thing that should need a reason.
    people: mayManage(db, user, row.code) ? members(db, row.id) : undefined,
    // The same audience as `people`: whoever may change it. Nobody else has a
    // use for it - the display that needs it is handed it by startLecture.
    branding: mayManage(db, user, row.code) ? parseBranding(row.branding) : undefined,
  }));
}

const members = (db, courseId) =>
  db.prepare(`SELECT u.username, u.display_name, u.disabled_at, cm.role
      FROM course_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.course_id = ? ORDER BY cm.role DESC, u.username`).all(courseId)
    .map((row) => ({
      username: row.username,
      displayName: row.display_name || row.username,
      role: row.role,
      disabled: !!row.disabled_at,
    }));

function create(db, user, { code, title }) {
  if (!user.isAdmin) throw Object.assign(new Error('only an administrator can make a course'), { status: 403 });
  const wanted = clean(code);
  if (!CODE_RE.test(wanted)) {
    throw Object.assign(new Error(
      'a course code is 1-64 characters of a-z, 0-9, dot, dash or underscore - it is typed into a filter box, so keep it short',
    ), { status: 400 });
  }
  try {
    db.prepare('INSERT INTO courses (code, title, created_at) VALUES (?, ?, ?)')
      .run(wanted, String(title || '').slice(0, 200), Date.now());
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) {
      throw Object.assign(new Error(`there is already a course called ${wanted}`), { status: 409 });
    }
    throw err;
  }
  return courseRow(find(db, wanted));
}

/**
 * Rename, or archive and bring back.
 *
 * Archiving is as close to deleting as Podium gets, and deliberately so:
 * everything filed under a course - library items, plans, session records -
 * stays exactly where it is and simply stops being listed. A term that is over
 * should go quiet, not take its lecture recordings with it.
 */
function update(db, user, code, { title, archived } = {}) {
  if (!user.isAdmin) throw Object.assign(new Error('only an administrator can change a course'), { status: 403 });
  const course = find(db, code);
  if (title !== undefined) {
    db.prepare('UPDATE courses SET title = ? WHERE id = ?').run(String(title || '').slice(0, 200), course.id);
  }
  if (archived !== undefined) {
    db.prepare('UPDATE courses SET archived_at = ? WHERE id = ?').run(archived ? Date.now() : null, course.id);
  }
  return courseRow(find(db, code));
}

/**
 * What a lecture held under this course starts with in the corner (Issue
 * #157), or null when the course has none. Read by startLecture, which has
 * already decided the lecture belongs here - so no permission check of its
 * own: whoever is starting a lecture in a course's room already holds its
 * passphrase, which is a far bigger thing than its logo.
 */
function brandingFor(db, courseId) {
  if (courseId == null) return null;
  const row = db.prepare('SELECT branding FROM courses WHERE id = ?').get(courseId);
  const branding = row ? parseBranding(row.branding) : null;
  return hasBranding(branding) ? branding : null;
}

/**
 * Set a course's default watermark. An owner's business as well as an
 * admin's, unlike renaming or archiving: it changes nothing about who can see
 * what, only what a fresh lecture shows before anybody touches the Say tab.
 * An empty text and image clears it.
 */
function setBranding(db, user, code, raw) {
  if (!mayManage(db, user, code)) {
    throw Object.assign(new Error(`no course with the code ${code} that you can change`), { status: 403 });
  }
  const course = find(db, code);
  const branding = cleanBranding(raw);
  db.prepare('UPDATE courses SET branding = ? WHERE id = ?')
    .run(JSON.stringify(hasBranding(branding) ? branding : {}), course.id);
  return branding;
}

function addMember(db, user, code, { username, role = 'member' }) {
  if (!mayManage(db, user, code)) {
    throw Object.assign(new Error(`no course with the code ${code} that you can change`), { status: 403 });
  }
  const course = find(db, code);
  const person = accounts.findUser(db, username);
  if (!person) throw Object.assign(new Error(`no account called ${username}`), { status: 400 });
  const wanted = role === 'owner' ? 'owner' : 'member';
  // Setting an existing owner's role to 'member' is a demotion by another
  // name, and the page offers it as exactly that ("Make a member") - so it
  // has to keep the same last-owner rail removeMember enforces, or that rail
  // is just a label on one of two doors to the same room.
  if (wanted === 'member' && !user.isAdmin) {
    const current = db.prepare('SELECT role FROM course_members WHERE course_id = ? AND user_id = ?')
      .get(course.id, person.id);
    if (current?.role === 'owner') {
      const owners = db.prepare("SELECT COUNT(*) AS n FROM course_members WHERE course_id = ? AND role = 'owner'")
        .get(course.id).n;
      if (owners <= 1) {
        throw Object.assign(new Error(
          `${person.username} is the only owner of ${course.code} - make someone else an owner first`,
        ), { status: 409 });
      }
    }
  }
  db.prepare(`INSERT INTO course_members (course_id, user_id, role) VALUES (?, ?, ?)
      ON CONFLICT(course_id, user_id) DO UPDATE SET role = excluded.role`)
    .run(course.id, person.id, wanted);
  return members(db, course.id);
}

/**
 * Take someone out of a course.
 *
 * Worth saying plainly, here and in the docs: this stops them SEEING the
 * course's things from now on, and it does not take back what they already
 * have. A device that adopted the room's settings still holds the passphrase,
 * which is what rotating it is for (see settings.js).
 *
 * A course keeps at least one owner while it has any members at all, for the
 * same reason the instance keeps an admin: a course nobody owns cannot have
 * anyone added back to it except by an admin.
 */
function removeMember(db, user, code, username) {
  if (!mayManage(db, user, code)) {
    throw Object.assign(new Error(`no course with the code ${code} that you can change`), { status: 403 });
  }
  const course = find(db, code);
  const person = accounts.findUser(db, username);
  if (!person) throw Object.assign(new Error(`no account called ${username}`), { status: 400 });
  const row = db.prepare('SELECT role FROM course_members WHERE course_id = ? AND user_id = ?')
    .get(course.id, person.id);
  if (!row) return members(db, course.id);
  if (row.role === 'owner' && !user.isAdmin) {
    const owners = db.prepare("SELECT COUNT(*) AS n FROM course_members WHERE course_id = ? AND role = 'owner'")
      .get(course.id).n;
    if (owners <= 1) {
      throw Object.assign(new Error(
        `${person.username} is the only owner of ${course.code} - make someone else an owner first`,
      ), { status: 409 });
    }
  }
  db.prepare('DELETE FROM course_members WHERE course_id = ? AND user_id = ?').run(course.id, person.id);
  return members(db, course.id);
}

module.exports = {
  list, members, create, update, addMember, removeMember, roleOf, mayManage, find,
  brandingFor, setBranding, cleanBranding, MAX_BRANDING_IMAGE_CHARS,
};
