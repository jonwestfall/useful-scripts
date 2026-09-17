// Lecture plans, kept by the server rather than carried on a stick.
//
// Nothing about the plan FILE changes. `doc` is exactly the document
// planfile.js writes, stored whole and handed back whole, so a plan that came
// from a server and a plan that came from a USB stick are the same thing and
// neither format can drift from the other. Export and import still work, and
// still work with no server at all.
//
// The visibility rule here is the opposite of the library's, which is worth
// being loud about because the asymmetry is surprising:
//
//   library item, no course  ->  everyone with an account can see it
//   plan,         no course  ->  only its author can see it
//
// A library item is something you went out of your way to publish. A plan is a
// draft until you say otherwise - filing it under a course is the act of
// sharing it, and until then half a written lecture has no business appearing
// in a colleague's list.

'use strict';

// Owner, or a member of the course it has been filed under, or an admin.
// ?1 = user id, ?2 = 1 for an admin.
const VISIBLE = `(
  p.owner_id = ?1
  OR ?2 = 1
  OR (p.course_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM course_members cm WHERE cm.course_id = p.course_id AND cm.user_id = ?1))
)`;

const SELECT_PLANS = `
  SELECT p.*, c.code AS course_code, u.username AS owner_name
    FROM plans p
    LEFT JOIN courses c ON c.id = p.course_id
    LEFT JOIN users u ON u.id = p.owner_id
   WHERE p.deleted_at IS NULL`;

function planRow(row, { withDoc = false } = {}) {
  const summary = {
    id: row.id,
    title: row.title || 'Untitled lecture',
    course: row.course_code || null,
    owner: row.owner_name || '',
    ownerId: row.owner_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // The document itself is only sent when one plan was asked for. A list of
  // twenty lectures is a list of twenty names, not twenty lecture plans.
  if (!withDoc) return summary;
  let doc = null;
  try { doc = JSON.parse(row.doc); } catch { doc = null; }
  return { ...summary, doc };
}

const listPlans = (db, user) =>
  db.prepare(`${SELECT_PLANS} AND ${VISIBLE} ORDER BY p.updated_at DESC`)
    .all(user.id, user.isAdmin ? 1 : 0)
    .map((row) => planRow(row));

function getPlan(db, user, id) {
  const row = db.prepare(`${SELECT_PLANS} AND p.id = ?3 AND ${VISIBLE}`)
    .get(user.id, user.isAdmin ? 1 : 0, Number(id));
  return row ? planRow(row, { withDoc: true }) : null;
}

/**
 * Changing or deleting a plan is the author's business, or an admin's.
 *
 * Deliberately NOT a course owner's: filing a plan under a course shares it to
 * be read and taught from, not handed over. A co-instructor who wants their
 * own version can save one - the document is right there.
 */
function mayWrite(db, user, plan) {
  return user.isAdmin || plan.ownerId === user.id;
}

function courseIdFor(db, user, code) {
  if (!code) return null;
  const course = db.prepare('SELECT * FROM courses WHERE code = ?').get(String(code).trim().toLowerCase());
  if (!course) throw Object.assign(new Error(`no course with the code ${code}`), { status: 400 });
  if (!user.isAdmin) {
    const member = db.prepare('SELECT 1 AS ok FROM course_members WHERE course_id = ? AND user_id = ?')
      .get(course.id, user.id);
    if (!member) throw Object.assign(new Error(`no course with the code ${code}`), { status: 400 });
  }
  return course.id;
}

const MAX_DOC_BYTES = 2 * 1024 * 1024;

function docText(doc) {
  const text = typeof doc === 'string' ? doc : JSON.stringify(doc ?? {});
  if (Buffer.byteLength(text) > MAX_DOC_BYTES) {
    throw Object.assign(new Error('that plan is too large to store'), { status: 413 });
  }
  return text;
}

function savePlan(db, user, { title, courseCode, doc }) {
  const courseId = courseIdFor(db, user, courseCode);
  const now = Date.now();
  const { lastInsertRowid } = db.prepare(`INSERT INTO plans
      (owner_id, course_id, title, doc, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
    .run(user.id, courseId, String(title || 'Untitled lecture').slice(0, 200), docText(doc), now, now);
  return getPlan(db, user, lastInsertRowid);
}

function updatePlan(db, user, id, { title, courseCode, doc }) {
  const plan = getPlan(db, user, id);
  if (!plan) throw Object.assign(new Error('no such plan'), { status: 404 });
  if (!mayWrite(db, user, plan)) {
    throw Object.assign(new Error('only the person who wrote this plan can change it'), { status: 403 });
  }
  const sets = [];
  const values = [];
  if (title !== undefined) { sets.push('title = ?'); values.push(String(title || 'Untitled lecture').slice(0, 200)); }
  if (courseCode !== undefined) { sets.push('course_id = ?'); values.push(courseIdFor(db, user, courseCode)); }
  if (doc !== undefined) { sets.push('doc = ?'); values.push(docText(doc)); }
  if (!sets.length) return plan;
  sets.push('updated_at = ?');
  values.push(Date.now(), Number(id));
  db.prepare(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getPlan(db, user, id);
}

function deletePlan(db, user, id) {
  const plan = getPlan(db, user, id);
  if (!plan) throw Object.assign(new Error('no such plan'), { status: 404 });
  if (!mayWrite(db, user, plan)) {
    throw Object.assign(new Error('only the person who wrote this plan can remove it'), { status: 403 });
  }
  db.prepare('UPDATE plans SET deleted_at = ? WHERE id = ?').run(Date.now(), Number(id));
  return plan;
}

module.exports = { listPlans, getPlan, savePlan, updatePlan, deletePlan, mayWrite, MAX_DOC_BYTES };
