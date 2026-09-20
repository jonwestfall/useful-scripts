# Roadmap: audience participation

Students scan a QR code or open a short URL, enter the code on the projector,
and answer the question that is up — a multiple choice, or a short typed
answer. The presenter watches results arrive live, privately, on the
controller; the room sees nothing until a separate explicit Reveal. Results
can be exported afterwards, and a poll already ended can be reopened
(asked again, fresh) or redisplayed (its final results, put back up) later
in the same session.

The old Socrative did roughly this. This document is how Podium will.

## What has been decided

| Question | Answer |
|---|---|
| Build it in, or point at an existing tool? | **Build it in** |
| Which relay? | **The self-hosted one** (`server/podium-server.js`) |
| How many answering at once? | **60–120** |
| What v1 does | **Multiple choice (A/B/C/D)** and **short typed answers, shown as a list** |
| Who sees results | **The presenter, live, always** — the controller shows counts and answers as they arrive, no waiting; the room sees nothing until **Reveal to room**, one explicit action, always separate from closing voting (superseded the earlier live/on-close/never sketch below — see "Settled") |
| Afterwards | **Exportable** (a CSV button per poll, and folded into the session zip); ended polls stay in a **this-session history** to reopen or redisplay; no saved poll *library* across sessions — see "Settled" |

True/False comes free with multiple choice (it is the same machinery with two
fixed options). A word cloud is deferred — the short-answer list is the same
input with a simpler, more useful rendering, and nothing about the plan
below forecloses adding a cloud view of the same data later.

## Why the self-hosted relay changes everything

The original worry in this document was that Podium's whole security model is
"know the room passphrase" (see `crypto.js`: one AES-GCM key derived from
passphrase + room, and anything holding it can drive the display, not just
answer a poll). Handing that to a room of students to collect a vote would
hand them freeze, blank, and every other command. That has not changed and
still rules out putting audience traffic on the room's own channel.

What running your own relay changes is that there is now **a server students
can reach that is not the projector**. The classroom PC cannot accept inbound
connections; a VPS can. That makes the simplest possible design available:

- **Students POST a vote over plain HTTP.** No WebSocket, no crypto, no CDN,
  no library. A phone on bad campus wifi retries a POST; it does not have to
  hold a connection open to be counted.
- **Students receive the current question over SSE** (`EventSource`, built
  into every browser, reconnects by itself, ~15 lines of server). One-way,
  server to phone, a message only when the question actually changes.
- **The display polls the relay for the tally**, once a second, and folds it
  into its own state — so every connected controller sees live results
  through the normal encrypted broadcast without talking to the poll server
  at all.

At 120 students that is 120 idle SSE connections and a burst of 120 POSTs per
question. A ~150-line Node server does not notice either. Critically, none of
this touches the room's WebSocket, so the relay's existing 12-peer room cap
stays exactly as it is and is not a constraint on class size.

### The one real concession

Students do not have the room key and must not, so **their answers reach the
relay as plaintext**. On a relay you run yourself, on a box you control, for
anonymous answers to a question you just put on a projector, that is a fair
trade — but it is a genuine exception to "the relay never sees content in the
clear," and it should be stated in the README rather than glossed over.

Encrypting with a key derived from the access code would be theatre: the code
is displayed on a projector to the whole room, and you own the server anyway.

### If you ever move off the self-hosted relay

Polls would need a poll server regardless — Supabase Realtime would work
(200 concurrent connections and 2M messages/month on the free tier is many
classes over), but it is a different implementation. To keep that door open,
the poll endpoint should be its own config field defaulting to "derived from
`wsUrl`", not hard-wired to it.

## The shape: a poll is an item

Podium already has a content model that freeze, cue, TAKE, the B/C/D panels,
photos and automated sets all understand. A poll is an item in it, exactly as
an automated set became one. What actually shipped in step 2, once asking the
user resolved a few open questions the sketch below had left open:

```js
{ type: 'poll', pollId, token, kind: 'choice' | 'text',
  question: 'Which bias is this?', options: ['Construct', 'Method', …],
  open: true, revealed: false, voters: 0,
  counts: [12, 3, 40, 1], answers: ['exposed', 'seen', …],
  hiddenAnswers: [1] }
```

`token` doubles as the "is this a live poll" flag: a poll **redisplayed** from
this session's history (see "History" under "What gets built") carries the
same `pollId`, for a stable ink key, but an empty `token` - there is nothing
left on the relay behind it, so the display's own poll loop and every
relay-touching control (Close/Reopen voting, the join QR) skip it, and it
renders as a frozen, already-revealed snapshot rather than a dead join code.
`hiddenAnswers` is indices into `answers`, set by the presenter (Step 3,
below) and honoured by the projector's renderer, never by the relay - the
relay still has every answer; a hidden one has simply never been shown to
the room.

`pollId` is the same four-letter code the relay hands back and the room
types in — no separate internal id. `token` is the relay's private host
credential, carried on the item because whichever controller composed the
poll is the only place it is ever needed again (closing voting, reopening
it, exporting, deleting). `open`/`voters`/`counts`/`answers` are filled in
by the display polling the relay once a second, same as a running set's
clock — every controller renders them from the broadcast echo, never
fetching the relay itself except through the one controller that owns the
UI action in front of the user.

Staged onto a panel the normal way. That buys, with no special-casing: it can
be cued behind a freeze and taken; it can live in panel B while slides stay
on A; it can be photographed; it survives a display reload like everything
else on screen (the relay's own 12-hour TTL is the real limit, not Podium's
own state).

## Reveal is its own action, not a mode - and it only ever gates the room

The original sketch above had `reveal` as a per-poll mode chosen up front
(`live` / `onClose` / `never`). Step 2 shipped a simpler first cut instead: a
single boolean, `revealed`, toggled by an explicit action - but that first
cut made it gate the *presenter's own* view too, so nobody saw anything
before choosing to reveal it. Told plainly that the presenter should never
have to wait on their own Reveal tap to find out what the room said, the
fix landed exactly where the note below had already flagged it would:
**`revealed` now controls only the projector.** The controller's own
`renderRunningPoll()` shows counts and answers unconditionally, live, the
moment `tickPolls()` (the display's once-a-second relay poll, see "The
shape" above) reports them - `#poll-toggle-reveal` ("Reveal to room" /
"Hide from room") is the one thing standing between that private view and
the one on the wall. Closing voting still never reveals anything by itself.

This is what gives the moderation Step 3 needed something to moderate:
anonymous free text is visible to the presenter as it arrives, and
`hideAnswer` (an index into `answers`, toggled per-answer, honoured only by
the projector's own renderer) is how one bad answer gets pulled before the
room ever sees it — without needing to hide the *whole* poll to buy the
time to read it first.

## What gets built

**`server/podium-server.js`** (+~70 lines, no new dependency)

- an in-memory `polls` map, `code → { question, answers, votes }`
- `GET  /poll/:code/stream` — SSE; pushes the current question when it changes
- `POST /poll/:code/vote` — records one answer, `204`
- `GET  /poll/:code/results` — the tally, for the display
- `PUT  /poll/:code` — the display sets the current question
- CORS headers and an `OPTIONS` preflight, since the pages may be served from
  GitHub Pages while the relay lives elsewhere
- no persistence: a poll lives as long as the relay process, which is the same
  promise every other ephemeral thing in Podium makes

**`join.html` + `assets/js/join.js`** — a fourth page, deliberately the
smallest one in the repo. Enter a code (or arrive with `?c=CODE`), see the
question, tap an answer or type one, see "got it". No settings, no passphrase,
no relay client, nothing to install.

**`protocol.js`** — the `poll` item type (`normalizeItem`, and a content-derived
`inkSurfaceKey` case so ink survives the fresh `.key` every re-stage gets) and
the one command that drives it beyond the ordinary stage/panel/clear set:
`{ op: 'poll', pollId, action: 'reveal', value }`. Open/close and the tally
itself are relay state, not protocol state — the display's own poll loop
(`tickPolls()`, mirroring the existing `tickSets()`) is what keeps `open`,
`voters`, `counts` and `answers` in sync with the relay, same as a running
set's clock ticks on its own.

**`renderers.js`** — `renderPoll`: the question, a QR + code to join while
`!revealed`, and the results (bars for choice, a list for text) once
`revealed` — the QR renderer already existed and the join-card layout reuses
its drawing approach. The join URL comes from a new `opts.getPollJoinUrl`
callback (renderers have no access to `cfg`, so display.js and control.js
each supply it via `pollJoinUrl(cfg, pollId)` from `config.js`).

**`control.js`** — a Polls tab: compose a question (kind, options), **Start
poll** creates it on the relay and stages it; while it runs, the tab shows
live votes as they arrive (not gated on reveal - see above), lets the
presenter **Hide**/**Unhide** any one typed answer, and offers **Close/Reopen
voting**, **Reveal/Hide to room**, **Export CSV**, and **End poll** (a
second-tap confirm, like other destructive buttons here - `wireDangerButton`
normally leaves a button disabled after use, which is wrong for one a
session expects to press more than once, so `endPoll` re-arms it). The tab
finds the one poll item wherever it is staged (`state.program`,
`state.preview`, or any of `state.panels`) rather than tracking it
separately — consistent with "one poll at a time" being a UX rule, not
protocol state.

**History, reopen and redisplay** — every poll `endPoll()` actually deletes
from the relay (a token-carrying one; a redisplay dismissed by End poll is
not re-archived) is first snapshotted into `pollHistory`, a plain array in
`localStorage` capped at 20 rows - "this session", not a cross-lecture
library, the same shelf life as the Saved tiles in the Library. Each row
offers **Reopen** (the same kind/question/options loaded back into the
composer, asked again from zero - a new relay poll, new code) and
**Redisplay** (the final snapshot staged straight back up, `token: ''`,
`open: false`, `revealed: true` - see "The shape" above for what a
token-less item means to the rest of the system). Both are disabled while a
poll is currently running rather than queuing invisibly behind it.

**Export** — a CSV download button per poll (`pollResultRows()`, built from
the item's own `counts`/`answers`/`hiddenAnswers` rather than a fresh relay
fetch, which is also what makes it work on a token-less redisplay with
nothing left to fetch from), plus the same rows folded into
`exportSession()`'s zip (Photos tab) as `polls/NN-question.csv` - one per
poll currently on screen and one per row in history.

**Planning** (`planfile.js` / `plan.js`) — `PLAN_TYPES.poll`: kind, question,
and options (one per line - the field editor only knows scalar kinds, so
they travel as one newline-separated string, split back into an array only
when loaded into the composer). A planned poll is a question, not yet a
poll: it carries no `pollId` or `token`, since nothing has talked to a relay
yet. Picking its Library tile does not stage it - `pick()` special-cases
`type === 'poll'` the same way it already does `camera`, opening the Polls
tab with the composer pre-filled instead. Automated Sets declines it for
the same reason `camera` is declined: there is no sensible "hold it for 20
seconds then move on" for a question the room is still answering.

## Order of work

1. ~~**Server endpoints + `join.html`, multiple choice only.**~~ **Done.** End
   to end, one question, votes landing in a tally, tested with a script
   posting 120 votes before any UI existed.
2. ~~**The `poll` item, renderer and Polls tab.**~~ **Done.** Composing,
   staging, watching votes arrive, closing, revealing and exporting, all
   driven from the controller and tested through the real UI, not just the
   relay directly.
3. ~~**Short typed answers, and hide-an-answer.**~~ **Done.** Typed answers
   render as a live list on both the controller and (once revealed) the
   projector; `hideAnswer` lets the presenter drop one before the room ever
   sees it, without hiding the whole poll to buy time to read it first.
4. ~~**Export**, into the existing session zip, alongside the per-poll CSV
   button step 2 already shipped.~~ **Done** — see "Export" above.
5. Word cloud, if the list turns out to want it.

Beyond the original four steps: **live results on the controller**
(reveal now gates only the projector, not the presenter's own view),
**session history with reopen/redisplay**, and **planning-page support**
(compose a poll's wording in the office, saved in the plan file, started
for real from the Polls tab in class) all shipped together in one round,
prompted directly by using the thing in a real room.

Each step is shippable on its own and testable the way everything else here
is: pure state-machine tests for the protocol, and end-to-end tests driving
real browsers — including, since step 1, a third kind of page, which the
harness can open as many of as a class has phones.

## Settled

- **Anonymous.** Nobody types a name. The export is counts and a list of
  answers, and nothing anywhere ties one to a student.
- **No right answers.** A question is a question; results are a distribution,
  not a score. Marking a correct option is a later question, and one that
  only really makes sense alongside named responses.
- **The relay serves the pages**, so everything is one origin and students
  get one hostname. The poll routes send CORS headers anyway, because a
  display on GitHub Pages talking to its own relay is a configuration the
  README has always described.
- **One answer each, changeable until the question closes.** Keyed by a
  random id the phone keeps in `localStorage`. That stops a double tap
  counting twice and stops casual mischief; it does not stop a private
  window, and the docs should say so rather than implying a guarantee.
- **No saved poll *library* across lectures.** Composing a poll from scratch
  still starts from a blank form every time — Automated Sets are saved
  across sessions, a poll is not. What a plan *can* carry forward is the
  wording (see "Planning" above), and what a session itself remembers is
  what it already ran (see "History", next) — neither is a cross-lecture
  library of reusable polls, and that line is deliberate, not an oversight.
- **This-session history, not a library.** A poll `localStorage` remembers
  is scoped to the browser tab that ran it, capped at 20, and offered back
  only as Reopen (ask it again, fresh) or Redisplay (show the same final
  numbers again) — never edited into a new question. Wanting to *reuse* a
  question across different lectures is what the plan-file poll type is
  for instead.
- **One poll at a time, wherever it is staged.** A poll is a normal item —
  it can go on A, or on any of B/C/D — but the Polls tab only ever tracks
  and shows the single poll item it finds staged somewhere, not a list of
  several. Starting a second poll before ending the first is not offered,
  and Reopen/Redisplay from history are disabled rather than queued
  invisibly behind whatever is currently running.
- **Reveal gates the room, not the presenter.** See "Reveal is its own
  action, not a mode" above — the one place this document's original plan
  and what shipped genuinely diverged, corrected within the same round.

## Where it has got to

**All four original steps are done, plus three things the plan did not
originally call for:** live results on the controller (independent of
reveal), a this-session history with reopen and redisplay, and a poll type
in the planning page. A poll can be composed in the office or from scratch
in class, started from the controller, staged like anything else, answered
from real phones, watched arriving live and privately by the presenter,
moderated one answer at a time before anyone else sees it, revealed to or
hidden from the room independently of the presenter's own view, closed and
reopened, exported to a CSV (standalone or inside the session zip), ended —
invalidating the code on the relay the same moment it clears the screen —
and, afterward, asked again fresh or put back up exactly as it ended. None
of it goes near the room's own encrypted channel.

Measured rather than assumed, at the size this has to work at: **120 phones
each holding an event stream open, 120 answers counted in 65 ms**, on the
same ~200-line relay. Tallies came back exactly right. Scale is not the
constraint here.

Nothing from "What gets built" above remains unbuilt. What is left is the
word cloud (step 5), which stays deferred until the short-answer list this
already ships turns out to want one.
