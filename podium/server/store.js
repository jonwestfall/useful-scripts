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
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
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
