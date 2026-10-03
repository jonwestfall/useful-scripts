# Rebuilding the vendored bundles

`npm run build` rebuilds both bundles below. `npm run build:marp` and
`npm run build:codemirror` rebuild just one.

## Marp

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

## CodeMirror (the deck editor)

`../assets/vendor/codemirror.esm.js` is [CodeMirror 6](https://codemirror.net/) for
`deck.html` (Issue #226), bundled from `codemirror-entry.js`. That file is the only
list of what the editor can import: state, view, commands, language (folding and
highlighting), Markdown with embedded HTML, search, autocomplete and lint.

```bash
cd podium/vendor-build
npm install
npm run build:codemirror
```

Every `@codemirror/*` package is pinned to an exact version in `package.json`, so
that the bundle contains exactly one copy of `@codemirror/state`. Two copies break
CodeMirror in confusing ways, so upgrade them together. To use something new from
CodeMirror in `assets/js/deck-editor.js`, export it from `codemirror-entry.js` and
rebuild.
