#!/usr/bin/env bash
# First-run installer for a server-backed Podium.
#
#   sudo ./deploy/install.sh
#
# Makes the layout the update script and the service expect, and nothing else:
#
#   /opt/podium/releases/<id>   one deploy, read-only
#   /opt/podium/current         symlink to the live release
#   /var/lib/podium             the database and uploads - NEVER touched by a deploy
#   /etc/podium/podium.env      configuration and secrets, read by systemd
#
# Code and data are separated on purpose: rolling back to last week's release
# must not roll back last week's database, and a bad deploy must not be able to
# take the library with it.
#
# It does not install nginx, get you a certificate, or open a firewall. Those
# are the parts where a box differs from every other box, and deploy/README.md
# says what to do with the template next to this script.

set -Eeuo pipefail

PODIUM_USER=${PODIUM_USER:-podium}
PREFIX=${PREFIX:-/opt/podium}
DATA_DIR=${DATA_DIR:-/var/lib/podium}
CONFIG_DIR=${CONFIG_DIR:-/etc/podium}
PORT=${PORT:-8080}

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)

die() { echo "install: $*" >&2; exit 1; }

(( EUID == 0 )) || die 'run as root'
[[ -f "$here/server/podium-server.js" ]] || die "no podium checkout at $here"
command -v node >/dev/null || die 'node is not installed (Podium needs Node 22.5 or newer)'

# Ask the module, not the version number. node:sqlite arrived partway through
# the Node 22 line, so "major >= 22" passes on 22.0-22.4 where requiring it
# still throws - and the failure would be silent: storage off, no accounts, an
# open site.
node -e 'require("node:sqlite")' 2>/dev/null \
  || die "this node cannot load node:sqlite, which Podium stores everything in (found $(node -v); needs 22.5 or newer)"

echo "==> service account: $PODIUM_USER"
if ! id -u "$PODIUM_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$PODIUM_USER"
fi

echo "==> directories"
install -d -m 0755 "$PREFIX" "$PREFIX/releases"
# The database holds password hashes and the room passphrase; nobody but the
# service account has any business reading it.
install -d -m 0700 -o "$PODIUM_USER" -g "$PODIUM_USER" "$DATA_DIR"
install -d -m 0750 -o root -g "$PODIUM_USER" "$CONFIG_DIR"

echo "==> $CONFIG_DIR/podium.env"
if [[ -f "$CONFIG_DIR/podium.env" ]]; then
  echo "    already there, leaving it alone"
else
  cat > "$CONFIG_DIR/podium.env" <<EOF
# Podium service configuration. systemd reads this; see server/podium-server.js
# for what each one does.
PORT=$PORT
# Localhost only: this box is meant to have a TLS terminator in front, and
# binding every interface would publish the plain-HTTP port beside it.
HOST=127.0.0.1
STATIC=../
DATA_DIR=$DATA_DIR

# Lock the relay to your own site once you know the hostname:
#ORIGIN=https://podium.example.com

# Only consulted when there are NO accounts. Creating the first account with
# podium-admin turns the cookie gate on and this off.
#AUTH_PASSWORD=

# How long a session record keeps its BULKY parts - the photos taken in the
# room, the ink, and the pages an export rasterizes. Unset means keep them
# forever. Timelines and poll results are never aged out by this: they are a few
# hundred short rows, and they are what you want three years later when somebody
# asks what the course covered.
#LECTURE_RETENTION_DAYS=180
EOF
  chmod 0640 "$CONFIG_DIR/podium.env"
  chgrp "$PODIUM_USER" "$CONFIG_DIR/podium.env"
fi

echo "==> systemd unit"
sed -e "s#@PREFIX@#$PREFIX#g" -e "s#@USER@#$PODIUM_USER#g" \
    -e "s#@DATA_DIR@#$DATA_DIR#g" -e "s#@CONFIG_DIR@#$CONFIG_DIR#g" \
    "$here/deploy/podium.service.in" > /etc/systemd/system/podium.service
systemctl daemon-reload

echo "==> first release"
# Passed explicitly: these are shell variables, not exported ones, so without
# this a non-default PREFIX would install the unit pointing at one place and
# the release into another.
PREFIX="$PREFIX" DATA_DIR="$DATA_DIR" CONFIG_DIR="$CONFIG_DIR" "$here/deploy/update.sh" "$here"

echo "==> first account"
# BEFORE the service is enabled, deliberately. An instance with a DATA_DIR and
# no accounts has no gate at all, so starting first and bootstrapping second
# would leave a window - and on the non-interactive path, an install that was
# simply never finished would leave that window open indefinitely.
#
# runuser rather than sudo: sudo is not on every minimal box, and this has to
# run AS the service account - a database file left owned by root is one the
# service cannot then write to.
as_podium() { runuser -u "$PODIUM_USER" -- env DATA_DIR="$DATA_DIR" "$@"; }
admin_cli="$PREFIX/current/server/podium-admin.js"
existing=$(as_podium node "$admin_cli" user list 2>/dev/null || true)
have_account=0
if [[ -n "$existing" && "$existing" != *'no accounts yet'* ]]; then
  echo "    accounts already exist, leaving them alone"
  have_account=1
elif [[ -t 0 ]]; then
  echo "    Until an account exists there is no gate, so this comes first."
  read -rp "    Username for the first (admin) account [admin]: " first_user
  first_user=${first_user:-admin}
  as_podium node "$admin_cli" user add "$first_user" --admin
  have_account=1
fi

if (( have_account )); then
  echo "==> enabling the service"
  systemctl enable --now podium.service
else
  # Installed, ready, and deliberately not running. Refusing to start is the
  # only honest end to an unattended install: the alternative is an open
  # Podium on a public box waiting for someone to notice.
  systemctl enable podium.service
  cat <<EOF

    NOT STARTED. There is no account yet, and an instance without one has no
    gate. Create the first account and then start it:

      runuser -u $PODIUM_USER -- env DATA_DIR=$DATA_DIR node $admin_cli user add <name> --admin
      systemctl start podium

EOF
fi

cat <<EOF

Podium is installed.

  service    systemctl status podium
  logs       journalctl -u podium -f
  config     $CONFIG_DIR/podium.env
  data       $DATA_DIR
  accounts   sudo -u $PODIUM_USER DATA_DIR=$DATA_DIR node $PREFIX/current/server/podium-admin.js user list
  check      sudo -u $PODIUM_USER DATA_DIR=$DATA_DIR node $PREFIX/current/server/podium-admin.js doctor
  backup     sudo $PREFIX/current/deploy/backup.sh
  update     $here/deploy/update.sh $here

It is listening on 127.0.0.1:$PORT and expects a TLS terminator in front of it.
deploy/podium.nginx.conf is a template; deploy/README.md says what to change.
EOF
