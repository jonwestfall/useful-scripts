---
marp: true
theme: psy415-dsu
size: 16:9
paginate: true
title: Progressive Builds
footer: Podium · example deck
---
<!-- _class: lead -->
# **Progressive Builds**
### Reveal one bullet at a time, PowerPoint-style

<!--
Marp itself has no concept of a "build" - every `---` is one static slide,
shown all at once. This is Podium's own convention layered on top.
-->

---
<!-- _class: build -->
## Opt a slide in with one directive

* Add `<!-- _class: build -->` right after the `---` that starts the slide.
* Every bullet on the slide then arrives one at a time as you press **Next**.
* This line, the one above it, and the one below it are three separate steps.

<!--
Nothing else about the markdown changes - it is still a completely normal
bullet list. Podium numbers each <li> on the slide and hides it until its
turn; the Slides tab's Next/Previous walk through them before moving on.
-->

---
<!-- _class: build -->
## Fine control with your own markup

Raw HTML is allowed for layout, so you can mark exactly what should build
regardless of whether it is a bullet:

<p class="build">This paragraph appears on step 1.</p>

<p class="build">This one waits for step 2.</p>

A plain paragraph with no <code>class="build"</code> - like this one - is part
of the slide from the moment it appears, same as before.

<!--
Once you mark anything explicitly with class="build", Podium builds exactly
those elements, in the order they appear, instead of auto-numbering bullets.
-->

---

## A slide with no `build` class

Behaves exactly as it always has - everything shows at once. Builds are
opt-in per slide, so the rest of your deck is unaffected.
