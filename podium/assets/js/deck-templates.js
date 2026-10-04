// Deck templates in the deck editor (Issue #226).
//
// Slides and whole decks to start from, from three places, listed together:
//
//   built-in  files under content/deck-templates/, listed in its index.json -
//             there with or without a server, and read-only. An admin can
//             hide one for everyone on a server.
//   course    a course's own, kept on the server; its owners (and admins)
//             add, change and remove them, everyone in the course uses them.
//   mine      your own, kept on the server, seen by nobody else.
//
// A slide template goes in after the slide you are on; a deck template starts
// a new deck. Either can be saved from what is in the editor, and a template
// of your own (or your course's) opens in this same editor to be changed -
// see the `template` origin in deck-editor.js. The server side is
// server/deck-templates.js.

import { $, $$, el } from './util.js';
import { render as renderDeckSource, deckId, applyFits, applyPolyfill } from './deck.js';
import { parseDeck } from './deck-source.js';

const BUILT_IN_DIR = 'content/deck-templates/';

/** A template's key: `b:<id>` for a built-in, `s:<id>` for one on the server. */
export const templateKey = (t) => (t.scope === 'builtin' ? `b:${t.id}` : `s:${t.id}`);

/** The built-ins, with their markdown. Missing files are skipped, not fatal. */
async function loadBuiltIns() {
  try {
    const res = await fetch(`${BUILT_IN_DIR}index.json`, { cache: 'no-cache' });
    if (!res.ok) return [];
    const list = (await res.json()).templates || [];
    const loaded = await Promise.all(list.map(async (t) => {
      if (!/^[\w-]+$/.test(t.id || '') || !/^[\w.-]+\.md$/.test(t.file || '')) return null;
      try {
        const file = await fetch(`${BUILT_IN_DIR}${t.file}`, { cache: 'no-cache' });
        if (!file.ok) return null;
        return {
          id: t.id, scope: 'builtin', kind: t.kind === 'deck' ? 'deck' : 'slide', title: t.title || t.id,
          description: t.description || '', then: t.then || '', markdown: await file.text(), editable: false,
        };
      } catch { return null; }
    }));
    return loaded.filter(Boolean);
  } catch { return []; }
}

/**
 * Every template this person can use: the built-ins (less any an admin hid,
 * unless this is an admin), then the server's.
 * @param {{server: boolean, isAdmin: boolean}} who
 */
export async function loadTemplates({ server = false, isAdmin = false } = {}) {
  const [builtIns, fromServer] = await Promise.all([
    loadBuiltIns(),
    server
      ? fetch('/api/deck-templates', { credentials: 'same-origin', cache: 'no-cache' })
        .then((res) => (res.ok ? res.json() : { templates: [], hiddenBuiltIns: [] }))
        .catch(() => ({ templates: [], hiddenBuiltIns: [] }))
      : { templates: [], hiddenBuiltIns: [] },
  ]);
  const hidden = new Set(fromServer.hiddenBuiltIns || []);
  return [
    ...builtIns.map((t) => ({ ...t, hidden: hidden.has(t.id) })).filter((t) => isAdmin || !t.hidden),
    ...(fromServer.templates || []),
  ];
}

/** One template by key, for opening it in the editor. */
export async function findTemplate(key, who) {
  return (await loadTemplates(who)).find((t) => templateKey(t) === key) || null;
}

/** A template's markdown without its front matter: what goes into a deck as slides. */
export function slidesOf(markdown) {
  const deck = parseDeck(markdown);
  return deck.slides.map((s, i) => (i ? s.sep : '') + s.raw).join('').replace(/^\s*\n/, '');
}

async function api(path, method, body) {
  const res = await fetch(`/api/deck-templates${path}`, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(reply.error || `the server said HTTP ${res.status}`);
  return reply;
}

/**
 * The Templates dialog.
 *
 * @param {object} deps
 * @param {() => boolean} deps.server - signed in to a server that keeps templates
 * @param {() => boolean} deps.isAdmin
 * @param {() => {code: string, title: string, role: string}[]} deps.courses
 * @param {() => string} deps.deckCourse - the course the open deck is filed under
 * @param {() => object} deps.deck - the open deck, parsed (deck-source.js)
 * @param {() => number} deps.current - the slide the cursor is in
 * @param {() => string} deps.text - the open deck's markdown
 * @param {(slides: string, then: string) => void} deps.insertSlides - after the current slide
 * @param {(template: object) => void} deps.startDeck - a new deck from a deck template
 * @param {() => void} deps.done - the dialog closed
 */
export function createTemplatesPanel(deps) {
  const dialog = $('#deck-templates-dialog');
  const list = $('#deck-templates-list');
  const note = $('#deck-templates-note');
  let kind = 'slide';
  let templates = [];
  let armed = null;
  let drawing = 0;

  const who = () => ({ server: deps.server(), isAdmin: deps.isAdmin() });
  const ownedCourses = () => deps.courses().filter((c) => c.role === 'owner');

  function scopeLabel(t) {
    if (t.scope === 'builtin') return t.hidden ? 'Built-in · hidden' : 'Built-in';
    if (t.scope === 'course') return (t.course || '').toUpperCase();
    return 'Mine';
  }

  function scopeOptions(select, { placeholder = '' } = {}) {
    select.replaceChildren(
      ...(placeholder ? [el('option', { value: '' }, placeholder)] : []),
      el('option', { value: 'mine' }, 'Just me'),
      ...ownedCourses().map((c) => el('option', { value: `course:${c.code}` }, `Everyone in ${c.code.toUpperCase()}`)),
    );
  }

  async function refresh() {
    templates = await loadTemplates(who());
    draw();
  }

  function draw() {
    for (const tab of $$('[role="tab"]', dialog)) tab.setAttribute('aria-selected', String(tab.dataset.kind === kind));
    const shown = templates.filter((t) => t.kind === kind);
    $('#deck-templates-hint').textContent = kind === 'slide'
      ? `Goes in after slide ${deps.current() + 1}.`
      : 'Starts a new deck. The one open now is kept as a draft.';
    $('#deck-templates-save-heading').textContent = kind === 'slide'
      ? `Save slide ${deps.current() + 1} as a template` : 'Save this whole deck as a template';
    if (!$('#deck-templates-name').value || $('#deck-templates-name').dataset.auto === 'true') {
      const deck = deps.deck();
      const name = kind === 'slide' ? deck.slides[deps.current()]?.title : deck.frontMatter.fields.title || deck.slides[0]?.title;
      $('#deck-templates-name').value = name || '';
      $('#deck-templates-name').dataset.auto = 'true';
    }
    const online = deps.server();
    $('#deck-templates-save').hidden = !online;
    $('.deck-templates-offline', dialog).hidden = online;
    list.replaceChildren(...(shown.length ? shown.map(card) : [el('p', { class: 'hint' }, 'No templates of this kind yet.')]));
    drawThumbnails(shown);
  }

  function card(t) {
    const key = templateKey(t);
    const actions = [
      el('button', { type: 'button', class: 'primary', 'data-act': 'use' }, t.kind === 'slide' ? 'Add this slide' : 'Start a deck from it'),
    ];
    if (t.editable) {
      actions.push(
        el('button', { type: 'button', 'data-act': 'edit', title: 'Open it in the editor, in a new tab' }, 'Edit'),
        el('button', { type: 'button', 'data-act': 'rename' }, 'Rename'),
      );
    }
    if (deps.server()) {
      const copy = el('select', { 'data-act': 'copy', 'aria-label': `Copy “${t.title}” to…` });
      scopeOptions(copy, { placeholder: 'Copy to…' });
      actions.push(copy);
    }
    if (t.editable) actions.push(el('button', { type: 'button', 'data-act': 'delete', class: 'danger-ish' }, 'Delete'));
    if (t.scope === 'builtin' && deps.isAdmin() && deps.server()) {
      actions.push(el('button', { type: 'button', 'data-act': 'hide', title: 'For everyone on this server' }, t.hidden ? 'Show it again' : 'Hide it'));
    }
    return el('div', { class: `deck-template${t.hidden ? ' is-hidden' : ''}`, role: 'listitem', 'data-key': key },
      el('div', { class: 'deck-template-thumb', 'aria-hidden': 'true' }),
      el('div', { class: 'deck-template-text' },
        el('div', { class: 'deck-template-title' }, t.title, el('span', { class: `deck-template-badge is-${t.scope}` }, scopeLabel(t))),
        t.description ? el('p', { class: 'hint' }, t.description) : null,
        t.updatedBy && t.scope !== 'builtin' ? el('p', { class: 'hint' }, `Last changed by ${t.updatedBy}`) : null,
        el('div', { class: 'deck-template-acts' }, ...actions)));
  }

  // Each template's first slide, drawn the way it will look - a slide
  // template in the open deck's theme, since that is where it will go.
  // Marp's polyfill for each thumbnail (Issue #231), or WebKit draws only a
  // slide's top-left corner; let go when the thumbnails are drawn again.
  let polyfills = [];
  const dropPolyfills = () => { for (const p of polyfills) p?.cleanup?.(); polyfills = []; };

  async function drawThumbnails(shown) {
    const mine = ++drawing;
    dropPolyfills();
    const fm = deps.deck().frontMatter.raw;
    for (const t of shown) {
      if (mine !== drawing || dialog.hidden) return;
      const host = list.querySelector(`[data-key="${CSS.escape(templateKey(t))}"] .deck-template-thumb`);
      if (!host) continue;
      const source = t.kind === 'slide' ? `${fm || '---\nmarp: true\n---\n'}\n${slidesOf(t.markdown)}` : t.markdown;
      try {
        const id = `tpl:${await deckId(source)}`;
        const rendered = await renderDeckSource(source, id);
        if (mine !== drawing) return;
        const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `<style>
          :host { display: block; }
          .marpit { position: absolute; inset: 0; }
          .marpit svg { display: block; width: 100%; height: 100%; }
          .podium-fragment { opacity: 1 !important; }
        </style><style>${rendered.css}</style>${rendered.html}`;
        const svgs = shadow.querySelectorAll('svg[data-marpit-svg]');
        svgs.forEach((svg, i) => { if (i) svg.remove(); });
        applyFits(shadow, rendered.fits);
        const polyfill = await applyPolyfill(shadow);
        if (mine === drawing) polyfills.push(polyfill); else polyfill?.cleanup?.();
      } catch { /* a template Marp cannot draw just has no picture */ }
    }
  }

  async function act(ev) {
    const target = ev.target.closest('[data-act]');
    const row = ev.target.closest('.deck-template');
    if (!target || !row) return;
    const t = templates.find((x) => templateKey(x) === row.dataset.key);
    if (!t) return;
    const what = target.dataset.act;
    if (what === 'copy' && ev.type !== 'change') return;
    if (what !== 'copy' && ev.type !== 'click') return;
    note.textContent = '';
    try {
      if (what === 'use') {
        close();
        if (t.kind === 'slide') deps.insertSlides(slidesOf(t.markdown), t.then || '');
        else deps.startDeck(t);
      } else if (what === 'edit') {
        window.open(`deck.html?${new URLSearchParams({ template: templateKey(t) })}`, '_blank', 'noopener');
      } else if (what === 'rename') {
        const title = (prompt('A new name for this template:', t.title) || '').trim();
        if (!title || title === t.title) return;
        await api(`/${t.id}`, 'PUT', { title });
        note.textContent = `Renamed to “${title}”.`;
        await refresh();
      } else if (what === 'copy') {
        const to = target.value;
        target.value = '';
        if (!to) return;
        const [scope, course] = to.split(':');
        const made = (await api('', 'POST', { scope, course, kind: t.kind, title: t.title, markdown: t.markdown })).template;
        note.textContent = `Copied to ${scope === 'mine' ? 'your own templates' : course.toUpperCase()}${made.editable ? ', where you can change it' : ''}.`;
        await refresh();
      } else if (what === 'delete') {
        // Two taps, like every other irreversible button in Podium.
        if (armed !== row.dataset.key) {
          armed = row.dataset.key;
          target.textContent = 'Sure?';
          target.classList.add('armed');
          setTimeout(() => { if (armed === row.dataset.key) { armed = null; target.textContent = 'Delete'; target.classList.remove('armed'); } }, 4000);
          return;
        }
        armed = null;
        await api(`/${t.id}`, 'DELETE');
        note.textContent = `Deleted “${t.title}”.`;
        await refresh();
      } else if (what === 'hide') {
        await api(`/builtin/${encodeURIComponent(t.id)}`, 'PUT', { hidden: !t.hidden });
        note.textContent = t.hidden ? `“${t.title}” is back for everyone.` : `“${t.title}” is hidden for everyone but administrators.`;
        await refresh();
      }
    } catch (err) {
      note.textContent = `That did not work: ${err.message}`;
    }
  }

  async function saveCurrent() {
    const title = $('#deck-templates-name').value.trim();
    const to = $('#deck-templates-scope').value;
    if (!title) { note.textContent = 'Give the template a name first.'; $('#deck-templates-name').focus(); return; }
    const [scope, course] = to.split(':');
    const deck = deps.deck();
    const markdown = kind === 'slide'
      ? (deck.slides[deps.current()]?.raw || '').replace(/^\s*\n/, '')
      : deps.text();
    try {
      await api('', 'POST', { scope, course, kind, title, markdown });
      note.textContent = `Saved “${title}” for ${scope === 'mine' ? 'you' : `everyone in ${course.toUpperCase()}`}.`;
      $('#deck-templates-name').dataset.auto = 'true';
      await refresh();
    } catch (err) {
      note.textContent = `That did not save: ${err.message}`;
    }
  }

  function open({ kind: wanted = 'slide' } = {}) {
    kind = wanted;
    note.textContent = '';
    $('#deck-templates-name').value = '';
    $('#deck-templates-name').dataset.auto = 'true';
    scopeOptions($('#deck-templates-scope'));
    const course = (deps.deckCourse() || '').toLowerCase();
    if (ownedCourses().some((c) => c.code === course)) $('#deck-templates-scope').value = `course:${course}`;
    dialog.hidden = false;
    draw();
    refresh();
    $('[role="tab"][aria-selected="true"]', dialog)?.focus();
  }

  function close() {
    dialog.hidden = true;
    drawing++;
    dropPolyfills();
    deps.done();
  }

  $$('[role="tab"]', dialog).forEach((tab) => tab.addEventListener('click', () => { kind = tab.dataset.kind; $('#deck-templates-name').dataset.auto = 'true'; draw(); }));
  list.addEventListener('click', act);
  list.addEventListener('change', act);
  $('#deck-templates-name').addEventListener('input', (ev) => { ev.target.dataset.auto = 'false'; });
  $('#deck-templates-save-go').addEventListener('click', saveCurrent);
  $('#deck-templates-close').addEventListener('click', close);
  dialog.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } });

  return { open };
}
