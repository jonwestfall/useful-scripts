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
| `index.html` | anywhere | a landing page linking to the two above |

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

**Blank** is the separate panic button: instant black, program still loaded
underneath, one tap to bring it back.

## What it can put on screen

**Marp decks in Markdown**, with presenter notes on your iPad and your own themes —
see below. Plus: images · video files · audio (with a now-playing card) · YouTube
(play, pause, seek and volume, all driven from the iPad) · any embeddable web page ·
HTML slide decks including reveal.js · PDFs with page-turn buttons · big text cards ·
a QR code for the class to scan · a countdown timer · a whiteboard · your phone's
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
Settings are stored in that browser, so you do this once per machine.

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

On the iPad, Share → **Add to Home Screen** gives you a fullscreen controller with no
Safari chrome. Repeat the pairing for your iPhone; both stay in sync.

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
straight there. An external keyboard or a presentation clicker works too: arrows,
space, `B` to blank, `F` to freeze.

Because the whole deck is rendered once into a shadow root, changing slide is
instant, and a deck cued behind a freeze keeps its place when you take it.

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

## What to expect in a real room

**One click to start.** Browsers block sound until someone interacts with the page,
so the display opens on a **Go live** button. That single click also takes it
fullscreen and requests a wake lock so the screen never sleeps mid-lecture. The
display joins the room as soon as the page loads, though — so your iPad can see it
sitting there waiting for that click, rather than the room looking empty.

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
isolation it will not, and the controller says so instead of hanging.

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

### Getting at Settings on the classroom PC

The display normally runs fullscreen with no browser chrome, and the standby
screen disappears as soon as a controller connects. Three keys get you back in:

| Key | What it does |
| :-- | :-- |
| `P` | Show or hide the pairing QR |
| `S` | Open Settings |
| `Esc` | Close the pairing QR |

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
cd podium/server && npm install             # once
node podium/test/e2e.mjs                    # needs: npm i playwright
```

The end-to-end test starts the relay, drives a display and two controllers in real
browsers, and checks the things that would embarrass you in front of a class: freeze
really holds, TAKE does not reload the cued item, ink arrives, a countdown ticks on
the display, and a controller with the wrong passphrase cannot touch the screen.

## Layout

```
podium/
  display.html  control.html  index.html
  config.json                     optional shared defaults
  assets/
    css/podium.css
    js/
      display.js  control.js      the two runtimes
      protocol.js                 state shape + the rules for changing it
      renderers.js                one factory per content type
      bus.js                      encryption, identity, presence, reconnect
      crypto.js  config.js  rtc.js  util.js
      transport/                  supabase.js · mqtt.js · ws.js
      deck.js                     Marp: themes, rendering, presenter notes
    vendor/qrcode.js              QR generator (MIT, Kazuhiko Arase)
    vendor/marp.esm.js            Marp renderer, bundled for browsers
  marp-themes/                    your Marp CSS + themes.json
  content/manifest.json           your library
  content/decks/                  markdown decks
  server/                         the self-hosted relay
  vendor-build/                   rebuilds the Marp bundle
  test/
```
