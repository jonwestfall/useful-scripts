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
- A minimal Node.js server (`server/podium-server.js`) with zero external runtime dependencies.
- Handles WebSocket room routing, HTTP audience polling endpoints, and optional SQLite persistence (`node:sqlite`).
- Can run behind reverse proxies like Caddy or Nginx with TLS termination.

### 3. Public MQTT
- Uses standard MQTT over WebSockets for environments where WebSocket relays are blocked or restricted.

---

## Security & End-to-End Cryptography

Podium is built on a **Zero-Trust Relay** model. Because classroom computers and personal tablets often run on unencrypted campus Wi-Fi or public networks, messages are encrypted in the browser before leaving the device:

### 1. Key Derivation (PBKDF2)
- When you set a room name and passphrase, Podium derives a 256-bit symmetric encryption key using standard Web Crypto:
  $$\text{Key} = \text{PBKDF2}(\text{Passphrase}, \text{Salt} = \text{SHA-256}(\text{RoomName}), \text{Iterations} = 100{,}000, \text{Digest} = \text{SHA-256})$$
- The passphrase and encryption key **never leave your browser** and are never transmitted over the network.

### 2. Message Encryption (AES-GCM-256)
- Every command (slide navigation, ink strokes, layout changes, timers) is encrypted using AES-GCM-256 with a unique 96-bit cryptographic initialization vector (IV) per message.
- The relay server sees only the room name (for routing) and opaque ciphertext. A compromised or eavesdropped relay learns nothing about your presentation, notes, or classroom activity.

### 3. Key Isolation & Room Boundaries
- Controllers and displays verify message authenticity using AES-GCM authentication tags. Packets with invalid passphrases or tampering are rejected silently by the browser without touching application state.

### 4. The Live Caption Exception
- Live captions (Issue #79) use the browser's own `SpeechRecognition` API, running on whichever device starts it. In Chrome and Edge, that API sends the room's audio to Google's speech recognition service to be transcribed — **inside browser-native code Podium never touches**, before there is anything for this app's own encryption to cover. Safari recognizes on-device instead; Firefox has no implementation at all.
- This is a genuine third exception to "the relay only ever sees ciphertext," and a categorically different one from the audience-poll exception above: it is not Podium's own server, is not self-hostable, and is not auditable by this codebase — it is entirely outside Podium's trust boundary, decided by the browser vendor rather than by Podium. It also means live captions do not work on a deployment that is intentionally offline or air-gapped, regardless of how Podium itself is hosted.
- Recognized text travels from there exactly like any other controller-to-display state: encrypted over the relay, via `protocol.js`'s `caption` command. Off by default; the trade-off is stated plainly next to the Start button in `control.html`'s Say tab, not just here.

---

## State Machine Protocol (`protocol.js`)

All application state is governed by a pure, deterministic state machine in [`podium/assets/js/protocol.js`](file:///Users/jon/projects/git/useful-scripts/podium/assets/js/protocol.js):

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
├── index.html            # Landing portal linking to Display, Controller, and Plan
├── display.html          # Cleanroom projector display
├── control.html          # Mobile/iPad presenter remote interface
├── plan.html             # Office lecture composer
├── join.html             # Audience poll participation page for student phones
├── admin.html            # Self-hosted administrative dashboard (accounts & courses)
├── login.html            # Authentication gateway for self-hosted instances
├── assets/
│   ├── css/
│   │   └── podium.css    # Unified responsive stylesheet
│   └── js/
│       ├── control.js    # Controller view logic, touch handling, and intervals
│       ├── display.js    # Projector rendering engine and presentation sync
│       ├── plan.js       # Office planner UI and document serialisation
│       ├── protocol.js   # Deterministic state machine & command reducer
│       ├── crypto.js     # Web Crypto AES-GCM & PBKDF2 encryption routines
│       ├── renderers.js  # Content renderers (Marp decks, PDFs, media, text)
│       ├── ink.js        # Apple Pencil vector drawing and stroke interpolation
│       ├── util.js       # Core helpers, timing formatters, and DOM utilities
│       └── ...
├── server/               # Minimal Node.js self-hosted relay & storage server
│   ├── podium-server.js  # WebSocket relay and HTTP server
│   ├── store.js          # SQLite database schema and persistence layer
│   ├── doctor.js         # Self-diagnostics and integrity inspection CLI
│   └── ...
├── docs/                 # Documentation directory
└── test/                 # Test suites (unit tests and Playwright E2E)
```
