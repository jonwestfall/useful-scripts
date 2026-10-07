// The deck editor (Issue #226): a Marp deck's markdown in a real code editor
// (CodeMirror, vendored), beside the projector's own renderer.
//
// The markdown is the document - this page never keeps a second copy of the
// deck in any other shape. deck-source.js is how it knows where slides start
// and which comments are notes, and every structural edit (move a slide, set
// a directive, write the notes) is computed there and applied to the editor
// as one change, so it is one undo step and the cursor stays put.
//
// Where a deck comes from decides where Save puts it:
//   ?library=<id>  a deck in this server's library - saved with If-Match, so
//                  two people never silently overwrite each other
//   ?content=<f>   content/decks/<f>, an administrator's
//   ?plan&item     a deck carried inside a lecture plan, handed over by the
//                  planner tab that opened this one and handed back to it
//   ?src=<url>     a deck at an address. One that is really a library deck
//                  or a content/decks file opens as that, and saves back to
//                  it; anything else is opened, then saved somewhere
//   ?template=<k>  a template of your own or your course's, saved back to it
//                  (one you cannot change opens as a new deck made from it)
//   ?from=<k>      a new deck, started from a template
//   (nothing)      a new deck
// A draft of unsaved work is kept on this device the whole time.

import { $, $$, el, safeStorageSet } from './util.js';
import { createRenderer } from './renderers.js';
import { render as renderDeckSource, deckId, describeBuild, forgetDeck, applyFits, applyPolyfill, deckLocation } from './deck.js';
import { deckStep } from './protocol.js';
import { serverInfo, mountSessionBadge } from './server.js';
import { downloadText } from './store.js';
import * as DS from './deck-source.js';
import { createDeckMedia, uploadDeckMedia } from './deck-media.js';
import { exportZip, readDeckZip, exportPdf, replaceRef } from './deck-export.js';
import { deckProblems, checkServerMedia } from './deck-checks.js';
import { openQuickLook } from './quicklook-open.js';
import { createTemplatesPanel, findTemplate, slidesOf } from './deck-templates.js';
import {
  STARTERS, starterFence, isMermaidLiveLink, readMermaidLiveLink, fenceFromLink, mermaidLiveLink, fenceAt,
  mermaidStreamParser,
} from './deck-diagrams.js';
import * as CM from '../vendor/codemirror.esm.js';

const params = new URLSearchParams(location.search);
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('podium-decks') : null;

const STARTER = `---
marp: true
paginate: true
title: Untitled deck
---

# Untitled deck

Your name · Course

---

## A first slide

- A point worth making
- And another
`;

const BUILT_IN_THEMES = ['default', 'gaia', 'uncover'];
const BASE_CLASSES = ['lead', 'invert', 'build'];
const DRAFT_PREFIX = 'podium.deckdraft.';
const MAX_DRAFT_CHARS = 1024 * 1024;

let info = null;
let origin = { kind: 'new' };   // where this deck lives - see the file comment
let savedText = '';             // what that place holds, as far as this page knows
let deck = DS.parseDeck('');
let rendered = null;            // the last render, from deck.js
let renderedId = null;
let current = 0;                // the slide the cursor is in
let step = null;                // the preview's build step; null = fully built
let view = null;
let problems = [];
let themeNames = [...BUILT_IN_THEMES];
let themeClasses = new Set(BASE_CLASSES);
let libraryCourses = [];
let saving = false;
let openedWith = '';
// A deck inside a lecture plan keeps its pictures in the plan when there is
// no server (Issue #226): `asset:<id>` in the markdown, the bytes here.
const planPictures = new Map();            // the text this page opened with, to tell an untouched new deck

// --- small helpers -------------------------------------------------------------

const text = () => view.state.doc.toString();
const dirty = () => view && text() !== savedText;

function warn(message, actions = []) {
  const box = $('#deck-warn');
  if (!message) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  box.replaceChildren(el('span', {}, message), ...actions.map(([label, fn]) => el('button', { type: 'button', onclick: fn }, label)));
}

function setSaveState(textValue) {
  $('#deck-save-state').textContent = textValue;
}

function refreshSaveState() {
  if (saving) return;
  setSaveState(dirty() ? 'Unsaved changes (a draft is kept on this device)' : 'Saved');
  document.title = `${dirty() ? '• ' : ''}${deck.frontMatter.fields.title || origin.title || 'Deck'} — Podium deck editor`;
}

function destination() {
  return { library: 'library', content: 'content', plan: 'plan' }[origin.kind] || 'file';
}

function draftKey() {
  if (origin.kind === 'library') return `${DRAFT_PREFIX}library:${origin.id}`;
  if (origin.kind === 'content') return `${DRAFT_PREFIX}content:${origin.name}`;
  if (origin.kind === 'plan') return `${DRAFT_PREFIX}plan:${origin.planId}:${origin.itemId}`;
  if (origin.kind === 'file' && origin.src) return `${DRAFT_PREFIX}src:${origin.src}`;
  if (origin.kind === 'template') return `${DRAFT_PREFIX}template:${origin.id}`;
  return `${DRAFT_PREFIX}new`;
}

let draftTimer = null;
function keepDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      if (!dirty()) { localStorage.removeItem(draftKey()); return; }
      const value = text();
      if (value.length > MAX_DRAFT_CHARS) return;
      safeStorageSet(localStorage, draftKey(), JSON.stringify({ text: value, base: savedText, at: Date.now() }));
    } catch { /* no storage: the draft is just not kept */ }
  }, 1500);
}

function dropDraft() {
  try { localStorage.removeItem(draftKey()); } catch { /* nothing to drop */ }
}

// The first character of a slide's own content, past its directives and blank
// lines - where the cursor goes when you pick that slide.
function slideCursorPos(parsed, index) {
  const slide = parsed.slides[Math.max(0, Math.min(parsed.slides.length - 1, index))];
  if (!slide) return 0;
  const raw = slide.raw;
  const re = /^[ \t]*(?:<!--[\s\S]*?-->[ \t]*)?\r?\n/y;
  let at = 0;
  for (;;) {
    re.lastIndex = at;
    const m = re.exec(raw);
    if (!m || !m[0]) break;
    if (m[0].includes('<!--') && !commentIsDirective(m[0])) break;
    at = re.lastIndex;
  }
  return slide.start + at;
}

function commentIsDirective(chunk) {
  return DS.commentsIn(chunk).every((c) => c.directive);
}

/**
 * Replace the whole document with `next`, as the smallest change that gets
 * there: one undo step, and the cursor and scroll stay where they were
 * unless `selectSlide` says to go to a slide.
 */
function applyText(next, { selectSlide } = {}) {
  const prev = text();
  if (next === prev && selectSlide === undefined) return;
  let a = 0;
  while (a < prev.length && a < next.length && prev[a] === next[a]) a++;
  let b = 0;
  while (b < prev.length - a && b < next.length - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
  const spec = { userEvent: 'input.podium' };
  if (next !== prev) spec.changes = { from: a, to: prev.length - b, insert: next.slice(a, next.length - b) };
  if (selectSlide !== undefined) {
    spec.selection = { anchor: slideCursorPos(DS.parseDeck(next), selectSlide) };
    spec.scrollIntoView = true;
  }
  view.dispatch(spec);
}

// --- the code editor ------------------------------------------------------------

const sepLine = CM.Decoration.line({ class: 'cm-marp-sep' });
const currentLine = CM.Decoration.line({ class: 'cm-marp-current' });
const directiveMark = CM.Decoration.mark({ class: 'cm-marp-directive' });
const noteMark = CM.Decoration.mark({ class: 'cm-marp-note' });

// Slide separators, directives, notes and the slide you are on, picked out
// so the structure of the deck is visible at a glance.
const marpDecorations = CM.ViewPlugin.fromClass(class {
  constructor(v) { this.decorations = this.build(v); }
  update(u) { if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build(u.view); }
  build(v) {
    const builder = new CM.RangeSetBuilder();
    const doc = v.state.doc;
    const ranges = [];
    for (const slide of deck.slides) {
      if (slide.index > 0 && slide.sep) ranges.push({ from: slide.start - slide.sep.length, deco: sepLine, line: true });
      if (slide.index === current) {
        const first = doc.lineAt(Math.min(slide.start, doc.length));
        const last = doc.lineAt(Math.min(Math.max(slide.start, slide.end - 1), doc.length));
        for (let n = first.number; n <= last.number; n++) ranges.push({ from: doc.line(n).from, deco: currentLine, line: true });
      }
      for (const c of DS.commentsIn(slide.raw)) {
        ranges.push({ from: slide.start + c.start, to: slide.start + c.end, deco: c.directive ? directiveMark : noteMark });
      }
    }
    // Line decorations first at any one position, then marks - the order a
    // RangeSetBuilder insists on.
    ranges.sort((x, y) => x.from - y.from || (x.line === y.line ? 0 : x.line ? -1 : 1));
    for (const r of ranges) {
      if (r.from > doc.length) continue;
      if (r.line) builder.add(r.from, r.from, r.deco);
      else if (r.to > r.from) builder.add(r.from, Math.min(r.to, doc.length), r.deco);
    }
    return builder.finish();
  }
}, { decorations: (v) => v.decorations });

// Each slide folds from the end of its first line to its end.
const slideFolds = CM.foldService.of((state, lineStart, lineEnd) => {
  for (const slide of deck.slides) {
    const head = slide.index === 0 ? slide.start : slide.start - slide.sep.length;
    if (head !== lineStart) continue;
    const end = Math.max(lineEnd, slide.end - 1);
    return end > lineEnd ? { from: lineEnd, to: end } : null;
  }
  return null;
});

function inFrontMatter(pos) {
  return deck.frontMatter.raw && pos < deck.frontMatter.raw.length;
}

const IMAGE_OPTIONS = ['bg', 'bg contain', 'bg cover', 'bg fit', 'bg left', 'bg right', 'bg left:40%', 'bg right:40%', 'w:600', 'h:400', 'contain', 'cover', 'grayscale', 'sepia', 'blur'];
const VALUES = {
  theme: () => themeNames,
  size: () => ['16:9', '4:3'],
  paginate: () => ['true', 'false'],
  math: () => ['katex'],
  class: () => [...themeClasses],
  mermaidTheme: () => DS.MERMAID_THEMES,
};

// Directive names, their values, theme names and picture options - the bits
// of Marp nobody remembers the spelling of.
function marpCompletions(ctx) {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);

  const img = /!\[([^\]]*?)([\w:%-]*)$/.exec(before);
  if (img) {
    return { from: ctx.pos - img[2].length, options: IMAGE_OPTIONS.map((label) => ({ label, type: 'keyword' })) };
  }
  const value = /(?:^|<!--|\s)(_?)([A-Za-z]+)\s*:\s*([\w:#.-]*)$/.exec(before);
  if (value) {
    const key = value[2];
    const list = VALUES[key]?.();
    if (list && (inFrontMatter(ctx.pos) || /<!--/.test(before) || insideComment(ctx.state, ctx.pos))) {
      return { from: ctx.pos - value[3].length, options: list.map((label) => ({ label, type: 'value' })) };
    }
  }
  const key = /(?:<!--\s*|^\s*)(_?)([A-Za-z]*)$/.exec(before);
  if (key && (/<!--/.test(before) || insideComment(ctx.state, ctx.pos) || inFrontMatter(ctx.pos))) {
    if (!key[2] && !ctx.explicit && !/<!--\s*_?$/.test(before)) return null;
    const local = [...DS.LOCAL_DIRECTIVES, DS.MERMAID_DIRECTIVE];
    const names = inFrontMatter(ctx.pos) ? [...DS.GLOBAL_DIRECTIVES, ...local]
      : key[1] === '_' ? [...DS.LOCAL_DIRECTIVES, ...DS.PODIUM_DIRECTIVES.filter((d) => d !== DS.DIAGRAM_DIRECTIVE)] : local;
    return {
      from: ctx.pos - key[2].length,
      options: names.map((name) => ({
        label: name, type: 'property', apply: `${name}: `,
        detail: key[1] === '_' ? 'this slide only' : (local.includes(name) && !inFrontMatter(ctx.pos) ? 'this slide and after' : 'whole deck'),
      })),
    };
  }
  return null;
}

function insideComment(state, pos) {
  const head = state.doc.sliceString(Math.max(0, pos - 2000), pos);
  return head.lastIndexOf('<!--') > head.lastIndexOf('-->');
}

const editorTheme = CM.EditorView.theme({
  '&': { height: '100%', fontSize: '14px', backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--dim)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine': { backgroundColor: 'rgba(110, 168, 254, 0.07)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(110, 168, 254, 0.12)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(110, 168, 254, 0.3) !important' },
  '.cm-marp-sep': { backgroundColor: 'rgba(255, 201, 77, 0.10)', borderTop: '1px solid rgba(255, 201, 77, 0.35)' },
  '.cm-marp-current': { backgroundColor: 'rgba(255, 255, 255, 0.025)' },
  // The markdown highlighter colours a comment's inner spans too; these win.
  '.cm-marp-directive, .cm-marp-directive *': { color: '#c49bff !important' },
  '.cm-marp-note, .cm-marp-note *': { color: '#7fc8a9 !important', fontStyle: 'italic' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--line)', color: 'var(--ink)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--on-accent)' },
  '.cm-panels': { backgroundColor: 'var(--bg)', color: 'var(--ink)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--panel-2)', border: '1px solid var(--line)', color: 'var(--dim)' },
}, { dark: true });

const highlight = CM.HighlightStyle.define([
  { tag: CM.tags.heading, color: '#ffd166', fontWeight: '700' },
  { tag: CM.tags.strong, fontWeight: '700' },
  { tag: CM.tags.emphasis, fontStyle: 'italic' },
  { tag: CM.tags.link, color: '#6ea8fe' },
  { tag: CM.tags.url, color: '#6ea8fe' },
  { tag: CM.tags.monospace, color: '#ffb38a' },
  { tag: CM.tags.list, color: '#97a2b0' },
  { tag: CM.tags.quote, color: '#b7c0cc', fontStyle: 'italic' },
  { tag: CM.tags.comment, color: '#7fc8a9' },
  { tag: CM.tags.meta, color: '#97a2b0' },
  { tag: CM.tags.processingInstruction, color: '#97a2b0' },
  { tag: CM.tags.contentSeparator, color: '#ffc94d', fontWeight: '700' },
  { tag: CM.tags.tagName, color: '#ff8fa3' },
  { tag: CM.tags.attributeName, color: '#ffb38a' },
  { tag: CM.tags.string, color: '#a5d6a7' },
  // Inside a ```mermaid block (Issue #235).
  { tag: CM.tags.keyword, color: '#c49bff' },
  { tag: CM.tags.operator, color: '#ffc94d' },
  { tag: CM.tags.number, color: '#ffb38a' },
]);

// The text of a ```mermaid block, coloured as Mermaid rather than plain code.
const mermaidCode = CM.LanguageDescription.of({
  name: 'mermaid',
  support: new CM.LanguageSupport(CM.StreamLanguage.define(mermaidStreamParser)),
});

const editorKeys = [
  { key: 'Mod-s', preventDefault: true, run: () => { save(); return true; } },
  { key: 'Mod-b', run: () => { wrapSelection('**'); return true; } },
  { key: 'Mod-i', run: () => { wrapSelection('*'); return true; } },
];

function createEditor(initial) {
  const state = CM.EditorState.create({
    doc: initial,
    extensions: [
      CM.lineNumbers(),
      CM.highlightActiveLineGutter(),
      CM.foldGutter(),
      CM.history(),
      CM.drawSelection(),
      CM.dropCursor(),
      CM.indentOnInput(),
      CM.bracketMatching(),
      CM.closeBrackets(),
      CM.highlightActiveLine(),
      CM.highlightSelectionMatches(),
      CM.EditorView.lineWrapping,
      CM.markdown({ base: CM.markdownLanguage, codeLanguages: [mermaidCode] }),
      CM.syntaxHighlighting(highlight),
      CM.syntaxHighlighting(CM.defaultHighlightStyle, { fallback: true }),
      CM.autocompletion({ override: [marpCompletions], activateOnTyping: true }),
      CM.lintGutter(),
      CM.search({ top: true }),
      slideFolds,
      marpDecorations,
      editorTheme,
      CM.keymap.of([
        ...editorKeys,
        ...CM.closeBracketsKeymap, ...CM.defaultKeymap, ...CM.searchKeymap, ...CM.historyKeymap,
        ...CM.foldKeymap, ...CM.completionKeymap, CM.indentWithTab,
      ]),
      CM.EditorView.updateListener.of(onEditorUpdate),
      // A pasted screenshot or a dropped photo or video goes to the library
      // and the slide links to it - never into the markdown itself.
      CM.EditorView.domEventHandlers({
        paste(ev) {
          // A mermaid.live link: ask whether it is the diagram or the link.
          const pasted = ev.clipboardData?.getData('text/plain') || '';
          if (!ev.clipboardData?.files?.length && isMermaidLiveLink(pasted)) {
            ev.preventDefault();
            pasteLiveLink(pasted.trim());
            return true;
          }
          if (!media.takeFiles(ev.clipboardData?.files)) return false;
          ev.preventDefault();
          return true;
        },
        drop(ev, editor) {
          if (!ev.dataTransfer?.files?.length) return false;
          const pos = editor.posAtCoords({ x: ev.clientX, y: ev.clientY });
          if (pos !== null) editor.dispatch({ selection: { anchor: pos } });
          if (!media.takeFiles(ev.dataTransfer.files)) return false;
          ev.preventDefault();
          return true;
        },
      }),
    ],
  });
  const editor = new CM.EditorView({ state, parent: $('#deck-code') });
  return editor;
}

/** A fresh document: new undo history, cursor at the top. */
function setDocument(value) {
  deck = DS.parseDeck(value);
  current = 0;
  step = null;
  view?.destroy();
  view = createEditor(value);
}

function onEditorUpdate(update) {
  if (update.docChanged) {
    deck = DS.parseDeck(update.state.doc.toString());
    renderSoon();
    keepDraftSoon();
    refreshSaveState();
  }
  if (update.docChanged || update.selectionSet) {
    const at = DS.slideAt(deck, update.state.selection.main.head);
    if (at !== current) {
      current = at;
      step = null;
      if ($('#deck-focus').checked) focusSlide();
      showCurrent();
    } else if (update.docChanged) {
      renderSlidePanel();
    }
  }
}

// --- rendering --------------------------------------------------------------------

let renderTimer = null;
let renderGeneration = 0;
const sources = new Map();   // preview deck id -> markdown, for the renderer to ask for
let previewRenderer = null;

function renderSoon(ms = 300) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderNow, ms);
}

async function renderNow() {
  const mine = ++renderGeneration;
  // A picture kept in the lecture plan is drawn from the bytes the planner
  // handed over; the markdown keeps its `asset:` address.
  const value = planPictures.size ? text().replace(DS.ASSET_REF, (ref, id) => planPictures.get(id) || ref) : text();
  const id = `edit:${await deckId(value)}`;
  if (mine !== renderGeneration) return;
  sources.set(id, value);
  let result;
  try {
    result = await renderDeckSource(value, id);
  } catch (err) {
    if (mine !== renderGeneration) return;
    problems = [{ slide: 0, offset: 0, severity: 'warning', message: `Marp could not render this: ${err.message}` }];
    renderProblems();
    return;
  }
  if (mine !== renderGeneration) return;
  rehearsal?.update(rehearsalPackage());
  const previous = renderedId;
  rendered = result;
  renderedId = id;
  if (previous && previous !== id) {
    // The renderer may still be mounting the last version; let it finish first.
    setTimeout(() => { if (renderedId !== previous) { forgetDeck(previous); sources.delete(previous); } }, 5000);
  }
  updatePreview();
  buildStrip();
  computeProblems();
  renderSlidePanel();
}

function previewItem() {
  const fragments = rendered?.fragments || [];
  const slide = Math.min(current, Math.max(0, (rendered?.count || 1) - 1));
  return {
    type: 'deck', deckId: renderedId, slide,
    step: step === null ? (fragments[slide] || 0) : step,
    slideCount: rendered?.count || 1, fragments,
  };
}

function updatePreview() {
  if (!renderedId) return;
  const item = previewItem();
  if (!previewRenderer) {
    previewRenderer = createRenderer(item, { preview: true, getDeckSource: (it) => sources.get(it.deckId) ?? null });
    $('#deck-preview').append(previewRenderer.el);
    wirePreviewClicks(previewRenderer.el);
  } else {
    previewRenderer.update(item);
  }
  const steps = item.fragments[item.slide] || 0;
  $('#deck-position').textContent = `Slide ${item.slide + 1} of ${item.slideCount}`
    + (steps ? ` · ${item.step} of ${steps} revealed` : '');
  const { text: note, warn: bad } = describeBuild(rendered?.builds?.[item.slide]);
  const box = $('#deck-build');
  box.hidden = !note;
  box.textContent = note;
  box.classList.toggle('is-warn', bad);
  $$('.deck-toolbar [data-cmd="build"]').forEach((b) => b.setAttribute('aria-pressed', String(!!deck.slides[current]?.hasBuild)));
}

// Clicking a heading or a line of text on the preview puts the cursor on it
// in the markdown, as near as text matching can find it.
function wirePreviewClicks(host) {
  host.addEventListener('click', (ev) => {
    const target = ev.composedPath()[0];
    const words = (target?.textContent || '').trim().replace(/\s+/g, ' ');
    const slide = deck.slides[current];
    if (!slide) return;
    let at = -1;
    if (words) {
      const probe = words.slice(0, 40);
      at = slide.raw.indexOf(probe);
      if (at === -1) {
        // Formatting (**, `, links) breaks a straight match; try the first word run.
        const first = probe.split(' ').slice(0, 3).join(' ');
        at = first ? slide.raw.indexOf(first) : -1;
      }
    }
    if (target?.tagName === 'IMG') {
      const src = target.getAttribute('src');
      const m = slide.media.find((x) => src && (src.endsWith(x.src) || x.src.endsWith(src)));
      if (m) at = m.start;
    }
    const pos = at >= 0 ? slide.start + at : slideCursorPos(deck, current);
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  });
}

// --- the slide strip -----------------------------------------------------------------

let stripShadow = null;
let stripBuiltFor = null;
let stripPolyfill = null;

function buildStrip() {
  if (!rendered || stripBuiltFor === renderedId) { markStrip(); return; }
  stripBuiltFor = renderedId;
  stripShadow ??= $('#deck-strip').attachShadow({ mode: 'open' });
  stripShadow.innerHTML = `<style>
    :host { display: block; }
    .cell { display: block; width: 100%; margin: 0 0 10px; padding: 0; text-align: left; background: none; border: 0; color: inherit; cursor: pointer; }
    .thumb { position: relative; aspect-ratio: ${rendered.aspects?.[0] || 16 / 9}; overflow: hidden; background: #fff; border: 2px solid #2a3038; border-radius: 8px; }
    .cell.on .thumb { border-color: #6ea8fe; }
    .cell.drop .thumb { border-color: #ffc94d; border-style: dashed; }
    .thumb .marpit { position: absolute; inset: 0; }
    .thumb svg { display: block; width: 100%; height: 100%; }
    .podium-fragment { opacity: 1 !important; }
    .num { position: absolute; right: 3px; bottom: 3px; padding: 0 5px; border-radius: 4px; background: rgba(0,0,0,.65); color: #fff; font: 600 11px/1.6 system-ui, sans-serif; }
    .badges { position: absolute; left: 3px; bottom: 3px; display: flex; gap: 3px; }
    .badge { padding: 0 4px; border-radius: 4px; font: 700 11px/1.6 system-ui, sans-serif; background: rgba(0,0,0,.65); color: #fff; }
    .badge.warn { background: #ffc94d; color: #151b23; }
    .cap { margin-top: 4px; font: 12px/1.3 system-ui, sans-serif; color: #b7c0cc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cell.on .cap { color: #e7ecf2; font-weight: 600; }
    .acts { display: none; gap: 4px; margin-top: 4px; }
    .cell.on .acts { display: flex; }
    .acts button { flex: 1; min-height: 28px; font: 12px system-ui, sans-serif; color: #e8ecf1; background: #1b2027; border: 1px solid #2a3038; border-radius: 6px; cursor: pointer; }
    .acts button:disabled { opacity: .4; cursor: default; }
    .acts button.armed { background: #6b1a1a; border-color: #ff4d4f; }
    /* Narrow (Issue #231): the editor is one column, so the slides are one
       row of small thumbnails that scrolls sideways. */
    @media (max-width: 960px) {
      #cells { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px; }
      .cell { flex: 0 0 168px; margin: 0; }
    }
  </style><style>${rendered.css}</style><div id="cells"></div>`;
  const holder = document.createElement('div');
  holder.innerHTML = rendered.html;
  applyFits(holder, rendered.fits);
  const cells = stripShadow.getElementById('cells');
  Array.from(holder.querySelectorAll('svg[data-marpit-svg]')).forEach((svg, i) => {
    const cell = el('div', { class: 'cell', role: 'listitem', tabindex: '0', draggable: 'true', 'data-index': String(i) });
    const marpit = el('div', { class: 'marpit' });
    marpit.append(svg);
    const thumb = el('div', { class: 'thumb' }, marpit, el('span', { class: 'num' }, String(i + 1)), el('span', { class: 'badges' }));
    cell.append(thumb, el('div', { class: 'cap' }), el('div', { class: 'acts' },
      el('button', { type: 'button', title: 'Move up', 'data-act': 'up' }, '↑'),
      el('button', { type: 'button', title: 'Move down', 'data-act': 'down' }, '↓'),
      el('button', { type: 'button', title: 'Duplicate', 'data-act': 'dup' }, '⧉'),
      el('button', { type: 'button', title: 'Delete this slide', 'data-act': 'del' }, '🗑')));
    cells.append(cell);
  });
  cells.addEventListener('click', onStripClick);
  cells.addEventListener('keydown', (ev) => {
    const cell = ev.target.closest?.('.cell');
    if (cell && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); goToSlide(Number(cell.dataset.index)); }
  });
  cells.addEventListener('dragstart', (ev) => {
    const cell = ev.target.closest?.('.cell');
    if (!cell) return;
    ev.dataTransfer.setData('text/x-podium-slide', cell.dataset.index);
    ev.dataTransfer.effectAllowed = 'move';
  });
  cells.addEventListener('dragover', (ev) => {
    const cell = ev.target.closest?.('.cell');
    if (!cell || !(ev.dataTransfer.types.includes('text/x-podium-slide') || ev.dataTransfer.types.includes('Files'))) return;
    ev.preventDefault();
    stripShadow.querySelectorAll('.cell.drop').forEach((c) => c.classList.toggle('drop', c === cell));
    cell.classList.add('drop');
  });
  cells.addEventListener('dragleave', (ev) => ev.target.closest?.('.cell')?.classList.remove('drop'));
  cells.addEventListener('drop', (ev) => {
    const cell = ev.target.closest?.('.cell');
    stripShadow.querySelectorAll('.cell.drop').forEach((c) => c.classList.remove('drop'));
    if (!cell) return;
    ev.preventDefault();
    // A picture or video dropped on a slide goes on that slide.
    if (ev.dataTransfer.files?.length) {
      goToSlide(Number(cell.dataset.index));
      if (!media.takeFiles(ev.dataTransfer.files)) warn('Only pictures and videos can be dropped on a slide.');
      return;
    }
    const from = Number(ev.dataTransfer.getData('text/x-podium-slide'));
    const to = Number(cell.dataset.index);
    moveSlide(from, to);
  });
  markStrip();
  // Marp's own polyfill for inline-SVG slides (Issue #231): without it,
  // WebKit - Safari, and every iPad - lays a slide's content out at its full
  // 1280px inside the small thumbnail, so all that shows is its top-left
  // corner. The controller's slide grid and every renderer already do this.
  stripPolyfill?.cleanup?.();
  stripPolyfill = null;
  const built = stripBuiltFor;
  applyPolyfill(stripShadow).then((handle) => {
    if (stripBuiltFor === built) stripPolyfill = handle;
    else handle?.cleanup?.();
  });
}

function markStrip() {
  if (!stripShadow) return;
  $('#deck-count').textContent = `${deck.slides.length}`;
  const slideProblems = new Set(problems.filter((p) => p.severity === 'warning').map((p) => p.slide));
  stripShadow.querySelectorAll('.cell').forEach((cell) => {
    const i = Number(cell.dataset.index);
    const slide = deck.slides[i];
    cell.classList.toggle('on', i === current);
    cell.setAttribute('aria-current', i === current ? 'true' : 'false');
    cell.querySelector('.cap').textContent = slide?.title || `Slide ${i + 1}`;
    const badges = cell.querySelector('.badges');
    badges.replaceChildren(
      ...(slide?.video ? [el('span', { class: 'badge', title: 'Video slide' }, '🎬')] : []),
      ...(slide?.hasBuild ? [el('span', { class: 'badge', title: 'Builds' }, '▶')] : []),
      ...(slide?.notes ? [el('span', { class: 'badge', title: 'Has presenter notes' }, '✎')] : []),
      ...(slideProblems.has(i) ? [el('span', { class: 'badge warn', title: 'Something to check' }, '!')] : []),
    );
    const acts = cell.querySelector('.acts');
    acts.querySelector('[data-act="up"]').disabled = i === 0 || deck.headingDivider;
    acts.querySelector('[data-act="down"]').disabled = i >= deck.slides.length - 1 || deck.headingDivider;
    acts.querySelector('[data-act="dup"]').disabled = deck.headingDivider;
    acts.querySelector('[data-act="del"]').disabled = deck.slides.length < 2 || deck.headingDivider;
  });
  const on = stripShadow.querySelector('.cell.on');
  on?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

let deleteArmed = null;
function onStripClick(ev) {
  const button = ev.target.closest?.('button[data-act]');
  const cell = ev.target.closest?.('.cell');
  if (!cell) return;
  const i = Number(cell.dataset.index);
  if (!button) { goToSlide(i); return; }
  ev.stopPropagation();
  const act = button.dataset.act;
  if (act === 'up') moveSlide(i, i - 1);
  else if (act === 'down') moveSlide(i, i + 1);
  else if (act === 'dup') applyText(DS.duplicateSlide(text(), i), { selectSlide: i + 1 });
  else if (act === 'del') {
    // Two taps, like every other irreversible button in Podium - and Undo
    // (Ctrl/Cmd+Z) brings it back regardless.
    if (deleteArmed === i) {
      deleteArmed = null;
      applyText(DS.deleteSlide(text(), i), { selectSlide: Math.max(0, i - 1) });
    } else {
      deleteArmed = i;
      button.classList.add('armed');
      button.textContent = 'Sure?';
      setTimeout(() => { if (deleteArmed === i) { deleteArmed = null; markStrip(); button.classList.remove('armed'); button.textContent = '🗑'; } }, 4000);
    }
  }
}

function moveSlide(from, to) {
  if (deck.headingDivider || from === to || to < 0 || to >= deck.slides.length) return;
  applyText(DS.moveSlide(text(), from, to), { selectSlide: to });
}

function goToSlide(i) {
  const pos = slideCursorPos(deck, i);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  view.focus();
}

function showCurrent() {
  markStrip();
  updatePreview();
  renderSlidePanel();
  // Re-draw the current-slide band in the editor.
  view.dispatch({});
}

// --- the slide panel (directives and notes for the slide you are on) ----------------

function renderSlidePanel() {
  const slide = deck.slides[current];
  if (!slide) return;
  $('#deck-slide-heading').textContent = `Slide ${current + 1}${slide.title ? ` — ${slide.title}` : ''}`;
  const build = $('#deck-slide-build');
  build.checked = slide.hasBuild;
  build.disabled = deck.headingDivider;
  const cls = $('#deck-slide-class');
  if (document.activeElement !== cls) {
    cls.value = slide.spot.class !== undefined ? slide.spot.class : '';
    cls.placeholder = slide.spot.class === undefined && slide.classes.length ? `${slide.classes.join(' ')} (carried from before)` : 'e.g. lead';
  }
  const bg = slide.directives.backgroundColor;
  $('#deck-slide-bg').value = /^#[0-9a-f]{6}$/i.test(bg || '') ? bg : '#ffffff';
  $('#deck-slide-bg-clear').disabled = !slide.spot.backgroundColor;
  $('#deck-slide-paginate').value = slide.spot.paginate ?? '';
  const notes = $('#deck-slide-notes');
  if (document.activeElement !== notes) notes.value = slide.notes;
  $('#deck-slide-video').hidden = !slide.video;
  if (slide.video) {
    const name = decodeURIComponent(slide.video.src.split(/[?#]/)[0].split('/').pop() || slide.video.src);
    $('#deck-slide-video-text').textContent = `🎬 Video slide: ${name}${slide.video.start ? `, from ${DS.formatTimecode(slide.video.start)}` : ''}. Played from the controller.`;
  }
  $$('.deck-toolbar [data-cmd="build"]').forEach((b) => b.setAttribute('aria-pressed', String(slide.hasBuild)));
}

function wireSlidePanel() {
  $('#deck-slide-build').addEventListener('change', (ev) => applyText(DS.setSlideBuild(text(), current, ev.target.checked)));
  $('#deck-slide-class').addEventListener('change', (ev) => applyText(DS.setSlideDirective(text(), current, 'class', ev.target.value.trim() || null)));
  $('#deck-slide-bg').addEventListener('change', (ev) => applyText(DS.setSlideDirective(text(), current, 'backgroundColor', ev.target.value)));
  $('#deck-slide-bg-clear').addEventListener('click', () => applyText(DS.setSlideDirective(text(), current, 'backgroundColor', null)));
  $('#deck-slide-paginate').addEventListener('change', (ev) => applyText(DS.setSlideDirective(text(), current, 'paginate', ev.target.value || null)));
  $('#deck-slide-video-change').addEventListener('click', () => media.openVideo());
  // The poster stays: it is an ordinary background picture, and the slide may
  // as well keep showing it. Delete it in the markdown if not.
  $('#deck-slide-video-remove').addEventListener('click', () => applyText(DS.setSlideVideo(text(), current, {})));
  let notesTimer = null;
  const notes = $('#deck-slide-notes');
  const writeNotes = () => {
    clearTimeout(notesTimer);
    const slide = deck.slides[current];
    if (!slide || slide.notes === notes.value.trim()) return;
    applyText(DS.setSlideNotes(text(), current, notes.value));
  };
  notes.addEventListener('input', () => { clearTimeout(notesTimer); notesTimer = setTimeout(writeNotes, 700); });
  notes.addEventListener('blur', writeNotes);
}

// --- deck settings (front matter) ----------------------------------------------------

function renderDeckSettings() {
  const f = deck.frontMatter.fields;
  const title = $('#deck-title');
  if (document.activeElement !== title) title.value = f.title || '';
  const theme = $('#deck-theme');
  const names = [...new Set([...themeNames, ...(f.theme ? [f.theme] : [])])];
  theme.replaceChildren(el('option', { value: '' }, 'Marp default'), ...names.filter((n) => n !== 'default').map((n) => el('option', { value: n }, n)));
  theme.value = f.theme && f.theme !== 'default' ? f.theme : '';
  $('#deck-size').value = ['16:9', '4:3'].includes(f.size) ? f.size : '';
  $('#deck-paginate').value = f.paginate === 'true' ? 'true' : '';
  for (const key of ['header', 'footer']) {
    const input = $(`#deck-${key}`);
    if (document.activeElement !== input) input.value = f[key] || '';
  }
  $('#deck-theme-note').textContent = rendered?.themeWarning || '';
}

function wireDeckSettings() {
  const set = (key, value) => applyText(DS.setFrontMatter(text(), key, value));
  $('#deck-title').addEventListener('change', (ev) => set('title', ev.target.value.trim() || null));
  $('#deck-theme').addEventListener('change', (ev) => set('theme', ev.target.value || null));
  $('#deck-size').addEventListener('change', (ev) => set('size', ev.target.value || null));
  $('#deck-paginate').addEventListener('change', (ev) => set('paginate', ev.target.value || null));
  $('#deck-header').addEventListener('change', (ev) => set('header', ev.target.value.trim() || null));
  $('#deck-footer').addEventListener('change', (ev) => set('footer', ev.target.value.trim() || null));
}

// --- problems ------------------------------------------------------------------------

// Whether each picture and video on this server is really there (Issue #226),
// asked once per address - see checkServerMedia in deck-checks.js.
const mediaFound = new Map();   // src -> true | 'HTTP 404' | null while asking

function computeProblems() {
  checkServerMedia(deck, mediaFound, computeProblems);
  problems = deckProblems(text(), rendered, { destination: destination(), pageProtocol: location.protocol, mediaFound });
  renderProblems();
  markStrip();
  renderDeckSettings();
}

function renderProblems() {
  const list = $('#deck-problems');
  $('#deck-problem-count').textContent = problems.length ? `(${problems.length})` : '';
  list.replaceChildren(...(problems.length ? problems.map((p) => el('li', { class: `is-${p.severity}` },
    el('button', { type: 'button', onclick: () => { view.dispatch({ selection: { anchor: Math.min(p.offset, view.state.doc.length) }, scrollIntoView: true }); view.focus(); } },
      `Slide ${p.slide + 1}: `), p.message)) : [el('li', { class: 'is-ok' }, 'Nothing to fix.')]));
  if (!view) return;
  const doc = view.state.doc;
  const diagnostics = problems.map((p) => {
    const from = Math.min(p.offset, doc.length);
    const line = doc.lineAt(from);
    return { from, to: Math.max(from, Math.min(line.to, from + 200)), severity: p.severity, message: p.message };
  });
  view.dispatch(CM.setDiagnostics(view.state, diagnostics));
}

// --- toolbar --------------------------------------------------------------------------

function wrapSelection(marker) {
  const { from, to } = view.state.selection.main;
  const chosen = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: `${marker}${chosen}${marker}` },
    selection: chosen ? { anchor: from, head: to + marker.length * 2 } : { anchor: from + marker.length },
  });
  view.focus();
}

function prefixLines(make) {
  const { from, to } = view.state.selection.main;
  const doc = view.state.doc;
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  const changes = [];
  for (let n = first; n <= last; n++) {
    const line = doc.line(n);
    const next = make(line.text, n - first);
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  }
  view.dispatch({ changes });
  view.focus();
}

function insertBlock(textToInsert, cursorOffset) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const at = line.text.trim() ? line.to : line.from;
  const lead = line.text.trim() ? '\n\n' : '';
  view.dispatch({ changes: { from: at, insert: lead + textToInsert }, selection: { anchor: at + lead.length + cursorOffset } });
  view.focus();
}

const COMMANDS = {
  heading: () => prefixLines((t) => {
    const m = /^(#{1,6})\s+/.exec(t);
    if (!m) return `# ${t}`;
    return m[1].length >= 3 ? t.slice(m[0].length) : `${m[1]}# ${t.slice(m[0].length)}`;
  }),
  bold: () => wrapSelection('**'),
  italic: () => wrapSelection('*'),
  list: () => prefixLines((t) => (/^\s*[-*+]\s/.test(t) ? t.replace(/^(\s*)[-*+]\s/, '$1') : `- ${t}`)),
  numbered: () => prefixLines((t, i) => (/^\s*\d+[.)]\s/.test(t) ? t.replace(/^(\s*)\d+[.)]\s/, '$1') : `${i + 1}. ${t}`)),
  build: () => applyText(DS.setSlideBuild(text(), current, !deck.slides[current]?.hasBuild)),
  image: () => media.openPicture(),
  template: () => templates.open({ kind: 'slide' }),
  video: () => media.openVideo(),
  math: () => insertBlock('$$\n\n$$\n', 3),
  code: () => insertBlock('```\n\n```\n', 4),
};

// --- diagrams (Issue #235) ---------------------------------------------------------

/** Put a whole block on its own lines where `from`-`to` is, and leave the cursor at `cursor` within it. */
function blockChange(from, to, block, cursor) {
  const doc = view.state.doc;
  const line = doc.lineAt(from);
  const before = doc.sliceString(line.from, from);
  const after = doc.sliceString(to, doc.lineAt(to).to);
  // A blank line between it and the text above, which reads better in the markdown.
  const above = line.number > 1 ? doc.line(line.number - 1).text : '';
  const lead = before.trim() ? '\n\n' : (above.trim() ? '\n' : '');
  const tail = after.trim() ? '\n' : '';
  return {
    changes: { from, to, insert: lead + block + tail },
    selection: { anchor: from + lead.length + cursor },
    scrollIntoView: true,
  };
}

function insertDiagram(id) {
  const block = starterFence(id);
  if (!block) return;
  const { from, to } = view.state.selection.main;
  // The cursor ends on the diagram's first line, ready to change its kind or direction.
  view.dispatch(blockChange(from, to, block, '```mermaid\n'.length));
  view.focus();
}

async function openInMermaidLive() {
  const found = fenceAt(text(), view.state.selection.main.head);
  if (!found) return;
  // The theme Podium drew it in, so it looks the same there - unless it says its own.
  const theme = rendered?.diagrams?.[found.index]?.theme || 'default';
  const link = await mermaidLiveLink(found.body, { theme });
  window.open(link, '_blank', 'noopener');
}

let pasteAsk = null;   // {from, to, link} of a pasted mermaid.live link while the dialog asks about it

/**
 * A mermaid.live link pasted in goes in as the link first, then the dialog
 * asks. "Diagram" swaps it for the diagram it holds, as a separate step, so
 * undo puts the link back.
 */
async function pasteLiveLink(link) {
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: link },
    selection: { anchor: from + link.length },
    userEvent: 'input.paste',
    annotations: CM.isolateHistory.of('full'),
  });
  const diagram = await readMermaidLiveLink(link);
  if (!diagram) return;   // not one this can read: it stays a link
  pasteAsk = { from, to: from + link.length, link, diagram };
  $('#deck-mermaid-preview').textContent = fenceFromLink(diagram).trim();
  $('#deck-mermaid-dialog').hidden = false;
  $('#deck-mermaid-diagram').focus();
}

function answerPaste(asDiagram) {
  const ask = pasteAsk;
  pasteAsk = null;
  $('#deck-mermaid-dialog').hidden = true;
  if (ask && asDiagram && view.state.sliceDoc(ask.from, ask.to) === ask.link) {
    view.dispatch({
      ...blockChange(ask.from, ask.to, fenceFromLink(ask.diagram), '```mermaid\n'.length),
      userEvent: 'input.paste',
      annotations: CM.isolateHistory.of('full'),
    });
  }
  view.focus();
}

function wireDiagrams() {
  const menu = $('#deck-diagram-menu');
  const toggle = $('#deck-diagram');
  const live = $('#deck-diagram-live');
  const close = () => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  $('#deck-diagram-starters').replaceChildren(...STARTERS.map((starter) => el('button', {
    type: 'button',
    'data-diagram': starter.id,
    onclick: () => { close(); insertDiagram(starter.id); },
  }, starter.label)));
  toggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.hidden = !menu.hidden;
    toggle.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) {
      const inside = !!fenceAt(text(), view.state.selection.main.head);
      live.disabled = !inside;
      live.title = inside ? 'Edit it there; paste its link back here when you are done' : 'Put the cursor in a diagram first';
    }
  });
  document.addEventListener('click', (ev) => { if (!menu.hidden && !ev.target.closest('.deck-diagram-wrap')) close(); });
  menu.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { close(); toggle.focus(); } });
  live.addEventListener('click', () => { close(); openInMermaidLive(); });

  $('#deck-mermaid-diagram').addEventListener('click', () => answerPaste(true));
  $('#deck-mermaid-link').addEventListener('click', () => answerPaste(false));
  $('#deck-mermaid-dialog').addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); answerPaste(false); }
  });
}

function wireToolbar() {
  $$('.deck-toolbar [data-cmd]').forEach((button) => button.addEventListener('click', () => COMMANDS[button.dataset.cmd]?.()));
  $('#deck-add-slide').addEventListener('click', addSlide);
  $('#deck-focus').addEventListener('change', (ev) => (ev.target.checked ? focusSlide() : view.dispatch({ effects: unfoldEverything() })));
  $('#deck-prev').addEventListener('click', () => stepPreview('prev'));
  $('#deck-next').addEventListener('click', () => stepPreview('next'));
}

// A new slide after this one, its title selected so typing names it - and the
// editor focused, so typing goes there rather than to the button.
function addSlide() {
  if (deck.headingDivider) return;
  const at = current + 1;
  const next = DS.insertSlide(text(), at, '\n## New slide\n\n');
  applyText(next, { selectSlide: at });
  const slide = DS.parseDeck(next).slides[at];
  const title = slide ? slide.raw.indexOf('New slide') : -1;
  if (title >= 0) view.dispatch({ selection: { anchor: slide.start + title, head: slide.start + title + 'New slide'.length } });
  view.focus();
}

function stepPreview(dir) {
  if (!rendered) return;
  const item = previewItem();
  const pos = deckStep(item, dir, item.fragments, item.slideCount);
  step = pos.step;
  if (pos.slide !== current) {
    // Moving the preview moves the cursor too, keeping the two in step.
    const keep = pos.step;
    goToSlide(pos.slide);
    step = keep;
  }
  updatePreview();
}

function unfoldEverything() {
  const effects = [];
  CM.foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => { effects.push(CM.unfoldEffect.of({ from, to })); });
  return effects;
}

function focusSlide() {
  const effects = unfoldEverything();
  const doc = view.state.doc;
  for (const slide of deck.slides) {
    if (slide.index === current) continue;
    const head = slide.index === 0 ? slide.start : slide.start - slide.sep.length;
    const line = doc.lineAt(Math.min(head, doc.length));
    const end = Math.min(slide.end - 1, doc.length);
    if (end > line.to) effects.push(CM.foldEffect.of({ from: line.to, to: end }));
  }
  view.dispatch({ effects });
}

// --- pictures and videos (see deck-media.js) ----------------------------------------

/** What uploads say they were for: the deck's title, or failing that its file name. */
function deckName() {
  return deck.frontMatter.fields.title || origin.title || deck.slides[0]?.title || fileName();
}

const media = createDeckMedia({
  canUpload: () => !!(info?.features.includes('library') && info?.user),
  keepInPlan: () => (origin.kind === 'plan' ? keepPictureInPlan : null),
  courses: () => libraryCourses,
  deckCourse: () => origin.course || params.get('course') || '',
  deckName,
  insertPicture: (tag) => insertBlock(`${tag}\n`, tag.length + 1),
  makeVideoSlide: (video) => applyText(DS.setSlideVideo(text(), current, video), { selectSlide: current }),
  currentVideo: () => deck.slides[current]?.video || null,
  done: () => view.focus(),
});

// --- a library deck's earlier versions -----------------------------------------------

async function openVersions() {
  const dialog = $('#deck-versions-dialog');
  const list = $('#deck-versions-list');
  const note = $('#deck-versions-note');
  note.textContent = 'Looking…';
  list.replaceChildren();
  dialog.hidden = false;
  $('#deck-versions-close').focus();
  try {
    const res = await fetch(`/api/library/${origin.id}/revisions`, { credentials: 'same-origin', cache: 'no-cache' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    note.textContent = body.revisions.length ? '' : 'There are none yet: every save from now on keeps the version it replaces.';
    const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    list.replaceChildren(...body.revisions.map((r) => el('li', {},
      el('span', {}, `Until ${when(r.replacedAt)}${r.replacedBy ? `, when ${r.replacedBy} saved over it` : ''}`,
        el('small', { class: 'hint' }, ` · ${Math.max(1, Math.round(r.bytes / 1024))} KB`)),
      el('button', {
        type: 'button',
        onclick: async () => {
          try {
            const file = await fetch(`/media/${r.version}/${encodeURIComponent(origin.name || 'deck.md')}`, { credentials: 'same-origin' });
            if (!file.ok) throw new Error(`HTTP ${file.status}`);
            const older = await file.text();
            dialog.hidden = true;
            applyText(older);
            warn(`This is the deck as it was until ${when(r.replacedAt)}. Save to make it the deck again, or Undo (Ctrl/Cmd+Z) to go back.`);
            view.focus();
          } catch (err) {
            note.textContent = `Could not open that version: ${err.message}`;
          }
        },
      }, 'Open this version'))));
  } catch (err) {
    note.textContent = `Could not list the versions: ${err.message}`;
  }
}

function wireVersions() {
  const dialog = $('#deck-versions-dialog');
  const close = () => { dialog.hidden = true; view.focus(); };
  $('#deck-versions-close').addEventListener('click', close);
  dialog.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } });
}

// --- templates (see deck-templates.js) -------------------------------------------------

const templateWho = () => ({ server: !!(info?.features.includes('deckTemplates') && info?.user), isAdmin: !!info?.user?.isAdmin });

const templates = createTemplatesPanel({
  server: () => templateWho().server,
  isAdmin: () => templateWho().isAdmin,
  courses: () => libraryCourses,
  deckCourse: () => origin.course || params.get('course') || '',
  deck: () => deck,
  current: () => current,
  text,
  insertSlides,
  startDeck,
  done: () => view.focus(),
});

/** A slide template's slides, after the one you are on - then its picture or video, if it asks for one. */
function insertSlides(slides, then) {
  if (deck.headingDivider) { warn('This deck splits slides on headings, so slides cannot be added from templates here.'); return; }
  const at = current + 1;
  const next = DS.insertSlide(text(), at, `\n${slides.trim()}\n\n`);
  applyText(next, { selectSlide: at });
  if (then) {
    // After the slide's heading, where the picture dialog puts what it adds.
    const slide = DS.parseDeck(next).slides[at];
    const heading = slide ? /^ {0,3}#{1,6}[ \t].*$/m.exec(slide.raw) : null;
    if (heading) view.dispatch({ selection: { anchor: slide.start + heading.index + heading[0].length } });
    if (then === 'picture') media.openPicture();
    else if (then === 'video') media.openVideo();
  }
  view.focus();
}

/** A new deck from a deck template: here, if nothing is open yet, else in this tab afresh. */
function startDeck(template) {
  if (origin.kind === 'new' && text() === openedWith) {
    setDocument(template.markdown);
    openedWith = template.markdown;
    savedText = '';
    describeOrigin();
    refreshSaveState();
    renderNow();
    renderDeckSettings();
    renderSlidePanel();
    return;
  }
  keepDraftNow();
  location.href = `deck.html?${new URLSearchParams({ from: template.scope === 'builtin' ? `b:${template.id}` : `s:${template.id}` })}`;
}

async function openTemplate(key) {
  const t = await findTemplate(key, templateWho());
  if (!t) throw new Error('That template is not here any more, or you cannot see it.');
  if (!t.editable) {
    origin = { kind: 'new' };
    warn(`“${t.title}” is not yours to change, so this is a new deck made from it. Save it as a template of your own from the Save menu.`);
    return t.markdown;
  }
  origin = { kind: 'template', id: t.id, title: t.title, name: t.title, scope: t.scope, course: t.course, templateKind: t.kind, editable: true };
  return t.markdown;
}

async function saveTemplate() {
  saving = true;
  setSaveState('Saving…');
  try {
    const res = await fetch(`/api/deck-templates/${origin.id}`, {
      method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: text() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    savedOk('Saved to the template');
  } catch (err) {
    saving = false;
    refreshSaveState();
    warn(`That did not save: ${err.message}`);
  }
}

async function keepPictureInPlan(dataUrl, name) {
  const reply = await askPlanner({ type: 'plan-asset-put', planId: origin.planId, itemId: origin.itemId, data: dataUrl, name });
  planPictures.set(reply.id, dataUrl);
  return `asset:${reply.id}`;
}

// A picture or video dropped or pasted anywhere on the page that nothing
// more particular took (the editor and the strip handle their own).
function wirePageDrops() {
  const hasFiles = (ev) => Array.from(ev.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragover', (ev) => { if (hasFiles(ev)) ev.preventDefault(); });
  document.addEventListener('drop', (ev) => {
    if (!hasFiles(ev) || ev.defaultPrevented) return;
    ev.preventDefault();
    if (!media.takeFiles(ev.dataTransfer.files)) warn('Only pictures (.png, .jpg, .gif, .webp) and videos (.mp4, .webm) can be dropped here, and only on Podium\'s own server.');
  });
  document.addEventListener('paste', (ev) => {
    if (ev.defaultPrevented || ev.target.closest?.('input, textarea, .cm-editor')) return;
    if (media.takeFiles(ev.clipboardData?.files)) ev.preventDefault();
  });
}

// --- opening ---------------------------------------------------------------------------

async function loadLibraryCourses() {
  try {
    const res = await fetch('/api/library', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const body = await res.json();
    libraryCourses = body.courses || [];
    return body.items || [];
  } catch { return []; }
}

async function openLibrary(id) {
  const items = await loadLibraryCourses();
  const item = items.find((i) => String(i.id) === String(id));
  if (!item || item.type !== 'deck') throw new Error('That deck is not in the library, or you cannot see it.');
  const res = await fetch(item.src, { cache: 'no-cache', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Could not read that deck (HTTP ${res.status}).`);
  const value = await res.text();
  origin = { kind: 'library', id: item.id, item, version: item.version, editable: !!item.editable, name: item.filename, title: item.title, course: item.course };
  return value;
}

async function openContent(name) {
  const res = await fetch(`/api/content/files/decks/${encodeURIComponent(name)}`, { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Could not read content/decks/${name}.`);
  origin = { kind: 'content', name: body.file.filename, mtime: body.file.mtime, editable: true, title: body.file.filename };
  return body.file.text;
}

async function openSrc(src) {
  // A deck already on this server is edited where it is, whichever way the
  // address names it - so the planner, the controller and a link can all
  // just say which deck, and Save puts it back there.
  const where = deckLocation(src);
  const server = !!(info?.features.includes('library') && info?.user);
  if (where.kind === 'library' && server) return openLibrary(where.id);
  if (where.kind === 'version' && server) {
    const res = await fetch(`/api/library/deck-for/${where.sha}`, { credentials: 'same-origin' });
    const found = res.ok ? (await res.json()).item : null;
    if (found) {
      const value = await openLibrary(found.id);
      // The address named this deck by its contents, which a save changes.
      // Whatever pointed at it (a lecture in the planner) now points at the
      // deck's own address, so it follows this edit and every later one.
      relinkToLibrary(found);
      if (!found.current) warn(`That address held an earlier version of “${found.title}”. This is the deck as it is now; Previous versions has the older ones.`);
      return value;
    }
  }
  if (where.kind === 'content') {
    if (info?.user?.isAdmin) return openContent(where.name);
    const value = await openPlainSrc(src);
    if (server) warn(`content/decks/${where.name} is kept by the server's administrators, so only they can save over it. Save makes a copy of it in the library, for you to edit and present.`);
    return value;
  }
  return openPlainSrc(src);
}

function relinkToLibrary(item) {
  const fromPlan = params.get('plan') && params.get('item') ? { planId: params.get('plan'), itemId: params.get('item') } : null;
  if (fromPlan) channel?.postMessage({ type: 'deck-linked', ...fromPlan, src: item.src, title: item.title, from: 'editor' });
}

async function openPlainSrc(src) {
  const res = await fetch(src, { cache: 'no-cache', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Could not read ${src} (HTTP ${res.status}).`);
  origin = { kind: 'file', src, name: decodeURIComponent(src.split('/').pop() || 'deck.md'), title: '' };
  return res.text();
}

// A deck inside a lecture plan lives in the planner tab that opened this one;
// ask it for the markdown, and hand it back the same way on Save.
function askPlanner(message, { timeout = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    if (!channel) { reject(new Error('This browser cannot talk to the planner tab.')); return; }
    const nonce = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { channel.removeEventListener('message', onReply); reject(new Error('The planner tab did not answer. Keep the lecture open in the planner while you edit its deck.')); }, timeout);
    const onReply = (ev) => {
      if (ev.data?.nonce !== nonce || ev.data?.from !== 'planner') return;
      clearTimeout(timer);
      channel.removeEventListener('message', onReply);
      if (ev.data.error) reject(new Error(ev.data.error));
      else resolve(ev.data);
    };
    channel.addEventListener('message', onReply);
    channel.postMessage({ ...message, nonce, from: 'editor' });
  });
}

async function openPlan(planId, itemId) {
  const reply = await askPlanner({ type: 'plan-deck-get', planId, itemId });
  origin = { kind: 'plan', planId, itemId, name: reply.name || 'deck.md', title: reply.title || '', planTitle: reply.planTitle || '', course: reply.course || '', editable: true };
  for (const [id, data] of Object.entries(reply.pictures || {})) planPictures.set(id, data);
  return reply.markdown ?? '';
}

function describeOrigin() {
  const where = $('#deck-where');
  const label = {
    library: () => `Library${origin.course ? ` · ${origin.course.toUpperCase()}` : ''} · ${origin.name}${origin.editable ? '' : ' · view only'}`,
    content: () => `content/decks/${origin.name}`,
    plan: () => `Inside the lecture “${origin.planTitle || 'plan'}”`,
    template: () => `Template · ${origin.scope === 'course' ? (origin.course || '').toUpperCase() : 'Mine'} · ${origin.title} (${origin.templateKind === 'deck' ? 'a whole deck' : 'a slide'})`,
    file: () => (origin.src ? `Opened from ${origin.src}` : `${origin.name || 'A file'} · not saved anywhere yet`),
    new: () => 'New deck · not saved anywhere yet',
  }[origin.kind];
  where.textContent = label ? label() : '';
  const canSaveHere = (origin.kind === 'library' && origin.editable) || origin.kind === 'content' || origin.kind === 'plan' || origin.kind === 'template';
  $('#deck-save').textContent = canSaveHere ? 'Save' : 'Save…';
  $('#deck-save-library').hidden = !(info?.features.includes('library') && info?.user);
  $('#deck-save-content').hidden = !info?.user?.isAdmin;
  $('#deck-versions').hidden = origin.kind !== 'library';
  if (origin.kind === 'library' && !origin.editable) {
    warn(origin.course
      ? `You can change this deck here and present it, but only an owner of ${origin.course.toUpperCase()} or an admin can save over it. Save a copy instead.`
      : 'Only the person who added this deck, or an admin, can save over it. Save a copy instead.');
  }
}

async function start() {
  info = await serverInfo();
  mountSessionBadge($('#session-badge'));
  loadThemes();
  let initial = STARTER;
  try {
    if (params.get('plan') && params.get('item') && params.get('embedded')) initial = await openPlan(params.get('plan'), params.get('item'));
    else if (params.get('library')) initial = await openLibrary(params.get('library'));
    else if (params.get('content')) initial = await openContent(params.get('content'));
    else if (params.get('src')) initial = await openSrc(params.get('src'));
    else if (params.get('template')) initial = await openTemplate(params.get('template'));
    else if (params.get('from')) {
      const t = await findTemplate(params.get('from'), templateWho());
      if (!t) throw new Error('That template is not here any more, or you cannot see it.');
      origin = { kind: 'new' };
      initial = t.kind === 'deck' ? t.markdown : `${STARTER.replace(/\n*$/, '\n\n---\n\n')}${slidesOf(t.markdown)}`;
    }
    else {
      origin = { kind: 'new' };
      const title = params.get('title');
      if (title) initial = DS.setFrontMatter(STARTER, 'title', title).replace('# Untitled deck', `# ${title}`);
    }
  } catch (err) {
    origin = { kind: 'new' };
    warn(`${err.message} Starting a new deck instead.`);
  }
  if (info.features.includes('library') && info.user && !libraryCourses.length) loadLibraryCourses();
  setDocument(initial);
  openedWith = initial;
  savedText = origin.kind === 'new' ? '' : initial;
  describeOrigin();
  // A deck just started from a template is not the unsaved new deck from
  // before; that draft stays for the next plain new deck.
  if (!params.get('from')) offerDraft(initial);
  refreshSaveState();
  renderNow();
  renderDeckSettings();
  renderSlidePanel();
}

function offerDraft(loaded) {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch { /* none */ }
  if (!draft?.text || draft.text === loaded) return;
  const when = new Date(draft.at).toLocaleString();
  const stale = draft.base !== loaded && origin.kind !== 'new';
  warn(`There are unsaved changes to this deck from ${when}${stale ? ', made to an older version than the one that is there now' : ''}.`, [
    ['Restore them', () => { applyText(draft.text); warn(''); }],
    ['Throw them away', () => { dropDraft(); warn(''); }],
  ]);
}

async function loadThemes() {
  try {
    const res = await fetch('marp-themes/themes.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.json();
    const files = Array.isArray(data) ? data : data.themes || [];
    for (const file of files) {
      try {
        const css = await (await fetch(`marp-themes/${file}`, { cache: 'no-cache' })).text();
        const name = /@theme\s+([\w-]+)/.exec(css)?.[1];
        if (name && !themeNames.includes(name)) themeNames.push(name);
        for (const m of css.matchAll(/section\.([A-Za-z][\w-]*)/g)) themeClasses.add(m[1]);
      } catch { /* one broken theme does not stop the rest */ }
    }
  } catch { /* no themes folder: the built-ins are still there */ }
  $('#deck-classes').replaceChildren(...[...themeClasses].map((c) => el('option', { value: c })));
  renderDeckSettings();
}

// --- saving -------------------------------------------------------------------------------

async function save() {
  if (saving) return;
  if (origin.kind === 'library' && origin.editable) return saveLibrary();
  if (origin.kind === 'content') return saveContent();
  if (origin.kind === 'plan') return savePlan();
  if (origin.kind === 'template') return saveTemplate();
  // Nowhere to save back to yet: the library if there is one, else a file.
  if (!$('#deck-save-library').hidden) openLibraryDialog();
  else downloadDeck();
}

function savedOk(message = 'Saved') {
  savedText = text();
  dropDraft();
  saving = false;
  setSaveState(message);
  setTimeout(refreshSaveState, 2500);
  describeOrigin();
}

async function saveLibrary({ force = false } = {}) {
  saving = true;
  setSaveState('Saving…');
  const value = text();
  try {
    const res = await fetch(`/api/library/${origin.id}/content`, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'content-type': 'text/markdown; charset=utf-8', ...(force ? {} : { 'if-match': `"${origin.version}"` }) },
      body: value,
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 412) {
      saving = false;
      refreshSaveState();
      conflict(body.version);
      return;
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    origin.version = body.item.version;
    origin.item = body.item;
    savedOk();
    channel?.postMessage({ type: 'deck-saved', src: body.item.src, from: 'editor' });
  } catch (err) {
    saving = false;
    refreshSaveState();
    warn(`That did not save: ${err.message}`);
  }
}

function conflict(theirVersion) {
  warn('Someone else saved this deck since you opened it.', [
    ['Save mine over theirs', () => { warn(''); origin.version = theirVersion; saveLibrary({ force: true }); }],
    ['Save mine as a copy', () => { warn(''); openLibraryDialog(); }],
    ['Load theirs (mine stays as a draft)', async () => {
      warn('');
      keepDraftNow();
      const fresh = await openLibrary(origin.id);
      setDocument(fresh);
      savedText = fresh;
      describeOrigin();
      renderNow();
    }],
  ]);
}

function keepDraftNow() {
  try { safeStorageSet(localStorage, draftKey(), JSON.stringify({ text: text(), base: savedText, at: Date.now() })); } catch { /* no storage */ }
}

async function saveContent({ name = origin.name, mtime = origin.mtime } = {}) {
  saving = true;
  setSaveState('Saving…');
  try {
    const query = mtime ? `?ifMtime=${encodeURIComponent(mtime)}` : '';
    const res = await fetch(`/api/content/files/decks/${encodeURIComponent(name)}${query}`, {
      method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'text/markdown; charset=utf-8' }, body: text(),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 412) {
      saving = false;
      refreshSaveState();
      warn(`content/decks/${name} was changed since you opened it.`, [
        ['Save mine over it', () => { warn(''); saveContent({ name, mtime: body.mtime }); }],
        ['Download mine', () => { warn(''); downloadDeck(); }],
      ]);
      return;
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    origin = { kind: 'content', name: body.saved.filename, mtime: body.saved.mtime, editable: true, title: body.saved.filename };
    history.replaceState(null, '', `?${new URLSearchParams({ content: origin.name })}`);
    savedOk();
    channel?.postMessage({ type: 'deck-saved', src: body.saved.url, from: 'editor' });
  } catch (err) {
    saving = false;
    refreshSaveState();
    warn(`That did not save: ${err.message}`);
  }
}

async function savePlan() {
  saving = true;
  setSaveState('Saving into the plan…');
  try {
    await askPlanner({ type: 'plan-deck-put', planId: origin.planId, itemId: origin.itemId, markdown: text(), title: deck.frontMatter.fields.title || '' });
    savedOk('Saved into the plan');
  } catch (err) {
    saving = false;
    refreshSaveState();
    warn(`That did not save into the plan: ${err.message}`, [['Download it instead', downloadDeck]]);
  }
}

function fileName() {
  const base = origin.name || deck.frontMatter.fields.title || deck.slides[0]?.title || 'deck';
  const clean = String(base).replace(/\.(md|markdown)$/i, '').replace(/[^\w .-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'deck';
  return `${clean}.md`;
}

function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// The deck and the pictures and videos it uses, as one .zip any Marp tool
// opens (see deck-export.js).
async function downloadZip() {
  setSaveState('Packing the .zip…');
  try {
    const md = text();
    // The deck as it is now, for its diagrams' pictures (Issue #235).
    const exportId = `export:${await deckId(md)}`;
    const drawn = /```mermaid/.test(md) ? await renderDeckSource(md, exportId).catch(() => null) : null;
    forgetDeck(exportId);
    const { blob, packed, skipped, diagrams } = await exportZip(md, {
      name: fileName(),
      resolve: (src) => (src.startsWith('asset:') ? planPictures.get(src.slice(6)) || null : null),
      diagrams: drawn?.diagrams || [],
    });
    saveBlob(fileName().replace(/\.md$/, '.zip'), blob);
    setSaveState(`Downloaded, with ${packed} file${packed === 1 ? '' : 's'}${diagrams ? ` and ${diagrams} diagram picture${diagrams === 1 ? '' : 's'}` : ''}`);
    if (skipped.length) warn(`Left out of the .zip, because this page could not fetch them: ${skipped.join(', ')}`);
  } catch (err) {
    warn(`That did not download: ${err.message}`);
  }
  setTimeout(refreshSaveState, 2500);
}

// The deck in Quick Look (Issue #242), in its own tab - full screen, with its
// notes and builds - as it is here, unsaved changes and all, and kept up to
// date as you type (see renderNow).
let rehearsal = null;

function rehearsalPackage() {
  const value = planPictures.size ? text().replace(DS.ASSET_REF, (ref, id) => planPictures.get(id) || ref) : text();
  return {
    item: { type: 'deck', title: deck.frontMatter.fields.title || origin.title || fileName(), src: origin.src || origin.item?.src || '' },
    source: value,
    from: 'From the deck editor · follows your edits',
    destination: destination(),
  };
}

function rehearse() {
  rehearsal = openQuickLook(rehearsalPackage(), { live: true });
}

// Every slide, fully built, one page each - for a handout or to post after class.
async function downloadPdf() {
  if (!rendered) return;
  try {
    const blob = await exportPdf(rendered, {
      title: deck.frontMatter.fields.title || origin.title || 'Deck',
      onProgress: (done, total) => setSaveState(`Making the PDF: slide ${done} of ${total}…`),
    });
    saveBlob(fileName().replace(/\.md$/, '.pdf'), blob);
    setSaveState('PDF downloaded');
  } catch (err) {
    warn(`That PDF did not work: ${err.message}`);
  }
  setTimeout(refreshSaveState, 2500);
}

// A deck's .zip, opened: its pictures and videos go into the library as deck
// media (when there is one), and the markdown is pointed at them there.
async function openZip(file) {
  const opened = await readDeckZip(file);
  let value = opened.markdown;
  const left = [...opened.missing];
  if (opened.media.length && media && info?.features.includes('library') && info?.user) {
    const deckLabel = DS.parseDeck(value).frontMatter.fields.title || opened.name.replace(/\.\w+$/, '');
    for (const [i, file] of opened.media.entries()) {
      setSaveState(`Adding ${file.name} to the library (${i + 1} of ${opened.media.length})…`);
      try {
        const item = await uploadDeckMedia(file.blob, { filename: file.name, course: '', deckName: deckLabel });
        value = replaceRef(value, file.ref, item.src);
      } catch {
        left.push(file.ref);
      }
    }
    warn(`The deck's pictures and videos went into the library with no course, so every signed-in account here can see them.${left.length ? ` Not found or not added: ${left.join(', ')}.` : ''}`);
  } else if (opened.media.length || left.length) {
    warn(`The pictures and videos in that .zip need Podium's own server to come in with it, so the slides still point at ${[...opened.media.map((m) => m.ref), ...left].join(', ')}.`);
  }
  return { value, name: opened.name };
}

function downloadDeck() {
  downloadText(fileName(), text(), 'text/markdown');
  if (origin.kind === 'new' || (origin.kind === 'file' && !origin.src)) {
    savedOk('Downloaded');
  }
}

function openLibraryDialog() {
  const dialog = $('#deck-library-dialog');
  const select = $('#deck-library-course');
  // Filing a deck under a course you do not own would make one you cannot
  // edit again - so only courses you own (or every course, for an admin).
  const owned = libraryCourses.filter((c) => c.role === 'owner');
  select.replaceChildren(
    ...owned.map((c) => el('option', { value: c.code }, `${c.code.toUpperCase()} — ${c.title}`)),
    el('option', { value: '' }, 'No course'),
  );
  const wanted = (origin.course || params.get('course') || '').toLowerCase();
  select.value = owned.some((c) => c.code === wanted) ? wanted : (owned[0]?.code || '');
  const hint = () => {
    $('#deck-library-course-hint').textContent = select.value
      ? `Everyone in ${select.value.toUpperCase()} can present it; its owners can edit it.`
      : 'With no course, every signed-in account on this server can see it, and only you (or an admin) can edit it.';
  };
  select.onchange = hint;
  hint();
  $('#deck-library-name').value = fileName();
  $('#deck-library-note').textContent = '';
  dialog.hidden = false;
}

function wireLibraryDialog() {
  $('#deck-library-cancel').addEventListener('click', () => { $('#deck-library-dialog').hidden = true; });
  $('#deck-library-go').addEventListener('click', async () => {
    const note = $('#deck-library-note');
    let filename = $('#deck-library-name').value.trim() || fileName();
    if (!/\.(md|markdown)$/i.test(filename)) filename += '.md';
    note.textContent = 'Saving…';
    try {
      const query = new URLSearchParams({
        filename, course: $('#deck-library-course').value, group: '',
        title: deck.frontMatter.fields.title || deck.slides[0]?.title || filename.replace(/\.\w+$/, ''),
      });
      const res = await fetch(`/api/library/upload?${query}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'text/markdown; charset=utf-8' }, body: text(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const item = { ...body.item, editable: true };
      const fromPlan = params.get('plan') && params.get('item') ? { planId: params.get('plan'), itemId: params.get('item') } : null;
      origin = { kind: 'library', id: item.id, item, version: item.version, editable: true, name: item.filename, title: item.title, course: item.course };
      const next = new URLSearchParams({ library: String(item.id) });
      if (fromPlan) { next.set('plan', fromPlan.planId); next.set('item', fromPlan.itemId); }
      history.replaceState(null, '', `?${next}`);
      $('#deck-library-dialog').hidden = true;
      savedOk('Saved to the library');
      warn('');
      // The lecture that opened this now points at the library deck.
      if (fromPlan) channel?.postMessage({ type: 'deck-linked', ...fromPlan, src: item.src, title: item.title, from: 'editor' });
    } catch (err) {
      note.textContent = `That did not save: ${err.message}`;
    }
  });
}

function wireSaveMenu() {
  const menu = $('#deck-save-menu');
  const toggle = $('#deck-save-more');
  const close = () => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
  toggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.hidden = !menu.hidden;
    toggle.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (ev) => { if (!menu.hidden && !ev.target.closest('.deck-menu-wrap')) close(); });
  $('#deck-save').addEventListener('click', () => save());
  $('#deck-save-library').addEventListener('click', () => { close(); openLibraryDialog(); });
  $('#deck-save-content').addEventListener('click', async () => {
    close();
    const name = (prompt('File name in content/decks:', fileName()) || '').trim();
    if (!name) return;
    const exists = await fetch(`/api/content/files/decks/${encodeURIComponent(name)}`, { credentials: 'same-origin' }).then((r) => r.ok).catch(() => false);
    if (exists && !confirm(`content/decks/${name} already exists. Replace it?`)) return;
    saveContent({ name, mtime: null });
  });
  $('#deck-download').addEventListener('click', () => { close(); downloadDeck(); });
  $('#deck-download-zip').addEventListener('click', () => { close(); downloadZip(); });
  $('#deck-download-pdf').addEventListener('click', () => { close(); downloadPdf(); });
  $('#deck-rehearse').addEventListener('click', () => { close(); rehearse(); });
  $('#deck-save-template').addEventListener('click', () => { close(); templates.open({ kind: 'deck' }); });
  $('#deck-versions').addEventListener('click', () => { close(); openVersions(); });
  $('#deck-new-template').addEventListener('click', () => { close(); templates.open({ kind: 'deck' }); });
  $('#deck-new').addEventListener('click', () => {
    close();
    if (dirty() && !confirm('Start a new deck? Your unsaved changes stay as a draft for this deck.')) return;
    location.href = 'deck.html';
  });
  $('#deck-open-file').addEventListener('click', () => { close(); $('#deck-file').click(); });
  $('#deck-file').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    if (dirty() && !confirm('Open another deck? Your unsaved changes stay as a draft for this one.')) return;
    keepDraftNow();
    let value;
    let name = file.name;
    try {
      ({ value, name } = /\.zip$/i.test(file.name) ? await openZip(file) : { value: await file.text(), name });
    } catch (err) {
      warn(`Could not open ${file.name}: ${err.message}`);
      return;
    }
    origin = { kind: 'file', name, title: name };
    history.replaceState(null, '', location.pathname);
    setDocument(value);
    savedText = value;
    describeOrigin();
    refreshSaveState();
    renderNow();
  });
}

// The planner tab may say a deck it shows changed (or ask whether one is open).
channel?.addEventListener('message', (ev) => {
  if (ev.data?.type === 'editor-ping' && ev.data.from === 'planner') {
    channel.postMessage({ type: 'editor-here', nonce: ev.data.nonce, origin: { kind: origin.kind, id: origin.id, planId: origin.planId, itemId: origin.itemId }, from: 'editor' });
  }
});

window.addEventListener('beforeunload', (ev) => {
  if (!dirty()) return;
  keepDraftNow();
  ev.preventDefault();
  ev.returnValue = '';
});

wireToolbar();
wireDiagrams();
wireSlidePanel();
wireDeckSettings();
wirePageDrops();
wireVersions();
wireLibraryDialog();
wireSaveMenu();
start();
