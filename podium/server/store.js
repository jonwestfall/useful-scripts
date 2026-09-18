// The server's own memory.
//
// Everything Podium knows that is not a file on disk lives in one SQLite
// database, reached through Node's built-in `node:sqlite`. That choice is the
// whole point: no npm dependency, no compiler on the box, no native module to
// rebuild when Node moves. `apt install sqlite3` and you can read your own
// data with no help from this program.
//
// Nothing in here is required. A relay with no DATA_DIR, or a Node without
// node:sqlite, calls open() once, gets null, and serves exactly the Podium it
// always has - see the capabilities probe in api.js. The pages are built to
// notice.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Forward-only and additive, because rolling the CODE back to last week's
// release does not roll the DATABASE back with it. Index n is the migration
// that takes user_version from n to n+1; never edit one that has shipped.
const MIGRATIONS = [
  function toV1(db) {
    db.exec(`
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY,
        username      TEXT    NOT NULL UNIQUE,
        display_name  TEXT    NOT NULL DEFAULT '',
        password_hash TEXT    NOT NULL,
        is_admin      INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        disabled_at   INTEGER
      );

      -- Only the hash of a token is kept. A stolen database backup is then a
      -- pile of expired-looking noise rather than a working set of logins.
      CREATE TABLE auth_sessions (
        token_sha256 TEXT    PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        user_agent   TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX auth_sessions_by_user ON auth_sessions(user_id);
      CREATE INDEX auth_sessions_by_expiry ON auth_sessions(expires_at);

      -- A course is a label that also grants access: library items and plans
      -- carry one, and membership is what lets you see them. Deliberately not
      -- a workspace you switch into - the UI stays one flat library with a
      -- filter (see VPS.md).
      CREATE TABLE courses (
        id          INTEGER PRIMARY KEY,
        code        TEXT    NOT NULL UNIQUE,
        title       TEXT    NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        archived_at INTEGER
      );

      CREATE TABLE course_members (
        course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role      TEXT    NOT NULL DEFAULT 'member',
        PRIMARY KEY (course_id, user_id)
      );
      CREATE INDEX course_members_by_user ON course_members(user_id);
    `);
  },

  function toV2(db) {
    db.exec(`
      -- Content-addressed, so uploading the same PDF to two courses stores one
      -- copy and deleting either one never takes bytes the other still points
      -- at. The sha is the filename on disk as well as the key here.
      CREATE TABLE media (
        id           INTEGER PRIMARY KEY,
        sha256       TEXT    NOT NULL UNIQUE,
        bytes        INTEGER NOT NULL,
        content_type TEXT    NOT NULL,
        created_at   INTEGER NOT NULL,
        created_by   INTEGER REFERENCES users(id)
      );

      -- A library item is what the controller's Library tab shows. course_id
      -- NULL means "everyone on this instance"; anything else is visible to
      -- that course's members, which is the whole of the access model (see
      -- VPS.md: a course is a tag that also grants access).
      --
      -- props is the rest of the Podium item - the fields that differ per kind
      -- - stored as JSON rather than as forty mostly-empty columns. The server
      -- never interprets it; it only ever hands it back.
      CREATE TABLE library_items (
        id          INTEGER PRIMARY KEY,
        course_id   INTEGER REFERENCES courses(id) ON DELETE CASCADE,
        kind        TEXT    NOT NULL,
        title       TEXT    NOT NULL,
        group_label TEXT    NOT NULL DEFAULT '',
        media_id    INTEGER REFERENCES media(id),
        filename    TEXT    NOT NULL DEFAULT '',
        props       TEXT    NOT NULL DEFAULT '{}',
        created_by  INTEGER REFERENCES users(id),
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        deleted_at  INTEGER
      );
      CREATE INDEX library_items_by_course ON library_items(course_id);
      CREATE INDEX library_items_by_media ON library_items(media_id);
    `);
  },

  function toV3(db) {
    db.exec(`
      -- What a device needs to talk to the room: transport, room name, and the
      -- passphrase every message is encrypted under. Held per COURSE, because
      -- a TA who may drive the projector needs the passphrase to do it and
      -- membership is how they get it - the same rule the library runs on.
      --
      -- This is the table that makes a Podium server able to decrypt its own
      -- relay traffic. VPS.md argues that trade out; the short version is that
      -- a server which ships you the JavaScript doing the encrypting could
      -- always have read the key, and end-to-end encryption is there to
      -- protect you from a relay operator who is not you.
      CREATE TABLE course_settings (
        course_id  INTEGER PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
        settings   TEXT    NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        updated_by INTEGER REFERENCES users(id)
      );

      -- A lecture plan, stored whole: doc is exactly the plan file planfile.js
      -- writes, so what the server keeps and what a USB stick carries are the
      -- same document and neither can drift from the other.
      --
      -- NOTE the visibility rule is the OPPOSITE of library_items, and
      -- deliberately: there, no course means "everyone with an account"; here
      -- it means "only its author". A library item is something you went out
      -- of your way to publish. A plan is a draft until you say otherwise, and
      -- half a lecture appearing in a colleague's list would be a nasty
      -- surprise. Filing one under a course is the act of sharing it.
      CREATE TABLE plans (
        id         INTEGER PRIMARY KEY,
        owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        course_id  INTEGER REFERENCES courses(id) ON DELETE SET NULL,
        title      TEXT    NOT NULL DEFAULT '',
        doc        TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX plans_by_owner ON plans(owner_id);
      CREATE INDEX plans_by_course ON plans(course_id);
    `);
  },

  function toV4(db) {
    db.exec(`
      -- One run of the room: Go live to stand down. The DISPLAY writes these,
      -- not the relay, and that is not a preference - the relay only ever sees
      -- ciphertext, so it could not tell you what was on screen if it wanted
      -- to. The display is the one device that holds the decrypted state, and
      -- on a server-backed deployment it is also a signed-in page, so it is
      -- the only thing in the system able to keep this record at all.
      --
      -- course_id is resolved from the ROOM at start time: the course whose
      -- stored settings name this room, among the courses the account
      -- starting it may use. NULL means no course matched, and then the same
      -- rule as plans applies - it is private to whoever ran it. A record of
      -- your own teaching is not something colleagues should find by default.
      CREATE TABLE lectures (
        id         INTEGER PRIMARY KEY,
        course_id  INTEGER REFERENCES courses(id) ON DELETE SET NULL,
        room       TEXT    NOT NULL DEFAULT '',
        title      TEXT    NOT NULL DEFAULT '',
        started_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER,
        -- Set when the event cap was reached. A timeline that silently stops
        -- halfway would be read as "the lecture ended there".
        truncated  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX lectures_by_course ON lectures(course_id);
      CREATE INDEX lectures_by_owner ON lectures(started_by);
      CREATE INDEX lectures_by_start ON lectures(started_at);

      -- Append-only. Nothing is ever updated in place, and an event's end is
      -- simply the next one's start (or the lecture's ended_at for the last),
      -- so a display that loses the network or the power leaves a timeline
      -- that is short rather than one that is wrong.
      CREATE TABLE lecture_events (
        id         INTEGER PRIMARY KEY,
        lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
        at         INTEGER NOT NULL,
        kind       TEXT    NOT NULL,
        title      TEXT    NOT NULL DEFAULT '',
        detail     TEXT    NOT NULL DEFAULT '{}'
      );
      CREATE INDEX lecture_events_by_lecture ON lecture_events(lecture_id, at);

      -- The tally as it stood when the poll was ended, which is the only
      -- moment it exists anywhere: the relay deletes a poll as it closes, and
      -- until now the only copy was the controller's localStorage. This is
      -- what makes "re-export that CSV weeks later" possible.
      CREATE TABLE lecture_polls (
        id         INTEGER PRIMARY KEY,
        lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
        poll_id    TEXT    NOT NULL,
        kind       TEXT    NOT NULL DEFAULT 'choice',
        question   TEXT    NOT NULL DEFAULT '',
        results    TEXT    NOT NULL DEFAULT '{}',
        voters     INTEGER NOT NULL DEFAULT 0,
        ended_at   INTEGER NOT NULL,
        -- The same poll ended twice (two controllers in the room, or a retry
        -- after a failed post) is one row, not two.
        UNIQUE (lecture_id, poll_id)
      );
      CREATE INDEX lecture_polls_by_lecture ON lecture_polls(lecture_id, ended_at);
    `);
  },

  function toV5(db) {
    db.exec(`
      -- The bulky half of a session: the photos taken in the room, the ink as
      -- strokes, and the rasterized pages the controller builds when it exports
      -- - annotated slides, boards drawn on, poll CSVs, the session.txt that
      -- says what is in it. Each row is one file inside what used to be a zip
      -- that existed only on whichever device pressed Export.
      --
      -- The bytes go in the SAME content-addressed media store the library uses,
      -- so a photo filed twice (an export after a re-export) is stored once and
      -- removing either copy can never pull the bytes out from under the other.
      -- That is also why library.js's forgetMediaIfUnused and mayReadMedia both
      -- had to learn about this table: "unused" and "may read" are now questions
      -- with two places to look.
      --
      -- name is the path the file has inside the zip, and it is unique per
      -- lecture: exporting a second time REPLACES what the first export left
      -- rather than accumulating two of everything.
      CREATE TABLE lecture_files (
        id         INTEGER PRIMARY KEY,
        lecture_id INTEGER NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
        media_id   INTEGER NOT NULL REFERENCES media(id),
        kind       TEXT    NOT NULL,          -- photo | ink | session
        name       TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        created_by INTEGER REFERENCES users(id),
        UNIQUE (lecture_id, name)
      );
      CREATE INDEX lecture_files_by_lecture ON lecture_files(lecture_id);
      CREATE INDEX lecture_files_by_media ON lecture_files(media_id);
    `);
  },

  function toV6(db) {
    db.exec(`
      -- A retried POST is not the same thing as a second event. The display
      -- queues a batch and re-sends it whenever a flush's response is lost -
      -- deliberately, since the alternative is losing the batch outright - but
      -- a lost RESPONSE does not mean a lost REQUEST: the insert can have
      -- already committed here, and the same batch arrives again a few
      -- seconds later. Without something to recognise "I already have this
      -- one", a flaky connection duplicates rows in a timeline that is
      -- supposed to be the reliable record.
      --
      -- client_id is that something: an id the display invents once per
      -- event, at the moment it decides to record one, and sends with it
      -- every time that event is (re)posted. Nullable, because an event with
      -- no id (an older display, or one of the rare paths that does not carry
      -- one) simply is not deduplicated - the same "opt in, never opt
      -- everyone into a stricter rule at once" shape client_id-less rows
      -- always had. The partial unique index is what makes the same
      -- (lecture, client_id) pair a no-op on a retry instead of a duplicate.
      ALTER TABLE lecture_events ADD COLUMN client_id TEXT;
      CREATE UNIQUE INDEX lecture_events_by_client
        ON lecture_events(lecture_id, client_id) WHERE client_id IS NOT NULL;
    `);
  },
];

function migrate(db) {
  const from = db.prepare('PRAGMA user_version').get().user_version;

  // A database from a NEWER release than this code. Rolling the code back does
  // not roll the schema back with it (see the layout notes in VPS.md), so this
  // is the expected shape of a rollback that went one release too far. Running
  // anyway means old code writing to a schema it has never seen; stopping is
  // the only safe answer, and it is recoverable by deploying forward again.
  if (from > MIGRATIONS.length) {
    throw new Error(
      `this database is at schema version ${from} but this Podium only knows ${MIGRATIONS.length}`
      + ' - it was written by a newer release, so deploy that one again rather than rolling further back',
    );
  }

  for (let version = from; version < MIGRATIONS.length; version++) {
    // SQLite makes DDL transactional, so a migration that dies halfway - a
    // full disk, a killed process - leaves no trace instead of leaving half
    // its tables behind with the old version still recorded. That state would
    // be permanent: every restart would rerun the migration and fail on a
    // table that already exists.
    db.exec('BEGIN');
    try {
      MIGRATIONS[version](db);
      // PRAGMA takes no bound parameters; the value is a loop index, not input.
      // Inside the transaction, so the version and the tables it describes can
      // never disagree.
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back by the failure */ }
      throw new Error(`migration to schema version ${version + 1} failed: ${err.message}`);
    }
  }
  return MIGRATIONS.length;
}

/**
 * Open (creating if needed) the database under `dataDir`.
 *
 * Returns null for one reason only: no dataDir was configured, which means
 * "store nothing" and is a supported way to run the relay. Everything else
 * throws.
 *
 * That distinction is load-bearing. Whether there is a database decides
 * whether the account gate governs (see api.js), so a configured database that
 * cannot be opened - wrong permissions, a corrupt file, a schema from the
 * future - must NOT quietly look the same as "this box stores nothing". It
 * would take the gate down with it and leave the pages open to anyone. The
 * caller is expected to refuse to start.
 */
function open(dataDir) {
  if (!dataDir) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error('this Node has no node:sqlite (Podium needs 22.5 or newer to store anything)');
  }
  try {
    // 0700: the database holds password hashes and the room passphrase.
    // mkdirSync's mode only applies to a directory it actually creates, so an
    // operator pointing DATA_DIR at an existing 0755 directory would otherwise
    // leave all of that readable by every local account. Tightened either way,
    // and not fatal if it cannot be - a deliberate ACL is the operator's call,
    // and refusing to start over it would be worse than saying so.
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dataDir, 0o700);
    } catch (err) {
      console.error(`podium: could not tighten permissions on ${dataDir} (${err.code}) - check who can read it`);
    }
    const db = new DatabaseSync(path.join(dataDir, 'podium.db'));
    // WAL so a long read cannot block the write that a login is; a busy
    // timeout so the CLI adding a user while the server runs waits its turn
    // rather than failing outright.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return db;
  } catch (err) {
    throw new Error(`could not open the database in ${dataDir}: ${err.message}`);
  }
}

/** Where the data lives, given the environment. Null means "store nothing". */
function dataDirFromEnv(env = process.env) {
  return env.DATA_DIR ? path.resolve(env.DATA_DIR) : null;
}

module.exports = { open, migrate, dataDirFromEnv, SCHEMA_VERSION: MIGRATIONS.length };
