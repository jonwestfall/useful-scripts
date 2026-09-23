// "Upload a ZIP": the review screen both the admin page and the planner use
// (Issue #106).
//
// Upload the archive, get back what the server thinks is in it, fix whatever
// it got wrong on one screen, and import. The server keeps the upload staged
// until Import or Cancel (see server/zip-staging.js), so everything here is
// only ever a set of choices sent back with the staged upload's id - which
// files belong to which item is never something this page gets to say.

import { el } from './util.js';

export const KIND_LABELS = {
  imagedeck: 'Picture deck',
  photo: 'Photo',
  deck: 'Marp deck',
  pdf: 'PDF',
  video: 'Video',
  audio: 'Audio',
  slides: 'HTML slides',
  webdeck: 'Web slide deck',
};
// What each choice means when it is not the item's own kind.
const OPTION_LABELS = { ...KIND_LABELS, photo: 'Separate photos' };
const RASTER = /\.(png|jpe?g|gif|webp)$/i;

const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `that did not work (${res.status})`);
  return body;
}

/**
 * Put a ZIP import into `host`.
 *
 * @param {HTMLElement} host
 * @param {object} options
 * @param {'admin'|'planner'} options.surface
 * @param {() => Promise<{code: string, title: string}[]>} [options.loadCourses]  planner: where it can be filed
 * @param {() => string} [options.defaultCourse]  planner: the course to preselect
 * @param {(result: object, choices: object) => void} [options.onImported]
 * @param {() => HTMLElement|null} [options.extraOptions]  anything else to ask on the review screen
 */
export function mountZipImport(host, { surface, loadCourses, defaultCourse, onImported, extraOptions } = {}) {
  let job = null;
  const status = el('p', { class: 'hint zip-status', role: 'status' });
  const input = el('input', { type: 'file', accept: '.zip,application/zip', class: 'zip-file', hidden: true });
  const pick = el('button', { type: 'button', class: 'zip-pick' }, 'Upload a ZIP…');
  const start = el('div', { class: 'zip-start' }, pick, input, status);
  const review = el('div', { class: 'zip-review', hidden: true });
  host.replaceChildren(start, review);

  const say = (text, bad = false) => {
    status.textContent = text;
    status.classList.toggle('is-bad', bad);
  };
  const reset = () => {
    job = null;
    review.hidden = true;
    review.replaceChildren();
    start.hidden = false;
  };

  pick.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    pick.disabled = true;
    say(`Uploading ${file.name} (${fmtBytes(file.size)}) and looking inside…`);
    try {
      const params = new URLSearchParams({ surface, filename: file.name });
      ({ job } = await api(`/api/import/zip?${params}`, { method: 'POST', body: file }));
      say('');
      start.hidden = true;
      await renderReview();
    } catch (err) {
      say(`That ZIP was not accepted: ${err.message}`, true);
    } finally {
      pick.disabled = false;
    }
  });

  async function renderReview() {
    const itemRows = job.items.map(itemRow);
    const inputRows = job.needsInput.map(inputRow);
    const importBtn = el('button', { type: 'button', class: 'big-button zip-commit' });
    const cancelBtn = el('button', { type: 'button', class: 'zip-cancel' }, 'Cancel');
    const note = el('p', { class: 'hint', role: 'status' });

    const count = () => itemRows.reduce((n, r) => n + r.count(), 0) + inputRows.reduce((n, r) => n + r.count(), 0);
    const refresh = () => {
      const n = count();
      importBtn.textContent = n === 1 ? 'Import 1 item' : `Import ${n} items`;
      importBtn.disabled = n === 0;
    };

    // Where it goes: one choice for the whole import, not one per item.
    const group = el('input', { type: 'text', class: 'zip-group', value: job.archiveName.replace(/\.zip$/i, ''), maxlength: 80 });
    const where = [el('label', { class: 'field' }, el('span', {}, 'Group in the Library'), group)];
    let courseSelect = null;
    let addToLibrary = null;
    if (surface === 'planner') {
      courseSelect = el('select', { class: 'zip-course' }, el('option', { value: '' }, 'Everyone on this server'));
      where.push(el('label', { class: 'field' }, el('span', {}, 'Who can use it'), courseSelect));
      try {
        const courses = loadCourses ? await loadCourses() : [];
        const wanted = (defaultCourse?.() || '').trim().toLowerCase();
        for (const c of courses) {
          courseSelect.append(el('option', { value: c.code, selected: c.code === wanted }, `${c.code} — ${c.title}`));
        }
      } catch { /* "everyone" still works */ }
    } else {
      addToLibrary = el('input', { type: 'checkbox', class: 'zip-add-manifest', checked: true });
      where.push(el('label', { class: 'check' }, addToLibrary, ' Add each item to the Library manifest'));
    }
    const extra = extraOptions?.() || null;

    const skippedList = job.skipped.length || job.ignored
      ? el('details', { class: 'zip-skipped' },
        el('summary', {}, [
          job.skipped.length ? `${job.skipped.length} file${job.skipped.length === 1 ? '' : 's'} cannot be imported` : '',
          job.ignored ? `${job.skipped.length ? ', and ' : ''}${job.ignored} ignored (system files, unknown types)` : '',
        ].join('')),
        el('ul', {}, ...job.skipped.map((s) => el('li', {}, el('code', {}, s.path), ` — ${s.reason}`))))
      : null;

    // Filtered: unlike el(), replaceChildren() would print a null as "null".
    review.replaceChildren(...[
      el('h3', {}, `${job.archiveName}: ${job.items.length} item${job.items.length === 1 ? '' : 's'} found`),
      el('div', { class: 'admin-form zip-where' }, ...where),
      extra,
      job.items.length ? el('div', { class: 'zip-items' }, ...itemRows.map((r) => r.node)) : el('p', { class: 'hint' }, 'Nothing in this ZIP can be imported here as it is.'),
      inputRows.length ? el('h4', { class: 'zip-needs-head' }, `${inputRows.length} need${inputRows.length === 1 ? 's' : ''} your input`) : null,
      inputRows.length ? el('div', { class: 'zip-needs' }, ...inputRows.map((r) => r.node)) : null,
      skippedList,
      el('div', { class: 'admin-actions zip-actions' }, importBtn, cancelBtn, note),
    ].filter(Boolean));
    review.hidden = false;
    for (const r of [...itemRows, ...inputRows]) r.onChange(refresh);
    refresh();

    cancelBtn.addEventListener('click', async () => {
      const id = job.id;
      reset();
      say('Import cancelled.');
      try { await api(`/api/import/zip/${id}`, { method: 'DELETE' }); } catch { /* expires on its own */ }
    });

    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      cancelBtn.disabled = true;
      note.textContent = 'Importing…';
      const choices = {
        group: group.value,
        items: Object.fromEntries(itemRows.map((r) => [r.id, r.choice()])),
        needsInput: Object.fromEntries(inputRows.map((r) => [r.id, r.choice()])),
        ...(courseSelect ? { course: courseSelect.value } : {}),
        ...(addToLibrary ? { addToLibrary: addToLibrary.checked } : {}),
      };
      try {
        const result = await api(`/api/import/zip/${job.id}/commit`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(choices),
        });
        showResult(result);
        onImported?.(result, choices);
      } catch (err) {
        note.textContent = `That did not import: ${err.message}`;
        note.classList.add('is-bad');
        importBtn.disabled = false;
        cancelBtn.disabled = false;
      }
    });
  }

  function thumbFor(files) {
    const first = files.find((f) => RASTER.test(f));
    if (!first) return el('span', { class: 'zip-thumb is-empty' });
    const params = new URLSearchParams({ path: first });
    return el('img', { class: 'zip-thumb', alt: '', loading: 'lazy', src: `/api/import/zip/${job.id}/preview?${params}` });
  }

  function itemRow(item) {
    const include = el('input', { type: 'checkbox', checked: !item.duplicate, 'aria-label': `Import ${item.title}` });
    const title = el('input', { type: 'text', class: 'zip-title', value: item.title, maxlength: 200, 'aria-label': 'Title' });
    const kind = item.options.length > 1
      ? el('select', { class: 'zip-kind', 'aria-label': 'Import as' },
        ...item.options.map((k) => el('option', { value: k, selected: k === item.kind }, OPTION_LABELS[k] || k)))
      : el('span', { class: 'zip-kind-label' }, KIND_LABELS[item.kind] || item.kind);
    const files = item.files.length === 1 ? item.files[0] : `${item.files.length} files`;
    const notes = [];
    if (item.duplicate) notes.push(el('span', { class: 'zip-flag' }, `Already in library as “${item.duplicate.title}”`));
    if (item.target) notes.push(el('span', { class: item.renamed ? 'zip-flag' : 'zip-target' }, `${item.renamed ? 'Name taken, saved as ' : '→ '}${item.target}`));
    const node = el('div', { class: 'zip-row', dataset: { kind: item.kind } },
      include, thumbFor(item.files),
      el('div', { class: 'zip-row-main' }, title,
        el('div', { class: 'zip-meta' }, kind, el('span', {}, ` ${files} · ${fmtBytes(item.size)}`), ...notes)));
    const sync = () => node.classList.toggle('is-off', !include.checked);
    sync();
    return {
      id: item.id,
      node,
      count: () => (!include.checked ? 0 : (kind.value === 'photo' ? item.files.length : 1)),
      choice: () => ({ include: include.checked, title: title.value, ...(kind.value ? { kind: kind.value } : {}) }),
      onChange: (fn) => {
        include.addEventListener('change', () => { sync(); fn(); });
        kind.addEventListener?.('change', fn);
      },
    };
  }

  function inputRow(entry) {
    const title = el('input', { type: 'text', class: 'zip-title', value: entry.title || '', maxlength: 200, 'aria-label': 'Title', hidden: !entry.options.length });
    const pickKind = entry.options.length
      ? el('select', { class: 'zip-decide', 'aria-label': 'Decide' },
        el('option', { value: '' }, 'Decide…'),
        ...entry.options.map((k) => el('option', { value: k }, OPTION_LABELS[k] || k)),
        el('option', { value: 'skip' }, 'Skip'))
      : null;
    const shown = entry.paths.slice(0, 4).join(', ') + (entry.paths.length > 4 ? `, and ${entry.paths.length - 4} more` : '');
    const node = el('div', { class: 'zip-row zip-need' },
      thumbFor(entry.paths),
      el('div', { class: 'zip-row-main' },
        el('div', {}, el('code', {}, shown)),
        el('p', { class: 'hint' }, entry.reason),
        pickKind ? el('div', { class: 'inline' }, pickKind, title) : el('span', { class: 'zip-flag' }, 'Will not be imported')));
    return {
      id: entry.id,
      node,
      count: () => {
        const v = pickKind?.value;
        if (!v || v === 'skip') return 0;
        return v === 'photo' ? entry.paths.length : 1;
      },
      choice: () => ({ kind: pickKind?.value || '', title: title.value }),
      onChange: (fn) => pickKind?.addEventListener('change', fn),
    };
  }

  function showResult(result) {
    const lines = [];
    for (const i of result.imported) {
      lines.push(el('li', {}, `Imported ${i.title}`, i.target ? ` → ${i.target}` : '', i.renamed ? ' (name was taken, so it was numbered)' : ''));
    }
    for (const s of result.skipped) lines.push(el('li', { class: 'hint' }, `Not imported: ${s.title} — ${s.reason}`));
    for (const f of result.failed) lines.push(el('li', { class: 'is-bad' }, `Failed: ${f.title} — ${f.reason}`));
    const done = el('button', { type: 'button', class: 'zip-done' }, 'Done');
    done.addEventListener('click', reset);
    review.replaceChildren(
      el('h3', {}, `Imported ${result.imported.length} item${result.imported.length === 1 ? '' : 's'}`),
      el('ul', { class: 'zip-result' }, ...lines),
      el('div', { class: 'admin-actions' }, done),
    );
  }

  return { reset };
}
