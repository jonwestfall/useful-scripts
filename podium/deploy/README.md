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
dependencies, run the two browser-free test suites, flip the symlink, restart,
and poll `/healthz` — putting the previous release back if it does not come up.
The checkout is only ever read, so `git pull` keeps working.

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

## Backing up

Everything that matters is under one directory, which was the point of putting
it there:

```bash
systemctl stop podium
tar czf podium-$(date +%F).tar.gz -C /var/lib podium
systemctl start podium
```

The stop is only needed for a guaranteed-consistent SQLite copy; if you would
rather not interrupt anything, `sqlite3 /var/lib/podium/podium.db ".backup ..."`
does it live.

Releases are not worth backing up — they come from git.
