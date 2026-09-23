# Podium Features & Lecture Guide

Podium is designed for real classroom lectures. It gives you total control over what is displayed on the projector from an iPad or phone in your hand, while keeping the classroom computer completely untouched.

---

## Table of Contents

- [The Core Model: Freeze is a Cue](#the-core-model-freeze-is-a-cue)
- [Marp Slide Decks in Markdown](#marp-slide-decks-in-markdown)
- [The Presenter View (Now, Next & Notes)](#the-presenter-view-now-next--notes)
- [Live Ink Annotations](#live-ink-annotations)
- [Laser Pointer](#laser-pointer)
- [Full-Screen Messages](#full-screen-messages)
- [Live Captions](#live-captions)
- [Media Playback & Background Music](#media-playback--background-music)
- [Screen Layouts & Split Screen](#screen-layouts--split-screen)
- [Timers & Lecture Pacing](#timers--lecture-pacing)
- [Document Camera & Photo Capture](#document-camera--photo-capture)
- [Audience Polls & Interactive Questions](#audience-polls--interactive-questions)
- [Automated Presentation Sets](#automated-presentation-sets)
- [Watermarks](#watermarks)
- [Planning Lectures with `plan.html`](#planning-lectures-with-planhtml)

---

## The Core Model: Freeze is a Cue

In standard presentation software, freezing the screen holds a static frame. In Podium, **Freeze is a video switcher cue**:

- **Freeze**: The classroom projector freezes the current live display. Everything you do on your iPad from then on lands in the **Cue** (preview) rather than going live.
  - You can flip ahead through slides to check upcoming material.
  - You can load a YouTube video, scrub past ads, and queue it to the exact timestamp (e.g. 3:15).
  - You can open a PDF document and navigate to page 42.
- **TAKE**: Cuts the cued item live to the projector and unfreezes. The switch is instantaneous because both content layers are already loaded in memory.
- **Swap**: Swaps the on-screen item and the cued item without unfreezing, allowing you to preview both before showing the room.
- **Clear Cue**: Abandons whatever is queued and leaves the live screen untouched.
- **Blank**: The panic button. Instantly blacks out the projector while keeping everything loaded underneath. One tap restores the display.

---

## Marp Slide Decks in Markdown

Podium natively renders [Marp](https://marp.app/) Markdown decks directly inside the browser using client-side Web Workers:

- **Markdown Simplicity**: Write slides using standard markdown separated by `---`.
- **KaTeX Math**: Include inline LaTeX math (`$E=mc^2$`) and block math (`$$\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}$$`) with zero setup.
- **Presenter Notes**: Use HTML comments (`<!-- presenter notes go here -->`) to display notes privately on your iPad that the audience never sees.
- **Progressive Builds**: Use list bullets or `<!-- fit -->` directives to progressively reveal slide content one item at a time.
- **Custom CSS Themes**: Add custom styles and CSS themes to the top of your markdown files.

---

## The Presenter View (Now, Next & Notes)

The **Slides** tab provides an integrated confidence monitor:
- **Now Box**: A 1:1 live mirror showing exactly what the audience is looking at.
- **Next Box**: A preview of the upcoming slide or bullet point so you never have to turn around and look at the screen.
- **Presenter Notes**: Scrollable, readable notes corresponding to the active slide.
- **Confidence Split Toggle**: Tap to cycle the Now/Next pane split between 50/50, 75/25, and 25/75.
- **Jump to Slide Grid**: Tap "Jump to a slide" to view thumbnails of the entire presentation with captions. Slides that have ink drawings display an indicator badge.

---

## Live Ink Annotations

Annotate over any slide, PDF, image, or whiteboard with an Apple Pencil or stylus:
- **Zero Latency Vector Ink**: Draws locally on the iPad first for instantaneous feedback, then synchronizes vector strokes to the projector over WebSockets.
- **Surface Anchoring**: Ink is mathematically anchored to the content bounds. If a slide is 16:9 letterboxed on a 4:3 projector, ink stays pinned to the slide elements even if the layout changes.
- **Pen, Highlighter & Stroke Eraser Tools**:
  - **Pen**: Opaque solid line for writing, sketching, and diagrams.
  - **Highlighter**: Semi-transparent (35% opacity) broad stroke designed to emphasize slide text, equations, or diagrams without obscuring content beneath.
  - **Targeted Stroke Eraser**: Tap or swipe across individual strokes to remove them via vector hit-testing without wiping the whole board or reversing newer annotations.
- **Stylus & Apple Pencil Hardware Support**: Physical stylus eraser tips or barrel buttons automatically trigger eraser mode while in contact. Keyboard shortcuts `1` (Pen), `2` / `H` (Highlighter), `3` / `E` (Eraser) enable fast tool switching, and `Cmd/Ctrl+Z` undoes the last stroke on a physical keyboard.
- **Undo**: A dedicated Undo button removes the most recently drawn stroke on the focused surface — the fast recovery for a slipped hand, distinct from the targeted eraser above, which is for removing a specific older stroke.
- **Exporting Annotations**: At the end of class, export all annotated slides and whiteboard diagrams as high-resolution PNGs bundled in a session `.zip`.

---

## Laser Pointer

Turn your iPad screen into a virtual laser pointer:
- Tap **Laser** in the Slides tab (or use the bottom-bar shortcut slot).
- Drag your finger across the Now preview box. A bright, focused laser dot follows your finger on the classroom projector.
- Available in red, green (for dark slides/photos), or blue (for bright slides).
- Automatically disappears the moment you lift your finger.

---

## Full-Screen Messages

Put words on the projector without touching your slides — "Back in 5", a discussion prompt for group work, a title card while people file in:
- Tap **Compose a message…** in the Say tab. A dedicated editor opens with a live preview, rendered by the same code that draws the projector, so what you see is what the room gets.
- Write with a light markdown: `# Heading` / `## Subheading`, `**bold**`, `*italic*`, `` `code` ``, `- bullet` (or `*`) lists, and `1. numbered` lists. Line breaks are kept as written.
- Choose a size (Small–Huge), left or centred alignment, and one of five fonts (Sans, Serif, Monospace, Rounded, Bold display).
- Pick a background from five presets or a custom colour picker.
- Optionally attach a picture with a caption underneath the text — the same resizing pipeline as any other photo in Podium, so it survives the trip over the relay.
- Tap **Show** to stage it; **Cancel** or Escape closes the editor without changing what's on screen.

---

## Live Captions

Real-time captions along the bottom of the projector, for a hearing-impaired or ESL student in the room, generated from the instructor's own speech:
- Tap **Start live captions** in the Say tab. Recognition runs on that device's microphone using the browser's own speech recognition — nothing to install, nothing to configure, and off by default.
- Captions ride the same bottom bar as the manual "Caption along the bottom" overlay above it, and clear themselves after a few seconds of silence rather than sitting on the last thing said for the rest of class.
- Typing a manual caption while captions are running takes over the bar immediately; the next recognized phrase does not overwrite it.
- **The trade-off, stated plainly**: in Chrome and Edge, this sends the room's audio to Google's servers for recognition — outside Podium's own end-to-end encryption entirely, since it happens inside the browser's own code. Safari recognizes on-device instead. Firefox has no speech recognition at all. See [Security & End-to-End Cryptography](architecture.md#security--end-to-end-cryptography) for the full picture.

---

## Media Playback & Background Music

Podium gives you dedicated remote transport controls for all media:
- **Videos & Audio Files**: Play, pause, scrub timeline, restart, and toggle looping.
- **YouTube Embeds**: Full playback control and scrubbing directly from the iPad without ever exposing the YouTube website or recommendations to the room.
- **Master Audio Mixer**:
  - Top bar / bottom bar master volume slider scales all classroom audio together.
  - Master Mute button silences the room immediately.
  - Independent channel faders for content media vs. background music.
- **Pre-Class Background Music**:
  - Queue playlists to play music as students enter the room.
  - Automatically ducks under lecture video when content media is played.

---

## Screen Layouts & Split Screen

Divide the classroom projector into multiple simultaneous panels using the layout picker in the top bar:
- **Single**: Standard fullscreen presentation.
- **2h (Side by Side)**: Compare two items (e.g. code on the left, live web output on the right; or lecture slide on the left, blank whiteboard on the right).
- **2v (Stacked)**: Top and bottom split.
- **3 (One Large, Two Small)**: Large main slide flanked by two supplementary panels.
- **4 (Quad Grid)**: Four equal quadrants.

Each panel independently maintains its own focused item, zoom level, and ink annotations.

---

## Timers & Lecture Pacing

- **Topbar Local Clock**: Displays real-time local wall clock time in tabular digits.
- **Persistent Pacing Clock**: Set a lecture budget (e.g., 50 minutes) in **Settings &rarr; Presentation**. Shows an elapsed progress bar that turns amber at $\ge 85\%$ time and flashes red if you run overtime.
  - Auto-starts the first time you unblank or advance a slide.
  - Survives browser refreshes in `localStorage`.
- **Classroom Countdown Timers**: Run independent countdown clocks on screen for group work, quizzes, or lab exercises.

---

## Document Camera & Photo Capture

- **Phone Camera as Document Camera**: Open Podium on your smartphone and tap the Camera tab. Your phone streams high-frame-rate video directly to the classroom projector over local WebRTC.
- **High-Resolution Snapshots**: Tap photo capture to grab a crystal-clear snapshot of student work or handwritten paper, holding it in one panel while continuing your lecture in another.

---

## Audience Polls & Interactive Questions

Engage your class without requiring third-party software or student logins:
- **Multiple Choice & Short Answer**: Compose questions on the fly or load planned questions from your lecture plan.
- **Instant Student Joining**: Students scan a QR code displayed on the screen to reach `join.html` on their phones.
- **Presenter Privacy**: Incoming student votes appear live on the iPad controller. Results remain private until you explicitly tap **Reveal to room**.
- **Session History & CSV Export**: Download poll results as CSV files after class.

---

## Automated Presentation Sets

Create timed, automated rotations of items:
- Perfect for pre-class announcements, lab rules, rotating schedules, or sponsor slides.
- Set per-slide display durations (e.g., 10 seconds per announcement).
- Automatically pauses when you switch focus or begin teaching.

---

## Watermarks

Pin your university logo, course number (e.g. `CS 101`), or date to any corner of the projector display. The watermark remains persistently anchored across all slide transitions and split-screen layouts.

---

## Planning Lectures with `plan.html`

The **Plan** page (`plan.html`) is designed for your office computer:
- Drag-and-drop your slides, PDFs, YouTube URLs, and notes into an ordered running order.
- Test slide timings and configure timers.
- Export as a single `.podium` file to load onto your iPad, or sync directly via the self-hosted server.
- On a self-hosted server, **Update the copy already there** overwrites a lecture you previously sent instead of leaving a duplicate behind, and **Delete from server** removes one you no longer need — the plan file on your own machine, if you saved one, is untouched either way.
- **Start in picture-in-picture.** Under *Screen layout to start in*, the PiP layout lets a plan choose which pane fills the screen, which is the inset, the inset's corner and its size. Auto-launch then stages what each pane shows when the plan is opened in class.

### Importing a whole folder (ZIP)

On a self-hosted server, both the planner (under **Add**) and the admin page (**Global Content → Pre-load Files**) take a ZIP of a lecture's materials at once: slide images exported from PowerPoint or Keynote, Marp decks, PDFs, audio, video and photos. Podium sorts what it finds and shows one review screen before anything is imported:

- A folder of numbered images (`Slide1.png`, `Slide2.png`, … or Keynote's `Name.001.png`) becomes one **picture deck**, stepped through like any other deck. Split it into separate photos from the same row if that guess was wrong.
- Rename anything, untick what you do not want, and decide on anything Podium was not sure about (the same slide number twice, say). PowerPoint files are not converted; export them as images or a PDF first.
- **From the planner**, everything goes into the server library for a course you choose (or everyone), and by default into this lecture's running order too. A file already in the library is shown as such and not added twice. The planner never takes HTML.
- **From the admin page**, files go into the matching `content/` folder; an exported web deck (a folder with an `index.html`) keeps its layout under `content/slides/`. A name that is already taken gets a number added, shown on the review screen before you import. Each item can also be added to the Library manifest.

The upload is kept on the server only until you import or cancel, and is cleared away after two hours if you do neither. The largest ZIP it accepts is an admin setting (200 MB unless raised).
