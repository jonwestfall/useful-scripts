// What happened in the room, kept after everyone has gone home.
//
// The thing worth being clear about first, because it decides the whole shape
// of this module: THE RELAY CANNOT WRITE THIS. Every message Podium puts on a
// relay is encrypted in the browser under a key derived from the room
// passphrase, so a relay watching its own traffic sees ciphertext and nothing
// else. It does not know what is on the projector, and it is not supposed to.
// The audience-poll routes are the one documented exception and they only
// carry answers, never what the answers were about.
//
// The display is the device that holds the decrypted, authoritative state, and
// on a server-backed deployment it is also a signed-in page. So the display
// writes the timeline, over the ordinary JSON API, with its own cookie. The
// controller does the same for a poll as it ends it, because the controller is
// the device that ends polls and the only one that ever sees the final tally.
//
// Everything here is best-effort by design. A display that loses the network,
// or a browser that is closed with the projector still on, leaves a lecture
// whose record stops early - never one that is wrong. Events are append-only
// and an event's end is simply the next one's start, so nothing has to be
// updated in place and nothing has to be reconciled afterwards.

'use strict';

const path = require('node:path');

const library = require('./library.js');
const settings = require('./settings.js');

// A 90-minute lecture recording a surface change every 15 seconds tops out
// around 360 events. 5000 is "something is looping", and the point of the cap
// is that one wedged display cannot fill the disk.
const MAX_EVENTS = 5000;
const MAX_EVENTS_PER_POST = 100;
const MAX_POLLS = 200;
const MAX_TITLE = 200;
const MAX_DETAIL_BYTES = 2000;

const EVENT_KINDS = new Set(['program', 'poll', 'note']);

// --- what a session may keep -------------------------------------------------
//
// Photos taken in the room, the ink as strokes, and the pages the controller
// rasterizes when it exports. Its own allow-list rather than the library's:
// these arrive from Podium's own pages, not from a file picker, and the set of
// things they can be is short and known. Nothing here executes, which is the
// same rule the library's list is built on and the reason .svg is absent from
// both - the bytes come back from this origin later.
const KEEPABLE = new Map(Object.entries({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
}));

// What a file is FOR, which is all the server knows about it: a photo taken
// in the room, the ink as strokes, or a page the controller rasterized when it
// exported. Anything else is filed as a plain part of the export.
const FILE_KINDS = new Set(['photo', 'ink', 'session']);

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILES_PER_LECTURE = 500;
// One lecture's whole record. A 90-minute session with two dozen photos and
// forty annotated slides lands around 40 MB; this is room for an unusual one
// without letting a wedged controller fill the disk in an afternoon.
const MAX_LECTURE_BYTES = 400 * 1024 * 1024;

const keepableType = (name) => KEEPABLE.get(path.extname(String(name || '')).toLowerCase()) || null;

// The path a file has inside the zip, and the only thing a caller chooses about
// where the bytes land - so it is cleaned rather than trusted. Forward slashes
// survive (the zip has folders); anything that could climb out of one, or that
// a filesystem would argue with, does not. The bytes themselves are stored
// under their own hash and never under this name.
function cleanName(raw) {
  const parts = String(raw || '').split('/')
    .map((part) => part.replace(/[^a-zA-Z0-9._ -]+/g, '').replace(/^\.+/, '').trim())
    .filter(Boolean);
  return parts.join('/').slice(0, 200);
}

// Owner, admin, or a member of the course it was filed under (while that
// course is not archived) - the same rule as a plan, and for the same reason.
// A lecture with no course is a record of your own teaching, not something a
// colleague should find by browsing. The archived check gates only the
// membership branch, so whoever ran the lecture keeps their own record; `c`
// is SELECT_LECTURES's own join of courses.
//
// server/library.js's mayReadMedia duplicates this by hand for the
// lecture-media branch, rather than sharing it, because lectures.js already
// requires library.js and the reverse require would be circular - keep the
// two in sync.
// ?1 = user id, ?2 = 1 for an admin.
const VISIBLE = `(
  l.started_by = ?1
  OR ?2 = 1
  OR (l.course_id IS NOT NULL AND c.archived_at IS NULL
      AND EXISTS (SELECT 1 FROM course_members cm WHERE cm.course_id = l.course_id AND cm.user_id = ?1))
)`;

const SELECT_LECTURES = `
  SELECT l.*, c.code AS course_code, u.username AS owner_name,
         (SELECT COUNT(*) FROM lecture_events e WHERE e.lecture_id = l.id) AS event_count,
         (SELECT COUNT(*) FROM lecture_polls p WHERE p.lecture_id = l.id) AS poll_count
    FROM lectures l
    LEFT JOIN courses c ON c.id = l.course_id
    LEFT JOIN users u ON u.id = l.started_by`;

function lectureRow(row) {
  return {
    id: row.id,
    title: row.title || '',
    room: row.room || '',
    course: row.course_code || null,
    owner: row.owner_name || '',
    ownerId: row.started_by,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    truncated: !!row.truncated,
    events: row.event_count,
    polls: row.poll_count,
  };
}

function parseDetail(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Which course, if any, this room belongs to.
 *
 * Deliberately derived rather than sent: the display already knows its room
 * name and has never needed to know a course code, and settings.forUser only
 * ever returns courses this account may actually use - so a room name
 * belonging to somebody else's course resolves to nothing rather than filing
 * the lecture there.
 */
function courseIdForRoom(db, user, room) {
  const wanted = String(room || '').trim();
  if (!wanted) return null;
  const matches = settings.forUser(db, user).filter((row) => row.settings.room === wanted);
  // Two of this account's courses sharing a room is a misconfiguration, not
  // a choice for this function to make silently - filing the lecture under
  // whichever sorts first would expose it to the wrong course's members. No
  // course id is a lecture that simply isn't filed under one, which is safe;
  // guessing wrong is not.
  if (matches.length !== 1) return null;
  const course = db.prepare('SELECT id FROM courses WHERE code = ?').get(matches[0].course);
  return course ? course.id : null;
}

/**
 * The lecture, if this account may see it - and seeing it is also the whole of
 * the permission to ADD to it. That is deliberate: the display that started a
 * lecture and the controllers driving it are often different accounts, and a
 * TA's controller ending a poll should not have the tally dropped on the floor
 * because the classroom PC happens to be signed in as the instructor. Removing
 * one is narrower; see mayDelete.
 */
const findLecture = (db, user, id) =>
  db.prepare(`${SELECT_LECTURES} WHERE l.id = ?3 AND ${VISIBLE}`)
    .get(user.id, user.isAdmin ? 1 : 0, Number(id));

/**
 * Removing one is narrower: whoever ran it, a course owner, or an admin - the
 * same shape as removing a library item. A colleague who can read the record
 * of your lecture has no business deleting it.
 */
function mayDelete(db, user, lecture) {
  if (user.isAdmin || lecture.ownerId === user.id) return true;
  if (!lecture.course) return false;
  const row = db.prepare(`SELECT cm.role FROM course_members cm
      JOIN courses c ON c.id = cm.course_id
     WHERE c.code = ? AND cm.user_id = ?`).get(lecture.course, user.id);
  return row?.role === 'owner';
}

/**
 * The lecture's summary, if this account may see it - and nothing else. What
 * getLecture does with a whole timeline, every poll and every file attached is
 * far too much to read just to find out whether a photo may be filed.
 */
function visibleLecture(db, user, id) {
  const row = findLecture(db, user, id);
  return row ? lectureRow(row) : null;
}

function listLectures(db, user, { limit = 200 } = {}) {
  const rows = db.prepare(`${SELECT_LECTURES} WHERE ${VISIBLE} ORDER BY l.started_at DESC LIMIT ?3`)
    .all(user.id, user.isAdmin ? 1 : 0, Math.min(Math.max(Number(limit) || 200, 1), 500));
  return rows.map(lectureRow);
}

/** One lecture, with its whole timeline and every poll it ran. */
function getLecture(db, user, id) {
  const row = findLecture(db, user, id);
  if (!row) return null;
  const events = db.prepare('SELECT * FROM lecture_events WHERE lecture_id = ? ORDER BY at, id')
    .all(row.id)
    .map((e) => ({ id: e.id, at: e.at, kind: e.kind, title: e.title, detail: parseDetail(e.detail) }));
  const polls = db.prepare('SELECT * FROM lecture_polls WHERE lecture_id = ? ORDER BY ended_at, id')
    .all(row.id)
    .map((p) => ({
      // The stored tally spreads FIRST, so a stray key inside it can never
      // overwrite the row's own id or question - the same lesson library.js
      // learned about an item's props.
      ...parseDetail(p.results),
      id: p.id,
      pollId: p.poll_id,
      kind: p.kind,
      question: p.question,
      voters: p.voters,
      endedAt: p.ended_at,
    }));
  return { ...lectureRow(row), timeline: events, pollResults: polls, files: listFiles(db, row.id) };
}

/**
 * Delete a lecture row outright, releasing any media that row's own files
 * were the last thing pointing at.
 *
 * The two steps are married into one function deliberately, and the order
 * inside it matters: forgetMediaIfUnused decides "is this sha still in use"
 * by looking at lecture_files, so it has to run AFTER the DELETE has cascaded
 * this lecture's own rows away. Ask it first and a file this very lecture is
 * about to stop referencing still counts as "in use" - by itself - and
 * nothing is ever freed. Used for a stale lecture closed by the next Go live,
 * one discarded for having recorded nothing, and an explicit removal from
 * admin.html: the same shape every time a lecture row disappears.
 *
 * `dataDir` is optional and the release is a no-op without it, the same shape
 * addFile already uses: a caller that has not been handed the data directory
 * (a test exercising the schema alone, say) gets the row deleted and the
 * bytes left alone rather than a crash.
 */
function discardLecture(db, dataDir, lectureId) {
  const held = dataDir
    ? db.prepare(`SELECT m.sha256 FROM lecture_files lf JOIN media m ON m.id = lf.media_id
         WHERE lf.lecture_id = ?`).all(lectureId)
    : [];
  db.prepare('DELETE FROM lectures WHERE id = ?').run(lectureId);
  for (const { sha256 } of held) library.forgetMediaIfUnused(db, dataDir, sha256);
}

/**
 * Go live. Any lecture this account left open in this room is closed first -
 * a display whose tab was closed at four o'clock, or a machine that lost power
 * mid-lecture, never got to end its own.
 *
 * It is closed at the last thing it RECORDED rather than at now, so a lecture
 * abandoned on Tuesday afternoon is not shown as having run until Thursday
 * morning; and one that recorded nothing at all is discarded outright, the
 * same as endLecture does, because an empty row is not a lecture anyone taught.
 */
function startLecture(db, user, { room, title, dataDir } = {}) {
  const now = Date.now();
  const stale = db.prepare(`SELECT l.id, l.started_at,
        (SELECT MAX(e.at) FROM lecture_events e WHERE e.lecture_id = l.id) AS last_at,
        (SELECT MAX(p.ended_at) FROM lecture_polls p WHERE p.lecture_id = l.id) AS last_poll_at,
        (SELECT COUNT(*) FROM lecture_polls p WHERE p.lecture_id = l.id) AS poll_count
      FROM lectures l
     WHERE l.started_by = ? AND l.room = ? AND l.ended_at IS NULL`).all(user.id, String(room || ''));
  for (const row of stale) {
    if (!row.last_at && !row.poll_count) discardLecture(db, dataDir, row.id);
    // A stale lecture that ran a poll but never wrote a timeline event (a
    // display that only ever showed the arming screen while a poll ran
    // through the controller) still has a real end time - the poll's, not
    // the lecture's own started_at - so take whichever of the two is later.
    else db.prepare('UPDATE lectures SET ended_at = ? WHERE id = ?')
      .run(Math.max(row.last_at || 0, row.last_poll_at || 0) || row.started_at, row.id);
  }

  const { lastInsertRowid } = db.prepare(`INSERT INTO lectures
      (course_id, room, title, started_by, started_at) VALUES (?, ?, ?, ?, ?)`)
    .run(courseIdForRoom(db, user, room), String(room || '').slice(0, 200),
      String(title || '').slice(0, MAX_TITLE), user.id, now);
  return lectureRow(findLecture(db, user, lastInsertRowid));
}

/**
 * Stand down. A lecture that recorded nothing at all is removed rather than
 * ended: clicking Go live to check the projector works, then closing it again,
 * should not leave a row in anybody's session browser.
 */
function endLecture(db, user, id, { at, dataDir } = {}) {
  const lecture = findLecture(db, user, id);
  if (!lecture) throw Object.assign(new Error('no such lecture'), { status: 404 });
  const row = lectureRow(lecture);
  if (!row.events && !row.polls) {
    // A photo or the ink can exist before the first timeline event or poll -
    // fileInk and a photo upload both happen independently of appendEvents -
    // so "recorded nothing" is judged by events and polls but the files still
    // have to be released the same way an explicit delete releases them.
    discardLecture(db, dataDir, row.id);
    return { ...row, endedAt: at || Date.now(), discarded: true };
  }
  // Clamped to the lecture's own lifetime: an out-of-range `at` (0, or a
  // clock in the future) would otherwise store a nonsensical end time that
  // reads as still-open (endedAt falsy) or as a lecture that ran backwards.
  const when = Number.isFinite(at) ? Math.min(Math.max(at, row.startedAt), Date.now()) : Date.now();
  db.prepare('UPDATE lectures SET ended_at = ? WHERE id = ?').run(when, row.id);
  return { ...row, endedAt: when };
}

// A plausible-looking client id or nothing at all - an older display, or one
// of the rare paths that never generates one, sends no client_id, and that
// event is simply never deduplicated (see the migration in store.js for why
// that is fine rather than a hole).
const CLIENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function cleanEvent(raw, now, startedAt) {
  const kind = EVENT_KINDS.has(raw?.kind) ? raw.kind : 'program';
  // A clock that disagrees with the server's is the display's, and it is the
  // server's that the whole timeline is read against - so an `at` from the
  // future, or from before this lecture began, is not honoured. Anything
  // inside the sane window is kept, because the queue below flushes in
  // batches and the moment an item went up is what matters, not the moment
  // the batch was sent.
  const at = Number.isFinite(raw?.at) ? Math.min(Math.max(raw.at, startedAt), now) : now;
  let detail = '{}';
  if (raw?.detail && typeof raw.detail === 'object' && !Array.isArray(raw.detail)) {
    const text = JSON.stringify(raw.detail);
    if (Buffer.byteLength(text) <= MAX_DETAIL_BYTES) detail = text;
  }
  const clientId = typeof raw?.id === 'string' && CLIENT_ID_RE.test(raw.id) ? raw.id : null;
  return { at, kind, title: String(raw?.title || '').slice(0, MAX_TITLE), detail, clientId };
}

/**
 * Add to the timeline. Returns how many were stored, which is fewer than were
 * sent once the cap is reached - and the lecture is flagged so that a timeline
 * which stops halfway is not read as a lecture that ended there.
 */
function appendEvents(db, user, id, events) {
  const lecture = findLecture(db, user, id);
  if (!lecture) throw Object.assign(new Error('no such lecture'), { status: 404 });
  const list = Array.isArray(events) ? events.slice(0, MAX_EVENTS_PER_POST) : [];
  if (!list.length) return { stored: 0, truncated: !!lecture.truncated };

  const now = Date.now();
  // ON CONFLICT DO NOTHING is the whole fix for a retried flush: the display
  // resends a batch whenever it cannot tell whether the last attempt's
  // response was merely lost, and without this a lost response duplicates
  // every event in that batch. The WHERE clause has to repeat the partial
  // index's own condition - SQLite will not infer it - and it is exactly what
  // makes an event with no client_id (see cleanEvent) insert unconditionally
  // instead of colliding with every other client_id-less row in the lecture.
  const insert = db.prepare(`INSERT INTO lecture_events (lecture_id, at, kind, title, detail, client_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(lecture_id, client_id) WHERE client_id IS NOT NULL DO NOTHING`);
  let room = MAX_EVENTS - lecture.event_count;
  let stored = 0;
  db.exec('BEGIN');
  try {
    for (const raw of list) {
      if (room <= 0) break;
      const event = cleanEvent(raw, now, lecture.started_at);
      const { changes } = insert.run(lecture.id, event.at, event.kind, event.title, event.detail, event.clientId);
      // A duplicate (changes === 0) costs neither a slot in the cap nor a
      // count towards `stored` - a retry that lands a second time must not
      // look like it used up room a genuinely new event would need next.
      if (!changes) continue;
      room -= 1;
      stored += 1;
    }
    // Flagged whenever the cap was actually reached, not just when this
    // particular batch had leftovers: a batch that exactly fills the last
    // `room` slots (stored === list.length) still leaves the lecture with no
    // room for the next event, and that is the same "stops halfway" a caller
    // needs to know about - it would otherwise only get flagged on the NEXT
    // request, by which point the timeline has already been read as complete.
    const atCap = room <= 0;
    if (atCap && !lecture.truncated) {
      db.prepare('UPDATE lectures SET truncated = 1 WHERE id = ?').run(lecture.id);
    }
    db.exec('COMMIT');
    return { stored, truncated: !!lecture.truncated || atCap };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back by the failure */ }
    throw err;
  }
}

/**
 * A poll, as it stood when it was ended.
 *
 * `results` keeps whatever shape the poll had - counts and options for a
 * choice poll, the answers themselves for a text one - as JSON, the same
 * arrangement library_items uses for props: the server never interprets it and
 * only ever hands it back.
 */
function recordPoll(db, user, id, poll) {
  const lecture = findLecture(db, user, id);
  if (!lecture) throw Object.assign(new Error('no such lecture'), { status: 404 });
  const pollId = String(poll?.pollId || '').slice(0, 100);
  if (!pollId) throw Object.assign(new Error('a poll needs its id'), { status: 400 });
  if (lecture.poll_count >= MAX_POLLS) {
    const already = db.prepare('SELECT 1 AS ok FROM lecture_polls WHERE lecture_id = ? AND poll_id = ?')
      .get(lecture.id, pollId);
    if (!already) throw Object.assign(new Error('that lecture already holds as many polls as it can'), { status: 413 });
  }

  const results = {
    options: Array.isArray(poll?.options) ? poll.options.slice(0, 50).map((o) => String(o).slice(0, 500)) : [],
    counts: Array.isArray(poll?.counts) ? poll.counts.slice(0, 50).map((n) => Number(n) || 0) : [],
    answers: Array.isArray(poll?.answers) ? poll.answers.slice(0, 500).map((a) => String(a).slice(0, 1000)) : [],
    // Indices into `answers`, not the answers themselves - that is the shape
    // the controller moderates in (see pollResultRows in control.js), and
    // rewriting it here would quietly change what "hidden" means.
    hiddenAnswers: Array.isArray(poll?.hiddenAnswers)
      ? poll.hiddenAnswers.slice(0, 500).map((n) => Number(n) || 0) : [],
  };
  const text = JSON.stringify(results);
  if (Buffer.byteLength(text) > 256 * 1024) {
    throw Object.assign(new Error('that poll is too large to store'), { status: 413 });
  }

  // Ended twice - two controllers in the room, or a retry after a post that
  // failed on the way back - is one row. The later tally is meant to win,
  // because a poll only ever gains votes - but "later" has to mean "more
  // votes counted", not "arrived at the server more recently": two
  // controllers racing to end the same poll, or a retried request landing
  // after a fresher one, can deliver the smaller count second. Voters alone
  // is not quite enough, though: a voter changing their answer without
  // changing the total leaves two rows tied on voters but disagreeing on
  // results, and >= would let whichever lands last win regardless of which
  // is actually newer. ended_at breaks that tie - accept a tied count only
  // when it is at least as new - so a stale retry (same count, older
  // ended_at) can no longer stomp a fresher result that happened to tie it.
  db.prepare(`INSERT INTO lecture_polls (lecture_id, poll_id, kind, question, results, voters, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lecture_id, poll_id) DO UPDATE SET
        kind = excluded.kind, question = excluded.question,
        results = excluded.results, voters = excluded.voters, ended_at = excluded.ended_at
      WHERE excluded.voters > lecture_polls.voters
         OR (excluded.voters = lecture_polls.voters AND excluded.ended_at >= lecture_polls.ended_at)`)
    .run(lecture.id, pollId,
      poll?.kind === 'text' ? 'text' : 'choice',
      String(poll?.question || '').slice(0, 1000),
      text,
      Number(poll?.voters) || 0,
      Number.isFinite(poll?.endedAt) ? poll.endedAt : Date.now());
  return { pollId };
}

// --- the files a session keeps -----------------------------------------------

const fileRow = (row) => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  bytes: row.bytes,
  at: row.created_at,
  // The same content-addressed path the library's items use, so one route
  // serves both and gets the hardening right once (see serveMedia).
  url: `/media/${row.sha256}/${encodeURIComponent(row.name.split('/').pop() || 'file')}`,
});

const listFiles = (db, lectureId) =>
  db.prepare(`SELECT lf.*, m.sha256, m.bytes FROM lecture_files lf
      JOIN media m ON m.id = lf.media_id
     WHERE lf.lecture_id = ? ORDER BY lf.name`).all(lectureId).map(fileRow);

/**
 * Keep one file with a lecture. `sha256`/`bytes` come from library.storeUpload,
 * which has already written the bytes into the shared media store.
 *
 * Exporting a session twice replaces what the first export left rather than
 * accumulating two of everything - the name is unique per lecture, and the
 * bytes the replaced row pointed at are freed if nothing else wants them.
 */
function addFile(db, user, id, { name, kind, sha256, bytes, contentType, dataDir }) {
  const lecture = findLecture(db, user, id);
  if (!lecture) throw Object.assign(new Error('no such lecture'), { status: 404 });

  const clean = cleanName(name);
  if (!clean) throw Object.assign(new Error('that file needs a name'), { status: 400 });

  const held = db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(m.bytes), 0) AS bytes
      FROM lecture_files lf JOIN media m ON m.id = lf.media_id
     WHERE lf.lecture_id = ? AND lf.name <> ?`).get(lecture.id, clean);
  if (held.files >= MAX_FILES_PER_LECTURE) {
    throw Object.assign(new Error('that lecture already keeps as many files as it can'), { status: 413 });
  }
  if (held.bytes + bytes > MAX_LECTURE_BYTES) {
    throw Object.assign(new Error('that lecture has reached the space one session may use'), { status: 413 });
  }

  const mediaId = library.rememberMedia(db, user, { sha256, bytes, contentType });
  const previous = db.prepare(`SELECT m.sha256 FROM lecture_files lf JOIN media m ON m.id = lf.media_id
     WHERE lf.lecture_id = ? AND lf.name = ?`).get(lecture.id, clean);
  db.prepare(`INSERT INTO lecture_files (lecture_id, media_id, kind, name, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(lecture_id, name) DO UPDATE SET
        media_id = excluded.media_id, kind = excluded.kind,
        created_at = excluded.created_at, created_by = excluded.created_by`)
    .run(lecture.id, mediaId, FILE_KINDS.has(kind) ? kind : 'session', clean, Date.now(), user.id);
  if (previous && previous.sha256 !== sha256) library.forgetMediaIfUnused(db, dataDir, previous.sha256);

  return { name: clean, bytes };
}


/** What the session records are costing in disk, for the admin page to show. */
function usage(db) {
  const row = db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(bytes), 0) AS bytes FROM media
     WHERE id IN (SELECT media_id FROM lecture_files)`).get();
  return { files: row.files, bytes: row.bytes };
}

/**
 * The retention control: drop the FILES of lectures older than `days`, and
 * leave the timelines alone.
 *
 * That asymmetry is the whole design. Photos and rasterized slides are the two
 * payloads that grow without bound; a timeline is a few hundred short rows and
 * is exactly what somebody wants three years later when they are asked what a
 * course covered. So the bulk ages out and the record does not.
 *
 * Age is measured from when the lecture started, not from when a file was
 * written: a lecture is the unit anybody thinks in, and an export run a week
 * late should not buy its photos another term.
 */
function pruneFiles(db, dataDir, { days, now = Date.now() } = {}) {
  const keepFor = Number(days);
  if (!Number.isFinite(keepFor) || keepFor <= 0) return { removed: 0, bytes: 0 };
  const before = now - keepFor * 24 * 60 * 60 * 1000;
  const doomed = db.prepare(`SELECT lf.id, m.sha256, m.bytes FROM lecture_files lf
      JOIN media m ON m.id = lf.media_id
      JOIN lectures l ON l.id = lf.lecture_id
     WHERE l.started_at < ?`).all(before);
  let bytes = 0;
  for (const row of doomed) {
    db.prepare('DELETE FROM lecture_files WHERE id = ?').run(row.id);
    // Only counted as space recovered if the bytes really went: the same photo
    // may still be a library item, and content addressing means that copy is
    // this copy.
    if (library.forgetMediaIfUnused(db, dataDir, row.sha256)) bytes += row.bytes;
  }
  return { removed: doomed.length, bytes };
}

function renameLecture(db, user, id, { title, courseCode } = {}) {
  const lecture = findLecture(db, user, id);
  if (!lecture) throw Object.assign(new Error('no such lecture'), { status: 404 });
  if (!mayDelete(db, user, lectureRow(lecture))) {
    throw Object.assign(new Error(
      'only whoever ran this lecture, a course owner, or an administrator can change it',
    ), { status: 403 });
  }
  const sets = [];
  const values = [];
  if (title !== undefined) { sets.push('title = ?'); values.push(String(title || '').slice(0, MAX_TITLE)); }
  if (courseCode !== undefined) {
    sets.push('course_id = ?');
    values.push(courseCode ? library.courseIdFor(db, user, courseCode) : null);
  }
  if (!sets.length) return lectureRow(lecture);
  values.push(lecture.id);
  db.prepare(`UPDATE lectures SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return lectureRow(findLecture(db, user, id));
}

/**
 * Removed outright rather than marked deleted, unlike a library item or a
 * plan. A session record kept after somebody asked for it to go is the
 * opposite of what the retention control this sits under is for - and unlike
 * a library item, there is nothing else in the system that files something
 * under a lecture id, so there is no "soft delete, keep it findable" case to
 * preserve. The media bytes are handled explicitly below, because they ARE
 * shared with the library store now (see the lecture_files comment in
 * store.js) and are only actually freed once nothing else points at them.
 */
function deleteLecture(db, user, id, { dataDir } = {}) {
  const lecture = findLecture(db, user, id);
  if (!lecture) throw Object.assign(new Error('no such lecture'), { status: 404 });
  const row = lectureRow(lecture);
  if (!mayDelete(db, user, row)) {
    throw Object.assign(new Error(
      'only whoever ran this lecture, a course owner, or an administrator can remove it',
    ), { status: 403 });
  }
  // The children go with it: every child table is ON DELETE CASCADE, and
  // PRAGMA foreign_keys is on (see store.js). The BYTES do not follow on their
  // own, though - they live in the shared media store, so each one is offered
  // back afterwards and kept if anything else still points at it.
  discardLecture(db, dataDir, row.id);
  return row;
}

module.exports = {
  listLectures, getLecture, startLecture, endLecture, appendEvents, recordPoll,
  renameLecture, deleteLecture, mayDelete, courseIdForRoom,
  addFile, listFiles, pruneFiles, usage, keepableType, cleanName, visibleLecture,
  MAX_EVENTS, MAX_EVENTS_PER_POST, MAX_POLLS,
  MAX_FILE_BYTES, MAX_FILES_PER_LECTURE, MAX_LECTURE_BYTES, KEEPABLE,
};
