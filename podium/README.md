# 🎛️ Podium

> **Turn the classroom PC into a presentation display you drive from your iPad or phone.**

The classroom PC opens **one browser tab** and never gets touched again. Everything that appears on the projector — Marp slide decks, PDFs, videos, YouTube clips, background music, class QR codes, countdown timers, live handwriting, and your phone's camera — is controlled from an iPad or iPhone in your hand, from anywhere in the room.

Podium is built as static web pages with **zero build step and no framework**. It runs out-of-the-box from GitHub Pages, a simple VPS, or even directly from a local folder.

---

> [!TIP]
> ### 🚀 New to Podium? Start Here!
> **[Read the Quickstart Guide](docs/quickstart.md)** — A plain-English, step-by-step walkthrough to get Podium online **for free** on GitHub Pages in about 20 minutes. No terminal, no server, no credit card required.

---

## The Three Surfaces

Podium divides presentation duties cleanly across three dedicated web surfaces:

| Surface | File | Runs on | Role |
| :--- | :--- | :--- | :--- |
| **Display** | [`display.html`](display.html) | Classroom PC | Fullscreen tab connected to the projector; silently renders what it is told. |
| **Controller** | [`control.html`](control.html) | iPad / iPhone / Laptop | The presenter remote; manages the cue, notes, timers, ink, and media. Multiple controllers stay in sync. |
| **Planning Desk** | [`plan.html`](plan.html) | Office Computer | Assemble lecture materials, organize decks, and save a self-contained `.podium` plan file. Offline-only. |
| **Launcher** | [`index.html`](index.html) | Any Browser | Quick navigation landing page connecting to the three surfaces. |

---

## Core Concepts

*   **Freeze is a Cue**: Pressing **Freeze** holds the current screen on the projector while freeing your controller to preview, scrub, or advance slides silently in the background. Press **TAKE** to cut smoothly to the staged content, **Swap** to trade preview and live, or **Clear** to discard changes.
*   **Instant Blank**: A dedicated blackout panic button cuts the projector instantly while keeping your lecture session and media position loaded underneath.
*   **Live Pencil Ink & Laser**: Annotate directly on slides, photos, or blank whiteboards with an Apple Pencil or stylus. Laser pointer mode tracks your touch and auto-vanishes on release.
*   **Dual-Layer Audio & Media Mixer**: Play background waiting music before class that ducks automatically when lecture media plays, and controls content volume independently.
*   **Encrypted by Default**: All communications are encrypted in the browser with AES-GCM-256 via PBKDF2 keys derived from your room passphrase. The relay only ever sees ciphertext.

---

## 5-Minute Setup

### 1. Choose a Relay
Podium clients exchange encrypted messages over a lightweight relay:
*   **Supabase Realtime (Recommended)**: Free tier, high reliability, zero server maintenance. Uses broadcast channels (no database tables or RLS required).
*   **Self-Hosted WebSocket**: A tiny ~150-line Node server (`server/podium-server.js`) with zero third-party dependencies.
*   **Public MQTT Broker**: Zero signup required (e.g. `wss://broker.emqx.io:8084/mqtt`) for instant testing.

### 2. Publish the Pages
Deploy to GitHub Pages by committing this repo and enabling **Pages** in repo settings (deploy from `main` branch, `/ (root)`). Your pages are live at `https://<user>.github.io/useful-scripts/podium/`.

### 3. Arm the Classroom Display
Open `display.html` on the classroom machine, enter your room name and passphrase, and click **Go live** (or press `G`). This grants fullscreen, Screen Wake Lock, and audio autoplay permissions.

### 4. Pair Your Controller
On the display, click **Pair a device** (or press `P`) to display the pairing QR code. Scan the code with your iPad or iPhone camera. The controller opens pre-configured and instantly connects.

---

## Classroom Display Shortcuts

When running fullscreen on the classroom PC with browser toolbars hidden, use these physical keyboard shortcuts on the podium machine:

| Key | Action |
| :---: | :--- |
| `?` | Show or hide the shortcut cheat sheet card |
| `G` | **Go live** (arms session, enters fullscreen, locks wake state) |
| `F` | Toggle fullscreen mode |
| `E` | **End of class** (drops fullscreen and returns to arming screen) |
| `B` | Back to home landing page (`index.html`) |
| `P` | Show or hide the pairing QR code |
| `S` | Open connection and display Settings |
| `Esc` | Dismiss any open modal or card |

---

## Documentation Directory

Explore the dedicated documentation in [`docs/`](docs/) for in-depth technical references and guides:

*   📖 **[Quickstart Guide](docs/quickstart.md)** — Step-by-step setup guide for instructors and non-technical users.
*   🎨 **[Features & Teaching Guide](docs/features.md)** — In-depth guide to Marp Markdown decks, presenter notes, ink tools, countdowns, camera streaming, audience polls, and automated sets.
*   🏗️ **[Architecture & Protocol Reference](docs/architecture.md)** — Zero-framework philosophy, state machine protocol, Web Crypto AES-GCM encryption, transports, and code directory layout.
*   🖥️ **[Self-Hosting & VPS Guide](docs/vps.md)** — Running your own Node relay, SQLite storage, user accounts, course access control, browser library uploads, and systemd deployment.
*   🧪 **[Testing Suite & CI](docs/testing.md)** — Unit tests (`protocol`, `plan`, `store`, `pacing`, `bottombar`), `doctor.js` diagnostics, and Playwright end-to-end test execution.
*   🩺 **[Troubleshooting & Diagnostics](docs/troubleshooting.md)** — Connection diagnostics, relay readout interpretation, build mismatch detection, surgical device reset, and emergency controls.
*   🗺️ **[Audience Participation & Roadmap](docs/roadmap.md)** — Architecture for live audience polls and feature plans.
*   📋 **[Open Issues & Backlog](docs/open-issues.md)** — Tracked enhancements and version planning.
