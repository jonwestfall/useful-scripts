# What's New in Podium 1.3

Podium 1.3 is the biggest release yet. In one sentence: you can now **take attendance from students' phones**, **write and show documents as well as slides**, **zoom anything to fill the screen with a pinch**, and afterwards **search and replay every lecture** with its sound.

Features marked 🖥️ need Podium's own self-hosted server; everything else works on every setup, including free GitHub Pages hosting. Details for each are in the [features guide](features.md), and the [illustrated guide](../guide.html) marks everything new.

---

## The headlines

### ✅ Attendance from students' phones 🖥️
Open check-in from the controller's **Attendance** tab and a QR code and six-digit code go up on the projector, changing every 15 seconds so a photo texted to someone outside goes stale almost at once. Students scan, pick their name from the course roster, and get a receipt. No app, no student accounts.
- **Rosters** are imported from Canvas, Blackboard, Moodle or a spreadsheet, with a preview before anything changes. Guests are welcome too.
- **Honest flags, not accusations:** one phone checking in two people is flagged for you to look at; nothing is blocked.
- **Only from phones in the room**, if you want it: the phone sends its position once, and the server keeps only the distance.
- **Entry and exit tickets:** up to three questions as students check in, and again at the end of class.
- **The parking lot:** students leave a question, named or anonymous. An anonymous one keeps nothing that ties it to whoever asked.
- **After class:** review and fix any mark, see the **term grid**, and export CSV or a **Canvas gradebook** file. Students can get an **emailed receipt**.
- **Planned ahead:** an Attendance item in the planner opens check-in, with its questions, the moment you reach it.

### ⏯️ Replay any lecture 🖥️
**▶ Replay** on My Files plays a recorded lecture back on its own clock: your controller mic's audio, what was on the projector (the annotated slide or marked-up screen where one was kept), the caption being said, a transcript you tap to jump, and each poll's result as it closed.
- Several mics play together, and each can be muted on its own.
- **Screen video** (optional): an administrator can let displays offer **Go live and record the screen**. The video then plays on the replay's stage, with its own storage limit per lecture.
- The address keeps your place, so a link opens at the same moment, but only for people who could open the lecture.

### 🔎 Search every lecture 🖥️
"The lecture where I mentioned working memory": search what was said, what was on screen, notes, polls and attendance questions across every session you can open. Results show the matched words in context; open one to see that moment in the timeline, or **▶ Play from here** to hear it.

### 📖 Markdown documents, and Word files
A plain `.md` file can now be shown as **one page to read** rather than slides. You scroll it for the room, jump between its headings, and mark it up with ink that stays pinned to the words. Guest viewers can **read at their own pace** on a phone. **Word (`.docx`, `.doc`) and RTF files** become documents, or PDFs if you'd rather keep their layout 🖥️.

### 🤏 Pinch to zoom, and portrait pages that keep their shape
PDF pages and photos now **fill the screen when zoomed**, instead of becoming a narrow column with bars beside it. A compact zoom bar (Fit page, Fit width, Fit height, a slider) replaces the old arrows, and you can **pinch and drag** on the Now preview or the ink pad, double-tap, use the mouse wheel, or press + and −. The ink pad and preview take the shape of what you're drawing on, so a portrait page or an upright phone photo lines up exactly, and ink stays on the words at any zoom.

### ✍️ A real deck editor
`deck.html` writes Marp decks and markdown documents beside the projector's own preview:
- a toolbar for slides, columns, builds and notes, with checks before class;
- **pictures** pasted or dropped in, and **video slides** 🖥️;
- **Mermaid diagrams** drawn from a code block, with mermaid.live links in and out;
- **templates** (built-in, course and personal) 🖥️;
- **previous versions** of a library deck 🖥️;
- `.zip` export and import, and **PDF export**;
- decks already on the server edited where they live.

---

## Also new

- **Quick Look:** open any file privately in its own tab to check it before class, from the controller, planner, library, My Files or the deck editor. Documents get an outline and scroll with a finger on an iPad.
- **My Files** 🖥️: everything that is yours on the server in one place (files, lectures, deck templates, recorded lectures, rosters and attendance), each saying what you may do with it, plus your password.
- **Choose files from the server** 🖥️ in the planner, several at once, with recently opened decks first.
- **Archive** last term's lectures out of your planner list, alone or in bulk; it's personal and undoable.
- **Light or dark on every page**, following the device or chosen once on your account so it follows you everywhere 🖥️.
- **Video over background music** is heard on Safari too, and the music ducks to 20% underneath it.
- **Streaming guide:** stream a class live to YouTube or Twitch with OBS, from the classroom PC or from a Guest View link anywhere. See [streaming.md](streaming.md).

## For administrators 🖥️

- **New settings** on Admin › Server:
  - **Attendance:** how long device details are kept, how often the code changes, and the default "in the room" radius.
  - **Screen video:** on or off, and a per-lecture budget, kept apart from the 400 MB a session already gets.
- **Outgoing mail** (`SMTP_URL`, `MAIL_FROM`) for attendance receipts, with **Send a test email**. `podium-admin doctor` checks mail too.
- **Plan the disk before turning on screen video:** about 540 MB an hour. See [deploy/README.md](../deploy/README.md#session-records-and-how-long-they-are-kept).
- **Database migrations run on their own** at startup. The search index is built from your existing history the first time, so a term already under way is searchable at once.
- **Kept recordings:** a lecture that kept a recording (mic or screen) is never discarded as "empty" when it ends.

## Privacy, stated plainly

What's new on this front, all opt-in and all on your own server:
- **Attendance check-ins** go to your server outside the room's encryption, the same way poll answers always have.
- **Location:** only a distance is kept, never coordinates.
- **Shared-phone flags:** a phone's browser token and network address are stored only as keyed hashes, and only for the retention period you set.
- **Emailed receipts** pass through the mail server you configure.
- **Session records and recordings** are stored readable on your server so they can be searched and replayed, and only people who could open a lecture can reach them.

The display tells the room what is kept, and shows a badge while the screen is being recorded. See [Architecture & Security](architecture.md#security--end-to-end-cryptography).

## Upgrading

- **Your own server:** update as usual (`deploy/update.sh`). The new tables, the search index and its backfill are created on the first start; nothing needs to be done by hand.
- **GitHub Pages:** pull or merge the new files. A device still running the old copy notices on its next load and offers **Reload now**.

Every page reports its version as **v1.3**, on the landing page, the display's Go live screen, Admin, and `GET /healthz`.
