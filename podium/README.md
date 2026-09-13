# 🎛️ Podium — drive the projector from your iPad

The classroom PC opens **one browser tab** and never gets touched again. Everything
that appears on the projector — slides, PDFs, video, YouTube, music, a QR code for the
class, a countdown, your handwriting, your phone's camera — is chosen from an iPad or
iPhone in your hand, from anywhere in the room.

It is three static pages. They run from GitHub Pages, from a VPS, or from a folder on
disk. There is no build step and no framework.

| Page | Runs on | What it is |
|---|---|---|
| `display.html` | the classroom PC | one fullscreen tab; renders what it is told |
| `control.html` | iPad, iPhone | the remote; several can be connected at once |
| `plan.html` | your office machine | build a lecture at your desk; carry it over as a file |
| `index.html` | anywhere | a landing page linking to the three above |

**New to this, or not especially technical?** [QUICKSTART.md](QUICKSTART.md) explains
the whole thing in plain English and walks through putting it online free on GitHub
Pages in about twenty minutes — no terminal, no server, no card. This file is the
full reference; that one is the road in.

## The idea worth knowing about: freeze is a cue

The display only ever changes when a controller tells it to. So "hold the screen" is
free — and it is more useful than a frozen frame.

Press **Freeze** and the projector holds exactly what it is showing. Everything you
pick from then on lands in the **cue** instead of going live: you can load the next
video and scrub it to 4:20, open the next PDF and find the right page, line up the
next slide — all visible on your iPad, none of it visible to the room. Press **TAKE**
and it cuts to the screen and unfreezes.

The cued item is not rebuilt when you take it. The display keeps two content layers
and simply swaps which one is visible, so a video keeps its playhead and a page keeps
its scroll position. This is how a video switcher works, and it is the difference
between cueing something and re-opening it in front of thirty people.

**TAKE / Swap / Clear cue**, precisely:

- **TAKE** puts the cued item on screen and unfreezes.
- **Swap** trades on-screen and cued without unfreezing, so you can peek at what is
  cued — or keep paging through it — without committing to it yet.
- **Clear cue** discards the cued item and leaves the screen exactly as it is.

Freeze also protects **paging within the deck that is already on screen**, not just
new picks. Press Next while frozen and nothing on the projector moves — Podium quietly
clones the on-screen slide into the cue and advances *that*, so you can flip ahead
through the same deck the class is looking at without them seeing a single slide
change. TAKE commits wherever you ended up; Clear cue abandons the detour. Background
audio and video are the one exception: **play / pause / seek always control what is
actually audible**, frozen or not — freeze only ever holds back what the room *sees*.

**Blank** is the separate panic button: instant black, program still loaded
underneath, one tap to bring it back.

## What it can put on screen

**Marp decks in Markdown**, with presenter notes on your iPad and your own themes —
see below. Plus: images · video files · audio (with a now-playing card) · YouTube
(play, pause, seek and volume, all driven from the iPad) · any embeddable web page ·
HTML slide decks including reveal.js · PDFs with page-turn buttons · big text cards ·
a QR code for the class to scan · countdown timers · a whiteboard · your phone's
camera as a document camera.

Two more that sit on top of anything: **ink**, so you can annotate live over a slide
with an Apple Pencil, and a **caption** along the bottom of the screen.

## Setup

### 1. Pick how the devices talk to each other

The pages are static, so messages need a relay. Three are built in; pick one.

**Supabase Realtime (recommended).** Free tier, reliable, nothing to run.
Create a project, then Project Settings → API for the URL and the anon/publishable
key. That is all — Podium uses *broadcast* channels, so there are no tables to create
and no RLS policies to write, and nothing is stored.

**Your own VPS.** ~150 lines of Node in `server/`. Nothing third-party in the path.

```bash
cd podium/server && npm install
PORT=8080 node podium-server.js
```

Put it behind TLS (Caddy: `podium.example.com { reverse_proxy localhost:8080 }`) and
point the pages at `wss://podium.example.com`. `podium.service` is a systemd unit;
set `STATIC=../` in it if you also want the box to serve the pages themselves.

**A free public MQTT broker.** Zero signup, good for trying it out in five minutes.
The default is `wss://broker.emqx.io:8084/mqtt`. Podium speaks MQTT 3.1.1, which every
broker supports. It is a public broker, which is fine here only because of the
encryption below — but prefer one of the other two for anything you do every week.

### 2. Publish the pages

Commit, then in the repo's Settings → Pages choose **Deploy from a branch**, `main`,
`/ (root)`. The pages land at:

```
https://<you>.github.io/useful-scripts/podium/display.html
https://<you>.github.io/useful-scripts/podium/control.html
```

It must be `https://` (or `localhost`): the encryption uses the Web Crypto API, which
browsers only expose in a secure context. GitHub Pages is https by default.

### 3. Set up the classroom PC once

Open `display.html`, fill in the connection settings, and click **Go live**.
That click is what grants the page fullscreen, sound and the wake lock — the
browser will not hand those to a page that did not ask for them inside a real
click. Settings are stored in that browser, so you do this once per machine.
Press `?` on that machine for the keys it understands; `E` is the one that
leaves fullscreen and puts the **Go live** screen back at the end of class.

Then bookmark it — or better, make a desktop shortcut that skips the browser chrome
entirely. No install, no admin rights:

```
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk https://<you>.github.io/useful-scripts/podium/display.html --edge-kiosk-type=fullscreen
```

### 4. Pair the iPad

On the display press **Pair a device** (or the `P` key). Scan the QR with the iPad.
It opens the controller already configured — the settings ride in the URL fragment,
which browsers never send to a server.

The code grants control of the projector, so it is behind a deliberate button press
on the classroom machine and hides itself after 90 seconds. Do not leave it up in
front of the room.

On the iPad, Share → **Add to Home Screen** gives you a real app: its own icon, no
Safari chrome, and a shell that is cached on the very first visit, so it opens
whether or not the classroom Wi-Fi is behaving. (When it opens without a network it
says so plainly — *could not open wss://…* — rather than looking broken. See
**reading the relay readout** below.) The display page installs the same way on the
classroom PC. Repeat the pairing for your iPhone; both stay in sync.

## Marp decks

Markdown decks are a first-class content type. The deck is rendered by the real
[`@marp-team/marp-core`](https://github.com/marp-team/marp-core), so front matter,
`_class` directives, layout helpers, tables, code and `$math$` all behave the way
they do when you export a PDF.

**Two ways to get a deck on screen:**

- **From the server.** Drop the `.md` in `content/decks/`, add it to
  `content/manifest.json` with `"type": "deck"`, and it appears as a tile. Both the
  display and your iPad fetch it directly, so nothing large crosses the air.
- **From your iPad.** *Open a Marp deck…* on the Library tab takes a file from
  Files, iCloud Drive, or anywhere the picker can reach. The markdown is encrypted
  and sent to the display, which caches it for the rest of the lecture. Uploads are
  capped at 120 KB of markdown — past that, put it in `content/decks/` instead.
  Images should be links, not base64 blobs.

```json
{ "group": "Week 1", "title": "Day 6 — Weighing the Evidence",
  "type": "deck", "src": "content/decks/day06-evidence-weighting.md" }
```

**Presenter notes** are any HTML comment that is not a Marp directive:

```markdown
## The slide the class sees

<!--
This lands on your iPad and nowhere else.
`<!-- _class: lead -->` is a directive, so it is not treated as a note.
-->
```

The **Slides** tab shows the notes for the slide that is up, what is coming next,
big Previous/Next buttons, and a thumbnail of every slide — tap one to jump
straight there. An external keyboard or a presentation clicker works too: arrows and
space page through anything with pages, and `B` to blank and `F` to freeze work on
*whatever* is up — a photo, a video, a whiteboard — not only on a deck.

Because the whole deck is rendered once into a shadow root, changing slide is
instant, and a deck cued behind a freeze keeps its place when you take it.

### Slides that are too full

Marp gives every slide the same fixed box — 1280x720 for a 16:9 deck — and
simply hides anything that does not fit in it. A slide with one paragraph too
many does not scroll and does not warn you: it loses its last bullets off the
bottom edge, and you find out standing in front of the class.

Podium shrinks that slide instead. Before a deck is shown anywhere, every slide
is measured once, and any that overflows gets its type scaled down — 5%, 15%,
whatever it takes — until the whole slide fits. A slide that already fits is
left exactly as its author wrote it, and a slide that would have to go below 55%
to fit is left at 55% rather than made unreadable.

It is the same number everywhere: the projector, the Now/Next boxes on your
iPad, the thumbnails, and the PNG export all shrink a slide by the same amount,
so what you rehearse is what the room sees. The Slides tab says so — *Slide 9 /
13 · fit 74%* — rather than leaving you wondering why the type looks small.

Shrinking never changes a slide's shape, only the size of what is on it, so ink
and the laser still land exactly where they were aimed.

To opt a slide out and keep it cropped the way Marp would crop it:

```markdown
---
<!-- _class: nofit -->
# This slide is cropped on purpose
```

### Progressive builds

Marp itself has no concept of a PowerPoint-style build — every `---` is one static
slide, shown all at once. Podium layers a convention on top: add one directive right
after the `---` that starts a slide,

```markdown
---
<!-- _class: build -->
## Three things to remember

* This bullet appears first.
* This one waits for the next click of Next.
* So does this one.
```

and every bullet on that slide arrives one Next at a time instead of all together.
Previous steps back through them the same way, and jumping to the slide from a
thumbnail (or from the export below) always shows it fully built, not bullet by
bullet. For anything that is not a plain bullet list, wrap exactly what should build
in raw HTML — `<p class="build">…</p>`, `<div class="build">…</div>` — and Podium
builds those, in order, instead of auto-numbering `<li>`s. `example-builds.md` in
the library demonstrates both.

### The Slides tab: Now, Next, Markup, Laser

Alongside the notes and the Previous/Next buttons, the Slides tab shows a small
**confidence monitor**: a live "Now" box (exactly what the projector shows, build
step included) and a "Next" box (the slide coming up, always shown fully built —
you are looking ahead, not rehearsing its reveal). "End of deck" replaces Next on
the last slide.

Two things live on the Now box:

- **✎ Markup** jumps to the Ink tab, already lined up on the slide you are looking
  at — no separate step to pick the right surface.
- **Laser** turns the Now box itself into a pointer. Drag on it and a dot follows
  your finger on the real screen, mapped onto the slide's own bounds the same way
  ink is; lift your finger and it is gone. Nothing about it is saved or undoable —
  it is a live gesture, not a mark on the slide.

  Three colours sit next to the button. **Red** is what everyone expects and what
  you get by default; **green** is the one that survives a dark slide or a
  photograph, where red sinks into the picture; **blue** reads on a bright one. The
  button itself wears the colour, so you can see what the class is about to see
  without pressing it first, and the choice is remembered on that device — whoever
  needs green today needs it for the rest of the term.

### Themes

Put your CSS in `marp-themes/` and list the filename in `marp-themes/themes.json`.
A deck selects it by the name in the file's own `/* @theme name */` header, not by
its filename:

```css
/* @theme psy415-dsu */
@import "gaia";
section { ... }
```

```yaml
---
marp: true
theme: psy415-dsu
---
```

Marp's built-in themes (`default`, `gaia`, `uncover`) are always available and can
be `@import`-ed from your own. A deck that names a theme you have not installed
falls back to the default — the Slides tab says so rather than leaving you
wondering why the colours are wrong.

`psy415-dsu.css` ships as a working example.

### What is and is not supported

- **Math** renders through KaTeX. `math: mathjax` is not bundled and will error.
- **Code highlighting** covers about forty languages (R, Python, Stata, SQL, and
  the usual suspects). Anything else renders as plain code. The list is in
  `vendor-build/build-marp.mjs`.
- **Raw HTML is allowed as layout** — `<div class="columns">` and friends work —
  but tags and attributes are filtered, so a deck from elsewhere cannot run a
  script on the classroom PC.
- The Marp renderer is **vendored** at `assets/vendor/marp.esm.js` (~1 MB, fetched
  once, only when you first open a deck) rather than pulled from a CDN, so decks
  keep working when the network does not. See `vendor-build/` to rebuild it.
- KaTeX's glyph fonts are the one thing still fetched from a CDN. Math renders
  without them, just in a fallback face.

## Annotating with ink

Ink is scoped to whatever is actually on screen — a whiteboard, or one specific slide
of a deck — not to the whole session. Draw on slide 4, flip to slide 5, and slide 4's
strokes are waiting for you when you flip back; **Clear** only wipes the one surface
you are currently looking at. Switching to unrelated content (a timer, a message)
shows a blank sheet rather than carrying old drawings onto it. The display saves ink
to that browser as you go, so it survives an accidental reload mid-lecture.

The pad on the Ink tab is shaped to match the content exactly — a deck slide's own
aspect ratio, or the display's window shape for a full-bleed whiteboard — so the
whole pad **is** the drawable area, edge to edge. There is no dead margin around it
to draw into by mistake, whatever shape the classroom PC's window happens to be. It
also shows a live mirror of what is actually on screen *behind* your strokes, so you
can see what you are marking up rather than drawing blind on a black square —
**Showing slide** / **Slide hidden** at the bottom of the pad toggles it off if it is
ever distracting. **Zoom** and the pan arrows next to it are a pure magnifier for a
steadier line; they never change where a stroke actually lands.

**Clear is one tap, and undoable.** Wiping the board is a frequent, deliberate move —
finish one problem, start the next — so putting a confirmation in front of it would tax
the common case to guard against the rare one. Instead the display keeps what it wiped
and the controller offers **Undo clear** for fifteen seconds. Nothing crosses the
network to put it back: the display restores its own copy.

**Export marked-up slides** (Slides tab, while a deck is on screen) rasterizes every
slide with its own ink baked in and downloads a `.zip` — `slide-01.png`,
`slide-02.png`, … plus a `slides.txt` listing titles and which slides carry
annotations. It is best-effort: a slide that depends on a font or image the browser
refuses to bake into a canvas is skipped individually (noted in `slides.txt`) rather
than failing the whole export.

### What ink costs to move, and why that mattered

A stroke is a list of points, and a point used to cross the wire at full float
precision — `0.5488135039273248`, eighteen characters to place a dot on a projector.
They are now rounded to four decimals: one ten-thousandth of the screen, 0.19px on a
1920px projector, well under the width of the thinnest pen, and **60% smaller**.

That was not a micro-optimisation. The state heartbeat used to carry every stroke on
the current surface, in full, every two seconds — and every 400ms while anything was
playing. A hundred strokes of sixty points is 243 KB of JSON, and two separate
ceilings sat above that:

- **Encryption overflowed the call stack** somewhere past 100 KB, because base64
  encoding spread every byte of the message as a function argument. Past the limit,
  `send()` threw and the message simply never went — with nothing on screen to say
  why. That ceiling sat under *every* large message, so an uploaded deck (capped at
  120 KB) and a lecture plan's photo (160 KB) were already at or over it.
- **The relay closes a socket** that sends more than 256 KB, with code 1009. The
  transport then reconnects, the next heartbeat closes it again, and a whiteboard
  with a term's annotation on it took the projector off the air in a loop.

Both are fixed, and the heartbeat now carries a *summary* of the current surface —
how many strokes, and how many points in the finished ones — rather than the strokes
themselves. A controller whose own copy does not match asks for the surface and gets
it in slices small enough for any transport. It rarely needs to: it applies its own
strokes as it draws them, and it now follows its peers' strokes straight off the bus,
so a second iPad draws **live** rather than up to two seconds behind. It asks only
when it has genuinely fallen behind — joining mid-lecture, opening a surface it has
never seen, or a dropped message.

The summary deliberately ignores the last stroke's point count. While someone is
drawing, that count is legitimately different on every device, because batches are in
flight; counting it would mean re-fetching the whole surface on every frame of every
gesture.

One stroke is also capped now, at 3000 points. The stroke *count* was always bounded;
the points inside one were not, so a pen left down — or a pointer that never lifted
because a tab was backgrounded mid-gesture — could grow a single stroke without limit.

**Rotating the iPad mid-stroke does not warp the line.** Every point in a stroke is a
fraction (0–1) of the pad's own box at the instant it was captured. If that box
changed shape *during* the gesture — an iPad rotation crosses the controller's
narrow/wide layout breakpoint, moving the preview rail from above the pad to beside
it — points from before and after the change would be fractions of two different
boxes, and redrawing them all at one final size would stretch the stroke. The pad
defers resizing itself until the stroke actually ends, then catches up; the same
timing gap explained a slide-projector mismatch reported early on, since the fraction
math itself was always correct once box and content stayed in step. The display side
has a matching guard: entering fullscreen (see **One click to start** below) can
resize the window a beat after the click itself resolves, so the display also
recomputes its content box on `fullscreenchange`, not only on `resize`.

**Drawing right after picking a deck lands where you drew it, even on the very first
slide.** A deck's real shape (its own aspect ratio) is only known once Marp has
actually parsed it — genuinely slow for a real lecture deck's theme and fonts,
unlike the tiny bundled demo — and until then, nothing should guess at it:

- **Picking a deck is asynchronous from the very first tap.** A tile's click handler
  can't be awaited by the tap that fired it, so switching straight to the Ink tab
  used to be able to race a pick that had not even sent anything to the display yet.
  Picking now marks that a deck is on its way the instant the tap lands, before any
  of the loading it does.
- The **controller's pad** used to size itself off the *display's own window shape*
  while a second, redundant parse of the deck it had just picked was still running in
  the background — over a second, for a deck with a real theme's fonts. Picking now
  reuses the parse it already did to stage the deck, so the pad knows the real shape
  immediately rather than racing a second one.
- The **display** draws ink through the same "what shape is this slide" math it uses
  to letterbox the slide itself, which needs that deck's own parse to finish too. A
  stroke applied in the brief window before it does used to stay wrong for the rest
  of that item's time on screen — nothing re-drew ink just because the deck caught
  up a moment later. The deck renderer now tells the display to redo it the instant
  its real shape becomes known.

Between picking and the real shape being known, the pad simply will not draw (it
dims and ignores touches) rather than guess — normally invisible, since a real hand
takes longer to reach the pad than the deck takes to load.

**The ink layer covers the screen, on any pixel density.** A `<canvas>` is a
*replaced* element, like an `<img>` — so an absolutely positioned one with no stated
width takes its **intrinsic** width (its `width` attribute, read as CSS pixels)
rather than stretching to `left:0; right:0`. That attribute holds the backing store,
which is sized in *device* pixels, so on a 2× screen the element gets laid out at
twice the window, anchored top-left, and you see the top-left quarter of it: ink at
double size, drifting further off the further from the corner you draw. `#ink` states
`width:100%; height:100%` explicitly for that reason — those are not redundant next
to `inset: 0`, and leaving them off is a real bug rather than a tidiness question.

**Moving the display window between screens does not throw the ink off.** A laptop
screen and a projector rarely share a pixel density, and the ink layer is a canvas
sized in *device* pixels — so a window dragged from a 2× laptop display onto a 1×
projector needs that canvas rebuilt. The catch is that this particular change fires
no `resize` event at all: the window is the same size, so nothing tells the page
anything happened, and a canvas still scaled for the old screen paints every stroke
at double the distance from the corner — marks nowhere near the slide they were drawn
over. Podium re-checks that the canvas still matches the screen immediately before
every redraw, rather than trusting that it was told, so a missed notification costs
one frame instead of the rest of the lecture. (It also listens for the density change
directly, so the correction usually lands before you draw at all.)

## Getting back to where you were

Two things a lecture does constantly, which the app used to be bad at.

**A student asks something, you put up a photo, you go back.** Picking the deck out
of the Library stages it from slide 1 — so that detour used to restart the lecture in
front of everyone. The Library now leads with a **Back to** strip: the last few things
that were on the projector, each at the position you left it (*Weighing the Evidence ·
slide 5 of 13*, *Reaction clip · 4:12*). One tap returns to exactly that. Whatever is
on screen is never offered, and the position comes from the display's own state, so it
is where the class actually got to rather than where you last tapped.

**The classroom PC reloads.** A stray refresh, a browser reclaiming the tab, a machine
waking up — and the display, which holds the only authoritative copy of the lecture,
used to come back to black with every panel empty. No controller could help; they
mirror that screen, they do not hold it. It now saves what is on screen as it goes and
offers it back: the arming screen reads *Picking up where this screen left off —
Weighing the Evidence*, with **Start black instead** if you would rather not. A running
countdown comes back still counting, because its end is an absolute moment rather than
a duration. Anything older than twelve hours is ignored, so yesterday's lecture does
not reappear this morning.

Deliberately *not* restored: freeze, blank, and the cued preview. Those are "what I am
doing this second", and coming back into a held or blacked-out screen with no memory of
why is worse than coming back to the content.

The save is debounced, which leaves the obvious window — the last thing you did is
exactly what a debounce has not written yet — so it is also flushed when the tab is
hidden, closed or reloaded. Only a hard crash loses anything, and then at most a second.

## Splitting the screen

The layout picker lives in the topbar (five small icons, next to Settings): **full
screen**, **side by side**, **top and bottom**, **one large + two small**, and **four
panels**. Picking anything but full screen adds a row of panel buttons — **A**,
**B**, **C**, and however many more the layout has — right next to it.

Whichever panel is lit up is what the rest of the app currently talks to: Library
taps stage content into it, Previous/Next and thumbnails page it, transport controls
play/pause/scrub it, and the Ink tab draws on it. Switch panels the same way you
would switch tabs — tap **A**, **B**, **C**, or **D** — and everything else follows.

Panel **A** is exactly what Podium has always been: TAKE, freeze, cue, Swap all
still work on it precisely as before, just confined to its own region of the screen
once a layout splits it. **B**, **C**, and **D** are deliberately simpler and have
none of that. Picking content into one is immediate — on screen the instant you tap
it, even while frozen — because there is no moment to protect: unlike A, a split
panel was never going to change in front of the class without you choosing to change
it right then. Think of A as "what I am presenting" and B/C/D as "what's also up" —
a countdown for group work, a slide of instructions, a photo — set once and left
alone rather than cued and revealed.

This is for laying a screen out, not for a fast during-class reveal: project your
slides, split to add a countdown and an instruction panel for group work, then drop
back to full screen when the group work ends. The class sees each change the moment
you make it, on whichever panel you made it to.

A few limits worth knowing: the room's sound always follows panel A, even when a
video or audio clip ends up in B/C/D — two panels both making noise at once would
just be noise, and there is no cue step on those to decide which one meant to be
heard. **Export marked-up slides** (Slides tab) only ever exports whichever deck the
focused panel is currently showing.

## Countdowns

A class runs more than one clock. Eight minutes of group work sit inside a
ninety-minute session; a five-minute break has its own end; the quiz has a limit
that is not either of those. So the Timer tab holds **up to four independent
countdowns**.

The chips along the top are the set, each showing its own clock, so you can see all
of them at a glance without switching anything. Tapping one selects it; everything
below — the big readout, the presets, Start/Pause/Stop — drives that one. **Add a
timer** makes another (up to four); **Remove this timer** takes one away. The first
one cannot be removed, because it is what anything that does not name a clock falls
back to — including the plain **Timer** tile in the Library, and any countdown made
before there was more than one.

**Put this one on screen** projects the selected countdown. It carries that clock's
identity, not just its label, which is what lets a split screen show two different
countdowns at once: put one up, switch panels, select the other, put that up. They
tick independently, and each keeps its own ink surface, so marking up one does not
scrawl on the other.

Countdowns run on the *display*, not the iPad, so they stay accurate even if the
tablet sleeps or you close the controller and reopen it.

A lecture plan defines the set: its saved timers become the four clocks, with their
names and lengths, and a plan's countdown items say which one they show. See below.

## Planning a lecture in your office

`plan.html` is the third page, and the only one you use when there is no class in
front of you. The controller is built for one-handed use at a lectern — big targets,
nothing destructive within easy reach, no typing — which makes it a poor place to
*build* a lecture. So planning lives on its own page: type, upload, drag things into
order, and check each one against the projector's own renderer before anyone sees it.

The workflow it is for:

1. **In your office**, open **Planning**. Build the running order: upload the deck,
   add the photo, write the "Back in 5" sign, save the countdown you always forget to
   set, write yourself a note on the item you always forget to mention.
2. **Save a plan file.** One JSON file, self-contained.
3. **Get it to the iPad** — AirDrop, iCloud Drive, email it to yourself.
4. **Before class**, in the controller: **Library → Load a lecture plan…**. The
   running order appears at the top of the Library, numbered, in order, with your
   notes on the tiles and your timers on the Timer tab.

Nothing else about the controller changes. It is still the same tabs, the same
freeze-and-take, the same everything — the plan only decides what is *in* it.

### Why a file, and not a login

The Saved library has always lived in `localStorage`, which never leaves the device
that wrote it: a lecture built on a desktop would be invisible on the tablet you
actually teach from. Syncing it would mean a server, an account and a password —
three things Podium deliberately does not have, on a set of pages you can host by
copying a folder.

So a plan is a file, and it is **self-contained**: an uploaded deck travels as its
markdown, an uploaded photo as a data URL. Nothing in a plan points at a file that
has to be deployed before the plan will work, which is what makes "AirDrop it and
open it" the whole of step 3. Everything is reconstructed on load: an uploaded deck
is registered under the hash of its markdown, exactly as a deck you dropped on the
iPad would be, so the projector asks for it over the encrypted bus the same way.

Two consequences worth knowing:

- **Photos are resized on the way in.** Every relay caps a message — the self-hosted
  one at 256 KB, and the envelope is the JSON encrypted and then base64'd, so it
  lands about a third larger than it went in. A phone photo is 3–6 MB and the
  projector is 1920×1080, so a photo is re-encoded down a ladder of sizes and
  qualities until it fits (about 120 KB). What you approve in the office is then
  exactly what the class sees. For anything bigger — a video especially — put the
  file on your server and give the plan a path instead.
- **An item carries a reference, not the bytes.** `asset:a1b2c3`, resolved only at
  the point of handing the item to a renderer. The item itself lives in the state the
  projector rebroadcasts twice a second, and is what ink surfaces are keyed by; a
  data URL inline would bloat every heartbeat and every saved stroke.

### The rest of what the page does

- **Lectures** are stored in IndexedDB on that machine, not `localStorage` — a plan
  carries photos, and losing an hour of prep to a full 5 MB string bucket is not a
  trade worth offering. Autosaved on a debounce; the header says which of saving,
  saved, or *not* saved it is.
- **Drag to reorder**, or use the ↑/↓ buttons, which is what a keyboard and a
  touchscreen get.
- **The preview is the real thing.** Same renderer files the projector runs, in a
  16:9 box. If a web page refuses to be framed, or a theme fails to load, it fails
  here — in your office, with time to fix it.
- **A plan sets the starting screen layout**, so a lecture that wants slides beside a
  countdown opens that way. Applied when you deliberately load the plan, never when
  the tablet merely wakes up and restores it.
- **Timers you save become the lecture's countdowns** — up to four, named and
  pre-loaded, replacing the iPad's 1/2/5/10/15 buttons with labelled ones (*Group
  work · 8m*). A **Countdown** item in the running order then says *which* of them
  to project, rather than carrying a length of its own; that is what lets a split
  screen show two of your clocks side by side. Adding the first countdown creates a
  timer to go with it, so the item is never inert.
- **Opening a plan file** on this page loads it for editing, which is how you move a
  lecture between machines or start next week from last week's.

A plan is a file that arrived from somewhere else, so loading one rebuilds it field
by field rather than trusting it: fields belonging to some other type are dropped,
out-of-range values fall back to their defaults, an item pointing at a file the plan
does not carry is named rather than left to fail on the wall, and a `src` with a
scheme that is not `http` or `https` is stripped — `javascript:` has no business
reaching a screen nobody is standing in front of. A plan from a *newer* build refuses
outright rather than silently dropping what it does not understand. A plan with three
bad rows and forty good ones loads the forty and tells you what it dropped: it is ten
minutes before class.

### It has no password of its own

The page assumes whatever you already put in front of the site — HTTP basic auth in
nginx, say — is the thing protecting it. It holds no credentials and makes no
security claim: anything stored on that machine is readable by anyone who can open
that browser, and a plan file is plain JSON. Put it behind the same auth as the rest
of Podium and treat the file like any other lecture prep.

## Your lecture library

Edit `content/manifest.json`, commit, and the tiles appear on the iPad. Files you put
under `podium/content/` are served alongside the pages.

```json
{ "group": "Week 1", "title": "Lecture deck", "type": "slides",
  "src": "content/slides/week1/index.html" }
```

Types: `image` `video` `audio` `youtube` `web` `slides` `pdf` `text` `qr` `timer`
`whiteboard` `camera` `black`. You can also paste any link straight into the
controller — it works out what it is — and tick **Save** to keep it.

Large videos do not belong in a git repo. Host them on the VPS, or use an unlisted
YouTube link.

The manifest ships with two groups: **Working examples** actually play, right now,
with files already in this repo — including a synthesized "Waiting music" loop, so
you can see what a real entry looks like before writing your own. **Template — point
these at your files** shows the format for content that has to be yours (a PDF, a
photo, a video); those `src` paths do not exist yet, and picking one shows an error
until you replace it or delete the entry — that is expected, not a bug.

### Audio and waiting music

Two ways to get a sound file onto the projector, same pattern as everything else:

- **Paste its URL** into the Library tab, if it is already hosted somewhere (your
  course site, Dropbox, anywhere reachable). No manifest edit, no upload — the
  fastest path for something you only need once.
- **Drop it in `content/audio/`** and add one line to `content/manifest.json` for a
  permanent tile, the same way a deck goes in `content/decks/`:

  ```json
  { "group": "Between classes", "title": "Waiting music",
    "type": "audio", "src": "content/audio/your-file.mp3", "loop": true }
  ```

mp3, wav, ogg, m4a and flac all work. There is no third path — a file picked
straight from your iPad's Files app cannot be shipped to the classroom PC the way a
markdown deck can: decks are a few kilobytes and travel fine as text over the same
encrypted channel as everything else, but even a short mp3 is megabytes, past what a
public MQTT broker or most transports will pass through as a single message. Audio
needs to be reachable by URL for the display to fetch it directly.

## What to expect in a real room

**One click to start.** Browsers block sound until someone interacts with the page,
so the display opens on a **Go live** button. That single click also takes it
fullscreen and requests a wake lock so the screen never sleeps mid-lecture. The
display joins the room as soon as the page loads, though — so your iPad can see it
sitting there waiting for that click, rather than the room looking empty.

Autoplay is actually two separate locks, and unlocking one does not unlock the
other: the Web Audio API (used to keep timing steady) has its own gate, and every
plain `<audio>`/`<video>` element — Waiting Music, videos, YouTube — has a second,
independent one that Safari enforces strictly. The Go Live click plays and
immediately pauses a real (silent) audio element synchronously inside the click to
satisfy that second gate, since resuming an AudioContext alone does nothing for it.
If some engine still refuses even that — an unusual browser policy, or the click
landing before the page finished wiring up — Podium does not just give up: the very
next tap or key press anywhere on the display retries the blocked clip once, so a
stuck Waiting Music tile clears itself rather than requiring you to find the "leave
and re-enter fullscreen" workaround.

**Some sites refuse to be embedded.** `X-Frame-Options` and CSP mean many news sites,
most LMSes and Google Docs will show a blank frame — the display says so rather than
leaving you guessing. Anything you host yourself, YouTube's embed, and most slide
decks are fine.

**Slide decks.** A deck served from the same origin is driven directly, including
`Reveal.next()`. A reveal.js deck elsewhere responds if it was built with the
postMessage API enabled. Anything else gets a synthetic arrow key it may ignore — in
that case, put the deck in `content/` and drive it properly.

**PDF page turns reload the frame.** The browser's built-in viewer only reads
`#page=` when it loads. It comes from cache, so it is quick, but it is a reload.

**The camera needs the two devices to reach each other.** WebRTC with STUN and no
TURN server. On a normal campus network this connects; on a guest network with client
isolation it will not — both ends now time out after 15 seconds rather than sitting
on "Connecting…" forever, and say plainly that the two devices could not reach each
other. Either the **Phone camera** tile in the library or the Camera tab's own button
starts it; both ask for the camera and open the connection the same way. **Freeze**
pauses the live feed on its current frame — there is no timeline to hold otherwise,
so this is what "freeze" means for a camera — and a small **Frozen** badge says so on
the projector; unfreezing (or taking a cue) simply resumes showing whatever is live
by then.

**You cannot mirror the iPad's screen.** iOS Safari has no screen-capture API, so no
web app can do this. The camera feed and the content library are the way around it —
and with a cue you rarely want mirroring anyway.

## Starting a device over

Settings are saved per device, which is what makes the classroom PC a one-time
setup — but it also means a device can be carrying a room you have forgotten
about. **Clear settings & reload** at the bottom of the Settings sheet, on both
pages, puts that device back to a stock, never-configured Podium: the room, the
passphrase, saved links and decks, any service worker or cache Podium left
behind. It takes two taps, and it only affects the device you press it on.

It is deliberately surgical rather than a blanket wipe. On GitHub Pages every
project on your site shares one origin, so clearing everything would take your
other apps' saved data with it. Podium removes only its own `podium.*` keys and
only cookies scoped to this folder.

If a page seems to be running old code rather than old settings, that is the
browser's HTTP cache, not Podium's storage — a hard reload (Ctrl/Cmd+Shift+R)
is the fix.

### The display's own keyboard

The display normally runs fullscreen with no browser chrome, and the standby
screen disappears as soon as a controller connects, so these keys — pressed on
the classroom machine itself — are the way back in mid-lecture. `?` is the only
one worth remembering, because it shows you the rest:

| Key | What it does |
| :-- | :-- |
| `?` | Show or hide the shortcut card |
| `F` | Go fullscreen, or leave it |
| `E` | Leave fullscreen and go back to the **Go live** screen |
| `P` | Show or hide the pairing QR |
| `S` | Open Settings |
| `Esc` | Close whatever is open |

`E` is the end-of-class key: it drops out of fullscreen and puts the arming
screen back up with the lecture still loaded behind it, so **Go live** picks up
exactly where you were. The controller sees it too, and says *"Display open —
click Go live on it"* rather than reporting the screen as missing.

None of these fire while you are typing in Settings, so a room called
`seminar-f` is just a room name.

## When the controller says the display isn't there

The top bar reports two separate things, and it is worth reading them as two:

- **Relay OK** — this device reached Supabase / the broker / your server. It says
  nothing about the display.
- **Display connected** — a display in the same room, speaking the same passphrase,
  is publishing. This is the one that matters.

If you see *Relay OK* and *No display connected*, a banner appears after a few
seconds with the likely causes. In order of how often they are the answer:

1. **The display is open but nobody clicked Go live.** The controller now says
   "Display open — click Go live on it" rather than pretending it is absent, and the
   display's own screen says whether it has reached the relay.
2. **The room or passphrase differs.** Both ends show the same four-character code
   when they match — on the display's standby screen and arming screen, and in the
   controller's top bar. Different codes mean they will never hear each other. The
   fix is to press **Pair a device** on the display and scan again.
3. **Different transports.** A display on Supabase and a controller on MQTT both
   report a healthy relay and never exchange a byte.
4. **A device carrying stale settings from an earlier experiment.** *Clear settings
   & reload* on that device and pair it again.

If the codes match and you still see nothing, the controller will say
**Wrong passphrase somewhere** — that means encrypted traffic is arriving that it
cannot read, which is a mismatch rather than an absence.

### When nothing connects at all: reading the relay readout

A relay that will not come up is a different problem from a display that has not
joined, and it used to be reported in four words — *Lost the relay — retrying* —
which name no URL, no error and no attempt count. There is nothing to act on in
that sentence, and the retry loop overwrites the first attempt (the informative
one) with the twentieth.

Both pages now state, in plain text, **what they are dialling** and **what
happened when they last tried**:

- The display's arming screen, and its Settings, show the transport, the URL and
  the room: `Self-hosted WebSocket · wss://vps.example/podium · room phi101`.
  Worth reading even when things work — a good share of "it won't connect" is two
  devices pointed at different relays, or a URL saved with a typo months ago.
- Below it, a short timestamped log of every transition, with repeats collapsed
  into a count. The controller shows the same thing in a red banner and in its own
  Settings.

What the messages distinguish, because each sends you somewhere different:

- **`could not open wss://… (code 1006)`** — the socket never opened. The browser
  will not tell a page which of these it was, so the message lists them: the relay
  is not running, the port is closed to this network, or — the one that catches
  people with a relay on their own machine — **its TLS certificate is not trusted
  by this browser**, which refuses the handshake silently. Open the same host as
  `https://` in a tab once, accept the certificate, and reload.
- **`dropped (code 1006), attempt 4`** — it *was* connected and lost it. That is
  Wi-Fi or the relay restarting, and it recovers on its own.
- **`never connected to wss://broker…`** — the broker refused. Public brokers move
  their WebSocket port and path around, and a wrong one looks exactly like a dead
  network. `wss://broker.emqx.io:8084/mqtt` is the shape that works.
- **`"my-vps.example/podium" is not a URL`**, **`must start with wss://`**, and
  **`a browser can only speak MQTT over a WebSocket`** — caught before any socket
  is attempted. `mqtt://host:1883` from a broker's own documentation is the single
  most common way this ends up silently dead; a browser cannot dial it.
- **`This page is served over https://, so the browser blocks a plain ws:// relay`**
  — mixed content, refused at a layer the page cannot see into.
- **`Could not load the MQTT client from cdn.jsdelivr.net`** — the transport's
  client library is fetched from a CDN, and a locked-down campus network blocking
  it is not something the app can route around. The self-hosted WebSocket
  transport needs no CDN at all, which is the fix.

Two of those categories used to be worse than unhelpful. They reject *before* any
socket exists, and both pages use top-level `await`: an unhandled rejection there
aborts the rest of the module, so the display never rendered and the controller
never loaded its library. A one-line configuration mistake presented as a hung
page. Both now catch it, say what happened, and come up anyway — the controller is
fully usable offline, so fixing the URL in Settings is all that is left to do.

A stale build also no longer reports itself on the relay's channel, where it read
as `Cannot reach the relay: Running build 3…` — a claim about the network, made at
exactly the moment someone is trying to debug the network. Version news has its own
line.

### Builds, and telling when a device is running an old one

The display and the controller are separate devices, each loading its own copy of
Podium from wherever you serve it — so they can disagree about what version they
are. A projector tab open since before you deployed, or a browser that never
revalidated the page, keeps running the old code indefinitely. That does not
announce itself; it just misbehaves, in ways that look for all the world like fresh
bugs. (Ink landing in the wrong place was one, and it cost two rounds of hunting.)

Every release bumps an integer build number, and three things check it:

- **The controller's top bar** reads `Display connected · 214 ms · build 7`. That is
  the number to compare.
- **The display's Settings**, under *Clear settings & reload*, states its own build.
  If those two numbers differ, the lower one is stale and needs reloading — and the
  controller says so outright rather than leaving you to notice: *"Display is on
  build 5, this is build 7 — reload the display."* It names which end is behind,
  including when the device in your hand is the old one.
- **Each page checks itself on load**, re-reading its own code from the server with
  caching bypassed. If what it is running is older than what the server is handing
  out, it came from a cache — the controller shows a banner with a **Reload now**
  button that bypasses the cache, rather than leaving you to reload a page the cache
  will simply answer for again.

One caveat worth stating plainly: silence only means agreement once *both* ends are
new enough to have this. A device older than the check itself reports no build at
all — which is why "no build reported" is treated as the oldest answer there is, not
as nothing to report.

Serving Podium yourself? Send `Cache-Control: no-cache` for the HTML and JS (the
bundled relay in `server/` already does). Long cache lifetimes on `display.js` are
what turn a deploy into a mystery.

## Security

Every message is encrypted in the browser with AES-GCM, under a key derived from the
room passphrase with PBKDF2. The relay — Supabase, a public broker, your own server —
only ever moves ciphertext, and a device with the wrong passphrase is ignored rather
than trusted. The display warns you when something is talking to it that it cannot
read.

Both ends show a four-character code derived from the room and passphrase. Same code
on both screens means they can actually talk to each other.

Keep the passphrase out of a public repo. `config.json` is a convenient place for the
Supabase URL and anon key (both are designed to be public); let each device carry the
passphrase, which the pairing QR handles for you.

## Tests

```bash
node podium/test/protocol.test.mjs          # the state machine, no browser needed
node podium/test/plan.test.mjs              # the lecture-plan document, likewise
cd podium/server && npm install             # once
node podium/test/e2e.mjs                    # needs: npm i playwright
```

The end-to-end test starts the relay, drives a display and two controllers in real
browsers, and checks the things that would embarrass you in front of a class:
a board with three hundred strokes on it keeps the projector on the relay rather than
being closed off it, an interrupted lecture comes back to the slide it was on and a
reloaded display does too, the controller opens with no network at all, freeze
really holds even while paging through the deck already on screen (and never touches
playing audio, and pauses a live camera on its current frame rather than pretending
it can hold a still one), TAKE does not reload the cued item, ink lands inside a
letterboxed slide's own bounds and never on unrelated content, the Ink tab actually
shows what you are drawing on, a build's bullets arrive one at a time, the Now/Next
confidence boxes stay correctly sized even switching tabs cold, a dragged laser
pointer tracks, vanishes on release and really is the colour you picked, two
countdowns run independently and can be projected side by side, the phone-camera tile actually opens the
connection (Chromium's synthetic camera, no real hardware or permission prompt
needed), export produces a real, valid-PNG-containing zip, waiting music actually
plays, a countdown ticks on the display, a dead relay explains which URL it could
not open (and neither page dies at its top-level `await` when the failure happens
before a socket exists), a lecture planned in the office reaches the projector intact
— photo and slides that exist nowhere on the server included — after a round trip
through a plan file and a second device, and a controller with the wrong passphrase
cannot touch the screen. 234 checks.

## Layout

```
podium/
  display.html  control.html  plan.html  index.html
  sw.js                           offline shell (network-first; see the file)
  manifest-control.webmanifest    Add to Home Screen, as the controller
  manifest-display.webmanifest    ...and as the display
  config.json                     optional shared defaults
  assets/
    css/podium.css
    js/
      display.js  control.js      the two runtimes
      plan.js                     the office page: build a lecture, write a plan file
      planfile.js                 what a lecture plan is, and how to read an untrusted one
      store.js                    IndexedDB for plans, plus photo resizing and file I/O
      protocol.js                 state shape + the rules for changing it
      renderers.js                one factory per content type
      bus.js                      encryption, identity, presence, reconnect
      crypto.js  config.js  rtc.js  util.js
      transport/                  supabase.js · mqtt.js · ws.js
      deck.js                     Marp: themes, rendering, presenter notes, builds, slide fitting
      zip.js                      minimal ZIP writer, for exporting marked-up slides
    icons/                        app icons (regenerate: vendor-build/make-icons.mjs)
    vendor/qrcode.js              QR generator (MIT, Kazuhiko Arase)
    vendor/marp.esm.js            Marp renderer, bundled for browsers
  marp-themes/                    your Marp CSS + themes.json
  content/manifest.json           your library
  content/decks/                  markdown decks
  server/                         the self-hosted relay
  vendor-build/                   rebuilds the Marp bundle
  test/
```

Three pages, three jobs. `display.html` is the projector. `control.html` is the iPad
in your hand during class. `plan.html` is the desk: it never connects to anything,
and writes a file the controller reads.
```
