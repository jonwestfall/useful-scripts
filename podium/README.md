# 🎛️ Podium

> **Teach from anywhere in the room.** Podium turns the classroom computer into a screen you drive from your iPad or phone.

Open **one browser tab** on the machine wired to the projector and walk away. Slides, PDFs, documents, video, YouTube, background music, handwriting, timers, polls, attendance, captions and your phone's camera are all controlled from the device in your hand. Afterwards, every lecture can be searched and replayed.

Podium is plain HTML, CSS and JavaScript: **no install, no build step, no framework**. It runs for free from GitHub Pages, from a folder on disk, or from your own small server, and every message between devices is **encrypted in the browser** before it leaves.

<p align="center">
  <a href="docs/quickstart.md"><b>🚀 Quickstart</b></a> ·
  <a href="guide.html"><b>✨ Visual guide</b></a> ·
  <a href="docs/features.md"><b>🎨 Every feature</b></a> ·
  <a href="docs/vps.md"><b>🖥️ Self-hosting</b></a> ·
  <a href="docs/troubleshooting.md"><b>🩺 Troubleshooting</b></a>
</p>

> [!TIP]
> **New to Podium?** The **[Quickstart](docs/quickstart.md)** walks you through getting it online **for free** on GitHub Pages in about 20 minutes, with no terminal, no server and no credit card.
>
> **Prefer a visual tour?** Open **[`guide.html`](guide.html)**. On a published copy it's at `https://<you>.github.io/<repo>/podium/guide.html`.

---

## Made in a classroom, by a teacher

Podium was designed and built by **Jon Westfall**, a professor with more than twenty years in the classroom. It's not a company or a product team. It's one teacher's answer to a familiar problem: the lecture happens out in the room, and the computer running the projector is stuck behind the lectern.

Every feature exists because a real class needed it, and the whole thing stays deliberately simple: a few web pages you can read, host for free, and trust.

---

## How it works

Podium splits the job across a few web pages. Each page has one job.

| Page | Runs on | What it does |
| :--- | :--- | :--- |
| **Display** · [`display.html`](display.html) | Classroom PC | Fullscreen on the projector, with no toolbars, cursor or notifications. It shows what it's told and resumes the lecture after a reload. |
| **Controller** · [`control.html`](control.html) | iPad · iPhone · laptop | Your remote: library, presenter notes, ink, timers, polls, music, mixer and camera. Several controllers can share one room. |
| **Planning desk** · [`plan.html`](plan.html) | Office computer | Build a lecture's running order and carry it to class as one `.podium` file, or send it to your server. |
| **Deck editor** · [`deck.html`](deck.html) | Office computer | Write and edit Marp decks and markdown documents beside the projector's own preview, then save them to the library, a plan, or a `.md` file. |
| **Quick Look** · [`quicklook.html`](quicklook.html) | Any browser | Preview any file privately in its own tab, with the projector nowhere involved. |
| **Simple Mode** · [`guest.html`](guest.html) | A substitute's device | A big-button clicker with Next, Previous, Play, Blank and a laser, and no cueing to get wrong. |
| **Join** · [`join.html`](join.html) | Students' phones | Answer polls and ask questions. No app, no login, and no access to the room. |
| **Check in** · [`attend.html`](attend.html) | Students' phones | Take attendance from a code on the screen, answer entry and exit tickets, and leave a question in the parking lot. 🖥️ |
| **Guest View** · [`view.html`](view.html) | Anyone's device | Watch the live screen with its sound. Watch-only. |
| **My Files** · [`me.html`](me.html) | Any browser | On your own server: your files, lectures, templates, recorded lectures, rosters and attendance, and your password. 🖥️ |
| **Replay** · [`replay.html`](replay.html) | Any browser | Play a recorded lecture back with its mic audio, screens, captions and polls in time. 🖥️ |
| **Admin** · [`admin.html`](admin.html) | Any browser | On your own server: people, courses, library, sessions, storage and kiosks. |
| **Home** · [`index.html`](index.html) | Any browser | The landing page that links everything together. |

The devices never talk to each other directly. They all check in with a small **relay** (a free public MQTT broker, Supabase Realtime, or Podium's own server), and the relay only ever sees ciphertext.

```
  Controller (iPad) ──🔒──▶  Relay (sees only ciphertext)  ──🔒──▶  Display (projector)
        ▲                            ▲                                   │
   plan file from               student phones                    Guest viewers
   the planning desk            answer polls (own server)         watch a signed copy
```

---

## Features at a glance

Features marked **🖥️** need Podium's own self-hosted server. Everything else works on every setup, including free GitHub Pages hosting. Each heading links to the full details.

### 🎬 [Presenting](docs/features.md#part-1--presenting)
- **Freeze is a cue.** Freeze holds the projector while you open and page through a deck, scrub a video, find a PDF page, or mark something up. **TAKE** cuts it live (ink and all), **Swap** trades live and cued, and **Blank** blacks out the room with everything still loaded.
- **Now / Next / Notes.** A confidence monitor on your device, with a searchable thumbnail grid. Hold a thumbnail for a pop-out preview.
- **Marp slides in Markdown**, with KaTeX math, **Mermaid diagrams**, progressive builds, presenter notes and custom CSS themes, plus a **deck editor** with a live projector preview, pictures, **video slides** 🖥️, deck templates 🖥️, previous versions 🖥️, and `.zip` and PDF export.
- **Markdown documents**: a plain `.md` shown as one readable page that you scroll for the room, with headings to jump between, ink pinned to the words, and a reflowed copy for viewers' phones. **Word and RTF** files become documents or PDFs 🖥️.
- **PDFs and photos that fill the screen when zoomed**: Fit page, Fit width, a zoom slider, or **pinch and drag** on the preview or the ink pad. A portrait page or an upright photo keeps its shape on your iPad, and ink stays on the words at any zoom. PowerPoint uploads are converted to PDF automatically 🖥️.
- **Quick Look**: open any file privately in a new tab to check it before class, from the controller, planner, library or deck editor.
- **A library of anything:** decks, picture decks, HTML slides, video, audio, YouTube, live streams, photos, web pages, text signs, QR codes, whiteboards, chalkboards and timers. You can also paste any link or upload a photo.
- **Split screen and picture-in-picture** (single, side-by-side, stacked, 3-up, quad, or a PiP inset). Each panel keeps its own item, zoom and ink.
- **"Back to" strip:** go look at a photo, then return to the exact slide you left.

### ✏️ [Drawing & pointing](docs/features.md#part-2--drawing--pointing)
- **Live ink** with pen, highlighter and a stroke eraser in any colour and thickness. Ink is anchored to the slide and each slide keeps its own drawing. Apple Pencil eraser tips work too.
- **Shape snapping:** pause at the end of a stroke to snap it into a line, arrow, rectangle or circle. **Undo** and **Undo clear** rescue a slip.
- **Laser pointer** and **Spotlight** (dims everything except a circle around your finger).

### 🎵 [Media & sound](docs/features.md#part-3--media--sound)
- **Remote transport for video, audio and YouTube**: scrub, skip ±10s and loop, without YouTube's site ever reaching the projector.
- **Live streams from Twitch or YouTube Live**, as video and sound, video only, or sound only, switched live from the Now tab.
- **Background music** that ducks under lecture video, fades out on cue, and can put up a "We begin in…" countdown.
- **A four-channel mixer** (master, content, music, microphones) with a master fader on every tab.
- **Controller microphone**, amplified through the room's speakers and optionally recorded with the lecture 🖥️.

### ⏱️ [On-screen tools](docs/features.md#part-4--on-screen-tools)
- **Up to four countdown timers**, run by the display so they stay accurate while your iPad sleeps.
- **Full-screen messages** with light Markdown, fonts, colours and an optional picture.
- **Watermarks**: your name, course or logo pinned to a corner. Courses can set a default 🖥️.
- **Automated sets**: rotations that run themselves, in order or shuffled.

### 🗳️ [Engaging the room](docs/features.md#part-5--engaging-the-room)
- **Audience polls** 🖥️: multiple choice (with an optional correct answer for quizzes), short answer with a **word cloud**, and **Q&A with upvoting**. They include voting timers, optional names and CSV export. Results stay private until you **Reveal to room**.
- **Document camera**: your phone's camera streamed to the projector. Freeze frames and hold four side by side.
- **Attendance** 🖥️: students check in from their phones with a QR code or a six-digit code that changes every 15 seconds, against your course roster. It flags one phone checking in two people, can require phones to be in the room, and adds **entry and exit tickets**, an anonymous **parking lot** for questions, emailed receipts, a term grid and a Canvas gradebook export.
- **Guest View**: anyone can watch the live screen, with sound, on their own device. It's signed, watch-only, and never shows presenter notes or the cue.

### ♿ [Accessibility](docs/features.md#part-6--accessibility)
- **Live captions** from your speech, plus **pre-scripted captions** written in the planner for any item.
- A screen-reader and contrast pass on the controller and display, enforced by automated tests. See the [audit](docs/accessibility.md).
- **Light or dark on every page**, following the device or chosen once on your account 🖥️, and **keyboard shortcuts** for everything the lectern needs.

### 🤝 [Sharing the lectern](docs/features.md#part-7--sharing-the-lectern)
- **Pair by QR code.** The controller arrives already configured, the code hides itself after 90 seconds, and matching four-character codes confirm both ends agree.
- **Many controllers in one room**, all in sync.
- **Simple Mode for substitutes.** It can't disturb anything you've frozen or cued.

### 🧭 [Planning](docs/features.md#part-8--planning-lectures)
- **Running order** with notes, target length and saved countdowns.
- **Auto-launch**: opening the plan stages panels (including a PiP layout), starts music and begins a countdown.
- **One portable `.podium` file**, or plans stored on your server 🖥️ with **course templates** 🖥️ and a personal **archive** for last term's lectures.
- **Choose files from the server** 🖥️, several at once, and add Word, RTF, PowerPoint and PDF files straight into a plan.
- **ZIP import** 🖥️: bring in a whole folder of exported slides, decks, PDFs and media, and review it before anything lands.

### 🧩 [Make it yours](docs/features.md#part-9--making-the-controller-yours)
- Reorder or hide the controller's twelve tabs, and customize up to eight bottom-bar shortcuts.
- **Saved defaults** for music, mixer levels, caption and watermark, applied at the start of every lecture and winning over a plan's own music settings.
- Keyboard and Bluetooth clicker support, a **pacing clock** for your lecture budget, haptics, keep-awake, split view on a wide iPad, and optional blackout on connect.

### 🗃️ [After class](docs/features.md#part-10--after-class)
- **Export the session** as one ZIP or one merged PDF of photos, annotated slides and boards.
- **Lecture recap** 🖥️: a PDF of what went up and when, what was said, and each poll's result.
- **Session history** 🖥️ with timeline, ink and polls, and retention you control.
- **Replay any lecture** 🖥️: the mic audio, what was on screen, the captions and polls, all in time, with a transcript you can tap to jump. Optionally record the **screen as video** too.
- **Search every lecture** 🖥️ for what was said or shown, and **play from that moment**.
- **Stream live** to YouTube or Twitch with OBS: see the [streaming guide](docs/streaming.md).

### 🖥️ [Your own server](docs/features.md#part-11--your-own-server)
- **Accounts and courses.** A course shares its library, plans and room settings, so a new iPad is just a sign-in.
- **My Files**: everything that's yours on the server in one place (files, lectures, templates, recordings, rosters and attendance), each saying what you may do with it.
- **A shared library** with browser uploads, plus Marp theme, playlist and manifest management on the admin page.
- **Kiosks and signage**: provision a lobby screen with one QR code, schedule plans by day and time, see when it last checked in, and revoke it remotely.
- **Easy to operate**: install and update scripts with automatic rollback, nightly backups, a `doctor` health check, an audit log and a storage-pressure warning.

---

## Choose your setup

The pages are identical everywhere. The only choice is which relay carries their sealed messages.

| | **Public MQTT** | **Supabase Realtime** | **Your own server** |
| :--- | :---: | :---: | :---: |
| Cost | Free, no signup | Free tier | A small VPS |
| Effort | ~20 min, no terminal ([Quickstart](docs/quickstart.md)) | Paste two values into Settings | Install script + nginx ([Deploy guide](deploy/README.md)) |
| Every classroom feature | ✅ | ✅ | ✅ |
| Polls, quizzes, Q&A | – | – | ✅ |
| Accounts, courses, uploads, stored plans | – | – | ✅ |
| Session history, recaps, mic recording | – | – | ✅ |
| Lecture replay, search and screen video | – | – | ✅ |
| Attendance, rosters, entry and exit tickets | – | – | ✅ |
| Guest View typed codes, kiosks, PowerPoint and Word conversion | – | – | ✅ |

### Five-minute version

1. **Publish the pages.** Fork or upload this folder to GitHub and turn on **Pages** (Settings → Pages → deploy from `main`, `/ (root)`).
2. **Arm the display.** Open `display.html` on the classroom PC, enter a room name and a passphrase of three or four random words, then press **Go live** (or `G`).
3. **Pair your iPad.** Press **Pair a device** (or `P`) on the display and scan the QR code. The controller opens already connected.
4. **Teach.** Tap anything in the Library and it's on the projector.

The [Quickstart](docs/quickstart.md) covers each step in plain English. For a server, see [`deploy/README.md`](deploy/README.md).

---

## Privacy & reliability

- **Encrypted end to end.** Every message is sealed with AES-GCM-256 using a key derived from your passphrase (PBKDF2, 150,000 rounds). The passphrase never leaves your devices, and the pairing link carries it after the `#`, which browsers never send to a server.
- **No accounts required, no analytics, no tracking.** Without a server of your own, nothing is stored anywhere except your own devices.
- **The exceptions, stated plainly.** All of them are opt-in:
  - Audience polls and attendance check-ins go through your own server.
  - Session records and recordings are kept, readable, on your own server.
  - Emailed attendance receipts go through the mail server you configure.
  - Live captions in Chrome and Edge use Google's speech recognition.

  See [Architecture & Security](docs/architecture.md#security--end-to-end-cryptography).
- **Built for a live audience.** Pages keep working offline once loaded, the display resumes the lecture after a crash or reload, stale copies of the code are detected and flagged, and over fifty unit suites plus a five-part browser end-to-end suite run on every change.

---

## Classroom display shortcuts

Press **`?`** on the display or the controller for the full list. The controller's shortcuts are in the [features guide](docs/features.md#keyboard-shortcuts).

| Key | On the classroom PC |
| :---: | :--- |
| `G` | **Go live**: fullscreen, sound, and keep the screen awake |
| `P` | Show or hide the pairing QR code |
| `F` | Toggle fullscreen |
| `E` | End of class: leave fullscreen and return to the Go live screen |
| `S` | Open Settings |
| `B` | Back to the home page |
| `?` / `Esc` | Show the shortcut card / close whatever is open |

---

## Documentation

| Guide | For | What's inside |
| :--- | :--- | :--- |
| 🆕 **[What's new in 1.3](docs/whats-new-1.3.md)** | Everyone | Everything added since 1.2, in one page |
| ✨ **[Visual guide](guide.html)** | Everyone | A one-page illustrated tour of Podium |
| 🚀 **[Quickstart](docs/quickstart.md)** | Every teacher | Free setup on GitHub Pages in plain English |
| 🎨 **[Features & teaching guide](docs/features.md)** | Every teacher | Every feature in detail, grouped like the list above |
| 📡 **[Streaming a lecture](docs/streaming.md)** | Anyone streaming class | OBS with YouTube or Twitch, sound, privacy, and how it compares with the replay |
| 🩺 **[Troubleshooting](docs/troubleshooting.md)** | When something's off | Status messages, stale builds, resetting one device |
| 🖥️ **[Self-hosting](docs/vps.md)** | IT and the curious | Accounts, courses, library, sessions, kiosks, and the reasoning behind each |
| 📦 **[Deploying & operating](deploy/README.md)** | Whoever runs the box | Install, update, back up, restore, `doctor` |
| 🏗️ **[Architecture & security](docs/architecture.md)** | Developers | Design principles, protocol, relays, cryptography, code map |
| ♿ **[Accessibility audit](docs/accessibility.md)** | Accessibility staff | What was checked, fixed and still open |
| 🧪 **[Testing](docs/testing.md)** | Contributors | Unit and end-to-end suites, and how to run them |
| 🗺️ **[Audience participation design](docs/roadmap.md)** | The curious | How polls were designed |

Bugs, ideas and requests go to [GitHub Issues](https://github.com/jonwestfall/useful-scripts/issues).

---

<sub>Podium is part of Jon Westfall's <a href="../README.md">Useful Scripts</a>. Designed by one teacher for real classrooms.</sub>
