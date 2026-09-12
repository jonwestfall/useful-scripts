---
marp: true
theme: psy415-dsu
size: 16:9
paginate: true
title: Podium Deck Features
footer: Podium · example deck
---
<!-- _class: lead -->
# **Podium + Marp**
### Everything this deck shows works on the projector

<!--
This is a presenter note. It shows up on your iPad, never on the projector.

Anything inside an HTML comment that is not a Marp directive becomes a note,
so you can write as much as you like here.
-->

---

## Notes, directives and classes

* An HTML comment that **is** a directive (`_class`, `_backgroundColor`, …) is consumed by Marp.
* Any **other** comment becomes a presenter note on the controller.
* Per-slide classes from your theme still work — this slide is plain, the first was `lead`.

<!--
Second slide note. Tap Next on the iPad and watch this panel change.

Keep notes short enough to glance at: you are reading these while talking.
-->

---
<!-- _class: compact -->
## Math, tables and code all render

Inline math like $I^2 > 50\%$ and display math both work through KaTeX:

$$ g = \frac{M_1 - M_2}{SD_{pooled}} $$

| Evidence | Effect | NNT |
| :--- | :--- | :--- |
| **PE** | $d = 0.85$ | 4.1 |
| **MBSR** | $d = 0.35$ | 9.6 |

```r
t.test(outcome ~ group, data = trial)
```

<!--
The compact class from psy415-dsu.css is doing the work here.

Code highlighting covers about forty languages; R, Python, Stata and SQL are
all included.
-->

---

## Driving it from the iPad

<div class="callout">

**Next / Previous** step slides. **Freeze** holds the projector while you read
ahead. **Blank** cuts to black.

</div>

* Tap any thumbnail in **Jump to a slide** to go straight there.
* An external keyboard works too: arrows, space, `B` to blank, `F` to freeze.

<!--
The callout div comes from the theme's layout helpers. Raw HTML is allowed for
layout, but scripts are stripped, so a deck downloaded from elsewhere cannot run
code on the classroom PC.
-->
