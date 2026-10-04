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
const { Readable } = require('node:stream');

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
// when the asker is a member of the course it has AND that course is not
// archived, or when the asker is an admin. Archiving a course is documented
// (VPS.md) as making everything filed under it stop being listed - so the
// archived check gates the membership branch specifically, rather than being
// a separate top-level condition, and an admin (who can also un-archive a
// course) is never blocked by it. Everything that lists or fetches goes
// through this; SELECT_ITEMS below is what makes `c` (courses) available here.
const VISIBLE = `(
  li.course_id IS NULL
  OR ?2 = 1
  OR (c.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM course_members cm WHERE cm.course_id = li.course_id AND cm.user_id = ?1))
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
    // A deck can be edited (Issue #226), and everything that points at one -
    // a plan, the manifest, a controller's library - should see the edit. So a
    // deck's src is a stable address that always serves its current version,
    // and `version` (the sha of what is there now) is what an editor checks
    // before saving over it. The content-addressed URL above still answers
    // for anyone holding it; it is just no longer what a deck hands out.
    ...(row.sha256 && row.kind === 'deck' ? {
      src: deckSrc(row.id, row.filename),
      version: row.sha256,
    } : {}),
  };
}

/** The address a deck is always reachable at, whatever its current contents. */
function deckSrc(id, filename) {
  return `/media/deck/${Number(id)}/${encodeURIComponent(filename || 'deck.md')}`;
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
    .map(itemRow)
    // Said per deck, so the planner and controller can offer Edit only where
    // saving would be allowed (Issue #226).
    .map((item) => (item.type === 'deck' ? { ...item, editable: mayEditDeck(db, user, item) } : item));
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
      LEFT JOIN courses c ON c.id = li.course_id
     WHERE m.sha256 = ?3 AND li.deleted_at IS NULL AND ${VISIBLE} LIMIT 1`)
    .get(user.id, user.isAdmin ? 1 : 0, String(sha256));
  if (row) return true;
  // One of the slides of a picture deck you can see (Issue #106): those files
  // hang off the item through library_item_files rather than media_id.
  const slide = db.prepare(`SELECT 1 AS ok FROM library_item_files lif
      JOIN media m ON m.id = lif.media_id
      JOIN library_items li ON li.id = lif.item_id
      LEFT JOIN courses c ON c.id = li.course_id
     WHERE m.sha256 = ?3 AND li.deleted_at IS NULL AND ${VISIBLE} LIMIT 1`)
    .get(user.id, user.isAdmin ? 1 : 0, String(sha256));
  if (slide) return true;
  // An earlier version of a deck you can see (Issue #226): what it used to say.
  const revision = db.prepare(`SELECT 1 AS ok FROM deck_revisions dr
      JOIN media m ON m.id = dr.media_id
      JOIN library_items li ON li.id = dr.item_id
      LEFT JOIN courses c ON c.id = li.course_id
     WHERE m.sha256 = ?3 AND li.deleted_at IS NULL AND ${VISIBLE} LIMIT 1`)
    .get(user.id, user.isAdmin ? 1 : 0, String(sha256));
  if (revision) return true;
  // The other way to be allowed at these bytes: they are a file kept by a
  // lecture you can see. The lecture's own visibility rule is the one that
  // decides (see the VISIBLE comment in server/lectures.js) - deliberately
  // not this file's VISIBLE, which is the library's and inverts for a missing
  // course. Kept in sync with lectures.js's VISIBLE by hand rather than
  // shared, because lectures.js already requires this file and the reverse
  // require would be circular.
  const kept = db.prepare(`SELECT 1 AS ok FROM lecture_files lf
      JOIN media m ON m.id = lf.media_id
      JOIN lectures l ON l.id = lf.lecture_id
      LEFT JOIN courses c ON c.id = l.course_id
     WHERE m.sha256 = ?3
       AND (l.started_by = ?1
            OR ?2 = 1
            OR (l.course_id IS NOT NULL AND c.archived_at IS NULL
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
  // Filing something new under an archived course is worse than refusing
  // outright: VISIBLE already stops answering for one, so a write that
  // "succeeds" here would insert a row that getItem() can then never find -
  // a 200 response for an item that is quietly nowhere.
  if (course.archived_at) {
    throw Object.assign(new Error(`${course.code} is archived and cannot be filed under any more`), { status: 409 });
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
     SELECT 1 AS ok FROM library_item_files lif
       JOIN library_items li ON li.id = lif.item_id
      WHERE lif.media_id = ?1 AND li.deleted_at IS NULL
      UNION ALL
     SELECT 1 AS ok FROM lecture_files WHERE media_id = ?1
      UNION ALL
     SELECT 1 AS ok FROM deck_revisions WHERE media_id = ?1
     LIMIT 1`,
  ).get(row.id);
  if (inUse) return false;
  db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
  try { fs.rmSync(mediaPath(dataDir, sha256), { force: true }); } catch { /* already gone */ }
  return true;
}

/**
 * The files of a many-file item (a picture deck), in order. The item itself is
 * made by addItem as usual; this records which stored bytes it is made of.
 */
function setItemFiles(db, itemId, mediaIds) {
  const insert = db.prepare('INSERT INTO library_item_files (item_id, media_id, position) VALUES (?, ?, ?)');
  mediaIds.forEach((mediaId, i) => insert.run(Number(itemId), mediaId, i));
}

/**
 * An item this user can already see with exactly these bytes - what a ZIP
 * import in the planner reports as "already in library" rather than adding a
 * second copy. One file: same media and kind. Several (a picture deck): the
 * same files in the same order.
 */
function findDuplicate(db, user, { kind, sha256s }) {
  const visible = (sql, ...args) => db.prepare(`${SELECT_ITEMS} AND ${VISIBLE} AND ${sql}`)
    .all(user.id, user.isAdmin ? 1 : 0, ...args);
  if (sha256s.length === 1) {
    const [row] = visible('li.kind = ?3 AND m.sha256 = ?4 LIMIT 1', String(kind), sha256s[0]);
    return row ? itemRow(row) : null;
  }
  const wanted = sha256s.join(',');
  const candidates = visible(`li.kind = ?3 AND li.id IN (
      SELECT lif.item_id FROM library_item_files lif JOIN media fm ON fm.id = lif.media_id
       WHERE lif.position = 0 AND fm.sha256 = ?4)`, String(kind), sha256s[0]);
  const filesOf = db.prepare(`SELECT m.sha256 FROM library_item_files lif JOIN media m ON m.id = lif.media_id
     WHERE lif.item_id = ? ORDER BY lif.position`);
  const match = candidates.find((row) => filesOf.all(row.id).map((f) => f.sha256).join(',') === wanted);
  return match ? itemRow(match) : null;
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
 * Who may change a deck's contents (Issue #226): an admin; for a deck filed
 * under a course, that course's owners; for one filed under none, the person
 * who added it. "Everyone connected to the deck except TAs" - and a TA is
 * what a plain course member is, so a member who uploaded a course deck can
 * present it but not rewrite it. Narrower than mayDelete on purpose.
 */
function mayEditDeck(db, user, item) {
  if (user.isAdmin) return true;
  if (!item.course) return item.createdBy === user.id;
  const row = db.prepare(`SELECT cm.role FROM course_members cm
      JOIN courses c ON c.id = cm.course_id
     WHERE c.code = ? AND cm.user_id = ?`).get(item.course, user.id);
  return row?.role === 'owner';
}

// --- a deck's pictures and videos (Issue #226) ---------------------------------
//
// What the deck editor uploads lands in the library like any other upload,
// in a "Deck media" group and with a deckMedia prop naming the deck, so the
// controller can keep it out of the way of the things you would pick to
// show. Filed under the deck's course, or none.

const DECK_MEDIA_GROUP = 'Deck media';

/**
 * Whether this user may file deck media under a course: the same people who
 * may edit that course's decks (its owners, and admins). No course is open to
 * anyone with an account, as for any upload.
 */
function mayAddDeckMedia(db, user, courseCode) {
  if (!courseCode || user.isAdmin) return true;
  const row = db.prepare(`SELECT cm.role FROM course_members cm
      JOIN courses c ON c.id = cm.course_id
     WHERE c.code = ? AND cm.user_id = ?`).get(String(courseCode).trim().toLowerCase(), user.id);
  return row?.role === 'owner';
}

/**
 * The same bytes already in the library, as the same kind and filed under the
 * same course (or none), visible to this user - so a photo put on two slides,
 * or into two decks, is one library item rather than two.
 */
function findSameMedia(db, user, { kind, sha256, courseCode }) {
  const code = String(courseCode || '').trim().toLowerCase();
  const row = db.prepare(`${SELECT_ITEMS} AND ${VISIBLE} AND li.kind = ?3 AND m.sha256 = ?4
      AND ${code ? 'c.code = ?5' : 'li.course_id IS NULL'} ORDER BY li.id LIMIT 1`)
    .get(user.id, user.isAdmin ? 1 : 0, String(kind), String(sha256), ...(code ? [code] : []));
  return row ? itemRow(row) : null;
}

// Generous for markdown - a deck is text; its pictures live beside it.
const MAX_DECK_SOURCE_BYTES = 2 * 1024 * 1024;

/**
 * Replace a deck's markdown, keeping the item (Issue #226). The new text is
 * stored as new content-addressed media and the item re-pointed at it, so the
 * deck's stable src serves the edit from now on. The old bytes are left where
 * they are: another item may share them, and they are what a later "previous
 * versions" would list.
 *
 * `ifMatch` is the version the editor opened. If the deck has changed since,
 * nothing is written and the 412 carries the version that is there now, so
 * the editor can offer overwrite / save a copy / reload.
 */
async function replaceDeckContent(db, user, dataDir, id, text, { ifMatch = '' } = {}) {
  const item = getItem(db, user, id);
  if (!item) throw Object.assign(new Error('no such item'), { status: 404 });
  if (item.type !== 'deck') throw Object.assign(new Error('only a deck can be edited this way'), { status: 400 });
  if (!mayEditDeck(db, user, item)) {
    throw Object.assign(new Error(item.course
      ? `only an owner of ${item.course.toUpperCase()} or an admin can change this deck`
      : 'only the person who added this deck, or an admin, can change it'), { status: 403 });
  }
  const wanted = String(ifMatch || '').replace(/^W\//, '').replace(/"/g, '');
  if (wanted && wanted !== item.version) {
    throw Object.assign(new Error('this deck was changed by someone else since you opened it'), { status: 412, version: item.version });
  }
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  if (buf.length > MAX_DECK_SOURCE_BYTES) {
    throw Object.assign(new Error(`a deck can be at most ${MAX_DECK_SOURCE_BYTES / (1024 * 1024)} MB of text`), { status: 413 });
  }
  const { sha256, bytes } = await storeUpload(dataDir, Readable.from([buf]), { limit: MAX_DECK_SOURCE_BYTES });
  if (sha256 === item.version) return item;   // nothing changed: no new version to keep
  const mediaId = rememberMedia(db, user, { sha256, bytes, contentType: UPLOADABLE.get('.md').type });
  const now = Date.now();
  const was = db.prepare('SELECT media_id FROM library_items WHERE id = ?').get(Number(id)).media_id;
  // The version being replaced becomes a revision, then the oldest beyond
  // the last few are let go (their bytes too, if nothing else holds them).
  if (was) {
    db.prepare('INSERT INTO deck_revisions (item_id, media_id, saved_at, saved_by) VALUES (?, ?, ?, ?)')
      .run(Number(id), was, now, user.id);
  }
  db.prepare('UPDATE library_items SET media_id = ?, updated_at = ? WHERE id = ?').run(mediaId, now, Number(id));
  const old = db.prepare(`SELECT dr.id, m.sha256 FROM deck_revisions dr JOIN media m ON m.id = dr.media_id
      WHERE dr.item_id = ? ORDER BY dr.saved_at DESC, dr.id DESC LIMIT -1 OFFSET ?`).all(Number(id), MAX_DECK_REVISIONS);
  for (const row of old) {
    db.prepare('DELETE FROM deck_revisions WHERE id = ?').run(row.id);
    forgetMediaIfUnused(db, dataDir, row.sha256);
  }
  return getItem(db, user, id);
}

/**
 * The library deck a content address belongs to - its current version, or one
 * of its earlier ones - for a plan or manifest that points at a deck by the
 * address it had before decks got a stable one. Null when no deck this user
 * can see holds those bytes.
 */
function deckForVersion(db, user, sha256) {
  const row = db.prepare(`${SELECT_ITEMS} AND ${VISIBLE} AND li.kind = 'deck' AND (m.sha256 = ?3
      OR EXISTS (SELECT 1 FROM deck_revisions dr JOIN media rm ON rm.id = dr.media_id
                  WHERE dr.item_id = li.id AND rm.sha256 = ?3))
    ORDER BY (m.sha256 = ?3) DESC, li.updated_at DESC LIMIT 1`)
    .get(user.id, user.isAdmin ? 1 : 0, String(sha256).toLowerCase());
  if (!row) return null;
  const item = itemRow(row);
  return { ...item, editable: mayEditDeck(db, user, item), current: item.version === String(sha256).toLowerCase() };
}

// How many earlier versions of a deck are kept. A deck is a few kilobytes of
// text, so this is about keeping the list useful, not about disk.
const MAX_DECK_REVISIONS = 20;

/**
 * A deck's earlier versions, newest first (Issue #226): each one the version
 * that was there until someone saved over it, when, and who saved over it.
 * Anyone who can see the deck can see them - they are what it used to say.
 */
function deckRevisions(db, user, id) {
  const item = getItem(db, user, id);
  if (!item) throw Object.assign(new Error('no such item'), { status: 404 });
  if (item.type !== 'deck') throw Object.assign(new Error('only a deck has versions'), { status: 400 });
  return db.prepare(`SELECT m.sha256, m.bytes, dr.saved_at, u.display_name, u.username
      FROM deck_revisions dr JOIN media m ON m.id = dr.media_id LEFT JOIN users u ON u.id = dr.saved_by
     WHERE dr.item_id = ? ORDER BY dr.saved_at DESC, dr.id DESC`).all(Number(id))
    .map((row) => ({ version: row.sha256, bytes: row.bytes, replacedAt: row.saved_at, replacedBy: row.display_name || row.username || null }));
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
     WHERE id IN (SELECT media_id FROM library_items WHERE deleted_at IS NULL AND media_id IS NOT NULL)
        OR id IN (SELECT lif.media_id FROM library_item_files lif
                    JOIN library_items li ON li.id = lif.item_id WHERE li.deleted_at IS NULL)`).get();
  return { files: row.files, bytes: row.bytes };
}

module.exports = {
  MAX_UPLOAD_BYTES, UPLOADABLE, uploadKindFor, mediaPath,
  DECK_MEDIA_GROUP, mayAddDeckMedia, findSameMedia, deckRevisions, deckForVersion, MAX_DECK_REVISIONS,
  listItems, getItem, listCourses, mayReadMedia, courseIdFor,
  addItem, setItemFiles, findDuplicate, storeUpload, rememberMedia, forgetMediaIfUnused,
  renameItem, deleteItem, mayDelete, usage,
  mayEditDeck, replaceDeckContent, deckSrc, MAX_DECK_SOURCE_BYTES,
};
