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
└── e2e.mjs               # Full multi-browser end-to-end integration test suite
```

---

## 1. Running the Unit Tests

The unit tests run directly in Node.js without requiring any build step, headless browser, or npm installation.

Run all unit tests:
```bash
node podium/test/protocol.test.mjs
node podium/test/plan.test.mjs
node podium/test/store.test.mjs
node podium/test/pacing.test.mjs
node podium/test/bottombar.test.mjs
```

Or run them in a single command:
```bash
node podium/test/protocol.test.mjs && \
node podium/test/plan.test.mjs && \
node podium/test/store.test.mjs && \
node podium/test/pacing.test.mjs && \
node podium/test/bottombar.test.mjs
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

The E2E suite (`podium/test/e2e.mjs`) is an exhaustive integration test. It:
1. Generates its own self-contained audio and media fixtures dynamically in memory (no external downloads needed).
2. Spawns an internal relay server on an ephemeral port.
3. Launches real headless Chromium browser pages representing the **Display** and two independent **Controllers** simultaneously.
4. Executes over 540 rigorous checks simulating real-world classroom situations.

### Prerequisites

Install Playwright and Chromium:
```bash
npm install playwright
npx playwright install chromium
```

### Running the E2E Test

Run the complete test suite:
```bash
node podium/test/e2e.mjs
```

### Running Targeted Sections

During development, you can run specific test sections using the `--only` filter to save time:

```bash
node podium/test/e2e.mjs --only ink
node podium/test/e2e.mjs --only photos,camera
node podium/test/e2e.mjs --only polls
node podium/test/e2e.mjs --only freeze
```

> [!NOTE]
> `--only` is for rapid iterative debugging. In the full test run, subsequent sections build on state created by earlier steps. Always run the full test suite before committing or pushing changes.

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
- **Fast Unit Test Job:** Runs immediately on every push and pull request touching `podium/**`.
- **E2E Integration Job:** Runs Playwright headless test across matrix environments to prevent regressions.
