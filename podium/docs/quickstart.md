# Podium for professors — a quick start for non-geeks

Podium turns the classroom computer into a screen you drive from your iPad: slides,
video, a countdown, your handwriting over a figure. This explains how it works in
plain English and walks you through putting it online **for free** — no server to
rent, nothing to install, no credit card.

Setup takes about twenty minutes, once. You will not need a terminal or a code
editor.

*(For the full reference — every feature, every setting, every design decision —
see [README.md](../README.md). This file is the short road in.)*

---

## How it works

Podium is not an app you install. It is three web pages you open in a browser, and
each has one job.

- **The display** runs fullscreen on the classroom computer, plugged into the
  projector. It shows what it is told to show and nothing else — no toolbars, no
  cursor, no email notification sliding in over your slide.
- **The controller** runs on your iPad or phone. It is the remote: your library of
  slides and clips, presenter notes, a timer, and a pad for drawing over the slide.
- **The planning page** is the one you use at your desk rather than at the lectern.
  Build a lecture's running order, then carry it to the iPad as a file.

The interesting question is how the iPad tells the classroom computer what to do,
given the two are on different networks, behind a university firewall, with no
server of yours in between.

```
                        ┌───────────────────────┐
                        │     GitHub Pages      │
                        │ your free copy of the │
                        │         pages         │
                        └───────────────────────┘
                           ╱                   ╲
             the app itself,                    the app itself,
             once  ╱                                 ╲  once
                  ▼                                   ▼
   ┌───────────────────┐   sealed   ┌──────────┐   still   ┌───────────────────┐
   │     Your iPad     │ ─────────▶ │  Public  │  sealed   │   Classroom PC    │
   │   the controller  │            │  broker  │ ────────▶ │    the display    │
   └───────────────────┘            └──────────┘           └───────────────────┘
       holds the key            no key, ever                  holds the key
      your passphrase        sees scrambled text            same passphrase
                              and your room name

   ╌╌╌ dashed = happens once, when a page loads
   ─── solid  = every tap, all lecture
```

GitHub hands each device a copy of the app and then drops out of the picture
entirely — it never sees a single lecture message. Everything you actually *do*
travels iPad → broker → classroom PC, scrambled inside your browser before it
leaves and unscrambled only inside the other one.

### Why a "broker" at all

Your iPad cannot simply call the classroom PC. Campus networks do not allow it, and
neither device has a fixed address the other could dial. So both of them phone *out*
to the same agreed place and leave messages for each other there.

That place is an MQTT broker, and it behaves exactly like a pigeonhole in a
department office: you drop something into the box labelled with your room name, and
whoever else is watching that box picks it up. The broker never inspects what is in
the envelope. It cannot — the envelope is sealed with your passphrase before it
leaves your iPad, and the broker was never given the key. That is what makes it safe
to use a free public one that anybody can connect to.

---

## The words you will meet

Seven terms stand between you and a working setup. None of them is complicated.

| Term | What it actually means |
| --- | --- |
| **GitHub** | A website where people keep files. Think Dropbox with a public side: free accounts, and anything you mark public gets a web address anybody can open. |
| **Repository** | One project's folder of files, living on GitHub. Everyone shortens it to "repo". You will make one called `podium`. |
| **Static site** | A website made only of files handed to the browser as-is — no database, nothing running on a server. Podium is one, which is exactly why it can be hosted for nothing, and why there is no server of yours to break into. |
| **GitHub Pages** | A free switch on any public repo that says "also serve these files as a website". Flip it and your files are live at `yourname.github.io/podium/`. |
| **MQTT** | A dialect computers use to pass short messages around. Designed for sensors and thermostats, so it is tiny and quick — which is why a pen stroke on your iPad lands on the wall with no visible lag. |
| **Broker** | The pigeonhole itself. You will use a free public one run by EMQX. No account, no signup, no card. |
| **Room and passphrase** | Your two secrets. The **room** is which pigeonhole to use. The **passphrase** is the key that seals and opens the envelopes — and it is the only thing standing between a stranger and your projector. |

---

## Setting it up

### 1. Make a GitHub account — 2 minutes

Go to [github.com](https://github.com) and sign up. A free account is all this needs.
Pick a username you do not mind appearing in your web address; it becomes part of it.

### 2. Download the files — 2 minutes

Open [github.com/jonwestfall/useful-scripts](https://github.com/jonwestfall/useful-scripts),
click the green **Code** button, then **Download ZIP**. Unzip it and open the folder
called `podium`. That folder — about fifty files — is the whole application.

### 3. Make your own repository — 5 minutes

1. On GitHub click **+** (top right) → **New repository**.
2. Name it `podium`. Leave it set to **Public**. Click **Create repository**.
3. On the page that appears, click **uploading an existing file**.
4. Open your `podium` folder, select *everything inside it*, and drag it onto the
   browser window. Wait for the list to finish filling in.
5. Scroll down and click **Commit changes**.

> **Public, but that is fine.** Podium's code is open source; publishing it gives
> nothing away. Your *lecture content* is a different matter — see
> [Is this safe?](#is-this-safe) before you upload any slides.

### 4. Turn the website on — 3 minutes

In your repo: **Settings** → **Pages** (left sidebar) → under *Source* choose
**Deploy from a branch**, set the branch to **main** and the folder to
**/ (root)**, then **Save**.

Wait a minute or two and refresh. GitHub shows you your address:

```
https://YOURNAME.github.io/podium/
```

Open it. You should see three buttons: Display, Controller, Planning.

### 5. Set up the classroom computer — 4 minutes

On the machine wired to the projector, open your address and click **Display**.
Because this device has never been set up, it shows a settings form:

- **Connection** — leave it on *MQTT over WSS (public broker)*.
- **Broker URL** — already filled in. Do not touch it.
- **Room** — something nobody would guess. Not `psych101`. Try
  `westfall-415-fall-r7k2`.
- **Passphrase** — three or four random words, e.g. `lantern shovel pear anvil`.
  This is the real lock; see [below](#so-the-passphrase-is-the-whole-lock).

Click **Save**, then **Go live** — or just press `G`. That one click or keypress is
what grants the page fullscreen, sound, and permission to keep the screen awake —
browsers require a real click or keypress for those, which is the only reason the
button exists.

Press `?` on that machine at any point for the handful of keys it understands. The
ones worth knowing now: `G` is **Go live** itself, `F` toggles fullscreen, and `E`
leaves fullscreen and puts the **Go live** screen back up — which is how you get out
at the end of class without hunting for the browser's own controls.

### 6. Pair the iPad — 3 minutes

On the display press **Pair a device** (or the `P` key). A QR code appears. Point the
iPad's camera at it and tap the link.

The controller opens *already configured* — room, passphrase and broker all arrive
with the link, so there is nothing to retype. Then use Share → **Add to Home Screen**
for a proper app icon with no browser chrome around it.

> **Check the four-character code.** Both screens show a short code like `94AA`. The
> same code on both means they can actually hear each other. Different codes mean a
> typo in the passphrase — they will never connect.

> **Then hide the QR.** Anyone who scans it gets control of your projector. It
> disappears by itself after 90 seconds; do not leave it up in front of the room.

---

## Your first lecture

Tap anything in the **Library** and it goes on the projector immediately. That is the
whole basic operation.

The part worth learning is **Freeze**. Press it and the projector holds whatever it is
showing — then you can browse ahead, open the next deck, line up a video, all without
the class seeing any of it. When you are ready, **Take** puts it up. It is borrowed
from television gallery control, where you never cut to something you have not looked
at first. In a lecture it means you can answer "what was that figure in week three?"
without the room watching you rummage.

Everything else is where you would expect: **Ink** draws over the slide with a pencil,
**Timer** puts a countdown on the wall for group work, **Blank** cuts to black when you
want their eyes on you, and the **Slides** tab shows your presenter notes and the next
slide while the class sees only the current one.

If you wander off to a photo and want to get back, the Library's **Back to** strip
returns you to the exact slide you left — not the start of the deck.

The **Music** tab plays music through the classroom computer with nothing on the
projector — for while the room fills up. Put your tracks on your own server, list them
in `content/music.json`, and press Load. It fades in, ducks itself when you play a
video, and **Fade out & stop** takes the room quiet over three seconds when class
begins. **⏳ Show "We begin in…"** puts up a panel counting down to the end of
whatever is playing, so the room can see when you are actually starting.

The **Say** tab's watermark pins your name or a logo to a corner of the screen for
the whole lecture — it survives everything you pick, and ends up in a whole-screen
photo too, which is the point of it.

The **Sets** tab builds a rotation that runs itself before class — a QR code, a
photo, a text sign, each held for its own number of seconds. **+ New set**, then
**Add items — go to Library** and tap tiles to add them; come back to name it, set
durations and order, and **Save set**. Each saved set has an A/B/C/D button — start
it on any pane, and it keeps advancing even if you close the tab.

The **Camera** tab makes your phone a document camera — hold it over a book and it is
on the wall. **Take a photo** freezes a frame and keeps it: tap the thumbnail to put
it on screen, and since each photo is just a photo, you can split the screen and hold
four of them up at once (four students' answers, side by side). They last for the
class and are never saved to the tablet.

To keep a board you have drawn on, **press and hold** the panel letter (A/B/C/D, top
right) — you get a photo of that panel with the ink on it. Hold a layout button a
moment longer for a shot of the whole screen. Everything you keep this way is on the
**Photos** tab, and **Export this session** there downloads one zip with the photos,
every slide you annotated, and every board you drew on. (The **⤓** on a single photo
saves just that one.) That zip is the only copy that outlives the class: nothing is
written to the tablet until you press it.

---

## Is this safe?

Yes — and it is worth understanding exactly why, because one decision is yours to get
right.

Every message is encrypted *inside your browser* before it goes anywhere, using
AES-GCM — the same encryption behind the padlock in your address bar. The key is
derived from your passphrase by grinding it through 150,000 rounds of a deliberately
slow function, which is what makes guessing expensive.

Nothing in the middle can read any of it. The honest accounting:

| Who | What they can see | What they can do |
| --- | --- | --- |
| GitHub | The app's files, which are open source anyway. No lecture traffic ever reaches them. | Nothing |
| The broker | Scrambled text, and your room name. | Nothing |
| Your IT department | That your browser talks to a broker. Not what it says. | Nothing |
| A curious student | Your web address, and a setup form asking for a room and passphrase. | Nothing |
| Someone with your passphrase | Everything. | Drive your projector |

### So the passphrase is the whole lock

That last row is the one that matters. Because the broker is public, someone could in
principle record your scrambled traffic and sit at home trying passphrases against it.
The 150,000 rounds make each guess slow — but a single dictionary word is still a
single dictionary word.

**Use three or four random, unrelated words.** That is genuinely enough, and it is easy
to read aloud to a colleague. Change it each term: on any device, **Settings → Clear
settings & reload** starts fresh.

> **The one real trap.** A free GitHub Pages site must be **public**. If you upload
> lecture slides into that repo, those slides are on the open web — the wrong answer
> for copyrighted figures, unpublished data, or an exam.
>
> Use the **Planning** page instead. It builds a lecture on your office machine and
> saves it as a single file you AirDrop to the iPad. Your slides and photos travel
> inside that file, device to device — they are never uploaded to GitHub at all. Only
> the public example content ships with the repo.

### Two details worth knowing

The pairing QR carries your passphrase in the part of a web address after the `#`.
Browsers never send that part to a server — it is the one piece of a URL that stays on
your device. That is deliberate, so the passphrase does not end up in anyone's access
log.

And nothing is stored anywhere but on your own devices. There are no accounts, no
analytics, no database, no company holding your lecture material. When you clear a
device's settings, that really is the end of it.

---

## Making it yours

Everything is a plain text file. Edit it on GitHub's website and the change is live in
about a minute.

| File | What it controls |
| --- | --- |
| `content/manifest.json` | **Your library** — the tiles you see on the iPad. Add a line, commit, and it appears. Slides, images, video, YouTube, PDFs, a QR code for the class, a text card. |
| `marp-themes/` | **Your slide design.** Slides are written in Markdown, so your department's colours and fonts are one stylesheet away. Drop in the CSS, name it in the theme list. |
| `plan.html` | **Per-lecture plans.** Build a running order at your desk — deck, photo, countdown, a note to yourself — and carry it over as a file. Nothing goes near the repo. |
| `config.json` | **Defaults for new devices.** Set the connection type and a house room name so a fresh device has less to fill in. Never put the passphrase here. |

There is no build step and no framework: it is HTML, CSS and JavaScript that a browser
runs directly. If you can edit a syllabus, you can edit this — and if you break
something, GitHub keeps every previous version.

---

## When something is wrong

Podium is built to tell you which of the parts is at fault rather than just failing.

- **"Lost the relay — retrying"** — the broker is not answering. The display shows
  exactly what it is dialling and what went wrong underneath. Usually the classroom
  wi-fi; occasionally the free broker having a bad day. Settings lets you switch to a
  different one.
- **The codes do not match** — the four characters on each screen come from the room
  and passphrase together. Different codes mean one of them was typed differently.
  Re-pair with the QR rather than retyping.
- **"Display is on build 5, this is build 8"** — one device is running an older copy it
  kept in its cache. Reload the one it names. Both pages also check themselves against
  the server on every load.
- **Nothing on the projector** — somebody has to press **Go live** on the display after
  it starts. The controller says so explicitly ("Display open — click Go live on it")
  rather than pretending the display is not there.
- **Everything has gone wrong at once** — on the misbehaving device, **Settings → Clear
  settings & reload**, then scan the pairing QR again. Thirty seconds, and it affects
  only that one device.

---

## What it costs

Nothing. A free GitHub account, free hosting on GitHub Pages, and a free public broker
that needs no signup.

The broker is offered as a courtesy with no guarantees — fine for teaching. If your
department wants something it controls, Podium also runs over your own server with one
setting changed (`server/` in this folder is a small relay you can put on any VPS), or
over a free Supabase project.
