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
# The one package it does install is a browser, for the live browser (web
# pages driven from the controller): Google Chrome on amd64, Debian's Chromium
# on arm64 Debian. INSTALL_CHROME=0 leaves it out.
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
# The live browser (server/browser.js) needs a Chromium. INSTALL_CHROME=0
# skips installing one; web pages are then embedded frames, as they always were.
INSTALL_CHROME=${INSTALL_CHROME:-1}

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

# Outgoing mail, for attendance receipts (optional). smtp:// uses STARTTLS
# and will not send a password without it; smtps:// is TLS from the start.
# Percent-encode any special characters in the user or password.
#SMTP_URL=smtp://user:password@mail.example.edu:587
#MAIL_FROM="Podium <podium@example.edu>"

# The live browser: web pages run in Chromium on this box and are driven from
# the controller. On whenever Chromium is installed (this script installs it;
# restart the service after installing one by hand). See docs/vps.md.
#LIVE_BROWSER=off
#BROWSER_PATH=/usr/bin/google-chrome-stable
#BROWSER_MAX_SESSIONS=4
#BROWSER_IDLE_MINUTES=10
#BROWSER_ALLOW_PRIVATE=1
#BROWSER_SEARCH_URL=https://www.google.com/search?q=
# A network that only reaches the internet through a proxy:
#BROWSER_UPSTREAM_PROXY=http://proxy.example.edu:3128
#BROWSER_ARGS=
#BROWSER_SANDBOX=off
EOF
  chmod 0640 "$CONFIG_DIR/podium.env"
  chgrp "$PODIUM_USER" "$CONFIG_DIR/podium.env"
fi

echo "==> live browser (a Chromium for web pages driven from the controller)"
# Never fatal: everything else works without it, and a mirror that is down
# today is no reason to leave a half-installed server behind.
find_chrome() {
  local name
  for name in google-chrome-stable google-chrome chromium chromium-browser; do
    command -v "$name" 2>/dev/null && return 0
  done
  return 1
}
install_chrome() {
  command -v apt-get >/dev/null || { echo "    no apt here: install Chrome or Chromium yourself (docs/vps.md, \"The live browser\")"; return 0; }
  local arch tmp
  arch=$(dpkg --print-architecture)
  if [[ "$arch" == amd64 ]]; then
    tmp=$(mktemp -d)
    # Google's own package: its sandbox works for a service user, and it adds
    # Google's apt repository, so Chrome updates with the rest of the system.
    if command -v curl >/dev/null; then
      curl -fsSL -o "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb || { rm -rf "$tmp"; return 1; }
    elif command -v wget >/dev/null; then
      wget -q -O "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb || { rm -rf "$tmp"; return 1; }
    else
      rm -rf "$tmp"; echo "    neither curl nor wget is here to download Chrome with"; return 1
    fi
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$tmp/chrome.deb"
    local status=$?
    rm -rf "$tmp"
    return $status
  fi
  # No Google Chrome for Linux on other architectures. Debian's own Chromium
  # is a real package; Ubuntu's is a snap, which expects a home directory a
  # service account does not have.
  if grep -qi '^ID=debian' /etc/os-release 2>/dev/null; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq chromium
    return $?
  fi
  echo "    no package for $arch here: install a Chromium yourself and set BROWSER_PATH (docs/vps.md)"
  return 0
}
if [[ "$INSTALL_CHROME" == 0 ]]; then
  echo "    skipped (INSTALL_CHROME=0): web pages will be embedded frames"
elif chrome=$(find_chrome); then
  echo "    already here: $chrome"
elif install_chrome; then
  chrome=$(find_chrome) && echo "    installed: $chrome"
else
  echo "    WARNING: Chrome did not install; web pages will be embedded frames until it does (docs/vps.md, \"The live browser\")"
fi

echo "==> systemd unit"
sed -e "s#@PREFIX@#$PREFIX#g" -e "s#@USER@#$PODIUM_USER#g" \
    -e "s#@DATA_DIR@#$DATA_DIR#g" -e "s#@CONFIG_DIR@#$CONFIG_DIR#g" \
    "$here/deploy/podium.service.in" > /etc/systemd/system/podium.service

# Installed alongside the relay's own unit, not left as a manual cron line to
# remember: deploy/backup.sh and restore.sh are only as good as the first one
# actually running, and doctor's own new backup check (see server/doctor.js)
# exists specifically because nothing before this caught an install that
# skipped that step. Enabling it is asked about below, once there is
# something to back up.
sed -e "s#@PREFIX@#$PREFIX#g" -e "s#@DATA_DIR@#$DATA_DIR#g" -e "s#@CONFIG_DIR@#$CONFIG_DIR#g" \
    "$here/deploy/podium-backup.service.in" > /etc/systemd/system/podium-backup.service
install -m 0644 "$here/deploy/podium-backup.timer" /etc/systemd/system/podium-backup.timer
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

echo "==> nightly backups"
# Asked here, after the service has had its chance to create a database:
# backup.sh refuses cleanly (its own die() message) if there is nothing yet
# to back up. Interactive installs default to yes - the safe answer, with an
# easy no - because a person is here to make that call; an unattended one
# defaults to no and stays that way, the same reasoning the account step
# above refuses to auto-start without a human present for.
if [[ -t 0 ]]; then
  read -rp "    Enable the nightly backup timer (podium-backup.timer, 03:15 daily)? [Y/n]: " enable_backup
else
  enable_backup=n
fi
if [[ -z "$enable_backup" || "$enable_backup" =~ ^[Yy] ]]; then
  systemctl enable --now podium-backup.timer
  backup_line="enabled - systemctl status podium-backup.timer"
else
  backup_line="NOT enabled - systemctl enable --now podium-backup.timer"
fi

cat <<EOF

Podium is installed.

  service    systemctl status podium
  logs       journalctl -u podium -f
  config     $CONFIG_DIR/podium.env
  data       $DATA_DIR
  accounts   sudo -u $PODIUM_USER DATA_DIR=$DATA_DIR node $PREFIX/current/server/podium-admin.js user list
  check      sudo -u $PODIUM_USER DATA_DIR=$DATA_DIR node $PREFIX/current/server/podium-admin.js doctor
  backup     sudo $PREFIX/current/deploy/backup.sh (nightly timer: $backup_line)
  update     $here/deploy/update.sh $here

It is listening on 127.0.0.1:$PORT and expects a TLS terminator in front of it.
deploy/podium.nginx.conf is a template; deploy/README.md says what to change.
EOF
