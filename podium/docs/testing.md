# Testing Podium

Podium maintains a comprehensive automated testing suite ensuring zero-regression reliability for classroom teaching. Because lecturers rely on Podium in front of live audiences, testing focuses rigorously on the things that cannot fail: freeze safety, offline recovery, state machine correctness, ink synchronization, audio mixer math, and cryptographic boundary isolation.

---

## Test Suites Overview

The testing suite consists of two layers:
1. **Fast, browser-free unit test suites** (Node.js native, runs in milliseconds without dependencies).
2. **Full End-to-End (E2E) integration test suite** (Playwright driving real headless Chromium browser instances).

```
podium/test/
├── protocol.test.mjs     # Core state machine, command dispatch, and ink surface math
├── plan.test.mjs         # Plan document parsing, serialization, and asset bundling
├── store.test.mjs        # Server SQLite storage, multi-user accounts, courses, and retention
├── pacing.test.mjs       # Topbar persistent pacing clock & lecture duration calculations
├── bottombar.test.mjs    # Customizable bottom-bar quick-action slots and dispatchers
├── content.test.mjs      # Admin content/Marp theme/manifest management, server-side (Issue #54)
├── deck_nav.test.mjs     # Slide thumbnail badges, grid auto-scroll & section chips (Issue #34)
├── haptics.test.mjs      # Tactile haptic feedback on navigation & lectern actions (Issue #32)
├── ink.test.mjs          # Highlighter mode (#35) and stroke eraser (#36)
├── mini-markdown.test.mjs # The "lite" markdown shared by messages, notes and captions (Issue #103)
├── music.test.mjs        # Background music queueing, ducking and fade math
├── pdf-writer.test.mjs   # Client-side canvas PDF export/rendering (Issue #43)
├── poll-names.test.mjs   # Optional name recording on audience polls (Issue #72)
├── relay.test.mjs        # WebSocket relay limits - room caps and per-IP throttling (Issue #112)
├── snap.test.mjs         # Quick shape & straight-line snapping, hold-to-straighten (Issue #38)
├── spotlight.test.mjs    # Spotlight / attention dimmer pointer mode (Issue #37)
├── tabsettings.test.mjs  # Customizable/collapsible controller tab bar (Issue #76)
├── templates.test.mjs    # Course-level plan templates, against a real SQLite file (Issue #80)
├── offline-shell.test.mjs # The offline shell warms everything the pages load at startup (Issue #130)
├── e2e.mjs               # Runs every end-to-end group below
└── e2e/
    ├── harness.mjs       # Shared setup: fixtures, relay, browser, ok()/trap()/--only
    ├── core.mjs          # Switching, connection, settings, offline, the display basics
    ├── ink-layout.mjs    # Ink, split layouts, picture-in-picture, keeping what was on screen
    ├── media.mjs         # Camera, music, audio, clocks, captions, PDFs
    └── polls-server.mjs  # Polls, plans, accounts, multi-device rooms
```

---

## 1. Running the Unit Tests

The unit tests run directly in Node.js without requiring any build step, headless browser, or npm installation.

Run every unit test (this is also exactly what CI's unit job and `deploy/update.sh`'s release
gate run - see Issue #111: this used to be a hand-picked subset of three files, and the rest
silently never ran anywhere automatically):
```bash
for f in podium/test/*.test.mjs; do node "$f"; done
```

Run one directly while iterating on it:
```bash
node podium/test/protocol.test.mjs
```

### What Each Unit Test Covers

- **`protocol.test.mjs`**:
  - State machine command transitions (`stage`, `take`, `swap`, `clear`, `freeze`, `blank`, `layout`, `nav`, `media`, `timer`, `poll`, `music`).
  - Cueing rules: ensuring that while frozen, new staged items and layout changes land exclusively in `preview` and never touch the live projector.
  - Multi-panel layouts (`single`, `2h`, `2v`, `3`, `4`) and focused panel routing.
  - Ink surface key calculation, vector stroke ingestion, and content-addressed surface digests.
- **`plan.test.mjs`**:
  - Lecture plan format parsing, version validation, and JSON serialization.
  - Media asset packaging and base64 embedding.
  - Round-trip plan fidelity from office machine to classroom lectern.
- **`store.test.mjs`**:
  - Self-hosted SQLite database operations via native `node:sqlite`.
  - Multi-user authentication, password hashing, session tokens, and privilege levels (admin vs. instructor).
  - Course-level access control and archiving behavior.
  - Media storage deduplication and automatic file retention cleanup policies.
  - Built-in system health checks (`doctor`).
- **`pacing.test.mjs`**:
  - Wall-clock formatting and persistent timer duration calculations.
  - Near-end warning thresholds ($\ge 85\%$ elapsed) and overtime indicator tracking.
  - Automatic timer start triggers upon first slide advance or unblank.
- **`bottombar.test.mjs`**:
  - Customizable bottom-bar shortcut slots across all supported actions (Music, Media Play, Whiteboard, Laser, Countdown, Next, Prev, None).
  - Safe state resolution and DOM element contract verification.
- **`content.test.mjs`**: admin content/Marp theme/manifest management, and path-traversal rejection.
- **`deck_nav.test.mjs`**: thumbnail badges for ink, grid auto-scroll, and section chip navigation.
- **`haptics.test.mjs`**: vibration triggers on navigation and lectern actions, and the Settings toggle.
- **`ink.test.mjs`**: highlighter blending and the targeted stroke eraser.
- **`mini-markdown.test.mjs`**: the shared "lite" markdown renderer (headings, lists, bold/italic/code/links, HTML escaping) used by full-screen messages, presenter notes, and captions.
- **`music.test.mjs`**: background-music queue ordering, crossfade/ducking math, and loop behavior.
- **`pdf-writer.test.mjs`**: the client-side canvas PDF export/render pipeline's byte output.
- **`poll-names.test.mjs`**: the opt-in "record respondent name" setting on audience polls, server-side.
- **`relay.test.mjs`**: spawns a real relay process and opens real sockets (no browser) to check `MAX_PER_ROOM`, the relay-wide `MAX_ROOMS` cap, and the per-IP upgrade throttle.
- **`snap.test.mjs`**: hold-to-straighten shape/line snapping thresholds and geometry.
- **`spotlight.test.mjs`**: the attention-dimmer pointer mode's keyboard shortcuts and geometry.
- **`tabsettings.test.mjs`**: reordering, hiding, and restoring controller tabs.
- **`templates.test.mjs`**: course-level plan template ownership and removal permissions.

---

## 1a. Linting (`eslint.config.mjs`)

A minimal correctness pass (Issue #123) - `eslint:recommended` (`no-undef`, `no-unused-vars`, and the rest of that set) plus `eqeqeq` in its `smart` mode, which still catches a stray `==` between two real values but leaves the codebase's own `x == null` idiom (null-or-undefined, on purpose, in dozens of places) alone. It is deliberately not a style or formatting pass - nothing in it reformats a line of existing code.

Nothing is committed for it, the same ad-hoc-install approach as the E2E job's Playwright install below:
```bash
cd podium
npm install eslint@10.11.0 @eslint/js@10.0.1 globals@17.12.0
npx eslint .
```

---

## 2. Server Diagnostics (`doctor.js`)

On self-hosted instances (`server/`), Podium includes an autonomous diagnostics tool that inspects the running database, media directory, permissions, build alignment, and schema integrity:

```bash
cd podium/server
node doctor.js
```

The doctor check verifies:
- Node.js runtime version compatibility.
- SQLite schema version and migrations.
- Data directory permissions (ensuring no world-readable leakage).
- Missing, dangling, or unreferenced media blobs on disk.
- Account validity and retention policies.

---

## 3. End-to-End (E2E) Browser Integration Tests

The E2E suite is an exhaustive integration test, split into four feature groups under
`podium/test/e2e/` (Issue #122). Each group:
1. Generates its own self-contained audio and media fixtures (no external downloads needed).
2. Spawns its own relay server on an ephemeral port.
3. Launches its own headless Chromium, driving real **Display** and **Controller** pages.

So a group runs on its own, and a failure in one never stops the others from reporting.
Together they execute over 540 checks simulating real-world classroom situations.

### Prerequisites

Install Playwright and Chromium:
```bash
npm install playwright
npx playwright install chromium
```

### Running the E2E Test

Run every group, one after another, with a pass/fail summary per group at the end:
```bash
node podium/test/e2e.mjs
```

Run one group (or several, comma-separated) - either through the runner or directly:
```bash
node podium/test/e2e.mjs --group ink-layout
node podium/test/e2e/ink-layout.mjs
```

CI runs the four groups side by side on separate runners, then reports a single
`End-to-end (Playwright)` check that is green only when every group is. Locally the runner
goes one group at a time, because some groups write the same fixture files.

### Running Targeted Sections

During development, you can run specific test sections using the `--only` filter to save time:

```bash
node podium/test/e2e.mjs --only ink
node podium/test/e2e.mjs --only photos,camera
node podium/test/e2e/polls-server.mjs --only polls
node podium/test/e2e/core.mjs --only freeze
```

> [!NOTE]
> `--only` is for rapid iterative debugging. Within a group, later sections can build on state an earlier one left behind, so a filtered run is a convenience; the group's full run is the contract. Always run the full suite before committing or pushing changes.

### Key Scenarios Verified by E2E Tests

- **Freeze & Cue Safety:**
  - Freeze holds the live screen frame-perfect while paging through slides in cue.
  - Cueing a layout change holds back until TAKE is explicitly pressed.
  - Audio and video play/pause remain responsive even while visual freeze is engaged.
- **Live Handwriting & Ink:**
  - Ink strokes land accurately within slide bounds across all aspect ratios.
  - Rapid handwriting creates hundreds of vector strokes without disconnecting the WebSockets.
  - Annotations survive panel layout transitions (`2h` &rarr; `single`) and device reloads.
- **Presenter Tools:**
  - Laser pointer tracks touch drag in real-time, displays chosen color swatch, and disappears immediately on release.
  - Multiple countdown timers run concurrently and project side-by-side.
  - Document camera initiates synthetic WebRTC video stream without user permission prompts.
  - Now/Next confidence monitor scales correctly across tab switches.
- **Audio & Media Mixer:**
  - Master volume fader and individual channel faders multiply levels accurately.
  - Mute instantly silences both channels without losing slider positions.
  - Background music ducks automatically when a lecture video clip plays.
- **Audience Polls:**
  - Audience votes submitted via HTTP POST reflect in real-time on presenter controller.
  - Student join codes gate questions, and results remain private until explicit "Reveal to room".
  - Poll history is preserved in session archives and exportable as CSV.
- **Security & Multi-User Accounts:**
  - Controllers with incorrect passphrases or unauthenticated cookies are rejected by the relay.
  - Session cookies use `HttpOnly` and `SameSite` flags.
  - Uploaded files are served with strict MIME type enforcement, preventing arbitrary HTML/script execution.

---

## 4. Continuous Integration (CI)

All tests are automated in GitHub Actions (`.github/workflows/podium-tests.yml`):
- **Lint Job:** Runs ESLint (see above) on every push and pull request touching `podium/**`.
- **Fast Unit Test Job:** Runs immediately on every push and pull request touching `podium/**`.
- **E2E Integration Job:** Runs Playwright headless test across matrix environments to prevent regressions.
