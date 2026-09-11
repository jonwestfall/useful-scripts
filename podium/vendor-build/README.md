# Rebuilding the vendored Marp bundle

`../assets/vendor/marp.esm.js` is [`@marp-team/marp-core`](https://github.com/marp-team/marp-core)
bundled for browsers. It is vendored rather than pulled from a CDN so that a deck
still renders when campus Wi-Fi is being campus Wi-Fi.

```bash
cd podium/vendor-build
npm install
npm run build
```

Two things are trimmed to keep it near a megabyte instead of four:

- **MathJax is stubbed.** Podium renders math with KaTeX, which is bundled. A deck
  that asks for `math: mathjax` in its front matter will throw a clear error.
- **highlight.js keeps ~40 languages** instead of ~190. The list is at the top of
  `build-marp.mjs`; add to it and rebuild if you need another. An unlisted language
  renders as plain unhighlighted code.

KaTeX's fonts are the one thing still fetched from a CDN (jsDelivr), because they
are separate font files rather than CSS. Math renders without them, just in a
fallback face. To self-host them, copy `node_modules/katex/dist/fonts/` somewhere
under `podium/` and set `katexFontPath` in `assets/js/deck.js`.
