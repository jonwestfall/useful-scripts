// The library, once there is a disk to keep it on.
//
// Without a server, a Podium library is content/manifest.json: a file you edit,
// commit and push, which means Tuesday's PDF is a git round trip. With one, it
// is this - upload from a browser, appear on the iPad. The shipped manifest
// keeps working and keeps being read; server items are an ADDITIONAL source
// the controller merges in, never a replacement (see loadLibrary in control.js).
//
// Two rules run through all of it:
//
// Access is by course. An item with a course is visible to that course's
// members; an item with none is visible to everyone with an account here. That
// is the whole model - a course is a tag that also grants access - and it is
// applied in SQL rather than in the caller, so there is one place to get it
// right. Admins see everything.
//
// Bytes are content-addressed. A file is stored under the SHA-256 of its
// contents, so the same deck uploaded to two courses is stored once, and
// deleting one item can never pull the bytes out from under another.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// An allow-list, not a block-list, and extensions rather than whatever the
// browser claimed the type was. Deliberately missing: .html, .htm, .svg, .xml,
// .js. Podium serves uploads from its own origin, so a file that a browser
// will execute is a file that can read the session cookie and drive the
// projector. Nothing here executes.
const UPLOADABLE = new Map(Object.entries({
  '.md': { type: 'text/markdown; charset=utf-8', kind: 'deck' },
  '.markdown': { type: 'text/markdown; charset=utf-8', kind: 'deck' },
  '.pdf': { type: 'application/pdf', kind: 'pdf' },
  '.png': { type: 'image/png', kind: 'image' },
  '.jpg': { type: 'image/jpeg', kind: 'image' },
  '.jpeg': { type: 'image/jpeg', kind: 'image' },
  '.gif': { type: 'image/gif', kind: 'image' },
  '.webp': { type: 'image/webp', kind: 'image' },
  '.mp4': { type: 'video/mp4', kind: 'video' },
  '.webm': { type: 'video/webm', kind: 'video' },
  '.mp3': { type: 'audio/mpeg', kind: 'audio' },
  '.m4a': { type: 'audio/mp4', kind: 'audio' },
  '.ogg': { type: 'audio/ogg', kind: 'audio' },
  '.wav': { type: 'audio/wav', kind: 'audio' },
}));

const uploadKindFor = (filename) => UPLOADABLE.get(path.extname(String(filename || '')).toLowerCase()) || null;

const mediaDir = (dataDir) => path.join(dataDir, 'media');
// One level of sharding: a flat directory of ten thousand files is a directory
// no tool enjoys listing.
const mediaPath = (dataDir, sha256) => path.join(mediaDir(dataDir), sha256.slice(0, 2), sha256);

// --- reading -----------------------------------------------------------------

// The access rule, written once. A row is visible when it has no course, or
// when the asker is a member of the course it has, or when the asker is an
// admin. Everything that lists or fetches goes through this.
const VISIBLE = `(
  li.course_id IS NULL
  OR ?2 = 1
  OR EXISTS (SELECT 1 FROM course_members cm WHERE cm.course_id = li.course_id AND cm.user_id = ?1)
)`;

function itemRow(row) {
  let props = {};
  try { props = JSON.parse(row.props || '{}'); } catch { /* stored by us, but never trust a parse */ }
  return {
    // props FIRST, and everything the database knows after it. props is
    // whatever the caller sent when the item was created, so spreading it last
    // would let it overwrite the item's own id, course, or who uploaded it -
    // fields that permission checks and the UI both read back. Server-owned
    // values win; a prop can only fill in what the row does not already say.
    ...props,
    id: row.id,
    type: row.kind,
    title: row.title,
    // Empty rather than a default: the client decides what an item with no
    // group of its own is filed under, and the controller files it under its
    // course. Defaulting it here would hide the course from the one place
    // that wanted it.
    group: row.group_label || '',
    course: row.course_code || null,
    filename: row.filename || '',
    bytes: row.bytes || 0,
    createdAt: row.created_at,
    createdBy: row.created_by,
    ...(row.sha256 ? { src: `/media/${row.sha256}/${encodeURIComponent(row.filename || 'file')}` } : {}),
  };
}

const SELECT_ITEMS = `
  SELECT li.*, m.sha256, m.bytes, c.code AS course_code
    FROM library_items li
    LEFT JOIN media m ON m.id = li.media_id
    LEFT JOIN courses c ON c.id = li.course_id
   WHERE li.deleted_at IS NULL`;

function listItems(db, user) {
  return db.prepare(`${SELECT_ITEMS} AND ${VISIBLE} ORDER BY li.created_at DESC`)
    .all(user.id, user.isAdmin ? 1 : 0)
    .map(itemRow);
}

function getItem(db, user, id) {
  const row = db.prepare(`${SELECT_ITEMS} AND li.id = ?3 AND ${VISIBLE}`)
    .get(user.id, user.isAdmin ? 1 : 0, Number(id));
  return row ? itemRow(row) : null;
}

/**
 * Whether this user may be handed these bytes. Asked per media request rather
 * than trusting that a SHA-256 in a URL is unguessable enough on its own - it
 * is, but "unguessable" is not an access rule.
 */
function mayReadMedia(db, user, sha256) {
  const row = db.prepare(`SELECT 1 AS ok FROM library_items li
      JOIN media m ON m.id = li.media_id
     WHERE m.sha256 = ?3 AND li.deleted_at IS NULL AND ${VISIBLE} LIMIT 1`)
    .get(user.id, user.isAdmin ? 1 : 0, String(sha256));
  if (row) return true;
  // The other way to be allowed at these bytes: they are a file kept by a
  // lecture you can see. The lecture's own visibility rule is the one that
  // decides (see server/lectures.js) - deliberately not this file's VISIBLE,
  // which is the library's and inverts for a missing course.
  const kept = db.prepare(`SELECT 1 AS ok FROM lecture_files lf
      JOIN media m ON m.id = lf.media_id
      JOIN lectures l ON l.id = lf.lecture_id
     WHERE m.sha256 = ?3
       AND (l.started_by = ?1
            OR ?2 = 1
            OR (l.course_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM course_members cm
                             WHERE cm.course_id = l.course_id AND cm.user_id = ?1)))
     LIMIT 1`)
    .get(user.id, user.isAdmin ? 1 : 0, String(sha256));
  return !!kept;
}

function listCourses(db, user) {
  const rows = user.isAdmin
    ? db.prepare('SELECT c.*, \'owner\' AS role FROM courses c WHERE c.archived_at IS NULL ORDER BY c.code').all()
    : db.prepare(`SELECT c.*, cm.role FROM courses c
          JOIN course_members cm ON cm.course_id = c.id AND cm.user_id = ?
         WHERE c.archived_at IS NULL ORDER BY c.code`).all(user.id);
  return rows.map((row) => ({ code: row.code, title: row.title || row.code, role: row.role || 'member' }));
}

// --- writing -----------------------------------------------------------------

function courseIdFor(db, user, code) {
  if (!code) return null;                            // shared with the instance
  const course = db.prepare('SELECT * FROM courses WHERE code = ?').get(String(code).trim().toLowerCase());
  if (!course) throw Object.assign(new Error(`no course with the code ${code}`), { status: 400 });
  if (!user.isAdmin) {
    const member = db.prepare('SELECT 1 AS ok FROM course_members WHERE course_id = ? AND user_id = ?')
      .get(course.id, user.id);
    // Same answer as "no such course": whether a course exists is not
    // something a non-member has any business learning.
    if (!member) throw Object.assign(new Error(`no course with the code ${code}`), { status: 400 });
  }
  return course.id;
}

/** Everything a row needs that is not the bytes. */
function addItem(db, user, { courseCode, kind, title, group, filename = '', mediaId = null, props = {} }) {
  const courseId = courseIdFor(db, user, courseCode);
  const now = Date.now();
  const { lastInsertRowid } = db.prepare(`INSERT INTO library_items
      (course_id, kind, title, group_label, media_id, filename, props, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(courseId, String(kind), String(title || filename || 'Untitled').slice(0, 200),
      String(group || '').slice(0, 80), mediaId, String(filename).slice(0, 200),
      JSON.stringify(props || {}), user.id, now, now);
  return getItem(db, user, lastInsertRowid);
}

/**
 * Take an upload: hash it on the way in, refuse it if it grows past the cap,
 * and only then give it a name. Writing to a temporary file first is what makes
 * the content-addressed name possible - you cannot know a file's hash until you
 * have all of it, and a half-written file must never appear under a name that
 * claims to be its contents.
 */
function storeUpload(dataDir, stream, { limit = MAX_UPLOAD_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const dir = mediaDir(dataDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.incoming-${crypto.randomBytes(8).toString('hex')}`);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(temp, { mode: 0o600 });
    let bytes = 0;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      fs.rm(temp, { force: true }, () => reject(err));
    };

    stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        const cap = limit >= 1024 * 1024 ? `${Math.round(limit / 1024 / 1024)} MB` : `${Math.round(limit / 1024)} KB`;
        fail(Object.assign(new Error(`that file is larger than the ${cap} limit`), { status: 413 }));
        stream.destroy();
        return;
      }
      hash.update(chunk);
    });
    stream.on('error', fail);
    out.on('error', fail);
    stream.pipe(out);

    out.on('close', () => {
      if (settled) return;
      settled = true;
      if (!bytes) { fs.rm(temp, { force: true }, () => reject(Object.assign(new Error('that file is empty'), { status: 400 }))); return; }
      const sha256 = hash.digest('hex');
      const final = mediaPath(dataDir, sha256);
      try {
        fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 });
        // Already there means someone uploaded these exact bytes before, and
        // the copy on disk is by definition identical. Keep it, drop ours.
        if (fs.existsSync(final)) fs.rmSync(temp, { force: true });
        else fs.renameSync(temp, final);
        resolve({ sha256, bytes });
      } catch (err) {
        fs.rm(temp, { force: true }, () => reject(err));
      }
    });
  });
}

/**
 * Record the bytes, reusing the row if these exact bytes are already known.
 *
 * One statement rather than SELECT-then-INSERT: two uploads of the same file
 * arriving together would both find nothing and both try to insert, and the
 * loser of that race would get a UNIQUE violation - a 500 for a request whose
 * bytes had been stored perfectly well. Letting SQLite arbitrate and then
 * reading the id back is the same work without the race.
 */
function rememberMedia(db, user, { sha256, bytes, contentType }) {
  db.prepare(`INSERT INTO media (sha256, bytes, content_type, created_at, created_by)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`)
    .run(sha256, bytes, contentType, Date.now(), user.id);
  return db.prepare('SELECT id FROM media WHERE sha256 = ?').get(sha256).id;
}

/**
 * Undo a store that nothing ended up pointing at - an upload whose item could
 * not be created. Content addressing is what makes this safe: if any live item
 * shares the hash, the row and the file are somebody else's and are left
 * exactly where they are.
 */
function forgetMediaIfUnused(db, dataDir, sha256) {
  const row = db.prepare('SELECT id FROM media WHERE sha256 = ?').get(sha256);
  if (!row) return false;
  // TWO tables point at media now: the library, and the files a session keeps
  // (see the lecture_files comment in store.js). Content addressing means a
  // photo filed with a lecture and the same photo uploaded to the library are
  // one set of bytes, so "nobody is using this any more" has to be asked of
  // both - forgetting to ask the second is how a lecture's record would lose
  // its pictures the day somebody tidied the library.
  const inUse = db.prepare(
    `SELECT 1 AS ok FROM library_items WHERE media_id = ?1 AND deleted_at IS NULL
      UNION ALL
     SELECT 1 AS ok FROM lecture_files WHERE media_id = ?1
     LIMIT 1`,
  ).get(row.id);
  if (inUse) return false;
  db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
  try { fs.rmSync(mediaPath(dataDir, sha256), { force: true }); } catch { /* already gone */ }
  return true;
}

function renameItem(db, user, id, { title, group, courseCode }) {
  const item = getItem(db, user, id);
  if (!item) throw Object.assign(new Error('no such item'), { status: 404 });
  // Seeing an item is not permission to change it. Re-filing one under a
  // different course - or under none, which means everyone - moves it between
  // access scopes, so editing needs the same standing as removing: the person
  // who uploaded it, a course owner, or an admin.
  if (!mayDelete(db, user, item)) {
    throw Object.assign(new Error('only the person who added this, a course owner, or an admin can change it'), { status: 403 });
  }

  // Built from a fixed set of literals - the values are always bound, never
  // interpolated - because the alternative (one statement with COALESCE and a
  // flag per column) was unreadable and got its own parameter numbering wrong.
  const sets = [];
  const values = [];
  if (title !== undefined) { sets.push('title = ?'); values.push(String(title).slice(0, 200)); }
  if (group !== undefined) { sets.push('group_label = ?'); values.push(String(group).slice(0, 80)); }
  if (courseCode !== undefined) { sets.push('course_id = ?'); values.push(courseIdFor(db, user, courseCode)); }
  if (!sets.length) return item;

  sets.push('updated_at = ?');
  values.push(Date.now(), Number(id));
  db.prepare(`UPDATE library_items SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getItem(db, user, id);
}

/**
 * Who may delete: an admin, the person who uploaded it, or an owner of the
 * course it belongs to. Explicitly NOT an ordinary course member - a TA can
 * add to the library and present from it, which is what was asked for, and
 * deleting shared materials by accident is the thing worth making harder.
 */
function mayDelete(db, user, item) {
  if (user.isAdmin || item.createdBy === user.id) return true;
  if (!item.course) return false;
  const row = db.prepare(`SELECT cm.role FROM course_members cm
      JOIN courses c ON c.id = cm.course_id
     WHERE c.code = ? AND cm.user_id = ?`).get(item.course, user.id);
  return row?.role === 'owner';
}

/**
 * Soft delete. The bytes stay: another item may point at the same hash, and
 * sweeping unreferenced media is a job for a scheduled task that can afford to
 * be careful, not for a click in a web page.
 */
function deleteItem(db, user, id) {
  const item = getItem(db, user, id);
  if (!item) throw Object.assign(new Error('no such item'), { status: 404 });
  if (!mayDelete(db, user, item)) {
    throw Object.assign(new Error('only the person who added this, a course owner, or an admin can remove it'), { status: 403 });
  }
  db.prepare('UPDATE library_items SET deleted_at = ? WHERE id = ?').run(Date.now(), Number(id));
  return item;
}

function usage(db) {
  const row = db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM media
     WHERE id IN (SELECT media_id FROM library_items WHERE deleted_at IS NULL AND media_id IS NOT NULL)`).get();
  return { files: row.files, bytes: row.bytes };
}

module.exports = {
  MAX_UPLOAD_BYTES, UPLOADABLE, uploadKindFor, mediaPath,
  listItems, getItem, listCourses, mayReadMedia, courseIdFor,
  addItem, storeUpload, rememberMedia, forgetMediaIfUnused,
  renameItem, deleteItem, mayDelete, usage,
};
