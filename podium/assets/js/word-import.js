// Word and RTF files as documents (Issue #258).
//
// A .docx or .rtf picked in the planner, the controller or My Files becomes a
// markdown document - the same `document` Podium already shows, scrolls,
// outlines and inks (Issue #240) - converted once, here in the browser, so it
// works with no server and offline. The person chose this over a PDF (which
// keeps Word's exact layout; that is LibreOffice's job on a server): what
// carries over is the writing, not the page.
//
//   .docx  mammoth (vendored, loaded only when needed) to HTML, then to markdown
//   .rtf   a small parser of our own to HTML, then the same way to markdown
//   .doc   the old binary format: a server with LibreOffice turns it into a
//          .docx first (see POST /api/convert/docx), then as a .docx
//
// What comes across: headings, paragraphs, bold/italic/underline/strike,
// lists (nested), tables (merged cells flattened), links, pictures, footnotes
// (numbered, gathered under "Notes" at the end) and Word's comments, which
// become presenter notes where they were anchored - the controller shows
// them, the room never does. Page layout, headers and footers, text boxes,
// fonts and colours do not; the report says so.

export const WORD_EXTS = ['.docx', '.doc', '.rtf'];

/** 'docx' | 'doc' | 'rtf' | null, from a file name. */
export function wordKind(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(String(name || ''))?.[1]?.toLowerCase();
  return ext === 'docx' || ext === 'doc' || ext === 'rtf' ? ext : null;
}

const NOT_CARRIED = 'Page layout, headers and footers, text boxes, fonts and colours are not carried over.';

/**
 * Convert a Word (.docx) or RTF file to a markdown document.
 *
 * @param {Blob|ArrayBuffer} input
 * @param {object} opts
 * @param {'docx'|'rtf'} opts.kind
 * @param {string} [opts.name] - the file's name, for the title when it has no heading
 * @param {(blob: Blob, name: string) => Promise<string>} opts.placePicture - stores a
 *   picture (in the library, or in the plan) and resolves to the address to use
 * @returns {Promise<{markdown: string, title: string, report: object}>}
 */
export async function wordToMarkdown(input, { kind, name = '', placePicture }) {
  const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  const report = { pictures: 0, tables: 0, comments: 0, footnotes: 0, warnings: [] };
  let pictureCount = 0;
  const place = async (blob, ext) => {
    pictureCount += 1;
    report.pictures += 1;
    const base = String(name).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 40) || 'document';
    return placePicture(blob, `${base}-picture-${pictureCount}.${ext}`);
  };

  let html;
  if (kind === 'docx') html = await docxToHtml(buffer, place, report);
  else if (kind === 'rtf') html = await rtfToHtml(new Uint8Array(buffer), place, report);
  else throw new Error(`a .${kind} file cannot be converted here`);

  const markdown = htmlToMarkdown(html, report);
  const fallback = String(name).replace(/\.[^.]+$/, '') || 'Untitled document';
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || fallback;
  report.summary = summarize(report);
  return { markdown, title, report };
}

function summarize(report) {
  const kept = [
    report.pictures && `${report.pictures} picture${report.pictures === 1 ? '' : 's'}`,
    report.tables && `${report.tables} table${report.tables === 1 ? '' : 's'}`,
    report.footnotes && `${report.footnotes} footnote${report.footnotes === 1 ? '' : 's'}`,
    report.comments && `${report.comments} comment${report.comments === 1 ? '' : 's'} (now presenter notes)`,
  ].filter(Boolean);
  const skipped = report.skippedPictures
    ? ` ${report.skippedPictures} picture${report.skippedPictures === 1 ? ' was' : 's were'} in an old Windows format (WMF/EMF) and left out.` : '';
  return `${kept.length ? `Kept ${kept.join(', ')}. ` : ''}${NOT_CARRIED}${skipped}`;
}

// --- .docx -----------------------------------------------------------------------

async function docxToHtml(arrayBuffer, place, report) {
  const { default: mammoth } = await import('../vendor/mammoth.esm.js');
  const result = await mammoth.convertToHtml({ arrayBuffer }, {
    // Word's own title styles are headings too; comments are wanted (as notes).
    styleMap: [
      "p[style-name='Title'] => h1:fresh",
      "p[style-name='Subtitle'] => h2:fresh",
      'comment-reference => sup',
    ],
    convertImage: mammoth.images.imgElement(async (image) => {
      const base64 = await image.read('base64');
      const type = image.contentType || 'image/png';
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const ext = (type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
      return { src: await place(new Blob([bytes], { type }), ext) };
    }),
  });
  for (const m of result.messages || []) {
    if (m.type === 'warning' && report.warnings.length < 5) report.warnings.push(m.message);
  }
  return result.value;
}

// --- HTML (from either) to markdown ------------------------------------------------

/**
 * Markdown from the simple HTML mammoth (or rtfToHtml) writes. Footnotes and
 * comments are found by the ids mammoth gives them; footnotes are gathered at
 * the end under "Notes", comments become `<!-- … -->` presenter notes where
 * they were anchored.
 */
export function htmlToMarkdown(html, report = { tables: 0, comments: 0, footnotes: 0 }) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const body = doc.body;

  // Footnotes and endnotes: mammoth's <ol><li id="footnote-1">…</li></ol> at the end.
  const footnotes = new Map();
  for (const li of body.querySelectorAll('li[id^="footnote-"], li[id^="endnote-"]')) {
    li.querySelectorAll('a[href^="#footnote-ref-"], a[href^="#endnote-ref-"]').forEach((a) => a.remove());
    footnotes.set(li.id, inlineText(li));
    const list = li.parentElement;
    li.remove();
    if (list && !list.children.length) list.remove();
  }
  // Comments: <dl><dt id="comment-0">…</dt><dd>text</dd></dl> at the end.
  const comments = new Map();
  for (const dt of body.querySelectorAll('dt[id^="comment-"]')) {
    const dd = dt.nextElementSibling;
    if (dd?.tagName === 'DD') {
      dd.querySelectorAll('a[href^="#comment-ref-"]').forEach((a) => a.remove());
      comments.set(dt.id, dd.textContent.replace(/\s+/g, ' ').trim());
      dd.remove();
    }
    const list = dt.parentElement;
    dt.remove();
    if (list && !list.children.length) list.remove();
  }

  const noteOrder = [];
  const ctx = { footnotes, comments, noteOrder, report };
  const blocks = [];
  for (const node of body.childNodes) {
    const out = block(node, ctx, '');
    if (out) blocks.push(out);
  }
  let markdown = blocks.join('\n\n');
  if (noteOrder.length) {
    markdown += `\n\n---\n\n**Notes**\n\n${noteOrder.map((text, i) => `${i + 1}. ${text || ' '}`).join('\n')}`;
  }
  report.footnotes = noteOrder.length;
  return `${markdown.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function block(node, ctx, indent) {
  if (node.nodeType === 3) {
    const text = escapeText(node.textContent).replace(/\s+/g, ' ').trim();
    return text ? indent + text : '';
  }
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    const text = inline(node, ctx).trim();
    return text ? `${'#'.repeat(Number(tag[1]))} ${text}` : '';
  }
  if (tag === 'p') {
    const text = inline(node, ctx).trim();
    return text ? indent + text.replace(/\n/g, `\n${indent}`) : '';
  }
  if (tag === 'ul' || tag === 'ol') return list(node, ctx, indent);
  if (tag === 'table') return table(node, ctx);
  if (tag === 'blockquote') {
    const inner = [...node.childNodes].map((n) => block(n, ctx, '')).filter(Boolean).join('\n\n');
    return inner.split('\n').map((line) => `> ${line}`).join('\n');
  }
  if (tag === 'hr') return '---';
  if (tag === 'img') return inline(node, ctx);
  // Anything else (a div, a span at the top level): its children.
  return [...node.childNodes].map((n) => block(n, ctx, indent)).filter(Boolean).join('\n\n');
}

function list(node, ctx, indent) {
  const ordered = node.tagName === 'OL';
  const lines = [];
  let n = Number(node.getAttribute('start')) || 1;
  for (const li of node.children) {
    if (li.tagName !== 'LI') continue;
    const marker = ordered ? `${n++}. ` : '- ';
    const pad = indent + ' '.repeat(marker.length);
    const own = [];
    const nested = [];
    for (const child of li.childNodes) {
      if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) nested.push(list(child, ctx, pad));
      else if (child.nodeType === 1 && child.tagName === 'P') own.push(inline(child, ctx).trim());
      else own.push(inline({ childNodes: [child] }, ctx).trim());
    }
    lines.push(`${indent}${marker}${own.filter(Boolean).join(' ')}`);
    lines.push(...nested.filter(Boolean));
  }
  return lines.join('\n');
}

function table(node, ctx) {
  ctx.report.tables += 1;
  const rows = [...node.querySelectorAll('tr')].map((tr) => {
    const cells = [];
    for (const cell of tr.children) {
      const text = [...cell.childNodes].map((c) => (c.nodeType === 1 && /^(P|UL|OL)$/.test(c.tagName)
        ? inline(c, ctx) : inline({ childNodes: [c] }, ctx))).map((t) => t.trim()).filter(Boolean)
        .join('<br>').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
      cells.push(text);
      // A merged cell is flattened: what it spanned is left empty.
      for (let i = 1; i < (Number(cell.getAttribute('colspan')) || 1); i++) cells.push('');
    }
    return cells;
  }).filter((r) => r.length);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const line = (r) => `| ${pad(r).map((c) => c || ' ').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

function inline(node, ctx) {
  let out = '';
  for (const child of node.childNodes || []) {
    if (child.nodeType === 3) { out += escapeText(child.textContent.replace(/\s+/g, ' ')); continue; }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === 'sup') {
      // Each finds its footnote or comment once: asking twice would lose it.
      const mark = footnoteRef(child, ctx) || commentRef(child, ctx);
      if (mark) { out += mark; continue; }
    }
    const inner = () => inline(child, ctx);
    if (tag === 'strong' || tag === 'b') out += wrap(inner(), '**');
    else if (tag === 'em' || tag === 'i') out += wrap(inner(), '*');
    else if (tag === 's' || tag === 'del' || tag === 'strike') out += wrap(inner(), '~~');
    else if (tag === 'u') out += `<u>${inner()}</u>`;
    else if (tag === 'sup' || tag === 'sub') out += `<${tag}>${inner()}</${tag}>`;
    else if (tag === 'br') out += '  \n';
    else if (tag === 'img') {
      const src = child.getAttribute('src') || '';
      out += src ? `![${escapeText(child.getAttribute('alt') || '')}](${src.replace(/ /g, '%20')})` : '';
    } else if (tag === 'a') {
      const href = child.getAttribute('href') || '';
      const text = inner();
      // Word's own bookmarks and anchors lead nowhere outside the file.
      out += href && !href.startsWith('#') ? `[${text || href}](${href.replace(/ /g, '%20').replace(/\)/g, '%29')})` : text;
    } else out += inner();
  }
  return out;
}

function inlineText(node) {
  return inline(node, { footnotes: new Map(), comments: new Map(), noteOrder: [], report: {} }).replace(/\s+/g, ' ').trim();
}

// <sup><a href="#footnote-1" …>[1]</a></sup> -> a numbered mark, its text kept for the end.
function footnoteRef(sup, ctx) {
  const a = sup.querySelector('a[href^="#footnote-"], a[href^="#endnote-"]');
  if (!a) return '';
  const id = a.getAttribute('href').slice(1);
  if (!ctx.footnotes.has(id)) return '';
  ctx.noteOrder.push(ctx.footnotes.get(id));
  ctx.footnotes.delete(id);
  return `<sup>${ctx.noteOrder.length}</sup>`;
}

// <sup><a href="#comment-0" …>[AB1]</a></sup> -> a presenter note right there.
function commentRef(sup, ctx) {
  const a = sup.querySelector('a[href^="#comment-"]');
  if (!a) return '';
  const text = ctx.comments.get(a.getAttribute('href').slice(1));
  if (text == null) return '';
  ctx.report.comments += 1;
  return text ? `<!-- ${text.replace(/--/g, '—')} -->` : '';
}

function wrap(text, mark) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : text;
}

// Text that would otherwise be read as markdown: emphasis, links, code, HTML,
// and a heading/list/quote marker at the start of a line.
function escapeText(text) {
  return String(text)
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .replace(/^(\s*)([#+-]|\d+\.)(\s)/, '$1\\$2$3');
}

// --- .rtf ------------------------------------------------------------------------

// Groups whose contents are not text to show.
const SKIP = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
  'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'themedata',
  'colorschememapping', 'datastore', 'latentstyles', 'xmlnstbl', 'mmathPr', 'pgdsctbl', 'listtext', 'pntext',
  'fldinst', 'atnid', 'atnauthor', 'atntime', 'atnref', 'atndate', 'bkmkstart', 'bkmkend', 'xe', 'tc', 'object',
  'shp', 'shpinst', 'nonshppict', 'filetbl', 'revtbl', 'protusertbl', 'userprops', 'docvar', 'wgrffmtfilter',
]);

const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const fromCp1252 = (b) => (b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80] : String.fromCharCode(b));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * HTML from RTF: paragraphs, headings (from the stylesheet's "heading N"
 * names or \outlinelevel), bold/italic/underline/strike, super/subscript,
 * lists, tables, links, PNG/JPEG pictures, footnotes and comments - written
 * the way mammoth writes them, so htmlToMarkdown treats both alike.
 */
export async function rtfToHtml(bytes, place, report = { warnings: [] }) {
  const src = typeof bytes === 'string' ? bytes : Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  if (!src.startsWith('{\\rtf')) throw new Error('that is not an RTF file');

  const styles = new Map();          // \sN -> heading level
  const pictures = [];               // filled in after parsing (placing is async)
  const footnotes = [];
  const comments = [];
  let html = '';
  let para = '';
  let paraProps = { heading: 0, list: 0, listOrdered: false, listLevel: 0, inTable: false };
  let row = null;
  let cell = '';
  let rows = null;
  let openList = [];                 // stack of 'ul'|'ol' currently open
  let openListId = null;             // the \ls of the list now open

  const stack = [];
  let state = { bold: false, italic: false, underline: false, strike: false, sup: false, sub: false, skip: false, dest: '', uc: 1 };
  let pendingSkip = 0;               // characters to drop after a \u

  let text = '';                     // runs within the current paragraph, already HTML
  const flushRun = (run) => {
    if (!run) return;
    let out = esc(run);
    if (state.sup) out = `<sup>${out}</sup>`;
    if (state.sub) out = `<sub>${out}</sub>`;
    if (state.strike) out = `<s>${out}</s>`;
    if (state.underline) out = `<u>${out}</u>`;
    if (state.italic) out = `<em>${out}</em>`;
    if (state.bold) out = `<strong>${out}</strong>`;
    text += out;
  };
  let run = '';
  const emitChar = (ch) => {
    if (pendingSkip > 0) { pendingSkip -= 1; return; }
    if (state.skip) return;
    if (state.dest === 'footnote' || state.dest === 'annotation' || state.dest === 'pict' || state.dest === 'fldrslt-href') {
      state.capture.text += ch;
      return;
    }
    run += ch;
  };
  const closeRun = () => { flushRun(run); run = ''; };

  const closeLists = (toLevel) => {
    while (openList.length > toLevel) html += `</li></${openList.pop()}>`;
  };
  const endParagraph = () => {
    closeRun();
    const content = (para + text).trim();
    para = '';
    text = '';
    if (paraProps.inTable) { cell += (cell && content ? '<br>' : '') + content; return; }
    if (rows) { html += tableHtml(rows); rows = null; }
    if (paraProps.list) {
      const level = paraProps.listLevel + 1;
      const tag = paraProps.listOrdered ? 'ol' : 'ul';
      // Another list (or a bulleted one turning numbered) starts afresh.
      if (openList.length && (paraProps.list !== openListId || openList[0] !== tag) && level === 1) closeLists(0);
      openListId = paraProps.list;
      if (openList.length >= level) { closeLists(level); html += '</li><li>'; } else {
        while (openList.length < level) { html += `<${tag}><li>`; openList.push(tag); }
      }
      html += content;
      return;
    }
    closeLists(0);
    if (!content) return;
    html += paraProps.heading ? `<h${paraProps.heading}>${content}</h${paraProps.heading}>` : `<p>${content}</p>`;
  };
  const tableHtml = (r) => `<table>${r.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;

  // A link's address, from HYPERLINK "…" in \fldinst, for the \fldrslt after it.
  let pendingHref = '';
  // Whether the list item about to start is numbered: Word writes its "1." in
  // a \listtext group BEFORE the \pard that starts the paragraph.
  let listTextOrdered = null;

  let i = 0;
  // Stylesheet parsing: the group being read and its \sN.
  let styleNumber = null;
  let styleName = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '{') {
      if (state.dest !== 'stylesheet-entry') closeRun();
      stack.push(state);
      state = { ...state };
      i += 1;
      // A destination marked \* we do not know is skipped whole.
      if (src.startsWith('\\*', i)) {
        const m = /^\\\*\\([a-z]+)/.exec(src.slice(i, i + 40));
        // Kept: a comment, a link's address, and a picture (Word wraps the
        // picture it wants shown in \*\shppict, beside a \nonshppict fallback).
        if (m && !['annotation', 'fldinst', 'shppict'].includes(m[1])) state.skip = true;
      }
      continue;
    }
    if (c === '}') {
      if (state.dest === 'stylesheet-entry' && styleNumber !== null) {
        const m = /heading\s*(\d)/i.exec(styleName) || (/^title$/i.test(styleName.trim().replace(/;$/, '')) ? [0, '1'] : null);
        if (m) styles.set(styleNumber, Math.min(6, Number(m[1])));
        styleNumber = null;
        styleName = '';
      }
      closeRun();
      const ended = state;
      state = stack.pop() || state;
      // A footnote or comment group ends: put its mark in the text.
      if (ended.dest === 'footnote' && state.dest !== 'footnote') {
        footnotes.push(ended.capture.text.trim());
        text += `<sup><a href="#footnote-${footnotes.length}">[${footnotes.length}]</a></sup>`;
      } else if (ended.dest === 'annotation' && state.dest !== 'annotation') {
        comments.push(ended.capture.text.trim());
        text += `<sup><a href="#comment-${comments.length - 1}">[c]</a></sup>`;
      } else if (ended.dest === 'pict' && state.dest !== 'pict') {
        const hex = ended.capture.text.replace(/[^0-9a-f]/gi, '');
        if (ended.capture.format && hex.length > 16) {
          pictures.push({ hex, format: ended.capture.format, mark: `\u0000pic${pictures.length}\u0000` });
          text += pictures[pictures.length - 1].mark;
        } else if (hex.length > 16) {
          report.skippedPictures = (report.skippedPictures || 0) + 1;
        }
      } else if (ended.dest === 'fldrslt-href' && state.dest !== 'fldrslt-href') {
        text += `<a href="${esc(ended.capture.href)}">${esc(ended.capture.text)}</a>`;
      }
      i += 1;
      continue;
    }
    if (c === '\\') {
      const next = src[i + 1];
      if (next === '\'') {
        emitChar(fromCp1252(parseInt(src.substr(i + 2, 2), 16)));
        i += 4;
        continue;
      }
      if (!/[a-z]/i.test(next)) {
        // Control symbols: escaped braces/backslash, ~ (nbsp), - _ (hyphens), * (handled above).
        if (next === '{' || next === '}' || next === '\\') emitChar(next);
        else if (next === '~') emitChar(' ');
        else if (next === '_') emitChar('-');
        else if (next === '\n' || next === '\r') { if (!state.skip) endParagraph(); }
        i += 2;
        continue;
      }
      const m = /^\\([a-z]+)(-?\d+)? ?/i.exec(src.slice(i, i + 40));
      const word = m[1];
      const arg = m[2] === undefined ? null : Number(m[2]);
      i += m[0].length;

      if (state.dest === 'stylesheet' && /^s$/.test(word)) { state.dest = 'stylesheet-entry'; styleNumber = arg; continue; }
      if (SKIP.has(word)) {
        if (word === 'stylesheet') { state.dest = 'stylesheet'; continue; }
        if (word === 'listtext' || word === 'pntext') {
          const end = src.indexOf('}', i);
          const shown = src.slice(i, end < 0 ? i : end).replace(/\\'[0-9a-f]{2}|\\[a-z]+-?\d* ?/gi, '');
          listTextOrdered = /\d+[.)]|^[a-z][.)]/i.test(shown.trim());
        }
        state.skip = true;
        if (word === 'fldinst') state.fldinst = true;
        continue;
      }
      if (state.skip && !state.fldinst) continue;
      switch (word) {
        case 'par': if (!state.dest) endParagraph(); else if (state.capture) state.capture.text += ' '; break;
        case 'line': if (!state.dest) { closeRun(); text += '<br>'; } else if (state.capture) state.capture.text += ' '; break;
        case 'tab': emitChar(' '); break;
        case 'emdash': emitChar('—'); break;
        case 'endash': emitChar('–'); break;
        case 'bullet': emitChar('•'); break;
        case 'lquote': emitChar('‘'); break;
        case 'rquote': emitChar('’'); break;
        case 'ldblquote': emitChar('“'); break;
        case 'rdblquote': emitChar('”'); break;
        case 'u': {
          const code = arg < 0 ? arg + 65536 : arg;
          emitChar(String.fromCharCode(code));
          pendingSkip = state.uc;
          break;
        }
        case 'uc': state.uc = arg ?? 1; break;
        case 'b': closeRun(); state.bold = arg !== 0; break;
        case 'i': closeRun(); state.italic = arg !== 0; break;
        case 'ul': closeRun(); state.underline = arg !== 0; break;
        case 'ulnone': closeRun(); state.underline = false; break;
        case 'strike': closeRun(); state.strike = arg !== 0; break;
        case 'super': closeRun(); state.sup = true; state.sub = false; break;
        case 'sub': closeRun(); state.sub = true; state.sup = false; break;
        case 'nosupersub': closeRun(); state.sup = false; state.sub = false; break;
        case 'plain': closeRun(); Object.assign(state, { bold: false, italic: false, underline: false, strike: false, sup: false, sub: false }); break;
        case 'pard': paraProps = { heading: 0, list: 0, listOrdered: false, listLevel: 0, inTable: false }; break;
        case 's': if (!state.dest) paraProps.heading = styles.get(arg) || 0; break;
        case 'outlinelevel': paraProps.heading = Math.min(6, (arg ?? 0) + 1); break;
        case 'ls':
          paraProps.list = arg || 1;
          if (listTextOrdered !== null) { paraProps.listOrdered = listTextOrdered; listTextOrdered = null; }
          break;
        case 'ilvl': paraProps.listLevel = Math.max(0, Math.min(5, arg || 0)); break;
        case 'pnlvlbody': paraProps.list = paraProps.list || 1; paraProps.listOrdered = true; break;
        case 'pnlvlblt': paraProps.list = paraProps.list || 1; paraProps.listOrdered = false; break;
        case 'levelnfc': break;
        case 'intbl': paraProps.inTable = true; break;
        case 'trowd': if (!rows) rows = []; row = []; break;
        case 'cell': endParagraph(); row = row || []; row.push(cell.trim()); cell = ''; break;
        case 'row': if (row) { rows = rows || []; rows.push(row); } row = null; paraProps.inTable = false; break;
        case 'footnote': closeRun(); state.dest = 'footnote'; state.capture = { text: '' }; break;
        case 'annotation': closeRun(); state.skip = false; state.dest = 'annotation'; state.capture = { text: '' }; break;
        case 'pict': closeRun(); state.dest = 'pict'; state.capture = { text: '', format: '' }; break;
        case 'pngblip': if (state.capture) state.capture.format = 'png'; break;
        case 'jpegblip': if (state.capture) state.capture.format = 'jpg'; break;
        case 'fldrslt': if (pendingHref) { state.dest = 'fldrslt-href'; state.capture = { text: '', href: pendingHref }; pendingHref = ''; } break;
        default: break;
      }
      continue;
    }
    if (c === '\r' || c === '\n') { i += 1; continue; }
    // Plain text.
    if (state.fldinst) {
      // HYPERLINK "url" inside \fldinst: remember it for the \fldrslt that follows.
      const end = src.indexOf('}', i);
      const inst = src.slice(i, end < 0 ? src.length : end);
      const link = /HYPERLINK\s+"([^"]+)"/.exec(inst);
      if (link) pendingHref = link[1];
      i = end < 0 ? src.length : end;
      continue;
    }
    if (state.dest === 'stylesheet-entry') { styleName += c; i += 1; continue; }
    if (state.dest === 'stylesheet') { i += 1; continue; }
    emitChar(c);
    i += 1;
  }
  endParagraph();
  if (rows) html += tableHtml(rows);
  closeLists(0);

  // Pictures: placed now (asynchronously), then their marks swapped for <img>.
  for (const pic of pictures) {
    const bytesOut = new Uint8Array(pic.hex.length / 2);
    for (let k = 0; k < bytesOut.length; k++) bytesOut[k] = parseInt(pic.hex.substr(k * 2, 2), 16);
    const srcOut = await place(new Blob([bytesOut], { type: pic.format === 'png' ? 'image/png' : 'image/jpeg' }), pic.format);
    html = html.replace(pic.mark, `<img src="${esc(srcOut)}" alt="">`);
  }
  // The footnote and comment texts, where htmlToMarkdown looks for them.
  if (footnotes.length) html += `<ol>${footnotes.map((t, k) => `<li id="footnote-${k + 1}"><p>${esc(t)}</p></li>`).join('')}</ol>`;
  if (comments.length) html += `<dl>${comments.map((t, k) => `<dt id="comment-${k}">Comment</dt><dd><p>${esc(t)}</p></dd>`).join('')}</dl>`;
  return html;
}
