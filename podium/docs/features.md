# Podium Features & Teaching Guide

Podium is built for real classroom lectures. It gives you complete control of the projector from an iPad or phone in your hand, while the classroom computer stays untouched. This guide covers every feature, grouped by what you're trying to do.

> **Legend:** 🖥️ marks features that need Podium's own self-hosted server. Everything else works on every setup, including free GitHub Pages hosting with a public MQTT broker or Supabase. For a visual overview, see the [Podium Guide](../guide.html).

---

## Contents

1. **[Presenting](#part-1--presenting)**: Freeze is a cue · The library · Marp decks · Now/Next/Notes · PDFs · Layouts & PiP
2. **[Drawing & Pointing](#part-2--drawing--pointing)**: Live ink · Whiteboards · Laser · Spotlight
3. **[Media & Sound](#part-3--media--sound)**: Transport · Background music · Mixer · Controller microphone
4. **[On-Screen Tools](#part-4--on-screen-tools)**: Timers · Messages · QR codes · Watermarks · Automated sets
5. **[Engaging the Room](#part-5--engaging-the-room)**: Polls, quizzes & Q&A 🖥️ · Document camera · Guest View
6. **[Accessibility](#part-6--accessibility)**: Live captions · Pre-scripted captions · Screen readers & themes
7. **[Sharing the Lectern](#part-7--sharing-the-lectern)**: Pairing · Several controllers · Simple Mode
8. **[Planning Lectures](#part-8--planning-lectures)**: `plan.html` · ZIP import 🖥️ · PowerPoint 🖥️
9. **[Making the Controller Yours](#part-9--making-the-controller-yours)**: Tabs, dock & clickers · Comfort settings · Pacing clock · Keyboard shortcuts
10. **[After Class](#part-10--after-class)**: Session export · Lecture recaps 🖥️ · Session history 🖥️
11. **[Your Own Server](#part-11--your-own-server)** 🖥️: Accounts & courses · Kiosks · Operations

---

## Part 1 — Presenting

Show anything, and never cut to something you haven't looked at first.

### The Core Model: Freeze is a Cue

In standard presentation software, freezing the screen holds a static frame. In Podium, **Freeze is a video switcher cue**:

- **Freeze**: The classroom projector freezes the current live display. Everything you do on your iPad from then on lands in the **Cue** (preview) rather than going live.
  - You can flip ahead through slides to check upcoming material.
  - You can load a YouTube video, scrub past ads, and queue it to the exact timestamp (e.g. 3:15).
  - You can open a PDF document and navigate to page 42.
  - You can open a deck you never loaded before class. The **Slides** tab switches to the cued deck (marked **Cued, not on screen yet**), so you can read its notes, page through it and check the thumbnails while the room still sees what it saw.
  - You can **mark it up**. Ink drawn on panel A while frozen is held back from the room: on the cued item if one is cued, otherwise on what is already on screen. Your pad shows it over the live ink, and the Ink tab says it's being held.
- **TAKE**: Cuts the cued item live to the projector and unfreezes. The switch is instantaneous because both content layers are already loaded in memory. Any held ink is revealed at the same moment, so a marked-up slide appears finished. Held ink on its own is enough to arm TAKE: the cue bar reads **Ink cued**.
- **Unfreeze** without TAKE leaves the cue (and any held ink) waiting for a later TAKE.
- **Swap**: Swaps the on-screen item and the cued item without unfreezing, allowing you to preview both before showing the room.
- **Clear Cue**: Abandons whatever is queued, held ink included, and leaves the live screen untouched.
- **Blank**: The panic button. Instantly blacks out the projector while keeping everything loaded underneath. One tap restores the display.

### The Library: What You Can Show

The **Library** tab is where everything starts: tap a tile and it goes to the projector (or into the cue, while frozen). Tiles come from `content/manifest.json`, from a loaded lecture plan, from what you've saved on this device, and, on a self-hosted server, from the course library.

| Item type | What it is |
| :--- | :--- |
| **Marp deck** | A Markdown slide deck, rendered in the browser (see below). |
| **Picture deck** | A folder of numbered slide images (e.g. exported from PowerPoint or Keynote), stepped through like a deck. |
| **HTML slides** | An exported web deck, paged from the controller. |
| **PDF** | Paged, zoomable and pannable on the projector (see below). |
| **Video / Audio** | Local or linked files, with full remote transport. |
| **YouTube** | Embedded with remote transport, so the room never sees the YouTube site. |
| **Photo / Image** | Any picture. Upload one from the iPad's Photos or Files with **Upload a photo…**. |
| **Web page** | Any page that allows embedding. |
| **Text sign** | A simple card of text. |
| **QR code** | A QR code for any link, e.g. the course site. |
| **Timer** | A countdown panel. |

**Built-in quick tools** are always there (an administrator can toggle them on a server): **Black**, **Whiteboard**, **Chalkboard**, **Phone camera**, **Timer** and **We begin in…**.

- **Paste a link** (YouTube, image, video, PDF, any page) and press **Show**, or **Save** it to this device's library.
- **Open a Marp deck…** loads a `.md` file straight from the device.
- **Back to** remembers where you were, including the slide. Wander off to a photo mid-deck, and one tap returns you to the exact slide you left rather than restarting the deck in front of everyone.

### Marp Slide Decks in Markdown

Podium natively renders [Marp](https://marp.app/) Markdown decks directly inside the browser using client-side Web Workers:

- **Markdown Simplicity**: Write slides using standard markdown separated by `---`.
- **KaTeX Math**: Include inline LaTeX math (`$E=mc^2$`) and block math (`$$\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}$$`) with zero setup.
- **Presenter Notes**: Use HTML comments (`<!-- presenter notes go here -->`) to display notes privately on your iPad that the audience never sees.
- **Progressive Builds**: Use list bullets or `<!-- fit -->` directives to progressively reveal slide content one item at a time.
- **Custom CSS Themes**: Add custom styles and CSS themes to the top of your markdown files.

### The Presenter View (Now, Next & Notes)

The **Slides** tab provides an integrated confidence monitor:
- **Now Box**: A 1:1 live mirror showing exactly what the audience is looking at.
- **Next Box**: A preview of the upcoming slide or bullet point so you never have to turn around and look at the screen.
- **Presenter Notes**: Scrollable, readable notes corresponding to the active slide.
- **Confidence Split Toggle**: Tap to cycle the Now/Next pane split between 50/50, 75/25, and 25/75.
- **Jump to Slide Grid**: Tap "Jump to a slide" to view thumbnails of the entire presentation with captions. Slides that have ink drawings display an indicator badge.
- **Pop-out Preview**: **press and hold** a thumbnail to open that slide large, fully built, with its notes. Nothing is sent to the display, so it's safe mid-lecture. **Go to this slide** jumps there; **Close** (or Escape, or a tap outside) doesn't.
- **While frozen**, this tab works on the cue (see [Freeze is a Cue](#the-core-model-freeze-is-a-cue)). The Now box is relabelled **Cued**, and Laser and Spotlight are put away, since they point at what the room sees.

The **Now** tab always opens with a large live view of what the focused pane is showing the room. It never shows the cue, frozen or not. Below it are the transport controls for media, and paging and PDF zoom for documents. While frozen, a note says those controls are working on the cue.

### PDFs: Zoom and Pan on the Projector

PDFs page like a deck. When a PDF is focused, the **Now** tab adds zoom (1× to 4×) and four-way pan controls that change **what the room actually sees**, which is useful for a small figure or a dense table. Pan stops at the page's edges, so you never pan into empty letterboxing. Ink stays anchored correctly at any zoom level, and a zoomed page exports zoomed.

On a self-hosted server, **Upload/Load a PDF…** on the Library tab uploads straight into the library, and PowerPoint files are converted to PDF on upload (see [PowerPoint Uploads](#powerpoint-uploads)).

### Screen Layouts, Split Screen & Picture-in-Picture

Divide the classroom projector into multiple simultaneous panels using the layout picker in the top bar:
- **Single**: Standard fullscreen presentation.
- **2h (Side by Side)**: Compare two items (e.g. code on the left, live web output on the right; or lecture slide on the left, blank whiteboard on the right).
- **2v (Stacked)**: Top and bottom split.
- **3 (One Large, Two Small)**: Large main slide flanked by two supplementary panels.
- **4 (Quad Grid)**: Four equal quadrants.
- **PiP (Picture-in-Picture)**: One pane fills the screen and another sits as a small inset in a corner you choose, at the size you choose. Good for a document camera over a slide, or a timer over a video.

Each panel independently maintains its own focused item, zoom level, and ink annotations. The **A/B/C/D** buttons in the top bar pick which panel your next Library tap, deck navigation and ink go to. **⛶ Full screen this** takes whatever is in a focused B/C/D panel and makes it the single full-screen item in one tap.

---

## Part 2 — Drawing & Pointing

Write on anything with an Apple Pencil, a stylus or a finger.

### Live Ink Annotations

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

#### More ink controls

- **Colours and thickness**: preset colours plus a custom colour picker, and a thickness slider.
- **Undo clear**: **Clear** stays one tap because clearing a board is a deliberate, frequent move. For a few seconds afterwards, **Undo clear** brings the whole drawing back.
- **Snap lines and shapes on hold**: pause about half a second at the end of a stroke and it snaps into a clean straight line, arrow, rectangle or circle. Turn this on or off in **Settings → Presentation**.
- **Apple Pencil only**: ignore finger touches on the pad so a resting palm never draws.
- **Pad zoom**: zoom the drawing pad on your device (not the projector) and pan with the arrows for precise work.
- **Scroll border** and **tools above the slide** (Settings → Presentation): leave a 10% margin around the slide for finger scrolling, and move the tool row to the top of the screen.
- **Markup** on the Slides tab jumps straight to the Ink tab, already lined up on the current slide.

### Whiteboards & Chalkboards

The Library's **Whiteboard** and **Chalkboard** give you a blank surface to draw on. They're the fastest way to work a problem out in front of the room. Put one in a split-screen panel beside a slide to annotate *about* the slide without covering it. **W** on a keyboard, or the **Quick Whiteboard** bottom-bar slot, puts one up instantly. To keep a board, press and hold its panel letter (A/B/C/D) to photograph it with the ink burnt in (see [After Class](#part-10--after-class)).

### Laser Pointer

Turn your iPad screen into a virtual laser pointer:
- Tap **Laser** in the Slides tab (or use the bottom-bar shortcut slot).
- Drag your finger across the Now preview box. A bright, focused laser dot follows your finger on the classroom projector.
- Available in red, green (for dark slides/photos), or blue (for bright slides).
- Automatically disappears the moment you lift your finger.

### Spotlight

**Spotlight** dims the whole projector except a soft circle that follows your finger across the Now box, so the room looks at one line of an equation or one bar of a chart. It's on the Slides tab next to Laser, in the Ink tab's tool row, and available as a bottom-bar shortcut. Like the laser, it vanishes when you lift your finger and nothing is saved.

---

## Part 3 — Media & Sound

A real transport and a real mixer, operated from across the room.

### Media Playback & Background Music

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

#### Background music in detail

- Playlists come from `content/music.json` (or the admin page's **Music Playlists** on a server), and each track can live anywhere reachable, including your own server. Track lengths show in the picker and the queue.
- **Load**, **Add to queue**, or paste a link to any audio file and **Queue it**. **Auto-play** runs the queue on its own, **Shuffle the rest** mixes up what's left, and **Pause Queue** holds after the current track.
- **Fade out & stop** takes the room quiet over three seconds when class begins.
- **⏳ Show "We begin in…" on screen** puts up a panel counting down to the end of the current track, with editable text, so the room can see when you're starting.
- Music keeps playing while you teach. Picking content, freezing and blanking don't touch it.

#### The Mixer

The **Mixer** tab gives each thing that makes sound its own fader, instead of one volume slider shared by all of them:

- **Master**: everything the room hears. It's also on the bottom bar of every tab, for "it's too loud right now".
- **Loaded audio / video**: whatever is playing on a panel.
- **Background music**: heard, never shown.
- **Controller mics**: every microphone amplified through the display.

A channel's level and the Master multiply together, and the bottom bar's **mute** silences every channel at once.

### The Controller Microphone

The **Say** tab can turn the controller's own microphone on (**Start my mic**). This is separate from live captions, which use the browser's speech recognition and never touch a recording.

- **Play through the display's speakers** amplifies your voice (or a co-presenter's, or a student's answering from their own device) through the classroom PC's audio. Several controllers can have a live mic at once. They get their own **Controller mics** channel on the Mixer, and an amplified mic ducks background music the way a video does. It's off by default, and the controller warns you it can howl with feedback if the device is near the display's speakers.
- **Record this mic to the session** (self-hosted server that records sessions): the audio is uploaded in short, independently playable segments as you go, so a lecture that ends early still keeps what was already recorded.

---

## Part 4 — On-Screen Tools

The small things a lecture needs, one tap away.

### Countdown Timers

- **Up to four independent countdowns**, each shown as a chip with its own clock, so you can see all of them at once.
- Preset buttons (1, 2, 5, 10, 15 minutes), replaced by a lecture plan's own saved timers when one is loaded.
- **Put this one on screen** stages the selected timer. Split the screen and two can be on the projector at once.
- Countdowns run on the display, so they stay accurate even if your iPad sleeps. The **R** key and the **Quick Countdown** bottom-bar slot start, pause or resume the selected one.

### Full-Screen Messages

Put words on the projector without touching your slides — "Back in 5", a discussion prompt for group work, a title card while people file in:
- Tap **Compose a message…** in the Say tab. A dedicated editor opens with a live preview, rendered by the same code that draws the projector, so what you see is what the room gets.
- Write with a light markdown: `# Heading` / `## Subheading`, `**bold**`, `*italic*`, `` `code` ``, `- bullet` (or `*`) lists, and `1. numbered` lists. Line breaks are kept as written.
- Choose a size (Small–Huge), left or centred alignment, and one of five fonts (Sans, Serif, Monospace, Rounded, Bold display).
- Pick a background from five presets or a custom colour picker.
- Optionally attach a picture with a caption underneath the text — the same resizing pipeline as any other photo in Podium, so it survives the trip over the relay.
- Tap **Show** to stage it; **Cancel** or Escape closes the editor without changing what's on screen.

### QR Code for the Class

The **Say** tab's **QR code for the class** puts any link (the course site, a reading, a survey) on screen as a big scannable code, without adding it to the library first.

### Watermarks

Pin your university logo, course number (e.g. `CS 101`), or date to any corner of the projector display. The watermark remains persistently anchored across all slide transitions and split-screen layouts.

**A default per course** (Issue #157): on a self-hosted server, a course owner or an admin can set a default watermark — text, a logo, and a corner — from the course's card on the admin page's **Courses** tab. A **new** lecture held in that course's room starts with it, so the same name or logo is not re-entered every session. It is only where a lecture starts:

- It is still changed or hidden from the Say tab like any other watermark.
- A watermark the presenter set themselves (typed or uploaded from the Say tab, now or in an earlier session) always wins; the course default never replaces it.
- A course default does not linger into another course's lecture: on a classroom PC shared between courses, the next new lecture swaps it for that course's default, or takes it down if that course has none. Hiding or moving a course default for one lecture does not stop the next lecture of that course starting with it.
- Reloading the display mid-lecture resumes the same lecture and does **not** put the default back — a logo taken down ten minutes ago stays down.
- A logo is shrunk to a small PNG on upload, the same way the Say tab's own logo upload is, so transparency survives.

### Automated Presentation Sets

Create timed, automated rotations of items:
- Perfect for pre-class announcements, lab rules, rotating schedules, or sponsor slides.
- Set per-slide display durations (e.g., 10 seconds per announcement).
- Automatically pauses when you switch focus or begin teaching.

---

## Part 5 — Engaging the Room

Participation with no apps, no accounts, and no third-party service.

### Audience Polls, Quizzes & Q&A

Engage your class without third-party software or student logins. Polls need Podium's **self-hosted server**, because students' phones talk to the server's poll endpoints rather than joining the encrypted room (see the [design notes](roadmap.md)). On Supabase or MQTT the Polls tab says so plainly.

**Three kinds of question**
- **Multiple choice**: add as many options as you need. Mark one **correct** to make it a quiz; the correct answer is shown only once you reveal it.
- **Short answer**: free text, with a **Word cloud** view of the answers.
- **Audience Q&A**: students submit questions and **upvote** each other's. The most-upvoted rise to the top, and from the controller you can mark a question answered, hide it, or put it on the projector.

**Running a poll**
- Stage it like anything else, on panel A or any of B/C/D. Only one poll runs at a time.
- Students scan the QR code, or type the four-letter code at `join.html`. Settings → Presentation can also spell out the full voting address under the QR code for a room where typing beats scanning.
- Add a voting countdown (**+30s**, **+60s**, **+2m**) that closes the poll automatically, or **Close voting** by hand.
- Results appear live on your controller and stay private until you tap **Reveal to room**. **End poll** finishes it.

**Names are optional, and off unless allowed.** An administrator decides whether presenters may collect participant names or IDs. When it's allowed, **Ask participants for name / ID** adds a prompt, and **Show names to room** is a separate choice from revealing results.

**Afterwards**
- **Export CSV** downloads the results.
- The **This session** list keeps every poll you've ended. **Reopen** loads the question back into the composer with fresh votes, and **Redisplay** puts the final results back on the projector exactly as they ended.
- On a server that records sessions, each poll's final result is kept with the lecture and appears in its [recap](#lecture-recaps).
- If the relay restarts mid-poll and votes are lost, the controller warns you rather than silently showing a smaller count.

### Document Camera & Photo Capture

- **Phone camera as document camera**: open the controller on your phone, go to the **Camera** tab and **Start camera**. The phone streams video straight to the classroom projector over a direct WebRTC connection. **Flip** switches between front and back cameras.
- **Take a photo** freezes a frame and keeps it. Tap the thumbnail to put it on the focused panel. Split the screen first and you can hold four students' answers up side by side, and each one can be annotated separately on the Ink tab.
- Photos are held in memory only and never written to the device unless you export them (see [After Class](#part-10--after-class)).

### Guest View: Watching on Your Own Device

Guest View (Issue #150) lets someone watch the live display on their own phone or laptop, with its sound: a student at the back of a big room, or someone who is not in the room at all. It is **watch-only**. Nothing a viewer does reaches the display.

**Handing it out**
- On the display, open **Pair a device** and choose **Guest view (watch only)**. Unlike the two control modes, this QR code stays up until you close it.
- Or, from any controller's **Say** tab, choose **Put the viewer QR on screen** to show the QR code (and the typed code) on the projector as content.
- On a server running Podium's own relay, there is also a **six-character code** for anyone who can't scan: they go to `…/view.html` and type it. The code stays the same from lecture to lecture, but it only works while the display is live. Guessing is rate-limited.
- The link and the code stay valid until you replace them. **New viewer link**, on the display's Guest view sheet, cuts off everyone holding the old link or code at once.

**What viewers see and hear**
- Exactly what is on the projector:
  - slides and decks, with presenter notes stripped out;
  - PDFs, pictures, video and audio, which viewers who join late catch up on;
  - whiteboards and ink, layouts and picture-in-picture, the watermark, captions, timers, polls, the laser and spotlight, and background music.
- Never the presenter's cue. Something you cue while frozen reaches viewers only when you take it, the same as the projector.
- A poll shows its question and how many have voted. Results and the correct answer appear only once revealed. Nobody's name next to their answer is ever sent, and neither is the poll's control token.
- Between lectures, a viewer sees "Not live right now", never the last thing that was on screen. It comes back on its own when the class goes live.
- **Not included:** live mic amplification and the document camera. Both are peer-to-peer and need a media relay to reach many viewers; that's future work.

**Who's watching:** controllers show a count next to the connection status, like "3 watching". The count never says who.

**How it's kept watch-only**
- The viewer link never contains the room passphrase. It opens a separate view channel with its own random room name and key, and the display sends only what's on screen there. Holding a viewer link gets you nowhere near the room itself.
- Everything the display sends viewers is **signed** with a key only the display holds. The link carries the matching public half, so a viewer can't show other viewers something the presenter never put up.
- **On a server with accounts:** viewers never sign in. Instead:
  - The relay lets an anonymous viewer onto a view channel only while a signed-in display is on it.
  - Viewers get a short-lived **viewer pass**. It reads the course files and library media the presenting account can read, and nothing else: no pages and no API. It stops working the moment the display stands down or the link is replaced.
  - The server keeps typed codes, and therefore view links, in memory so it can answer them. It never holds the room passphrase for this.

**Capacity:** on Podium's own relay, a view channel takes up to 300 viewers (`MAX_VIEWERS_PER_ROOM`). The 12-device limit for controllers and displays is unchanged. On MQTT or Supabase deployments, capacity is whatever that service allows. For now, viewers also receive every message the display sends the view channel. If audiences get very large, trimming that is a planned follow-up.

---

## Part 6 — Accessibility

For the students in the room, and for the person at the front of it.

### Live Captions

Real-time captions along the bottom of the projector, for a hearing-impaired or ESL student in the room, generated from the instructor's own speech:
- Tap **Start live captions** in the Say tab. Recognition runs on that device's microphone using the browser's own speech recognition — nothing to install, nothing to configure, and off by default.
- Captions ride the same bottom bar as the manual "Caption along the bottom" overlay above it, and clear themselves after a few seconds of silence rather than sitting on the last thing said for the rest of class.
- Typing a manual caption while captions are running takes over the bar immediately; the next recognized phrase does not overwrite it.
- **On a self-hosted server that records sessions**, each finished caption line is saved to the lecture's timeline (Issue #158) — the text only, never audio — so it can appear in the [lecture recap](#lecture-recaps). The arming screen says so alongside the rest of what is recorded. This covers typed and pre-scripted captions as well as live ones.
- **The trade-off, stated plainly**: in Chrome and Edge, this sends the room's audio to Google's servers for recognition — outside Podium's own end-to-end encryption entirely, since it happens inside the browser's own code. Safari recognizes on-device instead. Firefox has no speech recognition at all. See [Security & End-to-End Cryptography](architecture.md#security--end-to-end-cryptography) for the full picture.

### Pre-scripted Captions

Any item in a lecture plan can carry pre-written **caption or audio-description text**, entered in the planner beside that item's notes. When the item goes live on the main screen (panel A), whether staged directly, taken from the cue, swapped in, or advanced to by an automated set, its caption appears on the same bottom bar live captions use. When it leaves, the caption clears.

- Only the main (program) screen drives the bar. Captions on B/C/D panels never show.
- A **live** transcript always wins. A pre-scripted caption never overwrites what you're saying.
- This is the natural way to caption an unattended [kiosk](#kiosks--unattended-signage), and it works just as well between sentences in a live lecture.

### Screen Readers, Contrast & Themes

- The controller and display went through an accessibility pass: every control has a name a screen reader can say, toggles announce their state, connection changes and action results are announced through live regions, keyboard focus is always drawn, and text meets WCAG AA contrast. Automated tests keep it that way. The full findings, including what's still open, are in the [accessibility audit](accessibility.md).
- **Controller theme** (Settings → Presentation): **Dark** (default), **Light / High contrast** for bright rooms and window glare, or **Auto** to match the system.
- [Guest View](#guest-view-watching-on-your-own-device) puts the projector on a student's own screen, which helps anyone who can't see the wall well.
- Every lectern action has a [keyboard shortcut](#keyboard-shortcuts).

---

## Part 7 — Sharing the Lectern

Co-teachers, TAs and substitutes, without handing over your iPad.

### Pairing a Device

On the display, press **Pair a device** (or `P`) and choose what to hand out:

| Choice | Gives | QR behaviour |
| :--- | :--- | :--- |
| **Full control** (default) | A full controller for the room | Hides itself after 90 seconds |
| **Guest (Simple Mode)** | A substitute's clicker (below) | Hides itself after 90 seconds |
| **Guest view (watch only)** | A [Guest View](#guest-view-watching-on-your-own-device) link | Stays up until you close it |

Scanning a control QR opens the controller **already configured**: room, passphrase and connection all arrive in the link, after the `#` so they never reach a server log. Both devices then show the same **four-character code**. Matching codes confirm they can hear each other, and different codes mean a typo somewhere. Full control is the default every time the sheet opens, so a guest link is never left armed by the last person who used the machine.

On a server with accounts, a course can hold its room settings centrally, so a new iPad only needs a sign-in (see [Your Own Server](#part-11--your-own-server)).

### Several Controllers in One Room

Any number of controllers can join the same room: your iPad, a TA's phone, a laptop at the back. They all share one state (the same cue, the same freeze, the same screen), so a co-teacher can queue up the next clip while you talk. Podium's own relay allows up to 12 controllers and displays per room. The controller's top bar shows the connection, the round-trip time to the display, and how many guest viewers are watching.

### Simple Mode for Substitutes

`guest.html` is a stripped-down controller for someone handed a device cold: a substitute, a guest lecturer, a student presenting.

- Big **Previous / Next**, **Play/Pause** (for whatever video or audio is on screen), **Blank screen**, and a **Laser pointer** pad to drag on.
- **No freeze, cue or TAKE** to get wrong. Next and Blank always go straight to the projector, so a guest never disturbs anything the instructor has frozen and cued on their own controller in the same room.
- It needs no account even on a server with accounts. A device that hasn't been paired just says to ask whoever is teaching for the guest code.

---

## Part 8 — Planning Lectures

Do the fiddly part at your desk, not in front of forty people.

### Planning Lectures with `plan.html`

The **Plan** page (`plan.html`) is designed for your office computer:
- Drag-and-drop your slides, PDFs, YouTube URLs, and notes into an ordered running order.
- Set a **target length** (30 minutes to 3 hours) and watch the running order's planned minutes add up against it.
- Save **countdowns** for this lecture; each *Countdown* item gets its own timer, up to the room's four. They replace the iPad's preset buttons.
- Write **notes to yourself** per item, and optional [pre-scripted captions](#pre-scripted-captions).
- **Auto-launch on plan load**: stage what each pane shows, start background music and a countdown, and choose whether it all opens **live**, **staged in the cue** (behind Freeze), or **blacked out**.
- Upload files straight to the server library from an item 🖥️, and start a new lecture from your course's **template** 🖥️.
- Export as a single `.podium` file to load onto your iPad, or sync directly via the self-hosted server.
- On a self-hosted server, **Update the copy already there** overwrites a lecture you previously sent instead of leaving a duplicate behind, and **Delete from server** removes one you no longer need — the plan file on your own machine, if you saved one, is untouched either way.
- **Start in picture-in-picture.** Under *Screen layout to start in*, the PiP layout lets a plan choose which pane fills the screen, which is the inset, the inset's corner and its size. Auto-launch then stages what each pane shows when the plan is opened in class.

#### Importing a whole folder (ZIP)

On a self-hosted server, both the planner (under **Add**) and the admin page (**Global Content → Pre-load Files**) take a ZIP of a lecture's materials at once: slide images exported from PowerPoint or Keynote, Marp decks, PDFs, audio, video and photos. Podium sorts what it finds and shows one review screen before anything is imported:

- A folder of numbered images (`Slide1.png`, `Slide2.png`, … or Keynote's `Name.001.png`) becomes one **picture deck**, stepped through like any other deck. Split it into separate photos from the same row if that guess was wrong.
- A `.ppt`/`.pptx` file is converted to a PDF (see [PowerPoint Uploads](#powerpoint-uploads) below) and imported as one. Keynote, OpenDocument and the old "PowerPoint Show" formats are not; export those to images or a PDF first.
- Rename anything, untick what you do not want, and decide on anything Podium was not sure about (the same slide number twice, say).
- **From the planner**, everything goes into the server library for a course you choose (or everyone), and by default into this lecture's running order too. A file already in the library is shown as such and not added twice. The planner never takes HTML.
- **From the admin page**, files go into the matching `content/` folder; an exported web deck (a folder with an `index.html`) keeps its layout under `content/slides/`. A name that is already taken gets a number added, shown on the review screen before you import. Each item can also be added to the Library manifest.

The upload is kept on the server only until you import or cancel, and is cleared away after two hours if you do neither. The largest ZIP it accepts is an admin setting (200 MB unless raised).

#### PowerPoint Uploads

On a self-hosted server with LibreOffice installed (see [Installing LibreOffice for PowerPoint uploads](vps.md#installing-libreoffice-for-powerpoint-uploads)), a `.ppt` or `.pptx` file is converted to a PDF the moment it is uploaded, and plays with Podium's existing PDF viewer — the same page navigation, the same projector experience a hand-exported PDF already has. This works everywhere a PDF upload already does:

- The planner's **PDF** item, under *Upload to this server*.
- The admin page's **Global Content → Pre-load Files**, uploaded to the **PDFs** category.
- A `.ppt`/`.pptx` found inside a ZIP (see above).

The converted file is named after the original with `.pdf` in place of `.ppt`/`.pptx`; nothing about the upload — the size limit, who may use it, where it is filed — differs from uploading a PDF directly, since converting happens before anything is stored. Without LibreOffice installed, uploading one of these files fails with a plain error saying so, rather than a silent no-op; every other upload keeps working as it always has. Speaker notes are not carried over.

---

## Part 9 — Making the Controller Yours

Every teacher drives differently.

### Tabs, Dock & Clickers

- **Controller tabs** (Settings → Presentation): reorder the twelve tabs (Library, Slides, Now, Ink, Say, Timer, Camera, Photos, Music, Mixer, Sets, Polls) or hide the ones you never use. Hidden tabs are tucked under **More ▾**, never removed.
- **Bottom bar dock**: up to eight quick-action slots chosen from Music, Media Play/Pause, Freeze, Blank, TAKE, Clear Cue, Quick Whiteboard, Laser, Spotlight, Quick Countdown, and Slide Next/Prev. On a phone the first four show alongside the volume slider.
- **Split view**: on a wide iPad or laptop, show two tabs side by side, for example Slides beside Ink.
- **Hide cue bar**: tuck the cue sidebar away when nothing is cued to give Now/Next more room.
- A **Magic Keyboard or Bluetooth presentation clicker** drives the same actions (see [Keyboard Shortcuts](#keyboard-shortcuts)).

### Comfort Settings

All in **Settings → Presentation**, saved on that device only:
- **Black out the screen when this controller connects**, so nothing from a previous class is still up while you get ready. It fires once per fresh open, never on a reconnect or reload mid-lecture.
- **Keep this device's screen awake** while the controller is open.
- **Haptic feedback**: a physical tick when you advance, freeze, blank or TAKE, so you know a tap registered without looking down (on devices that support vibration).
- **Always cue first**: every pick waits in the cue, even when not frozen.

### Start Every Lecture With… (Saved Defaults)

Settings → Presentation → **Start every lecture with** remembers the controls you set the same way every class, on this device:

| Default | What it does |
| :--- | :--- |
| **Music: Auto-play, Pause Queue, "We begin in…" counts to the end of the queue** | Each is *Plan / as is*, *On* or *Off*. Auto-play also decides whether a plan's auto-launched music starts playing. |
| **Music: Countdown text** | The words on the "We begin in…" panel. |
| **Mixer levels** | Master, loaded audio/video, background music and controller mics. **Use the Mixer's current levels** copies them from the Mixer tab. |
| **Caption along the bottom** | Fills in the Say tab's caption box, ready to show. Nothing goes on screen until you press **Show**. |
| **Watermark** | Text, corner and an optional logo. It goes up automatically unless you've already put up a watermark of your own in this lecture, and it replaces a course's default watermark. |

**When they apply:** once when you open the controller in a new tab and it first finds the display (the same moment as *Black out the screen when this controller connects*: never on a reconnect, a reload, or closing Settings), and again every time a lecture plan loads, so they win over the plan's own music settings. The watermark is only applied on opening, so one you took down mid-lecture stays down when you load a plan. Anything left on *Plan / as is*, empty, or unticked changes nothing. **Clear all defaults** puts everything back to that.

### Lecture Pacing Clock

- **Topbar local clock**: displays the wall-clock time in tabular digits.
- **Persistent pacing clock**: set a lecture budget (e.g. 50 minutes) in **Settings → Presentation**. The top bar shows elapsed time and a progress bar that turns amber at 85% and flashes red if you run over.
  - Auto-starts the first time you unblank or advance a slide (optional). Tap the tracker to start or reset it by hand.
  - Survives browser refreshes.
- A lecture plan's **target length** in the planner shows how your running order adds up against the same budget.

### Keyboard Shortcuts

Both `control.html` (the controller) and `display.html` (the projector's own machine) answer a Magic Keyboard, a Bluetooth clicker, or any keyboard paired to that device. Press **`?`** on either page for the full, always-current list — typing into a field is never intercepted, and a modified key (Cmd/Ctrl/Alt) is never claimed, so a room name or a passphrase with a shortcut letter in it is just text.

On the controller, the letter keys mirror the same handful of actions the bottom-bar dock and Settings' clicker remapping already use (Take, Clear cue, Quick whiteboard, Music, Timer, Play/Pause, Next/Prev) — one action, three ways to reach it: a tap, a keystroke, or a physical clicker button. The highlights:

- **B** / **F** blank / freeze the screen, from any tab.
- **T** / **C** TAKE the cued item live, or clear the cue — a no-op with nothing cued, same as the dock buttons disabling themselves.
- **P** / **Shift+P** photograph the focused panel / the whole screen.
- **W** a quick whiteboard.
- **M** play or pause the loaded background playlist.
- **R** start, pause, or resume the currently-selected timer.
- **`[`** / **`]`** step through this device's own tab order — whatever Settings → Controller tabs has it set to, hidden tabs skipped, so reordering or hiding a tab changes what cycling through them means too, not just what they look like.
- **Space**, **←** / **→**, **PageUp** / **PageDown** page through a deck, PDF, HTML slides or web page — or, when the focused item is a video, audio clip or YouTube embed instead, **Space** plays or pauses it, the way it does in any other media player.
- On the **Ink** tab, **1**-**5** or **E H L S** pick a tool and **Ctrl/Cmd+Z** undoes; on the **Slides** tab, **L** / **S** toggle the laser pointer / spotlight.

`display.html`'s own card (also `?`) covers the far smaller surface that machine has of its own: going live, fullscreen, pairing, and Settings — paging, blanking and freezing live on the controller, not there.

---

## Part 10 — After Class

Take the lecture with you: the slides you marked up and what the room said.

### Session Export (ZIP & PDF)

Everything you keep during class lands on the **Photos** tab:
- frames frozen off the document camera;
- **press and hold a panel letter** (A/B/C/D) for a photo of that panel with its ink burnt in;
- **hold any layout button** (or **Shift+P**) for a shot of the whole screen, watermark included.

Then:
- **Export this session (.zip)…** downloads one ZIP with every photo, every deck slide you annotated (ink included), and every board or image you drew on. Ink lives on the display, so keep it connected while the ZIP is built.
- **Download as PDF…** produces the same material as one merged PDF, rendered on your device.
- The **⤓** on a single photo saves just that one. **Export marked-up slides (.zip)** on the Slides tab exports only the current deck's annotated slides.
- Nothing is written to the device until you export. **Discard every photo** clears them.

On a self-hosted server that records sessions, **Keep photos on the server with this lecture** (Photos tab, or the default in Settings → Presentation) stores them with the lecture record instead. It's off by default, because a photo is usually someone else's work. **Finish session & save** ends the lecture record and sends every display in the room back to its arming screen.

### Lecture Recaps

On a self-hosted server that records sessions, open a lecture on the admin page's **Sessions** tab and choose **Download the recap** (Issue #158) for one PDF of how the lecture went, in order:

- Everything that went on the projector — each slide, board, message or media item — with the time it went up.
- Under each entry, the caption lines said while it was on screen (see [Live Captions](#live-captions)). Lines said before anything went up get a section of their own at the top.
- An annotated slide the session kept, placed right after the moment that slide was shown.
- Each poll's final result, at the point it closed.
- At the end, anything kept that has no moment of its own — photos, boards, and annotated slides the timeline never recorded.

A lecture with no captions still makes a useful recap (slides and polls alone). The recap is a one-off export of what happened, like the session ZIP and PDF beside it; it is not edited afterwards. Caption lines also show in the session's timeline on the same page, and in the downloaded timeline text.

### Session History

On a server with accounts, the display writes down what it showed as it goes: a timeline of what went up and when, the ink, poll results, caption lines, and (if you opted in) photos and mic audio. The arming screen tells the room what is recorded. The admin page's **Sessions** tab lists past lectures, where you can:
- read the timeline, and download it as text;
- download a session's ZIP or PDF again, or its [recap](#lecture-recaps);
- **Download all sessions**, or **Delete sessions older than** a number of days.

A lecture nobody has heard from in 15 minutes closes itself. Retention is configurable; see [deploy/README.md](../deploy/README.md#session-records-and-how-long-they-are-kept).

---

## Part 11 — Your Own Server

Optional. Everything above still works without it.

### Accounts, Courses & the Admin Page

Running Podium's own server (`server/podium-server.js` with a `DATA_DIR`) adds a memory to the system. Everything below is optional, and every page still works without a server. The full design and reasoning is in [vps.md](vps.md), and installation is in [deploy/README.md](../deploy/README.md).

- **Accounts**: instructors and TAs sign in on a proper login page (no browser Basic Auth prompts). Administrators manage people; the CLI (`podium-admin`) is the recovery path.
- **Courses** are the unit of sharing. Library items and plans filed under a course are visible to its members. A course can hold its **room settings** (connection, room, passphrase), so a new device is just a sign-in, a **default watermark**, and a **plan template**.
- **The admin page** (`admin.html`) has tabs for **People** (accounts, audit log CSV, poll name policy, ZIP size limit), **Courses**, **Library** (browser uploads), **Global Content** (the library manifest, Marp themes with a live preview editor, pre-load files, music playlists, built-in tools), **Sessions**, **Storage** (with a disk-pressure warning on every tab), and **Kiosks**.
- **Plans on the server**: send a lecture from the planner and it's on the iPad in class without a file to carry. Update or delete it later; a plan file you saved stays untouched either way. Two edits to the same plan are caught rather than silently overwriting each other.

### Kiosks & Unattended Signage

A **kiosk** is a display nobody is running: a lobby screen, a hallway sign, a lab's rotating rules.

- **Kiosk mode** (a checkbox in the display's own setup) makes the display arm itself on every load (first boot, crash, reboot, power flicker) with no click needed, and never open a lecture record.
- **Kiosk profiles** (admin page → **Kiosks**, administrators only): name a kiosk, give it a room and connection, and assign the plan it **should be showing**. Provisioning a blank device is one scan of a QR code, which redeems a one-time link for the device's own long-lived credential. The passphrase never sits in a URL.
- **Schedules**: day-of-week and time-range entries, each naming a plan, with the default plan as fallback. The display checks once a minute and switches on its own. No controller is needed.
- **Heartbeat**: each profile shows when it was last seen, and is flagged **stale** if it has gone quiet for more than two hours.
- **Revoke** a profile and both its link and any already-provisioned device stop working on their next request.
- Pair a kiosk's plan with [pre-scripted captions](#pre-scripted-captions) and [automated sets](#automated-presentation-sets) for signage that captions itself.

### Operating a Server

- **Install and update** with `deploy/install.sh` and `deploy/update.sh`. Updates run the unit tests first, flip to the new release, check `/healthz`, and roll back automatically if it doesn't come up.
- **Backups**: a nightly systemd timer, `podium-admin backup` for a database snapshot, and `restore.sh`.
- **`podium-admin doctor`** works through what actually goes wrong on a box: a full disk, an unsound database, a deploy that never reached the running process, an expiring certificate, no backups, no administrator left, and a relay that answers HTTP but doesn't actually relay. It's safe to run from cron.
- **Audit log** of logins and administrative actions, downloadable as CSV and automatically pruned.
- **Relay limits**: caps on rooms, devices per room (12) and viewers per room (300), plus per-IP connection throttling.
