// Backups you can open: a course's library, a lecture and everything it
// uses, or (for an administrator) the whole server, as one ZIP of ordinary
// files in folders a person can find their way around.
//
// This is not the disaster-recovery backup. That is deploy/backup.sh (and
// the admin page's database copy): the data directory as Podium keeps it,
// files named by their SHA-256, for putting a server back exactly as it was.
// This is the other thing people ask for - "give me my stuff" at the end of
// a term - so names are what they were uploaded as, folders are courses and
// lectures, and a manifest.json says what each file was on the server for
// whatever wants to read it back later.
//
//   Podium backup 2026-12-18/
//     README.txt
//     manifest.json
//     PSY415 — Introduction to Psychology/
//       Library/<group>/<file>                      a file
//       Library/<group>/<deck>/<deck>.md + media/    a deck and its pictures
//       Library/<group>/<picture deck>/001 ….png      a picture deck's slides
//       Lectures/<lecture>/<lecture>.podium.json      the plan file, as the planner exports it
//       Lectures/<lecture>/files/…                   what it uses that is not in Library/ above
//       Recorded lectures/<date> <title>/            a session's record and its files
//     No course/…
//
// A lecture folder is complete on its own when the lecture is all that was
// asked for ("back up this lecture and its files"). When its course's
// library is in the same backup, the files it uses are already there, and
// the lecture folder lists where rather than holding a second copy of every
// video.
//
// Nothing is decided here about who may see what. Every item, plan and
// session goes through the same getItem / getPlan / getLecture the rest of
// the server answers with, and every file a plan or deck points at through
// mayReadMedia; what this person could not open anyway is left out, and the
// manifest says so.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const library = require('./library.js');
const plans = require('./plans.js');
const lectures = require('./lectures.js');
const { ZipWriter, safePart, predictSize } = require('./zip-writer.js');

// Server files a plan or a deck can point at: content-addressed bytes, and
// a deck's stable address (library.deckSrc).
const MEDIA_REF = /\/media\/([0-9a-f]{64})\/([^\s"'()<>\\]+)/g;
const DECK_REF = /\/media\/deck\/(\d+)\/([^\s"'()<>\\]+)/g;
// A file in the site's own content/ folder, as a planner path or a URL.
const CONTENT_REF = /(?:^|["'\s(])\/?(content\/[^\s"'()<>\\?#]+)/g;

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const dayStamp = (ms) => new Date(ms).toISOString().slice(0, 10);
const COURSE_LABEL = (c) => safePart(c ? `${c.code.toUpperCase()}${c.title ? ` — ${c.title}` : ''}` : 'No course', 'Course');
const NO_COURSE = 'No course';

/**
 * Everything a backup will hold, worked out before a byte is sent - so the
 * page can say how big it is, and so nothing is half-written when a file
 * turns out to be missing.
 *
 * @param {object} spec
 * @param {number[]} [spec.items]    library items, by id
 * @param {number[]} [spec.plans]    lectures (plans), by id: each with all its files
 * @param {string[]} [spec.courses]  whole courses, by code: library, lectures (and sessions, with `recorded`)
 * @param {boolean}  [spec.mine]     everything this account added or wrote
 * @param {boolean}  [spec.everything] the whole server (administrators only)
 * @param {boolean}  [spec.noCourse] with `everything`'s parts: library items filed under no course
 * @param {boolean}  [spec.recorded] include recorded lectures (session records and their files)
 */
function collect(db, user, { dataDir, contentDir }, spec = {}) {
  const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const codes = [...new Set((Array.isArray(spec.courses) ? spec.courses : []).map((c) => String(c).trim().toLowerCase()).filter(Boolean))];
  if (spec.everything && !user.isAdmin) throw Object.assign(new Error('only an administrator can back up the whole server'), { status: 403 });

  const courseRows = new Map(db.prepare('SELECT id, code, title FROM courses').all().map((c) => [c.code, c]));
  const skipped = [];
  const itemIds = new Set(ids(spec.items));
  const planIds = new Set(ids(spec.plans));
  const lectureIds = new Set();

  // A course is backed up by someone in it (or an administrator): the parts
  // of it they can see, which for a member is all of it.
  const memberOf = new Set(db.prepare(`SELECT c.code FROM course_members cm JOIN courses c ON c.id = cm.course_id
      WHERE cm.user_id = ?`).all(user.id).map((r) => r.code));
  for (const code of codes) {
    const course = courseRows.get(code);
    if (!course || (!user.isAdmin && !memberOf.has(code))) { skipped.push({ what: code.toUpperCase(), why: 'not a course you are in' }); continue; }
    for (const r of db.prepare('SELECT id FROM library_items WHERE course_id = ? AND deleted_at IS NULL').all(course.id)) itemIds.add(r.id);
    for (const r of db.prepare('SELECT id FROM plans WHERE course_id = ? AND deleted_at IS NULL').all(course.id)) planIds.add(r.id);
    if (spec.recorded) for (const r of db.prepare('SELECT id FROM lectures WHERE course_id = ?').all(course.id)) lectureIds.add(r.id);
  }
  if (spec.mine) {
    for (const r of db.prepare('SELECT id FROM library_items WHERE created_by = ? AND deleted_at IS NULL').all(user.id)) itemIds.add(r.id);
    for (const r of db.prepare('SELECT id FROM plans WHERE owner_id = ? AND deleted_at IS NULL').all(user.id)) planIds.add(r.id);
    if (spec.recorded) for (const r of db.prepare('SELECT id FROM lectures WHERE started_by = ?').all(user.id)) lectureIds.add(r.id);
  }
  if (spec.everything) {
    for (const r of db.prepare('SELECT id FROM library_items WHERE deleted_at IS NULL').all()) itemIds.add(r.id);
    for (const r of db.prepare('SELECT id FROM plans WHERE deleted_at IS NULL').all()) planIds.add(r.id);
    if (spec.recorded) for (const r of db.prepare('SELECT id FROM lectures').all()) lectureIds.add(r.id);
  }
  if (spec.noCourse) {
    for (const r of db.prepare('SELECT id FROM library_items WHERE course_id IS NULL AND deleted_at IS NULL').all()) itemIds.add(r.id);
  }

  const entries = [];          // { path, file?, data?, mtime }
  const used = new Set();      // lower-cased paths, so two files never share one
  const where = new Map();     // sha256 -> a path already in this backup holding those bytes
  const root = `Podium backup ${dayStamp(Date.now())}`;
  const unique = (p) => {
    let candidate = p;
    const m = /^(.*?)(\.[^./]{1,8})?$/.exec(p);
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${m[1]} (${n})${m[2] || ''}`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
  const media = db.prepare('SELECT sha256, bytes, created_at FROM media WHERE sha256 = ?');
  const onDisk = (sha256) => {
    const row = media.get(sha256);
    if (!row) return null;
    const file = library.mediaPath(dataDir, sha256);
    try { if (!fs.statSync(file).isFile()) return null; } catch { return null; }
    return { ...row, file };
  };
  const addFile = (p, sha256, { reuse = false } = {}) => {
    if (reuse && where.has(sha256)) return where.get(sha256);
    const found = onDisk(sha256);
    if (!found) return null;
    const at = unique(p);
    entries.push({ path: at, file: found.file, bytes: found.bytes, mtime: new Date(found.created_at) });
    if (!where.has(sha256)) where.set(sha256, at);
    return at;
  };
  const addData = (p, data, mtime = new Date()) => {
    const at = unique(p);
    const buf = Buffer.from(data, 'utf8');
    entries.push({ path: at, data: buf, bytes: buf.length, mtime });
    return at;
  };
  const courseFolder = (code) => `${root}/${code ? COURSE_LABEL(courseRows.get(code) || { code, title: '' }) : NO_COURSE}`;

  /**
   * A deck's markdown, and the server pictures and videos it points at under
   * media/ beside it with the markdown pointed there - the shape the deck
   * editor's own .zip export has, so the folder opens in any Marp tool and
   * comes back in through "Open a .md or .zip file".
   */
  const addDeck = (folder, item, { reuse = false } = {}) => {
    const found = item.version ? onDisk(item.version) : null;
    if (!found) return null;
    let text;
    try { text = fs.readFileSync(found.file, 'utf8'); } catch { return null; }
    const refs = [...new Map([...text.matchAll(MEDIA_REF)].map((m) => [m[0], m])).values()]
      .filter((m) => library.mayReadMedia(db, user, m[1]));
    const name = safePart(item.filename || `${item.title}.md`, 'deck.md').replace(/(\.md|\.markdown)?$/i, (ext) => ext || '.md');
    if (!refs.length) return addData(`${folder}/${name}`, text, new Date(item.updatedAt || found.created_at));
    const dir = `${folder}/${safePart(item.title, 'Deck')}`;
    const taken = new Set();
    for (const m of refs) {
      let file = safePart(decode(m[2]), 'file');
      for (let n = 2; taken.has(file.toLowerCase()); n++) file = file.replace(/(\.\w+)?$/, (ext) => ` (${n})${ext || ''}`);
      taken.add(file.toLowerCase());
      if (addFile(`${dir}/media/${file}`, m[1], { reuse })) text = text.split(m[0]).join(`media/${file}`);
    }
    return addData(`${dir}/${name}`, text, new Date(item.updatedAt || found.created_at));
  };

  // --- the library --------------------------------------------------------

  const manifestItems = [];
  const sortedItems = [...itemIds].map((id) => library.getItem(db, user, id)).filter((item, k) => {
    if (!item) skipped.push({ what: `library item ${[...itemIds][k]}`, why: 'not one you can see' });
    return !!item;
  });
  for (const item of sortedItems) {
    const folder = `${courseFolder(item.course)}/Library${item.group ? `/${safePart(item.group, 'Group')}` : ''}`;
    let at = null;
    if (library.isMarkdownKind(item.type)) {
      at = addDeck(folder, item);
    } else if (item.type === 'imagedeck') {
      const files = db.prepare(`SELECT m.sha256 FROM library_item_files lif JOIN media m ON m.id = lif.media_id
          WHERE lif.item_id = ? ORDER BY lif.position`).all(item.id);
      const dir = `${folder}/${safePart(item.title, 'Picture deck')}`;
      const names = Array.isArray(item.images) ? item.images : [];
      files.forEach((f, i) => {
        const base = safePart(decode(String(names[i] || '').split('/').pop() || ''), `slide.png`);
        if (addFile(`${dir}/${String(i + 1).padStart(3, '0')} ${base}`, f.sha256)) at = dir;
      });
    } else if (item.src && /^\/media\/[0-9a-f]{64}\//.test(item.src)) {
      at = addFile(`${folder}/${safePart(item.filename || item.title, 'file')}`, item.src.split('/')[2]);
    }
    if (!at && item.src && /^\/media\//.test(item.src)) skipped.push({ what: item.title, why: 'its file is missing from the server' });
    manifestItems.push({
      id: item.id, title: item.title, type: item.type, course: item.course, group: item.group,
      filename: item.filename || '', bytes: item.bytes || 0, addedBy: item.createdByName || '', addedAt: item.createdAt,
      ...(item.version ? { sha256: item.version } : item.src && /^\/media\/[0-9a-f]{64}\//.test(item.src) ? { sha256: item.src.split('/')[2] } : {}),
      // What has no file (a link, a text card, a QR code) is all here.
      ...(at ? { path: at.slice(root.length + 1) } : { item: { ...item, may: undefined } }),
    });
  }
  // Links, text cards and QR codes have no file to hold: each course's are
  // listed beside its files, so they are not only in the manifest.
  const bare = new Map();
  for (const m of manifestItems) if (!m.path && m.item) (bare.get(m.course || '') || bare.set(m.course || '', []).get(m.course || '')).push(m.item);
  for (const [code, list] of bare) {
    addData(`${courseFolder(code)}/Library/Links and text items.json`, JSON.stringify(list.map((i) => ({
      title: i.title, type: i.type, group: i.group, ...(i.src ? { src: i.src } : {}), ...(i.text ? { text: i.text } : {}),
      ...(i.videoId ? { videoId: i.videoId } : {}), ...(i.url ? { url: i.url } : {}),
    })), null, 2));
  }

  // --- lectures (plans) ---------------------------------------------------

  const manifestPlans = [];
  for (const id of planIds) {
    const plan = plans.getPlan(db, user, id);
    if (!plan || !plan.doc) { skipped.push({ what: `lecture ${id}`, why: 'not one you can see' }); continue; }
    const owner = plan.ownerId === user.id ? '' : `/${safePart(plan.owner, 'Someone')}`;
    const folder = `${courseFolder(plan.course)}/Lectures${plan.course ? '' : owner}/${safePart(plan.title, 'Lecture')}`;
    const stem = (plan.title || 'lecture').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lecture';
    const doc = JSON.stringify({ ...plan.doc, podium: 'plan' }, null, 2);
    const planPath = addData(`${folder}/${stem}.podium.json`, doc, new Date(plan.updatedAt));
    const files = [];
    const seen = new Set();
    // Decks first: a deck brings its own pictures, and those should sit with it.
    for (const m of doc.matchAll(DECK_REF)) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      const deck = library.getItem(db, user, Number(m[1]));
      if (!deck || !library.isMarkdownKind(deck.type)) { skipped.push({ what: `${plan.title}: ${decode(m[2])}`, why: 'a deck you cannot see, or one deleted since' }); continue; }
      const inBackup = manifestItems.find((i) => i.id === deck.id && i.path);
      const at = inBackup ? `${root}/${inBackup.path}` : addDeck(`${folder}/files`, deck, { reuse: true });
      if (at) files.push({ ref: m[0], path: at.slice(root.length + 1) });
    }
    for (const m of doc.matchAll(MEDIA_REF)) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      if (!library.mayReadMedia(db, user, m[1])) { skipped.push({ what: `${plan.title}: ${decode(m[2])}`, why: 'a file you cannot open, or one deleted since' }); continue; }
      const at = addFile(`${folder}/files/${safePart(decode(m[2]), 'file')}`, m[1], { reuse: true });
      if (at) files.push({ ref: m[0], path: at.slice(root.length + 1) });
      else skipped.push({ what: `${plan.title}: ${decode(m[2])}`, why: 'its file is missing from the server' });
    }
    if (contentDir) {
      for (const m of doc.matchAll(CONTENT_REF)) {
        const rel = decode(m[1]);
        if (seen.has(rel)) continue;
        seen.add(rel);
        const full = path.resolve(contentDir, rel.slice('content/'.length));
        if (!full.startsWith(path.resolve(contentDir) + path.sep)) continue;
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (!stat.isFile()) continue;
        const at = unique(`${folder}/files/content/${rel.slice('content/'.length).split('/').map((p) => safePart(p)).join('/')}`);
        entries.push({ path: at, file: full, bytes: stat.size, mtime: stat.mtime });
        files.push({ ref: rel, path: at.slice(root.length + 1) });
      }
    }
    if (files.some((f) => !f.path.startsWith(folder.slice(root.length + 1)))) {
      addData(`${folder}/Files used, elsewhere in this backup.txt`, [
        `“${plan.title}” uses these files. Each is in this backup once, where it is listed:`, '',
        ...files.map((f) => `${f.path}`), '',
      ].join('\r\n'));
    }
    manifestPlans.push({
      id: plan.id, title: plan.title, course: plan.course, owner: plan.owner, updatedAt: plan.updatedAt,
      path: planPath.slice(root.length + 1), files,
    });
  }

  // --- recorded lectures --------------------------------------------------

  const manifestLectures = [];
  for (const id of lectureIds) {
    const record = lectures.getLecture(db, user, id);
    if (!record) continue;
    const when = new Date(record.startedAt);
    const stamp = `${dayStamp(record.startedAt)} ${String(when.getUTCHours()).padStart(2, '0')}${String(when.getUTCMinutes()).padStart(2, '0')}`;
    const folder = `${courseFolder(record.course)}/Recorded lectures/${safePart(`${stamp} ${record.title || record.room || 'Session'}`, stamp)}`;
    const files = [];
    for (const f of record.files || []) {
      const sha = /^\/media\/([0-9a-f]{64})\//.exec(f.url || '')?.[1];
      const at = sha && addFile(`${folder}/${String(f.name).split('/').map((p) => safePart(p)).join('/')}`, sha);
      if (at) files.push({ name: f.name, kind: f.kind, path: at.slice(root.length + 1) });
    }
    const { files: _files, ...rest } = record;
    addData(`${folder}/record.json`, JSON.stringify({ ...rest, files }, null, 2), new Date(record.startedAt));
    manifestLectures.push({ id: record.id, title: record.title, course: record.course, startedAt: record.startedAt, path: folder.slice(root.length + 1) });
  }

  const bytes = entries.reduce((n, e) => n + e.bytes, 0);
  const summary = {
    items: manifestItems.length, plans: manifestPlans.length, lectures: manifestLectures.length,
    files: entries.length, bytes, skipped,
  };
  const manifest = {
    podium: 'backup', v: 1, createdAt: Date.now(), by: user.username,
    scope: {
      ...(spec.everything ? { everything: true } : {}), ...(codes.length ? { courses: codes } : {}),
      ...(spec.mine ? { mine: true } : {}), ...(spec.recorded ? { recorded: true } : {}),
    },
    items: manifestItems, plans: manifestPlans, lectures: manifestLectures, skipped,
  };
  addData(`${root}/manifest.json`, JSON.stringify(manifest, null, 2));
  addData(`${root}/README.txt`, readme(summary, user));
  return { root, entries, summary, fileName: `${safePart(root)}.zip` };
}

function readme(summary, user) {
  const lines = [
    'A backup from Podium',
    '',
    `Made by ${user.displayName || user.username} on ${new Date().toUTCString()}.`,
    `${summary.items} library item(s), ${summary.plans} lecture(s), ${summary.lectures} recorded lecture(s).`,
    '',
    'Each course has a folder, and in it:',
    '',
    '  Library            the files, in the groups they were filed under. A slide deck with',
    '                     pictures is a folder: the .md and a media folder, which any Marp tool',
    '                     opens, and which Podium\'s deck editor takes back if you zip the folder.',
    '  Lectures           each lecture\'s plan file (.podium.json), which the planner opens',
    '                     (Open plan file), and the files it uses. Where a file is already',
    '                     in Library, the lecture folder says where instead of holding a copy.',
    '  Recorded lectures  what a session kept: its timeline and polls (record.json), and photos,',
    '                     annotations and recordings.',
    '',
    'manifest.json lists everything, with what it was on the server.',
    '',
  ];
  if (summary.skipped.length) {
    lines.push('Left out:', '', ...summary.skipped.map((s) => `  ${s.what}: ${s.why}`), '');
  }
  lines.push('This is a copy to keep, not a way to put a server back as it was. For that, an',
    'administrator has deploy/backup.sh, which keeps the whole data directory.', '');
  return lines.join('\r\n');
}

/** The archive's exact size, from what collect() found. */
const zipSize = (found) => predictSize(found.entries.map((e) => (e.data ? { name: e.path, data: e.data } : { name: e.path, bytes: e.bytes })));

/** Write what collect() found onto `out` as a ZIP. Rejects if the download is stopped. */
async function writeZip(out, found) {
  const zip = new ZipWriter(out);
  for (const e of found.entries) {
    if (e.data) await zip.addBuffer(e.path, e.data, { mtime: e.mtime });
    else await zip.addFile(e.path, e.file, { mtime: e.mtime });
  }
  await zip.finish();
  return zip.written;
}

// --- a backup asked for, then downloaded ------------------------------------
//
// Asking (POST) works out what is in it and how big it is, and hands back a
// ticket; the download itself is a plain GET of that ticket, so the browser
// saves it as it arrives, shows its own progress bar, and never has to hold
// gigabytes in a page's memory. A ticket is good for one person for a little
// while, and what it names is worked out again, permissions and all, when it
// is used.

const TICKET_MS = 30 * 60 * 1000;
const MAX_TICKETS = 200;
const tickets = new Map();

function ticketFor(user, spec) {
  const now = Date.now();
  for (const [key, t] of tickets) if (t.expires < now) tickets.delete(key);
  while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
  const key = crypto.randomBytes(18).toString('base64url');
  tickets.set(key, { userId: user.id, spec, expires: now + TICKET_MS });
  return key;
}

/** The backup a ticket names, for this person only; null when it is not theirs or has run out. */
function specForTicket(user, key) {
  const t = tickets.get(String(key || ''));
  if (!t || t.expires < Date.now() || t.userId !== user.id) return null;
  return t.spec;
}

// --- what has been backed up lately ------------------------------------------
//
// Removing a course's files (space.js) is meant to come after backing them
// up, so a backup that was downloaded to the end is remembered, for a day,
// by who took it and what it covered. Kept in memory on purpose: after a
// restart the removal simply asks for a backup again (or to be told none is
// wanted), which is the safe way round.

const DONE_MS = 24 * 60 * 60 * 1000;
let done = [];

function noteBackedUp(user, spec) {
  const now = Date.now();
  done = done.filter((d) => now - d.at < DONE_MS).slice(-200);
  done.push({
    userId: user.id, at: now, everything: !!spec.everything, recorded: !!spec.recorded,
    courses: new Set((spec.courses || []).map((c) => String(c).trim().toLowerCase())),
    noCourse: !!(spec.noCourse || spec.everything),
  });
}

/** Whether this person downloaded, in the last day, a backup holding all of these courses ('' is No course). */
function backedUp(user, codes, { recorded = false } = {}) {
  const now = Date.now();
  return codes.map((c) => String(c ?? '').trim().toLowerCase()).every((code) => done.some((d) => d.userId === user.id
    && now - d.at < DONE_MS && (!recorded || d.recorded)
    && (d.everything || (code === '' ? d.noCourse : d.courses.has(code)))));
}

module.exports = { collect, zipSize, writeZip, ticketFor, specForTicket, noteBackedUp, backedUp, MEDIA_REF, DECK_REF };
