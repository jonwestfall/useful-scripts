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
  itemLabel, itemForStage, assetRef, assetIdOf, isAssetRef, pruneAssets, emptyAutoLaunch, emptyPip,
  MAX_ASSET_CHARS, MAX_PLAN_BYTES,
} from './planfile.js';
import {
  allPlans, savePlan, loadPlan, removePlan,
  readFileText, downscaleImage, downloadText,
} from './store.js';
import { createRenderer } from './renderers.js';
import { render as renderDeckSource, frontMatterTitle } from './deck.js';
import { BUILD, VERSION, COMMIT, versionStamp, MAX_TIMERS, LAYOUTS } from './protocol.js';
import { mountSessionBadge, serverInfo } from './server.js';

mountSessionBadge($('#session-badge'));

let plan = null;
let selectedId = null;
// Issue #108: whether serverUploadField() below has anything to upload to -
// set once serverInfo() resolves.
let serverLibraryUpload = false;
let saveTimer = null;
let preview = { renderer: null, key: null, slide: 0, step: 0, count: 0 };
// The server row this in-memory plan maps to, if any - set after pulling one
// from the server or pushing one there, cleared by anything that swaps the
// plan out for a different one (a new lecture, a different local lecture, an
// imported file, a duplicate). What "Update the copy already there" acts on.
let currentServerPlanId = null;

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
  let rows;
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
  setCurrentServerPlanId(null);
  warn('');
  renderAll();
}

async function newPlan(seed = null) {
  await commit();
  plan = seed || emptyPlan();
  selectedId = plan.items[0]?.id || null;
  setCurrentServerPlanId(null);
  try { await savePlan(plan); } catch (err) { warn(`This lecture could not be saved: ${err.message}`); }
  renderAll();
}

// --- the running order & pacing ----------------------------------------------

function fmtTimelineTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function renderPacing() {
  const totalPlanned = plan.items.reduce((sum, item) => sum + (Number(item.durationMins) || 0), 0);
  const target = Number(plan.targetDuration) || 50;
  const isOver = totalPlanned > target;
  const diff = Math.abs(totalPlanned - target);

  let statusText;
  if (totalPlanned === 0) {
    statusText = `<b>0 min</b> planned · target:`;
  } else if (isOver) {
    statusText = `<b>${totalPlanned} min</b> planned · <span class="pacing-over">${diff}m over budget!</span>`;
  } else if (totalPlanned === target) {
    statusText = `<b>${totalPlanned} min</b> planned · <span class="pacing-ok">exact match</span>`;
  } else {
    statusText = `<b>${totalPlanned} min</b> planned · <span class="pacing-under">${diff}m remaining</span>`;
  }

  const summary = $('#plan-pacing-summary');
  if (summary) summary.innerHTML = statusText;
  const bar = $('#plan-pacing-bar');
  if (bar) {
    bar.style.width = `${Math.min(100, target > 0 ? (totalPlanned / target) * 100 : 0)}%`;
    bar.classList.toggle('is-over', isOver);
    bar.classList.toggle('is-exact', totalPlanned === target && totalPlanned > 0);
  }
}

function renderOrder() {
  const list = $('#order');
  let accumulatedMins = 0;
  list.replaceChildren(...plan.items.map((item, index) => {
    const dur = Number(item.durationMins) || 0;
    const startMins = accumulatedMins;
    accumulatedMins += dur;
    const endMins = accumulatedMins;

    const timeLabel = dur > 0
      ? `${fmtTimelineTime(startMins)} - ${fmtTimelineTime(endMins)} (${dur}m)`
      : (accumulatedMins > 0 ? `${fmtTimelineTime(startMins)}` : '');

    const row = el('li', {
      class: `order-row${item.id === selectedId ? ' is-on' : ''}`,
      draggable: 'true',
      dataset: { id: item.id },
    },
      el('span', { class: 'order-n' }, String(index + 1)),
      el('button', { class: 'order-open', type: 'button', onclick: () => select(item.id) },
        el('span', { class: 'order-icon' }, PLAN_TYPES[item.type]?.icon || '?'),
        el('span', { class: 'order-title' }, itemLabel(item, plan)),
        el('span', { class: 'order-type' }, PLAN_TYPES[item.type]?.label || item.type),
        timeLabel ? el('span', { class: 'order-time' }, timeLabel) : null,
        item.note ? el('span', { class: 'order-note' }, item.note) : null),
      el('div', { class: 'order-tools' },
        el('button', { type: 'button', title: 'Move up', 'aria-label': 'Move up', disabled: index === 0, onclick: () => move(item.id, -1) }, '↑'),
        el('button', { type: 'button', title: 'Move down', 'aria-label': 'Move down', disabled: index === plan.items.length - 1, onclick: () => move(item.id, 1) }, '↓'),
        el('button', { type: 'button', title: 'Duplicate', 'aria-label': 'Duplicate', onclick: () => duplicate(item.id) }, '⧉'),
        el('button', { type: 'button', class: 'order-del', title: 'Remove', 'aria-label': 'Remove', onclick: () => remove(item.id) }, '×')));
    return row;
  }));
  $('#order-empty').hidden = plan.items.length > 0;
  renderPacing();
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
  renderAutoLaunch();
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
  renderAutoLaunch();
}

function remove(id) {
  const index = plan.items.findIndex((i) => i.id === id);
  if (index < 0) return;
  plan.items.splice(index, 1);
  if (selectedId === id) selectedId = plan.items[Math.min(index, plan.items.length - 1)]?.id || null;
  pruneAutoLaunchItem(id);
  touch();
  renderOrder();
  renderEditor();
  renderAutoLaunch();
}

function renderTypePicker() {
  $('#type-picker').replaceChildren(...Object.entries(PLAN_TYPES).map(([type, spec]) => el('button', {
    class: 'type-btn', type: 'button', title: spec.blurb,
    onclick: () => {
      const item = newItem(type);
      // A countdown names one of the lecture's timers, so adding the first one
      // has to bring a timer with it or the item is inert and the reason is
      // two screens away.
      if (type === 'timer') {
        if (!plan.timers.length) plan.timers.push({ id: uid(6), label: 'Countdown', mins: 5 });
        item.timerId = plan.timers[0].id;
      }
      const at = plan.items.findIndex((i) => i.id === selectedId);
      // Inserted after whatever is selected: you build a lecture by working
      // down it, and appending to the end means dragging it back every time.
      plan.items.splice(at < 0 ? plan.items.length : at + 1, 0, item);
      touch();
      select(item.id);
      renderAutoLaunch();
    },
  }, el('span', { class: 'type-icon' }, spec.icon), el('span', {}, spec.label))));
}

// --- timers ------------------------------------------------------------------

function renderTimers() {
  $('#timers').replaceChildren(...plan.timers.map((timer) => el('li', { class: 'timer-row' },
    el('span', { class: 'grow' }, `${timer.label || 'Countdown'} · ${timer.mins}m`),
    el('button', {
      type: 'button', 'aria-label': `Remove ${timer.label || 'countdown'}`,
      onclick: () => {
        plan.timers = plan.timers.filter((t) => t.id !== timer.id);
        pruneAutoLaunchTimer(timer.id);
        touch();
        renderTimers();
        renderOrder();
        renderEditor();
        renderAutoLaunch();
      },
    }, '×'))));
  if (!plan.timers.length) $('#timers').append(el('li', { class: 'empty' }, 'None yet — the iPad will show one unnamed countdown and the 1/2/5/10/15 buttons.'));
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
    type: 'text', value: item.title || '', placeholder: itemLabel(item, plan),
    oninput: (ev) => { item.title = ev.target.value; afterEdit({ label: true }); },
  }), 'Optional. Left blank, the iPad labels it from its contents.'));

  for (const spec2 of spec.fields) fields.append(fieldFor(item, spec2));

  fields.append(field('Planned duration', el('div', { class: 'inline', style: 'align-items: center;' },
    el('input', {
      type: 'number', min: '0', max: '360', step: '1',
      id: 'item-duration',
      style: 'width: 100px;',
      value: item.durationMins || '',
      placeholder: '0',
      oninput: (ev) => {
        const val = Math.max(0, Math.min(360, Math.round(Number(ev.target.value)) || 0));
        item.durationMins = val;
        afterEdit({ label: true });
      },
    }),
    el('span', { class: 'hint', style: 'margin: 0;' }, 'minutes (for pacing budget)')),
  'Optional. Helps you budget and pace your lecture.'));

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
  if (spec.hidden) return '';
  const set = (value, opts) => { item[spec.key] = value; afterEdit(opts); };

  if (spec.kind === 'poll-options') {
    const rawOptions = (item[spec.key] || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const options = rawOptions.length ? rawOptions : ['', ''];
    
    let correctIdx = item.correct ?? -1;
    const container = el('div', { class: 'stack' });
    
    const renderRows = () => {
      container.replaceChildren(...options.map((opt, i) => {
        const letter = String.fromCharCode(65 + i);
        const isCorrect = correctIdx === i;
        
        return el('div', { class: 'poll-option-row' },
          el('button', {
            type: 'button',
            class: `poll-chip ${isCorrect ? 'is-correct' : ''}`,
            title: isCorrect ? 'Marked as correct' : 'Mark as correct',
            onclick: () => {
              item.correct = isCorrect ? -1 : i;
              correctIdx = item.correct;
              afterEdit({ remount: true });
              renderRows();
            },
          }, letter),
          el('input', {
            type: 'text', placeholder: `Option ${i + 1}`, value: opt,
            oninput: (ev) => {
              options[i] = ev.target.value;
              set(options.join('\n'), { remount: true });
            },
          }),
          el('button', {
            type: 'button', title: 'Remove', disabled: options.length <= 1,
            onclick: () => {
              options.splice(i, 1);
              if (correctIdx === i) correctIdx = -1;
              else if (correctIdx > i) correctIdx--;
              item.correct = correctIdx;
              set(options.join('\n'), { remount: true });
              renderRows();
            },
          }, '×')
        );
      }));
    };
    renderRows();
    const addBtn = el('div', { class: 'inline', style: 'margin-top: 4px;' },
      el('button', { type: 'button', onclick: () => { options.push(''); renderRows(); } }, '+ Option')
    );
    return field(spec.label, el('div', { class: 'stack' }, container, addBtn), spec.hint);
  }

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
  if (spec.kind === 'timer-pick') {
    if (!plan.timers.length) {
      return field(spec.label, el('p', { class: 'hint stale-note' },
        'This lecture has no countdowns yet. Add one under Timers, below the running order.'));
    }
    return field(spec.label, el('select', { onchange: (ev) => set(ev.target.value, { remount: true, label: true }) },
      ...plan.timers.map((timer, i) => el('option', {
        value: timer.id,
        selected: (item.timerId || plan.timers[0].id) === timer.id,
      }, `${timer.label || `Timer ${i + 1}`} · ${timer.mins}m`))), spec.hint);
  }
  if (spec.kind === 'upload') return uploadField(item, spec);
  if (spec.kind === 'server-upload') return serverUploadField(item, spec);
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

// Issue #108: uploads a real file to this server's library - the same
// endpoint admin.html and the controller's own PDF upload use - rather than
// embedding it as a plan asset the way uploadField() does. A PDF handout or
// a video clip can be far bigger than the ~160KB a plan asset has to survive
// traveling over the relay in one message; this instead gets a served URL
// (item.src becomes a plain path, same as typing one by hand) and needs no
// budget at all. Only rendered once serverLibraryUpload confirms this Podium
// actually has a server with a library to upload to.
function serverUploadField(item, spec) {
  if (!serverLibraryUpload) return '';
  const note = el('p', { class: 'hint' }, spec.hint || '');
  const input = el('input', {
    type: 'file', accept: spec.accept || '',
    onchange: async (ev) => {
      const file = ev.target.files?.[0];
      ev.target.value = '';
      if (!file) return;
      note.textContent = `Uploading ${file.name}…`;
      try {
        const params = new URLSearchParams({
          filename: file.name, title: item.title || file.name.replace(/\.[^.]+$/, ''), course: '', group: '',
        });
        const res = await fetch(`/api/library/upload?${params}`, { method: 'POST', credentials: 'same-origin', body: file });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'that did not work');
        item[spec.key] = body.item.src;
        if (!item.title) item.title = body.item.title;
        touch();
        renderOrder();
        renderEditor();
      } catch (err) {
        note.textContent = `That did not upload: ${err.message}`;
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
  if (item.type === 'timer') return { ...staged, timerId: item.timerId || plan.timers[0]?.id || '', label: item.label || '' };
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
      // A plausible countdown, so the preview shows the size of the digits
      // rather than a permanent 0:00. Reads the timer the item points at.
      getTimer: (id) => {
        const timer = plan.timers.find((t) => t.id === (id || item.timerId)) || plan.timers[0] || null;
        return { running: false, remainingMs: (timer?.mins || 5) * 60000, endsAt: 0, label: timer?.label || item.label || '' };
      },
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
  renderTemplateControls();
  $('#plan-notes').value = plan.notes || '';
  const targetSelect = $('#plan-target-mins');
  if (targetSelect) targetSelect.value = String(plan.targetDuration || 50);
  $$('#plan-layout .layout-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.layout === plan.layout));
  renderPlanPip();
}

// Issue #131: which two panes a picture-in-picture plan starts with, and where
// the inset sits. A plan saved before this existed has no pip yet.
function renderPlanPip() {
  const box = $('#plan-pip');
  box.hidden = plan.layout !== 'pip';
  if (box.hidden) return;
  if (!plan.pip) plan.pip = emptyPip();
  const letters = ['A', 'B', 'C', 'D'];
  $('#plan-pip-main').replaceChildren(...letters.map((l) => el('option', { value: l, selected: l === plan.pip.main }, `Pane ${l}`)));
  $('#plan-pip-inset').replaceChildren(...letters.filter((l) => l !== plan.pip.main)
    .map((l) => el('option', { value: l, selected: l === plan.pip.inset }, `Pane ${l}`)));
  $('#plan-pip-corner').value = plan.pip.corner;
  $('#plan-pip-size').value = String(plan.pip.size);
  $('#plan-pip-size-label').textContent = `${plan.pip.size}%`;
}

const setPlanPip = (change) => {
  if (!plan.pip) plan.pip = emptyPip();
  // Picking the pane already on the other side swaps the two - the same rule
  // the controller's own PiP panel follows.
  if (change.main && change.main === plan.pip.inset) plan.pip.inset = plan.pip.main;
  Object.assign(plan.pip, change);
  touch();
  renderPlanPip();
};
$('#plan-pip-main').addEventListener('change', (ev) => setPlanPip({ main: ev.target.value }));
$('#plan-pip-inset').addEventListener('change', (ev) => setPlanPip({ inset: ev.target.value }));
$('#plan-pip-corner').addEventListener('change', (ev) => setPlanPip({ corner: ev.target.value }));
$('#plan-pip-size').addEventListener('input', (ev) => setPlanPip({ size: Number(ev.target.value) }));

$('#plan-target-mins')?.addEventListener('change', (ev) => {
  plan.targetDuration = Number(ev.target.value) || 50;
  touch();
  renderPacing();
});

$('#plan-title').addEventListener('input', (ev) => { plan.title = ev.target.value; touch(); renderPlanList(); });
$('#plan-course').addEventListener('input', (ev) => { plan.course = ev.target.value; touch(); renderTemplateControls(); });
$('#plan-notes').addEventListener('input', (ev) => { plan.notes = ev.target.value; touch(); });
$('#plan-layout').addEventListener('click', (ev) => {
  const button = ev.target.closest('.layout-btn');
  if (!button) return;
  plan.layout = button.dataset.layout;
  touch();
  renderHeader();
  renderAutoLaunch();
});

$('#timer-add').addEventListener('click', () => {
  const mins = Number($('#timer-new-mins').value);
  if (!Number.isFinite(mins) || mins < 1) return;
  if (plan.timers.length >= MAX_TIMERS) { warn(`A lecture can have ${MAX_TIMERS} countdowns; the display holds no more.`); return; }
  plan.timers.push({ id: uid(6), label: $('#timer-new-label').value.trim(), mins: Math.min(180, Math.round(mins)) });
  $('#timer-new-label').value = '';
  touch();
  renderTimers();
  // Countdown items name these, so their labels and the picker both move.
  renderOrder();
  renderEditor();
  renderAutoLaunch();
});

// --- auto-launch on plan load (Issue #52) -----------------------------------

let musicPlaylists = [];

async function loadMusicPlaylists() {
  try {
    const res = await fetch('content/music.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const data = await res.json();
    musicPlaylists = (Array.isArray(data) ? data : data.playlists || [])
      .filter((l) => l && Array.isArray(l.tracks) && l.tracks.length);
  } catch {
    musicPlaylists = [];
  }
  if (plan) renderAutoLaunch();
}

function pruneAutoLaunchItem(id) {
  if (!plan?.autoLaunch?.panes) return;
  for (const key of ['A', 'B', 'C', 'D']) {
    const p = plan.autoLaunch.panes[key];
    if (!p) continue;
    if (p.type === 'item' && p.itemId === id) {
      plan.autoLaunch.panes[key] = null;
    } else if (p.type === 'set' && Array.isArray(p.entries)) {
      p.entries = p.entries.filter((e) => e.itemId !== id);
      if (!p.entries.length) {
        plan.autoLaunch.panes[key] = null;
      }
    }
  }
  if (plan.autoLaunch.music?.playlist === `item:${id}`) {
    plan.autoLaunch.music.playlist = '';
  }
}

function pruneAutoLaunchTimer(timerId) {
  if (plan?.autoLaunch?.timer?.timerId === timerId) {
    plan.autoLaunch.timer.timerId = '';
  }
}

function renderAutoLaunch() {
  if (!plan) return;
  if (!plan.autoLaunch) plan.autoLaunch = emptyAutoLaunch();
  const al = plan.autoLaunch;

  const enableBox = $('#plan-autolaunch-enable');
  if (enableBox) enableBox.checked = !!al.enabled;
  const settingsBox = $('#plan-autolaunch-settings');
  if (settingsBox) settingsBox.hidden = !al.enabled;

  const stateSelect = $('#plan-autolaunch-state');
  if (stateSelect) stateSelect.value = al.initialState || 'live';

  const musicSelect = $('#plan-autolaunch-music');
  if (musicSelect) {
    const val = al.music?.playlist || '';
    musicSelect.replaceChildren(el('option', { value: '' }, 'None'));

    if (musicPlaylists.length) {
      const group = el('optgroup', { label: 'Playlists (content/music.json)' });
      for (const l of musicPlaylists) {
        group.append(el('option', {
          value: `playlist:${l.name}`,
        }, `🎵 ${l.name} (${l.tracks.length} track${l.tracks.length === 1 ? '' : 's'})`));
      }
      musicSelect.append(group);
    }

    const audioItems = (plan.items || []).filter((i) => i.type === 'audio');
    if (audioItems.length) {
      const group = el('optgroup', { label: 'Audio items in plan' });
      for (const it of audioItems) {
        group.append(el('option', {
          value: `item:${it.id}`,
        }, `🔊 ${itemLabel(it, plan)}`));
      }
      musicSelect.append(group);
    }

    if (val) {
      let matched = false;
      for (const opt of musicSelect.options) {
        if (opt.value === val || opt.value === `playlist:${val}`) {
          musicSelect.value = opt.value;
          matched = true;
          break;
        }
      }
      if (!matched) {
        const customOpt = el('option', { value: val }, val);
        musicSelect.append(customOpt);
        musicSelect.value = val;
      }
    } else {
      musicSelect.value = '';
    }
  }

  const musicPlay = $('#plan-autolaunch-music-play');
  if (musicPlay) musicPlay.checked = al.music?.autoplay !== false;

  const timerSelect = $('#plan-autolaunch-timer');
  if (timerSelect) {
    const val = al.timer?.timerId || '';
    timerSelect.replaceChildren(
      el('option', { value: '' }, 'None'),
      ...(plan.timers || []).map((t) => el('option', {
        value: t.id,
      }, `⏱️ ${t.label ? `${t.label} (${t.mins}m)` : `${t.mins}m countdown`}`)),
    );
    timerSelect.value = (plan.timers || []).some((t) => t.id === val) ? val : '';
  }

  renderAutoLaunchPanes();
}

function renderAutoLaunchPanes() {
  const container = $('#plan-autolaunch-panes');
  if (!container || !plan) return;
  if (!plan.autoLaunch) plan.autoLaunch = emptyAutoLaunch();
  if (!plan.autoLaunch.panes) plan.autoLaunch.panes = { A: null, B: null, C: null, D: null };
  if (!plan.autoLaunch.activePane) plan.autoLaunch.activePane = 'A';

  const count = LAYOUTS[plan.layout || 'single'] || 1;
  const activeKeys = ['A', 'B', 'C', 'D'].slice(0, count);
  // A stale pick from a plan last edited under a bigger layout (see the
  // apply-side comment in control.js) - reset here too, so the picker shown
  // to a person editing it agrees with what will actually happen on load.
  if (!activeKeys.includes(plan.autoLaunch.activePane)) plan.autoLaunch.activePane = 'A';

  container.replaceChildren(...activeKeys.map((key) => {
    const p = plan.autoLaunch.panes[key];
    let mode = 'none';
    if (p?.type === 'item') mode = 'item';
    else if (p?.type === 'set') mode = 'set';

    const modeSelect = el('select', {
      onchange: (ev) => {
        const val = ev.target.value;
        if (val === 'none') {
          plan.autoLaunch.panes[key] = null;
        } else if (val === 'item') {
          plan.autoLaunch.panes[key] = { type: 'item', itemId: plan.items[0]?.id || '' };
        } else if (val === 'set') {
          plan.autoLaunch.panes[key] = {
            type: 'set',
            title: `Pane ${key} set`,
            mode: 'sequential',
            entries: plan.items[0] ? [{ itemId: plan.items[0].id, seconds: 15 }] : [],
          };
        }
        touch();
        renderAutoLaunchPanes();
      },
    },
      el('option', { value: 'none', selected: mode === 'none' }, 'Empty / None'),
      el('option', { value: 'item', selected: mode === 'item' }, 'Single item'),
      el('option', { value: 'set', selected: mode === 'set' }, 'Automated set (slideshow)'),
    );

    // Which pane the controller's panel picker focuses once auto-launch has
    // staged everything (Issue #109) - moot with only one pane, so the
    // button only shows once there is an actual choice to make.
    const activeBtn = count > 1 ? el('button', {
      type: 'button',
      class: `autolaunch-pane-active${plan.autoLaunch.activePane === key ? ' is-on' : ''}`,
      title: 'Focus this pane on the controller once the plan loads',
      onclick: () => {
        plan.autoLaunch.activePane = key;
        touch();
        renderAutoLaunchPanes();
      },
    }, 'Active on load') : null;

    const header = el('div', { class: 'autolaunch-pane-header' },
      el('span', { class: 'pane-badge' }, `Pane ${key}${count === 1 ? ' (Full screen)' : ''}`),
      ...(activeBtn ? [activeBtn] : []),
      modeSelect,
    );

    const card = el('div', { class: 'autolaunch-pane-card' }, header);

    if (mode === 'item') {
      const itemSelect = el('select', {
        class: 'grow',
        onchange: (ev) => {
          if (!plan.autoLaunch.panes[key]) plan.autoLaunch.panes[key] = { type: 'item', itemId: '' };
          plan.autoLaunch.panes[key].itemId = ev.target.value;
          touch();
        },
      },
        el('option', { value: '' }, 'Pick an item…'),
        ...plan.items.map((it, idx) => el('option', {
          value: it.id,
          selected: it.id === p?.itemId,
        }, `${idx + 1}. [${PLAN_TYPES[it.type]?.label || it.type}] ${itemLabel(it, plan)}`)),
      );
      card.append(el('div', { class: 'field', style: 'margin: 0;' }, itemSelect));
    } else if (mode === 'set') {
      const setBox = el('div', { class: 'autolaunch-set-box' });
      const titleInput = el('input', {
        type: 'text',
        class: 'grow',
        placeholder: `Pane ${key} set`,
        value: p.title || '',
        oninput: (ev) => { p.title = ev.target.value; touch(); },
      });
      const orderSelect = el('select', {
        onchange: (ev) => { p.mode = ev.target.value; touch(); },
      },
        el('option', { value: 'sequential', selected: p.mode !== 'random' }, 'Sequential (in order)'),
        el('option', { value: 'random', selected: p.mode === 'random' }, 'Random shuffle'),
      );
      setBox.append(el('div', { class: 'inline' }, titleInput, orderSelect));

      const entriesContainer = el('div', { class: 'stack', style: 'gap: 6px;' });
      (p.entries || []).forEach((entry, eIdx) => {
        const entrySelect = el('select', {
          onchange: (ev) => { entry.itemId = ev.target.value; touch(); },
        },
          el('option', { value: '' }, 'Pick slide…'),
          ...plan.items.map((it, idx) => el('option', {
            value: it.id,
            selected: it.id === entry.itemId,
          }, `${idx + 1}. [${PLAN_TYPES[it.type]?.label || it.type}] ${itemLabel(it, plan)}`)),
        );
        const secondsInput = el('input', {
          type: 'number',
          min: '1',
          max: '3600',
          value: String(entry.seconds || 15),
          onchange: (ev) => {
            entry.seconds = Math.max(1, Math.min(3600, Math.round(Number(ev.target.value)) || 15));
            touch();
          },
        });
        const delBtn = el('button', {
          type: 'button',
          class: 'order-del',
          title: 'Remove slide from set',
          'aria-label': 'Remove slide',
          onclick: () => {
            p.entries.splice(eIdx, 1);
            touch();
            renderAutoLaunchPanes();
          },
        }, '×');
        entriesContainer.append(el('div', { class: 'autolaunch-set-entry' },
          entrySelect,
          secondsInput,
          el('span', { class: 'hint', style: 'margin: 0;' }, 'sec'),
          delBtn,
        ));
      });
      setBox.append(entriesContainer);

      const addBtn = el('button', {
        type: 'button',
        class: 'btn',
        style: 'align-self: flex-start; font-size: 13px; padding: 4px 8px;',
        onclick: () => {
          if (!Array.isArray(p.entries)) p.entries = [];
          p.entries.push({ itemId: plan.items[0]?.id || '', seconds: 15 });
          touch();
          renderAutoLaunchPanes();
        },
      }, '+ Add slide to set');
      setBox.append(addBtn);

      card.append(setBox);
    }

    return card;
  }));
}

$('#plan-autolaunch-enable').addEventListener('change', (ev) => {
  if (!plan.autoLaunch) plan.autoLaunch = emptyAutoLaunch();
  plan.autoLaunch.enabled = ev.target.checked;
  $('#plan-autolaunch-settings').hidden = !plan.autoLaunch.enabled;
  touch();
});

$('#plan-autolaunch-state').addEventListener('change', (ev) => {
  if (!plan.autoLaunch) plan.autoLaunch = emptyAutoLaunch();
  plan.autoLaunch.initialState = ev.target.value;
  touch();
});

$('#plan-autolaunch-music').addEventListener('change', (ev) => {
  if (!plan.autoLaunch) plan.autoLaunch = emptyAutoLaunch();
  if (!plan.autoLaunch.music) plan.autoLaunch.music = { playlist: '', autoplay: true, volume: 0.5 };
  plan.autoLaunch.music.playlist = ev.target.value;
  touch();
});

$('#plan-autolaunch-music-play').addEventListener('change', (ev) => {
  if (!plan.autoLaunch) plan.autoLaunch = emptyAutoLaunch();
  if (!plan.autoLaunch.music) plan.autoLaunch.music = { playlist: '', autoplay: true, volume: 0.5 };
  plan.autoLaunch.music.autoplay = ev.target.checked;
  touch();
});

$('#plan-autolaunch-timer').addEventListener('change', (ev) => {
  if (!plan.autoLaunch) plan.autoLaunch = emptyAutoLaunch();
  if (!plan.autoLaunch.timer) plan.autoLaunch.timer = { timerId: '' };
  plan.autoLaunch.timer.timerId = ev.target.value;
  touch();
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

// --- and the same two things, to a server that keeps them --------------------
//
// Deliberately beside the file rather than instead of it. A plan file is still
// the only thing that works on GitHub Pages, from a folder, or on a train.

let serverCourses = [];
// What #plan-push-update stages its save against (Issue #117) - the update
// this device last saw, not "now", so the server can tell a save that has
// not drifted from one that has.
let currentServerPlanUpdatedAt = null;

function setCurrentServerPlanId(id, updatedAt = null) {
  currentServerPlanId = id;
  currentServerPlanUpdatedAt = updatedAt;
  const btn = $('#plan-push-update');
  if (btn) btn.hidden = !id;
}

async function refreshServerPlans() {
  try {
    const res = await fetch('/api/plans', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    serverCourses = data.courses || [];
    const pick = $('#plan-pull-pick');
    pick.replaceChildren();
    for (const row of data.plans || []) {
      const label = [row.title, row.course && `(${row.course})`, row.owner && `— ${row.owner}`]
        .filter(Boolean).join(' ');
      pick.append(el('option', { value: String(row.id) }, label));
    }
    if (!(data.plans || []).length) pick.append(el('option', { value: '' }, 'Nothing saved here yet'));
    // The plan this page is showing may itself be the one just deleted from
    // elsewhere (another tab, another device) - the picker's own list is the
    // one place that would notice, so check it here rather than only after
    // this page's own Delete button.
    if (currentServerPlanId && !(data.plans || []).some((r) => String(r.id) === String(currentServerPlanId))) {
      setCurrentServerPlanId(null);
    }
  } catch { /* the file buttons above still work, which is the point */ }
}

$('#plan-push').addEventListener('click', async () => {
  await commit();
  const note = $('#plan-push-note');
  // The planning page's Course box is free text; the server only accepts a
  // course you are a member of. Rather than silently dropping it or silently
  // saving somewhere unexpected, match what we can and say what happened.
  const wanted = String(plan.course || '').trim().toLowerCase();
  const matched = serverCourses.find((c) => c.code === wanted);
  try {
    const res = await fetch('/api/plans', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: plan.title, course: matched?.code || '', doc: planToJson(plan) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'that did not work');
    note.textContent = matched
      ? `Sent — on the iPad now, shared with ${matched.code}.`
      : `Sent — on the iPad now, and yours alone${wanted ? ` (there is no course "${wanted}" here to file it under)` : ''}.`;
    // This copy IS the one just created - a follow-up edit can now update it
    // in place instead of sending yet another new row.
    setCurrentServerPlanId(body.plan.id, body.plan.updatedAt);
    await refreshServerPlans();
  } catch (err) {
    note.textContent = err.message;
  }
});

// Only ever visible once currentServerPlanId is known - see setCurrentServerPlanId
// and #plan-server's markup, which starts this button [hidden].
//
// Staged against currentServerPlanUpdatedAt (Issue #117): if someone else -
// another device, another tab, a co-instructor with the same course - saved
// this plan since it was last opened or pushed here, the server refuses with
// 409 rather than one save silently erasing the other. `force` retries with
// no base at all, which the server takes as "skip the check" - the explicit,
// deliberate way to say "overwrite it anyway" once a person has agreed to that.
async function pushPlanUpdate({ force = false } = {}) {
  const note = $('#plan-push-note');
  if (!currentServerPlanId) return;
  const wanted = String(plan.course || '').trim().toLowerCase();
  const matched = serverCourses.find((c) => c.code === wanted);
  try {
    const res = await fetch(`/api/plans/${encodeURIComponent(currentServerPlanId)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: plan.title, course: matched?.code || '', doc: planToJson(plan),
        ...(force ? {} : { baseUpdatedAt: currentServerPlanUpdatedAt }),
      }),
    });
    if (res.status === 409) {
      if (confirm('This lecture changed on the server since it was opened here - probably from another device or tab. '
        + 'Overwrite the server\'s copy with what is on this one?')) {
        await pushPlanUpdate({ force: true });
      } else {
        note.textContent = 'Not sent. Pull the server\'s copy first to see what changed, or push again once you are sure.';
      }
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'that did not work');
    currentServerPlanUpdatedAt = body.plan.updatedAt;
    note.textContent = `Updated — the copy already on the server now matches this${matched ? `, shared with ${matched.code}` : ''}.`;
    await refreshServerPlans();
  } catch (err) {
    note.textContent = err.message;
  }
}
$('#plan-push-update').addEventListener('click', async () => {
  await commit();
  await pushPlanUpdate();
});

$('#plan-pull').addEventListener('click', async () => {
  const id = $('#plan-pull-pick').value;
  if (!id) return;
  try {
    const res = await fetch(`/api/plans/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'that did not open');
    const { plan: loaded, warnings } = readPlan(typeof body.plan.doc === 'string' ? body.plan.doc : JSON.stringify(body.plan.doc));
    await newPlan(loaded);
    // newPlan() resets this (it resets for every OTHER caller too - a new
    // blank lecture, a local one, an import), so it is set back only here,
    // once the pulled plan is actually the one on screen.
    setCurrentServerPlanId(id, body.plan.updatedAt);
    warn(warnings.length ? `Opened with ${warnings.length} problem${warnings.length === 1 ? '' : 's'}: ${warnings.join(' ')}` : '');
  } catch (err) {
    warn(`That lecture did not open: ${err.message}`);
  }
});

// wireDangerButton leaves the button disabled after the action, which is
// wrong here for the same reason it is wrong for #plan-delete above: deleting
// one server lecture must not lock the button against the next one picked.
let deleteServerPlanButton;
deleteServerPlanButton = wireDangerButton($('#plan-pull-delete'), 'Delete from server', async () => {
  const id = $('#plan-pull-pick').value;
  const note = $('#plan-push-note');
  if (!id) { $('#plan-pull-delete').disabled = false; deleteServerPlanButton.disarm(); return; }
  try {
    const res = await fetch(`/api/plans/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'that did not delete');
    if (String(id) === String(currentServerPlanId)) setCurrentServerPlanId(null);
    note.textContent = 'Removed from the server. The file on your own machine, if you saved one, is untouched.';
    await refreshServerPlans();
  } catch (err) {
    note.textContent = err.message;
  }
  $('#plan-pull-delete').disabled = false;
  deleteServerPlanButton.disarm();
}, { armedLabel: 'Tap again to delete' });

// --- course plan templates (Issue #80) ---------------------------------
//
// A template is a real plan's doc, filed under a course the same way a
// pushed lecture is (see #plan-push above) - this page is the only one with
// an editor to build one in, so "manage a template" here means "save this
// lecture as one" rather than a second, separate editor somewhere else.

let courseTemplates = [];

function templateForCourse(code) {
  const wanted = String(code || '').trim().toLowerCase();
  return wanted ? courseTemplates.find((row) => row.course === wanted) : null;
}

function renderTemplateControls() {
  const wanted = String($('#plan-course').value || '').trim();
  const existing = templateForCourse(wanted);
  $('#plan-new-from-template').hidden = !existing;
  if (existing) $('#plan-new-from-template').textContent = `New lecture from ${existing.course}'s template…`;
  $('#plan-template-row').hidden = !wanted;
  $('#plan-remove-template').hidden = !existing;
}

async function refreshTemplates() {
  try {
    const res = await fetch('/api/templates', { credentials: 'same-origin' });
    if (!res.ok) return;
    courseTemplates = (await res.json()).templates || [];
  } catch { /* the rest of the page still works, which is the point */ }
  renderTemplateControls();
}

$('#plan-new-from-template').addEventListener('click', async () => {
  const existing = templateForCourse($('#plan-course').value);
  if (!existing?.doc) return;
  try {
    const { plan: loaded, warnings } = readPlan(typeof existing.doc === 'string' ? existing.doc : JSON.stringify(existing.doc));
    await newPlan(loaded);
    warn(warnings.length ? `Opened with ${warnings.length} problem${warnings.length === 1 ? '' : 's'}: ${warnings.join(' ')}` : '');
  } catch (err) {
    warn(`That template did not open: ${err.message}`);
  }
});

$('#plan-save-template').addEventListener('click', async () => {
  await commit();
  const note = $('#plan-template-note');
  const course = String($('#plan-course').value || '').trim();
  if (!course) { note.textContent = "Type a course above first - a template belongs to one."; return; }
  try {
    const res = await fetch(`/api/templates/${encodeURIComponent(course)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: planToJson(plan) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'that did not work');
    await refreshTemplates();
    note.textContent = `Saved — new lectures for ${body.saved.course} can start from this.`;
  } catch (err) {
    note.textContent = err.message;
  }
});

$('#plan-remove-template').addEventListener('click', async () => {
  const note = $('#plan-template-note');
  const course = String($('#plan-course').value || '').trim();
  if (!course) return;
  try {
    const res = await fetch(`/api/templates/${encodeURIComponent(course)}`, { method: 'DELETE', credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'that did not work');
    await refreshTemplates();
    note.textContent = `Removed — new lectures for ${course} start blank again.`;
  } catch (err) {
    note.textContent = err.message;
  }
});

serverInfo().then((info) => {
  // Issue #108: whether serverUploadField() offers uploading a PDF/video/
  // audio file straight to the server, rather than only a typed path.
  // Checked async, so an item editor already open for one of those types
  // when this resolves is re-rendered once, to pick the field up rather
  // than needing a reselect.
  if (info.features.includes('library')) {
    serverLibraryUpload = true;
    renderEditor();
  }
  if (!info.features.includes('plans')) return;
  $('#plan-server').hidden = false;
  refreshServerPlans();
  if (info.features.includes('templates')) refreshTemplates();
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
  renderAutoLaunch();
  renderEditor();
  renderSize();
  renderPlanList();
}

loadMusicPlaylists();
renderTypePicker();
$('#plan-build').textContent = `Podium ${VERSION} · build ${BUILD}${COMMIT ? ` · ${COMMIT}` : ''}`;
const planTag = $('#plan-version-tag');
if (planTag) planTag.textContent = versionStamp();
servedBuild().then((served) => {
  if (served === null || served === BUILD) return;
  $('#plan-build').textContent = `Podium ${VERSION} · build ${BUILD}, but the server has ${served} — this page came from a cache. Reload it.`;
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
