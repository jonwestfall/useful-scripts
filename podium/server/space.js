// Where the disk went, and getting it back (Admin › Storage).
//
// Three things an administrator needs at the end of a term:
//
//   report()  what the server is holding, by kind, by course and by person -
//             and how much of it is already spoken for by nothing (files
//             deleted from the library but still on disk, files no table
//             points at), which is space to be had for the asking.
//   tidy()    takes that space back.
//   remove()  takes a course's files, lectures and recorded lectures off the
//             server - normally once they have been backed up (backup.js),
//             which the route checks unless told not to.
//
// Bytes are counted per stored file, the way they sit on disk: the store is
// content-addressed, so a PDF uploaded to two courses is one file, counted
// once in the server's totals and in each course's own figure. A course's
// "frees about" is what would actually come back if it went: only the files
// nothing outside it still uses.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const library = require('./library.js');
const lectures = require('./lectures.js');
const store = require('./store.js');

// A file this young may be an upload whose row is a moment away.
const SETTLE_MS = 60 * 60 * 1000;

const safeList = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

function dirBytes(dir, depth = 0) {
  let total = 0;
  for (const name of safeList(dir)) {
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isDirectory() && depth < 12) total += dirBytes(full, depth + 1);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

/** What uses each stored file: media id -> { live, deleted, revision, session, courses:Set, people:Set } */
function uses(db) {
  const map = new Map();
  const at = (id) => {
    if (!map.has(id)) map.set(id, { live: false, deleted: false, revision: false, session: false, courses: new Set(), people: new Set() });
    return map.get(id);
  };
  const itemRows = db.prepare(`SELECT li.media_id AS media, li.course_id, li.created_by, li.deleted_at FROM library_items li WHERE li.media_id IS NOT NULL
      UNION ALL
     SELECT lif.media_id, li.course_id, li.created_by, li.deleted_at FROM library_item_files lif JOIN library_items li ON li.id = lif.item_id`).all();
  for (const r of itemRows) {
    const u = at(r.media);
    if (r.deleted_at) { u.deleted = true; continue; }
    u.live = true;
    u.courses.add(r.course_id ?? 0);
    if (r.created_by) u.people.add(r.created_by);
  }
  for (const r of db.prepare(`SELECT dr.media_id AS media, li.course_id, li.created_by, li.deleted_at FROM deck_revisions dr
      JOIN library_items li ON li.id = dr.item_id`).all()) {
    const u = at(r.media);
    if (r.deleted_at) { u.deleted = true; continue; }
    u.revision = true;
    u.courses.add(r.course_id ?? 0);
    if (r.created_by) u.people.add(r.created_by);
  }
  for (const r of db.prepare(`SELECT lf.media_id AS media, l.course_id, l.started_by FROM lecture_files lf
      JOIN lectures l ON l.id = lf.lecture_id`).all()) {
    const u = at(r.media);
    u.session = true;
    u.courses.add(r.course_id ?? 0);
    if (r.started_by) u.people.add(r.started_by);
  }
  return map;
}

/** Files on disk under media/ that no row knows, old enough not to be an upload in flight. */
function strayFiles(db, dataDir, now = Date.now()) {
  const known = new Set(db.prepare('SELECT sha256 FROM media').all().map((r) => r.sha256));
  const out = [];
  const mediaDir = path.join(dataDir, 'media');
  for (const shard of safeList(mediaDir)) {
    for (const name of safeList(path.join(mediaDir, shard))) {
      if (name.startsWith('.incoming-') || known.has(name)) continue;
      const full = path.join(mediaDir, shard, name);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && now - stat.mtimeMs > SETTLE_MS) out.push({ file: full, bytes: stat.size });
      } catch { /* gone already */ }
    }
  }
  return out;
}

/**
 * The whole picture, for the Storage tab.
 * @param {{dataDir: string, contentDir?: string}} where
 */
function report(db, { dataDir, contentDir }) {
  const media = db.prepare('SELECT id, sha256, bytes, created_at FROM media').all();
  const used = uses(db);
  const now = Date.now();
  const kinds = {
    library: { files: 0, bytes: 0 },
    revisions: { files: 0, bytes: 0 },
    sessions: { files: 0, bytes: 0 },
    deleted: { files: 0, bytes: 0 },
    unused: { files: 0, bytes: 0 },
  };
  const courseIds = db.prepare('SELECT id, code, title, archived_at FROM courses').all();
  const perCourse = new Map([[0, { code: null, title: 'No course', archived: false }], ...courseIds.map((c) => [c.id, { code: c.code, title: c.title, archived: !!c.archived_at }])]);
  for (const c of perCourse.values()) Object.assign(c, { libraryBytes: 0, sessionBytes: 0, sharedBytes: 0, freesBytes: 0 });
  const people = new Map();
  for (const m of media) {
    const u = used.get(m.id);
    const kind = !u ? 'unused'
      : u.live ? 'library'
        : u.session ? 'sessions'
          : u.revision ? 'revisions'
            : u.deleted ? 'deleted' : 'unused';
    // A row nothing points at, younger than an hour, is most likely an upload
    // about to be filed: not counted as spare.
    if (kind === 'unused' && now - m.created_at < SETTLE_MS) continue;
    kinds[kind].files += 1;
    kinds[kind].bytes += m.bytes;
    if (!u) continue;
    for (const id of u.courses) {
      const c = perCourse.get(id);
      if (!c) continue;
      if (u.live || u.revision) c.libraryBytes += m.bytes;
      if (u.session && !u.live) c.sessionBytes += m.bytes;
      if (u.courses.size > 1) c.sharedBytes += m.bytes;
      else c.freesBytes += m.bytes;
    }
    for (const id of u.people) {
      if (!people.has(id)) people.set(id, { bytes: 0, files: 0 });
      const p = people.get(id);
      p.bytes += m.bytes;
      p.files += 1;
    }
  }
  const stray = strayFiles(db, dataDir, now);
  kinds.unused.files += stray.length;
  kinds.unused.bytes += stray.reduce((n, s) => n + s.bytes, 0);

  const count = (sql) => new Map(db.prepare(sql).all().map((r) => [r.id ?? 0, r]));
  const items = count('SELECT course_id AS id, COUNT(*) AS n, MAX(updated_at) AS last FROM library_items WHERE deleted_at IS NULL GROUP BY course_id');
  const plans = count('SELECT course_id AS id, COUNT(*) AS n, MAX(updated_at) AS last FROM plans WHERE deleted_at IS NULL GROUP BY course_id');
  const sessions = count('SELECT course_id AS id, COUNT(*) AS n, MAX(started_at) AS last FROM lectures GROUP BY course_id');
  const courses = [...perCourse.entries()].map(([id, c]) => ({
    ...c,
    items: items.get(id)?.n || 0,
    plans: plans.get(id)?.n || 0,
    lectures: sessions.get(id)?.n || 0,
    lastUsed: Math.max(items.get(id)?.last || 0, plans.get(id)?.last || 0, sessions.get(id)?.last || 0) || null,
  })).filter((c) => c.code || c.items || c.plans || c.lectures);

  const names = new Map(db.prepare('SELECT id, username, display_name FROM users').all().map((u) => [u.id, u]));
  const owned = (sql) => new Map(db.prepare(sql).all().map((r) => [r.id, r.n]));
  const planCount = owned('SELECT owner_id AS id, COUNT(*) AS n FROM plans WHERE deleted_at IS NULL GROUP BY owner_id');
  const itemCount = owned('SELECT created_by AS id, COUNT(*) AS n FROM library_items WHERE deleted_at IS NULL GROUP BY created_by');
  const peopleList = [...people.entries()].map(([id, p]) => ({
    username: names.get(id)?.username || '(removed account)',
    name: names.get(id)?.display_name || '',
    bytes: p.bytes, files: p.files, items: itemCount.get(id) || 0, plans: planCount.get(id) || 0,
  })).sort((a, b) => b.bytes - a.bytes).slice(0, 50);

  let database = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { database += fs.statSync(path.join(dataDir, `podium.db${suffix}`)).size; } catch { /* not there */ }
  }
  return {
    disk: store.diskPressure(dataDir),
    dataDir,
    database,
    content: contentDir ? dirBytes(contentDir) : 0,
    kinds,
    reclaimable: { files: kinds.deleted.files + kinds.unused.files, bytes: kinds.deleted.bytes + kinds.unused.bytes },
    courses: courses.sort((a, b) => (b.libraryBytes + b.sessionBytes) - (a.libraryBytes + a.sessionBytes)),
    people: peopleList,
  };
}

/**
 * Take back the space nothing uses: library items deleted from the library
 * (gone for good now - until this they could still have been brought back
 * from the database), their files where nothing else holds them, stored
 * files no table points at, and files on disk the database never knew.
 * Nothing younger than an hour, which may be an upload in flight.
 */
function tidy(db, dataDir, { now = Date.now() } = {}) {
  let bytes = 0;
  let files = 0;
  const forget = (sha256, size) => { if (library.forgetMediaIfUnused(db, dataDir, sha256)) { bytes += size; files += 1; } };

  const deleted = db.prepare('SELECT id FROM library_items WHERE deleted_at IS NOT NULL').all();
  const heldBy = db.prepare(`SELECT m.sha256, m.bytes FROM media m WHERE m.id IN (
      SELECT media_id FROM library_items WHERE id = ?1 AND media_id IS NOT NULL
      UNION SELECT media_id FROM library_item_files WHERE item_id = ?1
      UNION SELECT media_id FROM deck_revisions WHERE item_id = ?1)`);
  for (const { id } of deleted) {
    const held = heldBy.all(id);
    db.prepare('DELETE FROM library_items WHERE id = ?').run(id);
    for (const m of held) forget(m.sha256, m.bytes);
  }
  for (const m of db.prepare('SELECT sha256, bytes FROM media WHERE created_at < ?').all(now - SETTLE_MS)) forget(m.sha256, m.bytes);
  for (const s of strayFiles(db, dataDir, now)) {
    try { fs.rmSync(s.file, { force: true }); bytes += s.bytes; files += 1; } catch { /* leave it */ }
  }
  return { items: deleted.length, files, bytes };
}

/**
 * Take courses' things off the server: their library (deck media and earlier
 * versions with it), their lectures (plans), and their recorded lectures,
 * as asked. Each stored file goes only once nothing else uses it - a PDF
 * another course also has stays. Administrators only; the route checks.
 *
 * @param {object} what
 * @param {string[]} what.courses  codes; '' for "No course" (library items filed under none)
 * @param {boolean} [what.library=true]
 * @param {boolean} [what.plans=true]
 * @param {boolean} [what.recorded=true]
 * @param {boolean} [what.archive=false]  archive each course afterwards
 */
function remove(db, admin, dataDir, { courses = [], library: lib = true, plans = true, recorded = true, archive = false } = {}) {
  if (!admin?.isAdmin) throw Object.assign(new Error('only an administrator can remove a course\'s files'), { status: 403 });
  const codes = [...new Set(courses.map((c) => String(c ?? '').trim().toLowerCase()))];
  if (!codes.length) throw Object.assign(new Error('choose at least one course'), { status: 400 });
  const ids = codes.map((code) => {
    if (code === '') return { code, id: null };
    const row = db.prepare('SELECT id FROM courses WHERE code = ?').get(code);
    if (!row) throw Object.assign(new Error(`no course called ${code.toUpperCase()}`), { status: 404 });
    return { code, id: row.id };
  });
  const result = { items: 0, plans: 0, lectures: 0, files: 0, bytes: 0, archived: [] };
  const before = (sha256) => db.prepare('SELECT bytes FROM media WHERE sha256 = ?').get(sha256)?.bytes || 0;
  const forget = (sha256) => {
    const size = before(sha256);
    if (library.forgetMediaIfUnused(db, dataDir, sha256)) { result.bytes += size; result.files += 1; }
  };
  const where = (col, id) => (id === null ? `${col} IS NULL` : `${col} = ${Number(id)}`);
  for (const { code, id } of ids) {
    if (lib) {
      const rows = db.prepare(`SELECT id FROM library_items WHERE ${where('course_id', id)}`).all();
      const held = new Set();
      for (const r of rows) {
        for (const m of db.prepare(`SELECT m.sha256 FROM media m WHERE m.id IN (
            SELECT media_id FROM library_items WHERE id = ?1 AND media_id IS NOT NULL
            UNION SELECT media_id FROM library_item_files WHERE item_id = ?1
            UNION SELECT media_id FROM deck_revisions WHERE item_id = ?1)`).all(r.id)) held.add(m.sha256);
        db.prepare('DELETE FROM library_items WHERE id = ?').run(r.id);
      }
      result.items += rows.length;
      for (const sha of held) forget(sha);
    }
    if (plans && id !== null) {
      result.plans += db.prepare(`DELETE FROM plans WHERE ${where('course_id', id)}`).run().changes;
    }
    if (recorded && id !== null) {
      for (const r of db.prepare(`SELECT id FROM lectures WHERE ${where('course_id', id)}`).all()) {
        const files = db.prepare('SELECT m.sha256 FROM lecture_files lf JOIN media m ON m.id = lf.media_id WHERE lf.lecture_id = ?').all(r.id);
        lectures.deleteLecture(db, admin, r.id, {});
        result.lectures += 1;
        for (const f of files) forget(f.sha256);
      }
    }
    if (archive && id !== null) {
      db.prepare('UPDATE courses SET archived_at = COALESCE(archived_at, ?) WHERE id = ?').run(Date.now(), id);
      result.archived.push(code);
    }
  }
  return result;
}

module.exports = { report, tidy, remove, SETTLE_MS };
