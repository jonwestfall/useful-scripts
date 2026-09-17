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

// Owner, admin, or a member of the course it was filed under - the same rule
// as a plan, and for the same reason. A lecture with no course is a record of
// your own teaching, not something a colleague should find by browsing.
// ?1 = user id, ?2 = 1 for an admin.
const VISIBLE = `(
  l.started_by = ?1
  OR ?2 = 1
  OR (l.course_id IS NOT NULL
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
  const match = settings.forUser(db, user).find((row) => row.settings.room === wanted);
  if (!match) return null;
  const course = db.prepare('SELECT id FROM courses WHERE code = ?').get(match.course);
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
  return { ...lectureRow(row), timeline: events, pollResults: polls };
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
function startLecture(db, user, { room, title } = {}) {
  const now = Date.now();
  const stale = db.prepare(`SELECT l.id, l.started_at,
        (SELECT MAX(e.at) FROM lecture_events e WHERE e.lecture_id = l.id) AS last_at,
        (SELECT COUNT(*) FROM lecture_polls p WHERE p.lecture_id = l.id) AS poll_count
      FROM lectures l
     WHERE l.started_by = ? AND l.room = ? AND l.ended_at IS NULL`).all(user.id, String(room || ''));
  for (const row of stale) {
    if (!row.last_at && !row.poll_count) db.prepare('DELETE FROM lectures WHERE id = ?').run(row.id);
    else db.prepare('UPDATE lectures SET ended_at = ? WHERE id = ?').run(row.last_at || row.started_at, row.id);
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
function endLecture(db, user, id, { at } = {}) {
  const lecture = findLecture(db, user, id);
  if (!lecture) throw Object.assign(new Error('no such lecture'), { status: 404 });
  const row = lectureRow(lecture);
  if (!row.events && !row.polls) {
    db.prepare('DELETE FROM lectures WHERE id = ?').run(row.id);
    return { ...row, endedAt: at || Date.now(), discarded: true };
  }
  const when = Number.isFinite(at) ? at : Date.now();
  db.prepare('UPDATE lectures SET ended_at = ? WHERE id = ?').run(when, row.id);
  return { ...row, endedAt: when };
}

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
  return { at, kind, title: String(raw?.title || '').slice(0, MAX_TITLE), detail };
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
  const insert = db.prepare('INSERT INTO lecture_events (lecture_id, at, kind, title, detail) VALUES (?, ?, ?, ?, ?)');
  let room = MAX_EVENTS - lecture.event_count;
  let stored = 0;
  db.exec('BEGIN');
  try {
    for (const raw of list) {
      if (room <= 0) break;
      const event = cleanEvent(raw, now, lecture.started_at);
      insert.run(lecture.id, event.at, event.kind, event.title, event.detail);
      room -= 1;
      stored += 1;
    }
    if (stored < list.length && !lecture.truncated) {
      db.prepare('UPDATE lectures SET truncated = 1 WHERE id = ?').run(lecture.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back by the failure */ }
    throw err;
  }
  return { stored, truncated: !!lecture.truncated || stored < list.length };
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
  // failed on the way back - is one row. The later tally wins, because a poll
  // only ever gains votes.
  db.prepare(`INSERT INTO lecture_polls (lecture_id, poll_id, kind, question, results, voters, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lecture_id, poll_id) DO UPDATE SET
        kind = excluded.kind, question = excluded.question,
        results = excluded.results, voters = excluded.voters, ended_at = excluded.ended_at`)
    .run(lecture.id, pollId,
      poll?.kind === 'text' ? 'text' : 'choice',
      String(poll?.question || '').slice(0, 1000),
      text,
      Number(poll?.voters) || 0,
      Number.isFinite(poll?.endedAt) ? poll.endedAt : Date.now());
  return { pollId };
}

function renameLecture(db, user, id, { title, courseCode } = {}) {
  const lecture = findLecture(db, user, id);
  if (!lecture) throw Object.assign(new Error('no such lecture'), { status: 404 });
  if (!mayDelete(db, user, lectureRow(lecture))) {
    throw Object.assign(new Error('only whoever ran this lecture can change it'), { status: 403 });
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
 * plan. There is nothing here anyone can point at later - no media rows, no
 * bytes on disk shared with something else - and a session record kept after
 * somebody asked for it to go is the opposite of what the retention control
 * this sits under is for.
 */
function deleteLecture(db, user, id) {
  const lecture = findLecture(db, user, id);
  if (!lecture) throw Object.assign(new Error('no such lecture'), { status: 404 });
  const row = lectureRow(lecture);
  if (!mayDelete(db, user, row)) {
    throw Object.assign(new Error('only whoever ran this lecture can remove it'), { status: 403 });
  }
  // The children go with it: both child tables are ON DELETE CASCADE, and
  // PRAGMA foreign_keys is on (see store.js).
  db.prepare('DELETE FROM lectures WHERE id = ?').run(row.id);
  return row;
}

module.exports = {
  listLectures, getLecture, startLecture, endLecture, appendEvents, recordPoll,
  renameLecture, deleteLecture, mayDelete, courseIdForRoom,
  MAX_EVENTS, MAX_EVENTS_PER_POST, MAX_POLLS,
};
