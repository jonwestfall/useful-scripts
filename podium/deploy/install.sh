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
command -v node >/dev/null || die 'node is not installed (Podium needs Node 22 or newer)'

node_major=$(node -p 'process.versions.node.split(".")[0]')
(( node_major >= 22 )) || die "node 22 or newer is required for node:sqlite (found $(node -v))"

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
STATIC=../
DATA_DIR=$DATA_DIR

# Lock the relay to your own site once you know the hostname:
#ORIGIN=https://podium.example.com

# Only consulted when there are NO accounts. Creating the first account with
# podium-admin turns the cookie gate on and this off.
#AUTH_PASSWORD=
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
"$here/deploy/update.sh" "$here"

echo "==> enabling the service"
systemctl enable --now podium.service

echo "==> first account"
# runuser rather than sudo: sudo is not on every minimal box, and this has to
# run AS the service account - a database file left owned by root is one the
# service cannot then write to.
as_podium() { runuser -u "$PODIUM_USER" -- env DATA_DIR="$DATA_DIR" "$@"; }
admin_cli="$PREFIX/current/server/podium-admin.js"
existing=$(as_podium node "$admin_cli" user list 2>/dev/null || true)
if [[ -n "$existing" && "$existing" != *'no accounts yet'* ]]; then
  echo "    accounts already exist, leaving them alone"
elif [[ ! -t 0 ]]; then
  echo "    no terminal to prompt on — create the first account yourself:"
  echo "      runuser -u $PODIUM_USER -- env DATA_DIR=$DATA_DIR node $admin_cli user add <name> --admin"
else
  echo "    Until an account exists, anyone who can reach this box can use it."
  read -rp "    Username for the first (admin) account [admin]: " first_user
  first_user=${first_user:-admin}
  as_podium node "$admin_cli" user add "$first_user" --admin
  # The gate is decided per request, but the startup line that reports which
  # mode is live is not - restart so the logs tell the truth.
  systemctl restart podium.service
fi

cat <<EOF

Podium is installed.

  service    systemctl status podium
  logs       journalctl -u podium -f
  config     $CONFIG_DIR/podium.env
  data       $DATA_DIR
  accounts   sudo -u $PODIUM_USER DATA_DIR=$DATA_DIR node $PREFIX/current/server/podium-admin.js user list
  update     $here/deploy/update.sh $here

It is listening on 127.0.0.1:$PORT and expects a TLS terminator in front of it.
deploy/podium.nginx.conf is a template; deploy/README.md says what to change.
EOF
