#!/usr/bin/env bash
# Back up everything a Podium instance cannot be rebuilt without.
#
#   sudo ./deploy/backup.sh [destination]
#
# Three things, and all three matter:
#
#   1. media/                the actual bytes - uploads, session photos, the
#                            pages an export rasterized (copied FIRST; see below)
#   2. the database          accounts, courses, connection settings, the library
#                            index, lecture plans, every session record
#   3. the service's env     PORT, DATA_DIR, ORIGIN, LECTURE_RETENTION_DAYS
#
# The database is taken with `VACUUM INTO` rather than `cp`, and that is half
# the reason this is a script rather than a line in a crontab. SQLite in WAL
# mode is several files and a copy taken mid-write is a copy of a half-written
# database - which restores, opens, and is quietly wrong. VACUUM INTO asks
# SQLite for a consistent snapshot while the service keeps running.
#
# The other half is the ORDER: media is copied before the database snapshot is
# taken, not after. The service keeps running throughout, so treat the two as
# taken at slightly different instants - and an instant apart in THIS order is
# the safe direction. An upload always writes its bytes before the database row
# that points at them, and a delete always removes the row before the bytes, so
# a database snapshot taken AFTER the media copy can only be looking at a
# slightly newer or slightly smaller world than what was captured, never one
# where it references bytes that were never captured at all. Reverse the order
# and a retention sweep or a delete landing in the gap can leave the database
# pointing at media this backup never copied - a "missing from disk" failure in
# podium-admin doctor on the restored copy, not the harmless "extra file
# nothing points at" one this order risks instead.
#
# The env file is copied because it holds the ORIGIN and the retention setting,
# which are configuration rather than data - but note that it may also hold
# AUTH_PASSWORD, so the archive is written 0600 and belongs somewhere private.

set -Eeuo pipefail

DATA_DIR=${DATA_DIR:-/var/lib/podium}
CONFIG_DIR=${CONFIG_DIR:-/etc/podium}
PREFIX=${PREFIX:-/opt/podium}
BACKUP_DIR=${1:-${BACKUP_DIR:-/var/backups/podium}}
# How many to keep. Backups of a box holding a term of lecture photos are not
# small, and an unbounded backup directory is its own outage.
KEEP=${KEEP_BACKUPS:-14}

die() { echo "backup: $*" >&2; exit 1; }

# Which migration the snapshot is at, recorded in the manifest so a restore two
# years later knows which release can open it.
schema_version() {
  node - "$1" <<'JS' 2>/dev/null || echo unknown
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(process.argv[2]);
  console.log(db.prepare('PRAGMA user_version').get().user_version);
  db.close();
} catch {
  console.log('unknown');
}
JS
}

(( EUID == 0 )) || die 'run as root'
[[ -d "$DATA_DIR" ]] || die "no data directory at $DATA_DIR"
command -v tar >/dev/null 2>&1 || die 'this needs tar'
command -v sqlite3 >/dev/null 2>&1 || node_sqlite=1

stamp=$(date +%Y%m%dT%H%M%S)
work=$(mktemp -d)
install -d -m 0700 "$BACKUP_DIR"
archive="$BACKUP_DIR/podium-$stamp.tar.gz"
# Written under this name first and renamed into place only once it is whole
# and has read back clean - never straight to $archive. tar failing partway
# (a full disk, most likely) would otherwise leave a truncated file sitting
# under the name rotation and a restore both trust as a complete backup.
tmp_archive="$archive.tmp.$$"
trap 'rm -rf -- "$work" "$tmp_archive"' EXIT
install -d -m 0700 "$work/podium-$stamp"
out="$work/podium-$stamp"

# Media is copied BEFORE the database snapshot, and that order is deliberate,
# not incidental - it is the one thing standing between this being a
# consistent point-in-time backup and not. The service keeps running and
# writing throughout: an upload always writes its bytes before the row that
# points at them (see storeUpload/addFile), and retention or a delete always
# removes the ROW before the bytes (see forgetMediaIfUnused's callers). So
# whichever of the two snapshots below runs second sees a database that is
# never AHEAD of the files on disk - a row this backup's database knows about
# either has its bytes captured already, or was deleted (row and bytes both)
# after this backup's database snapshot was taken and so is not in it either
# way. Reverse the order and the opposite, worse failure becomes possible: a
# retention sweep deleting a file between the two snapshots would leave the
# database pointing at bytes that plain do not exist in this backup - a "media
# missing from disk" failure in podium-admin doctor, not the harmless "extra
# unreferenced file" one.
echo "==> copying media"
if [[ -d "$DATA_DIR/media" ]]; then
  # Content-addressed, so nothing here is ever modified in place: a file either
  # exists under its hash or does not. That makes a plain copy safe even while
  # uploads are arriving - a half-written one is still under its .incoming name
  # and is skipped.
  #
  # tar rather than rsync, deliberately: this script should run on a box that
  # has had nothing installed on it beyond Node, and tar is always there.
  tar -C "$DATA_DIR" --exclude '.incoming-*' -cf - media | tar -C "$out" -xf -
else
  echo 'backup: nothing under media/ yet' >&2
fi

echo "==> snapshotting the database"
if [[ -f "$DATA_DIR/podium.db" ]]; then
  if [[ -z "${node_sqlite:-}" ]]; then
    sqlite3 "$DATA_DIR/podium.db" "VACUUM INTO '$out/podium.db'"
  else
    # No sqlite3 on the box: Podium's own Node has SQLite built in, which is
    # the whole reason it was chosen. Same snapshot, same guarantee.
    node - "$DATA_DIR/podium.db" "$out/podium.db" <<'JS'
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
const [, , source, destination] = process.argv;
const db = new DatabaseSync(source);
// VACUUM INTO takes no bound parameters, so the path is quoted by hand. It is
// this script's own temporary directory, but doubling any quote in it costs
// nothing and means a path with an apostrophe in it does not truncate the SQL.
db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
db.close();
JS
  fi
else
  echo 'backup: no database yet; carrying on with the files' >&2
fi

# The media-before-database order above closes the DELETE race (a retention
# sweep or a removed item can never leave the snapshotted database pointing
# at bytes this backup never captured), but it opens the opposite one for an
# UPLOAD: a file finishing its write in the gap between the media copy and
# VACUUM INTO has bytes the tar above missed, yet its row - written after the
# bytes, per storeUpload/rememberMedia - can still make it into the database
# snapshot. Left alone, that is exactly the same "missing from disk" failure
# the ordering was chosen to avoid, just from the other direction.
#
# This closes that gap rather than just documenting it: every sha256 the
# snapshot's own media table claims to hold is checked against what actually
# landed in the backup, and anything missing is copied in now from the live
# tree. That copy is safe BECAUSE the row is already committed in this
# snapshot - by the same write-bytes-before-row invariant, the bytes were on
# disk before the row was, so they are on disk now unless something deleted
# them in the (much smaller, now measured in seconds rather than however long
# the media copy took) gap between VACUUM INTO and this very check - a race
# on top of a race, and about as far as a shell script reasonably chases it.
if [[ -f "$out/podium.db" ]]; then
  echo "==> checking every file the snapshot points at made it into this backup"
  node - "$out/podium.db" "$out/media" "$DATA_DIR/media" <<'JS'
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const [, , dbPath, backupMedia, liveMedia] = process.argv;
const db = new DatabaseSync(dbPath);
const shas = db.prepare('SELECT sha256 FROM media').all().map((row) => row.sha256);
db.close();
let copied = 0;
let missing = 0;
for (const sha of shas) {
  const shard = sha.slice(0, 2);
  const dest = path.join(backupMedia, shard, sha);
  if (fs.existsSync(dest)) continue;
  const src = path.join(liveMedia, shard, sha);
  if (!fs.existsSync(src)) {
    missing += 1;
    console.error(`backup: ${sha} is in the database but is not on disk anywhere - it will restore as a broken image`);
    continue;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dest);
  copied += 1;
}
if (copied) console.log(`backup: topped up ${copied} file(s) uploaded after media was copied but before the database snapshot was taken`);
if (missing) process.exitCode = 1;
JS
fi

if [[ -f "$CONFIG_DIR/podium.env" ]]; then
  echo "==> copying $CONFIG_DIR/podium.env"
  install -m 0600 "$CONFIG_DIR/podium.env" "$out/podium.env"
fi

# What this backup came from, so a restore two years later is not archaeology.
{
  echo "taken:    $(date -Is)"
  echo "host:     $(hostname)"
  echo "data:     $DATA_DIR"
  echo "release:  $(readlink -f "$PREFIX/current" 2>/dev/null || echo 'unknown')"
  echo "schema:   $(schema_version "$out/podium.db")"
  echo
  echo 'Restore with deploy/restore.sh, or read it there: this is a database'
  echo 'snapshot plus the media tree, and both have to go back together.'
} > "$out/MANIFEST.txt"

echo "==> writing $archive"
tar -C "$work" -czf "$tmp_archive" "podium-$stamp"
chmod 0600 "$tmp_archive"

# A backup nobody has ever read is a hope, not a backup. This is cheap and it
# catches the two failures that actually happen: a truncated write, and a disk
# that filled up halfway through. Checked on the temporary name, before the
# rename that is the one moment this backup starts counting as one.
echo "==> verifying"
tar -tzf "$tmp_archive" >/dev/null || die 'the archive did not read back'
mv -f -- "$tmp_archive" "$archive"

echo "==> pruning to the last $KEEP"
mapfile -t stale < <(ls -1t "$BACKUP_DIR"/podium-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))")
for old in "${stale[@]:-}"; do
  [[ -n "$old" ]] && rm -f -- "$old"
done

echo "backup:   $archive ($(du -h "$archive" | cut -f1))"
echo "keeping:  $(ls -1 "$BACKUP_DIR"/podium-*.tar.gz 2>/dev/null | wc -l) archive(s) in $BACKUP_DIR"
