// Files on the server, to choose from (Issue #241): the planner's "Choose from
// the server…", and the listing My Files is built on (Issue #243).
//
// Three places a file can come from, listed in this order:
//   Recent      decks this person opened or saved in the deck editor lately
//               (GET /api/me/recent-decks) - "the one I just made"
//   Library     everything in this server's library this person can see
//               (GET /api/library), grouped by course, each saying what this
//               person may do with it
//   On the server  the shared library everyone sees (content/manifest.json),
//               and for an administrator the decks in content/decks too
//
// Pure DOM, no framework: openFileBrowser() builds its own dialog.

import { el } from './util.js';
import { openQuickLook, canQuickLook } from './quicklook-open.js';

/** The kinds of file a browser can be narrowed to, in the order offered. */
export const FILE_TYPES = [
  ['deck', 'Decks'],
  ['document', 'Documents'],
  ['pdf', 'PDFs'],
  ['image', 'Pictures'],
  ['imagedeck', 'Picture decks'],
  ['video', 'Video'],
  ['audio', 'Audio'],
];
const TYPE_LABEL = { ...Object.fromEntries(FILE_TYPES), slides: 'HTML slides' };
const ICONS = { deck: '📖', document: '📄', pdf: '📄', image: '🖼', imagedeck: '🎞', video: '▶', audio: '♪', slides: '📑' };
const FILE_KINDS = new Set(['deck', 'document', 'pdf', 'image', 'imagedeck', 'video', 'audio', 'slides']);

export const typeIcon = (type) => ICONS[type] || '•';

async function getJson(url) {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Every file this person could choose, from each place it can come from.
 * Each file: {key, type, title, src, images?, course, group, filename, at,
 * from: 'recent'|'library'|'content', libraryId, may, deckMedia}.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.server] - this page has a server with accounts and a library
 * @param {boolean} [opts.isAdmin] - list content/decks files as well
 * @param {string} [opts.manifest] - the shared library's address
 */
export async function loadFiles({ server = false, isAdmin = false, manifest = 'content/manifest.json' } = {}) {
  const out = { recent: [], library: [], content: [] };
  const jobs = [];
  if (server) {
    jobs.push(getJson('/api/me/recent-decks').then(({ decks }) => {
      out.recent = (decks || []).map((d) => ({
        key: `recent:${d.src}`, type: 'deck', title: d.title || d.src.split('/').pop(), src: d.src,
        course: d.course || '', group: '', filename: d.src.split('/').pop(), at: d.at, from: 'recent',
        libraryId: d.libraryId || null, saved: !!d.saved, where: d.where,
      }));
    }).catch(() => {}));
    jobs.push(getJson('/api/library').then(({ items }) => {
      out.library = (items || []).filter((i) => FILE_KINDS.has(i.type) && (i.src || i.images?.length)).map((i) => ({
        key: `library:${i.id}`, type: i.type, title: i.title || i.filename, src: i.src || '', images: i.images,
        course: i.course || '', group: i.group || '', filename: i.filename || '', at: i.createdAt || 0, from: 'library',
        libraryId: i.id, may: i.may || null, editable: !!i.editable, deckMedia: i.deckMedia || null, createdBy: i.createdBy,
      }));
    }).catch(() => {}));
  }
  jobs.push(getJson(manifest).then((data) => {
    const items = Array.isArray(data) ? data : data?.items || [];
    out.content.push(...items.filter((i) => i && FILE_KINDS.has(i.type) && i.enabled !== false && (i.src || i.images?.length)).map((i) => ({
      key: `content:${i.src || i.images[0]}`, type: i.type, title: i.title || i.src, src: i.src || '', images: i.images,
      course: '', group: i.group || '', filename: String(i.src || '').split('/').pop(), at: 0, from: 'content', libraryId: null,
    })));
  }).catch(() => {}));
  if (server && isAdmin) {
    jobs.push(getJson('/api/content/files/decks').then(({ files }) => {
      out.contentDecks = (files || []).map((f) => ({
        key: `content:${f.url}`, type: 'deck', title: f.filename, src: f.url, course: '', group: 'content/decks',
        filename: f.filename, at: f.mtime || 0, from: 'content', libraryId: null, editable: true,
      }));
    }).catch(() => {}));
  }
  await Promise.all(jobs);
  // A content/decks file the shared library already lists is listed once.
  const listed = new Set(out.content.map((f) => f.src.replace(/^\//, '')));
  out.content.push(...(out.contentDecks || []).filter((f) => !listed.has(f.src.replace(/^\//, ''))));
  delete out.contentDecks;
  return out;
}

/** The deck editor's address for a deck, or null: the library's id, or its place on the server. */
export function editorAddress(file) {
  if (file.type !== 'deck') return null;
  if (file.libraryId && (file.editable || file.from === 'recent')) return `deck.html?library=${encodeURIComponent(file.libraryId)}`;
  if (file.from === 'content' && file.editable) return `deck.html?src=${encodeURIComponent(file.src)}`;
  return null;
}

/** Quick Look (Issue #242) for a file. */
export function quickLookFile(file) {
  const item = { type: file.type, title: file.title, src: file.src, ...(file.images ? { images: file.images } : {}) };
  openQuickLook(file.libraryId && file.from === 'library' ? { libraryId: file.libraryId, item } : { item, from: 'From the server' });
}

const fmtDate = (at) => (at ? new Date(at).toLocaleDateString() : '');

/**
 * The dialog. `mode` 'use' picks one file for something (onUse(file));
 * 'add' ticks several to add (onAdd(files)). `type` narrows it to one kind
 * of file to begin with; `preselect` ticks or highlights the file at that
 * address.
 *
 * @returns {{close(): void}}
 */
export function openFileBrowser({
  mode = 'use', type = '', title = '', preselect = '', server = false, isAdmin = false, onUse = () => {}, onAdd = () => {},
} = {}) {
  const picked = new Set();
  let files = null;
  const search = el('input', { type: 'search', placeholder: 'Search by title, file name or class', 'aria-label': 'Search files', autocomplete: 'off' });
  const kind = el('select', { 'aria-label': 'Kind of file' },
    el('option', { value: '' }, 'Every kind'),
    ...FILE_TYPES.map(([value, label]) => el('option', { value }, label)));
  kind.value = type;
  const list = el('div', { class: 'fb-list', role: 'list' }, el('p', { class: 'fb-empty' }, 'Looking…'));
  const addButton = el('button', { type: 'button', class: 'primary', disabled: true, onclick: () => { onAdd(chosen()); close(); } }, 'Add to the lecture');
  const card = el('div', { class: 'deck-dialog-card fb-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Choose from the server' },
    el('div', { class: 'fb-head' },
      el('h2', {}, title || (mode === 'add' ? 'Add from the server' : 'Choose from the server')),
      el('button', { type: 'button', 'aria-label': 'Close', onclick: () => close() }, '✕')),
    el('div', { class: 'fb-filters' }, search, kind),
    list,
    mode === 'add' ? el('div', { class: 'inline fb-foot' }, addButton, el('span', { class: 'hint fb-count' })) : null);
  const dialog = el('div', { class: 'deck-dialog fb-dialog' }, card);
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) close(); });
  dialog.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
  document.body.append(dialog);
  search.focus();

  function close() { dialog.remove(); }
  function chosen() {
    const all = [...(files?.recent || []), ...(files?.library || []), ...(files?.content || [])];
    return [...picked].map((key) => all.find((f) => f.key === key)).filter(Boolean);
  }
  function syncCount() {
    if (mode !== 'add') return;
    addButton.disabled = !picked.size;
    addButton.textContent = picked.size ? `Add ${picked.size} to the lecture` : 'Add to the lecture';
  }

  function row(file) {
    const edit = editorAddress(file);
    const what = [
      file.course && file.course.toUpperCase(),
      file.group && file.group !== file.course?.toUpperCase() && file.group,
      file.filename && file.filename !== file.title && file.filename,
      file.from === 'recent' && (file.saved ? 'saved in the deck editor' : 'opened in the deck editor'),
      fmtDate(file.at),
    ].filter(Boolean).join(' · ');
    const isPicked = picked.has(file.key);
    return el('div', { class: `fb-row${file.src && file.src === preselect ? ' is-preselected' : ''}`, role: 'listitem', 'data-key': file.key },
      mode === 'add'
        ? el('input', {
          type: 'checkbox', 'aria-label': `Choose ${file.title}`, checked: isPicked,
          onchange: (ev) => { if (ev.target.checked) picked.add(file.key); else picked.delete(file.key); syncCount(); },
        })
        : null,
      el('span', { class: 'fb-icon', 'aria-hidden': 'true' }, typeIcon(file.type)),
      el('span', { class: 'fb-what' },
        el('span', { class: 'fb-title' }, file.title),
        el('span', { class: 'fb-meta' }, `${(TYPE_LABEL[file.type] || file.type).replace(/s$/, '')}${what ? ` · ${what}` : ''}`)),
      canQuickLook({ type: file.type, entries: [] })
        ? el('button', { type: 'button', title: 'Quick Look: open it in a new tab, just for you', 'aria-label': `Quick Look: ${file.title}`, onclick: () => quickLookFile(file) }, '↗')
        : null,
      edit ? el('button', { type: 'button', title: 'Open it in the deck editor', 'aria-label': `Edit ${file.title}`, onclick: () => window.open(edit, '_blank') }, '✎') : null,
      mode === 'use' ? el('button', { type: 'button', class: 'primary', onclick: () => { onUse(file); close(); } }, 'Use') : null);
  }

  function render() {
    if (!files) return;
    const needle = search.value.trim().toLowerCase();
    const wanted = kind.value;
    const match = (f) => (!wanted || f.type === wanted)
      && (!needle || `${f.title} ${f.filename} ${f.course} ${f.group} ${f.deckMedia || ''}`.toLowerCase().includes(needle))
      // The pictures and videos used in decks only when looked for, as in the controller's library.
      && (!f.deckMedia || needle);
    const sections = [];
    const recent = files.recent.filter(match).slice(0, 10);
    if (recent.length) sections.push(el('h3', {}, 'Recent in the deck editor'), ...recent.map(row));
    const library = files.library.filter(match);
    if (library.length) {
      // My courses first, then the rest, then no course.
      const groups = new Map();
      for (const f of library) {
        const name = f.course ? f.course.toUpperCase() : 'No course';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(f);
      }
      const names = [...groups.keys()].sort((a, b) => (a === 'No course') - (b === 'No course') || a.localeCompare(b));
      for (const name of names) sections.push(el('h3', {}, `Library · ${name}`), ...groups.get(name).map(row));
    }
    const content = files.content.filter(match);
    if (content.length) sections.push(el('h3', {}, 'On the server (content/)'), ...content.map(row));
    list.replaceChildren(...(sections.length ? sections : [el('p', { class: 'fb-empty' },
      needle || wanted ? 'Nothing matches that.' : 'There is nothing on the server to choose from yet.')]));
    const shown = list.querySelector('.is-preselected');
    shown?.scrollIntoView({ block: 'nearest' });
  }

  search.addEventListener('input', render);
  kind.addEventListener('change', render);
  loadFiles({ server, isAdmin }).then((loaded) => {
    files = loaded;
    if (mode === 'add' && preselect) {
      const hit = [...files.recent, ...files.library, ...files.content].find((f) => f.src === preselect);
      if (hit) picked.add(hit.key);
    }
    render();
    syncCount();
  });
  return { close };
}
