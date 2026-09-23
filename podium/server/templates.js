// A course's plan skeleton (Issue #80).
//
// Many instructors open the same shape of lecture every week - the class QR
// code, this term's watermark, the usual automated set, then that day's
// content on top. A template is that shape, saved once per course, so
// plan.html can start a new lecture from it instead of blank.
//
// The doc itself is exactly what a plan already is - whatever planfile.js
// writes - so a template is not a second format to keep in sync with the
// first: it is filled in from a real plan (see plan.html's "Save as this
// course's template") and read back into one the same way pulling any other
// plan already works.
//
// Read access follows membership, the same as a course's connection
// settings - starting a lecture from the template is not different from
// being handed the room's passphrase, both are things membership already
// grants. Writing one is an owner's business, or an admin's: a template
// becomes next week's lecture with nobody reviewing it first, so it is not
// a plain member's to change out from under the instructor.

'use strict';

const MAX_DOC_BYTES = 2 * 1024 * 1024; // same cap plans.js gives a plan itself

function docText(doc) {
  const text = typeof doc === 'string' ? doc : JSON.stringify(doc ?? {});
  if (Buffer.byteLength(text) > MAX_DOC_BYTES) {
    throw Object.assign(new Error('that template is too large to store'), { status: 413 });
  }
  return text;
}

function courseRow(db, code) {
  return db.prepare('SELECT * FROM courses WHERE code = ?').get(String(code || '').trim().toLowerCase());
}

/** Owner of the course, or an admin - see the file comment for why a member is not enough. */
function mayWrite(db, user, code) {
  if (user.isAdmin) return true;
  const row = db.prepare(`SELECT cm.role FROM course_members cm
      JOIN courses c ON c.id = cm.course_id
     WHERE c.code = ? AND cm.user_id = ?`).get(String(code || '').trim().toLowerCase(), user.id);
  return row?.role === 'owner';
}

/**
 * Every course this user could start a new plan for that actually has a
 * template saved - a course with none simply is not in the list, the same
 * "not every course has settings either" shape settings.forUser already has.
 */
function forUser(db, user) {
  const rows = user.isAdmin
    ? db.prepare(`SELECT c.code, c.title, t.doc, t.updated_at FROM course_templates t
          JOIN courses c ON c.id = t.course_id
         WHERE c.archived_at IS NULL ORDER BY c.code`).all()
    : db.prepare(`SELECT c.code, c.title, t.doc, t.updated_at FROM course_templates t
          JOIN courses c ON c.id = t.course_id
          JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = ?
         WHERE c.archived_at IS NULL ORDER BY c.code`).all(user.id);
  return rows.map((row) => {
    let doc;
    try { doc = JSON.parse(row.doc); } catch { doc = null; }
    return { course: row.code, title: row.title || row.code, doc, updatedAt: row.updated_at };
  });
}

function write(db, user, code, doc) {
  const course = courseRow(db, code);
  if (!course || !mayWrite(db, user, code)) {
    throw Object.assign(new Error(`no course with the code ${code} that you can change`), { status: 403 });
  }
  const text = docText(doc);
  db.prepare(`INSERT INTO course_templates (course_id, doc, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(course_id) DO UPDATE SET doc = excluded.doc,
        updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(course.id, text, Date.now(), user?.id ?? null);
  return { course: course.code, title: course.title || course.code };
}

function remove(db, user, code) {
  const course = courseRow(db, code);
  if (!course || !mayWrite(db, user, code)) {
    throw Object.assign(new Error(`no course with the code ${code} that you can change`), { status: 403 });
  }
  db.prepare('DELETE FROM course_templates WHERE course_id = ?').run(course.id);
  return { course: course.code };
}

module.exports = { forUser, write, remove, mayWrite, MAX_DOC_BYTES };
