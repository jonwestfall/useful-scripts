// A course's roster (Issue #256, phase 1): the people attendance is taken for.
//
// Rosters are not accounts. A student never signs in to Podium; they are a
// name, maybe a student ID and an email, filed under a course. The course's
// owners (and admins) keep the list - usually by importing the CSV their LMS
// or registrar already gives them - and its other members (TAs) can read it,
// since they take attendance too, but not change it.
//
// Removing someone only marks them removed: a session taken last month still
// has to know who "Jane Doe, present" was.

'use strict';

const courses = require('./courses.js');

const MAX_NAME = 120;
const MAX_STUDENT_ID = 64;
const MAX_EMAIL = 200;
const MAX_ROWS = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function personRow(row) {
  return {
    id: row.id,
    name: row.name,
    studentId: row.student_id,
    email: row.email,
    source: row.source,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    ...(row.removed_at ? { removedAt: row.removed_at } : {}),
  };
}

/** What this person may do with a course's roster: 'edit', 'read' or null. */
function access(db, user, code) {
  const role = courses.roleOf(db, user, code);
  return role === 'owner' ? 'edit' : role === 'member' ? 'read' : null;
}

function courseFor(db, user, code, need) {
  const course = courses.find(db, code);
  const may = access(db, user, code);
  if (!may) throw fail(`no course with the code ${code}`, 404);   // not a member: as if it were not there
  if (need === 'edit' && may !== 'edit') throw fail(`only an owner of ${String(code).toUpperCase()} or an admin can change its roster`, 403);
  return { course, may };
}

/** Tidy and check one person's fields. */
function cleanPerson(raw = {}) {
  const name = String(raw.name ?? '').replace(/\s+/g, ' ').trim();
  const studentId = String(raw.studentId ?? '').trim();
  const email = String(raw.email ?? '').trim().toLowerCase();
  if (!name) throw fail('a name is needed');
  if (name.length > MAX_NAME) throw fail(`a name can be at most ${MAX_NAME} characters`);
  if (studentId.length > MAX_STUDENT_ID) throw fail(`a student ID can be at most ${MAX_STUDENT_ID} characters`);
  if (email && (email.length > MAX_EMAIL || !EMAIL_RE.test(email))) throw fail(`“${email}” is not an email address`);
  return { name, studentId, email };
}

function current(db, courseId) {
  return db.prepare(`SELECT * FROM course_roster WHERE course_id = ? AND removed_at IS NULL
      ORDER BY lower(name), id`).all(courseId);
}

/**
 * The roster, for anyone in the course. `removed: true` adds the people taken
 * off it, marked, for an owner who wants to put someone back.
 */
function list(db, user, code, { removed = false } = {}) {
  const { course, may } = courseFor(db, user, code, 'read');
  const rows = removed && may === 'edit'
    ? db.prepare('SELECT * FROM course_roster WHERE course_id = ? ORDER BY removed_at IS NOT NULL, lower(name), id').all(course.id)
    : current(db, course.id);
  return { people: rows.map(personRow), mayEdit: may === 'edit' };
}

function clashes(db, courseId, studentId, exceptId = 0) {
  if (!studentId) return null;
  return db.prepare(`SELECT * FROM course_roster WHERE course_id = ? AND lower(student_id) = lower(?)
      AND removed_at IS NULL AND id <> ?`).get(courseId, studentId, exceptId);
}

function add(db, user, code, raw, { source = 'manual', now = Date.now() } = {}) {
  const { course } = courseFor(db, user, code, 'edit');
  const person = cleanPerson(raw);
  const other = clashes(db, course.id, person.studentId);
  if (other) throw fail(`${other.name} already has the student ID ${person.studentId}`, 409);
  const { lastInsertRowid } = db.prepare(`INSERT INTO course_roster
      (course_id, name, student_id, email, source, added_at, added_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(course.id, person.name, person.studentId, person.email, ['csv', 'manual', 'guest'].includes(source) ? source : 'manual', now, user.id, now);
  return personRow(db.prepare('SELECT * FROM course_roster WHERE id = ?').get(lastInsertRowid));
}

function rowIn(db, courseId, id) {
  const row = db.prepare('SELECT * FROM course_roster WHERE id = ? AND course_id = ?').get(Number(id), courseId);
  if (!row) throw fail('that person is not on this roster', 404);
  return row;
}

function update(db, user, code, id, raw, { now = Date.now() } = {}) {
  const { course } = courseFor(db, user, code, 'edit');
  const row = rowIn(db, course.id, id);
  const person = cleanPerson({ name: raw.name ?? row.name, studentId: raw.studentId ?? row.student_id, email: raw.email ?? row.email });
  // Putting someone back on the roster (undoing a removal) is an update too.
  const restore = raw.removed === false && row.removed_at;
  if (!row.removed_at || restore) {
    const other = clashes(db, course.id, person.studentId, row.id);
    if (other) throw fail(`${other.name} already has the student ID ${person.studentId}`, 409);
  }
  db.prepare(`UPDATE course_roster SET name = ?, student_id = ?, email = ?, updated_at = ?${restore ? ', removed_at = NULL' : ''}
      WHERE id = ?`).run(person.name, person.studentId, person.email, now, row.id);
  return personRow(db.prepare('SELECT * FROM course_roster WHERE id = ?').get(row.id));
}

function remove(db, user, code, id, { now = Date.now() } = {}) {
  const { course } = courseFor(db, user, code, 'edit');
  const row = rowIn(db, course.id, id);
  if (!row.removed_at) db.prepare('UPDATE course_roster SET removed_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.id);
  return personRow(db.prepare('SELECT * FROM course_roster WHERE id = ?').get(row.id));
}

// --- CSV ---------------------------------------------------------------------------

/** Rows of fields from CSV text: quotes, doubled quotes, CRLF, a BOM, and ; or tab as the separator. */
function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => (firstLine.match(new RegExp(ch === '\t' ? '\t' : `\\${ch}`, 'g')) || []).length;
  const sep = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === sep) { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Which column is which, by header. Covers a plain sheet and the exports
// people actually have: Canvas ("Student", "SIS User ID"), Blackboard and
// Moodle ("First name", "Last name", "Username", "Email address").
const HEADERS = {
  name: ['name', 'full name', 'student name', 'student', 'display name', 'preferred name'],
  first: ['first name', 'first', 'given name', 'firstname', 'forename'],
  last: ['last name', 'last', 'surname', 'family name', 'lastname'],
  // In order of preference: an institution's own ID beats an LMS's internal one.
  studentId: ['student id', 'sis user id', 'student number', 'student no', 'sid', 'emplid', 'id number', 'university id', 'id', 'username', 'sis login id'],
  email: ['email', 'email address', 'e mail', 'mail', 'school email', 'student email'],
};

function columnsOf(header) {
  const names = header.map(norm);
  const pick = (keys) => {
    for (const key of keys) { const at = names.indexOf(key); if (at >= 0) return at; }
    return -1;
  };
  return { name: pick(HEADERS.name), first: pick(HEADERS.first), last: pick(HEADERS.last), studentId: pick(HEADERS.studentId), email: pick(HEADERS.email) };
}

/**
 * The people in a CSV, and the lines that could not be read. A file with no
 * header row we recognise is read as name, student ID, email.
 */
function readRoster(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { people: [], problems: [{ line: 0, message: 'the file is empty' }], columns: null };
  let cols = columnsOf(rows[0]);
  let start = 1;
  const found = cols.name >= 0 || cols.first >= 0 || cols.last >= 0;
  if (!found) {
    // No header we know: name, ID, email in that order - but only if the
    // first line is a person rather than a header we failed to understand.
    // A real person's line has an ID or an email in it; a header has neither.
    const looksLikeData = rows[0].some((f) => /\d|@/.test(f));
    if (!looksLikeData && rows.length > 1) {
      return { people: [], problems: [{ line: 1, message: `no name column found (headers: ${rows[0].join(', ')})` }], columns: null };
    }
    cols = { name: 0, first: -1, last: -1, studentId: rows[0].length > 1 ? 1 : -1, email: rows[0].length > 2 ? 2 : -1 };
    start = 0;
  }
  const people = [];
  const problems = [];
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    const at = (n) => (n >= 0 ? String(row[n] ?? '').trim() : '');
    let name = at(cols.name);
    if (!name) name = [at(cols.first), at(cols.last)].filter(Boolean).join(' ');
    // Canvas lists "Last, First"; written the way a person is greeted.
    const comma = /^([^,]+),\s*(.+)$/.exec(name);
    if (comma && cols.name >= 0) name = `${comma[2]} ${comma[1]}`;
    // A "Points Possible" or "Muted" row under a Canvas header is not a student.
    if (/^(points possible|muted)$/i.test(name)) continue;
    try {
      people.push({ ...cleanPerson({ name, studentId: at(cols.studentId), email: at(cols.email) }), line: i + 1 });
    } catch (err) {
      problems.push({ line: i + 1, message: err.message });
    }
    if (people.length > MAX_ROWS) throw fail(`a roster can have at most ${MAX_ROWS} people`, 413);
  }
  const named = (n) => (n >= 0 && !(start === 0) ? rows[0][n] : null);
  return {
    people,
    problems,
    columns: { name: named(cols.name) || [named(cols.first), named(cols.last)].filter(Boolean).join(' + ') || (start === 0 ? 'column 1' : null),
      studentId: named(cols.studentId) || (start === 0 && cols.studentId >= 0 ? 'column 2' : null),
      email: named(cols.email) || (start === 0 && cols.email >= 0 ? 'column 3' : null) },
  };
}

// The same person in the file and on the roster: by student ID when both have
// one, else by email, else by name.
function matcher(rows) {
  const byId = new Map(); const byEmail = new Map(); const byName = new Map();
  for (const row of rows) {
    if (row.student_id) byId.set(row.student_id.toLowerCase(), row);
    if (row.email) byEmail.set(row.email.toLowerCase(), row);
    byName.set(row.name.toLowerCase(), row);
  }
  return (p) => (p.studentId && byId.get(p.studentId.toLowerCase()))
    || (p.email && byEmail.get(p.email))
    || (!p.studentId && byName.get(p.name.toLowerCase()))
    || null;
}

/**
 * What importing a CSV would do: who is new, who changes (and how), who is
 * unchanged, and - when the file replaces the roster - who comes off it.
 */
function plan(db, courseId, text, { replace = false } = {}) {
  const { people, problems, columns } = readRoster(text);
  const rows = current(db, courseId);
  const match = matcher(rows);
  const add = []; const change = []; const seen = new Set(); let unchanged = 0;
  const idsInFile = new Map();
  for (const p of people) {
    if (p.studentId) {
      const key = p.studentId.toLowerCase();
      if (idsInFile.has(key)) { problems.push({ line: p.line, message: `the student ID ${p.studentId} is also on line ${idsInFile.get(key)}` }); continue; }
      idsInFile.set(key, p.line);
    }
    const row = match(p);
    if (!row) { add.push(p); continue; }
    if (seen.has(row.id)) { problems.push({ line: p.line, message: `${p.name} appears twice in the file` }); continue; }
    seen.add(row.id);
    const after = { name: p.name, studentId: p.studentId || row.student_id, email: p.email || row.email };
    if (after.name === row.name && after.studentId === row.student_id && after.email === row.email) unchanged += 1;
    else change.push({ id: row.id, before: { name: row.name, studentId: row.student_id, email: row.email }, after });
  }
  const off = replace ? rows.filter((row) => !seen.has(row.id)).map(personRow) : [];
  return { columns, add, change, unchanged, remove: off, problems };
}

/** Preview an import (nothing changes). */
function previewImport(db, user, code, text, opts = {}) {
  const { course } = courseFor(db, user, code, 'edit');
  return plan(db, course.id, text, opts);
}

/**
 * Do an import. The file is read again here rather than trusting a preview
 * sent back, so what is applied is exactly what this file says now.
 */
function applyImport(db, user, code, text, { replace = false, now = Date.now() } = {}) {
  const { course } = courseFor(db, user, code, 'edit');
  const result = plan(db, course.id, text, { replace });
  db.exec('BEGIN');
  try {
    const insert = db.prepare(`INSERT INTO course_roster (course_id, name, student_id, email, source, added_at, added_by, updated_at)
        VALUES (?, ?, ?, ?, 'csv', ?, ?, ?)`);
    for (const p of result.add) insert.run(course.id, p.name, p.studentId, p.email, now, user.id, now);
    const change = db.prepare('UPDATE course_roster SET name = ?, student_id = ?, email = ?, updated_at = ? WHERE id = ?');
    for (const c of result.change) change.run(c.after.name, c.after.studentId, c.after.email, now, c.id);
    const off = db.prepare('UPDATE course_roster SET removed_at = ?, updated_at = ? WHERE id = ?');
    for (const p of result.remove) off.run(now, now, p.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err.status ? err : fail(`the import could not be saved: ${err.message}`, 409);
  }
  return { added: result.add.length, changed: result.change.length, unchanged: result.unchanged, removed: result.remove.length, problems: result.problems };
}

const csvField = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** The roster as CSV, in the same three columns the import reads. */
function exportCsv(db, user, code) {
  const { course } = courseFor(db, user, code, 'read');
  const lines = [['name', 'student id', 'email'], ...current(db, course.id).map((r) => [r.name, r.student_id, r.email])];
  return `\uFEFF${lines.map((l) => l.map(csvField).join(',')).join('\r\n')}\r\n`;
}

module.exports = {
  list, add, update, remove, previewImport, applyImport, exportCsv, access, parseCsv, readRoster, MAX_ROWS,
};
