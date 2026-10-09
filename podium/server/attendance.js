// Taking attendance (Issue #256, phase 2): the check-in itself.
//
// An instructor opens a session for a course; the projector shows a QR code
// and a six-digit code that change every few seconds; a student scans or types
// it on their own phone, picks themselves from the course's roster (or signs
// in as a guest), and gets a receipt. Everything here is in two halves:
//
//   - the student's side, which needs no account at all and is reached through
//     the public /attend routes (see podium-server.js). It is told as little as
//     it can be: a name search answers with names and the end of an ID, never
//     an email, and nothing at all until a valid code has been given;
//   - the instructor's side, through /api/attendance, for anyone in the course
//     (a TA takes attendance too).
//
// The code is worked out from the session's secret and the clock, never
// stored. The one just before the current one is still accepted, so a phone
// that scanned as the screen changed is not refused - but a code from two
// changes ago is, which is what makes a photo texted to a friend outside go
// stale.
//
// Nothing here blocks a shared phone. Phones die and people lend them, so a
// second person checked in from the same browser is recorded and both marks
// are flagged for the instructor to look at - the same thing every serious
// attendance system does. The browser token and network address behind that
// flag are kept only as keyed hashes, and only for the retention period an
// administrator sets; the marks themselves stay.

'use strict';

const crypto = require('node:crypto');
const courses = require('./courses.js');
const store = require('./store.js');
const roster = require('./roster.js');

const ROTATIONS = [10, 15, 30];          // seconds a code is up for
const DEFAULT_ROTATE = 15;
const TICKET_MS = 10 * 60 * 1000;        // how long a phone has to find its name
const CLOSE_GRACE_MS = 2 * 60 * 1000;    // ...and to finish, once check-in closes
const MAX_OPEN_MS = 12 * 60 * 60 * 1000; // a session left open overnight is not open
const MAX_MARKS = 1000;                  // per session
const MAX_PER_DEVICE = 10;               // check-ins from one browser in one session
const SEARCH_LIMIT = 8;
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const STATUSES = ['present', 'late', 'absent', 'excused'];
const PHASES = ['entry', 'exit'];
const MAX_QUESTIONS = 3;
const MAX_PROMPT = 300;
const MAX_OPTIONS = 8;
const MAX_OPTION = 120;
const MAX_ANSWER = 500;
const MAX_PARKING_TEXT = 500;
const MAX_PARKING = 500;            // per session
const MAX_NAME = 120;
const MAX_STUDENT_ID = 64;
const MAX_EMAIL = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Check-ins this close together from one network address, in a group this
// small, are worth a second look. A whole class on campus Wi-Fi shares one
// address, which is why a big group says nothing at all.
const NETWORK_SPAN_MS = 2 * 60 * 1000;
const NETWORK_GROUP_MAX = 4;

const fail = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

// --- keyed hashes -------------------------------------------------------------

/**
 * The server's own key for everything attendance hashes or signs. Made on
 * first use and kept in the database, so a copy of the database alone does
 * not tell anyone which address a check-in came from - they would need this
 * too, and it never leaves the server.
 */
function serverKey(db) {
  let key = store.getSystemSetting(db, 'attendance_key', '');
  if (!/^[0-9a-f]{64}$/.test(key)) {
    key = crypto.randomBytes(32).toString('hex');
    store.setSystemSetting(db, 'attendance_key', key);
  }
  return key;
}

const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();
const keyed = (db, kind, value) => (value ? hmac(serverKey(db), `${kind}:${value}`).toString('base64url').slice(0, 32) : '');

/** A browser's token, if it sent a sensible one. */
const cleanDevice = (raw) => (/^[A-Za-z0-9_-]{16,64}$/.test(String(raw || '')) ? String(raw) : '');

function sameText(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// --- the code on the screen ---------------------------------------------------

function codeFor(secret, window) {
  const n = hmac(secret, `code:${window}`).readUInt32BE(0) % 1000000;
  return String(n).padStart(6, '0');
}

/** The code showing now, and how long until it changes. */
function currentCode(session, now = Date.now()) {
  const span = session.rotate_s * 1000;
  const window = Math.floor(now / span);
  return { code: codeFor(session.secret, window), rotatesInMs: span - (now % span), window };
}

/** Whether `code` is this session's current code or the one just before. */
function codeMatches(session, code, now = Date.now()) {
  const { window } = currentCode(session, now);
  return sameText(code, codeFor(session.secret, window)) || sameText(code, codeFor(session.secret, window - 1));
}

// --- throttling (in memory: it only has to outlast a burst) -------------------

const tries = new Map();   // key -> { count, until }

/** Counts one try against `key`; true while it is still within `limit` per `windowMs`. */
function allow(key, limit, windowMs, now = Date.now()) {
  const entry = tries.get(key);
  if (!entry || entry.until <= now) {
    tries.set(key, { count: 1, until: now + windowMs });
    if (tries.size > 20000) for (const [k, v] of tries) if (v.until <= now) tries.delete(k);
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

function blockedFor(key, limit, now = Date.now()) {
  const entry = tries.get(key);
  return entry && entry.until > now && entry.count >= limit ? entry.until - now : 0;
}

function resetThrottle() { tries.clear(); }

// Five wrong codes a minute from one browser; a network address gets more,
// because a whole lecture hall can share one.
const WRONG_PER_DEVICE = 5;
const WRONG_PER_NETWORK = 60;
const WRONG_WINDOW_MS = 60 * 1000;

// --- tickets: what a phone holds between the code and the check-in ----------

function makeTicket(db, sessionId, deviceHash, now) {
  const exp = now + TICKET_MS;
  const sig = hmac(serverKey(db), `ticket:${sessionId}.${exp}.${deviceHash}`).toString('base64url').slice(0, 27);
  return `${sessionId}.${exp}.${sig}`;
}

/**
 * The session a ticket was given for, if it is genuine, still in date, came
 * from this same browser, and check-in is still open (or only just closed
 * after it was given).
 */
function redeemTicket(db, ticket, deviceHash, now) {
  const [sid, exp, sig] = String(ticket || '').split('.');
  const want = hmac(serverKey(db), `ticket:${sid}.${exp}.${deviceHash}`).toString('base64url').slice(0, 27);
  if (!sig || !sameText(sig, want)) throw fail('this page has been open too long - scan the code again', 401);
  if (Number(exp) <= now) throw fail('this page has been open too long - scan the code again', 401);
  const session = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(Number(sid));
  if (!session) throw fail('this check-in no longer exists', 404);
  const issued = Number(exp) - TICKET_MS;
  const open = session.opened_at != null && now - session.opened_at < MAX_OPEN_MS;
  const justClosed = session.opened_at == null && session.closed_at != null
    && session.closed_at >= issued && now - session.closed_at < CLOSE_GRACE_MS;
  if (!open && !justClosed) throw fail('check-in has closed - ask your instructor to mark you by hand', 410);
  return session;
}

// --- shared views -------------------------------------------------------------

function lateRule(session) {
  try {
    const rule = JSON.parse(session.late_rule || '{}');
    const after = rule.after == null || rule.after === '' ? NaN : Number(rule.after);
    return { after: Number.isFinite(after) && after >= 0 ? Math.round(after) : null, from: Number(rule.from) || session.created_at };
  } catch {
    return { after: null, from: session.created_at };
  }
}

/** Whether a check-in at `now` is late. */
function lateAt(session, now = Date.now()) {
  if (session.late_now) return true;
  const rule = lateRule(session);
  return rule.after != null && now >= rule.from + rule.after * 60 * 1000;
}

function isOpen(session, now = Date.now()) {
  return session.opened_at != null && now - session.opened_at < MAX_OPEN_MS;
}

const parseFlags = (text) => {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};

const maskId = (id) => (id ? `…${String(id).slice(-3)}` : '');

function courseOf(db, session) {
  return db.prepare('SELECT code, title FROM courses WHERE id = ?').get(session.course_id) || { code: '', title: '' };
}

function countMarks(db, sessionId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM attendance_marks WHERE session_id = ? AND status IN ('present', 'late')`).get(sessionId).n;
}

function hasRoster(db, courseId) {
  return !!db.prepare('SELECT 1 FROM course_roster WHERE course_id = ? AND removed_at IS NULL LIMIT 1').get(courseId);
}

function markName(db, mark) {
  if (mark.roster_id) return db.prepare('SELECT name FROM course_roster WHERE id = ?').get(mark.roster_id)?.name || '(removed)';
  return mark.guest_name;
}

function receiptOf(db, session, mark, already = false) {
  const course = courseOf(db, session);
  return {
    name: markName(db, mark),
    status: mark.status,
    at: mark.at,
    guest: !mark.roster_id,
    course: course.code.toUpperCase(),
    title: session.title || course.title || '',
    sessionId: session.id,
    already,
    // What this phone keeps to be recognised later in this session: for the
    // exit ticket, and to ask the parking lot a question in its own name.
    markKey: markKey(db, mark.id),
    ...askedOf(db, session, mark.id),
  };
}

// --- questions, and the key a phone keeps for its own check-in ---------------

/** A key for one mark: only the server can make it, so holding it means "I made this check-in". */
function markKey(db, markId) {
  return `${markId}.${hmac(serverKey(db), `mark:${markId}`).toString('base64url').slice(0, 22)}`;
}

/** The mark a key is for, in the given session - or an error. */
function markForKey(db, key, sessionId = null) {
  const [id, sig] = String(key || '').split('.');
  const want = hmac(serverKey(db), `mark:${Number(id)}`).toString('base64url').slice(0, 22);
  if (!sig || !sameText(sig, want)) throw fail('this phone’s check-in is not recognised - check in again', 401);
  const mark = db.prepare('SELECT * FROM attendance_marks WHERE id = ?').get(Number(id));
  if (!mark || (sessionId != null && mark.session_id !== sessionId)) throw fail('that check-in is not part of this session', 404);
  return mark;
}

const parseQuestions = (text) => {
  try {
    const v = JSON.parse(text || '{}');
    return { entry: Array.isArray(v?.entry) ? v.entry : [], exit: Array.isArray(v?.exit) ? v.exit : [] };
  } catch {
    return { entry: [], exit: [] };
  }
};

/**
 * Tidy a list of questions: at most three, each a prompt and (for a choice)
 * two to eight options. A question with fewer than two options is a short
 * answer. Ids are stable by position, q1-q3.
 */
function cleanQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).map((q) => {
    const prompt = String(q?.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT);
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o) => String(o ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_OPTION)).filter(Boolean).slice(0, MAX_OPTIONS);
    return prompt ? { prompt, kind: options.length >= 2 ? 'choice' : 'text', options: options.length >= 2 ? options : [] } : null;
  }).filter(Boolean).slice(0, MAX_QUESTIONS).map((q, i) => ({ ...q, id: `q${i + 1}` }));
}

/** What a phone is asked now, and whether this mark has answered it. */
function askedOf(db, session, markId) {
  const phase = PHASES.includes(session.phase) ? session.phase : 'entry';
  const questions = parseQuestions(session.questions)[phase];
  const answered = markId
    ? !!db.prepare('SELECT 1 FROM attendance_answers WHERE mark_id = ? AND phase = ? LIMIT 1').get(markId, phase)
    : false;
  return { phase, questions, answered, parking: !!session.parking };
}

// --- the student's side -------------------------------------------------------

/**
 * A typed or scanned code, swapped for a ticket good for the next few minutes.
 * Every wrong code counts against this browser and this network address.
 */
function redeemCode(db, { code, device, ip, now = Date.now() } = {}) {
  const deviceHash = keyed(db, 'd', cleanDevice(device));
  const ipHash = keyed(db, 'n', ip);
  const deviceKey = `wrong:${deviceHash || ipHash}`;
  const netKey = `wrong-net:${ipHash}`;
  const wait = Math.max(blockedFor(deviceKey, WRONG_PER_DEVICE, now), blockedFor(netKey, WRONG_PER_NETWORK, now));
  if (wait) throw fail('too many wrong codes - wait a moment and try again', 429, { retryAfterSeconds: Math.ceil(wait / 1000) });

  const typed = String(code || '').replace(/\D/g, '');
  const sessions = typed.length === 6
    ? db.prepare('SELECT * FROM attendance_sessions WHERE opened_at IS NOT NULL AND opened_at > ?').all(now - MAX_OPEN_MS)
    : [];
  const session = sessions.find((s) => codeMatches(s, typed, now));
  if (!session) {
    allow(deviceKey, WRONG_PER_DEVICE, WRONG_WINDOW_MS, now);
    allow(netKey, WRONG_PER_NETWORK, WRONG_WINDOW_MS, now);
    throw fail('that code is not right, or has changed - the one on the screen changes every few seconds', 404);
  }
  const course = courseOf(db, session);
  return {
    ticket: makeTicket(db, session.id, deviceHash, now),
    session: {
      id: session.id,
      course: course.code.toUpperCase(),
      courseTitle: course.title || '',
      title: session.title || '',
      roster: hasRoster(db, session.course_id),
      late: lateAt(session, now),
      ...askedOf(db, session, null),
    },
  };
}

/** Names on the roster matching what was typed: names and the end of an ID, never emails. */
function searchPeople(db, { ticket, device, q, now = Date.now() } = {}) {
  const deviceHash = keyed(db, 'd', cleanDevice(device));
  const session = redeemTicket(db, ticket, deviceHash, now);
  if (!allow(`search:${deviceHash || ticket}`, 120, 60 * 1000, now)) throw fail('slow down a little', 429, { retryAfterSeconds: 30 });
  const text = String(q || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
  if (text.length < 2) return { people: [] };
  const words = text.split(' ');
  const rows = db.prepare('SELECT id, name, student_id FROM course_roster WHERE course_id = ? AND removed_at IS NULL ORDER BY lower(name)')
    .all(session.course_id);
  const people = rows
    .filter((r) => {
      const name = r.name.toLowerCase();
      return words.every((w) => name.split(' ').some((part) => part.startsWith(w))) || (r.student_id && r.student_id.toLowerCase() === text);
    })
    .slice(0, SEARCH_LIMIT)
    .map((r) => ({ id: r.id, name: r.name, idHint: maskId(r.student_id) }));
  return { people };
}

function cleanGuest(raw = {}) {
  const name = String(raw.name ?? '').replace(/\s+/g, ' ').trim();
  const studentId = String(raw.studentId ?? '').trim();
  const email = String(raw.email ?? '').trim().toLowerCase();
  if (!name) throw fail('please give your name');
  if (name.length > MAX_NAME) throw fail(`a name can be at most ${MAX_NAME} characters`);
  if (studentId.length > MAX_STUDENT_ID) throw fail(`an ID can be at most ${MAX_STUDENT_ID} characters`);
  if (!email) throw fail('please give an email address, so your instructor can follow up');
  if (email.length > MAX_EMAIL || !EMAIL_RE.test(email)) throw fail(`“${email}” is not an email address`);
  return { name, studentId, email };
}

/**
 * Check in: someone on the roster (`rosterId`) or a guest (`guest`). Checking
 * the same person in twice changes nothing and shows the first receipt again.
 */
function checkIn(db, { ticket, device, ip, rosterId, guest, how = 'code', now = Date.now() } = {}) {
  const deviceHash = keyed(db, 'd', cleanDevice(device));
  const session = redeemTicket(db, ticket, deviceHash, now);
  const ipHash = keyed(db, 'n', ip);

  let person;
  let guestFields = null;
  if (rosterId != null && rosterId !== '') {
    person = db.prepare('SELECT * FROM course_roster WHERE id = ? AND course_id = ? AND removed_at IS NULL').get(Number(rosterId), session.course_id);
    if (!person) throw fail('that name is not on this class list any more - check in as a guest instead', 404);
  } else {
    guestFields = cleanGuest(guest);
    // Someone who could not find themselves but gave their own ID or email
    // is still them: mark the roster entry, not a guest.
    person = db.prepare(`SELECT * FROM course_roster WHERE course_id = ? AND removed_at IS NULL
        AND ((student_id <> '' AND lower(student_id) = lower(?)) OR (email <> '' AND email = ?)) ORDER BY id LIMIT 1`)
      .get(session.course_id, guestFields.studentId, guestFields.email) || null;
  }

  const existing = person
    ? db.prepare('SELECT * FROM attendance_marks WHERE session_id = ? AND roster_id = ?').get(session.id, person.id)
    : db.prepare('SELECT * FROM attendance_marks WHERE session_id = ? AND roster_id IS NULL AND guest_email = ?').get(session.id, guestFields.email);
  if (existing) return receiptOf(db, session, existing, true);

  const total = db.prepare('SELECT COUNT(*) AS n FROM attendance_marks WHERE session_id = ?').get(session.id).n;
  if (total >= MAX_MARKS) throw fail('this check-in is full', 429);
  const fromThisDevice = deviceHash
    ? db.prepare(`SELECT m.id, m.flags FROM attendance_marks m JOIN attendance_evidence e ON e.mark_id = m.id
        WHERE m.session_id = ? AND e.device_hash = ?`).all(session.id, deviceHash)
    : [];
  if (fromThisDevice.length >= MAX_PER_DEVICE) throw fail(`this phone has already checked in ${MAX_PER_DEVICE} people - ask your instructor`, 429);

  const status = lateAt(session, now) ? 'late' : 'present';
  const flags = fromThisDevice.length ? [{ kind: 'device', with: fromThisDevice.map((m) => m.id) }] : [];
  let mark;
  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = db.prepare(`INSERT INTO attendance_marks
        (session_id, roster_id, guest_name, guest_student_id, guest_email, status, how, at, flags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, person ? person.id : null,
        person ? '' : guestFields.name, person ? '' : guestFields.studentId, person ? '' : guestFields.email,
        status, how === 'scan' ? 'scan' : 'code', now, JSON.stringify(flags));
    db.prepare('INSERT INTO attendance_evidence (mark_id, device_hash, ip_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(lastInsertRowid, deviceHash, ipHash, now);
    // The earlier check-ins from this browser are flagged too: the second
    // name is as much in question as the first.
    for (const other of fromThisDevice) {
      const otherFlags = parseFlags(other.flags);
      const deviceFlag = otherFlags.find((f) => f.kind === 'device');
      if (deviceFlag) deviceFlag.with = [...new Set([...(deviceFlag.with || []), Number(lastInsertRowid)])];
      else otherFlags.push({ kind: 'device', with: [Number(lastInsertRowid)] });
      db.prepare('UPDATE attendance_marks SET flags = ? WHERE id = ?').run(JSON.stringify(otherFlags), other.id);
    }
    mark = db.prepare('SELECT * FROM attendance_marks WHERE id = ?').get(lastInsertRowid);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    // Two taps at once for the same person: the unique index caught the
    // second. Show the first receipt rather than an error.
    if (person && /UNIQUE/i.test(err.message)) {
      const first = db.prepare('SELECT * FROM attendance_marks WHERE session_id = ? AND roster_id = ?').get(session.id, person.id);
      if (first) return receiptOf(db, session, first, true);
    }
    throw err;
  }
  return receiptOf(db, session, mark);
}

/**
 * A phone's answers to the questions open now (the entry or the exit ticket).
 * It needs a ticket - a code from the screen, so the student is in the room -
 * and the key of its own check-in. Answering again replaces the answers.
 */
function answer(db, { ticket, device, markKey: key, answers = {}, now = Date.now() } = {}) {
  const deviceHash = keyed(db, 'd', cleanDevice(device));
  const session = redeemTicket(db, ticket, deviceHash, now);
  const mark = markForKey(db, key, session.id);
  const { phase, questions } = askedOf(db, session, mark.id);
  if (!questions.length) throw fail('there are no questions to answer right now', 409);
  const put = db.prepare(`INSERT INTO attendance_answers (mark_id, phase, question_id, answer, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mark_id, phase, question_id) DO UPDATE SET answer = excluded.answer, at = excluded.at`);
  let saved = 0;
  for (const q of questions) {
    let value = answers && typeof answers === 'object' ? answers[q.id] : undefined;
    if (value === undefined || value === null || value === '') continue;
    if (q.kind === 'choice') {
      const i = Number(value);
      if (!Number.isInteger(i) || i < 0 || i >= q.options.length) throw fail(`pick one of the choices for “${q.prompt}”`);
      value = q.options[i];
    } else {
      value = String(value).trim().slice(0, MAX_ANSWER);
      if (!value) continue;
    }
    put.run(mark.id, phase, q.id, value, now);
    saved += 1;
  }
  return { ...receiptOf(db, session, mark, true), saved };
}

/**
 * Whether a phone that checked in earlier is asked anything now: reopening
 * the page, or the exit ticket opening. Only its own key is needed.
 */
function status(db, { markKey: key, now = Date.now() } = {}) {
  const mark = markForKey(db, key);
  const session = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(mark.session_id);
  return { ...askedOf(db, session, mark.id), open: isOpen(session, now), sessionId: session.id };
}

/**
 * A question for the parking lot. In the asker's name if they checked in and
 * want it so; anonymous otherwise, with nothing kept that ties it to them.
 * Either way the phone has to have been in the room: a check-in's key, or a
 * fresh code.
 */
function park(db, { ticket, device, markKey: key, text, anonymous = false, now = Date.now() } = {}) {
  const deviceHash = keyed(db, 'd', cleanDevice(device));
  let session;
  let mark = null;
  if (key) {
    mark = markForKey(db, key);
    session = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(mark.session_id);
    if (!session || now - session.created_at > MAX_OPEN_MS) throw fail('this class’s parking lot has closed', 410);
  } else {
    session = redeemTicket(db, ticket, deviceHash, now);
  }
  if (!session.parking) throw fail('the parking lot is not open for this class', 409);
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_PARKING_TEXT);
  if (!clean) throw fail('write your question first');
  if (!allow(`park:${deviceHash || key || ticket}`, 5, 10 * 60 * 1000, now)) throw fail('that is a lot of questions - wait a few minutes', 429, { retryAfterSeconds: 120 });
  const count = db.prepare('SELECT COUNT(*) AS n FROM attendance_parking WHERE session_id = ?').get(session.id).n;
  if (count >= MAX_PARKING) throw fail('the parking lot is full', 429);
  const named = mark && !anonymous;
  const { lastInsertRowid } = db.prepare('INSERT INTO attendance_parking (session_id, mark_id, name, text, at) VALUES (?, ?, ?, ?, ?)')
    .run(session.id, named ? mark.id : null, named ? markName(db, mark) : '', clean, now);
  return { id: Number(lastInsertRowid), anonymous: !named };
}

/** What a display showing check-in asks for every few seconds. */
function screen(db, { sessionId, key, now = Date.now() } = {}) {
  const session = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(Number(sessionId));
  if (!session || !key || !sameText(key, session.screen_key)) throw fail('no such check-in', 404);
  const course = courseOf(db, session);
  const open = isOpen(session, now);
  const showing = open ? currentCode(session, now) : null;
  return {
    open,
    code: showing?.code || '',
    rotatesInMs: showing?.rotatesInMs || 0,
    rotate: session.rotate_s,
    count: countMarks(db, session.id),
    late: open && lateAt(session, now),
    phase: session.phase === 'exit' ? 'exit' : 'entry',
    course: course.code.toUpperCase(),
    title: session.title || course.title || '',
  };
}

// --- the instructor's side ------------------------------------------------------

/** Whether this person may take attendance for a course: anyone in it. */
function mayTake(db, user, code) {
  return !!courses.roleOf(db, user, code);
}

function courseFor(db, user, code) {
  if (!code || !mayTake(db, user, code)) throw fail(`no course with the code ${code}`, 404);
  return courses.find(db, code);
}

function sessionFor(db, user, id) {
  const session = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(Number(id));
  if (!session) throw fail('no such attendance session', 404);
  const course = courseOf(db, session);
  if (!mayTake(db, user, course.code)) throw fail('no such attendance session', 404);
  return session;
}

function cleanRule(raw, fallbackFrom) {
  if (!raw || typeof raw !== 'object') return null;
  const after = raw.after === null || raw.after === '' || raw.after === undefined ? null : Number(raw.after);
  if (after != null && (!Number.isFinite(after) || after < 0 || after > 600)) throw fail('“late after” must be between 0 and 600 minutes');
  const from = Number(raw.from) || fallbackFrom;
  return { after: after == null ? null : Math.round(after), from };
}

/** A session as the controller sees it: no marks, just the counts. */
function sessionView(db, session, now = Date.now()) {
  const course = courseOf(db, session);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM attendance_marks WHERE session_id = ? GROUP BY status').all(session.id)) {
    counts[row.status] = row.n;
  }
  return {
    id: session.id,
    course: course.code,
    courseTitle: course.title || '',
    lectureId: session.lecture_id,
    title: session.title || '',
    createdAt: session.created_at,
    open: isOpen(session, now),
    openedAt: session.opened_at,
    closedAt: session.closed_at,
    lateRule: lateRule(session),
    lateNow: !!session.late_now,
    lateApplies: lateAt(session, now),
    rotate: session.rotate_s,
    screenKey: session.screen_key,
    phase: session.phase === 'exit' ? 'exit' : 'entry',
    questions: parseQuestions(session.questions),
    parking: !!session.parking,
    counts,
    rosterSize: db.prepare('SELECT COUNT(*) AS n FROM course_roster WHERE course_id = ? AND removed_at IS NULL').get(session.course_id).n,
  };
}

/**
 * Set what a session asks: its phase (entry or exit ticket), the questions
 * for either or both phases ({entry: [...], exit: [...]}, each cleaned), and
 * whether its parking lot is open. Anything not given is left as it was.
 */
function applyAsks(db, session, { questions, parking, phase } = {}) {
  if (phase !== undefined) {
    if (!PHASES.includes(phase)) throw fail('a check-in is either the entry or the exit ticket');
    db.prepare('UPDATE attendance_sessions SET phase = ? WHERE id = ?').run(phase, session.id);
  }
  if (questions && typeof questions === 'object') {
    const current = parseQuestions(db.prepare('SELECT questions FROM attendance_sessions WHERE id = ?').get(session.id).questions);
    for (const p of PHASES) if (questions[p] !== undefined) current[p] = cleanQuestions(questions[p]);
    db.prepare('UPDATE attendance_sessions SET questions = ? WHERE id = ?').run(JSON.stringify(current), session.id);
  }
  if (parking !== undefined) db.prepare('UPDATE attendance_sessions SET parking = ? WHERE id = ?').run(parking ? 1 : 0, session.id);
}

/**
 * Open check-in for a course. With a lecture, a session already taken in that
 * lecture is opened again rather than a second one started - closing and
 * reopening is one window that happened twice, not two classes.
 */
function openSession(db, user, { course: code, lectureId = null, title = '', lateRule: rule = null, rotate = DEFAULT_ROTATE, questions, parking, phase, now = Date.now() } = {}) {
  const course = courseFor(db, user, code);
  const lecture = lectureId
    ? db.prepare('SELECT id, title FROM lectures WHERE id = ?').get(Number(lectureId))
    : null;
  const existing = lecture
    ? db.prepare('SELECT * FROM attendance_sessions WHERE course_id = ? AND lecture_id = ? ORDER BY id DESC LIMIT 1').get(course.id, lecture.id)
    : null;
  if (existing) {
    const next = cleanRule(rule, now);
    db.prepare(`UPDATE attendance_sessions SET opened_at = ?, closed_at = NULL${next ? ', late_rule = ?' : ''} WHERE id = ?`)
      .run(...[now, ...(next ? [JSON.stringify(next)] : []), existing.id]);
    applyAsks(db, existing, { questions, parking, phase });
    return { session: sessionView(db, db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(existing.id), now), reopened: true };
  }
  const seconds = ROTATIONS.includes(Number(rotate)) ? Number(rotate) : DEFAULT_ROTATE;
  const cleanTitle = String(title || lecture?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const { lastInsertRowid } = db.prepare(`INSERT INTO attendance_sessions
      (course_id, lecture_id, title, created_at, created_by, opened_at, late_rule, rotate_s, secret, screen_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(course.id, lecture ? lecture.id : null, cleanTitle, now, user.id, now,
      JSON.stringify(cleanRule(rule, now) || { after: null, from: now }), seconds,
      crypto.randomBytes(32).toString('hex'), crypto.randomBytes(18).toString('base64url'));
  applyAsks(db, db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(lastInsertRowid), { questions, parking, phase });
  return { session: sessionView(db, db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(lastInsertRowid), now), reopened: false };
}

/**
 * The session a controller should pick up: the one taken in this lecture if
 * there is one, otherwise the course's newest session if it is still open.
 */
function currentSession(db, user, { course: code, lectureId = null, now = Date.now() } = {}) {
  const course = courseFor(db, user, code);
  let row = lectureId
    ? db.prepare('SELECT * FROM attendance_sessions WHERE course_id = ? AND lecture_id = ? ORDER BY id DESC LIMIT 1').get(course.id, Number(lectureId))
    : null;
  if (!row) {
    const newest = db.prepare('SELECT * FROM attendance_sessions WHERE course_id = ? ORDER BY id DESC LIMIT 1').get(course.id);
    if (newest && isOpen(newest, now)) row = newest;
  }
  return { session: row ? sessionView(db, row, now) : null };
}

function changeSession(db, user, id, body = {}, { now = Date.now() } = {}) {
  const session = sessionFor(db, user, id);
  if (body.open === true && !isOpen(session, now)) {
    db.prepare('UPDATE attendance_sessions SET opened_at = ?, closed_at = NULL WHERE id = ?').run(now, session.id);
  } else if (body.open === false && session.opened_at != null) {
    db.prepare('UPDATE attendance_sessions SET opened_at = NULL, closed_at = ? WHERE id = ?').run(now, session.id);
  }
  if (body.lateNow !== undefined) db.prepare('UPDATE attendance_sessions SET late_now = ? WHERE id = ?').run(body.lateNow ? 1 : 0, session.id);
  if (body.lateRule !== undefined) {
    const rule = cleanRule(body.lateRule || { after: null }, now);
    db.prepare('UPDATE attendance_sessions SET late_rule = ? WHERE id = ?').run(JSON.stringify(rule), session.id);
  }
  applyAsks(db, session, body);
  if (body.title !== undefined) {
    db.prepare('UPDATE attendance_sessions SET title = ? WHERE id = ?').run(String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 200), session.id);
  }
  return sessionView(db, db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(session.id), now);
}

/**
 * The flags on a session's marks, in words a person can act on: who shares a
 * phone with whom, and (more weakly) who checked in from the same network
 * address within a couple of minutes, in a group too small to be a campus's
 * shared Wi-Fi.
 */
function flagsFor(db, marks) {
  const byId = new Map(marks.map((m) => [m.id, m]));
  const name = (id) => (byId.has(id) ? byId.get(id).name : 'someone since removed');
  const out = new Map(marks.map((m) => [m.id, []]));
  for (const m of marks) {
    for (const flag of parseFlags(m.flags)) {
      if (flag.kind === 'device') out.get(m.id).push({ kind: 'device', with: (flag.with || []).map(name) });
    }
  }
  const byNet = new Map();
  for (const m of marks) if (m.ip_hash) byNet.set(m.ip_hash, [...(byNet.get(m.ip_hash) || []), m]);
  const traced = marks.filter((m) => m.ip_hash).length;
  for (const group of byNet.values()) {
    if (group.length < 2 || group.length > NETWORK_GROUP_MAX) continue;
    // A network most of the room is on is the room's own Wi-Fi: it says
    // nothing about who is where.
    if (group.length * 2 > traced) continue;
    const times = group.map((m) => m.at);
    if (Math.max(...times) - Math.min(...times) > NETWORK_SPAN_MS) continue;
    for (const m of group) {
      const sharedDevice = out.get(m.id).some((f) => f.kind === 'device');
      const others = group.filter((o) => o.id !== m.id && !(sharedDevice && o.device_hash && o.device_hash === m.device_hash));
      if (others.length) out.get(m.id).push({ kind: 'network', with: others.map((o) => o.name) });
    }
  }
  return out;
}

/** A session with everyone in it: the roster with their marks, then guests. */
function getSession(db, user, id, { now = Date.now() } = {}) {
  const session = sessionFor(db, user, id);
  const marks = db.prepare(`SELECT m.*, e.device_hash, e.ip_hash, r.name AS roster_name, r.student_id AS roster_student_id
      FROM attendance_marks m
      LEFT JOIN attendance_evidence e ON e.mark_id = m.id
      LEFT JOIN course_roster r ON r.id = m.roster_id
     WHERE m.session_id = ? ORDER BY m.at, m.id`).all(session.id)
    .map((m) => ({ ...m, name: m.roster_id ? m.roster_name || '(removed)' : m.guest_name }));
  const flags = flagsFor(db, marks);
  const userName = (uid) => (uid ? db.prepare('SELECT display_name, username FROM users WHERE id = ?').get(uid) : null);
  const who = (uid) => { const u = userName(uid); return u ? u.display_name || u.username : ''; };
  // Each mark's answers, by phase then question.
  const answers = new Map();
  for (const a of db.prepare(`SELECT a.* FROM attendance_answers a JOIN attendance_marks m ON m.id = a.mark_id WHERE m.session_id = ?`).all(session.id)) {
    if (!answers.has(a.mark_id)) answers.set(a.mark_id, { entry: {}, exit: {} });
    (answers.get(a.mark_id)[a.phase] ||= {})[a.question_id] = a.answer;
  }
  const markView = (m) => ({
    id: m.id, status: m.status, how: m.how, at: m.at, flags: flags.get(m.id) || [], edited: !!m.edited_at,
    answers: answers.get(m.id) || null,
    editedBy: m.edited_at ? who(m.edited_by) : '',
    // Flags looked at and let go: still listed, no longer asking for attention.
    dismissed: m.flags_dismissed_at ? { at: m.flags_dismissed_at, by: who(m.flags_dismissed_by) } : null,
  });
  const marked = new Map(marks.filter((m) => m.roster_id).map((m) => [m.roster_id, m]));
  const open = isOpen(session, now);
  const roster = db.prepare('SELECT id, name, student_id, email, added_at, removed_at FROM course_roster WHERE course_id = ? ORDER BY lower(name), id')
    .all(session.course_id)
    .filter((r) => marked.has(r.id) || !r.removed_at || enrolled(r, session));
  const history = db.prepare(`SELECT a.*, u.display_name, u.username FROM attendance_audit a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.session_id = ? ORDER BY a.at DESC, a.id DESC LIMIT 500`).all(session.id)
    .map((a) => ({ at: a.at, action: a.action, name: a.name, before: a.before, after: a.after, by: a.display_name || a.username || '' }));
  return {
    session: sessionView(db, session, now),
    mayEditRoster: courses.roleOf(db, user, courseOf(db, session).code) === 'owner',
    people: roster.map((r) => ({
      rosterId: r.id, name: r.name, studentId: r.student_id, removed: !!r.removed_at,
      mark: marked.has(r.id) ? markView(marked.get(r.id)) : null,
      // Once check-in has closed, someone on the roster who never checked in
      // was absent - without anyone having to mark them so.
      absent: !marked.has(r.id) && !open && enrolled(r, session),
    })),
    guests: marks.filter((m) => !m.roster_id).map((m) => ({
      name: m.guest_name, studentId: m.guest_student_id, email: m.guest_email, mark: markView(m),
    })),
    history,
    summary: summarize(parseQuestions(session.questions), [...answers.values()]),
    parking: db.prepare(`SELECT p.*, u.display_name, u.username FROM attendance_parking p LEFT JOIN users u ON u.id = p.answered_by
        WHERE p.session_id = ? ORDER BY p.at DESC, p.id DESC`).all(session.id)
      .map((q) => ({ id: q.id, name: q.name, anonymous: !q.mark_id && !q.name, text: q.text, at: q.at,
        answeredAt: q.answered_at, answeredBy: q.display_name || q.username || '' })),
  };
}

/**
 * What the room answered, question by question: how many chose each option,
 * or every short answer.
 */
function summarize(questions, answerSets) {
  const out = {};
  for (const phase of PHASES) {
    out[phase] = questions[phase].map((q) => {
      const given = answerSets.map((a) => a[phase]?.[q.id]).filter((v) => v !== undefined);
      return q.kind === 'choice'
        ? { ...q, answered: given.length, counts: q.options.map((o) => given.filter((g) => g === o).length) }
        : { ...q, answered: given.length, answers: given };
    });
  }
  return out;
}

/**
 * Whether someone on the roster was expected at a session: on the roster when
 * it began, and not taken off before it. Someone added later is not marked
 * absent from classes held before they joined.
 */
function enrolled(person, session) {
  return person.added_at <= session.created_at && (!person.removed_at || person.removed_at > session.created_at);
}

function cleanStatus(status) {
  if (!STATUSES.includes(status)) throw fail(`a mark is one of ${STATUSES.join(', ')}`);
  return status;
}

/** One line of a session's history: who changed which mark, from what to what. */
function audit(db, { session, markId = null, user, action, name = '', before = null, after = null, now = Date.now() }) {
  db.prepare(`INSERT INTO attendance_audit (session_id, mark_id, user_id, at, action, name, before, after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(session.id, markId, user?.id ?? null, now, action, name, before, after);
}

/**
 * Mark someone on the roster by hand - the student with no phone, or one whose
 * phone would not cooperate. A hand mark carries no device, so it is never
 * flagged. Marking someone already marked changes their status.
 */
function markByHand(db, user, id, { rosterId, status = 'present' } = {}, { now = Date.now() } = {}) {
  const session = sessionFor(db, user, id);
  const clean = cleanStatus(status);
  const person = db.prepare('SELECT * FROM course_roster WHERE id = ? AND course_id = ?').get(Number(rosterId), session.course_id);
  if (!person) throw fail('that person is not on this roster', 404);
  const existing = db.prepare('SELECT * FROM attendance_marks WHERE session_id = ? AND roster_id = ?').get(session.id, person.id);
  if (existing) {
    db.prepare('UPDATE attendance_marks SET status = ?, edited_by = ?, edited_at = ? WHERE id = ?').run(clean, user.id, now, existing.id);
    if (existing.status !== clean) {
      audit(db, { session, markId: existing.id, user, action: 'changed', name: person.name, before: existing.status, after: clean, now });
    }
    return { name: person.name, before: existing.status, status: clean, markId: existing.id };
  }
  const { lastInsertRowid } = db.prepare(`INSERT INTO attendance_marks (session_id, roster_id, status, how, at, marked_by)
      VALUES (?, ?, ?, 'hand', ?, ?)`).run(session.id, person.id, clean, now, user.id);
  audit(db, { session, markId: Number(lastInsertRowid), user, action: 'marked', name: person.name, after: clean, now });
  return { name: person.name, before: null, status: clean, markId: Number(lastInsertRowid) };
}

function markIn(db, session, markId) {
  const mark = db.prepare('SELECT * FROM attendance_marks WHERE id = ? AND session_id = ?').get(Number(markId), session.id);
  if (!mark) throw fail('no such mark in this session', 404);
  return mark;
}

/** Change any mark's status - a guest's too. */
function changeMark(db, user, id, markId, { status } = {}, { now = Date.now() } = {}) {
  const session = sessionFor(db, user, id);
  const mark = markIn(db, session, markId);
  const clean = cleanStatus(status);
  const name = markName(db, mark);
  db.prepare('UPDATE attendance_marks SET status = ?, edited_by = ?, edited_at = ? WHERE id = ?').run(clean, user.id, now, mark.id);
  if (mark.status !== clean) audit(db, { session, markId: mark.id, user, action: 'changed', name, before: mark.status, after: clean, now });
  return { name, before: mark.status, status: clean, markId: mark.id };
}

/** Take a mark back off: a mis-tap, or a check-in that should not have been. */
function removeMark(db, user, id, markId, { now = Date.now() } = {}) {
  const session = sessionFor(db, user, id);
  const mark = markIn(db, session, markId);
  const name = markName(db, mark);
  db.prepare('DELETE FROM attendance_marks WHERE id = ?').run(mark.id);
  audit(db, { session, markId: mark.id, user, action: 'removed', name, before: mark.status, now });
  // The others it was flagged with no longer share a phone with anyone here.
  for (const other of db.prepare('SELECT id, flags FROM attendance_marks WHERE session_id = ?').all(session.id)) {
    const flags = parseFlags(other.flags);
    let changed = false;
    for (const f of flags) {
      if (f.kind === 'device' && (f.with || []).includes(mark.id)) { f.with = f.with.filter((x) => x !== mark.id); changed = true; }
    }
    if (changed) {
      db.prepare('UPDATE attendance_marks SET flags = ? WHERE id = ?')
        .run(JSON.stringify(flags.filter((f) => f.kind !== 'device' || f.with.length)), other.id);
    }
  }
  return { name, before: mark.status, markId: mark.id };
}

/** Let a mark's flags go: looked at, and nothing wrong. */
function dismissFlags(db, user, id, markId, { now = Date.now() } = {}) {
  const session = sessionFor(db, user, id);
  const mark = markIn(db, session, markId);
  const name = markName(db, mark);
  db.prepare('UPDATE attendance_marks SET flags_dismissed_at = ?, flags_dismissed_by = ? WHERE id = ?').run(now, user.id, mark.id);
  audit(db, { session, markId: mark.id, user, action: 'flags_dismissed', name, now });
  return { name, markId: mark.id };
}

/**
 * Put a guest on the course's roster in one step: a late add who checked in
 * as a guest. Their check-ins as a guest in this course - this one and any
 * other with the same email - become theirs on the roster. Only someone who
 * may change the roster (an owner, an admin) may do it.
 */
function addGuestToRoster(db, user, id, markId, { now = Date.now() } = {}) {
  const session = sessionFor(db, user, id);
  const mark = markIn(db, session, markId);
  if (mark.roster_id) throw fail('they are already on the roster', 409);
  const code = courseOf(db, session).code;
  const person = roster.add(db, user, code, { name: mark.guest_name, studentId: mark.guest_student_id, email: mark.guest_email }, { source: 'guest', now });
  // On the roster from their first check-in here, so the term grid does not
  // count them absent from classes they were at as a guest.
  const first = db.prepare(`SELECT MIN(s.created_at) AS t FROM attendance_marks m JOIN attendance_sessions s ON s.id = m.session_id
      WHERE s.course_id = ? AND m.roster_id IS NULL AND m.guest_email = ?`).get(session.course_id, mark.guest_email).t;
  if (first) db.prepare('UPDATE course_roster SET added_at = ? WHERE id = ?').run(Math.min(first, now), person.id);
  const { changes } = db.prepare(`UPDATE attendance_marks SET roster_id = ?, guest_name = '', guest_student_id = '', guest_email = ''
      WHERE roster_id IS NULL AND guest_email = ? AND guest_email <> ''
        AND session_id IN (SELECT id FROM attendance_sessions WHERE course_id = ?)`).run(person.id, mark.guest_email, session.course_id);
  audit(db, { session, markId: mark.id, user, action: 'added_to_roster', name: person.name, now });
  return { person, linked: Number(changes) };
}

/** Delete a whole session: a check-in opened by mistake. Owners and admins only. */
function deleteSession(db, user, id) {
  const session = sessionFor(db, user, id);
  const course = courseOf(db, session);
  if (courses.roleOf(db, user, course.code) !== 'owner') {
    throw fail(`only an owner of ${course.code.toUpperCase()} or an admin can delete a check-in session`, 403);
  }
  const marks = db.prepare('SELECT COUNT(*) AS n FROM attendance_marks WHERE session_id = ?').get(session.id).n;
  db.prepare('DELETE FROM attendance_sessions WHERE id = ?').run(session.id);
  return { id: session.id, course: course.code, marks };
}

/** Mark a parking-lot question answered (or not). */
function answerParking(db, user, id, parkingId, { answered = true } = {}, { now = Date.now() } = {}) {
  const session = sessionFor(db, user, id);
  const row = db.prepare('SELECT * FROM attendance_parking WHERE id = ? AND session_id = ?').get(Number(parkingId), session.id);
  if (!row) throw fail('no such question in this parking lot', 404);
  db.prepare('UPDATE attendance_parking SET answered_at = ?, answered_by = ? WHERE id = ?')
    .run(answered ? now : null, answered ? user.id : null, row.id);
  return { id: row.id, answered: !!answered };
}

/** A session's answers and parking lot as a CSV: one row per answer or question. */
function answersCsv(db, user, id) {
  const data = getSession(db, user, id);
  const lines = [csvLine(['phase', 'question', 'name', 'student id', 'answer', 'at'])];
  const prompts = Object.fromEntries(PHASES.map((p) => [p, Object.fromEntries(data.session.questions[p].map((q) => [q.id, q.prompt]))]));
  const rows = [
    ...data.people.filter((p) => p.mark).map((p) => ({ name: p.name, studentId: p.studentId, mark: p.mark })),
    ...data.guests.map((g) => ({ name: g.name, studentId: g.studentId, mark: g.mark })),
  ];
  for (const phase of PHASES) {
    for (const r of rows) {
      for (const [qid, value] of Object.entries(r.mark.answers?.[phase] || {})) {
        lines.push(csvLine([phase, prompts[phase][qid] || qid, r.name, r.studentId, value, '']));
      }
    }
  }
  for (const q of [...data.parking].reverse()) {
    lines.push(csvLine(['parking lot', '', q.anonymous ? '(anonymous)' : q.name, '', q.text, new Date(q.at).toISOString()]));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// --- after class: the course's sessions, the term grid, exports ---------------

function sessionsIn(db, courseId, { from = 0, to = 0 } = {}) {
  return db.prepare(`SELECT * FROM attendance_sessions WHERE course_id = ?
      AND created_at >= ? AND created_at < ? ORDER BY created_at, id`)
    .all(courseId, Number(from) || 0, Number(to) || 8.64e15);
}

/** A course's sessions, newest first, with their counts. */
function listSessions(db, user, code, { from, to, now = Date.now() } = {}) {
  const course = courseFor(db, user, code);
  const rows = sessionsIn(db, course.id, { from, to }).reverse();
  const flagged = db.prepare(`SELECT COUNT(*) AS n FROM attendance_marks WHERE session_id = ? AND flags <> '[]' AND flags_dismissed_at IS NULL`);
  const people = db.prepare('SELECT id, added_at, removed_at FROM course_roster WHERE course_id = ?').all(course.id);
  return {
    course: course.code,
    mayEditRoster: courses.roleOf(db, user, code) === 'owner',
    sessions: rows.map((row) => {
      const marked = new Set(db.prepare('SELECT roster_id FROM attendance_marks WHERE session_id = ? AND roster_id IS NOT NULL').all(row.id).map((m) => m.roster_id));
      // Who never checked in to a closed session: absent, though nobody marked them so.
      const notCheckedIn = isOpen(row, now) ? 0 : people.filter((p) => !marked.has(p.id) && enrolled(p, row)).length;
      return { ...sessionView(db, row, now), screenKey: undefined, flagged: flagged.get(row.id).n, notCheckedIn };
    }),
  };
}

// A local calendar date for a moment, given the reader's offset from UTC in
// minutes (what Date#getTimezoneOffset says): a 7 pm class in Chicago is that
// day's, not tomorrow's in UTC.
const dateKey = (ms, tz = 0) => new Date(ms - (Number(tz) || 0) * 60000).toISOString().slice(0, 10);

const LETTER = { present: 'P', late: 'L', absent: 'A', excused: 'E' };

/**
 * The term grid: everyone x every session in range. A cell is a status, or
 * '' where the person was not expected (not yet on the roster, already taken
 * off, or check-in still open and they have not come). Someone on the roster
 * who never checked in to a closed session is absent. Guests get a row each,
 * by email, after the roster.
 *
 * The rate is (present + late) / (present + late + absent): excused classes
 * count for nothing either way.
 */
function grid(db, user, code, { from, to, tz = 0, now = Date.now() } = {}) {
  const course = courseFor(db, user, code);
  const sessions = sessionsIn(db, course.id, { from, to });
  const ids = sessions.map((s) => s.id);
  const marks = ids.length
    ? db.prepare(`SELECT * FROM attendance_marks WHERE session_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : [];
  const byPerson = new Map();   // roster id -> session id -> mark
  const guests = new Map();     // email -> { name, studentId, email, marks: session id -> mark }
  for (const m of marks) {
    if (m.roster_id) {
      if (!byPerson.has(m.roster_id)) byPerson.set(m.roster_id, new Map());
      byPerson.get(m.roster_id).set(m.session_id, m);
    } else {
      const key = m.guest_email || `#${m.id}`;
      if (!guests.has(key)) guests.set(key, { name: m.guest_name, studentId: m.guest_student_id, email: m.guest_email, marks: new Map() });
      guests.get(key).marks.set(m.session_id, m);
    }
  }
  const people = db.prepare('SELECT * FROM course_roster WHERE course_id = ? ORDER BY lower(name), id').all(course.id)
    .filter((r) => byPerson.has(r.id) || sessions.some((s) => enrolled(r, s)));
  const total = (cells) => {
    const t = { present: 0, late: 0, absent: 0, excused: 0 };
    for (const c of cells) if (c) t[c] += 1;
    const counted = t.present + t.late + t.absent;
    return { ...t, rate: counted ? (t.present + t.late) / counted : null };
  };
  const rows = people.map((r) => {
    const mine = byPerson.get(r.id) || new Map();
    const cells = sessions.map((s) => mine.get(s.id)?.status || (enrolled(r, s) && !isOpen(s, now) ? 'absent' : ''));
    return { rosterId: r.id, name: r.name, studentId: r.student_id, email: r.email, removed: !!r.removed_at, guest: false, cells, totals: total(cells) };
  });
  for (const g of guests.values()) {
    const cells = sessions.map((s) => g.marks.get(s.id)?.status || '');
    rows.push({ rosterId: null, name: g.name, studentId: g.studentId, email: g.email, removed: false, guest: true, cells, totals: total(cells) });
  }
  // Two sessions on one day are told apart by a number, so columns stay unique.
  const seen = new Map();
  const columns = sessions.map((s) => {
    const day = dateKey(s.created_at, tz);
    const n = (seen.get(day) || 0) + 1;
    seen.set(day, n);
    return { id: s.id, date: day, label: n > 1 ? `${day} (${n})` : day, title: s.title || '', at: s.created_at, open: isOpen(s, now) };
  });
  for (const c of columns) if (seen.get(c.date) > 1 && c.label === c.date) c.label = `${c.date} (1)`;
  return { course: course.code, courseTitle: course.title || '', sessions: columns, rows };
}

const csvField = (v) => (/[",\n\r]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
const csvLine = (fields) => fields.map(csvField).join(',');

function cleanPoints(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (String(raw).toLowerCase() === 'ex') return 'EX';
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw fail('points must be a number from 0 to 1000 (or EX for excused)');
  return n;
}

/**
 * A course's attendance as a CSV, in one of three shapes:
 *
 *   long    one row per person per session, with how and when they checked in
 *   grid    the term grid: one row per person, a P/L/A/E column per session,
 *           and the totals
 *   canvas  a Canvas gradebook import: Student, ID, SIS User ID, SIS Login ID,
 *           Section, then one column of points per session, with the
 *           "Points Possible" row Canvas expects. Present, late, excused and
 *           absent are worth what the caller says (1, 0.5, EX, 0 by default);
 *           EX is Canvas's own "excused". Roster people only - Canvas has
 *           nowhere to put a guest.
 */
function exportCsv(db, user, code, { format = 'long', from, to, tz = 0, points = {}, now = Date.now() } = {}) {
  const data = grid(db, user, code, { from, to, tz, now });
  const lines = [];
  if (format === 'grid') {
    lines.push(csvLine(['name', 'student id', 'email', 'guest', ...data.sessions.map((s) => s.label), 'present', 'late', 'absent', 'excused', 'rate']));
    for (const r of data.rows) {
      lines.push(csvLine([r.name, r.studentId, r.email, r.guest ? 'yes' : '', ...r.cells.map((c) => LETTER[c] || ''),
        r.totals.present, r.totals.late, r.totals.absent, r.totals.excused, r.totals.rate == null ? '' : `${Math.round(r.totals.rate * 100)}%`]));
    }
  } else if (format === 'canvas') {
    const pts = {
      present: cleanPoints(points.present, 1),
      late: cleanPoints(points.late, 0.5),
      excused: cleanPoints(points.excused, 'EX'),
      absent: cleanPoints(points.absent, 0),
    };
    const possible = typeof pts.present === 'number' ? pts.present : 1;
    lines.push(csvLine(['Student', 'ID', 'SIS User ID', 'SIS Login ID', 'Section', ...data.sessions.map((s) => `Attendance ${s.label}`)]));
    lines.push(csvLine(['Points Possible', '', '', '', '', ...data.sessions.map(() => possible)]));
    for (const r of data.rows.filter((row) => !row.guest)) {
      lines.push(csvLine([r.name, '', r.studentId, '', '', ...r.cells.map((c) => (c ? pts[c] : ''))]));
    }
  } else {
    const sessions = new Map(data.sessions.map((s) => [s.id, s]));
    const ids = data.sessions.map((s) => s.id);
    const marks = ids.length
      ? db.prepare(`SELECT * FROM attendance_marks WHERE session_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : [];
    const markOf = new Map(marks.map((m) => [`${m.session_id}:${m.roster_id ?? `g:${m.guest_email || m.id}`}`, m]));
    lines.push(csvLine(['date', 'session', 'name', 'student id', 'email', 'on roster', 'status', 'how', 'checked in at', 'flags']));
    for (const r of data.rows) {
      r.cells.forEach((cell, i) => {
        if (!cell) return;
        const s = data.sessions[i];
        const m = markOf.get(`${s.id}:${r.guest ? `g:${r.email}` : r.rosterId}`);
        const flags = m ? parseFlags(m.flags).map((f) => (f.kind === 'device' ? 'same phone' : f.kind)).join('; ') : '';
        lines.push(csvLine([sessions.get(s.id).date, s.title, r.name, r.studentId, r.email, r.guest ? 'guest' : 'yes', cell,
          m ? m.how : 'not checked in', m && m.how !== 'hand' ? new Date(m.at - (Number(tz) || 0) * 60000).toISOString().slice(11, 16) : '',
          flags + (m?.flags_dismissed_at && flags ? ' (dismissed)' : '')]));
      });
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// --- retention ------------------------------------------------------------------

/** Days device and network hashes are kept: the admin's setting, 30 by default. */
function retentionDays(db) {
  const days = Number(store.getSystemSetting(db, 'attendance_retention_days', String(DEFAULT_RETENTION_DAYS)));
  return Number.isInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS ? days : DEFAULT_RETENTION_DAYS;
}

function setRetentionDays(db, days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RETENTION_DAYS) {
    throw fail(`attendance retention must be a whole number of days from 1 to ${MAX_RETENTION_DAYS}`);
  }
  store.setSystemSetting(db, 'attendance_retention_days', String(n));
  return n;
}

/**
 * Forget the evidence behind check-ins older than the retention period. The
 * marks stay, flags and all - a flag already raised is the instructor's to
 * dismiss, not the clock's - but what it rested on goes.
 */
function prune(db, { days = retentionDays(db), now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const { changes } = db.prepare('DELETE FROM attendance_evidence WHERE created_at < ?').run(cutoff);
  // A session nobody closed is closed for them, dated when it stopped counting as open.
  db.prepare('UPDATE attendance_sessions SET closed_at = opened_at + ?, opened_at = NULL WHERE opened_at IS NOT NULL AND opened_at < ?')
    .run(MAX_OPEN_MS, now - MAX_OPEN_MS);
  return { removed: Number(changes) };
}

module.exports = {
  // the student's side
  redeemCode, searchPeople, checkIn, screen, answer, status, park,
  // the instructor's side
  mayTake, openSession, currentSession, changeSession, getSession, markByHand, changeMark, removeMark,
  // after class
  dismissFlags, addGuestToRoster, deleteSession, listSessions, grid, exportCsv,
  answerParking, answersCsv, cleanQuestions,
  // retention
  retentionDays, setRetentionDays, prune,
  // for tests
  currentCode, resetThrottle,
  ROTATIONS, STATUSES, MAX_PER_DEVICE, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS,
};
