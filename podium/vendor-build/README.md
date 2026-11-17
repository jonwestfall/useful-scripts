# Rebuilding the vendored bundles

`npm run build` rebuilds every bundle below. `npm run build:marp`,
`npm run build:codemirror` and `npm run build:mermaid` rebuild just one.

## Marp

`../assets/vendor/marp.esm.js` is [`@marp-team/marp-core`](https://github.com/marp-team/marp-core)
bundled for browsers. It is vendored rather than pulled from a CDN so that a deck
still renders when campus Wi-Fi is being campus Wi-Fi.

```bash
cd podium/vendor-build
npm install
npm run build
```

It also re-exports the markdown-it, KaTeX (with its stylesheet) and HTML filter
marp-core already carries, for markdown documents (Issue #240, `assets/js/doc.js`).
They come through `shared-cjs.cjs`, so the bundle reuses marp-core's own CommonJS
copies instead of adding their ES module builds beside them; that costs about
24 KB, KaTeX's CSS. Code in a document is highlighted by a Marp instance's own
`highlightjs`.

Two things are trimmed to keep it near a megabyte instead of four:

- **MathJax is stubbed.** Podium renders math with KaTeX, which is bundled. A deck
  that asks for `math: mathjax` in its front matter will throw a clear error.
- **highlight.js keeps ~40 languages** instead of ~190. The list is at the top of
  `build-marp.mjs`; add to it and rebuild if you need another. An unlisted language
  renders as plain unhighlighted code.

KaTeX's fonts are vendored beside the bundle, in `../assets/vendor/katex-fonts/`
(the `.woff2` files from `node_modules/katex/dist/fonts/`, and KaTeX's licence).
Math does not render without them: the slash through ≠ is a glyph of its own in
KaTeX_Main, so a slide would read `a = b`. `assets/js/math-fonts.js` points Marp
and documents at them and puts them on the page (see there for why). When the
KaTeX version in the bundle changes, copy the new version's `.woff2` files over
these; the list of names is in `sw.js` and `server/open-paths.js`.

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

## Mermaid (diagrams in decks)

`../assets/vendor/mermaid.esm.js` is [Mermaid](https://mermaid.js.org/) for
```` ```mermaid ```` code blocks in decks (Issue #235), bundled from
`mermaid-entry.js`. `assets/js/deck-mermaid.js` loads it, and only for a deck
that has a diagram in it.

```bash
cd podium/vendor-build
npm install
npm run build:mermaid
```

It is one file, about 5 MB (1.5 MB gzipped). Mermaid loads each kind of
diagram with `import()`; without code splitting esbuild folds all of them into
this file, so every kind of diagram draws offline and there is nothing else to
serve or cache. Nothing is trimmed: the biggest part is the ELK layout engine
(1.4 MB), which a diagram only uses if it asks for `layout: elk`, but stubbing
it out would turn such a diagram into an error on the projector. `mermaid` is
pinned to an exact version in `package.json`.

## pdf.js (PDFs everywhere)

`../assets/vendor/pdfjs/` is [pdf.js](https://mozilla.github.io/pdf.js/), copied
from `pdfjs-dist` (pinned in `package.json`) by `build-pdfjs.mjs`. Its version is
in `../assets/vendor/pdfjs/VERSION`. `assets/js/pdfjs.js` loads it the first time
a PDF is shown, on any page (Issues #335, #341).

```bash
cd podium/vendor-build
npm install
npm run build:pdfjs
```

It is the **legacy** build. The modern one calls methods only the newest
browsers have (`Map.prototype.getOrInsertComputed`, `Math.sumPrecise`,
`URL.parse`) without checking for them, so an iPad a version or two behind
would show nothing; the legacy build carries polyfills and runs on Safari 16.4 /
iPadOS 16.4 and later.

Beside it, in `wasm/`, are the image decoders pdf.js fetches when a PDF needs one
(JPEG 2000, JBIG2, ICC colour), each with its non-WebAssembly fallback. Left out:
QuickJS (PDF form scripts, which Podium never runs), and the CJK character maps
and standard fonts (which Podium has never shipped, so PDFs that rely on them
draw as they always have). The files are listed by name in `server/open-paths.js`
(kiosks and Guest View) and `test/offline-shell.test.mjs`; keep those in step if
a new pdf.js adds or renames one.
