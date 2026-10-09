# Podium Architecture & Security

Podium is designed around a strict set of architectural principles: **zero build step**, **zero runtime framework**, **offline resilience**, and **end-to-end cryptographic privacy**.

---

## Architectural Principles

1. **Pure Web Platform**: Built with vanilla ES modules, modern CSS variables, and HTML5 standard elements. No React, Vue, webpack, Vite, or npm build steps are required to serve or run the core application.
2. **Offline Resilience**: The controller and display install offline service worker caches. If campus internet drops mid-lecture, existing slides, ink, notes, and timers continue functioning without disruption.
3. **Display as Output Terminal**: The classroom computer (`display.html`) maintains no local user interface—no mouse cursor, no toolbars, and no menus. It renders strictly what it is instructed to display by authenticated controllers.
4. **Decoupled Relays**: The application pages are static files that communicate over lightweight, interchangeable message relays.

---

## Message Transport & Relays

Podium supports three interchangeable relay backends. All messages travel as lightweight JSON payloads over WebSockets or HTTP broadcast channels:

```
┌──────────────┐                         ┌──────────────┐
│  Controller  │                         │   Display    │
│    (iPad)    │                         │ (Projector)  │
└──────┬───────┘                         └──────▲───────┘
       │                                        │
       │ Encrypted Payload (AES-GCM-256)        │
       ▼                                        │
┌───────────────────────────────────────────────┴──────┐
│                    Relay Server                      │
│ (Supabase Broadcast / Node.js WebSocket / MQTT)     │
│             Blind Ciphertext Forwarding              │
└──────────────────────────────────────────────────────┘
```

### 1. Supabase Realtime (Recommended Free Route)
- Uses Supabase's managed WebSocket cluster.
- Relies on **Broadcast Channels**, meaning no database tables, row-level security (RLS) policies, or storage costs are incurred.
- Fully free tier compatible with zero configuration beyond entering your API URL and public anonymous key.

### 2. Self-Hosted Relay (`podium/server/`)
- A small Node.js server (`server/podium-server.js`) with two runtime dependencies (`ws` for WebSockets, `yauzl` for ZIP imports) and built-in `node:sqlite` storage.
- Handles WebSocket room routing and HTTP audience polling endpoints. With a `DATA_DIR`, it adds accounts, courses, a file library, stored plans, session records with replay and full-text search, rosters and attendance, Guest View codes and kiosk profiles (see [vps.md](vps.md)).
- Can run behind reverse proxies like Caddy or Nginx with TLS termination.

### 3. Public MQTT
- Uses standard MQTT over WebSockets through a public broker (the default in `config.json`, e.g. `wss://broker.emqx.io:8084/mqtt`). No signup, which makes it the fastest way to try Podium.

---

## Security & End-to-End Cryptography

Podium is built on a **Zero-Trust Relay** model. Because classroom computers and personal tablets often run on unencrypted campus Wi-Fi or public networks, messages are encrypted in the browser before leaving the device:

### 1. Key Derivation (PBKDF2)
- When you set a room name and passphrase, Podium derives a 256-bit symmetric encryption key using standard Web Crypto:
  ```
  Key = PBKDF2-SHA-256(passphrase, salt = "podium|v1|" + room, iterations = 150,000) → AES-GCM-256
  ```
  (See `deriveKey` in [`assets/js/crypto.js`](../assets/js/crypto.js).)
- The passphrase and encryption key **never leave your browser** and are never transmitted over the network.

### 2. Message Encryption (AES-GCM-256)
- Every command (slide navigation, ink strokes, layout changes, timers) is encrypted using AES-GCM-256 with a unique 96-bit cryptographic initialization vector (IV) per message.
- The relay server sees only the room name (for routing) and opaque ciphertext. A compromised or eavesdropped relay learns nothing about your presentation, notes, or classroom activity.

### 3. Key Isolation & Room Boundaries
- Controllers and displays verify message authenticity using AES-GCM authentication tags. Packets with invalid passphrases or tampering are rejected silently by the browser without touching application state.

### 4. The Live Caption Exception
- Live captions (Issue #79) use the browser's own `SpeechRecognition` API, running on whichever device starts it. In Chrome and Edge, that API sends the room's audio to Google's speech recognition service to be transcribed — **inside browser-native code Podium never touches**, before there is anything for this app's own encryption to cover. Safari recognizes on-device instead; Firefox has no implementation at all.
- This is a second exception to "the relay only ever sees ciphertext," and a categorically different one from the audience-poll exception (students' phones don't hold the room key, so poll answers go to your own server's poll endpoints outside the room's encryption; see [roadmap.md](roadmap.md)): it is not Podium's own server, is not self-hostable, and is not auditable by this codebase — it is entirely outside Podium's trust boundary, decided by the browser vendor rather than by Podium. It also means live captions do not work on a deployment that is intentionally offline or air-gapped, regardless of how Podium itself is hosted.
- Recognized text travels from there exactly like any other controller-to-display state: encrypted over the relay, via `protocol.js`'s `caption` command. Off by default; the trade-off is stated plainly next to the Start button in `control.html`'s Say tab, not just here.

---

### 5. Live Streams Load Twitch's Own Player
- A Twitch stream (Issue #175) is played through Twitch's embed script, fetched from `player.twitch.tv` by whichever screen shows the stream (the display, or a Guest View viewer), and only then. It is the only way to control a Twitch player's play, pause and volume. Nothing about the room travels to Twitch beyond what any embedded player sees: the page's address (Twitch requires it) and the viewer's own connection. YouTube Live uses the same `youtube.com` embed as ordinary YouTube items.

### 6. Session Records and Recordings Live on Your Server
- With accounts, the **display** (the one device holding the decrypted state) writes a lecture's record to your own server over HTTPS: the timeline, caption text, poll results, and, if chosen, photos, controller mic audio (Issue #147) and screen video (Issue #132, off unless an administrator turns it on). The relay still only ever sees ciphertext; these records are stored readable on the server so they can be replayed and searched (Issue #159), and only accounts that may open that lecture can reach them.
- Each recording is said on screen: the Go live screen lists what is kept, and a badge stays on the projector while the screen is being recorded.

### 7. Attendance: Location and Email
- Attendance (Issue #256) runs only on your own server. Students' phones talk to it directly at `attend.html`, outside the room's encryption, the same way poll answers do.
- **Location**, when an instructor requires phones to be in the room: the phone sends its position once; the server works out the distance and keeps only that number, never the coordinates.
- **Receipts by email** go through the SMTP server an administrator configures (`SMTP_URL`), so that mail provider sees each receipt's address and contents. Off unless both the server and the course turn it on.
- The browser token and network address behind a shared-phone flag are kept only as keyed hashes, and only for the retention period set on the admin page.

## State Machine Protocol (`protocol.js`)

All application state is governed by a pure, deterministic state machine in [`podium/assets/js/protocol.js`](../assets/js/protocol.js):

- **Pure Functional Core**: `applyCommand(state, cmd)` receives the current room state and an incoming command, mutating the state predictably and returning a boolean indicating whether the command changed state.
- **Single Source of Truth**:
  - `state.program`: The live item displayed on the main stage.
  - `state.preview`: The queued item visible only to the presenter while frozen.
  - `state.frozen`: Boolean indicating whether visual output is locked in place.
  - `state.blank`: Boolean indicating blackout mode.
  - `state.layout`: Active multi-panel configuration (`single`, `2h`, `2v`, `3`, `4`).
  - `state.panels`: Array representing items staged into secondary screen panels.
  - `state.ink`: Vector ink strokes organized by content-addressed surface keys.
  - `state.timers`: Array of active countdown timers and timestamps.
  - `state.music`: Background music queue, index, and playback state.

---

## Codebase Directory Map

```
podium/
├── index.html            # Landing page linking to every surface
├── guide.html            # The illustrated Podium Guide (self-contained, no scripts)
├── display.html          # Clean projector display (also view.html's engine)
├── control.html          # iPad / phone presenter remote
├── guest.html            # Simple Mode: a substitute's clicker (Issue #77)
├── view.html             # Guest View: watch-only viewer (Issue #150)
├── plan.html             # Office lecture planner
├── deck.html             # Deck editor: Marp decks and markdown documents (Issues #226, #240)
├── quicklook.html        # Quick Look: a file, privately, in its own tab (Issue #242)
├── join.html             # Audience poll page for student phones (self-contained)
├── attend.html           # Attendance check-in for student phones (self-contained, Issue #256)
├── me.html               # My Files: everything that is yours on a server (Issue #243)
├── replay.html           # Replay a recorded lecture (Issue #132)
├── admin.html            # Self-hosted admin page (people, courses, library, sessions, kiosks)
├── login.html            # Sign-in page for self-hosted instances (self-contained)
├── sw.js                 # Network-first offline service worker
├── config.json           # Optional defaults for never-configured devices
├── content/              # Example library: manifest.json, music.json, decks, audio
├── marp-themes/          # Marp CSS themes + themes.json
├── assets/
│   ├── css/podium.css    # One shared stylesheet (palette tokens, dark/light)
│   ├── vendor/           # Marp, PDF.js, QR code, CodeMirror, Mermaid, mammoth - vendored copies
│   └── js/
│       ├── protocol.js   # Deterministic state machine & command reducer, ink math
│       ├── control.js    # Controller UI
│       ├── display.js    # Projector renderer (and viewer mode for view.html)
│       ├── renderers.js  # Content renderers (decks, PDFs, media, text, polls, timers)
│       ├── plan.js       # Planner UI;  planfile.js - the .podium document format
│       ├── crypto.js     # Web Crypto AES-GCM & PBKDF2
│       ├── bus.js        # Encrypted message bus over a transport/
│       ├── transport/    # mqtt.js, supabase.js, ws.js
│       ├── rtc.js        # WebRTC camera & microphone
│       ├── pdf-writer.js # Client-side PDF export;  recap.js - lecture recaps
│       ├── deck-editor.js, deck-source.js, deck-mermaid.js  # The deck editor and its checks
│       ├── doc.js, doc-reader.js     # Markdown documents, and a viewer's own-pace reader
│       ├── zoom.js, gestures.js      # Zoom that fills the screen; pinch, drag, wheel
│       ├── quicklook.js, me.js, attendance-panel.js, attendance-review.js
│       ├── session-search.js         # Searching past sessions (Issue #159)
│       ├── replay.js, replay-model.js  # The lecture replay; screen-record.js records the display
│       ├── admin.js, guest.js, join.js, ...
│       └── ...
├── server/               # Self-hosted relay & storage server
│   ├── podium-server.js  # HTTP + WebSocket relay, auth gate, static files
│   ├── api.js            # REST API;  store.js - SQLite schema & persistence
│   ├── accounts.js, courses.js, library.js, plans.js, lectures.js, kiosks.js, ...
│   ├── roster.js, attendance.js  # Course rosters and attendance (Issue #256)
│   ├── mail.js           # A small SMTP client for attendance receipts
│   ├── podium-admin.js   # CLI: users, courses, backups, pruning, doctor
│   └── doctor.js         # Self-diagnostics
├── deploy/               # install/update/backup/restore scripts, systemd & nginx templates
├── docs/                 # This documentation
└── test/                 # Unit suites (*.test.mjs) and the Playwright e2e suite
```
