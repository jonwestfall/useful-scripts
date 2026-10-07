// Markdown documents (Issue #240): a plain .md shown as what it is - one
// rendered page to read - rather than cut into slides at every `---`.
//
// The page is laid out at one fixed width, DOC_WIDTH, and scaled to whatever
// shows it, the way a slide is. That is what makes a position in a document
// mean the same thing everywhere: `at`, the y of the top of what the room sees,
// is in the page's own pixels, so the display, the controller's mirror and a
// Quick Look tab all agree on it whatever their window.
//
// The markdown engine is the markdown-it, KaTeX and HTML filter already inside
// the Marp bundle (see vendor-build/marp-entry.js), and code is highlighted by
// a Marp instance's own highlight.js - no second copy of any of them.
//
// Presenter notes are HTML comments, as in a deck. Each is left in the page as
// an empty marker, so where it falls can be measured once the page is laid
// out; the comment's text never reaches the page.

import { HTML_ALLOWLIST, BLANK, MARP_URL } from './deck.js';
import { ASSET_REF, MERMAID_THEMES } from './deck-source.js';
import { drawDiagrams, DIAGRAM_CSS } from './deck-mermaid.js';
import { DOC_WIDTH, DOC_VIEW, DOC_STEP, clampDocAt, docMaxAt } from './protocol.js';

// The page's width (about 70 characters of projector type), one screenful of
// it, and how much of a screen Next moves - shared with protocol.js, which
// clamps every position the room is sent to.
export { DOC_WIDTH, DOC_VIEW, DOC_STEP };
/** Room left above a heading jumped to, so it does not sit on the very edge. */
const HEADING_MARGIN = 24;

let enginePromise = null;
const cache = new Map();

// --- markdown-it plugins -------------------------------------------------------

/** `$…$` and `$$…$$` inline, as Marp and most markdown editors take them. */
function mathInline(state, silent) {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24) return false;
  const display = src.charCodeAt(start + 1) === 0x24;
  const open = display ? 2 : 1;
  const first = src.charCodeAt(start + open);
  if (Number.isNaN(first) || (!display && /\s/.test(src[start + open]))) return false;
  let end = start + open;
  for (;;) {
    end = src.indexOf(display ? '$$' : '$', end);
    if (end === -1) return false;
    if (src.charCodeAt(end - 1) === 0x5c) { end += 1; continue; }   // \$
    break;
  }
  const content = src.slice(start + open, end);
  if (!content.trim()) return false;
  // "$5 and $6" is money, not maths: no space just inside, no digit just after.
  if (!display && (/\s$/.test(content) || /[0-9]/.test(src[end + 1] || ''))) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = content;
    token.markup = display ? '$$' : '$';
    token.meta = { display };
  }
  state.pos = end + open;
  return true;
}

/** A `$$` block, on one line or several. */
function mathBlock(state, startLine, endLine, silent) {
  const begin = state.bMarks[startLine] + state.tShift[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (state.src.slice(begin, begin + 2) !== '$$') return false;
  const firstLine = state.src.slice(begin + 2, state.eMarks[startLine]);
  let line = startLine;
  let content;
  if (firstLine.trim().endsWith('$$')) {
    content = firstLine.trim().slice(0, -2);
  } else {
    const lines = [firstLine];
    let closed = false;
    for (line = startLine + 1; line < endLine; line += 1) {
      const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      if (text.trim().endsWith('$$')) { lines.push(text.trim().slice(0, -2)); closed = true; break; }
      lines.push(text);
    }
    if (!closed) return false;
    content = lines.join('\n');
  }
  if (silent) return true;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = content;
  token.markup = '$$';
  token.map = [startLine, line + 1];
  state.line = line + 1;
  return true;
}

function mathPlugin(md, katex) {
  md.inline.ruler.before('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  const tex = (content, displayMode) => katex.renderToString(content, { displayMode, throwOnError: false });
  md.renderer.rules.math_inline = (tokens, i) => tex(tokens[i].content, !!tokens[i].meta?.display);
  md.renderer.rules.math_block = (tokens, i) => `<div class="math-block">${tex(tokens[i].content, true)}</div>\n`;
}

/** GitHub's `- [ ]` and `- [x]` list items, as boxes nobody can tick. */
function taskListPlugin(md) {
  md.core.ruler.after('inline', 'podium_task_lists', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i += 1) {
      const inline = tokens[i];
      if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
      const m = /^\[([ xX])\][ \t]/.exec(inline.content);
      const first = inline.children?.[0];
      if (!m || first?.type !== 'text' || !first.content.startsWith(m[0])) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token('task_box', '', 0);
      box.meta = { checked: m[1] !== ' ' };
      inline.children.unshift(box);
      tokens[i - 2].attrJoin('class', 'task-list-item');
    }
  });
  md.renderer.rules.task_box = (tokens, i) =>
    `<input class="task-box" type="checkbox" disabled${tokens[i].meta.checked ? ' checked' : ''}> `;
}

/** Each heading an id to jump to, and the outline the controller lists. */
function headingPlugin(md) {
  md.core.ruler.push('podium_headings', (state) => {
    const outline = [];
    state.tokens.forEach((token, i) => {
      if (token.type !== 'heading_open') return;
      const inline = state.tokens[i + 1];
      const text = (inline?.children || []).filter((c) => c.type === 'text' || c.type === 'code_inline' || c.type === 'math_inline')
        .map((c) => c.content).join('').replace(/\s+/g, ' ').trim();
      const anchor = `doc-h-${outline.length}`;
      token.attrSet('id', anchor);
      outline.push({ level: Number(token.tag.slice(1)), text: text || '(untitled)', anchor });
    });
    state.env.outline = outline;
  });
}

/**
 * Raw HTML: comments become presenter notes, everything else is held to the
 * same allowlist a deck's raw HTML is - layout, never a script.
 */
function htmlPlugin(md, filter) {
  const COMMENT = /(<!--[\s\S]*?-->)/;
  const html = (tag) => (tokens, i, options, env) => tokens[i].content.split(COMMENT).map((part) => {
    const note = /^<!--([\s\S]*?)-->$/.exec(part);
    if (!note) return filter.process(part);
    const text = note[1].trim();
    if (!text) return '';
    env.notes ??= [];
    env.notes.push(text);
    return `<${tag} class="podium-note" data-note="${env.notes.length - 1}"></${tag}>`;
  }).join('');
  md.renderer.rules.html_block = html('div');
  md.renderer.rules.html_inline = html('span');
}

// --- the engine ------------------------------------------------------------------

async function loadEngine() {
  const { Marp, MarkdownIt, katex, FilterXSS, katexCss } = await import(MARP_URL);
  const hljs = new Marp().highlightjs;
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    highlight(code, lang) {
      // A diagram is left as a ```mermaid block for drawDiagrams to find.
      if (!lang || lang === 'mermaid' || !hljs.getLanguage(lang)) return '';
      try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch { return ''; }
    },
  });
  const filter = new FilterXSS({ whiteList: HTML_ALLOWLIST, stripIgnoreTagBody: ['script', 'style'] });
  md.use(mathPlugin, katex).use(taskListPlugin).use(headingPlugin).use(htmlPlugin, filter);
  // Links out of a document open beside it, never in place of the projector.
  const linkOpen = md.renderer.rules.link_open || ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
  md.renderer.rules.link_open = (tokens, i, options, env, self) => {
    if (/^https?:/i.test(tokens[i].attrGet('href') || '')) {
      tokens[i].attrSet('target', '_blank');
      tokens[i].attrSet('rel', 'noopener noreferrer');
    }
    return linkOpen(tokens, i, options, env, self);
  };
  // KaTeX's fonts from the same place a deck's come from (see vendor-build/README.md).
  const fonts = `https://cdn.jsdelivr.net/npm/katex@${katex.version}/dist/fonts/`;
  return { md, katexCss: katexCss.replace(/url\(fonts\//g, `url(${fonts}`) };
}

function engine() {
  enginePromise ??= loadEngine().catch((err) => {
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

// --- front matter ------------------------------------------------------------------

const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A document's front matter as plain `key: value` pairs, and the text after it. */
export function splitFrontMatter(source) {
  const text = String(source || '');
  const m = FRONT_MATTER.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Light or dark (Issue #240: those two, no themes): the item's choice, else the front matter's. */
export function docLook(source, chosen = '') {
  if (chosen === 'dark' || chosen === 'light') return chosen;
  return /^dark$/i.test(splitFrontMatter(source).meta.theme || '') ? 'dark' : 'light';
}

/** A document's title: its front matter's, else its first heading, else the fallback. */
export function docTitle(source, fallback = 'Document') {
  const { meta, body } = splitFrontMatter(source);
  if (meta.title) return meta.title.slice(0, 120);
  const heading = /^#{1,3}[ \t]+(.+?)[ \t#]*$/m.exec(body);
  return heading ? heading[1].replace(/[*_`]/g, '').trim().slice(0, 120) : fallback;
}

// --- the look --------------------------------------------------------------------

export const DOC_CSS = `
  .podium-doc {
    --doc-bg: #ffffff; --doc-ink: #1d232b; --doc-dim: #59636e; --doc-line: #d6dbe1;
    --doc-accent: #0b5cad; --doc-code-bg: #f3f5f8; --doc-mark: #fff2a8;
    box-sizing: border-box; width: ${DOC_WIDTH}px; margin: 0; padding: 56px 80px 96px;
    background: var(--doc-bg); color: var(--doc-ink);
    font: 32px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    overflow-wrap: break-word;
  }
  .podium-doc.is-dark {
    --doc-bg: #14181d; --doc-ink: #e8ecf1; --doc-dim: #a3adb8; --doc-line: #36404b;
    --doc-accent: #7ab7ff; --doc-code-bg: #1f252c; --doc-mark: #6b5b00;
  }
  .podium-doc *, .podium-doc *::before, .podium-doc *::after { box-sizing: border-box; }
  .podium-doc > :first-child { margin-top: 0; }
  .podium-doc h1, .podium-doc h2, .podium-doc h3, .podium-doc h4, .podium-doc h5, .podium-doc h6 {
    line-height: 1.2; margin: 1.3em 0 .5em; font-weight: 700;
  }
  .podium-doc h1 { font-size: 2em; }
  .podium-doc h2 { font-size: 1.55em; padding-bottom: .2em; border-bottom: 2px solid var(--doc-line); }
  .podium-doc h3 { font-size: 1.25em; }
  .podium-doc h4, .podium-doc h5, .podium-doc h6 { font-size: 1em; }
  .podium-doc p, .podium-doc ul, .podium-doc ol, .podium-doc blockquote, .podium-doc pre, .podium-doc table, .podium-doc .math-block { margin: 0 0 .8em; }
  .podium-doc ul, .podium-doc ol { padding-left: 1.4em; }
  .podium-doc li + li { margin-top: .2em; }
  .podium-doc li.task-list-item { list-style: none; margin-left: -1.2em; }
  .podium-doc .task-box { width: .8em; height: .8em; margin: 0 .3em 0 0; vertical-align: -.05em; accent-color: var(--doc-accent); }
  .podium-doc a { color: var(--doc-accent); }
  .podium-doc strong { font-weight: 700; }
  .podium-doc mark { background: var(--doc-mark); color: inherit; }
  .podium-doc blockquote { padding: .1em 0 .1em .9em; border-left: 6px solid var(--doc-line); color: var(--doc-dim); }
  .podium-doc hr { border: 0; border-top: 2px solid var(--doc-line); margin: 1.4em 0; }
  .podium-doc code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .85em; }
  .podium-doc :not(pre) > code { background: var(--doc-code-bg); padding: .08em .3em; border-radius: 5px; }
  .podium-doc pre { background: var(--doc-code-bg); padding: .6em .8em; border-radius: 8px; overflow: hidden; white-space: pre-wrap; line-height: 1.4; }
  .podium-doc pre code { font-size: .78em; }
  .podium-doc table { border-collapse: collapse; width: auto; max-width: 100%; }
  .podium-doc th, .podium-doc td { border: 2px solid var(--doc-line); padding: .25em .6em; text-align: left; vertical-align: top; }
  .podium-doc th { background: var(--doc-code-bg); }
  .podium-doc img { max-width: 100%; height: auto; }
  .podium-doc img.podium-diagram { display: block; margin: 0 auto .8em; }
  .podium-doc .math-block { overflow: hidden; }
  .podium-doc .podium-note { display: block; height: 0; margin: 0; }
  .podium-doc span.podium-note { display: inline; }
  /* highlight.js, in the page's own two looks */
  .podium-doc .hljs-comment, .podium-doc .hljs-quote { color: #6a737d; font-style: italic; }
  .podium-doc .hljs-keyword, .podium-doc .hljs-selector-tag, .podium-doc .hljs-built_in, .podium-doc .hljs-type { color: #b0005a; }
  .podium-doc .hljs-string, .podium-doc .hljs-attr, .podium-doc .hljs-template-string, .podium-doc .hljs-regexp { color: #0a6b2f; }
  .podium-doc .hljs-number, .podium-doc .hljs-literal, .podium-doc .hljs-symbol { color: #8a4b00; }
  .podium-doc .hljs-title, .podium-doc .hljs-section, .podium-doc .hljs-function { color: #1d4fb8; }
  .podium-doc.is-dark .hljs-comment, .podium-doc.is-dark .hljs-quote { color: #8b96a3; }
  .podium-doc.is-dark .hljs-keyword, .podium-doc.is-dark .hljs-selector-tag, .podium-doc.is-dark .hljs-built_in, .podium-doc.is-dark .hljs-type { color: #ff8fc4; }
  .podium-doc.is-dark .hljs-string, .podium-doc.is-dark .hljs-attr, .podium-doc.is-dark .hljs-template-string, .podium-doc.is-dark .hljs-regexp { color: #8be0a4; }
  .podium-doc.is-dark .hljs-number, .podium-doc.is-dark .hljs-literal, .podium-doc.is-dark .hljs-symbol { color: #ffc27a; }
  .podium-doc.is-dark .hljs-title, .podium-doc.is-dark .hljs-section, .podium-doc.is-dark .hljs-function { color: #9cc4ff; }
`;

// --- rendering ---------------------------------------------------------------------

/** The same content id a deck's is: the same file is only ever shipped once. */
export { deckId as docId } from './deck.js';

/**
 * Render a document. `look` is 'light' or 'dark' (left out, the front
 * matter's). Cached by content and look, like a deck's render.
 *
 * Returns {id, html, css, look, title, outline: [{level, text, anchor}],
 * notes: [text], diagrams}. Where each heading and note falls is only known
 * once the page is laid out - see measureDoc().
 */
export async function renderDoc(source, id, { look = '' } = {}) {
  const text = String(source || '');
  const shade = docLook(text, look);
  const key = `${id || text.length + ':' + text.slice(0, 64)}|${shade}`;
  if (id && cache.has(key)) return cache.get(key);

  const { md, katexCss } = await engine();
  const { meta, body } = splitFrontMatter(text);
  const env = {};
  const inner = md.render(body.includes('asset:') ? body.replace(ASSET_REF, BLANK) : body, env);
  const wanted = MERMAID_THEMES.includes(meta.mermaidTheme) ? meta.mermaidTheme : '';
  const pageHtml = `<article class="podium-doc${shade === 'dark' ? ' is-dark' : ''}"${wanted ? ` data-mermaid-theme="${wanted}"` : ''}>${inner}</article>`;
  const css = `${katexCss}\n${DOC_CSS}\n${DIAGRAM_CSS}`;

  let html = pageHtml;
  let diagrams = [];
  if (typeof DOMParser !== 'undefined' && /<code class="language-mermaid"/.test(inner)) {
    // ```mermaid blocks drawn as diagrams, as in a deck - the page is the one
    // "slide" they are drawn against, so they take its colours.
    const doc = new DOMParser().parseFromString(`<div>${pageHtml}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    diagrams = await drawDiagrams(root, css, (r) => Array.from(r.querySelectorAll('article.podium-doc')));
    html = root.innerHTML;
  }

  const result = {
    id: id || null,
    html,
    css,
    look: shade,
    title: docTitle(text),
    outline: env.outline || [],
    notes: env.notes || [],
    diagrams,
  };
  if (id && !diagrams.some((d) => d.error?.retry)) cache.set(key, result);
  return result;
}

/** Drop a document's renders from the cache (an edited one, say). */
export function forgetDoc(id) {
  for (const key of cache.keys()) if (key.startsWith(`${id}|`)) cache.delete(key);
}

/**
 * Where everything is, once a rendered page is in the DOM: its height, each
 * heading's y and each note's, all in the page's own pixels whatever it is
 * scaled to on this screen.
 */
export function measureDoc(page, rendered) {
  const box = page.getBoundingClientRect();
  const scale = box.width ? box.width / DOC_WIDTH : 1;
  const yOf = (node) => Math.max(0, Math.round((node.getBoundingClientRect().top - box.top) / scale));
  const headings = (rendered?.outline || []).map((h) => {
    const node = page.querySelector(`#${h.anchor}`);
    return { ...h, y: node ? yOf(node) : 0 };
  });
  const notes = Array.from(page.querySelectorAll('.podium-note')).map((node) => ({
    text: rendered?.notes?.[Number(node.dataset.note)] || '',
    y: yOf(node),
  })).filter((n) => n.text);
  return { height: Math.max(DOC_VIEW, Math.round(box.height / scale)), headings, notes };
}

export { clampDocAt, docMaxAt };

/** Where jumping to a heading lands: just above it. */
export function headingAt(heading, height) {
  return clampDocAt((heading?.y || 0) - HEADING_MARGIN, height);
}

/**
 * The presenter notes for what is on screen (Issue #240): every note within
 * it, and the nearest one above it - so a note written at the top of a
 * section is still there while the rest of that section is up.
 */
export function notesInView(notes, at, view = DOC_VIEW) {
  const top = Number(at) || 0;
  const bottom = top + view;
  const within = (notes || []).filter((n) => n.y >= top && n.y < bottom);
  const above = (notes || []).filter((n) => n.y < top).pop();
  return above ? [above, ...within] : within;
}

/** The heading the top of the screen is under, for "you are here". */
export function headingAtTop(headings, at) {
  return (headings || []).filter((h) => h.y <= (Number(at) || 0) + HEADING_MARGIN * 2).pop() || null;
}
