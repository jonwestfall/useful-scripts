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
];

function migrate(db) {
  const from = db.prepare('PRAGMA user_version').get().user_version;
  for (let version = from; version < MIGRATIONS.length; version++) {
    MIGRATIONS[version](db);
    // PRAGMA takes no bound parameters; the value is a loop index, not input.
    db.exec(`PRAGMA user_version = ${version + 1}`);
  }
  return MIGRATIONS.length;
}

/**
 * Open (creating if needed) the database under `dataDir`, or return null if
 * this box cannot offer one. Never throws: a server that cannot store things
 * is a supported configuration, not a failure.
 */
function open(dataDir, onProblem = () => {}) {
  if (!dataDir) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    onProblem('this Node has no node:sqlite, so server-side storage is off');
    return null;
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
    onProblem(`could not open the database in ${dataDir}: ${err.message}`);
    return null;
  }
}

/** Where the data lives, given the environment. Null means "store nothing". */
function dataDirFromEnv(env = process.env) {
  return env.DATA_DIR ? path.resolve(env.DATA_DIR) : null;
}

module.exports = { open, migrate, dataDirFromEnv, SCHEMA_VERSION: MIGRATIONS.length };
