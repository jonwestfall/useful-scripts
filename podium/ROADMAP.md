# Roadmap: audience participation

Students scan a QR code or open a short URL, enter the code on the projector,
and answer the question that is up — a multiple choice, or a short typed
answer. Nobody sees results, presenter included, until a separate explicit
Reveal. Results can be exported afterwards.

The old Socrative did roughly this. This document is how Podium will.

## What has been decided

| Question | Answer |
|---|---|
| Build it in, or point at an existing tool? | **Build it in** |
| Which relay? | **The self-hosted one** (`server/podium-server.js`) |
| How many answering at once? | **60–120** |
| What v1 does | **Multiple choice (A/B/C/D)** and **short typed answers, shown as a list** |
| Who sees results | Nobody, presenter included, until **Reveal** — one explicit action, always a separate step from closing voting (superseded the earlier live/on-close/never sketch below — see "Settled") |
| Afterwards | **Exportable** (a CSV button per poll); no saved poll library — see "Settled" |

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
  counts: [12, 3, 40, 1], answers: ['exposed', 'seen', …] }
```

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

## Reveal is its own action, not a mode

The original sketch above had `reveal` as a per-poll mode chosen up front
(`live` / `onClose` / `never`) with the presenter always seeing results
privately on the controller regardless. Asked directly, simplicity won:
**reveal is a single boolean, toggled by an explicit "Reveal results" /
"Hide results" button, the same for the presenter's own screen as for the
projector.** Nobody — presenter included — sees a tally before choosing to
reveal it, and closing voting never reveals anything by itself. This is
simpler to build and to explain than the three-mode version, at the cost of
the presenter not getting a private pre-reveal peek; if that turns out to be
wanted later, it is a controller-only change (show `#poll-running-results`
regardless of `revealed`, gated on `open === false` instead) and does not
touch the relay, the protocol command, or the projector.

That still buys the moderation the original mode-based design was reaching
for: anonymous free text lands nowhere visible until a person chooses to
show it, so v1 needs no profanity list and no approve-each-one queue to be
safe. A per-answer hide-before-reveal control (Step 3, still unbuilt) adds
back the one thing the mode-based design had that a flat reveal doesn't:
pulling one bad answer out before showing the rest.

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
live votes, **Close/Reopen voting**, **Reveal/Hide results**, **Export CSV**,
and **End poll** (a second-tap confirm, like other destructive buttons here).
The tab finds the one poll item wherever it is staged (`state.program`,
`state.preview`, or any of `state.panels`) rather than tracking it separately
— consistent with "one poll at a time" being a UX rule, not protocol state.

**Export** — a CSV download button per poll, built in step 2. Folding poll
results into the session zip `exportSession()` already builds (Photos tab)
is still open — see step 4 below.

## Order of work

1. ~~**Server endpoints + `join.html`, multiple choice only.**~~ **Done.** End
   to end, one question, votes landing in a tally, tested with a script
   posting 120 votes before any UI existed.
2. ~~**The `poll` item, renderer and Polls tab.**~~ **Done.** Composing,
   staging, watching votes arrive, closing, revealing and exporting, all
   driven from the controller and tested through the real UI, not just the
   relay directly.
3. **Short typed answers, and hide-an-answer.** The relay and `join.html`
   already carry typed answers end to end (step 1's tests cover this); the
   protocol/renderer/tab in step 2 render an `answers` list too. What's
   missing is moderation: a tap to drop one bad answer before revealing.
4. **Export**, into the existing session zip, alongside the per-poll CSV
   button step 2 already shipped.
5. Word cloud, if the list turns out to want it.

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
- **Fresh each time — no saved poll library.** Unlike Automated Sets, a poll
  is not saved for reuse across lectures; composing one starts from a blank
  form every time. Asked directly, this was the simpler v1 to build and to
  explain, and it is a controller-only addition later if wanted.
- **One poll at a time, wherever it is staged.** A poll is a normal item —
  it can go on A, or on any of B/C/D — but the Polls tab only ever tracks
  and shows the single poll item it finds staged somewhere, not a list of
  several. Starting a second poll before ending the first is not offered.
- **Reveal is a separate, explicit action** — see "Reveal is its own
  action, not a mode" above.

## Where it has got to

**Steps 1 and 2 are done.** A poll can be composed and started from the
controller, staged like anything else, answered from real phones, watched
live on both the projector and the controller, closed and reopened, revealed
or hidden, exported to a CSV, and ended — invalidating the code on the relay
at the same moment it clears the screen. None of it goes near the room's own
encrypted channel.

Measured rather than assumed, at the size this has to work at: **120 phones
each holding an event stream open, 120 answers counted in 65 ms**, on the
same ~200-line relay. Tallies came back exactly right. Scale is not the
constraint here.

Steps 3–4 (hide-an-answer moderation for typed answers, and folding poll
results into the session zip export) are still to build. Everything else
listed under "What gets built" above is in place.
