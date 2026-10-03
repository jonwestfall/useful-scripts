// Deck templates (Issue #226): a whole starting deck, or one slide's layout,
// to start from in the deck editor instead of a blank page.
//
// Three scopes, listed together in the editor:
//
//   built-in  shipped with Podium, as files under content/deck-templates/
//             (with an index.json). Everyone can use them, with or without a
//             server. They are read-only; an administrator can hide one, and
//             which are hidden is all this file keeps about them.
//   course    a course's own. Its owners (and admins) add, change and remove
//             them - the same people who may edit the course's decks - and
//             everyone in the course uses them.
//   mine      one person's own, seen and changed by nobody else.
//
// A template is plain Marp markdown, like any deck. One that points at
// pictures in the library (a course logo, say) keeps those addresses when it
// is used; nothing is copied.
//
// Modelled on templates.js (a course's plan skeleton): read follows course
// membership, writing a course's is an owner's or an admin's.

'use strict';

const store = require('./store.js');

const MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_TITLE = 120;
const KINDS = new Set(['deck', 'slide']);
const HIDDEN_KEY = 'hidden_deck_templates';

const fail = (status, message) => Object.assign(new Error(message), { status });

function courseByCode(db, code) {
  const wanted = String(code || '').trim().toLowerCase();
  return wanted ? db.prepare('SELECT * FROM courses WHERE code = ?').get(wanted) : null;
}

function roleIn(db, user, courseId) {
  return db.prepare('SELECT role FROM course_members WHERE course_id = ? AND user_id = ?').get(courseId, user.id)?.role || null;
}

/** May this user add, change and remove a course's templates? Its owners and admins. */
function mayWriteCourse(db, user, courseId) {
  return !!user.isAdmin || roleIn(db, user, courseId) === 'owner';
}

function mayWrite(db, user, row) {
  return row.scope === 'mine' ? row.user_id === user.id : mayWriteCourse(db, user, row.course_id);
}

// Same shape of rule as the library's: a course's templates for its members
// (while the course is not archived), anyone's own for them, and everything
// for an admin - who may also need to tidy up after someone.
const VISIBLE = `t.deleted_at IS NULL AND (
  (t.scope = 'mine' AND t.user_id = ?1)
  OR (t.scope = 'course' AND (?2 = 1 OR (c.archived_at IS NULL AND EXISTS (
    SELECT 1 FROM course_members cm WHERE cm.course_id = t.course_id AND cm.user_id = ?1))))
)`;

const SELECT = `SELECT t.*, c.code AS course_code, c.title AS course_title, u.display_name AS author
    FROM deck_templates t
    LEFT JOIN courses c ON c.id = t.course_id
    LEFT JOIN users u ON u.id = t.updated_by`;

function shape(db, user, row) {
  return {
    id: row.id,
    scope: row.scope,
    course: row.course_code || null,
    courseTitle: row.course_title || null,
    kind: row.kind,
    title: row.title,
    markdown: row.markdown,
    updatedAt: row.updated_at,
    updatedBy: row.author || null,
    editable: mayWrite(db, user, row),
  };
}

function get(db, user, id) {
  const row = db.prepare(`${SELECT} WHERE t.id = ?3 AND ${VISIBLE}`).get(user.id, user.isAdmin ? 1 : 0, Number(id));
  return row ? shape(db, user, row) : null;
}

/** Every template this user can use, newest change first, and which built-ins are hidden. */
function forUser(db, user) {
  const rows = db.prepare(`${SELECT} WHERE ${VISIBLE} ORDER BY t.updated_at DESC`).all(user.id, user.isAdmin ? 1 : 0);
  return { templates: rows.map((row) => shape(db, user, row)), hiddenBuiltIns: hiddenBuiltIns(db) };
}

function clean({ kind, title, markdown }, { partial = false } = {}) {
  const out = {};
  if (kind !== undefined || !partial) {
    if (!KINDS.has(kind)) throw fail(400, 'a template is either a whole deck or one slide');
    out.kind = kind;
  }
  if (title !== undefined || !partial) {
    const text = String(title ?? '').trim().slice(0, MAX_TITLE);
    if (!text) throw fail(400, 'a template needs a name');
    out.title = text;
  }
  if (markdown !== undefined || !partial) {
    const text = String(markdown ?? '');
    if (!text.trim()) throw fail(400, 'a template needs something in it');
    if (Buffer.byteLength(text) > MAX_MARKDOWN_BYTES) throw fail(413, `a template can be at most ${MAX_MARKDOWN_BYTES / 1024} KB`);
    out.markdown = text;
  }
  return out;
}

/**
 * A new template. `scope` is 'mine' or 'course' (with `course`, a code).
 * @returns the template, as forUser lists it
 */
function create(db, user, body = {}) {
  const fields = clean(body);
  let courseId = null;
  if (body.scope === 'course') {
    const course = courseByCode(db, body.course);
    if (!course || course.archived_at || !mayWriteCourse(db, user, course.id)) {
      throw fail(403, `only an owner of ${String(body.course || 'that course').toUpperCase()} or an admin can add its templates`);
    }
    courseId = course.id;
  } else if (body.scope !== 'mine') {
    throw fail(400, 'a template is either a course\'s or your own');
  }
  const now = Date.now();
  const { lastInsertRowid } = db.prepare(`INSERT INTO deck_templates
      (scope, course_id, user_id, kind, title, markdown, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(body.scope, courseId, body.scope === 'mine' ? user.id : null, fields.kind, fields.title, fields.markdown,
      now, user.id, now, user.id);
  return get(db, user, lastInsertRowid);
}

function writable(db, user, id) {
  const row = db.prepare(`${SELECT} WHERE t.id = ?3 AND ${VISIBLE}`).get(user.id, user.isAdmin ? 1 : 0, Number(id));
  if (!row) throw fail(404, 'no such template');
  if (!mayWrite(db, user, row)) {
    throw fail(403, row.scope === 'course'
      ? `only an owner of ${String(row.course_code).toUpperCase()} or an admin can change its templates`
      : 'only the person who made this template can change it');
  }
  return row;
}

/** Rename, re-kind or rewrite a template - whichever of title, kind, markdown are given. */
function update(db, user, id, body = {}) {
  writable(db, user, id);
  const fields = clean(body, { partial: true });
  const sets = Object.keys(fields).map((key) => `${key} = ?`);
  if (!sets.length) return get(db, user, id);
  db.prepare(`UPDATE deck_templates SET ${sets.join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`)
    .run(...Object.values(fields), Date.now(), user.id, Number(id));
  return get(db, user, id);
}

/** Soft delete, like the library's: the row stays, out of every listing. */
function remove(db, user, id) {
  writable(db, user, id);
  db.prepare('UPDATE deck_templates SET deleted_at = ?, updated_by = ? WHERE id = ?').run(Date.now(), user.id, Number(id));
  return { id: Number(id) };
}

// --- the built-ins -------------------------------------------------------------

function hiddenBuiltIns(db) {
  try {
    const list = JSON.parse(store.getSystemSetting(db, HIDDEN_KEY, '[]'));
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Hide (or show again) a built-in template for everyone on this server. Admins only. */
function hideBuiltIn(db, user, id, hidden) {
  if (!user.isAdmin) throw fail(403, 'only an admin can hide the templates that come with Podium');
  const name = String(id || '').trim();
  if (!/^[\w-]{1,80}$/.test(name)) throw fail(400, 'that is not a built-in template');
  const list = new Set(hiddenBuiltIns(db));
  if (hidden) list.add(name); else list.delete(name);
  store.setSystemSetting(db, HIDDEN_KEY, JSON.stringify([...list].sort()));
  return { hiddenBuiltIns: hiddenBuiltIns(db) };
}

module.exports = {
  forUser, get, create, update, remove, hideBuiltIn, hiddenBuiltIns, mayWriteCourse, MAX_MARKDOWN_BYTES,
};
