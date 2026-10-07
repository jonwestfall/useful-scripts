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

// Owner, or a member of the course it has been filed under (while that course
// is not archived), or an admin. Archiving is documented as making everything
// filed under a course stop being listed to its members - so the archived
// check gates only the membership branch; the author keeps their own plan
// regardless, the same as they would if they simply left the course. `c` is
// SELECT_PLANS's own join of courses.
// ?1 = user id, ?2 = 1 for an admin.
const VISIBLE = `(
  p.owner_id = ?1
  OR ?2 = 1
  OR (p.course_id IS NOT NULL AND c.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM course_members cm WHERE cm.course_id = p.course_id AND cm.user_id = ?1))
)`;

// pa: whether the CALLER (?1) has archived this plan from their own list
// (Issue #239) - one person's tidying, never anyone else's.
const SELECT_PLANS = `
  SELECT p.*, c.code AS course_code, u.username AS owner_name, pa.archived_at AS archived_at
    FROM plans p
    LEFT JOIN courses c ON c.id = p.course_id
    LEFT JOIN users u ON u.id = p.owner_id
    LEFT JOIN plan_archive pa ON pa.plan_id = p.id AND pa.user_id = ?1
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
    // Archived from this caller's own list (Issue #239), and when.
    archived: !!row.archived_at,
    archivedAt: row.archived_at || null,
  };
  // The document itself is only sent when one plan was asked for. A list of
  // twenty lectures is a list of twenty names, not twenty lecture plans.
  if (!withDoc) return summary;
  let doc;
  try { doc = JSON.parse(row.doc); } catch { doc = null; }
  return { ...summary, doc };
}

/**
 * Every plan this user can see, newest change first. `archived` narrows it to
 * the ones they have archived (true) or not (false); left out, both, each
 * saying which it is.
 */
function listPlans(db, user, { archived } = {}) {
  const which = archived === undefined ? '' : archived ? ' AND pa.archived_at IS NOT NULL' : ' AND pa.archived_at IS NULL';
  return db.prepare(`${SELECT_PLANS} AND ${VISIBLE}${which} ORDER BY p.updated_at DESC`)
    .all(user.id, user.isAdmin ? 1 : 0)
    .map((row) => planRow(row));
}

function getPlan(db, user, id) {
  const row = db.prepare(`${SELECT_PLANS} AND p.id = ?3 AND ${VISIBLE}`)
    .get(user.id, user.isAdmin ? 1 : 0, Number(id));
  return row ? planRow(row, { withDoc: true }) : null;
}

/**
 * The plan doc a kiosk's schedule currently names (Issue #152), with no
 * owner/course VISIBLE check at all - a kiosk has no user identity to check
 * one against, and the check that matters already happened when an
 * administrator assigned this id to the profile in the first place
 * (server/kiosks.js's schedule and plan_id are both admin-only writes).
 * Still never hands back a deleted plan - that is what "assigned to
 * something gone" resolves to as far as a kiosk is concerned, same as an
 * id nobody ever wrote.
 */
function getPlanForKiosk(db, id) {
  // ?1 is SELECT_PLANS's own "whose archive" - nobody's, for a kiosk.
  const row = db.prepare(`${SELECT_PLANS} AND p.id = ?2`).get(0, Number(id));
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
  // The same rail library.js's courseIdFor enforces, and for the same reason:
  // VISIBLE already stops answering for an archived course's plans, so filing
  // one there would "succeed" into a plan that disappears from its own
  // sharing scope the instant it is saved.
  if (course.archived_at) {
    throw Object.assign(new Error(`${course.code} is archived and cannot be filed under any more`), { status: 409 });
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

// baseUpdatedAt is the updatedAt this write was staged against - undefined
// (an older client, or a script that never asked) skips the check entirely,
// same as before this existed. When it is given, it has to still match: two
// devices (or two tabs) editing the same plan is not a locking error, it is
// instructors actually doing this, and the one that saves second silently
// winning is exactly how the first one's changes go missing with no message
// at all.
function updatePlan(db, user, id, { title, courseCode, doc, baseUpdatedAt }) {
  const plan = getPlan(db, user, id);
  if (!plan) throw Object.assign(new Error('no such plan'), { status: 404 });
  if (!mayWrite(db, user, plan)) {
    throw Object.assign(new Error('only the person who wrote this plan can change it'), { status: 403 });
  }
  if (baseUpdatedAt !== undefined && Number(baseUpdatedAt) !== plan.updatedAt) {
    throw Object.assign(new Error('this plan changed on the server since it was opened here'), { status: 409 });
  }
  const sets = [];
  const values = [];
  if (title !== undefined) { sets.push('title = ?'); values.push(String(title || 'Untitled lecture').slice(0, 200)); }
  if (courseCode !== undefined) { sets.push('course_id = ?'); values.push(courseIdFor(db, user, courseCode)); }
  if (doc !== undefined) { sets.push('doc = ?'); values.push(docText(doc)); }
  if (!sets.length) return plan;
  // Strictly later than the updatedAt it replaces, never just Date.now():
  // updatedAt is the only thing the check above compares, so a save that
  // leaves it where it was is invisible to every other device. Two saves in
  // the same millisecond (a fast machine, or an autosave racing a manual
  // save) would otherwise stamp the same value twice, and a tab still
  // holding the first one would sail through the second as if nothing had
  // changed. The clock going backwards (NTP stepping it, a restored VM) is
  // the same failure more slowly, and this covers that too - updatedAt is a
  // version number first and a timestamp second.
  sets.push('updated_at = ?');
  values.push(Math.max(Date.now(), plan.updatedAt + 1), Number(id));
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

// --- archiving from one's own list (Issue #239) ----------------------------------

const MAX_ARCHIVE_IDS = 1000;

/**
 * Archive (or bring back) plans in this user's own planner list. Personal:
 * anyone may archive anything they can see, and it changes nothing for
 * anyone else. Ids this user cannot see are skipped, not an error - a list
 * gone stale on another device should not make the rest of a bulk tidy fail.
 *
 * @returns {{changed: number[], skipped: number[]}}
 */
function setArchived(db, user, ids, archived) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!wanted.length) throw Object.assign(new Error('which lectures?'), { status: 400 });
  if (wanted.length > MAX_ARCHIVE_IDS) {
    throw Object.assign(new Error(`at most ${MAX_ARCHIVE_IDS} lectures at a time`), { status: 413 });
  }
  const changed = [];
  const skipped = [];
  const now = Date.now();
  const put = db.prepare('INSERT OR IGNORE INTO plan_archive (user_id, plan_id, archived_at) VALUES (?, ?, ?)');
  const take = db.prepare('DELETE FROM plan_archive WHERE user_id = ? AND plan_id = ?');
  db.exec('BEGIN');
  try {
    for (const id of wanted) {
      if (!getPlan(db, user, id)) { skipped.push(id); continue; }
      if (archived) put.run(user.id, id, now); else take.run(user.id, id);
      changed.push(id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { changed, skipped };
}

module.exports = {
  listPlans, getPlan, getPlanForKiosk, savePlan, updatePlan, deletePlan, mayWrite, setArchived, MAX_DOC_BYTES, MAX_ARCHIVE_IDS,
};
