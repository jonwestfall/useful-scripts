# Podium on your own box

Podium has always been three static pages and a relay. That is what makes it
portable: GitHub Pages plus Supabase, or a public MQTT broker, or a folder on
disk, and nothing has to be installed anywhere. This document is about the
third route — **your own VPS** — and what becomes possible once there is a
machine of yours in the path that can actually *remember* things.

Everything here is additive. The Supabase and MQTT routes keep working exactly
as they do today, and so does opening `control.html` off a USB stick. A server
that offers none of this is not broken; it is the server Podium has always had.

## Why bother

Running your own relay already buys the one thing the classroom PC cannot do:
accept inbound connections, which is what made audience polls possible (see
[ROADMAP.md](ROADMAP.md)). But the relay is still a pipe. Everything Podium
knows lives in browser `localStorage` on whichever device happened to learn it:

- The **library** is a JSON file you edit, commit and push. Adding Tuesday's
  PDF means a git round trip.
- **Settings** are per-device. A new iPad is a QR scan and a passphrase.
- **Plans** are files you carry from the office machine to the room.
- **Sessions** — what you showed, what you drew on it, what the room answered —
  live in `localStorage` on the display and in RAM on the relay, and are gone
  when either restarts.

None of that is wrong for a laptop and a projector. It gets thin the moment
there is a real server sitting there with a disk.

## What has been decided

| Question | Answer |
|---|---|
| Which capabilities | **All four**: server-side file library, real accounts, durable session + poll history, server-stored plans and settings |
| Who can log in | **Multi-user accounts** — several logins, so co-instructors and TAs get their own |
| How content is shared | **Course is a tag that also grants access.** Library items and plans carry a course; membership in that course is what lets you see them |
| How it looks | **Flat, with a filter.** One library with a course filter — not a workspace you switch into |
| What stores it | **SQLite via `node:sqlite`** — built into Node 22, no npm dependency, no compiler, one file on disk. Media on the filesystem beside it |
| Uploads | **~50 MB**, single request. Decks, PDFs, images, modest audio. Lecture video still arrives by `rsync` |
| Where management lives | **A new `admin.html`** — library, accounts, courses, server settings |
| What a TA may do | Drive the projector · upload to the library · read poll results and history. **Not** delete library items |
| What a session keeps | Timeline of what was on screen · polls and results · ink · document-camera photos |
| Installation | **Installer plus update script**, generalised from the deploy script this instance already runs, health check and rollback included |
| The room passphrase | **Stored on the server.** See *What the server can see*, below — this is a real trade and it is being made deliberately |

## The rule that governs all of it

**The pages must keep working with no server at all.**

Every feature below is a progressive enhancement, gated on a single probe:

```
GET /api/capabilities  →  { "podium": true, "version": 1, "features": [...] }
```

A 404, a non-JSON body, a connection refused — any of those and the page is in
static mode and behaves precisely as it does today. There is no build flag and
no separate "server edition": one set of files that notices what it is being
served from. A deck opened from a USB stick must never discover that it wanted
a database.

This also decides where new UI may go. Anything server-backed either lives on
`admin.html` (which simply does not exist as a link when the probe fails) or
appears as an *additional* affordance next to something that already works —
"open a deck from the server" sits beside "open a deck from Files", it does not
replace it.

## What the server can see

Podium's stated security property has been: every message is encrypted in the
browser under a key derived from the room passphrase, and the relay only ever
moves ciphertext. The audience-poll routes were already the documented
exception — a student has no passphrase, so their answer arrives in the clear.

Server-stored settings make a second, larger exception, and it is worth being
blunt about it. **If the server hands a device its passphrase at login, the
server holds the key**, and "your own relay cannot read your traffic" stops
being true on this route.

That was chosen knowingly, for two reasons. The first is that it is nearly
moot: this same server is shipping you the JavaScript that does the encrypting.
A server willing to read your traffic can simply serve a page that mails it the
key. End-to-end encryption protects you from the *relay operator* — which is
the point when the relay is Supabase or a stranger's MQTT broker, and not much
of a point when the relay is a box you own and pay for. The second is that the
alternative buys very little for what it costs: one more thing to type on every
new device, every term, forever.

What does not change: the passphrase still gates *control*. Knowing it is still
the whole of the authorization to drive the projector, an account is still a
separate credential, and the Supabase and MQTT routes are untouched — there is
no server in either path to hold anything.

Written down plainly, a Podium VPS holds: your library files, your lecture
plans, your session history and ink, your poll results, your account password
hashes, and your room passphrase. Treat the box accordingly — it is now the
crown jewels rather than a pipe. Back it up; the installer will put the whole
lot under one directory precisely so that is one command.

## How it is laid out

Code is immutable and replaceable; data is neither. They go in different
places, which is what makes the release/rollback pattern safe.

```
/opt/podium/releases/<git-sha>-<timestamp>/   one deploy, read-only
/opt/podium/current                            symlink to the live release
/var/lib/podium/podium.db                      SQLite: everything structured
/var/lib/podium/media/<aa>/<sha256>            uploaded files, content-addressed
/var/lib/podium/backups/                       where the backup script lands
/etc/podium/podium.env                         secrets, systemd EnvironmentFile
```

`DATA_DIR` points at `/var/lib/podium` and is the only thing the server needs
told. Rolling back to last week's release does not roll back the database,
which is why migrations are forward-only and additive.

Media is content-addressed — stored under the SHA-256 of its bytes, sharded one
level to keep directories small. Uploading the same PDF to two courses stores
one copy; deleting one library item never deletes bytes another item is still
pointing at.

## The database

SQLite through `node:sqlite`, which Node 22 has built in. It prints an
experimental-feature warning and is otherwise a perfectly ordinary SQLite. The
alternative was `better-sqlite3` — faster, no warning, and a native module that
needs a compiler on the box and breaks on Node upgrades. For a table that will
never see a second concurrent writer, the built-in wins on every axis that
matters here: nothing to install, nothing to rebuild, `apt install sqlite3` and
you can read your own data.

Schema arrives in phases. Phase 1 creates the first four tables:

```sql
users(id, username, display_name, password_hash, is_admin, created_at, disabled_at)
auth_sessions(token_sha256, user_id, created_at, expires_at, last_seen_at, user_agent)
courses(id, code, title, created_at, archived_at)
course_members(course_id, user_id, role)        -- owner | member
```

Later phases add `media`, `library_items`, `plans`, `device_settings`,
`lectures`, `lecture_events`, `lecture_polls`, `lecture_ink`, `lecture_photos`.
Every migration is a numbered step against `PRAGMA user_version`, applied in
order at startup, and only ever adds.

Passwords are `scrypt` with a per-user random salt, stored as
`scrypt$N$r$p$salt$hash` so the parameters travel with the hash and can be
raised later without invalidating anyone. Session tokens are 32 random bytes;
the database stores only their SHA-256, so a stolen database backup is not a
stolen login.

## Authentication, and why it moves into the app

The instance this is written for currently does Basic Auth in nginx, and its
config carries the scars: `auth_basic off` for favicons because Apple's icon
discovery does not reliably reuse credentials, `auth_basic off` for the
webmanifests and PWA icons because Safari raises a native prompt on background
fetches, and an admin-owned `sw.js` whose entire job is to delete the offline
cache and unregister itself — because a service worker that returns a 401 makes
Safari's login prompt unreachable. The offline shell, the thing that makes
"Add to Home Screen" survive classroom Wi-Fi, had to be thrown away to get a
login.

A cookie fixes all of it at once. Browsers attach cookies to every same-origin
request automatically — subresources, manifests, icons, service-worker fetches
— with no prompt and no per-path exceptions. So:

- `POST /api/login` with a username and password sets `podium_session`:
  `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` whenever the request arrived
  over https (trusting `X-Forwarded-Proto` from the local proxy).
- A page request without a valid session **redirects** to
  `login.html?next=…` — a real page, not a browser prompt. `next` is validated
  as a same-origin relative path, or it is ignored.
- An API request without a valid session gets `401` and JSON, never a redirect.
- `join.html`, `assets/js/join.js`, `login.html` and its script, `/poll/*`,
  `/healthz` and `/api/capabilities` stay open. The audience never logs in.
- `SameSite=Lax` blocks cross-site form POSTs; mutating API routes
  additionally require a JSON content type and a same-origin `Origin` when one
  is sent. That is the whole CSRF story and it needs no tokens.
- Failed logins are rate-limited per IP and per username in memory — this is an
  internet-facing form on a box with one user, and an unthrottled one is a
  standing invitation.

`AUTH_PASSWORD` (the Basic Auth that shipped last week) stays for installs that
want one shared credential and no accounts. The precedence is explicit and
logged at startup: **if any enabled account exists, the cookie governs and
`AUTH_PASSWORD` is ignored.** Two doors into the same house, one of them
weaker, is how instances get embarrassed.

One sharp edge this creates, and it must be handled in the same change: the
service worker is network-first and caches what it fetches. A navigation to
`control.html` while logged out follows the redirect and comes back a perfectly
valid login page — which would then be cached *under `control.html`'s key* and
served offline forever after. `sw.js` must refuse to cache any response that
was redirected.

## Phases

Each phase is meant to be independently shippable and independently useful.

### Phase 1 — accounts, and the server's own memory ✅

The foundation everything else needs: a place to put things, and a notion of
who is asking.

`server/store.js` (SQLite, migrations, data dir) · `server/accounts.js` (scrypt,
sessions, rate limiting) · the `/api` router with capabilities, login, logout
and me · `login.html` · the cookie gate in `podium-server.js` · the `sw.js`
redirect guard · `server/podium-admin.js` to create the first account from the
shell · courses and membership tables, unused until Phase 2 · install and
update scripts, systemd unit and an nginx template with `auth_basic` removed.

Shipping the nginx template in this phase is not optional: the same change that
moves auth into the app must remove it from the proxy, or the instance gets two
prompts.

### Phase 2 — the library on the server ✅

`media` and `library_items`. Upload up to 50 MB from `admin.html`, dedupe by
hash, allow-list content types. The controller's Library tab merges three
sources: items shipped in `content/manifest.json` (read-only, so the working
examples still work), items uploaded to a course you are a member of, and
whatever the device has cached. Deleting is owner-only, as decided.

**As built.** An upload is the raw file as the request body with its name and
course in the query string — not `multipart/form-data`, which would have been
the largest thing in this repository and exists only to carry three short
strings the query string carries anyway. `fetch(url, { method: 'POST', body:
file })` is the whole client side.

Uploads are served from Podium's own origin, which is the thing to be careful
about: a file a browser would execute there runs with the session cookie and
the projector inside its reach. Three defences, all of them in the same change:
the allow-list is extensions, not declared types, and has no `.html`, `.svg`,
`.js` or `.xml` in it; `nosniff`, so a browser cannot decide a `.png` is really
something else; and `Content-Security-Policy: default-src 'none'; sandbox` on
every media response, which leaves anything that got past the first two with no
scripts and no origin. Uploaded *decks* were already safe: `deck.js` renders
markdown through a Marp HTML allow-list that has never permitted `<script>`.

A course becomes the item's group heading on the controller when nothing more
specific is set, and the group is part of what the existing filter box
searches — so typing `psy415` narrows the library to that course. That is the
"filter, not a mode switch" decision, implemented without a new control.

### Phase 3 — plans and settings

`plans` and `device_settings`. `plan.html` gains "save to server" and "open from
server" next to the file import and export it already has; nothing about the
plan *file* changes, because carrying one on a USB stick must keep working.
Logging in on a new device fetches transport, room, passphrase and preferences,
which is what makes new-device setup a login instead of a QR scan.

### Phase 4 — durable sessions

`lectures` and its four child tables. The display writes a timeline as it
goes; the relay writes poll results through to disk instead of only holding
them in RAM; ink and document-camera photos are captured at the end of a
lecture rather than living in `localStorage`. A session browser on
`admin.html`, the existing session zip exported from any past lecture rather
than only the live one, and a retention control, because ink and photos are the
two payloads that grow without bound.

### Phase 5 — `admin.html` proper

Accounts, courses and membership. Server settings. Storage usage. Backup and
restore. Phases 2–4 each add their own panel to a page that starts as a stub in
Phase 1.

### Phase 6 — operations

Backup script and a documented restore. Log rotation. A `podium doctor` that
checks the things that actually go wrong: disk space, database integrity,
certificate expiry, whether the service worker and the deployed build agree.

## Installation

`deploy/install.sh` on a fresh box: service user, the directory layout above,
`/etc/podium/podium.env` with a generated session secret, the systemd unit, an
nginx site from the template, and a prompt for the first admin account.

`deploy/update.sh` afterwards, generalised from the script this instance
already runs — rsync into a timestamped release directory, apply host config,
`npm ci --omit=dev`, run the unit tests, flip the `current` symlink, restart,
poll `/healthz`, and put the previous release back if it does not come up. The
existing script hardcodes one machine's paths; the shipped one takes them as
arguments and defaults to the layout the installer made.

Neither script is required. The manual path stays documented, because "clone it
and run `node podium-server.js`" is still the fastest way to see whether any of
this is for you.
