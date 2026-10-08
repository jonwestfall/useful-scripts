// A course's roster on My Files (Issue #256, phase 1): the people attendance
// is taken for. Owners (and admins) import, add, edit and remove; other
// members (TAs) read and export. See server/roster.js for the rules.
//
// An import is always previewed first - who is new, who changes and how, who
// comes off - and only then applied. The server reads the file again to apply
// it, so what lands is what the file says, not what a page sent back.

import { $, el } from './util.js';

const COURSE = (code) => String(code || '').toUpperCase();

/**
 * @param {object} deps
 * @param {(path: string, opts?: object) => Promise<any>} deps.api
 * @param {(title: string, build: (card: HTMLElement, done: (v: any) => void) => void) => Promise<any>} deps.dialog
 * @param {() => {code: string, title: string, role: string}[]} deps.courses - courses this person is in (an admin: all)
 * @param {string} [deps.initial] - a course to open on
 */
export function createRosterPanel({ api, dialog, courses, initial = '' }) {
  const pick = $('#roster-course');
  const list = $('#roster-list');
  const tools = $('#roster-tools');
  const search = $('#roster-search');
  const showRemoved = $('#roster-removed');
  let people = [];
  let mayEdit = false;

  const say = (text, bad = false) => {
    $('#roster-note').textContent = text;
    $('#roster-note').classList.toggle('is-bad', bad);
  };

  function fillCourses() {
    const all = courses();
    pick.replaceChildren(...all.map((c) => el('option', { value: c.code }, `${COURSE(c.code)}${c.title && c.title !== c.code ? ` — ${c.title}` : ''}`)));
    if (initial && all.some((c) => c.code === initial)) pick.value = initial;
    $('#roster-none').hidden = all.length > 0;
    $('#roster-body').hidden = !all.length;
  }

  async function load() {
    if (!pick.value) return;
    list.replaceChildren(el('p', { class: 'hint' }, 'Looking…'));
    try {
      const data = await api(`/api/courses/${encodeURIComponent(pick.value)}/roster${showRemoved.checked ? '?removed=1' : ''}`);
      people = data.people || [];
      mayEdit = !!data.mayEdit;
    } catch (err) {
      people = [];
      say(`Could not load the roster: ${err.message}`, true);
    }
    tools.hidden = !mayEdit;
    showRemoved.closest('label').hidden = !mayEdit;
    $('#roster-export').href = `/api/courses/${encodeURIComponent(pick.value)}/roster/export`;
    history.replaceState(null, '', `#roster:${pick.value}`);
    render();
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const shown = people.filter((p) => !q || `${p.name} ${p.studentId} ${p.email}`.toLowerCase().includes(q));
    const current = people.filter((p) => !p.removedAt).length;
    $('#roster-count').textContent = `${current} ${current === 1 ? 'person' : 'people'}${mayEdit ? '' : ' · you can read this roster; its owners change it'}`;
    if (!shown.length) {
      list.replaceChildren(el('p', { class: 'hint' }, people.length ? 'Nobody matches that search.'
        : mayEdit ? 'Nobody on this roster yet. Import the class list your LMS or registrar gives you as a CSV, or add people one by one.'
          : 'Nobody on this roster yet.'));
      return;
    }
    list.replaceChildren(...shown.map(row));
  }

  function row(p) {
    const small = (label, attrs) => el('button', { type: 'button', class: 'admin-small', ...attrs }, label);
    const meta = [p.studentId && `ID ${p.studentId}`, p.email, p.source === 'csv' ? 'from a CSV' : p.source === 'guest' ? 'added from a guest check-in' : 'added by hand',
      p.removedAt && `removed ${new Date(p.removedAt).toLocaleDateString()}`].filter(Boolean).join(' · ');
    return el('div', { class: `me-row${p.removedAt ? ' is-archived' : ''}`, role: 'listitem', 'data-id': String(p.id) },
      el('span', { class: 'fb-what' }, el('span', { class: 'fb-title' }, p.name), el('span', { class: 'fb-meta' }, meta)),
      mayEdit ? el('span', { class: 'me-actions' },
        p.removedAt
          ? small('Put back', { onclick: () => change(p, { removed: false }, `${p.name} is back on the roster.`) })
          : [
            small('Edit', { onclick: () => edit(p) }),
            small('Remove', { onclick: () => removePerson(p) }),
          ]) : null);
  }

  async function change(p, patch, done) {
    try {
      await api(`/api/courses/${encodeURIComponent(pick.value)}/roster/${p.id}`, { method: 'PATCH', body: patch });
      say(done);
      await load();
    } catch (err) { say(err.message, true); }
  }

  async function removePerson(p) {
    const sure = await dialog(`Take ${p.name} off the roster?`, (card, done) => {
      card.append(el('p', { class: 'hint' }, 'Attendance already taken keeps them. They can be put back later (Show removed).'),
        el('div', { class: 'admin-actions' },
          el('button', { type: 'button', class: 'primary', onclick: () => done(true) }, 'Remove'),
          el('button', { type: 'button', onclick: () => done(null) }, 'Cancel')));
    });
    if (!sure) return;
    try {
      await api(`/api/courses/${encodeURIComponent(pick.value)}/roster/${p.id}`, { method: 'DELETE' });
      say(`${p.name} is off the roster.`);
      await load();
    } catch (err) { say(err.message, true); }
  }

  // Add or edit one person.
  function personForm(title, start, save) {
    return dialog(title, (card, done) => {
      const field = (label, key, attrs = {}) => el('label', {}, label, el('input', { type: 'text', value: start[key] || '', 'data-key': key, ...attrs }));
      const status = el('p', { class: 'hint is-bad', role: 'status' });
      const form = el('form', { class: 'me-password roster-form' },
        field('Name', 'name', { required: true, autocomplete: 'off' }),
        field('Student ID (optional)', 'studentId', { autocomplete: 'off' }),
        field('Email (optional)', 'email', { type: 'email', autocomplete: 'off' }),
        status,
        el('div', { class: 'admin-actions' },
          el('button', { type: 'submit', class: 'primary' }, 'Save'),
          el('button', { type: 'button', onclick: () => done(null) }, 'Cancel')));
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const body = Object.fromEntries([...form.querySelectorAll('input[data-key]')].map((i) => [i.dataset.key, i.value]));
        try { await save(body); done(true); } catch (err) { status.textContent = err.message; }
      });
      card.append(form);
    });
  }

  async function edit(p) {
    if (await personForm(`Edit ${p.name}`, p, (body) => api(`/api/courses/${encodeURIComponent(pick.value)}/roster/${p.id}`, { method: 'PATCH', body }))) {
      say('Saved.');
      await load();
    }
  }

  async function addPerson() {
    if (await personForm(`Add someone to ${COURSE(pick.value)}`, {}, (body) => api(`/api/courses/${encodeURIComponent(pick.value)}/roster`, { method: 'POST', body }))) {
      say('Added.');
      await load();
    }
  }

  // --- importing a CSV: preview, then apply ---------------------------------------

  async function importFile(file) {
    const text = await file.text();
    const code = pick.value;
    const url = (opts) => `/api/courses/${encodeURIComponent(code)}/roster/import?${new URLSearchParams(opts)}`;
    let replace = false;
    let preview;
    try { preview = await api(url({ replace: '0' }), { method: 'POST', raw: text }); } catch (err) { say(err.message, true); return; }
    const applied = await dialog(`Import ${file.name} into ${COURSE(code)}`, (card, done) => {
      const body = el('div', { class: 'roster-preview' });
      const draw = () => {
        const cols = preview.columns || {};
        const names = (arr) => arr.slice(0, 8).map((p) => p.name || p.after?.name).join(', ') + (arr.length > 8 ? `, and ${arr.length - 8} more` : '');
        body.replaceChildren(
          el('p', { class: 'hint' }, `Read the columns ${[cols.name && `name: “${cols.name}”`, cols.studentId && `student ID: “${cols.studentId}”`, cols.email && `email: “${cols.email}”`].filter(Boolean).join(', ') || '(none found)'}.`),
          el('ul', { class: 'roster-diff' },
            el('li', {}, el('strong', {}, `${preview.add.length} new`), preview.add.length ? ` — ${names(preview.add)}` : ''),
            el('li', {}, el('strong', {}, `${preview.change.length} updated`), preview.change.length ? ` — ${preview.change.slice(0, 8).map((c) => {
              const what = ['name', 'studentId', 'email'].filter((k) => c.before[k] !== c.after[k]).map((k) => ({ name: 'name', studentId: 'ID', email: 'email' })[k]);
              return `${c.after.name} (${what.join(', ')})`;
            }).join(', ')}${preview.change.length > 8 ? '…' : ''}` : ''),
            el('li', {}, el('strong', {}, `${preview.unchanged} unchanged`)),
            replace ? el('li', { class: preview.remove.length ? 'is-bad' : '' }, el('strong', {}, `${preview.remove.length} taken off`), preview.remove.length ? ` — ${names(preview.remove)}` : '') : null),
          preview.problems.length
            ? el('details', { class: 'help', open: preview.problems.length < 4 },
              el('summary', {}, `${preview.problems.length} line${preview.problems.length === 1 ? '' : 's'} could not be used`),
              el('ul', {}, ...preview.problems.slice(0, 20).map((p) => el('li', {}, `Line ${p.line}: ${p.message}`))))
            : null);
      };
      const replaceBox = el('input', {
        type: 'checkbox',
        onchange: async (ev) => {
          replace = ev.target.checked;
          try { preview = await api(url({ replace: replace ? '1' : '0' }), { method: 'POST', raw: text }); draw(); } catch (err) { say(err.message, true); }
        },
      });
      draw();
      card.classList.add('roster-import');
      card.append(body,
        el('label', { class: 'me-check' }, replaceBox, 'This is the whole class: take off anyone not in the file (they keep their past attendance)'),
        el('div', { class: 'admin-actions' },
          el('button', { type: 'button', class: 'primary', onclick: async (ev) => {
            ev.target.disabled = true;
            try { done(await api(url({ replace: replace ? '1' : '0', apply: '1' }), { method: 'POST', raw: text })); } catch (err) { say(err.message, true); done(null); }
          } }, 'Import'),
          el('button', { type: 'button', onclick: () => done(null) }, 'Cancel')));
    });
    if (!applied) return;
    say(`Imported: ${applied.added} added, ${applied.changed} updated, ${applied.unchanged} unchanged${applied.removed ? `, ${applied.removed} taken off` : ''}.`);
    await load();
  }

  pick.addEventListener('change', load);
  search.addEventListener('input', render);
  showRemoved.addEventListener('change', load);
  $('#roster-add').addEventListener('click', addPerson);
  $('#roster-import').addEventListener('click', () => $('#roster-file').click());
  $('#roster-file').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (file) importFile(file);
  });

  return {
    async open() { fillCourses(); await load(); },
  };
}
