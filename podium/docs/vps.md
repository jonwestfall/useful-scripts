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
[roadmap.md](roadmap.md)). But the relay is still a pipe. Everything Podium
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
| What a TA may do | Drive the projector · upload to the library · read poll results and history. **Not** delete other people's library items (they can remove what they added themselves — see below) |
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
/var/backups/podium/                           where the backup script lands (BACKUP_DIR)
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

Later phases add `media`, `library_items`, `plans`, `course_settings`,
`lectures`, `lecture_events`, `lecture_polls`, `lecture_files`.
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
logged at startup: **if any account exists — including disabled ones — the
cookie governs and `AUTH_PASSWORD` is ignored.** Two doors into the same house,
one of them weaker, is how instances get embarrassed.

"Including disabled ones" is the important half. Counting only the accounts
that can currently sign in would mean that disabling the last one — something
you would do precisely because something was wrong — dropped the instance back
to `AUTH_PASSWORD`, or with the installer's defaults to no gate at all.
Locking yourself out must never be the same gesture as letting everyone else
in. With every account disabled the gate stays up and nobody gets through it;
`podium-admin user enable` is the way back, and the startup line says so.

One sharp edge this creates, and it must be handled in the same change: the
service worker is network-first and caches what it fetches. A navigation to
`control.html` while logged out follows the redirect and comes back a perfectly
valid login page — which would then be cached *under `control.html`'s key* and
served offline forever after. `sw.js` must refuse to cache any response that
was redirected.

## Phases

Each phase is meant to be independently shippable and independently useful.
All of them have now shipped; each carries an "as built" note where what was
built differs from what was planned, because the differences are the
interesting part.

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

**Removing a library item** is allowed to an admin, a course owner, *or the
person who uploaded it*. The "a TA may not delete" line in the table is about
*other people's* materials: what it protects against is shared files
disappearing, not somebody being unable to take back the wrong upload thirty
seconds later. A TA's own upload is theirs to remove. A member can only ever
remove their own, and nobody below owner can touch anyone else's.

### Phase 3 — plans and settings ✅

`plans` and `course_settings`. `plan.html` gains "send to the server" and "open
from the server" next to the file import and export it already has; nothing
about the plan *file* changes, because carrying one on a USB stick must keep
working. Logging in on a new device fetches transport, room and passphrase,
which is what makes new-device setup a login instead of a QR scan.

**As built, and one thing the sketch above got wrong.** Settings are held per
*course*, not per device or per user. The sketch never said whose settings a
device gets, and the answer matters: a TA may drive the projector, driving the
projector needs the room passphrase, and a per-user store would hand a TA
nothing — leaving the passphrase to be passed along by hand, which is the thing
this phase exists to stop. A course owns a room and a passphrase; being a
member is what gets you both.

Two consequences, stated rather than buried. **Reading** a course's settings
means holding the key to its projector — that is the point, and it means adding
someone to a course hands them that key and removing them again does not take
it back. Rotating the passphrase does — one button on the Admin page's course
card, or `podium-admin course settings --new-passphrase`. **Writing** them is therefore an
owner's or an admin's business, never a plain member's: a TA who could rotate
the key could lock an instructor out of their own lecture.

A device with no settings of its own adopts a course's automatically when
there is exactly one to adopt, and saves them — so the offline shell still
opens to a controller rather than a setup form when the Wi-Fi is down. Where
there are several courses, nothing is adopted and the choice is offered:
picking the wrong room is a mistake you discover in front of a class. Server
settings sit *below* localStorage in the precedence, so a device somebody has
already set up is never quietly re-pointed.

Plans invert the library's visibility rule, deliberately. A library item with
no course is visible to everyone with an account; a **plan** with no course is
visible only to its author. A library item is something you went out of your
way to publish; a plan is a draft until you file it under a course, and half a
written lecture appearing in a colleague's list would be a nasty surprise.
Sharing a plan shares it to be read and taught from — a course member can open
it and cannot overwrite it, and neither can a course owner who did not write
it.

### Phase 4a — the timeline and the polls ✅

`lectures`, `lecture_events` and `lecture_polls`. What was on the projector and
when, plus the final tally of every poll that ran. A session browser on
`admin.html` to read it back, name it, download the timeline, and pull a poll's
CSV out weeks later.

**As built**, with one correction to the sketch above worth stating plainly,
because it was wrong rather than merely vague: *the relay cannot write poll
results through to disk*, and it could not write the timeline either. Every
message Podium puts on a relay is encrypted in the browser under the room
passphrase — the relay moves ciphertext and knows nothing about what it says.
Only the `/poll` routes are plaintext there, and they carry answers, never the
question's final state or anything about what was on screen.

So the DISPLAY writes the timeline. It is the one device holding the decrypted
authoritative state, and on a server-backed deployment it is also a signed-in
page, so it can simply POST. The controller files each poll's tally for the same
reason: it is what ends a poll, and the only device that ever holds the final
counts. The display broadcasts the lecture id in `state` so the controller knows
what to file it under.

The rest of what that decision produced:

- **Which course a lecture belongs to is derived from the room**, not sent. The
  display has never needed to know a course code; it knows the room it is in,
  and phase 3 already stores a room per course. No match means no course, and
  then the plans rule applies — private to whoever ran it.
- **Entries are throttled to one per fifteen seconds**, and a change inside the
  gap replaces the one waiting. Stepping through forty slides should record
  where the lecture dwelled, not forty rows.
- **Append-only, with no end time per entry**: an entry ends where the next one
  begins. A display that loses the network or the power then leaves a record
  that is short rather than one that is wrong.
- **Events are queued and flushed in batches**, retried on failure, and beaconed
  on `pagehide` — the last thing that happened is exactly what a debounce has
  not sent yet.
- **A lecture that recorded nothing is discarded**, whether it was stood down or
  simply abandoned. Clicking Go live to check the projector is not a lecture.
- **5000 events per lecture**, and the lecture is flagged when it hits that, so
  a timeline that stops halfway is never read as a lecture that ended there.
- Writing to a lecture takes only the right to see it — the display and the
  controllers in a room are routinely different accounts. Removing one is
  narrower: whoever ran it, a course owner, or an admin.
- The arming screen says the lecture will be recorded. Nobody should have to
  read this file to find that out.

### Phase 4b — ink, photos, and how long they stay ✅

`lecture_files`: one row per file a session keeps, with the bytes in the SAME
content-addressed store the library uses. That sharing is the whole reason the
phase is small — dedup, the hashed path, `/media` serving and its hardening all
existed already — and it is also the one thing it could get wrong, so
`forgetMediaIfUnused` and `mayReadMedia` both had to learn that "in use" and
"may read" now have two tables to ask.

**Who files what, and why it has to be them:**

- **The display files the ink**, as strokes, when the lecture ends. It is the
  only device that has all of it — which is why exporting a session has always
  begun by pulling it across the relay from there. Strokes rather than pictures:
  a heavily drawn-on lecture is tens of kilobytes of JSON, and rebuilding a
  picture needs the deck behind it.
- **The controller files the photos**, as each one is taken, because that is
  where they live.
- **The controller files everything an export builds** — annotated slides,
  boards, poll CSVs, `session.txt` — when somebody presses Export. This is the
  part that makes "download that lecture again in March" real, and it is
  deliberately the export's own output rather than a second rendering path: the
  zip you got on the day and the zip you get in March are the same files.

Rebuilding the zip happens in the browser, with the same `zip.js` the controller
uses. The server never packs an archive; there is no zip code on it at all.

**The photo switch, and why it is off.** Podium's stated answer for photos has
been that they live in memory until Export, because a photo is usually somebody
else's — a worksheet, a board mid-argument, a face at the back. So the server
keeps none unless somebody has said it should: store no more than you have to.

Two levels, because they answer different questions. *Settings → Presentation →
Keep photos on the server by default* is the decision made once, in the office,
for a device. The switch on the Photos tab is this lecture only — a guest
speaker, a room with a camera on the students — and it starts from that default
and is forgotten on reload, so an exception never quietly becomes the rule.
Either one governs both the photo filed as it is taken and the photos inside a
filed export. Ink, poll CSVs and the rest of an export are nobody else's
picture and are kept whenever there is a lecture to keep them with.

**The retention control**, and the asymmetry that is the point of it:
`LECTURE_RETENTION_DAYS` ages out *files* — photos, ink, rasterized pages — and
never timelines or poll results. The bulk is what fills a disk; a few hundred
short rows is what somebody wants three years later when asked what a course
covered. Unset means keep everything, which is the right default for a box one
person runs for their own teaching: deleting a term's photos because nobody had
read the documentation would be the worse mistake. The sweep runs at startup and
daily, and `podium-admin lectures prune --days N` does it by hand. That command
is deliberately not called `sessions prune`, which already means expired logins.

Caps, so that one wedged controller cannot fill the disk in an afternoon: 16 MB
per file, 500 files and 400 MB per lecture, and an allow-list of what a session
may keep at all (png, jpeg, webp, json, txt, csv — nothing that executes, the
same rule the library's list is built on).

### Phase 5 — `admin.html` proper ✅

Accounts, courses and membership, the room each course connects to, what the
box is holding, and a copy of the database. Everything on this page was a shell
command until now, and that was the real gap: `podium-admin` is the right tool
for installing and for recovering, and the wrong one for adding a TA in the
week before term.

**Accounts** are an administrator's business and the card is absent rather than
disabled for anyone else — a page of controls that all answer 403 tells you
less than a page that does not offer them. Each row says when the account was
last seen and how many sessions it still holds, which are the two questions
anyone actually has in front of a list of accounts — a session, not a device:
signing in twice from the same browser counts twice, the same as two
different devices would. Setting somebody
else's password is a prompt rather than a field per row: it is a rare,
deliberate act, and a page carrying a dozen empty password boxes invites a
browser to fill one in.

**The rail that matters**: the last administrator who can sign in cannot be
disabled or demoted *from the browser*, and you are never offered either switch
on your own row. An instance with no enabled admin cannot be administered from
a browser at all, and the way back is a shell. Which is exactly why the same
rail is **not** in `accounts.js`: standing at a shell is the credential the CLI
runs on, and "that account is compromised, turn it off now" must not be a thing
Podium argues with. The rail goes on the path where a slip is plausible, not on
the path that exists to recover from one.

**Courses** gain the thing that makes them worth having: opening one shows who
is in it, lets an owner add and promote and remove, and shows the room that
course connects to — transport, room name, passphrase — with a one-button
rotate. That is the whole of "Sam joins PSY 415 and their iPad sets itself up
by logging in", on one card. Who is in a course is shown to somebody who *runs*
it, not to every member: a list of every account on the instance, assembled
from course pages, should need a reason. Making and archiving courses stays an
admin's: a course is the thing access is granted by, so inventing one is
inventing a place to put things where the instance's admin never looks.
Archiving is as close to deleting as Podium gets — everything filed under the
course stays exactly where it is and simply stops being listed. A term that is
over should go quiet, not take its lecture recordings with it.

**Storage** is three numbers and a button. `VACUUM INTO` is why the button is
three lines rather than a stop-the-world problem: SQLite writes a consistent
snapshot while the server runs, WAL and concurrent writers and all. The page
says plainly what that file is *not* — uploads and session photos live on disk
beside the database, so restoring it alone gives you every entry pointing at
bytes that are not there. Backing up the whole data directory is what
`deploy/` documents, and the ops script in phase 6 is where it gets automated.

### Phase 6 — operations ✅

`deploy/backup.sh`, `deploy/restore.sh`, and `podium-admin doctor`.

**Backup** takes three things and needs all three: a `VACUUM INTO` snapshot of
the database, the `media/` tree, and `podium.env`. `VACUUM INTO` rather than
`cp` is the whole reason it is a script — SQLite in WAL mode is several files,
and a copy taken mid-write restores, opens, and is quietly wrong. The archive is
`0600` (password hashes, every room's passphrase, possibly `AUTH_PASSWORD`),
keeps the last fourteen, and is read back before anything is pruned: a backup
nobody has ever opened is a hope rather than a backup. It needs nothing on the
box beyond `tar` and Podium's own Node, whose built-in SQLite takes the snapshot
when `sqlite3` is not installed — which is the choice from the top of this file
paying for itself in a place it was not chosen for.

**Restore** stops the service, moves the current data directory *aside* rather
than deleting it (a restore against the wrong archive happens at three in the
morning), puts the database and `media/` back together, and starts it again. The
database and the media tree go back together or not at all: the database holds
the index and `media/` holds the bytes each row points at, so restoring one
alone gives you an instance that opens perfectly, lists everything, and hands
you a broken image for all of it. The code is not restored and does not need to
be — releases come from git, and since migrations only ever add, restoring into
a newer release migrates on startup while restoring into an older one is refused
by the server itself.

**`podium-admin doctor`** is the list somebody would work through by hand at the
point where "it was fine last term" stops being true: Node and `node:sqlite`,
schema version, `integrity_check` and foreign keys, free disk, whether the data
directory is still `0700`, media files with no row and rows with no file,
whether anybody is left who can administer this from a browser, storage against
the retention setting, certificate expiry, and whether the service answers. Three
levels, because it is meant to be a cron line: `ok`, `warn` (exit 0), `bad`
(exit 1).

The check worth the whole command is the last one, and the sketch above had it
slightly wrong. "Whether the service worker and the deployed build agree" is a
*browser* problem, and the pages already solve it — each one reads its own BUILD
against the served copy and says so on screen. The server-side version is worse
and quieter: **`current` is a symlink and a service resolves it once, at start.**
Flip it without restarting and every file on disk is the new release, every
diagnostic agrees, and the code answering requests is last week's. So `/healthz`
now reports the build the running process actually resolved, and `doctor`
compares that against the release it is itself part of. Asked over `/healthz`
rather than by fetching `protocol.js`, because on an instance with accounts that
file is behind the login gate and answers 401 — which would have made the check
useless on exactly the deployments it matters most for.

**Logs** needed no rotation in the end, which is the right answer rather than a
missing one. Podium writes no log files: the service logs to the journal, which
rotates itself and can be capped in `journald.conf`; nginx's logs are rotated by
the package that ships nginx, and the site template turns access logging off for
`/healthz` so a monitor polling every ten seconds does not fill a disk with proof
that it is fine. The relay deliberately logs nothing per request or per message —
it moves ciphertext for rooms it cannot read, and a record of who connected when
is one it has no business keeping.

## Installation

`deploy/install.sh` on a fresh box: service user, the directory layout above,
`/etc/podium/podium.env`, the systemd unit, an nginx site from the template,
and a prompt for the first admin account.

There is no session secret to generate, which is worth saying because most
setups have one. Podium does not sign its session cookies — a cookie carries
32 random bytes and nothing else, and the database stores only their SHA-256.
Nothing has to be kept in sync for a session to be verifiable, so there is no
key to lose, rotate, or accidentally commit.

`deploy/update.sh` afterwards, generalised from the script this instance
already runs — rsync into a timestamped release directory, apply host config,
`npm ci --omit=dev`, run the unit tests, flip the `current` symlink, restart,
poll `/healthz`, and put the previous release back if it does not come up. The
existing script hardcodes one machine's paths; the shipped one takes them as
arguments and defaults to the layout the installer made.

Neither script is required. The manual path stays documented, because "clone it
and run `node podium-server.js`" is still the fastest way to see whether any of
this is for you.
