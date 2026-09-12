// The planning page: what you do at your desk, not at the lectern.
//
// The controller is built for one-handed use in front of a class - big targets,
// nothing that needs two hands or a keyboard, no destructive action you could
// hit by accident. That makes it a poor place to BUILD a lecture, which wants
// typing, file pickers, reordering and second thoughts. So this page owns all
// of that, writes a plan file (planfile.js), and the controller only ever reads
// one. The one thing they share is the renderers: the preview here is the same
// code the projector runs, so "it looks right in my office" means something.

import { $, $$, el, uid, guessItemFromUrl, wireDangerButton, servedBuild } from './util.js';
import {
  PLAN_TYPES, emptyPlan, newItem, readPlan, planToJson, planFileName, planBytes,
  itemLabel, itemForStage, assetRef, assetIdOf, isAssetRef, pruneAssets, MAX_ASSET_CHARS, MAX_PLAN_BYTES,
} from './planfile.js';
import {
  allPlans, savePlan, loadPlan, removePlan,
  readFileText, downscaleImage, downloadText,
} from './store.js';
import { createRenderer } from './renderers.js';
import { render as renderDeckSource, frontMatterTitle } from './deck.js';
import { BUILD } from './protocol.js';

let plan = null;
let selectedId = null;
let saveTimer = null;
let preview = { renderer: null, key: null, slide: 0, step: 0, count: 0 };

const selected = () => plan?.items.find((i) => i.id === selectedId) || null;
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function warn(text) {
  const box = $('#plan-warn');
  box.textContent = text || '';
  box.hidden = !text;
}

// --- saving -----------------------------------------------------------------
//
// Autosaved on a debounce rather than behind a Save button: this page is a
// desk, and losing twenty minutes of prep to a closed tab is not a trade worth
// offering. The readout says which of the three states it is in, because
// "did that save?" is the question a silent autosave leaves you asking.

function touch({ now = false } = {}) {
  if (!plan) return;
  plan.updated = Date.now();
  $('#save-state').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(commit, now ? 0 : 400);
}

async function commit() {
  if (!plan) return;
  // Photos belonging to items you have since deleted or replaced are dropped
  // here rather than at export time, so they never take up room on disk either.
  // pruneAssets keeps the items and timers arrays themselves, so nothing
  // holding a reference to an item loses it.
  plan = pruneAssets(plan);
  try {
    await savePlan(plan);
    $('#save-state').textContent = `Saved ${new Date().toLocaleTimeString()}`;
    renderSize();
    renderPlanList();
  } catch (err) {
    $('#save-state').textContent = 'NOT saved';
    warn(`This lecture could not be saved: ${err.message}`);
  }
}

function renderSize() {
  const bytes = planBytes(plan);
  const over = bytes > MAX_PLAN_BYTES * 0.75;
  $('#plan-size').textContent = `Plan file will be about ${fmtBytes(bytes)}${over ? ' — getting large for a file you have to carry; consider pointing at videos on the server instead of embedding photos.' : ''}`;
  $('#plan-size').classList.toggle('is-warn', over);
}

// --- the list of lectures ----------------------------------------------------

async function renderPlanList() {
  const list = $('#plan-list');
  let rows = [];
  try { rows = await allPlans(); } catch (err) { warn(err.message); return; }
  list.replaceChildren(...rows.map((row) => {
    const button = el('button', {
      class: `plan-row${row.id === plan?.id ? ' is-on' : ''}`,
      type: 'button',
      onclick: () => openPlan(row.id),
    },
      el('span', { class: 'plan-row-title' }, row.title || 'Untitled lecture'),
      el('span', { class: 'plan-row-meta' },
        `${row.items?.length || 0} item${(row.items?.length || 0) === 1 ? '' : 's'}`
        + (row.course ? ` · ${row.course}` : '')
        + ` · ${new Date(row.updated || 0).toLocaleDateString()}`));
    return button;
  }));
  if (!rows.length) list.append(el('p', { class: 'empty' }, 'No lectures yet.'));
}

async function openPlan(id) {
  await commit();
  const found = await loadPlan(id);
  if (!found) return;
  plan = found;
  selectedId = plan.items[0]?.id || null;
  warn('');
  renderAll();
}

async function newPlan(seed = null) {
  await commit();
  plan = seed || emptyPlan();
  selectedId = plan.items[0]?.id || null;
  try { await savePlan(plan); } catch (err) { warn(`This lecture could not be saved: ${err.message}`); }
  renderAll();
}

// --- the running order -------------------------------------------------------

function renderOrder() {
  const list = $('#order');
  list.replaceChildren(...plan.items.map((item, index) => {
    const row = el('li', {
      class: `order-row${item.id === selectedId ? ' is-on' : ''}`,
      draggable: 'true',
      dataset: { id: item.id },
    },
      el('span', { class: 'order-n' }, String(index + 1)),
      el('button', { class: 'order-open', type: 'button', onclick: () => select(item.id) },
        el('span', { class: 'order-icon' }, PLAN_TYPES[item.type]?.icon || '?'),
        el('span', { class: 'order-title' }, itemLabel(item)),
        el('span', { class: 'order-type' }, PLAN_TYPES[item.type]?.label || item.type),
        item.note ? el('span', { class: 'order-note' }, item.note) : null),
      el('div', { class: 'order-tools' },
        el('button', { type: 'button', title: 'Move up', 'aria-label': 'Move up', disabled: index === 0, onclick: () => move(item.id, -1) }, '↑'),
        el('button', { type: 'button', title: 'Move down', 'aria-label': 'Move down', disabled: index === plan.items.length - 1, onclick: () => move(item.id, 1) }, '↓'),
        el('button', { type: 'button', title: 'Duplicate', 'aria-label': 'Duplicate', onclick: () => duplicate(item.id) }, '⧉'),
        el('button', { type: 'button', class: 'order-del', title: 'Remove', 'aria-label': 'Remove', onclick: () => remove(item.id) }, '×')));
    return row;
  }));
  $('#order-empty').hidden = plan.items.length > 0;
}

// Drag to reorder, delegated so it survives every re-render. Keyboard and
// touch users get the ↑/↓ buttons above, which do the same thing - dragging is
// the shortcut, never the only way.
let dragId = null;
$('#order').addEventListener('dragstart', (ev) => {
  const row = ev.target.closest('.order-row');
  if (!row) return;
  dragId = row.dataset.id;
  ev.dataTransfer.effectAllowed = 'move';
  // Firefox will not start a drag without data on the transfer.
  ev.dataTransfer.setData('text/plain', dragId);
  row.classList.add('is-dragging');
});
$('#order').addEventListener('dragend', () => {
  dragId = null;
  $$('.order-row').forEach((r) => r.classList.remove('is-dragging', 'is-over'));
});
$('#order').addEventListener('dragover', (ev) => {
  if (!dragId) return;
  ev.preventDefault();
  const row = ev.target.closest('.order-row');
  $$('.order-row').forEach((r) => r.classList.toggle('is-over', r === row && r.dataset.id !== dragId));
});
$('#order').addEventListener('drop', (ev) => {
  if (!dragId) return;
  ev.preventDefault();
  const row = ev.target.closest('.order-row');
  if (!row || row.dataset.id === dragId) return;
  const from = plan.items.findIndex((i) => i.id === dragId);
  const to = plan.items.findIndex((i) => i.id === row.dataset.id);
  if (from < 0 || to < 0) return;
  plan.items.splice(to, 0, plan.items.splice(from, 1)[0]);
  touch();
  renderOrder();
});

function select(id) {
  selectedId = id;
  preview.slide = 0;
  preview.step = 0;
  renderOrder();
  renderEditor();
}

function move(id, delta) {
  const from = plan.items.findIndex((i) => i.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= plan.items.length) return;
  plan.items.splice(to, 0, plan.items.splice(from, 1)[0]);
  touch();
  renderOrder();
}

function duplicate(id) {
  const index = plan.items.findIndex((i) => i.id === id);
  if (index < 0) return;
  // A deep copy, so editing the duplicate cannot reach back into the original.
  // The asset table is shared on purpose: two rows showing the same photo
  // should not double the size of the file you carry.
  const copy = { ...structuredClone(plan.items[index]), id: uid(8) };
  plan.items.splice(index + 1, 0, copy);
  touch();
  select(copy.id);
}

function remove(id) {
  const index = plan.items.findIndex((i) => i.id === id);
  if (index < 0) return;
  plan.items.splice(index, 1);
  if (selectedId === id) selectedId = plan.items[Math.min(index, plan.items.length - 1)]?.id || null;
  touch();
  renderOrder();
  renderEditor();
}

function renderTypePicker() {
  $('#type-picker').replaceChildren(...Object.entries(PLAN_TYPES).map(([type, spec]) => el('button', {
    class: 'type-btn', type: 'button', title: spec.blurb,
    onclick: () => {
      const item = newItem(type);
      const at = plan.items.findIndex((i) => i.id === selectedId);
      // Inserted after whatever is selected: you build a lecture by working
      // down it, and appending to the end means dragging it back every time.
      plan.items.splice(at < 0 ? plan.items.length : at + 1, 0, item);
      touch();
      select(item.id);
    },
  }, el('span', { class: 'type-icon' }, spec.icon), el('span', {}, spec.label))));
}

// --- timers ------------------------------------------------------------------

function renderTimers() {
  $('#timers').replaceChildren(...plan.timers.map((timer) => el('li', { class: 'timer-row' },
    el('span', { class: 'grow' }, `${timer.label || 'Countdown'} · ${timer.mins}m`),
    el('button', {
      type: 'button', 'aria-label': `Remove ${timer.label || 'countdown'}`,
      onclick: () => { plan.timers = plan.timers.filter((t) => t.id !== timer.id); touch(); renderTimers(); },
    }, '×'))));
  if (!plan.timers.length) $('#timers').append(el('li', { class: 'empty' }, 'None saved — the iPad will show 1/2/5/10/15.'));
}

// --- the editor --------------------------------------------------------------
//
// Generated from PLAN_TYPES rather than written out per type, so a new field is
// a one-line change in one file and cannot drift out of step with what a plan
// is allowed to contain.

function renderEditor() {
  const item = selected();
  const fields = $('#item-fields');
  fields.replaceChildren();
  if (!item) {
    $('#item-heading').textContent = 'Nothing selected';
    $('#item-blurb').textContent = 'Pick something from the running order, or add one.';
    $('#item-preview-wrap').hidden = true;
    teardownPreview();
    return;
  }
  const spec = PLAN_TYPES[item.type];
  $('#item-heading').textContent = spec.label;
  $('#item-blurb').textContent = spec.blurb;

  fields.append(field('Title on the iPad', el('input', {
    type: 'text', value: item.title || '', placeholder: itemLabel(item),
    oninput: (ev) => { item.title = ev.target.value; afterEdit({ label: true }); },
  }), 'Optional. Left blank, the iPad labels it from its contents.'));

  for (const spec2 of spec.fields) fields.append(fieldFor(item, spec2));

  fields.append(field('Note to yourself', el('textarea', {
    rows: '2', placeholder: 'Shown under this item on the iPad.',
    oninput: (ev) => { item.note = ev.target.value; afterEdit({ label: true }); },
  }, item.note || ''), 'Appears on the tile during class — “ask about the confound”, “only 3 minutes”.'));

  renderPreview({ remount: true });
}

function field(label, control, hint) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    control,
    hint ? el('p', { class: 'hint' }, hint) : null);
}

function fieldFor(item, spec) {
  const set = (value, opts) => { item[spec.key] = value; afterEdit(opts); };

  if (spec.kind === 'select') {
    return field(spec.label, el('select', { onchange: (ev) => set(ev.target.value, { remount: true }) },
      ...spec.options.map(([value, label]) => el('option', { value, selected: (item[spec.key] ?? spec.def) === value }, label))), spec.hint);
  }
  if (spec.kind === 'check') {
    return field(spec.label, el('input', {
      type: 'checkbox', checked: !!item[spec.key],
      onchange: (ev) => set(ev.target.checked, { remount: true }),
    }), spec.hint);
  }
  if (spec.kind === 'number') {
    return field(spec.label, el('input', {
      type: 'number', min: String(spec.min ?? 0), max: String(spec.max ?? 9999), value: String(item[spec.key] ?? spec.def ?? 0),
      oninput: (ev) => set(Number(ev.target.value), { label: true }),
    }), spec.hint);
  }
  if (spec.kind === 'textarea') {
    return field(spec.label, el('textarea', {
      rows: '5', placeholder: spec.placeholder || '',
      oninput: (ev) => set(ev.target.value, { label: true }),
    }, item[spec.key] || ''), spec.hint);
  }
  if (spec.kind === 'color') {
    const swatch = el('input', {
      type: 'color', value: item[spec.key] || '#ffffff',
      oninput: (ev) => set(ev.target.value, { remount: true }),
    });
    return field(spec.label, el('div', { class: 'inline' }, swatch,
      el('button', { type: 'button', onclick: () => { set('', { remount: true }); swatch.value = '#ffffff'; } }, 'Default')), spec.hint);
  }
  if (spec.kind === 'upload') return uploadField(item, spec);
  if (spec.kind === 'image') return imageField(item, spec);

  // Plain text, with one special case: a pasted YouTube URL is unpacked into
  // the id and start time rather than left for you to dig out by hand.
  const input = el('input', {
    type: 'text', value: item[spec.key] || '', placeholder: spec.placeholder || '',
    oninput: (ev) => {
      let value = ev.target.value;
      if (spec.key === 'videoId') {
        const guess = guessItemFromUrl(value);
        if (guess?.type === 'youtube') {
          value = guess.videoId;
          item.startAt = guess.startAt || 0;
          ev.target.value = value;
          renderEditor();
          return;
        }
      }
      set(value, { remount: true, label: true });
    },
  });
  return field(spec.label, input, spec.hint);
}

function uploadField(item, spec) {
  const note = el('p', { class: 'hint' });
  const current = item[spec.key] ? plan.assets[item[spec.key]] : null;
  note.textContent = current ? `Holding ${current.name} (${fmtBytes(current.data.length)}).` : (spec.hint || '');
  const input = el('input', {
    type: 'file', accept: spec.accept || '',
    onchange: async (ev) => {
      const file = ev.target.files?.[0];
      ev.target.value = '';
      if (!file) return;
      note.textContent = `Reading ${file.name}…`;
      try {
        const text = await readFileText(file);
        const id = uid(10);
        plan.assets[id] = { name: file.name, mime: file.type || 'text/markdown', data: text };
        item[spec.key] = id;
        item.src = '';
        // A deck names itself in its front matter; use that rather than making
        // you retype it, and only when you have not titled it yourself.
        if (!item.title) item.title = frontMatterTitle(text, file.name.replace(/\.[^.]+$/, ''));
        touch();
        renderOrder();
        renderEditor();
      } catch (err) {
        note.textContent = `Could not read that file: ${err.message}`;
      }
    },
  });
  return field(spec.label, el('div', {}, input, note));
}

function imageField(item, spec) {
  const note = el('p', { class: 'hint' });
  const thumb = el('div', { class: 'thumb' });
  const showCurrent = () => {
    const value = item[spec.key] || '';
    const id = assetIdOf(value);
    const asset = id ? plan.assets[id] : null;
    thumb.replaceChildren(value ? el('img', { src: asset ? asset.data : value, alt: '' }) : el('span', { class: 'hint' }, 'No photo yet'));
    note.textContent = asset
      ? `${asset.name} — ${fmtBytes(asset.data.length)} after resizing for the relay.`
      : (value ? 'Loaded from the server at lecture time; make sure it is deployed.' : 'Upload a photo, or type a path already on your server.');
  };
  const input = el('input', {
    type: 'file', accept: 'image/*',
    onchange: async (ev) => {
      const file = ev.target.files?.[0];
      ev.target.value = '';
      if (!file) return;
      note.textContent = `Resizing ${file.name}…`;
      try {
        const shrunk = await downscaleImage(file, MAX_ASSET_CHARS);
        const id = uid(10);
        plan.assets[id] = { name: file.name, mime: 'image/jpeg', data: shrunk.dataUrl };
        item[spec.key] = assetRef(id);
        if (!item.title) item.title = file.name.replace(/\.[^.]+$/, '');
        touch();
        renderOrder();
        renderEditor();
        if (shrunk.tooBig) {
          warn(`“${file.name}” is still ${fmtBytes(shrunk.dataUrl.length)} after resizing, which is more than a relay message can carry — it may not reach the projector. Crop it, or put it on the server and use a path instead.`);
        }
      } catch (err) {
        note.textContent = `That did not load: ${err.message}`;
      }
    },
  });
  const path = el('input', {
    type: 'text', placeholder: 'content/img/stroop.png',
    value: isAssetRef(item[spec.key]) ? '' : (item[spec.key] || ''),
    oninput: (ev) => { item[spec.key] = ev.target.value; showCurrent(); afterEdit({ remount: true, label: true }); },
  });
  showCurrent();
  return field(spec.label, el('div', {}, thumb, input, note,
    el('label', { class: 'sub-label' }, 'or a path on the server'), path));
}

// A keystroke must not rebuild the editor - that would take the caret with it.
// So an edit updates only what an edit can change: the row's label, the preview,
// and the save state.
function afterEdit({ remount = false, label = false } = {}) {
  touch();
  if (label) renderOrder();
  renderPreview({ remount });
}

// --- preview -----------------------------------------------------------------
//
// The projector's own renderers, in a 16:9 box. Not a mock-up: if a web page
// refuses to be framed, or a theme fails to load, it fails here - in your
// office, with time to fix it.

function teardownPreview() {
  preview.renderer?.destroy();
  preview.renderer = null;
  preview.key = null;
  $('#item-preview').replaceChildren();
}

function previewDeckSource(item) {
  if (item.asset) return plan.assets[item.asset]?.data ?? null;
  if (item.src) {
    return fetch(item.src, { cache: 'no-cache' }).then((res) => {
      if (!res.ok) throw new Error(`${item.src} — HTTP ${res.status}`);
      return res.text();
    });
  }
  return null;
}

// What the projector will be handed, with asset references resolved to the
// bytes this page is holding.
function forPreview(item) {
  const staged = itemForStage(item);
  if (item.type === 'deck') {
    return { ...staged, deckId: item.asset ? `asset:${item.asset}` : `src:${item.src}`, slide: preview.slide, step: preview.step };
  }
  if (item.type === 'timer') return { ...staged, label: item.label || '' };
  const id = assetIdOf(staged.src);
  if (id) return { ...staged, src: plan.assets[id]?.data || '' };
  return staged;
}

function renderPreview({ remount = false } = {}) {
  const item = selected();
  $('#item-preview-wrap').hidden = !item;
  if (!item) { teardownPreview(); return; }

  const forRender = forPreview(item);
  // Remount only when the thing being rendered actually changes identity:
  // retyping a text sign should not tear down and rebuild its renderer on
  // every letter, and re-fetching a deck per keystroke would be worse.
  const key = `${item.type}:${forRender.src || forRender.deckId || ''}:${item.bg || ''}`;
  if (remount || key !== preview.key) {
    teardownPreview();
    preview.key = key;
    preview.renderer = createRenderer(forRender, {
      preview: true,
      getDeckSource: previewDeckSource,
      // A plausible countdown, so the preview shows the size of the digits
      // rather than a permanent 0:00.
      getTimer: () => ({ running: false, remainingMs: (item.mins || 5) * 60000, endsAt: 0, label: item.label || '' }),
    });
    $('#item-preview').append(preview.renderer.el);
  } else {
    preview.renderer.update(forRender);
  }

  const isDeck = item.type === 'deck';
  $('#deck-nav').hidden = !isDeck;
  if (isDeck) countDeck(item);
}

// Only so the slide stepper can say "3 of 14" and stop at the end; the renderer
// clamps regardless.
async function countDeck(item) {
  const where = $('#deck-where');
  try {
    const source = await previewDeckSource(item);
    if (source == null) { where.textContent = 'No slides yet'; preview.count = 0; return; }
    const deck = await renderDeckSource(source, `count:${item.asset || item.src}`);
    preview.count = deck.count;
    where.textContent = `Slide ${Math.min(preview.slide + 1, deck.count)} of ${deck.count}`;
  } catch (err) {
    preview.count = 0;
    where.textContent = `Could not read that deck: ${err.message}`;
  }
}

$('#deck-prev').addEventListener('click', () => { preview.slide = Math.max(0, preview.slide - 1); renderPreview(); });
$('#deck-next').addEventListener('click', () => {
  preview.slide = preview.count ? Math.min(preview.count - 1, preview.slide + 1) : preview.slide + 1;
  renderPreview();
});

// --- plan-level fields -------------------------------------------------------

function renderHeader() {
  $('#plan-title').value = plan.title || '';
  $('#plan-course').value = plan.course || '';
  $('#plan-notes').value = plan.notes || '';
  $$('#plan-layout .layout-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.layout === plan.layout));
}

$('#plan-title').addEventListener('input', (ev) => { plan.title = ev.target.value; touch(); renderPlanList(); });
$('#plan-course').addEventListener('input', (ev) => { plan.course = ev.target.value; touch(); });
$('#plan-notes').addEventListener('input', (ev) => { plan.notes = ev.target.value; touch(); });
$('#plan-layout').addEventListener('click', (ev) => {
  const button = ev.target.closest('.layout-btn');
  if (!button) return;
  plan.layout = button.dataset.layout;
  touch();
  renderHeader();
});

$('#timer-add').addEventListener('click', () => {
  const mins = Number($('#timer-new-mins').value);
  if (!Number.isFinite(mins) || mins < 1) return;
  plan.timers.push({ id: uid(6), label: $('#timer-new-label').value.trim(), mins: Math.min(180, Math.round(mins)) });
  $('#timer-new-label').value = '';
  touch();
  renderTimers();
});

// --- files in and out --------------------------------------------------------

$('#plan-export').addEventListener('click', async () => {
  await commit();
  downloadText(planFileName(plan), planToJson(plan));
  $('#save-state').textContent = `Plan file written · ${new Date().toLocaleTimeString()}`;
});

$('#plan-import').addEventListener('click', () => $('#plan-import-file').click());
$('#plan-import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const { plan: loaded, warnings } = readPlan(await readFileText(file));
    await newPlan(loaded);
    warn(warnings.length ? `Opened with ${warnings.length} problem${warnings.length === 1 ? '' : 's'}: ${warnings.join(' ')}` : '');
  } catch (err) {
    warn(`That file did not open: ${err.message}`);
  }
});

$('#plan-new').addEventListener('click', () => newPlan());

$('#plan-duplicate').addEventListener('click', async () => {
  const copy = structuredClone(plan);
  copy.id = uid(10);
  copy.title = `${plan.title} (copy)`;
  copy.created = Date.now();
  await newPlan(copy);
});

// wireDangerButton leaves the button disabled after the action, which is right
// for the settings reset it was written for (that reloads the page) and wrong
// here: deleting one lecture must not lock the button for the next one.
let deleteButton;
deleteButton = wireDangerButton($('#plan-delete'), 'Delete this lecture', async () => {
  const doomed = plan.id;
  const rows = (await allPlans()).filter((r) => r.id !== doomed);
  plan = null;                       // so commit() cannot write it back
  await removePlan(doomed);
  if (rows.length) await openPlan(rows[0].id);
  else await newPlan();
  $('#plan-delete').disabled = false;
  deleteButton.disarm();
}, { armedLabel: 'Tap again to delete' });

// --- boot --------------------------------------------------------------------

function renderAll() {
  renderHeader();
  renderOrder();
  renderTimers();
  renderEditor();
  renderSize();
  renderPlanList();
}

renderTypePicker();
$('#plan-build').textContent = `Build ${BUILD}`;
servedBuild().then((served) => {
  if (served === null || served === BUILD) return;
  $('#plan-build').textContent = `Build ${BUILD}, but the server has ${served} — this page came from a cache. Reload it.`;
  $('#plan-build').classList.add('is-stale');
});

// Nothing here needs a relay, a room or a passphrase: planning is offline work,
// and a plan is a file. So there is no connection to wait for and no reason for
// this page to fail when the network does.
try {
  const rows = await allPlans();
  if (rows.length) { plan = rows[0]; selectedId = plan.items[0]?.id || null; }
  else plan = emptyPlan();
  renderAll();
  if (!rows.length) await savePlan(plan);
} catch (err) {
  warn(`Plans cannot be stored in this browser: ${err.message} You can still build one and save it to a file, but it will not be here when you come back.`);
  plan = emptyPlan();
  renderAll();
}

// A tab being closed or backgrounded must not take the last few seconds of
// typing with it. visibilitychange is the one that actually fires reliably on
// iOS and on a phone being locked; beforeunload covers the desktop close.
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) commit(); });
window.addEventListener('beforeunload', () => { if (saveTimer) commit(); });
