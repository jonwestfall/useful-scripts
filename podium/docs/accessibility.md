# Accessibility: the controller and display

This is the audit from Issue #156: can someone use `control.html` with a screen reader, and do `control.html` and `display.html` meet a basic contrast check? It is about the **presenter's** own devices. The audience's side (someone who cannot see the projector) is Guest View Mode, Issue #150.

The audit was done by reading the markup, the CSS and the code that sets them. **Nobody has yet tried the pages end to end with VoiceOver, NVDA or TalkBack.** That is the most useful next step, and nothing below replaces it.

---

## What `test/a11y.test.mjs` checks

These checks run with the other unit tests, so a new button or colour cannot quietly undo a fix:

- Every page declares its language.
- Every form field on the controller and display has a label. A placeholder does not count.
- Every `<button>` on every page has a name a screen reader can say. That means real words, a number, an `aria-label`, or a `title` on a button with no content at all. A button showing only a symbol plus a `title` fails: a button's text wins over its `title`, so ▶ would be read as "black right-pointing triangle".
- The controller's connection announcer, and the display's caption bar and connection line, are live regions.
- The palette's text colours meet WCAG AA (4.5:1) on the panels they sit on.
- Every CSS rule that sets both a text colour and a background meets 4.5:1. This check is what found the failures below.
- Keyboard focus is always drawn, and nothing turns it off.

---

## Findings

### Fixed in this pass

| Area | What was wrong | Fix |
|---|---|---|
| Names | About 30 symbol-only buttons were read by their symbol's name, or had no name at all: ink colours, layout picker, pan/zoom arrows, transport (▶, ⏮, ⏭), mute (🔊), plan.html's deck arrows. | `aria-label` on each one. |
| Names | Bottom-bar quick slots set their symbol (✎, 🔦, ⏱ ▶) at runtime. | `renderSlotButton` names a symbol-only slot from its title. A slot showing a real word (Freeze, TAKE) keeps that word as its name, since that is what a voice-control user will say. |
| State | Toggles showed their state only as a highlight: layout, ink colour, message background, mute, bottom-bar slots, and which controller tab is open. | `aria-pressed` on the toggles. `aria-current` on the open tab. Both are kept in step by the same code that moves the highlight. |
| Announcements | No live regions anywhere on either page. | See **Live regions** below. |
| Contrast | White text on red fills (Take, Laser, danger buttons, a confirmed delete) was **3.27:1**. | A new `--live-fill` (#d32f2f) for red fills: **4.98:1**. `--live` itself is unchanged for red text and dots (5–6:1 on the panels). |
| Contrast | White on the amber Spotlight button was **2.52:1**. | Dark text instead: **7.36:1**. |
| Contrast | Session and recap PDF footers used #64748b, **3.75:1**. | #94a3b8, **7.0:1**. |
| Focus | No focus style of our own. The browser's ring ranges from faint to invisible on these dark panels. | `:focus-visible` draws a 2px accent outline. It uses `:focus-visible` so a tap on an iPad leaves no ring behind. |
| Labels | 13 of the controller's fields had only a placeholder for a label: the link box, the library and slide filters, the media position slider, the timer's minutes and label, the poll question, and others. A placeholder disappears on typing, and screen readers don't reliably read it as the field's name. | `aria-label` on each one. |
| Landmarks | The controller's tab bar was an unnamed `<nav>`. | Named "Controller sections". |

**Live regions** added in this pass:
- **Controller connection:** a single visually hidden announcer, `#sr-announce`. The visible status bar is rewritten on every heartbeat with a round-trip time, which a live region would read aloud every few seconds. The announcer speaks only when the relay or display state actually changes.
- **Action results:** notes that report how an action went use `role="status"`. For example, "Saved a 12-page PDF", the caption status, and the camera status.
- **Errors and warnings:** poll errors, the stale-build banner and the local-storage warning use `role="alert"`.
- **Display:** the caption bar is `aria-live="polite"`. So are the connection line, the arming screen's status, and its "Cleared" note.

### What already passed

- Body text (`--ink`) is 13.7–16.4:1. Hint text (`--dim`, 13px) is 6.3–7.5:1 on every panel. Accent, cue and OK colours as text are 8–12.7:1.
- Selected buttons (dark text on `--accent`) are 7.9:1.
- No positive `tabindex` anywhere, so the tab order is the DOM order. On the controller the DOM order matches what is on screen: top bar, cue bar, tab bar, the open panel, then the bottom bar.
- Keyboard shortcuts (Issue #138) already cover the lectern's main actions without a pointer.

### Not fixed here: worth their own issues

1. **Borders are nearly invisible.** `--line` borders are 1.46:1 on the background, and a button's fill is 1.20:1. WCAG 1.4.11 asks for 3:1 where the edge is what shows a control is there. This is a palette decision, not a quick fix, so it was left alone rather than redesigned in passing.
2. **Sheets and dialogs don't manage focus.** Settings, pairing and setup don't move focus in when they open, don't keep it inside, and don't return it to the button that opened them. Escape handling differs from sheet to sheet.
3. **The tab bar isn't a full ARIA tabs widget.** It now says which tab is open, but it doesn't use the tabs pattern (`role="tablist"`, arrow keys, roving tabindex). That pattern is worth doing together with the "More ▾" overflow menu, which has the same gap.
4. **Some names are terse.** Timer presets ("1m", "+30s") and "50 / 50" are left as they are. They read acceptably, and a fuller `aria-label` would no longer contain the visible text (WCAG 2.5.3, label in name).
5. **Pages not covered.** `admin.html`, `join.html` (already in Issue #125's backlog), `guest.html` and `plan.html` were only checked for button names and page language. The same goes for the pages added since, in Podium 1.3: `deck.html`, `quicklook.html`, `me.html`, `attend.html` and `replay.html`. `a11y.test.mjs` reads every `.html` file, so their buttons are named and their language declared, and their colours come from the same palette; nobody has yet audited their flow with a screen reader. Two things there were built with one in mind: the replay's transcript is a list of real buttons with times, and the controls work from the keyboard (Space, ← →, Home, End), and the search results' "Play from here" buttons say which moment they play from.
6. **The display is a projector.** It is not a page anyone is expected to use with a screen reader during a lecture. Only its setup and arming screens, and the caption bar, were checked.
