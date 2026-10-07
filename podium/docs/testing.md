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
├── quicklook-open.test.mjs # Quick Look's handover to a new tab: one-use tokens, the deck editor's live rehearsal (Issue #242)
├── recent-decks.test.mjs # The deck editor's recent decks, and what each person may do with each library file (Issue #241)
├── my-files.test.mjs   # My Files: your own password, your courses, moving a file, who added it (Issue #243)
├── documents.test.mjs  # Markdown documents: deck or document, switching, a document in the room, the page's safety, outline and notes (Issue #240)
├── plan-archive.test.mjs # Archiving lectures from one's own planner list: personal, bulk, what may be archived (Issue #239)
├── deck-templates.test.mjs # Deck templates: built-in, course and personal, and who may change which (Issue #226)
├── deck-mermaid.test.mjs # Mermaid diagrams in decks: which theme each is drawn in, and what a broken one says (Issue #235)
├── deck-diagrams.test.mjs # Diagrams in the deck editor: mermaid.live links in and out, starters, pictures in a .zip (Issue #235)
├── offline-shell.test.mjs # The offline shell warms everything the pages load at startup (Issue #130)
├── a11y.test.mjs         # Accessibility guard rails: labels, names, live regions, contrast, focus (Issue #156)
├── kiosk-open-paths.test.mjs # Kiosk and Guest View open-path lists match what the pages load (Issues #151, #150)
├── pptx-convert.test.mjs # PowerPoint-to-PDF conversion via LibreOffice (Issue #107)
├── recap.test.mjs        # Lecture recap assembly: timeline, captions, polls, kept pictures (Issue #158)
├── view-codes.test.mjs   # Typed Guest View codes and their rate limiting (Issue #150)
├── zip-import.test.mjs   # Inspecting a ZIP before import, and the limits on hostile archives (Issue #106)
├── zip-staging.test.mjs  # ZIP import end to end on the server: stage, review, commit (Issue #106)
├── e2e.mjs               # Runs every end-to-end group below
└── e2e/
    ├── harness.mjs       # Shared setup: fixtures, relay, browser, ok()/trap()/--only
    ├── core.mjs          # Switching, connection, settings, offline, the display basics
    ├── ink-layout.mjs    # Ink, split layouts, picture-in-picture, keeping what was on screen
    ├── media.mjs         # Camera, music, audio, clocks, captions, PDFs
    ├── polls-server.mjs  # Polls, plans, accounts, multi-device rooms
    └── editor.mjs        # The deck editor: library, planner, content/decks, drafts (Issue #226), diagrams (Issue #235); the planner's archive (Issue #239); Quick Look (Issue #242); choosing files from the server (Issue #241); My Files (Issue #243); markdown documents (Issue #240)
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
- **`quicklook-open.test.mjs`**: how a page hands something to a Quick Look tab on the same device (Issue #242), against Node's own BroadcastChannel: which item types can be looked at, a library file opening by its id, a one-use token (asked twice, or a token nobody handed over, gets nothing), a tab that opens before its item is ready, an item that could not be gathered saying why, and the deck editor's rehearsal handover answering reloads and sending each new version until it is closed.
- **`my-files.test.mjs`**: My Files (Issue #243): your courses as the admin set them (role in each, archived ones marked, an admin's own rather than every course), each library file's uploader by name, moving your own file between courses (refused for a course you are not in, an archived one, or someone else's file), and changing your own password: too short is refused before anything is checked, a wrong current one changes nothing, the right one ends every other session (and nobody else's) while handing back a fresh one, both are audited, and guessing is throttled with the login's own counters.
- **`documents.test.mjs`**: markdown documents (Issue #240): `marp: true` decides deck or document (front-matter variants, and the server's own copy of the rule agreeing); the library's kinds (an old deck stays a deck, a document has a deck's stable address and edit rule, switching only between the two and only for whoever may change the file); a document in the room's state (positions held to the page, Next most of a screen, a later height from its pictures, ink keyed by position, notes stripped for a viewer); and the page itself (no script, event attribute or `javascript:` link survives, allowed layout kept, the heading outline, comments as notes never in the page, maths drawn and money left alone, task lists, `mermaidTheme`, dark), plus which notes and heading go with what is on screen, and the transform that pins ink to a document's page (screen ↔ page, round trips, 16:9, 4:3 and 21:9 screens).
- **`recent-decks.test.mjs`**: the planner's *Choose from the server* (Issue #241): the decks someone opened or saved in the deck editor (newest first, one row each, saved staying saved, only addresses of decks on this server, never a deck they can no longer see, a dozen listed and a few dozen kept), and the per-file `may` the library now reports (owner, TA, a TA's own upload, a no-course deck, an admin), checked against the rules the server enforces.
- **`plan-archive.test.mjs`**: archiving lectures from the planner's list (Issue #239): it is one person's (a co-instructor's list is untouched, and the plan itself does not change), `?archived=` narrows the list, bulk archive and unarchive, a lecture you cannot see is skipped rather than archived, the limits on a request, and a deleted lecture leaving both lists.
- **`deck-templates.test.mjs`**: the deck editor's templates (Issue #226): who sees a course's and a person's own, who may add, rename, rewrite and remove them, the size cap, the built-ins' `index.json`, and an administrator hiding a built-in.
- **`deck-mermaid.test.mjs`**: diagrams in decks (Issue #235): the theme a diagram is drawn in when the deck decides (light, dark, gaia's colours, a course theme's brand colour, gradient backgrounds), when `mermaidTheme` does, that `strict` security is never relaxed, and how Mermaid's errors are shortened for a slide. Which slides a `mermaidTheme` reaches is checked against the real Marp engine in `deck-source.test.mjs`; drawing itself is in the editor's end-to-end group.
- **`deck-diagrams.test.mjs`**: the deck editor's diagram conveniences (Issue #235): mermaid.live links made and read back (`#pako:`, the older `#base64:`, `/view` and mermaid.ink, a theme carried over or left to the deck, broken and empty links), the ◇ Diagram starters, which block the cursor is in, and the picture comments a `.zip` export adds after each diagram (a directive rather than a note, replaced rather than added to, and taken out again on the way back in).

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
