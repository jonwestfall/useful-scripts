# Roadmap: audience participation

Students scan a QR code or open a short URL, enter the code on the projector,
and answer the question that is up — a multiple choice, or a short typed
answer. The presenter decides whether the room sees the results live, only
once the question closes, or not at all. Results can be exported afterwards.

The old Socrative did roughly this. This document is how Podium will.

## What has been decided

| Question | Answer |
|---|---|
| Build it in, or point at an existing tool? | **Build it in** |
| Which relay? | **The self-hosted one** (`server/podium-server.js`) |
| How many answering at once? | **60–120** |
| What v1 does | **Multiple choice (A/B/C/D)** and **short typed answers, shown as a list** |
| Who sees results | Presenter always; the room only if the presenter says so — **live**, **on close**, or **never** |
| Afterwards | **Saved and exportable** |

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
photos and automated sets all understand. A poll should be an item in it,
exactly as an automated set became one:

```js
{ type: 'poll', pollId, code, kind: 'choice' | 'text',
  question: 'Which bias is this?', options: ['A…','B…','C…','D…'],
  open: true, reveal: 'live' | 'onClose' | 'never',
  counts: [12, 3, 40, 1], answers: [{ id, text, hidden }] }
```

Staged onto a panel the normal way. That buys, with no special-casing: it can
be cued behind a freeze and taken; it can live in panel B while slides stay
on A; it can be photographed; it survives a display reload like everything
else on screen.

The display owns it, the same as it owns a running set's clock: it is the one
fetching the tally and writing `counts`/`answers` into state, and every
controller renders from the broadcast echo.

## Reveal control is also the moderation

Anonymous free text on a classroom projector is the one genuinely risky part
of this feature, and the reveal control the user asked for happens to solve
it. With `reveal: 'never'` or `'onClose'`, the presenter reads the answers on
the iPad before the room sees anything — so v1 needs no profanity list and no
approve-each-one queue to be safe, just:

- results always visible on the controller, never automatically on the
  projector
- a tap to hide an individual answer before revealing
- `reveal: 'live'` clearly marked as the "I trust this room / this question"
  setting rather than the default

The default should be `onClose` for text and `live` for multiple choice.

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

**`protocol.js`** — the `poll` item type and the commands that drive it
(`open`, `close`, `reveal`, `hide an answer`), with the same validation
discipline as every other command.

**`renderers.js`** — `renderPoll`: the question, a QR to join, and the results
if `reveal` says so. The QR renderer already exists and can be reused as-is.

**`control.js`** — a Polls tab: write a question, pick how many options, start
it, watch answers arrive, close it, reveal it, export it.

**Export** — poll results join the zip `exportSession()` already builds
(Photos tab), as one CSV per poll, plus a per-poll download button for the
question you just ran.

## Order of work

1. **Server endpoints + `join.html`, multiple choice only.** End to end, one
   question, votes landing in a tally. Testable with a script posting 120
   votes before any UI exists.
2. **The `poll` item, renderer and Polls tab.** Multiple choice on the
   projector, with `reveal` honoured.
3. **Short typed answers.** Same pipeline, list rendering, hide-an-answer.
4. **Export**, into the existing session zip and as a single-poll download.
5. Word cloud, if the list turns out to want it.

Each step is shippable on its own and testable the way everything else here
is: pure state-machine tests for the protocol, and end-to-end tests driving
real browsers — including, for the first time, a third kind of page, which
the harness can open as many of as a class has phones.

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

## Where it has got to

**Step 1 is done** (the relay endpoints and `join.html`). A poll can be
created, asked, answered from real phones, changed, closed and read back,
and none of it goes near the room's own encrypted channel.

Measured rather than assumed, at the size this has to work at: **120 phones
each holding an event stream open, 120 answers counted in 65 ms**, on the
same ~200-line relay. Tallies came back exactly right. Scale is not the
constraint here.

Steps 2–4 (the `poll` item and renderer, the Polls tab, typed-answer
moderation, export) are still to build. Until step 2 lands there is no way
to start a poll from the iPad — the endpoints work, but only a script can
drive them.
