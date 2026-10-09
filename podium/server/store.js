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

  (db) => {
    db.exec(`
      -- When the display last said it was still there. A lecture ends when
      -- somebody stands down - but a tab closed, a laptop shut mid-class or a
      -- browser that crashed never says so, and until now such a lecture sat
      -- open until the NEXT Go live in that room swept it up, which might be
      -- next week. This is what lets the server close one on its own, and
      -- what it dates the end to: the last moment the display was known to be
      -- there, rather than whenever the sweep happened to notice.
      --
      -- Backfilled to started_at rather than left NULL: an existing open
      -- lecture from before this column has no better answer, and NULL would
      -- make every one of them look infinitely idle and close on the first
      -- sweep with an end time of nothing.
      ALTER TABLE lectures ADD COLUMN last_seen_at INTEGER;
      UPDATE lectures SET last_seen_at = started_at WHERE last_seen_at IS NULL;
      CREATE INDEX lectures_open_by_seen ON lectures(last_seen_at) WHERE ended_at IS NULL;
    `);
  },

  (db) => {
    db.exec(`
      -- Audit log to track user interactions and administrative actions (Issue #55)
      CREATE TABLE audit_logs (
        id            INTEGER PRIMARY KEY,
        user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        username      TEXT,
        action        TEXT NOT NULL,
        ip_address    TEXT,
        user_agent    TEXT,
        created_at    INTEGER NOT NULL,
        details       TEXT
      );
      CREATE INDEX audit_logs_by_time ON audit_logs(created_at);
    `);
  },

  (db) => {
    db.exec(`
      -- System-wide administrative settings (Issue #72)
      CREATE TABLE system_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },

  (db) => {
    db.exec(`
      -- A course's plan skeleton (Issue #80): what plan.html starts a new
      -- lecture from instead of blank, for a course that opens the same
      -- shape of lecture every week. Exactly one per course, the same shape
      -- course_settings already is - and doc is the same thing plans.doc is,
      -- whatever planfile.js writes, so nothing here has to understand a
      -- plan's insides any more than the plans table does.
      CREATE TABLE course_templates (
        course_id  INTEGER PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
        doc        TEXT    NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by INTEGER REFERENCES users(id)
      );
    `);
  },

  (db) => {
    db.exec(`
      -- The files behind a library item that is more than one file (Issue
      -- #106): a picture deck is one item made of N slide images. media_id on
      -- library_items still covers every one-file item; this is only the
      -- extra files, in order, and it is what mayReadMedia and
      -- forgetMediaIfUnused consult so that "may read" and "still in use" see
      -- them too.
      CREATE TABLE library_item_files (
        item_id  INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        media_id INTEGER NOT NULL REFERENCES media(id),
        position INTEGER NOT NULL,
        PRIMARY KEY (item_id, position)
      );
      CREATE INDEX library_item_files_by_media ON library_item_files(media_id);
    `);
  },

  (db) => {
    db.exec(`
      -- Unattended signage, admin-managed (Issue #151). A kiosk profile is a
      -- room an administrator has set aside for a display nobody is running -
      -- a lobby screen, hallway signage - together with the connection
      -- settings (transport/room/passphrase/URLs) a device provisioned into
      -- it needs, kept the same shape course_settings already keeps them in
      -- rather than exploded into columns.
      --
      -- provision_token is what a QR/link scanned on a blank device actually
      -- carries - never the passphrase itself. Unlike an ordinary pairing
      -- link (which bakes room+passphrase straight into the URL with no
      -- server involved at all, see pairingUrl in config.js), a device
      -- redeems this token in one request, is handed the settings back, AND
      -- is issued its own long-lived credential (see kiosk_sessions below).
      -- That round trip, and the credential it hands out, is what lets
      -- revoking a profile do more than an ordinary passphrase rotation
      -- ever could: revoked_at is checked live, on every request, so it
      -- stops both a not-yet-used link from provisioning anything AND an
      -- already-provisioned device from reaching display.html the next time
      -- it asks - not just future provisioning, the device itself. What it
      -- still cannot do is reach into a connection that device already has
      -- open on the room's encrypted bus and close it - the same limit
      -- rotating a course's passphrase already has (see settings.js's own
      -- note on that); it only ever governs the next request that arrives.
      --
      -- plan_id is which plan this kiosk is meant to be showing, kept as
      -- admin-visible bookkeeping only for now: nothing here pushes it onto
      -- the live room automatically (that would need a server-side bus
      -- client, which does not exist) - see the PR that added this table for
      -- the reasoning. ON DELETE SET NULL rather than CASCADE: deleting the
      -- plan should not delete the kiosk profile, just leave it unassigned.
      CREATE TABLE kiosks (
        id              INTEGER PRIMARY KEY,
        name            TEXT    NOT NULL,
        settings        TEXT    NOT NULL DEFAULT '{}',
        provision_token TEXT    NOT NULL UNIQUE,
        plan_id         INTEGER REFERENCES plans(id) ON DELETE SET NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        updated_by      INTEGER REFERENCES users(id),
        revoked_at      INTEGER
      );
      CREATE INDEX kiosks_by_plan ON kiosks(plan_id);
    `);
  },

  (db) => {
    db.exec(`
      -- A kiosk's own long-lived credential (Issue #151) - what actually gets
      -- a provisioned device past the accounts gate on display.html, forever,
      -- with no account of its own. Deliberately NOT shaped like
      -- auth_sessions: there is no expires_at, because a kiosk device does
      -- not "log out" - it reboots, on its own, with nobody there to sign it
      -- back in, and should keep working until an administrator revokes the
      -- PROFILE (kiosks.revoked_at), not until some timer nobody thought to
      -- renew. Bound to the kiosk it was minted for, not a user account -
      -- see gate() in api.js for what it is actually allowed to reach, which
      -- is no more than the room's own passphrase already would grant.
      CREATE TABLE kiosk_sessions (
        token_sha256 TEXT    PRIMARY KEY,
        kiosk_id     INTEGER NOT NULL REFERENCES kiosks(id) ON DELETE CASCADE,
        created_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        user_agent   TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX kiosk_sessions_by_kiosk ON kiosk_sessions(kiosk_id);
    `);
  },

  (db) => {
    db.exec(`
      -- Time-based programming for a kiosk (Issue #152): a JSON array of
      -- {id, day, startMin, endMin, planId} entries, kept the same
      -- store-it-as-JSON shape 'settings' above already uses rather than a
      -- second table - there is nothing here anything else needs to query by,
      -- the way kiosks_by_plan's index exists for plan_id. day is 0-6
      -- (Sunday-Saturday) or null for every day; startMin/endMin are minutes
      -- since midnight, IN THE SERVER'S OWN LOCAL TIME - a v1 simplification
      -- named directly in the issue ("a simple day-of-week/time-range list is
      -- probably enough"), not a timezone-aware calendar. A self-hosted
      -- instance signage actually depends on sets its host's TZ to match the
      -- venue, same as any cron-driven schedule would.
      --
      -- plan_id here is NOT a foreign key, unlike kiosks.plan_id above: an
      -- entry naming a plan that is later deleted should not need every
      -- schedule touched to clean it up, and resolving one that no longer
      -- exists is already handled the same way an unassigned kiosk is - fall
      -- through to the next entry, or to the kiosk's own default plan_id.
      ALTER TABLE kiosks ADD COLUMN schedule TEXT NOT NULL DEFAULT '[]';
    `);
  },

  (db) => {
    db.exec(`
      -- A course's default watermark (Issue #157): {text, image, position},
      -- where image is a small PNG data URL - the same shape and size cap a
      -- watermark logo already has once it is on a display, so a lecture
      -- started under this course can hand it straight over. JSON on the
      -- course row rather than in course_settings, deliberately: that table
      -- is the room's KEY (see settings.js), handed only to members and
      -- written only by owners, and a logo is neither of those things.
      ALTER TABLE courses ADD COLUMN branding TEXT NOT NULL DEFAULT '{}';
    `);
  },
  (db) => {
    db.exec(`
      -- Who made a course, when it was not an administrator (Issue #224): an
      -- instructor typing a class the server did not have yet into the
      -- planner. NULL for every course an administrator made, which is every
      -- course that existed before this.
      ALTER TABLE courses ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `);
  },
  (db) => {
    db.exec(`
      -- Deck templates (Issue #226): a whole starting deck, or one slide's
      -- layout, written in the deck editor. Two scopes live here - a
      -- course's (course_id set; its owners write it, its members use it)
      -- and one person's own ("mine": course_id NULL, user_id theirs). The
      -- third scope, the ones shipped with Podium, are files under
      -- content/deck-templates/ and never in this table. markdown is the
      -- template itself: plain Marp, like any deck.
      CREATE TABLE deck_templates (
        id         INTEGER PRIMARY KEY,
        scope      TEXT    NOT NULL CHECK (scope IN ('course', 'mine')),
        course_id  INTEGER REFERENCES courses(id) ON DELETE CASCADE,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT    NOT NULL CHECK (kind IN ('deck', 'slide')),
        title      TEXT    NOT NULL,
        markdown   TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at INTEGER NOT NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        deleted_at INTEGER
      );
      CREATE INDEX deck_templates_by_course ON deck_templates(course_id);
      CREATE INDEX deck_templates_by_user ON deck_templates(user_id);
    `);
  },
  (db) => {
    db.exec(`
      -- A library deck's earlier versions (Issue #226): each time the deck
      -- editor saves over one, the version it replaced is kept here, so
      -- "previous versions" is a list of what the item pointed at before.
      -- The bytes are already content-addressed media, so a revision is only
      -- a pointer; forgetMediaIfUnused (and the doctor) count it as a use.
      -- Trimmed to the newest few per deck as new ones arrive.
      CREATE TABLE deck_revisions (
        id       INTEGER PRIMARY KEY,
        item_id  INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        media_id INTEGER NOT NULL REFERENCES media(id),
        saved_at INTEGER NOT NULL,
        saved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX deck_revisions_by_item ON deck_revisions(item_id, saved_at);
      CREATE INDEX deck_revisions_by_media ON deck_revisions(media_id);
    `);
  },
  (db) => {
    db.exec(`
      -- Lectures someone has put away (Issue #239): archived from THEIR
      -- planner list, and nobody else's. A co-instructor who shares the
      -- course still sees the lecture until they archive it themselves, and
      -- nothing about the plan - owner, course, who may open it - changes.
      CREATE TABLE plan_archive (
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id     INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        archived_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, plan_id)
      );
      CREATE INDEX plan_archive_by_plan ON plan_archive(plan_id);
    `);
  },
  (db) => {
    db.exec(`
      -- The decks someone has opened or saved in the deck editor lately
      -- (Issue #241), so the planner can offer "the one I just made" first.
      -- One row per person per address; saved stays set once it was.
      CREATE TABLE deck_recent (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        src     TEXT    NOT NULL,
        title   TEXT    NOT NULL DEFAULT '',
        saved   INTEGER NOT NULL DEFAULT 0,
        at      INTEGER NOT NULL,
        PRIMARY KEY (user_id, src)
      );
    `);
  },
  (db) => {
    db.exec(`
      -- Light or dark on every page (set on My Files): 'auto', 'light',
      -- 'dark', or '' for never chosen, which leaves each device its own.
      ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT '';
    `);
  },
  (db) => {
    db.exec(`
      -- A course's roster (Issue #256): the people attendance is taken for.
      -- Not accounts - a student never signs in to Podium. Removing someone
      -- only marks them removed, so a past session still knows who they were.
      CREATE TABLE course_roster (
        id          INTEGER PRIMARY KEY,
        course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        name        TEXT    NOT NULL,
        student_id  TEXT    NOT NULL DEFAULT '',
        email       TEXT    NOT NULL DEFAULT '',
        source      TEXT    NOT NULL DEFAULT 'manual',   -- csv | manual | guest
        added_at    INTEGER NOT NULL,
        added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at  INTEGER NOT NULL,
        removed_at  INTEGER
      );
      CREATE INDEX course_roster_by_course ON course_roster(course_id, removed_at);
      -- One person per student ID in a course, while they are on it.
      CREATE UNIQUE INDEX course_roster_student_id ON course_roster(course_id, lower(student_id))
        WHERE student_id <> '' AND removed_at IS NULL;
    `);
  },
  (db) => {
    db.exec(`
      -- Taking attendance (Issue #256, phase 2). One session is one check-in
      -- window for one course, usually one per lecture; it can be closed and
      -- opened again. The code on the projector is worked out from the secret
      -- and the time, never stored; the screen key is what lets a display ask
      -- for it.
      CREATE TABLE attendance_sessions (
        id          INTEGER PRIMARY KEY,
        course_id   INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
        lecture_id  INTEGER REFERENCES lectures(id) ON DELETE SET NULL,
        title       TEXT    NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        opened_at   INTEGER,              -- set while check-in is open
        closed_at   INTEGER,
        late_rule   TEXT    NOT NULL DEFAULT '{}',   -- {after: minutes or null, from: ms}
        late_now    INTEGER NOT NULL DEFAULT 0,
        rotate_s    INTEGER NOT NULL DEFAULT 15,
        secret      TEXT    NOT NULL,
        screen_key  TEXT    NOT NULL
      );
      CREATE INDEX attendance_sessions_by_course ON attendance_sessions(course_id, created_at);
      CREATE INDEX attendance_sessions_by_lecture ON attendance_sessions(lecture_id);
      CREATE INDEX attendance_sessions_open ON attendance_sessions(opened_at) WHERE opened_at IS NOT NULL;

      -- One mark per person per session: someone on the roster, or a guest
      -- who gave a name and an email. Flags (a shared phone) are kept with
      -- the mark; the evidence behind them is kept only for the retention
      -- period, below.
      CREATE TABLE attendance_marks (
        id               INTEGER PRIMARY KEY,
        session_id       INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
        roster_id        INTEGER REFERENCES course_roster(id) ON DELETE SET NULL,
        guest_name       TEXT    NOT NULL DEFAULT '',
        guest_student_id TEXT    NOT NULL DEFAULT '',
        guest_email      TEXT    NOT NULL DEFAULT '',
        status           TEXT    NOT NULL,          -- present | late | absent | excused
        how              TEXT    NOT NULL,          -- scan | code | hand
        at               INTEGER NOT NULL,
        flags            TEXT    NOT NULL DEFAULT '[]',
        marked_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        edited_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        edited_at        INTEGER
      );
      CREATE UNIQUE INDEX attendance_marks_person ON attendance_marks(session_id, roster_id)
        WHERE roster_id IS NOT NULL;
      CREATE INDEX attendance_marks_by_session ON attendance_marks(session_id, at);

      -- Keyed hashes of the browser token and network address behind a
      -- check-in: what a "same phone" flag rests on. Pruned after the
      -- attendance retention period; the marks stay.
      CREATE TABLE attendance_evidence (
        mark_id     INTEGER PRIMARY KEY REFERENCES attendance_marks(id) ON DELETE CASCADE,
        device_hash TEXT    NOT NULL DEFAULT '',
        ip_hash     TEXT    NOT NULL DEFAULT '',
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX attendance_evidence_by_age ON attendance_evidence(created_at);
    `);
  },
  (db) => {
    db.exec(`
      -- Reviewing attendance (Issue #256, phase 3). Every change to a mark
      -- after the fact, and who made it: what it was and what it became. The
      -- mark id is not a foreign key, so a mark taken off keeps its history.
      CREATE TABLE attendance_audit (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
        mark_id     INTEGER,
        user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        at          INTEGER NOT NULL,
        action      TEXT    NOT NULL,   -- marked | changed | removed | flags_dismissed | added_to_roster
        name        TEXT    NOT NULL DEFAULT '',
        before      TEXT,
        after       TEXT
      );
      CREATE INDEX attendance_audit_by_session ON attendance_audit(session_id, at);
      -- A flag looked at and dismissed: the mark keeps its flags (what was
      -- seen), but they no longer ask for attention.
      ALTER TABLE attendance_marks ADD COLUMN flags_dismissed_at INTEGER;
      ALTER TABLE attendance_marks ADD COLUMN flags_dismissed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `);
  },
  (db) => {
    db.exec(`
      -- Questions with check-in (Issue #256, phase 4). A session asks up to
      -- three questions when it opens (the entry ticket) and up to three more
      -- when it is opened again at the end (the exit ticket); which one is
      -- open now is its phase. The parking lot is a session's place for
      -- questions from the room, named or anonymous.
      ALTER TABLE attendance_sessions ADD COLUMN phase TEXT NOT NULL DEFAULT 'entry';   -- entry | exit
      ALTER TABLE attendance_sessions ADD COLUMN questions TEXT NOT NULL DEFAULT '{}';  -- {entry: [...], exit: [...]}
      ALTER TABLE attendance_sessions ADD COLUMN parking INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE attendance_answers (
        mark_id     INTEGER NOT NULL REFERENCES attendance_marks(id) ON DELETE CASCADE,
        phase       TEXT    NOT NULL,
        question_id TEXT    NOT NULL,
        answer      TEXT    NOT NULL,
        at          INTEGER NOT NULL,
        PRIMARY KEY (mark_id, phase, question_id)
      );
      -- An anonymous question keeps no mark: nothing ties it to whoever asked.
      CREATE TABLE attendance_parking (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
        mark_id     INTEGER REFERENCES attendance_marks(id) ON DELETE SET NULL,
        name        TEXT    NOT NULL DEFAULT '',
        text        TEXT    NOT NULL,
        at          INTEGER NOT NULL,
        answered_at INTEGER,
        answered_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
      CREATE INDEX attendance_parking_by_session ON attendance_parking(session_id, at);
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
      throw new Error(`migration to schema version ${version + 1} failed: ${err.message}`, { cause: err });
    }
  }
  return MIGRATIONS.length;
}

/**
 * Open the database under `dataDir`, creating it (and the directory) unless
 * told not to.
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
 *
 * `create: false` is for podium-admin's doctor, which exists to diagnose
 * exactly the box where DATA_DIR is missing or mistyped - opening this the
 * ordinary way would silently create a fresh, empty database right there and
 * report a clean bill of health on the wrong directory. With this off, a
 * missing podium.db throws instead of being conjured into existence.
 */
function open(dataDir, { create = true } = {}) {
  if (!dataDir) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error('this Node has no node:sqlite (Podium needs 22.5 or newer to store anything)');
  }
  const dbFile = path.join(dataDir, 'podium.db');
  if (!create && !fs.existsSync(dbFile)) {
    throw new Error(`no database at ${dbFile} - check DATA_DIR`);
  }
  try {
    if (create) {
      // 0700: the database holds password hashes and the room passphrase.
      // mkdirSync's mode only applies to a directory it actually creates, so
      // an operator pointing DATA_DIR at an existing 0755 directory would
      // otherwise leave all of that readable by every local account.
      // Tightened either way, and not fatal if it cannot be - a deliberate
      // ACL is the operator's call, and refusing to start over it would be
      // worse than saying so.
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(dataDir, 0o700);
      } catch (err) {
        console.error(`podium: could not tighten permissions on ${dataDir} (${err.code}) - check who can read it`);
      }
    }
    const db = new DatabaseSync(dbFile);
    // WAL so a long read cannot block the write that a login is; a busy
    // timeout so the CLI adding a user while the server runs waits its turn
    // rather than failing outright.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return db;
  } catch (err) {
    throw new Error(`could not open the database in ${dataDir}: ${err.message}`, { cause: err });
  }
}

/** Read a system-wide setting value. */
function getSystemSetting(db, key, defaultValue = null) {
  if (!db) return defaultValue;
  try {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

/** Write a system-wide setting value. */
function setSystemSetting(db, key, value) {
  if (!db) return;
  db.prepare(`
    INSERT INTO system_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

/** Where the data lives, given the environment. Null means "store nothing". */
function dataDirFromEnv(env = process.env) {
  return env.DATA_DIR ? path.resolve(env.DATA_DIR) : null;
}

/**
 * Whether the disk under a data directory is running out of room, on the
 * same thresholds doctor's own disk check has always used (Issue #160) -
 * shared here so the admin page's banner and `podium-admin doctor`'s exit
 * code never quietly drift apart on what counts as "getting full".
 */
function diskPressure(dataDir) {
  let stats;
  try {
    stats = fs.statfsSync(dataDir);
  } catch (err) {
    return { ok: false, error: err.code };
  }
  const free = stats.bavail * stats.bsize;
  const total = stats.blocks * stats.bsize;
  const share = total ? (free / total) * 100 : 0;
  // A relay that cannot write is a relay that cannot log anybody in: SQLite
  // fails a write before it fails a read, so the first symptom of a full
  // disk is a login form that refuses everybody - "bad" is meant to be seen
  // well before that.
  const level = free < 200 * 1024 * 1024 || share < 5 ? 'bad'
    : free < 1024 * 1024 * 1024 || share < 15 ? 'warn'
      : 'ok';
  return { ok: true, free, total, share, level };
}

module.exports = {
  open, migrate, dataDirFromEnv, SCHEMA_VERSION: MIGRATIONS.length,
  getSystemSetting, setSystemSetting, diskPressure,
};
