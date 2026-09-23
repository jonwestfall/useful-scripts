#!/usr/bin/env bash
# Deploy a new Podium release from a git checkout.
#
#   sudo ./deploy/update.sh [source-checkout]
#
# Generalised from the script this was written for. Same shape, no hostname
# baked in:
#
#   1. rsync the checkout into a new, timestamped release directory
#   2. overlay host-specific files (config.json and friends) from ADMIN_DIR
#   3. install production dependencies and run the tests that need no browser
#   4. flip /opt/podium/current, restart, and wait for /healthz
#   5. put the previous release back if it does not come up
#
# The git checkout is treated as read-only throughout, so `git pull` keeps
# working and a deploy can never leave uncommitted changes behind in it.
#
# The data directory is deliberately not touched by any of this. A rollback
# restores CODE; it cannot restore a database, which is why migrations only
# ever add.

set -Eeuo pipefail

PREFIX=${PREFIX:-/opt/podium}
DATA_DIR=${DATA_DIR:-/var/lib/podium}
CONFIG_DIR=${CONFIG_DIR:-/etc/podium}
SERVICE=${SERVICE:-podium.service}
HEALTH_URL=${HEALTH_URL:-}
# Optional: a directory of files to lay over the release after copying it,
# for anything that belongs to this box rather than to the repository
# (config.json is the usual one). Same idea as the original script's admin dir.
ADMIN_DIR=${ADMIN_DIR:-/etc/podium/overlay}

source_dir=${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}

die() { echo "update: $*" >&2; exit 1; }

(( EUID == 0 )) || die 'run as root'
[[ -f "$source_dir/server/podium-server.js" ]] || die "no podium checkout at $source_dir"
[[ -f "$source_dir/server/package-lock.json" ]] || die "no lockfile in $source_dir/server"

if [[ -z "$HEALTH_URL" ]]; then
  port=$(sed -n 's/^PORT=//p' "$CONFIG_DIR/podium.env" 2>/dev/null | tail -1)
  HEALTH_URL="http://127.0.0.1:${port:-8080}/healthz"
fi

release_id=$(date +%Y%m%dT%H%M%S%z)
if git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  release_id="$(git -C "$source_dir" rev-parse --short=12 HEAD)-$release_id"
fi
release_dir="$PREFIX/releases/$release_id"
previous_target=$(readlink -f "$PREFIX/current" 2>/dev/null || true)

echo "==> staging $release_dir"
install -d -m 0755 "$PREFIX/releases" "$release_dir"
rsync -a --delete \
  --exclude server/node_modules/ \
  --exclude test/fixtures/ \
  --exclude .git/ \
  "$source_dir/" "$release_dir/"

if [[ -d "$ADMIN_DIR" ]]; then
  echo "==> overlaying host files from $ADMIN_DIR"
  rsync -a "$ADMIN_DIR/" "$release_dir/"
fi

echo "==> checking and building"
node --check "$release_dir/server/podium-server.js"
npm ci --omit=dev --ignore-scripts --prefix "$release_dir/server"
# The browser suite needs Playwright and twelve minutes; every test/*.test.mjs
# file needs neither - all fast, Node-native, no external services. A release
# that fails any of them never goes live.
for f in "$release_dir"/test/*.test.mjs; do
  node "$f" >/dev/null
done

chown -R root:root "$release_dir"
find "$release_dir" -type d -exec chmod 0755 {} +
find "$release_dir" -type f -exec chmod u=rw,go=r {} +
# The two service entrypoints, and everything under deploy/ - backup.sh and
# restore.sh are meant to be run directly (the installer's own summary and
# deploy/README.md both say so), so they need their execute bit back same as
# the entrypoints do.
chmod 0755 "$release_dir/server/podium-server.js" "$release_dir/server/podium-admin.js"
find "$release_dir/deploy" -maxdepth 1 -type f -name '*.sh' -exec chmod 0755 {} +

echo "==> going live"
ln -s "$release_dir" "$PREFIX/current.next"
mv -Tf "$PREFIX/current.next" "$PREFIX/current"

if systemctl is-active --quiet "$SERVICE"; then
  systemctl restart "$SERVICE"
  healthy=0
  for _ in $(seq 1 20); do
    if curl --fail --silent --max-time 2 "$HEALTH_URL" >/dev/null; then healthy=1; break; fi
    sleep 1
  done
  if (( healthy == 0 )); then
    if [[ -n "$previous_target" && -d "$previous_target" ]]; then
      echo 'update: it did not come up; rolling back' >&2
      ln -s "$previous_target" "$PREFIX/current.rollback"
      mv -Tf "$PREFIX/current.rollback" "$PREFIX/current"
      systemctl restart "$SERVICE"
    fi
    die 'health check failed; the previous release was restored where there was one'
  fi
fi

# Keep the last few releases so a rollback has somewhere to roll back to, and
# no more: a release is most of a checkout and they add up.
keep=${KEEP_RELEASES:-5}
mapfile -t stale < <(ls -1dt "$PREFIX/releases"/* 2>/dev/null | tail -n "+$((keep + 1))")
for old in "${stale[@]:-}"; do
  [[ -n "$old" && "$old" != "$(readlink -f "$PREFIX/current")" ]] || continue
  rm -rf -- "$old"
done

echo "deployed:  $release_dir"
echo "current:   $(readlink -f "$PREFIX/current")"
echo "data:      $DATA_DIR (untouched)"
