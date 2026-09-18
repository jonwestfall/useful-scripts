#!/usr/bin/env bash
# Put a Podium backup back.
#
#   sudo ./deploy/restore.sh /var/backups/podium/podium-20260917T2014.tar.gz
#
# The database and the media tree have to go back TOGETHER, and that is the one
# thing worth understanding before running this. The database holds the index -
# every library item, every session's list of files - and media/ holds the bytes
# each of those rows points at. Restore one without the other and Podium opens
# perfectly, lists everything, and hands you a broken image for all of it.
#
# The service is stopped first and started again at the end, deliberately: a
# process holding a database open while the file underneath it is replaced is
# how a restore becomes a second outage.
#
# What is NOT restored: the code. A release is deployed with update.sh from a
# git checkout, and the schema only ever moves forward - so restoring a backup
# into a NEWER release is fine (it migrates on startup) and restoring into an
# older one is refused by the server itself.

set -Eeuo pipefail

DATA_DIR=${DATA_DIR:-/var/lib/podium}
CONFIG_DIR=${CONFIG_DIR:-/etc/podium}
SERVICE=${SERVICE:-podium.service}
PODIUM_USER=${PODIUM_USER:-podium}
RESTORE_ENV=${RESTORE_ENV:-0}

die() { echo "restore: $*" >&2; exit 1; }

archive=${1:-}
(( EUID == 0 )) || die 'run as root'
[[ -n "$archive" && -f "$archive" ]] || die "usage: restore.sh <archive.tar.gz>"

work=$(mktemp -d)

# If anything below fails AFTER the current data has been moved aside - a
# full disk partway through the install/cp that follows, a bad archive, a
# service that will not start again - this puts it straight back rather than
# leaving DATA_DIR half-restored and the service down with the only good
# copy sitting in .replaced. "Back to how it was, service running" is the one
# property a restore gone wrong must never give up; $aside and $started are
# both unset until the steps that set them actually run, so this is a no-op
# on a clean exit or a failure before either of them happened.
cleanup() {
  local status=$?
  rm -rf -- "$work"
  if (( status != 0 )); then
    # Gated on `moved`, not just "$aside exists": $aside is set well before
    # the mv that is supposed to populate it, so a bare existence check could
    # not tell "this invocation's own move landed there" from "something else
    # was already sitting at that path" - a leftover from a prior run, or two
    # restores landing on the same collision-prone name. Mistaking the latter
    # for the former would delete the still-live DATA_DIR and replace it with
    # whatever unrelated directory happened to be at $aside. `moved` is set
    # ONLY immediately after the mv below actually succeeds, so it is the one
    # thing that is actually true when it is set.
    if [[ -n "${moved:-}" && -e "${aside:-}" ]]; then
      echo "restore: failed (exit $status) - putting $DATA_DIR back the way it was" >&2
      rm -rf -- "$DATA_DIR"
      mv -T "$aside" "$DATA_DIR"
    fi
    if [[ -n "${started:-}" ]]; then
      echo "restore: starting $SERVICE again" >&2
      systemctl start "$SERVICE" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT

# Inspected before anything is extracted, not after: a path containing ".."
# or given as absolute can make tar write outside $work during extraction
# itself, and a symlink entry - cp -a below preserves media/ symlinks as-is -
# could make a media hash resolve to any file on this host once restored,
# for serveMedia() to stream back to whoever can read it. An archive this
# script itself wrote can never contain either, so failing this check means
# the archive was built, or tampered with, by something else.
if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  die 'that archive contains an unsafe path - refusing to restore it'
fi
if tar -tvzf "$archive" | grep -Eq '^l'; then
  die 'that archive contains a symlink - refusing to restore it'
fi
tar -xzf "$archive" -C "$work"
# mapfile rather than `find | head -1`: with `set -o pipefail`, head closing the
# pipe early can make find die of SIGPIPE and take the whole script with it.
# Vanishingly unlikely on a directory with one entry, and "vanishingly unlikely"
# is the wrong property for the script somebody runs at three in the morning.
mapfile -t unpacked < <(find "$work" -mindepth 1 -maxdepth 1 -type d)
inner=${unpacked[0]:-}
[[ -n "$inner" ]] || die 'that archive does not look like a podium backup'
[[ -f "$inner/podium.db" ]] || die "no podium.db inside $archive"

echo "==> restoring from $archive"
[[ -f "$inner/MANIFEST.txt" ]] && sed 's/^/    /' "$inner/MANIFEST.txt"

# Everything currently in DATA_DIR is moved aside rather than deleted. A restore
# run against the wrong archive is a thing that happens at three in the morning,
# and "it is still in the directory next door" is the difference between a bad
# hour and a bad year.
#
# Timestamped to the second AND suffixed with this process's own pid: the
# timestamp alone collides on two restores started in the same second, or
# with a leftover directory a prior run left at this exact path - and mv -T
# below would then either fail against that existing path or, worse, succeed
# by merging into it, either way defeating the "moved" flag's whole job of
# knowing whose move actually happened.
aside="$DATA_DIR.replaced-$(date +%Y%m%dT%H%M%S)-$$"

if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  echo "==> stopping $SERVICE"
  systemctl stop "$SERVICE"
  started=1
fi

if [[ -e "$DATA_DIR" ]]; then
  echo "==> moving the current data aside to $aside"
  mv -T "$DATA_DIR" "$aside"
  # Set only once the mv above has actually returned success - set -e means a
  # failed mv never reaches this line, so cleanup's rollback can trust this
  # flag as "this invocation genuinely relocated the live data here", not
  # merely "this variable happens to be non-empty".
  moved=1
fi

install -d -m 0700 "$DATA_DIR"
install -m 0600 "$inner/podium.db" "$DATA_DIR/podium.db"
if [[ -d "$inner/media" ]]; then
  echo "==> restoring media"
  cp -a "$inner/media" "$DATA_DIR/media"
fi

# The env file is configuration, not data, and the box you are restoring ONTO
# may legitimately have a different port or origin. Off unless asked for.
if [[ "$RESTORE_ENV" == "1" && -f "$inner/podium.env" ]]; then
  echo "==> restoring $CONFIG_DIR/podium.env"
  install -d -m 0755 "$CONFIG_DIR"
  # The archive's own DATA_DIR line, if it has one, names wherever the box
  # that made this backup kept its data - not necessarily this one's. Every
  # file above was just restored under THIS invocation's $DATA_DIR; shipping
  # the archive's env verbatim could start the service pointed at a
  # directory nothing above ever touched, possibly one that does not even
  # exist here, silently ignoring everything this restore just did.
  patched_env="$work/podium.env"
  grep -v '^DATA_DIR=' "$inner/podium.env" > "$patched_env" || true
  printf 'DATA_DIR=%s\n' "$DATA_DIR" >> "$patched_env"
  install -m 0640 "$patched_env" "$CONFIG_DIR/podium.env"
  chgrp "$PODIUM_USER" "$CONFIG_DIR/podium.env" 2>/dev/null || true
fi

if id "$PODIUM_USER" >/dev/null 2>&1; then
  chown -R "$PODIUM_USER:$PODIUM_USER" "$DATA_DIR"
fi
chmod 0700 "$DATA_DIR"

if [[ -n "${started:-}" ]]; then
  echo "==> starting $SERVICE"
  systemctl start "$SERVICE"
fi

echo
echo "restored: $DATA_DIR"
echo "previous: $aside  (delete it once you are satisfied)"
echo
echo 'Now check it: podium-admin.js doctor'
