// My Files (Issue #243): everything this account has on the server, in one
// place, each thing saying what you may do with it - and a small profile with
// the one thing you may change about yourself, your password.
//
// Four tabs, each a list the server already gives every other page:
//   Files              GET /api/library (with its per-item `may`, Issue #241)
//   Lectures           GET /api/plans, with #239's personal archive
//   Deck templates     GET /api/deck-templates
//   Recorded lectures  GET /api/lectures
// Nothing here decides a permission itself. A button is offered only where
// the server said it would allow it, and the server checks again either way.

import { $, $$, el } from './util.js';
import { serverInfo, mountSessionBadge } from './server.js';
import { FILE_TYPES, typeIcon, quickLookFile } from './file-browser.js';
import { canQuickLook } from './quicklook-open.js';
import { dayAndTime, spanOf, downloadSessionRecap } from './recap-pdf.js';
import { startPageTheme, setThemeChoice, onThemeChange } from './theme.js';
import { wordKind, uploadWordFile } from './word-upload.js';
import { createRosterPanel } from './roster-panel.js';
import { createAttendanceReview } from './attendance-review.js';
import { mountSessionSearch } from './session-search.js';

// Light or dark, as chosen for every page (see theme.js).
startPageTheme();

let me = null;
let profileCourses = [];      // where this account is a member, as the admin set it
let fileCourses = [];         // where it may file things (the library's own list)
let files = [];
let plans = [];
const picked = new Set();

const TYPE_LABEL = { ...Object.fromEntries(FILE_TYPES), slides: 'HTML slides', web: 'Web pages', text: 'Text cards', qr: 'QR codes', youtube: 'YouTube' };
const kindName = (type) => (TYPE_LABEL[type] || type).replace(/s$/, '');
const COURSE = (code) => String(code || '').toUpperCase();
const ROLE = { owner: 'owner', member: 'member (TA)' };

async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    ...(raw !== undefined ? { body: raw } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function size(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const day = (ms) => (ms ? new Date(ms).toLocaleDateString() : '');

function note(id, text, bad = false) {
  const line = $(id);
  line.textContent = text;
  line.classList.toggle('is-bad', bad);
}

// --- dialogs ------------------------------------------------------------------

/** A small modal; resolves with what `build` hands to done(), or null. */
function dialog(title, build) {
  return new Promise((resolve) => {
    const card = el('div', { class: 'deck-dialog-card me-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('h2', {}, title));
    const wrap = el('div', { class: 'deck-dialog' }, card);
    const done = (value) => { wrap.remove(); resolve(value); };
    build(card, done);
    wrap.addEventListener('click', (ev) => { if (ev.target === wrap) done(null); });
    wrap.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') done(null); });
    document.body.append(wrap);
    card.querySelector('input, select, button')?.focus();
  });
}

/** Which course to file something under: a code, '' for none, or null for cancel. */
function askCourse(title, current = '') {
  return dialog(title, (card, done) => {
    const pick = el('select', { 'aria-label': 'Course' },
      el('option', { value: '' }, 'No course — everyone with an account'),
      ...fileCourses.map((c) => el('option', { value: c.code }, `${COURSE(c.code)} — ${c.title}`)));
    pick.value = current || '';
    const warn = el('p', { class: 'hint me-warn' });
    const sync = () => {
      warn.textContent = pick.value ? '' : 'With no course, everyone who has an account on this server can see it.';
    };
    pick.addEventListener('change', sync);
    sync();
    card.append(pick, warn, el('div', { class: 'admin-actions' },
      el('button', { type: 'button', class: 'primary', onclick: () => done(pick.value) }, 'Move'),
      el('button', { type: 'button', onclick: () => done(null) }, 'Cancel')));
  });
}

function changePassword() {
  return dialog('Change your password', (card, done) => {
    const current = el('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password', id: 'pw-current' });
    const next = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password', id: 'pw-new', minlength: '8' });
    const again = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password again', id: 'pw-again' });
    const status = el('p', { class: 'hint', role: 'status', id: 'pw-status' });
    const save = el('button', { type: 'submit', class: 'primary' }, 'Change password');
    const form = el('form', { class: 'me-password' },
      el('label', {}, 'Current password', current),
      el('label', {}, 'New password (at least 8 characters)', next),
      el('label', {}, 'New password again', again),
      el('p', { class: 'hint' }, 'Changing it signs you out everywhere else. You stay signed in here.'),
      status,
      el('div', { class: 'admin-actions' }, save, el('button', { type: 'button', onclick: () => done(null) }, 'Cancel')));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      status.classList.add('is-bad');
      if (next.value.length < 8) { status.textContent = 'The new password needs at least 8 characters.'; return; }
      if (next.value !== again.value) { status.textContent = 'The two new passwords are not the same.'; return; }
      save.disabled = true;
      status.classList.remove('is-bad');
      status.textContent = 'Changing…';
      try {
        await api('/api/me/password', { method: 'POST', body: { current: current.value, password: next.value } });
        done(true);
      } catch (err) {
        status.classList.add('is-bad');
        status.textContent = err.status === 403 ? 'That is not your current password.' : `That did not work: ${err.message}`;
        if (err.status === 403) { current.value = ''; current.focus(); }
        save.disabled = false;
      }
    });
    card.append(form);
  });
}

// --- profile ------------------------------------------------------------------

function renderProfile() {
  $('#me-name').textContent = me.displayName || me.username;
  $('#me-who').textContent = [me.username, me.isAdmin ? 'Administrator' : ''].filter(Boolean).join(' · ');
  const active = profileCourses.filter((c) => !c.archived);
  const archived = profileCourses.filter((c) => c.archived);
  const chip = (c) => el('span', { class: `me-course${c.archived ? ' is-archived' : ''}`, title: c.title },
    `${COURSE(c.code)} — ${ROLE[c.role] || c.role}`);
  $('#me-courses').replaceChildren(
    el('span', { class: 'me-courses-label' }, 'Courses:'),
    ...(active.length ? active.map(chip) : [el('span', { class: 'hint' }, me.isAdmin
      ? 'None of your own. As an administrator you can see every course.'
      : 'None yet. An administrator adds you to a course.')]),
    ...(archived.length ? [el('span', { class: 'me-courses-label' }, 'Archived:'), ...archived.map(chip)] : []));
}

// --- Files --------------------------------------------------------------------

/** What this person may do with a file, and why - the chip on each row. */
function standing(item) {
  const by = item.createdByName || 'someone else';
  if (item.createdBy === me.id) return { label: 'Owner', cls: 'is-owner', why: 'You added this.' };
  if (item.may?.delete) {
    return {
      label: 'Can edit', cls: 'is-edit',
      why: me.isAdmin && !profileCourses.some((c) => c.code === item.course && c.role === 'owner')
        ? `Added by ${by}; you're an administrator.`
        : `Added by ${by}; you're an owner of ${COURSE(item.course)}.`,
    };
  }
  return {
    label: 'View only', cls: 'is-view',
    why: item.course ? `Added by ${by}; you're a member of ${COURSE(item.course)}.` : `Added by ${by}; shared with everyone on this server.`,
  };
}

function fillFileFilters() {
  const course = $('#files-course');
  const was = course.value;
  const codes = [...new Set(files.map((f) => f.course).filter(Boolean))].sort();
  course.replaceChildren(el('option', { value: '' }, 'Every course'),
    ...codes.map((code) => el('option', { value: code }, COURSE(code))),
    el('option', { value: '-' }, 'No course'));
  course.value = [...course.options].some((o) => o.value === was) ? was : '';

  const type = $('#files-type');
  const wasType = type.value;
  const kinds = [...new Set(files.map((f) => f.type))];
  const order = FILE_TYPES.map(([t]) => t);
  kinds.sort((a, b) => ((order.indexOf(a) + 1) || 99) - ((order.indexOf(b) + 1) || 99) || a.localeCompare(b));
  type.replaceChildren(el('option', { value: '' }, 'Every kind'), ...kinds.map((t) => el('option', { value: t }, TYPE_LABEL[t] || t)));
  type.value = [...type.options].some((o) => o.value === wasType) ? wasType : '';

  const upload = $('#upload-course');
  const wasUpload = upload.value;
  upload.replaceChildren(el('option', { value: '' }, 'No course'),
    ...fileCourses.map((c) => el('option', { value: c.code }, `${COURSE(c.code)} — ${c.title}`)));
  upload.value = [...upload.options].some((o) => o.value === wasUpload) ? wasUpload
    : (fileCourses.find((c) => c.role === 'owner')?.code || fileCourses[0]?.code || '');
}

function shownFiles() {
  const needle = $('#files-search').value.trim().toLowerCase();
  const show = $('#files-show').value;
  const course = $('#files-course').value;
  const type = $('#files-type').value;
  const deckMedia = $('#files-deck-media').checked;
  return files.filter((f) => {
    if (show === 'mine' && f.createdBy !== me.id) return false;
    if (show === 'edit' && !f.may?.delete) return false;
    if (show === 'view' && f.may?.delete) return false;
    if (course === '-' ? f.course : course && f.course !== course) return false;
    if (type && f.type !== type) return false;
    if (f.deckMedia && !deckMedia && !needle) return false;
    return !needle || `${f.title} ${f.filename} ${f.course || ''} ${f.group} ${f.createdByName}`.toLowerCase().includes(needle);
  });
}

function fileRow(item) {
  const chip = standing(item);
  const may = item.may || {};
  const what = [
    kindName(item.type),
    item.filename && item.filename !== item.title && item.filename,
    item.course ? COURSE(item.course) : 'No course',
    item.group,
    size(item.bytes),
    item.createdBy === me.id ? 'added by you' : item.createdByName && `added by ${item.createdByName}`,
    day(item.createdAt),
  ].filter(Boolean).join(' · ');
  const small = (label, attrs) => el('button', { type: 'button', class: 'admin-small', ...attrs }, label);
  return el('div', { class: 'me-row', role: 'listitem', 'data-id': String(item.id) },
    may.delete
      ? el('input', {
        type: 'checkbox', 'aria-label': `Select ${item.title}`, checked: picked.has(item.id),
        onchange: (ev) => { if (ev.target.checked) picked.add(item.id); else picked.delete(item.id); renderBulk(); },
      })
      : el('span', { class: 'me-nocheck' }),
    el('span', { class: 'fb-icon', 'aria-hidden': 'true' }, typeIcon(item.type)),
    el('span', { class: 'fb-what' },
      el('span', { class: 'fb-title' }, item.title),
      el('span', { class: 'fb-meta' }, what)),
    el('span', { class: `me-chip ${chip.cls}`, title: chip.why }, chip.label),
    el('span', { class: 'me-actions' },
      canQuickLook({ type: item.type })
        ? small('↗', { title: 'Quick Look: open it in a new tab, just for you', 'aria-label': `Quick Look: ${item.title}`, onclick: () => quickLookFile(fileForQuickLook(item)) })
        : null,
      (item.type === 'deck' || item.type === 'document') && may.edit
        ? small('✎ Edit', { 'aria-label': `Edit ${item.title}`, onclick: () => window.open(`deck.html?library=${encodeURIComponent(item.id)}`, '_blank') })
        : null,
      item.src ? el('a', { class: 'admin-small me-link', href: item.src, download: item.filename || '', 'aria-label': `Download ${item.title}` }, 'Download') : null,
      may.rename ? small('Rename', { 'aria-label': `Rename ${item.title}`, onclick: () => renameFile(item) }) : null,
      // A .md shown as slides or as a page to read (Issue #240): the same file.
      may.rename && (item.type === 'deck' || item.type === 'document')
        ? small(item.type === 'deck' ? 'Show as a document' : 'Show as slides', {
          title: item.type === 'deck' ? 'One page the room scrolls through, rather than slides' : 'Slides, split at every ---, rather than one page',
          onclick: () => switchKind(item),
        })
        : null,
      may.move ? small('Move to…', { 'aria-label': `Move ${item.title}`, onclick: () => moveFiles([item]) }) : null,
      may.delete ? small('Delete', { class: 'admin-small is-bad', 'aria-label': `Delete ${item.title}`, onclick: () => deleteFiles([item]) }) : null));
}

const fileForQuickLook = (item) => ({
  type: item.type, title: item.title, src: item.src || '', images: item.images, libraryId: item.id, from: 'library',
});

function renderFiles() {
  const shown = shownFiles();
  $('#files-list').replaceChildren(...(shown.length ? shown.map(fileRow) : [el('p', { class: 'hint' },
    files.length ? 'Nothing matches that.' : 'Nothing in the library yet. Upload something above.')]));
  renderBulk();
}

function renderBulk() {
  for (const id of [...picked]) if (!files.some((f) => f.id === id)) picked.delete(id);
  $('#files-bulk').hidden = !picked.size;
  $('#files-bulk-count').textContent = `${picked.size} selected`;
}

async function loadFiles() {
  try {
    const data = await api('/api/library');
    files = data.items || [];
    fileCourses = data.courses || [];
    fillFileFilters();
    renderFiles();
  } catch (err) {
    $('#files-list').replaceChildren(el('p', { class: 'hint is-bad' }, `The library did not load: ${err.message}`));
  }
}

async function renameFile(item) {
  const title = prompt('A new name for it:', item.title);
  if (title === null || !title.trim() || title.trim() === item.title) return;
  try {
    await api(`/api/library/${item.id}`, { method: 'PATCH', body: { title: title.trim() } });
    note('#files-note', `Renamed to “${title.trim()}”.`);
    await loadFiles();
  } catch (err) { note('#files-note', `That was not renamed: ${err.message}`, true); }
}

async function switchKind(item) {
  const type = item.type === 'deck' ? 'document' : 'deck';
  try {
    await api(`/api/library/${item.id}`, { method: 'PATCH', body: { type } });
    note('#files-note', `“${item.title}” is now ${type === 'deck' ? 'a slide deck' : 'a document'}.`);
    await loadFiles();
  } catch (err) { note('#files-note', `That did not change: ${err.message}`, true); }
}

async function moveFiles(items) {
  const course = await askCourse(items.length === 1 ? `Move “${items[0].title}” to…` : `Move ${items.length} files to…`,
    items.length === 1 ? items[0].course || '' : '');
  if (course === null) return;
  const failed = [];
  for (const item of items) {
    try { await api(`/api/library/${item.id}`, { method: 'PATCH', body: { course } }); } catch (err) { failed.push(`${item.title}: ${err.message}`); }
  }
  const where = course ? COURSE(course) : 'No course';
  note('#files-note', failed.length ? `Not everything moved. ${failed.join(' · ')}` : `Moved ${items.length === 1 ? `“${items[0].title}”` : `${items.length} files`} to ${where}.`, !!failed.length);
  picked.clear();
  await loadFiles();
}

async function deleteFiles(items) {
  const what = items.length === 1 ? `“${items[0].title}”` : `these ${items.length} files`;
  if (!confirm(`Delete ${what} from the library? A lecture that uses ${items.length === 1 ? 'it' : 'them'} will not find ${items.length === 1 ? 'it' : 'them'} any more.`)) return;
  const failed = [];
  for (const item of items) {
    try { await api(`/api/library/${item.id}`, { method: 'DELETE' }); } catch (err) { failed.push(`${item.title}: ${err.message}`); }
  }
  note('#files-note', failed.length ? `Not everything was deleted. ${failed.join(' · ')}` : `Deleted ${what}.`, !!failed.length);
  picked.clear();
  await loadFiles();
}

async function upload(list) {
  const chosen = [...list];
  if (!chosen.length) return;
  const course = $('#upload-course').value;
  let done = 0;
  const failed = [];
  const reports = [];
  for (const file of chosen) {
    note('#upload-note', `Uploading ${file.name}…`);
    // A Word or RTF file (Issue #258): a document or a PDF, as chosen.
    if (wordKind(file.name)) {
      try {
        const result = await uploadWordFile(file, { course });
        if (result) { done += 1; reports.push(result.message); }
      } catch (err) { failed.push(`${file.name}: ${err.message}`); }
      continue;
    }
    const params = new URLSearchParams({ filename: file.name, title: file.name.replace(/\.[^.]+$/, ''), course, group: '' });
    try { await api(`/api/library/upload?${params}`, { method: 'POST', raw: file }); done += 1; } catch (err) { failed.push(`${file.name}: ${err.message}`); }
  }
  note('#upload-note', [done && `Added ${done} file${done === 1 ? '' : 's'} to the library${course ? ` under ${COURSE(course)}` : ''}.`,
    ...reports, failed.length && `Not uploaded: ${failed.join(' · ')}`].filter(Boolean).join(' '), !!failed.length);
  await loadFiles();
}

function wireFiles() {
  for (const id of ['#files-search']) $(id).addEventListener('input', renderFiles);
  for (const id of ['#files-show', '#files-course', '#files-type', '#files-deck-media']) $(id).addEventListener('change', renderFiles);
  $('#upload-pick').addEventListener('click', () => $('#upload-file').click());
  $('#upload-file').addEventListener('change', (ev) => { upload(ev.target.files); ev.target.value = ''; });
  const drop = $('#panel-files');
  drop.addEventListener('dragover', (ev) => { if (ev.dataTransfer?.types?.includes('Files')) { ev.preventDefault(); drop.classList.add('is-drop'); } });
  drop.addEventListener('dragleave', (ev) => { if (ev.target === drop) drop.classList.remove('is-drop'); });
  drop.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer?.files?.length) return;
    ev.preventDefault();
    drop.classList.remove('is-drop');
    upload(ev.dataTransfer.files);
  });
  const chosen = () => files.filter((f) => picked.has(f.id));
  $('#files-bulk-move').addEventListener('click', () => moveFiles(chosen().filter((f) => f.may?.move)));
  $('#files-bulk-delete').addEventListener('click', () => deleteFiles(chosen()));
  $('#files-bulk-clear').addEventListener('click', () => { picked.clear(); renderFiles(); });
}

// --- Lectures (plans) -----------------------------------------------------------

function lectureRow(plan) {
  const mine = plan.ownerId === me.id;
  const small = (label, attrs) => el('button', { type: 'button', class: 'admin-small', ...attrs }, label);
  return el('div', { class: `me-row${plan.archived ? ' is-archived' : ''}`, role: 'listitem', 'data-id': String(plan.id) },
    el('span', { class: 'fb-icon', 'aria-hidden': 'true' }, '🗂'),
    el('span', { class: 'fb-what' },
      el('span', { class: 'fb-title' }, plan.title),
      el('span', { class: 'fb-meta' }, [plan.course ? COURSE(plan.course) : 'No class', mine ? 'yours' : plan.owner && `by ${plan.owner}`,
        `changed ${day(plan.updatedAt)}`, plan.archived && 'archived'].filter(Boolean).join(' · '))),
    el('span', {
      class: `me-chip ${mine ? 'is-owner' : 'is-view'}`,
      title: mine ? 'You wrote this lecture.' : `Shared with you through ${COURSE(plan.course)}: you can open and present it, not change it.`,
    }, mine ? 'Mine' : 'Shared, view & present'),
    el('span', { class: 'me-actions' },
      small('Open', { title: 'Open it in the planner', 'aria-label': `Open ${plan.title} in the planner`, onclick: () => window.open(`plan.html?open=${encodeURIComponent(plan.id)}`, '_blank') }),
      small('Present', { title: 'Open it in the controller', 'aria-label': `Present ${plan.title}`, onclick: () => window.open(`control.html?plan=${encodeURIComponent(plan.id)}`, '_blank') }),
      small(plan.archived ? 'Unarchive' : 'Archive', { 'aria-label': `${plan.archived ? 'Unarchive' : 'Archive'} ${plan.title}`, onclick: () => archivePlan(plan, !plan.archived) }),
      mine || me.isAdmin ? small('Delete', { class: 'admin-small is-bad', 'aria-label': `Delete ${plan.title}`, onclick: () => deletePlan(plan) }) : null));
}

function renderLectures() {
  const needle = $('#lectures-search').value.trim().toLowerCase();
  const archived = $('#lectures-archived').checked;
  const shown = plans.filter((p) => (archived || !p.archived)
    && (!needle || `${p.title} ${p.course || ''} ${p.owner}`.toLowerCase().includes(needle)));
  const hidden = plans.filter((p) => p.archived).length;
  $('#lectures-list').replaceChildren(...(shown.length ? shown.map(lectureRow) : [el('p', { class: 'hint' },
    plans.length ? 'Nothing matches that.' : 'No lectures on the server yet. Make one in the planner.')]));
  note('#lectures-note', !archived && hidden ? `${hidden} archived lecture${hidden === 1 ? '' : 's'} not shown.` : '');
}

async function loadLectures() {
  try {
    plans = (await api('/api/plans')).plans || [];
    renderLectures();
  } catch (err) {
    $('#lectures-list').replaceChildren(el('p', { class: 'hint is-bad' }, `Lectures did not load: ${err.message}`));
  }
}

async function archivePlan(plan, archived) {
  try {
    await api('/api/plans/archive', { method: 'PUT', body: { ids: [plan.id], archived } });
    await loadLectures();
    note('#lectures-note', `${archived ? 'Archived' : 'Unarchived'} “${plan.title}”. ${archived ? 'Only from your own list - nobody else\'s.' : ''}`);
  } catch (err) { note('#lectures-note', `That did not work: ${err.message}`, true); }
}

async function deletePlan(plan) {
  if (!confirm(`Delete “${plan.title}” from the server? Copies already on someone's device are left alone.`)) return;
  try {
    await api(`/api/plans/${plan.id}`, { method: 'DELETE' });
    await loadLectures();
    note('#lectures-note', `Deleted “${plan.title}”.`);
  } catch (err) { note('#lectures-note', `That was not deleted: ${err.message}`, true); }
}

// --- Deck templates ------------------------------------------------------------

async function loadTemplates() {
  try {
    const { templates } = await api('/api/deck-templates');
    const small = (label, attrs) => el('button', { type: 'button', class: 'admin-small', ...attrs }, label);
    $('#templates-list').replaceChildren(...((templates || []).length ? templates.map((t) => el('div', { class: 'me-row', role: 'listitem' },
      el('span', { class: 'fb-icon', 'aria-hidden': 'true' }, t.kind === 'deck' ? '📖' : '▭'),
      el('span', { class: 'fb-what' },
        el('span', { class: 'fb-title' }, t.title),
        el('span', { class: 'fb-meta' }, [t.kind === 'deck' ? 'Whole deck' : 'One slide', t.scope === 'mine' ? 'yours' : COURSE(t.course),
          t.updatedBy && `changed by ${t.updatedBy}`, day(t.updatedAt)].filter(Boolean).join(' · '))),
      el('span', { class: `me-chip ${t.editable ? (t.scope === 'mine' ? 'is-owner' : 'is-edit') : 'is-view'}` },
        t.scope === 'mine' ? 'Mine' : t.editable ? 'Can edit' : 'View only'),
      el('span', { class: 'me-actions' },
        small('Use', { title: 'A new deck from it, in the deck editor', 'aria-label': `New deck from ${t.title}`, onclick: () => window.open(`deck.html?from=${encodeURIComponent(`s:${t.id}`)}`, '_blank') }),
        t.editable ? small('✎ Edit', { 'aria-label': `Edit ${t.title}`, onclick: () => window.open(`deck.html?template=${encodeURIComponent(`s:${t.id}`)}`, '_blank') }) : null,
        t.editable ? small('Rename', { 'aria-label': `Rename ${t.title}`, onclick: () => renameTemplate(t) }) : null,
        t.editable ? small('Delete', { class: 'admin-small is-bad', 'aria-label': `Delete ${t.title}`, onclick: () => deleteTemplate(t) }) : null)))
      : [el('p', { class: 'hint' }, 'No deck templates of your own or your courses\' yet. Save one from the deck editor\'s Save menu.')]));
  } catch (err) {
    $('#templates-list').replaceChildren(el('p', { class: 'hint is-bad' }, `Templates did not load: ${err.message}`));
  }
}

async function renameTemplate(t) {
  const title = prompt('A new name for the template:', t.title);
  if (title === null || !title.trim() || title.trim() === t.title) return;
  try {
    await api(`/api/deck-templates/${t.id}`, { method: 'PUT', body: { title: title.trim() } });
    note('#templates-note', `Renamed to “${title.trim()}”.`);
    await loadTemplates();
  } catch (err) { note('#templates-note', `That was not renamed: ${err.message}`, true); }
}

async function deleteTemplate(t) {
  if (!confirm(`Delete the template “${t.title}”? Decks already made from it are not affected.`)) return;
  try {
    await api(`/api/deck-templates/${t.id}`, { method: 'DELETE' });
    note('#templates-note', `Deleted “${t.title}”.`);
    await loadTemplates();
  } catch (err) { note('#templates-note', `That was not deleted: ${err.message}`, true); }
}

// --- Recorded lectures ---------------------------------------------------------

// Searching what was said and shown in them (Issue #159): while a search is
// showing results, the list steps aside for them.
const recordedSearch = mountSessionSearch($('#recorded-search'), {
  label: 'Search your recorded lectures',
  onActive: (on) => { $('#recorded-list').hidden = on; },
});

async function loadRecorded() {
  try {
    const { lectures } = await api('/api/lectures');
    recordedSearch.setCourses((lectures || []).map((l) => l.course));
    const small = (label, attrs) => el('button', { type: 'button', class: 'admin-small', ...attrs }, label);
    $('#recorded-list').replaceChildren(...((lectures || []).length ? lectures.map((l) => el('div', { class: 'me-row', role: 'listitem' },
      el('span', { class: 'fb-icon', 'aria-hidden': 'true' }, '⏺'),
      el('span', { class: 'fb-what' },
        el('span', { class: 'fb-title' }, l.title || l.room || 'Untitled session'),
        el('span', { class: 'fb-meta' }, [dayAndTime(l.startedAt), l.course && COURSE(l.course), spanOf(l),
          l.polls ? `${l.polls} poll${l.polls === 1 ? '' : 's'}` : '', l.ownerId === me.id ? 'yours' : l.owner && `by ${l.owner}`].filter(Boolean).join(' · '))),
      el('span', { class: 'me-actions' },
        // Played back on its own clock, mic audio and all (Issue #132).
        small('▶ Replay', {
          'aria-label': `Replay ${l.title || l.room || 'this session'}`,
          onclick: () => window.open(`replay.html?lecture=${l.id}`, '_blank', 'noopener'),
        }),
        small('Recap (PDF)', {
          'aria-label': `Recap of ${l.title || l.room || 'this session'}`,
          onclick: async (ev) => {
            const button = ev.currentTarget;
            try { await downloadSessionRecap((await api(`/api/lectures/${l.id}`)), button); } catch (err) { note('#recorded-note', `The recap did not build: ${err.message}`, true); }
          },
        }),
        l.mayDelete ? small('Delete', { class: 'admin-small is-bad', 'aria-label': `Delete the record of ${l.title || l.room || 'this session'}`, onclick: () => deleteRecorded(l) }) : null)))
      : [el('p', { class: 'hint' }, 'No recorded lectures yet. A display that goes live on this server records one.')]));
  } catch (err) {
    $('#recorded-list').replaceChildren(el('p', { class: 'hint is-bad' }, `Recorded lectures did not load: ${err.message}`));
  }
}

async function deleteRecorded(l) {
  if (!confirm(`Delete the record of “${l.title || l.room || 'this session'}”, with its polls and files? This cannot be undone.`)) return;
  try {
    await api(`/api/lectures/${l.id}`, { method: 'DELETE' });
    note('#recorded-note', 'Deleted.');
    await loadRecorded();
  } catch (err) { note('#recorded-note', `That was not deleted: ${err.message}`, true); }
}

// --- tabs, and starting up -----------------------------------------------------

// Rosters (Issue #256): the courses this person is in - every course, for an
// administrator, who may keep any of them.
let rosterPanel = null;
async function loadRoster() {
  let list = profileCourses.filter((c) => !c.archived);
  if (me.isAdmin) {
    try { list = (await api('/api/courses')).courses.filter((c) => !c.archived); } catch { /* their own, then */ }
  }
  rosterPanel ??= createRosterPanel({ api, dialog, courses: () => list, initial: rosterWanted });
  await rosterPanel.open();
}
// #roster:psy415 opens that course's roster (Admin links here).
const rosterWanted = /^#roster:(.+)$/.exec(location.hash)?.[1] || '';

// Attendance after class (Issue #256): the same courses as Rosters.
let attendanceReview = null;
async function loadAttendance() {
  let list = profileCourses.filter((c) => !c.archived);
  if (me.isAdmin) {
    try { list = (await api('/api/courses')).courses.filter((c) => !c.archived); } catch { /* their own, then */ }
  }
  attendanceReview ??= createAttendanceReview({ api, dialog, courses: () => list, initial: attendanceWanted });
  await attendanceReview.open();
}
const attendanceWanted = /^#attendance:(.+)$/.exec(location.hash)?.[1] || '';

const LOADERS = { 'panel-files': loadFiles, 'panel-lectures': loadLectures, 'panel-templates': loadTemplates, 'panel-recorded': loadRecorded, 'panel-roster': loadRoster, 'panel-attendance': loadAttendance };
const loaded = new Set();

function showTab(target) {
  for (const tab of $$('.me-tabs .tab')) {
    const on = tab.dataset.target === target;
    tab.classList.toggle('is-on', on);
    tab.setAttribute('aria-selected', String(on));
    $(`#${tab.dataset.target}`).hidden = !on;
  }
  if (!loaded.has(target)) { loaded.add(target); LOADERS[target](); }
  // The roster tab keeps its course in the address itself (roster-panel.js).
  if (target !== 'panel-roster' && target !== 'panel-attendance') history.replaceState(null, '', `#${target.replace('panel-', '')}`);
}

async function start() {
  mountSessionBadge($('#session-badge'));
  const info = await serverInfo();
  if (info.auth?.mode !== 'accounts' || !info.user) { $('#no-accounts').hidden = false; return; }
  let profile;
  try { profile = await api('/api/me/profile'); } catch { $('#no-accounts').hidden = false; return; }
  me = profile.user;
  profileCourses = profile.courses || [];
  $('#me').hidden = false;
  renderProfile();
  // An administrator can see everything; the page is still theirs.
  $('#files-show').value = me.isAdmin ? 'mine' : 'all';
  $('#me-password').addEventListener('click', async () => {
    if (await changePassword()) {
      $('#me-who').textContent = `${$('#me-who').textContent.split(' — ')[0]} — password changed. Every other device has been signed out.`;
    }
  });
  // Appearance: saved on the account, so it follows them to every device.
  onThemeChange((effective, choice) => { $('#me-theme').value = choice; });
  $('#me-theme').addEventListener('change', async (ev) => {
    $('#me-theme-note').textContent = 'Saving…';
    $('#me-theme-note').textContent = await setThemeChoice(ev.target.value)
      ? 'Saved — every page, on every device you sign in from.'
      : 'Used on this device, but not saved to your account. Try again in a moment.';
  });
  wireFiles();
  $('#lectures-search').addEventListener('input', renderLectures);
  $('#lectures-archived').addEventListener('change', renderLectures);
  for (const tab of $$('.me-tabs .tab')) tab.addEventListener('click', () => showTab(tab.dataset.target));
  const wanted = `panel-${location.hash.slice(1).split(':')[0]}`;
  showTab(LOADERS[wanted] ? wanted : 'panel-files');
}

start();
