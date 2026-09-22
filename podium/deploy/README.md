# Putting Podium on a box

Three files do the work, and none of them is required — the manual path in the
main [README](../README.md) still works and is still the fastest way to find
out whether you want any of this.

| File | When |
|---|---|
| `install.sh` | once, on a fresh machine |
| `update.sh` | every deploy afterwards |
| `podium.nginx.conf` | a template to adapt, once |

## First time

```bash
git clone https://github.com/jonwestfall/useful-scripts.git
sudo useful-scripts/podium/deploy/install.sh
```

It makes a service account, the directory layout below, an environment file, a
systemd unit, the first release, and prompts for the first admin account. It
does **not** install nginx, obtain a certificate or touch your firewall: that
is where every box differs from every other one.

```
/opt/podium/releases/<sha>-<stamp>   one deploy, read-only
/opt/podium/current                  symlink to the live release
/var/lib/podium/                     database and uploads — no deploy touches this
/etc/podium/podium.env               configuration and secrets
```

Then adapt `podium.nginx.conf` — change `podium.example.com` in the four places
it appears, point it at your certificate, and reload. Certbot's nginx plugin
will do the certificate part for you and rewrite the `ssl_*` lines.

**If you are coming from a Basic Auth setup, take `auth_basic` out.** Podium now
authenticates itself with a session cookie, which is what lets it cover the
things Basic Auth never could: the WebSocket handshake, and every background
fetch Safari used to raise a native prompt on. Leaving `auth_basic` in place
gets you two logins for one page.

## Afterwards

```bash
cd useful-scripts && git pull
sudo podium/deploy/update.sh
```

Copy the checkout into a fresh release directory, install production
dependencies, run the three browser-free test suites (`protocol`, `plan` and
`store`), flip the symlink, restart, and poll `/healthz` — putting the previous
release back if it does not come up. The checkout is only ever read, so
`git pull` keeps working.

Environment variables it honours: `PREFIX`, `DATA_DIR`, `SERVICE`,
`HEALTH_URL`, `KEEP_RELEASES`, and `ADMIN_DIR` — a directory of host-specific
files (`config.json` is the usual one) laid over each release after copying, so
per-box configuration does not have to live in the repository.

## Accounts

```bash
cd /opt/podium/current/server
sudo -u podium DATA_DIR=/var/lib/podium node podium-admin.js user add sam --name "Sam Okafor"
sudo -u podium DATA_DIR=/var/lib/podium node podium-admin.js course add psy415 --title "PSY 415"
sudo -u podium DATA_DIR=/var/lib/podium node podium-admin.js member add psy415 sam
```

`podium-admin.js help` lists the rest. The first account is the moment the
instance stops being open to anyone who can reach it, so make it early.

After that, most of this is easier on the **Admin page** in a browser: accounts,
courses, membership, each course's room and passphrase, and what the box is
holding. The CLI stays the right tool for installing, for scripting, and for
getting back in — it is the one path that will still disable the last
administrator when you need it to.

## Session records, and how long they are kept

Once there are accounts, the display writes down what it showed, and the
controller files the photos and the pages an export rasterizes (see
[../docs/vps.md](../docs/vps.md)). Those two are the parts that grow, so
`LECTURE_RETENTION_DAYS` in `podium.env` ages them out:

```
LECTURE_RETENTION_DAYS=180
```

Unset means keep everything, which is the right default for a box one person
runs for their own teaching. Whatever it is set to, a lecture's **timeline and
poll results are never aged out** — they are a few hundred short rows, and they
are what you want three years later when somebody asks what a course covered.
The sweep runs at startup and once a day; to run it by hand, or once, without
setting it at all:

```bash
cd /opt/podium/current/server
sudo -u podium DATA_DIR=/var/lib/podium node podium-admin.js lectures list
sudo -u podium DATA_DIR=/var/lib/podium node podium-admin.js lectures prune --days 180
```

Courses are how the library is shared: an item filed under `psy415` is visible
to that course's members, an item filed under nothing is visible to everyone
with an account here. Members can add to a course library and present from it;
removing something needs to be its uploader, a course owner, or an admin.

## The library

Once there are accounts, `admin.html` is where files go — decks, PDFs, images,
audio and video, up to 50 MB each, straight from a browser instead of through a
git commit. Uploads are stored under the SHA-256 of their contents, so the same
file added to two courses takes one copy of the disk.

They appear on the controller's Library tab beside the examples that ship in
`content/manifest.json`, filed under their course. Typing a course code into
the filter box narrows the library to that course.

## Setting a course up so a new device is just a login

Give a course a room and a passphrase and its members' devices configure
themselves when they sign in — no pairing QR, nothing typed:

```bash
cd /opt/podium/current/server
sudo -u podium DATA_DIR=/var/lib/podium node podium-admin.js course settings psy415 \
  --transport ws --room psy415-live --ws-url wss://podium.example.com/podium --new-passphrase
```

`--new-passphrase` invents one and prints it; that is the only time it is
shown. Any other change leaves it alone and does not print it.

Be clear-eyed about what this hands out: **every member of a course can read
that course's passphrase**, because driving the projector is what it is for.
Adding someone gives them that key, and removing them does not take it back —
rotating it does, and every device already set up for the course then needs the
new one. Changing a course's settings is restricted to its owners and to
admins, so a TA cannot rotate a key out from under an instructor.

Lecture plans work the same way round as you would hope: a plan you send to the
server is yours alone unless you file it under a course, and a plan filed under
a course can be opened and taught from by its members but rewritten only by
whoever wrote it.

## Backups

Everything that matters is under one directory, which was the point of putting
it there. Releases are not worth backing up — they come from git.

```bash
sudo ./deploy/backup.sh                       # writes /var/backups/podium/podium-<stamp>.tar.gz
sudo BACKUP_DIR=/srv/backups ./deploy/backup.sh
```

Three things go in, and all three are needed: a **snapshot of the database**
(`VACUUM INTO`, not `cp` — SQLite in WAL mode is several files, and a copy taken
mid-write restores, opens, and is quietly wrong), the **`media/` tree** (the
bytes every library entry and session photo points at), and **`podium.env`**.
The archive is written `0600` because it holds password hashes, every room's
passphrase, and possibly `AUTH_PASSWORD`. It keeps the last `KEEP_BACKUPS`
(default 14) and reads the archive back before pruning, because a backup nobody
has ever opened is a hope rather than a backup.

`install.sh` installs `podium-backup.timer` (03:15 daily, `Persistent=true` so
a box that was off at that hour catches up the moment it is next up) and, on
an interactive install, offers to enable it right there. If you said no then,
or ran the install unattended, turn it on whenever you are ready:

```bash
sudo systemctl enable --now podium-backup.timer
sudo systemctl status podium-backup.timer      # confirm it is actually scheduled
```

Prefer a plain cron line instead? That still works exactly as before:

```
15 3 * * *  root  /opt/podium/current/deploy/backup.sh >/var/log/podium-backup.log 2>&1
```

Either way, **turning it on is not optional** - `podium-admin doctor` has its
own check for this (see "Checking up on it" below) precisely because a box
that has never backed up anything looks completely healthy right up until the
disk it is on is not there anymore.

A backup on the same disk as the thing it is backing up protects you from a
mistake, not from the disk. Copy the archives off the box.

## Restoring

```bash
sudo ./deploy/restore.sh /var/backups/podium/podium-20260917T2014.tar.gz
sudo RESTORE_ENV=1 ./deploy/restore.sh <archive>     # also put podium.env back
```

It stops the service, moves the current data directory aside as
`podium.replaced-<stamp>` (rather than deleting it — a restore against the wrong
archive happens at three in the morning), puts the database and `media/` back
together, and starts the service again.

**The database and `media/` have to go back together.** The database holds the
index — every library item, every session's list of files — and `media/` holds
the bytes those rows point at. Restore one without the other and Podium opens
perfectly, lists everything, and hands you a broken image for all of it.

The code is not restored and does not need to be: a release comes from
`update.sh`, and the schema only ever moves forward, so restoring into a *newer*
release is fine — it migrates at startup — and restoring into an older one is
refused by the server itself rather than silently half-working.

Then check it:

```bash
sudo -u podium DATA_DIR=/var/lib/podium node /opt/podium/current/server/podium-admin.js doctor
```

## Checking up on it

```bash
sudo -u podium DATA_DIR=/var/lib/podium node podium-admin.js doctor
sudo -u podium DATA_DIR=/var/lib/podium node podium-admin.js doctor \
  --health-url http://127.0.0.1:8080/healthz --cert /etc/letsencrypt/live/podium.example.com/fullchain.pem
```

The list somebody would work through by hand at the point where "it was fine
last term" stops being true: Node and `node:sqlite`, the schema version, SQLite's
own `integrity_check` and foreign keys, free disk, whether the data directory is
still `0700`, media files with no row and rows with no file, whether anybody is
left who can administer this from a browser, what storage is being used against
the retention setting, **whether a backup has ever actually run and how stale
the newest one is**, certificate expiry, and whether the service answers.

And one that is easy to miss and costs an afternoon: **the build the running
process is serving versus the release that is deployed.** `current` is a symlink,
and a service resolves it once — at start. Flip it without restarting and every
file on disk is the new release, every diagnostic agrees, and the code answering
requests is last week's. `/healthz` reports the build the process actually
resolved, so `doctor` can compare the two and say `systemctl restart`.

It exits 0 when nothing is broken (warnings included) and 1 when something needs
attention, so it can be a cron line:

```
30 6 * * *  root  /usr/bin/node /opt/podium/current/server/podium-admin.js doctor || mail -s 'podium doctor' you@example.com
```

## Logs

Podium writes no log files of its own. The service logs to the journal, which
rotates itself:

```bash
journalctl -u podium.service -f            # follow
journalctl -u podium.service -n 200        # the last 200 lines
journalctl -u podium.service --since -1h
```

If the journal is growing more than the box can afford, cap it in
`/etc/systemd/journald.conf` — `SystemMaxUse=200M` is generous for this — and
`systemctl restart systemd-journald`. nginx's own access and error logs are
rotated by the `logrotate` snippet the distribution's nginx package ships; the
site template turns access logging off for `/healthz` so a monitor polling every
ten seconds does not fill a disk with proof that it is fine.

The relay does not log a line per request or per message, deliberately: it moves
ciphertext for rooms it cannot read, and a log of who connected when is a record
it has no business keeping.
