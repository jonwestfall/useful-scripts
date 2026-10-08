// A Word or RTF file picked in the planner, the controller or My Files
// (Issue #258): the person chooses how it should be shown, and this does it.
//
//   Document (markdown)  converted here in the browser (word-import.js) into a
//                        document Podium scrolls, outlines and inks; editable.
//   PDF                  converted on the server by LibreOffice, keeping Word's
//                        own layout page for page.
//
// .docx and .rtf can become documents anywhere, with or without a server. A
// PDF, and the old binary .doc at all, need a server with LibreOffice - the
// choice says so plainly when that is not this one.

import { el } from './util.js';
import { serverInfo } from './server.js';
import { wordKind, wordToMarkdown, WORD_EXTS } from './word-import.js';
import { uploadDeckMedia } from './deck-media.js';

export { WORD_EXTS, wordKind };

/** What a file picker that takes Word files should accept. */
export const WORD_ACCEPT = '.docx,.doc,.rtf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,application/rtf,text/rtf';

/** Whether this server can make PDFs of Word files and read old .doc files. */
export async function officeConvert() {
  const info = await serverInfo();
  return !!info.officeConvert;
}

/**
 * Ask how to show a Word/RTF file. Resolves to 'markdown', 'pdf' or null.
 * @param {object} opts
 * @param {string} opts.fileName
 * @param {boolean} [opts.server] - signed in to a server with a library (a PDF lives there)
 * @param {string} [opts.prefer] - the option to start on
 */
export async function askWordChoice({ fileName, server = false, prefer = 'markdown' }) {
  const kind = wordKind(fileName);
  const office = server && await officeConvert();
  const markdownWhy = kind === 'doc' && !office
    ? 'An old .doc file needs a server with LibreOffice to read it. Save it as .docx in Word, or choose PDF on a server that has it.'
    : '';
  const pdfWhy = !server ? 'A PDF is made on a server with accounts, and this page is not signed in to one.'
    : !office ? 'This server cannot make PDFs of Word files: LibreOffice is not installed (see docs/vps.md).' : '';
  return new Promise((resolve) => {
    const title = `How should “${fileName}” be shown?`;
    const option = (value, label, detail, why) => el('label', { class: `word-choice-option${why ? ' is-off' : ''}` },
      el('input', { type: 'radio', name: 'word-choice', value, disabled: !!why }),
      el('span', {}, el('strong', {}, label), el('span', { class: 'hint' }, why || detail)));
    const card = el('div', { class: 'deck-dialog-card word-choice', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('h2', {}, title),
      option('markdown', 'As a document (Markdown)',
        'Converted to a page Podium scrolls on the projector, with an outline from its headings, its comments as presenter notes, and editing in the deck editor. Word’s page layout, fonts and colours are not kept.', markdownWhy),
      option('pdf', 'As a PDF',
        'Keeps Word’s exact layout, page for page. Shown like any PDF; it cannot be edited here.', pdfWhy));
    const go = el('button', { type: 'button', class: 'primary' }, 'Convert');
    const cancel = el('button', { type: 'button' }, 'Cancel');
    card.append(el('div', { class: 'admin-actions' }, go, cancel));
    const wrap = el('div', { class: 'deck-dialog word-choice-wrap' }, card);
    const radios = [...card.querySelectorAll('input[type=radio]')];
    const first = radios.find((r) => r.value === prefer && !r.disabled) || radios.find((r) => !r.disabled);
    if (first) first.checked = true;
    go.disabled = !first;
    const done = (value) => { wrap.remove(); resolve(value); };
    go.addEventListener('click', () => done(radios.find((r) => r.checked)?.value || null));
    cancel.addEventListener('click', () => done(null));
    wrap.addEventListener('click', (ev) => { if (ev.target === wrap) done(null); });
    wrap.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') done(null); });
    document.body.append(wrap);
    (first || cancel).focus();
  });
}

// A .doc becomes a .docx on the server first; .docx and .rtf are read here.
async function readable(file) {
  const kind = wordKind(file.name);
  if (kind !== 'doc') return { kind, data: await file.arrayBuffer() };
  const res = await fetch('/api/convert/docx', { method: 'POST', credentials: 'same-origin', body: file });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `the server said HTTP ${res.status}`);
  }
  return { kind: 'docx', data: await res.arrayBuffer() };
}

/**
 * A Word/RTF file as a markdown document, its pictures put wherever `placePicture` keeps them.
 * @returns {Promise<{markdown: string, title: string, report: object}>}
 */
export async function wordToDocument(file, { placePicture }) {
  const { kind, data } = await readable(file);
  return wordToMarkdown(data, { kind, name: file.name, placePicture });
}

/**
 * Into the library on this server as a document: its pictures as deck media
 * under the same course, then the markdown itself.
 * @returns {Promise<{item: object, report: object}>}
 */
export async function wordToLibraryDocument(file, { course = '', title = '' } = {}) {
  const name = title || file.name.replace(/\.[^.]+$/, '');
  const { markdown, title: found, report } = await wordToDocument(file, {
    placePicture: async (blob, pictureName) => (await uploadDeckMedia(blob, { filename: pictureName, course, deckName: name })).src,
  });
  const params = new URLSearchParams({ filename: `${file.name.replace(/\.[^.]+$/, '')}.md`, title: title || found || name, course, group: '' });
  const res = await fetch(`/api/library/upload?${params}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'text/markdown' },
    body: new Blob([markdown], { type: 'text/markdown' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `the server said HTTP ${res.status}`);
  return { item: body.item, report };
}

/** Into the library on this server as a PDF, made by LibreOffice. */
export async function wordToLibraryPdf(file, { course = '', title = '', group = '' } = {}) {
  const params = new URLSearchParams({ filename: file.name, title: title || file.name.replace(/\.[^.]+$/, ''), course, group, as: 'pdf' });
  const res = await fetch(`/api/library/upload?${params}`, { method: 'POST', credentials: 'same-origin', body: file });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `the server said HTTP ${res.status}`);
  return { item: body.item };
}

/** The one line to show after a conversion. */
export function reportLine(report, title) {
  return `Converted “${title}” from Word to a document. ${report.summary}`;
}

/**
 * The whole of it for a page that puts files in the library on this server
 * (My Files, Admin, the controller): ask, convert, upload. Resolves to
 * { item, message } - or null when the person cancelled.
 */
export async function uploadWordFile(file, { course = '', title = '', group = '' } = {}) {
  const choice = await askWordChoice({ fileName: file.name, server: true });
  if (!choice) return null;
  if (choice === 'pdf') {
    const { item } = await wordToLibraryPdf(file, { course, title, group });
    return { item, message: `Added “${item.title}” as a PDF, converted from ${file.name}.` };
  }
  const { item, report } = await wordToLibraryDocument(file, { course, title });
  return { item, message: reportLine(report, item.title) };
}
