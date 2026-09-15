# Roadmap: audience participation

Not a feature spec — a plan for one. Written after the first real class session,
where the idea came up as something worth having eventually: students scan a QR
code or open a URL, enter a short code for that session, and either pick an answer
(A/B/C/D, True/False) or type a short word or phrase that joins a live word cloud
on the projector. The old Socrative did exactly this. This document is about
whether and how Podium should.

## Why this is a roadmap and not a pull request

Every feature shipped in Podium so far — decks, ink, sets, watermark, countdowns —
adds a new *thing the presenter's own devices do*. The presenter's iPad and the
classroom display already share the one secret that matters (the room passphrase),
so a new feature is just a new message shape riding a channel that already exists
between two trusted parties.

Audience participation is a different shape of problem: it means accepting input
from devices that were never handed that secret, are not the presenter's, and
outnumber the presenter's devices by a class size. That is a new trust boundary,
not a new message type, and it touches the one piece of Podium's design that has
been load-bearing since the start — see below.

## The actual obstacle: the passphrase is the whole lock

From `assets/js/crypto.js`: every message on the wire is AES-GCM encrypted with a
key derived from `(passphrase, room)` by PBKDF2. There is no separate notion of
"presenter" versus "controller" once a device has that key — anything that can
decrypt the room's traffic can also *compose and send* a command the display will
apply. That is deliberate and it is what today's whole security model rests on:
"know the passphrase" is the entire authorization check, and README already
frames it that way ("a controller with the wrong passphrase cannot touch the
screen" — implying one *with* it can, fully, no further distinction made).

Handing that same passphrase to a room of students so they can submit a poll
answer would also hand them freeze, blank, and every other command a controller
can send. That is not a hardening gap to patch later — it is disqualifying on its
own, and it means audience participation cannot simply be "one more message type"
on the existing encrypted channel. It needs its own, weaker credential: a
short-lived access code, scoped to *this session's poll only*, that proves nothing
more than "I was shown this code" — not the room passphrase, and not persisted
account-style identity.

## The second obstacle: the relay was not sized for a room full of phones

`server/podium-server.js` (the self-hosted relay option) caps a room at 12 peers
(`MAX_PER_ROOM`) and broadcasts every message to every other peer in the room —
fine for a presenter's iPad plus a couple of controllers, actively wrong for
twenty-five students in one WebSocket room: each one would both compete for a
slot under that cap and receive every other device's raw traffic (still opaque
without the key, but still real bandwidth and connection count on a relay meant
to be "~150 lines of Node," not a fan-out server). The managed options users can
choose instead — Supabase Realtime, a public MQTT broker — have their own limits
and cost models that were never evaluated against "a lecture hall's worth of
concurrent anonymous clients."

Whatever audience participation turns into, it is a separate channel from the
presenter/display one, and probably a separate *kind* of channel — not because
the crypto model needs to change for existing features, but because "many
short-lived, low-trust, high-fan-in connections" is a genuinely different traffic
shape than "two or three long-lived, high-trust, low-fan-in ones."

## What already exists at the research pass

A quick survey of the landscape, weighted toward self-hostable/open options since
that is the closest philosophical match to a tool that currently has no backend,
no accounts, and no analytics:

| Tool | Model | Fit |
|---|---|---|
| **Claper** | Open-source, self-hosted (Elixir/Phoenix + Postgres), Slido/Mentimeter-style polls, word clouds, Q&A | Closest feature match; a real app with its own database and accounts to run and maintain — a second service, not a library |
| **ARSnova / Particify** | Open-source, self-hosted, but a genuine microservice stack (CouchDB, PostgreSQL, RabbitMQ, nginx) | Feature-rich and mature, but heavier infrastructure than the entire rest of Podium combined |
| **Rahoot** | Open-source, self-hosted Kahoot-style quiz (needs its own Node/socket.io server) | Game-show format, not really "poll + word cloud"; another server to run |
| **Mentimeter / Slido / AhaSlides / Wooclap / Poll Everywhere** | Hosted SaaS, free tiers with real limits | Zero infrastructure to run, but data leaves the room entirely, usually needs an account, and free tiers cap responses/questions |

None of these are "drop a file into `content/`" simple. Every self-hosted option
is a second application with its own database, which cuts against the one line
that has held for every feature so far: Podium has no backend of its own. A SaaS
option keeps that true for Podium itself but trades away the "nothing leaves the
room, no account required" story that the rest of the app (and this audience,
presumably — a room of students) has been built around.

## Two paths, not mutually exclusive

**Integrate.** Point Podium at an existing tool instead of building one. This
already almost works today with zero new code: a `qr` Library item showing the
join URL/code for a free or self-hosted instance of one of the tools above, and a
`web` item on a spare B/C/D panel showing that tool's live-results view. This is
a real option to just *try* — pick one free
hosted tool, run a class with it, and find out whether audience participation is
something worth building for before committing engineering time to it. Costs
almost nothing to test and nothing to build.

**Build.** A native `poll` item type and a new, low-trust join surface —
something like `join.html`, a fourth static page alongside display/control/plan —
that a QR code or short URL opens. It shows only: enter this session's access
code, then whatever the presenter is currently asking (choices, or a text box).
Submissions flow back over a *separate* channel keyed by the access code, not the
room passphrase, and the display aggregates and renders results client-side —
no new backend, in keeping with everything else here, but a channel shaped for
many short-lived anonymous senders rather than a few trusted long-lived ones (see
above). This keeps Podium's actual selling points — no accounts, nothing stored
beyond the moment, works with a relay you can run yourself — but is real, scoped
work: a new page, a new join/auth story, a new transport shape, and a new
question of abuse-resistance (a poll with no accounts is one bad actor away from
either meaningless results or, for a word cloud shown live on a classroom
projector, something actively worth not showing a room of students without a
moment's delay).

## If building: suggested phase order

1. **Multiple-choice / true-false only.** Bounded answer set, simple tally, no
   free text — the lower-risk 80% of the value and, unlike a word cloud, nothing
   a presenter has to worry about moderating live.
2. **Word cloud.** Free text is the harder half: it needs at minimum a
   profanity/abuse filter, and probably a presenter-side hold-and-approve step or
   a fast "remove this word" affordance, since the failure mode (something
   inappropriate hitting the projector in front of a class) is a real one, not a
   theoretical one, and "the presenter can react fast" is not the same guarantee
   as "it never got shown."
3. **Everything else Socrative-style tools eventually grow** — question banks,
   result history, per-student scoring — deliberately out of scope unless
   phases 1–2 prove the feature earns its keep. Podium's whole design bias is
   toward doing less, reliably, over a real relay in a real room; this roadmap
   is deliberately the same size as the problem it is solving today; a poll and
   a word cloud, not a gradebook.

## Open questions for whoever picks this up

- Does this require the self-hosted relay (`server/`), or does it need to work
  over Supabase Realtime and a public MQTT broker too? Those have different
  capacity and abuse characteristics, and "works everywhere Podium currently
  works" may not be achievable for this specific feature.
- What does the access code actually protect against? It cannot be cryptographic
  proof of anything (it is shown on a projector to an entire room, by design) —
  its job is closer to "keep the last class's stale QR code from still working"
  and "keep it off the open internet by casual guessing," not real authentication.
- Do submissions ever touch disk, anywhere, even transiently? Every other piece
  of ephemeral room content in Podium (freeze, blank, cued preview) is
  deliberately *not* restored across a reload — audience responses should
  probably follow that same rule by default.

## Non-goals for now

This document exists so the four short-term fixes filed alongside it did not
have to also carry a half-built audience-participation feature. Nothing here is
scheduled. It is the answer to "what would it take," written down once so the
next session that picks it up is not starting from zero.
