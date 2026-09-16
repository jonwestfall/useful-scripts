# Open issues — to check in a real room

Things that are believed fixed but could not be proved here, and small things
noticed along the way that have not been acted on. Not a bug tracker: if
something in here turns out to be real, it graduates into a fix and comes out
of this file.

The test suite runs Chromium only, on a machine with no projector, no iPad and
no YouTube. That is the gap most of this list lives in.

## To verify next time it comes up

### The Safari slide-fit fix

**What changed:** `measureFits()` in `deck.js` now applies Marp's own Safari
`<foreignObject>` layout fix before measuring how much a slide has to shrink,
rather than only applying it at render time (commit `bb26a7c`).

**Why it is unverified:** the fix is Safari-only by construction — Marp's
polyfill checks `navigator.vendor` and does nothing anywhere else — so the
Chromium test suite exercises the code path but never the behaviour. Chrome
never had the bug, so a test that passes here proves only "not broken", not
"fixed".

**What to look for:** a slide with a wide inline `$$…$$` line (the Day 8
"Structural Context ⟶ … ⟶ Measurement Meaning" pipeline is the known case).
On the iPad's Slides tab, the Now box should show the whole line, matching
what the projector shows. Before the fix, the iPad clipped the tail of it.

**If it is still wrong:** the next suspect is the two-frame wait before
measuring — Marp's polyfill corrects on its own `requestAnimationFrame` loop
after an async capability check, and two frames is an estimate of "long
enough", not a guarantee. Worth logging the measured `fits[]` values on both
devices for the same deck and comparing.

### The YouTube embed domain switch

**What changed:** YouTube embeds moved from `www.youtube-nocookie.com` to
`www.youtube.com` (commit `a8a8bcc`), plus a console warning if the player
ever reports a volume that disagrees with what it was told.

**Status:** the report that prompted it turned out to be a misread — the
control being reached for was the room volume slider, which does not govern
background music (see below). So the original symptom is explained, and the
domain switch was not strictly needed.

**Why it is staying:** it costs nothing behaviourally, `www.youtube.com` is
the domain Google's own IFrame API docs use for JS-controlled embeds, and the
volume-mismatch warning is worth having regardless. The one real trade-off is
that YouTube can now set its ordinary cookies as soon as the frame loads
rather than only once playback starts — worth reverting if that matters more
than API reliability does.

**What to look for:** nothing specific. If a video's volume ever ignores the
room slider again, the display's console now says so in plain language.

## Resolved since this file was written

**Two volume sliders, neither of them labelled** — the fuller fix mentioned
here (the bottom bar showing both channels) shipped as the **Mixer tab**:
Master, Content, and Music now each have their own labelled fader, and the
master multiplies into both channels rather than competing with either.
