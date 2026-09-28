#!/usr/bin/env bash
# Remove old data directories left behind by beta restores.
#
#   sudo ./deploy/prune-beta-backups.sh
#   sudo KEEP_BETA_BACKUPS=10 ./deploy/prune-beta-backups.sh
#   sudo DRY_RUN=1 ./deploy/prune-beta-backups.sh
#
# restore.sh moves the live data directory to DATA_DIR.replaced-<stamp> before
# restoring. This script keeps the newest few of those rollback copies. It
# never touches DATA_DIR itself.

set -Eeuo pipefail

DATA_DIR=${DATA_DIR:-/var/lib/podium-beta}
KEEP_BETA_BACKUPS=${KEEP_BETA_BACKUPS:-5}
DRY_RUN=${DRY_RUN:-0}

die() { echo "prune-beta-backups: $*" >&2; exit 1; }

[[ "$KEEP_BETA_BACKUPS" =~ ^[0-9]+$ ]] || die 'KEEP_BETA_BACKUPS must be a non-negative integer'
[[ "$DRY_RUN" == "0" || "$DRY_RUN" == "1" ]] || die 'DRY_RUN must be 0 or 1'
(( DRY_RUN == 1 || EUID == 0 )) || die 'run as root (or set DRY_RUN=1 to preview)'
[[ "$DATA_DIR" == /* && "$DATA_DIR" != "/" ]] || die 'DATA_DIR must be an absolute path other than /'
keep=$((10#$KEEP_BETA_BACKUPS))

parent=${DATA_DIR%/*}
base=${DATA_DIR##*/}
[[ -n "$parent" && -n "$base" && -d "$parent" ]] || die "invalid DATA_DIR: $DATA_DIR"

# The timestamp in restore.sh's directory name sorts chronologically. NUL
# delimiters keep unusual (but valid) path characters from becoming separate
# entries. Restricting find to the immediate parent prevents this cleanup from
# wandering into either the live data directory or another Podium instance.
mapfile -d '' -t backups < <(
  find "$parent" -mindepth 1 -maxdepth 1 -type d \
    -name "$base.replaced-*" -print0 | sort -z -r
)

if (( ${#backups[@]} <= keep )); then
  echo "nothing to prune: found ${#backups[@]}, keeping $keep"
  exit 0
fi

stale=("${backups[@]:keep}")
for backup in "${stale[@]}"; do
  if (( DRY_RUN )); then
    echo "would remove: $backup"
  else
    echo "removing: $backup"
    rm -rf -- "$backup"
  fi
done

if (( DRY_RUN )); then
  echo "dry run: would remove ${#stale[@]} and keep $keep"
else
  echo "pruned ${#stale[@]}; kept $keep"
fi
