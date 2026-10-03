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
import { render as renderDeckSource, frontMatterTitle, describeBuild } from './deck.js';
import { assetRefsIn } from './deck-source.js';
import { BUILD, VERSION, COMMIT, versionStamp, MAX_TIMERS, LAYOUTS, deckStep } from './protocol.js';
import { mountSessionBadge, serverInfo } from './server.js';
import { mountZipImport } from './zip-review.js';

mountSessionBadge($('#session-badge'));

let plan = null;
let selectedId = null;
// Issue #108: whether serverUploadField() below has anything to upload to -
// set once serverInfo() resolves.
let serverLibraryUpload = false;
let saveTimer = null;
let preview = { renderer: null, key: null, slide: 0, step: 0, count: 0, fragments: [], builds: [] };
// Bumped whenever the deck editor (Issue #226) changes a deck this page shows,
// so the preview's render (cached by id) is made again rather than reused.
let deckEpoch = 0;
// The server row this in-memory plan maps to, if any - set after pulling one
// from the server or pushing one there, cleared by anything that swaps the
// plan out for a different one (a new lecture, a different local lecture, an
// imported file, a duplicate). What "Update the copy already there" acts on.

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
  // Not "Saved to the server" for an edit that has not got there yet - the
  // line names the class this lecture is filed under, and that is only true
  // once the save that files it has landed.
  if (serverMode && conflictPlanId !== plan.id && worthSaving(plan)) setSync('saving');
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
    if (serverMode) scheduleServerSave(plan);
    else renderSync();
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

// One list (Issue #204): this browser's lectures, each saying where it lives,
// then - on a server - the server's lectures this browser has no copy of yet
// (another device's, or a co-instructor's), which open with a tap.
async function renderPlanList() {
  const list = $('#plan-list');
  let rows;
  try { rows = await allPlans(); } catch (err) { warn(err.message); return; }
  const where = (row) => {
    if (!serverMode) return 'this browser';
    return row.server?.id ? 'on the server' : 'this browser';
  };
  const local = rows.map((row) => el('button', {
    class: `plan-row${row.id === plan?.id ? ' is-on' : ''}`,
    type: 'button',
    onclick: () => openPlan(row.id),
  },
    el('span', { class: 'plan-row-title' }, row.title || 'Untitled lecture'),
    el('span', { class: 'plan-row-meta' },
      el('span', { class: `plan-row-where${row.server?.id && serverMode ? ' is-server' : ''}` }, where(row)),
      ` · ${row.items?.length || 0} item${(row.items?.length || 0) === 1 ? '' : 's'}`
      + (row.course ? ` · ${row.course}` : '')
      + ` · ${new Date(row.updated || 0).toLocaleDateString()}`)));
  const linked = new Set(rows.map((r) => r.server?.id && String(r.server.id)).filter(Boolean));
  // Only mine, or filed under a class I am in: an administrator can read
  // every lecture on the server, and the place to look through all of those
  // - the unfiled ones included - is Administration → Lectures (Issue #224),
  // not this list.
  const relevant = (r) => !me || r.ownerId === me.id || (!!r.course && (!myClasses || myClasses.has(r.course)));
  const remote = serverMode ? serverRows.filter((r) => !linked.has(String(r.id)) && relevant(r)).map((r) => el('button', {
    class: 'plan-row is-remote',
    type: 'button',
    onclick: () => openServerPlan(r.id),
  },
    el('span', { class: 'plan-row-title' }, r.title || 'Untitled lecture'),
    el('span', { class: 'plan-row-meta' },
      el('span', { class: 'plan-row-where' }, 'on the server only'),
      [r.course && ` · ${r.course}`, r.owner && ` · ${r.owner}`, ' · tap to open'].filter(Boolean).join('')))) : [];
  list.replaceChildren(...local, ...remote);
  if (!rows.length && !remote.length) list.append(el('p', { class: 'empty' }, 'No lectures yet.'));
}

async function openPlan(id) {
  await commit();
  await flushServerSave();
  const found = await loadPlan(id);
  if (!found) return;
  plan = found;
  selectedId = plan.items[0]?.id || null;
  warn('');
  renderAll();
}

async function newPlan(seed = null) {
  await commit();
  await flushServerSave();
  plan = seed || emptyPlan();
  selectedId = plan.items[0]?.id || null;
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

$('#order-settings').addEventListener('click', () => select(null));

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
      // A countdown names one of the lecture's timers, so adding one brings
      // its own fresh timer with it - not whichever one happened to be
      // created first - or the item is inert and the reason is two screens
      // away. Once every slot the room allows (MAX_TIMERS) is taken, there is
      // nothing left to create, so this one has to share; the timer-pick
      // field below asks which, rather than silently picking one.
      if (type === 'timer') {
        if (plan.timers.length < MAX_TIMERS) {
          const timer = { id: uid(6), label: '', mins: 5 };
          plan.timers.push(timer);
          item.timerId = timer.id;
        } else {
          item.timerId = '';
        }
      }
      const at = plan.items.findIndex((i) => i.id === selectedId);
      // Inserted after whatever is selected: you build a lecture by working
      // down it, and appending to the end means dragging it back every time.
      plan.items.splice(at < 0 ? plan.items.length : at + 1, 0, item);
      touch();
      select(item.id);
      if (type === 'timer') renderTimers();
      renderAutoLaunch();
    },
  }, el('span', { class: 'type-icon' }, spec.icon), el('span', {}, spec.label))));
}

// --- timers ------------------------------------------------------------------

// Refreshed everywhere a timer's name or length shows up somewhere other
// than this list - the item chips in the running order, the item editor's
// own timer-pick field, and the auto-launch panel's timer option.
function afterTimerEdit() {
  touch();
  renderOrder();
  renderEditor();
  renderAutoLaunch();
}

function renderTimers() {
  $('#timers').replaceChildren(...plan.timers.map((timer, i) => el('li', { class: 'timer-row' },
    el('input', {
      type: 'text', class: 'grow', value: timer.label, placeholder: `Timer ${i + 1}`,
      'aria-label': `Name for timer ${i + 1}`,
      oninput: (ev) => { timer.label = ev.target.value; afterTimerEdit(); },
    }),
    el('input', {
      type: 'number', min: '1', max: '180', step: '1', style: 'width: 80px;',
      value: String(timer.mins), 'aria-label': `Minutes for timer ${i + 1}`,
      oninput: (ev) => {
        const mins = Number(ev.target.value);
        if (!Number.isFinite(mins) || mins < 1) return;
        timer.mins = Math.min(180, Math.round(mins));
        afterTimerEdit();
      },
    }),
    el('button', {
      type: 'button', 'aria-label': `Remove ${timer.label || `timer ${i + 1}`}`,
      onclick: () => {
        plan.timers = plan.timers.filter((t) => t.id !== timer.id);
        pruneAutoLaunchTimer(timer.id);
        pruneItemsForTimer(timer.id);
        touch();
        renderTimers();
        renderOrder();
        renderEditor();
        renderAutoLaunch();
      },
    }, '×'))));
  if (!plan.timers.length) $('#timers').append(el('li', { class: 'empty' }, 'None yet — the iPad will show one unnamed countdown and the 1/2/5/10/15 buttons.'));
}

// A countdown item pointed at a timer that no longer exists is worse than
// one asking again which to use - see the "Choose a timer…" placeholder in
// fieldFor's timer-pick branch, which only shows once this is empty.
function pruneItemsForTimer(timerId) {
  for (const item of plan.items) {
    if (item.type === 'timer' && item.timerId === timerId) item.timerId = '';
  }
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
  // No item picked: this column holds the whole lecture's settings (Issue
  // #205) instead of a "Nothing selected" placeholder.
  $('#lecture-settings').hidden = !!item;
  $('#order-settings').classList.toggle('is-on', !item);
  $('#order-settings').setAttribute('aria-pressed', String(!item));
  if (!item) {
    $('#item-heading').textContent = 'Lecture settings';
    $('#item-blurb').textContent = 'For the whole lecture. Pick something in the running order to edit it instead.';
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
  if (item.type === 'deck') fields.append(deckEditorField(item));

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

  // Issue #154: pre-written for whoever cannot hear the room or read the
  // screen alone - a kiosk running unattended, or a live lecture between
  // sentences. Rides the same bottom bar Live Captions (#79) already owns;
  // see syncOverlayForProgram in protocol.js for exactly when it takes over.
  fields.append(field('Caption', el('textarea', {
    rows: '2', placeholder: 'Shown on the caption bar while this item is live.',
    oninput: (ev) => { item.overlayCaption = ev.target.value; afterEdit({ label: true }); },
  }, item.overlayCaption || ''),
  'Optional. Pre-scripted captions or audio description for a kiosk display, or any lecture, between spoken words.'));

  renderPreview({ remount: true });
}

// The deck editor (Issue #226) is a page of its own, opened in a new tab from
// here. Where the deck lives decides how it is opened, and so where Save puts
// it back: the library deck itself, content/decks for an administrator, or -
// for a deck carried inside this plan - back into this plan, through this tab
// (see the podium-decks channel below).
function deckEditorField(item) {
  const base = { plan: plan.id, item: item.id };
  const open = (extra) => window.open(`deck.html?${new URLSearchParams({ ...extra, ...base })}`, '_blank');
  const libraryId = /^\/media\/deck\/(\d+)\//.exec(item.src || '')?.[1];
  const contentName = /^content\/decks\/(.+)$/.exec(item.src || '')?.[1];
  const edit = el('button', {
    type: 'button',
    onclick: () => {
      if (item.asset) open({ embedded: '1' });
      else if (libraryId) open({ library: libraryId });
      else if (contentName && me?.isAdmin) open({ content: decodeURIComponent(contentName) });
      else open({ src: item.src });
    },
  }, 'Edit this deck');
  edit.hidden = !item.asset && !item.src;
  const fresh = el('button', {
    type: 'button',
    onclick: () => {
      if (serverLibraryUpload) {
        // Saved into the library from the editor, which then points this
        // item at it (deck-linked, below).
        open({ title: item.title || plan.title || '', course: plan.course || '' });
        return;
      }
      // No server to save to: the new deck lives inside this plan.
      const id = uid(10);
      plan.assets[id] = { name: 'deck.md', mime: 'text/markdown', data: newDeckMarkdown(item.title || plan.title || 'Untitled deck') };
      item.asset = id;
      item.src = '';
      touch();
      renderOrder();
      renderEditor();
      open({ embedded: '1' });
    },
  }, item.asset || item.src ? 'Start a new deck instead' : 'Write a new deck');
  return field('Deck editor', el('div', { class: 'inline' }, edit, fresh),
    'Opens in a new tab: the markdown beside the slides as the class will see them. Keep this lecture open here while you edit a deck that lives inside it.');
}

function newDeckMarkdown(title) {
  const safe = String(title).replace(/[\r\n]+/g, ' ').trim() || 'Untitled deck';
  return `---\nmarp: true\npaginate: true\ntitle: ${JSON.stringify(safe)}\n---\n\n# ${safe}\n\n---\n\n## A first slide\n\n- A point worth making\n`;
}

// What the deck editor asks of, and tells, the planner tab that opened it.
const deckChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('podium-decks') : null;
deckChannel?.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg.from !== 'editor') return;
  const reply = (body) => deckChannel.postMessage({ ...body, nonce: msg.nonce, from: 'planner' });
  const itemHere = () => (plan && plan.id === msg.planId ? plan.items.find((i) => i.id === msg.itemId) : null);

  if (msg.type === 'plan-deck-get') {
    const item = itemHere();
    if (!item) { if (plan?.id === msg.planId) reply({ error: 'That deck is no longer in this lecture.' }); return; }
    const asset = plan.assets[item.asset];
    if (!asset) { reply({ error: 'That item does not carry a deck inside the plan.' }); return; }
    // The deck's own pictures kept in this plan, so the editor can show them.
    const pictures = Object.fromEntries(assetRefsIn(asset.data).filter((id) => plan.assets[id]).map((id) => [id, plan.assets[id].data]));
    reply({ markdown: asset.data, name: asset.name, title: item.title || '', planTitle: plan.title || '', course: plan.course || '', pictures });
    return;
  }
  // A picture for a deck that lives in this plan, with no server to keep it
  // (Issue #226): it becomes one of the plan's assets, like any photo item's.
  if (msg.type === 'plan-asset-put') {
    const item = itemHere();
    if (!item) { if (plan?.id === msg.planId) reply({ error: 'That deck is no longer in this lecture.' }); return; }
    if (typeof msg.data !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(msg.data)) { reply({ error: 'That is not a picture.' }); return; }
    const id = uid(10);
    plan.assets[id] = { name: String(msg.name || 'picture.jpg').slice(0, 120), mime: /^data:([^;]+)/.exec(msg.data)[1], data: msg.data };
    touch();
    reply({ id });
    return;
  }
  if (msg.type === 'plan-deck-put') {
    const item = itemHere();
    if (!item) { if (plan?.id === msg.planId) reply({ error: 'That deck is no longer in this lecture.' }); return; }
    if (!plan.assets[item.asset]) {
      const id = uid(10);
      plan.assets[id] = { name: 'deck.md', mime: 'text/markdown', data: '' };
      item.asset = id;
    }
    plan.assets[item.asset].data = String(msg.markdown ?? '');
    item.src = '';
    deckEpoch++;
    touch();
    renderOrder();
    if (selectedId === item.id) renderEditor();
    reply({ ok: true });
    return;
  }
  if (msg.type === 'deck-linked') {
    const item = itemHere();
    if (!item) return;
    item.src = msg.src;
    item.asset = '';
    if (!item.title) item.title = msg.title || '';
    deckEpoch++;
    touch();
    renderOrder();
    if (selectedId === item.id) renderEditor();
    return;
  }
  if (msg.type === 'deck-saved') {
    deckEpoch++;
    const item = selected();
    if (item?.type === 'deck' && item.src === msg.src) renderPreview({ remount: true });
  }
});

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
    // No real answer to default to once the item's own timer is gone (the
    // room is full of other timers, or its slot was deleted) - an honest
    // placeholder asks, rather than quietly pointing at whichever is first.
    const known = plan.timers.some((t) => t.id === item.timerId);
    return field(spec.label, el('select', { onchange: (ev) => set(ev.target.value, { remount: true, label: true }) },
      ...(known ? [] : [el('option', { value: '', selected: true, disabled: true }, 'Choose a timer…')]),
      ...plan.timers.map((timer, i) => el('option', {
        value: timer.id,
        selected: known && item.timerId === timer.id,
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

// Issue #106: a ZIP of a lecture's materials, into the server library - and,
// unless unticked, straight into this lecture's running order as well.
function planItemFromLibrary(li) {
  const type = { image: 'image', deck: 'deck', pdf: 'pdf', video: 'video', audio: 'audio', imagedeck: 'imagedeck' }[li.type];
  if (!type) return null;
  const item = newItem(type);
  item.title = li.title;
  if (type === 'imagedeck') item.images = (li.images || []).join('\n');
  else item.src = li.src;
  return item;
}

function mountPlanZipImport() {
  $('#plan-zip-box').hidden = false;
  let addToOrder = null;
  mountZipImport($('#plan-zip'), {
    surface: 'planner',
    loadCourses: async () => {
      const res = await fetch('/api/library', { credentials: 'same-origin' });
      return res.ok ? (await res.json()).courses || [] : [];
    },
    defaultCourse: () => plan.course || '',
    extraOptions: () => {
      addToOrder = el('input', { type: 'checkbox', class: 'zip-add-order', checked: true });
      return el('label', { class: 'check' }, addToOrder, ' Also add them to this lecture\u2019s running order');
    },
    onImported: (result) => {
      if (!addToOrder?.checked) return;
      // What was already in the library is still wanted in this lecture.
      const found = [...result.imported, ...result.skipped].map((r) => r.item).filter(Boolean);
      const items = found.map(planItemFromLibrary).filter(Boolean);
      if (!items.length) return;
      const at = plan.items.findIndex((i) => i.id === selectedId);
      plan.items.splice(at < 0 ? plan.items.length : at + 1, 0, ...items);
      touch();
      renderOrder();
      renderAutoLaunch();
    },
  });
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
    return { ...staged, deckId: `${item.asset ? `asset:${item.asset}` : `src:${item.src}`}#e${deckEpoch}`, slide: preview.slide, step: preview.step };
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
      // A deck's pictures kept in this plan (Issue #226).
      resolveAssets: (it) => {
        const id = assetIdOf(it?.src);
        return id && plan.assets[id] ? { ...it, src: plan.assets[id].data } : it;
      },
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

// So the slide stepper can say "3 of 14", stop at the end, and walk through
// each slide's build the way Next will in class (Issue #177); the renderer
// clamps regardless.
async function countDeck(item) {
  const where = $('#deck-where');
  const buildNote = $('#deck-build');
  try {
    const source = await previewDeckSource(item);
    if (source == null) {
      where.textContent = 'No slides yet';
      Object.assign(preview, { count: 0, fragments: [], builds: [] });
      buildNote.hidden = true;
      return;
    }
    const deck = await renderDeckSource(source, `count:${item.asset || item.src}#e${deckEpoch}`);
    Object.assign(preview, { count: deck.count, fragments: deck.fragments || [], builds: deck.builds || [] });
    const slide = Math.min(preview.slide, Math.max(0, deck.count - 1));
    const steps = preview.fragments[slide] || 0;
    where.textContent = `Slide ${slide + 1} of ${deck.count}`
      + (steps ? ` · ${Math.min(preview.step, steps)} of ${steps} revealed` : '');
    renderBuildNote(slide);
  } catch (err) {
    Object.assign(preview, { count: 0, fragments: [], builds: [] });
    where.textContent = `Could not read that deck: ${err.message}`;
    buildNote.hidden = true;
  }
}

// What "What the class sees" cannot show by itself (Issue #177): whether this
// slide builds, what it builds, and - the reason to look here at all - when a
// build directive did not do what it was meant to. Plus which slides build
// across the whole deck, to catch a `class: build` (every slide from here on)
// written where `_class: build` (this slide) was meant.
function renderBuildNote(slide) {
  const note = $('#deck-build');
  const { text, warn } = describeBuild(preview.builds[slide]);
  const building = preview.builds.map((b, i) => (b.steps ? i + 1 : 0)).filter(Boolean);
  const classes = (preview.builds[slide]?.classes || []).join(' ');
  note.hidden = !text;
  note.classList.toggle('is-warn', warn);
  note.replaceChildren(
    el('span', { class: 'deck-build-text' }, text),
    classes ? el('span', { class: 'deck-build-classes' }, ` Slide class: ${classes}.`) : '',
    el('span', { class: 'deck-build-deck' }, building.length
      ? ` Slides that build: ${building.join(', ')}.`
      : ' No slide in this deck builds.'),
  );
}

// Next and Previous step through a slide's build before leaving it, exactly as
// the display does (deckStep in protocol.js).
function stepPreview(dir) {
  const pos = deckStep(preview, dir, preview.fragments, preview.count || preview.slide + 2);
  preview.slide = pos.slide;
  preview.step = pos.step;
  renderPreview();
}
$('#deck-prev').addEventListener('click', () => stepPreview('prev'));
$('#deck-next').addEventListener('click', () => stepPreview('next'));

// --- plan-level fields -------------------------------------------------------

function renderHeader() {
  $('#plan-title').value = plan.title || '';
  $('#plan-course').value = plan.course || '';
  renderCoursePick();
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
$('#plan-course').addEventListener('input', (ev) => {
  // While New class… is being typed on a server, nothing is filed until
  // Create class makes it - only the plain-text Course box of file-only mode
  // writes straight into the lecture.
  if (serverMode) return;
  plan.course = ev.target.value; touch(); renderTemplateControls();
});
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
      ...(plan.timers || []).map((t, i) => el('option', {
        value: t.id,
      }, `⏱️ ${t.label || `Timer ${i + 1}`} (${t.mins}m)`)),
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

// --- saving to a server that keeps lectures (Issue #204) ----------------------
//
// On a Podium with a server, a lecture saves itself there the way it already
// saves itself in this browser: no Send button, just a line saying it is
// saved, where, and who else can see it. The plan file is still offered - it
// is the only thing that works on GitHub Pages, from a folder, or on a train -
// just no longer as a competing main action.
//
// Each local lecture remembers the server row it is (plan.server: id and the
// updatedAt this device last saw). A save is staged against that updatedAt
// (Issue #117), so a copy changed elsewhere since is never silently replaced:
// saving pauses and asks instead (see showConflict).

let serverMode = false;
let me = null;              // the signed-in account, on a server with accounts
let myClasses = null;       // codes of the classes I am actually in (Issue #224)
let markBooted;
const booted = new Promise((resolve) => { markBooted = resolve; });
let serverCourses = [];
let serverRows = [];
const SERVER_SAVE_MS = 1500;
let serverSaveTimer = null;
let serverSavePending = null;     // the plan object a scheduled save is for
let serverSaving = null;          // the save in flight, so a switch can wait for it
let conflictPlanId = null;        // whose autosave is paused, waiting on Keep mine / Open theirs
let sync = { state: 'idle', at: 0, note: '' };

// A brand-new lecture nobody has touched yet is not worth a server row.
const worthSaving = (p) => {
  if (!p) return false;
  const title = String(p.title || '').trim();
  return !!(p.items?.length || (title && title !== 'Untitled lecture') || String(p.notes || '').trim());
};

function courseFor(p) {
  const wanted = String(p?.course || '').trim().toLowerCase();
  return { wanted, matched: serverCourses.find((c) => c.code === wanted) || null };
}

function setSync(state, note = '') {
  sync = { state, at: Date.now(), note };
  renderSync();
}

function renderSync() {
  const line = $('#plan-sync');
  if (!line || !plan) return;
  const time = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const conflicted = serverMode && conflictPlanId === plan.id;
  $('#plan-conflict').hidden = !conflicted;
  line.className = 'plan-sync';
  if (!serverMode) {
    line.textContent = plan.updated ? `Saved in this browser · ${time(plan.updated)}` : '';
    return;
  }
  if (conflicted) { line.textContent = 'Not saved to the server - see below'; line.classList.add('is-warn'); return; }
  if (!plan.server?.id && !worthSaving(plan)) { line.textContent = 'Saves to the server once it has a title or something in it'; return; }
  if (sync.state === 'saving') { line.textContent = 'Saving to the server…'; return; }
  if (sync.state === 'error') { line.textContent = `Not saved to the server: ${sync.note} It is still saved in this browser.`; line.classList.add('is-warn'); return; }
  if (plan.server?.id) {
    const { wanted, matched } = courseFor(plan);
    line.textContent = `Saved to the server · ${time(plan.server.savedAt || sync.at || Date.now())} · `
      + (matched ? `shared with ${matched.code}` : `yours alone${wanted ? ` (there is no course "${wanted}" here to file it under)` : ''}`);
    line.classList.add('is-ok');
    return;
  }
  line.textContent = 'Saving to the server…';
}

function scheduleServerSave(p) {
  if (!serverMode || !p || conflictPlanId === p.id || !worthSaving(p)) { renderSync(); return; }
  serverSavePending = p;
  clearTimeout(serverSaveTimer);
  serverSaveTimer = setTimeout(() => { serverSaving = serverSave(p); }, SERVER_SAVE_MS);
  if (p === plan) setSync('saving');
}

// Before switching lectures: the outgoing one's save goes now, not never.
async function flushServerSave() {
  if (serverSaveTimer && serverSavePending) {
    clearTimeout(serverSaveTimer);
    serverSaveTimer = null;
    serverSaving = serverSave(serverSavePending);
  }
  try { await serverSaving; } catch { /* reported on the sync line */ }
}

async function serverSave(p, { force = false } = {}) {
  serverSaveTimer = null;
  if (serverSavePending === p) serverSavePending = null;
  if (!serverMode || !p || (conflictPlanId === p.id && !force)) return;
  const { matched } = courseFor(p);
  const payload = { title: p.title, course: matched?.code || '', doc: planToJson(p) };
  try {
    let res;
    if (p.server?.id) {
      res = await fetch(`/api/plans/${encodeURIComponent(p.server.id)}`, {
        method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...payload, ...(force ? {} : { baseUpdatedAt: p.server.updatedAt }) }),
      });
      // Deleted from the server elsewhere: this is still a lecture someone is
      // editing, so it goes back up as a new row rather than vanishing.
      if (res.status === 404) { p.server = null; return serverSave(p); }
      if (res.status === 409) { showConflict(p); return; }
    } else {
      res = await fetch('/api/plans', {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `the server said ${res.status}.`);
    p.server = { id: String(body.plan.id), updatedAt: body.plan.updatedAt, savedAt: Date.now() };
    await savePlan(p);
    if (p === plan) setSync('saved');
    refreshServerPlans();
  } catch (err) {
    if (p === plan) setSync('error', /[.!?]$/.test(err.message) ? err.message : `${err.message}.`);
  }
}

function showConflict(p) {
  conflictPlanId = p.id;
  if (p === plan) setSync('conflict');
}

$('#plan-conflict-mine').addEventListener('click', async () => {
  conflictPlanId = null;
  setSync('saving');
  await serverSave(plan, { force: true });
});

$('#plan-conflict-theirs').addEventListener('click', async () => {
  const mine = plan;
  try {
    const res = await fetch(`/api/plans/${encodeURIComponent(mine.server.id)}`, { credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'that did not open');
    const { plan: theirs, warnings } = readPlan(typeof body.plan.doc === 'string' ? body.plan.doc : JSON.stringify(body.plan.doc));
    // Yours stays, as its own lecture in this browser, no longer tied to
    // the server row; theirs takes over that row (and this lecture's place).
    const copy = { ...structuredClone(mine), id: uid(10), server: null, title: `${mine.title || 'Untitled lecture'} (my copy)`, updated: Date.now() };
    await savePlan(copy);
    theirs.id = mine.id;
    // The row's title is the one every list shows; a rename made through the
    // server is still theirs even when the document inside predates it.
    if (body.plan.title) theirs.title = body.plan.title;
    theirs.server = { id: String(body.plan.id), updatedAt: body.plan.updatedAt, savedAt: Date.now() };
    conflictPlanId = null;
    plan = null;                     // so newPlan's commit() cannot write mine back over it
    await newPlan(theirs);
    setSync('saved');
    warn(warnings.length ? `Opened with ${warnings.length} problem${warnings.length === 1 ? '' : 's'}: ${warnings.join(' ')}` : '');
  } catch (err) {
    warn(`The server's copy did not open: ${err.message}`);
  }
});

async function refreshServerPlans() {
  try {
    const res = await fetch('/api/plans', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    serverCourses = data.courses || [];
    serverRows = data.plans || [];
    renderPlanList();
    renderCoursePick();
    renderSync();
  } catch { /* this browser's own copy still works, which is the point */ }
}

// A lecture on the server this browser has no copy of: open it, and it is
// tied to that row from then on, so editing it saves back there.
async function openServerPlan(id) {
  try {
    const res = await fetch(`/api/plans/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'that did not open');
    const { plan: loaded, warnings } = readPlan(typeof body.plan.doc === 'string' ? body.plan.doc : JSON.stringify(body.plan.doc));
    loaded.id = uid(10);
    if (body.plan.title) loaded.title = body.plan.title;
    loaded.server = { id: String(body.plan.id), updatedAt: body.plan.updatedAt, savedAt: Date.now() };
    await newPlan(loaded);
    warn(warnings.length ? `Opened with ${warnings.length} problem${warnings.length === 1 ? '' : 's'}: ${warnings.join(' ')}` : '');
  } catch (err) {
    warn(`That lecture did not open: ${err.message}`);
  }
}

// Which one main action the rail offers (Issue #204), and what its footer says.
function setServerMode(on) {
  serverMode = on;
  $('#plan-new').classList.toggle('is-primary', on);
  $('#plan-new-more').classList.toggle('is-primary', on);
  $('#plan-export').classList.toggle('big-button', !on);
  $('#plan-export').textContent = on ? 'Export plan file' : 'Save a plan file for the iPad';
  $('#plan-where-hint').textContent = on
    ? 'Lectures save to this server as you work, so they are on the iPad in class with no file to carry: Library → Lectures on the server. Export a plan file for a machine with no server, or to keep a copy.'
    : 'Plans live in this browser on this machine. To teach from one, save a plan file and open it on the iPad: Library → Load a lecture plan in the controller.';
  renderPlanList();
  renderCoursePick();
  renderSync();
}

// --- the Course field, on a server (Issue #224) -------------------------------
//
// A dropdown of the classes this account can file under, so a lecture always
// lands under a class that exists, plus No class assigned and New class… -
// which shows the text box and makes the class (owned by whoever typed it)
// when Create class is pressed. A lecture opened from a file can name a class
// this server does not have; that stays visible as such until it is changed.
const NEW_CLASS = '__new';
let creatingClass = false;

function renderCoursePick() {
  const pick = $('#plan-course-pick');
  pick.hidden = !serverMode;
  if (!serverMode) { $('#plan-course').hidden = false; $('#plan-course-create').hidden = true; return; }
  const current = String(plan?.course || '').trim().toLowerCase();
  const known = serverCourses.some((c) => c.code === current);
  pick.replaceChildren(
    el('option', { value: '' }, 'No class assigned'),
    ...serverCourses.map((c) => el('option', { value: c.code }, c.title && c.title !== c.code ? `${c.code} — ${c.title}` : c.code)),
    ...(current && !known ? [el('option', { value: current }, `${current} (not a class here yet)`)] : []),
    el('option', { value: NEW_CLASS }, 'New class…'),
  );
  pick.value = creatingClass ? NEW_CLASS : current;
  // The text box always holds the lecture's class while it is not being
  // used to type a new one, the same as without a server.
  if (!creatingClass) $('#plan-course').value = plan?.course || '';
  $('#plan-course').hidden = !creatingClass;
  $('#plan-course').placeholder = creatingClass ? 'New class name' : 'Course';
  $('#plan-course-create').hidden = !creatingClass;
}

$('#plan-course-pick').addEventListener('change', (ev) => {
  if (ev.target.value === NEW_CLASS) {
    creatingClass = true;
    $('#plan-course').value = '';
    renderCoursePick();
    $('#plan-course').focus();
    return;
  }
  creatingClass = false;
  plan.course = ev.target.value;
  touch();
  renderCoursePick();
  renderTemplateControls();
  renderSync();
});

async function createClass() {
  const name = $('#plan-course').value.trim();
  if (!name) { $('#plan-course').focus(); return; }
  try {
    const res = await fetch('/api/courses', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: name, fromPlanner: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `the server said ${res.status}.`);
    creatingClass = false;
    plan.course = body.course.code;
    warn('');
    await refreshServerPlans();
    touch();
    renderCoursePick();
    renderTemplateControls();
  } catch (err) {
    warn(`That class was not made: ${err.message}`);
  }
}
$('#plan-course-create').addEventListener('click', createClass);
$('#plan-course').addEventListener('keydown', (ev) => {
  if (serverMode && creatingClass && ev.key === 'Enter') { ev.preventDefault(); createClass(); }
  if (serverMode && creatingClass && ev.key === 'Escape') { creatingClass = false; renderCoursePick(); }
});

// "+ New lecture ▾": the other two ways to start one.
function setNewMenu(open) {
  $('#plan-new-menu').hidden = !open;
  $('#plan-new-more').setAttribute('aria-expanded', String(open));
}
$('#plan-new-more').addEventListener('click', (ev) => {
  ev.stopPropagation();
  setNewMenu($('#plan-new-menu').hidden);
});
$('#plan-new-menu').addEventListener('click', () => setNewMenu(false));
document.addEventListener('click', (ev) => { if (!ev.target.closest('.plan-new-wrap')) setNewMenu(false); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') setNewMenu(false); });

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
  const wanted = String(plan?.course || '').trim();
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
  const existing = templateForCourse(plan?.course);
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
  const course = String(plan?.course || '').trim();
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
  const course = String(plan?.course || '').trim();
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
    mountPlanZipImport();
  }
  if (!info.features.includes('plans')) return;
  me = info.user || null;
  if (me) {
    fetch('/api/courses', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (!data) return;
      // An administrator is listed every class, each with its people; anyone
      // else only the ones they are in.
      myClasses = new Set((data.courses || [])
        .filter((c) => !c.people || c.people.some((p) => p.username === me.username))
        .map((c) => c.code));
      renderPlanList();
    }).catch(() => {});
  }
  setServerMode(true);
  // plan.html?open=<id> (Issue #224): Administration's Lectures list opens
  // one here. After this page's own lectures are loaded, or loading them
  // would replace it.
  const openId = new URLSearchParams(location.search).get('open');
  refreshServerPlans().then(async () => {
    if (!openId) { if (plan) scheduleServerSave(plan); return; }
    await booted;
    history.replaceState(null, '', location.pathname);
    const local = (await allPlans()).find((row) => String(row.server?.id) === openId);
    if (local) await openPlan(local.id);
    else await openServerPlan(openId);
  });
  if (info.features.includes('templates')) refreshTemplates();
});

$('#plan-new').addEventListener('click', () => newPlan());

$('#plan-duplicate').addEventListener('click', async () => {
  const copy = structuredClone(plan);
  copy.id = uid(10);
  copy.title = `${plan.title} (copy)`;
  copy.created = Date.now();
  copy.server = null;
  await newPlan(copy);
});

// wireDangerButton leaves the button disabled after the action, which is right
// for the settings reset it was written for (that reloads the page) and wrong
// here: deleting one lecture must not lock the button for the next one.
let deleteButton;
deleteButton = wireDangerButton($('#plan-delete'), 'Delete this lecture', async () => {
  // On a server, "this lecture" is both copies (Issue #204) - the tap-again
  // label says so. An exported plan file is untouched either way.
  if (serverMode && plan.server?.id) {
    try {
      const res = await fetch(`/api/plans/${encodeURIComponent(plan.server.id)}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!res.ok && res.status !== 404) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `the server said ${res.status}.`);
      }
    } catch (err) {
      warn(`Not deleted - the server's copy could not be removed: ${err.message}`);
      $('#plan-delete').disabled = false;
      deleteButton.disarm();
      return;
    }
  }
  clearTimeout(serverSaveTimer);
  serverSavePending = null;
  const doomed = plan.id;
  const rows = (await allPlans()).filter((r) => r.id !== doomed);
  plan = null;                       // so commit() cannot write it back
  await removePlan(doomed);
  if (rows.length) await openPlan(rows[0].id);
  else await newPlan();
  $('#plan-delete').disabled = false;
  deleteButton.disarm();
  refreshServerPlans();
}, { armedLabel: 'Tap again to delete' });
// The confirmation names both copies when there are two.
$('#plan-delete').addEventListener('click', () => {
  if ($('#plan-delete').classList.contains('is-danger') && serverMode && plan?.server?.id) {
    $('#plan-delete').textContent = 'Tap again: delete here and on the server';
  }
});

// --- boot --------------------------------------------------------------------

function renderAll() {
  creatingClass = false;   // a half-typed new class belongs to the lecture it was typed on
  renderHeader();
  renderOrder();
  renderTimers();
  renderAutoLaunch();
  renderEditor();
  renderSize();
  renderPlanList();
  renderSync();
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
  markBooted();
} catch (err) {
  warn(`Plans cannot be stored in this browser: ${err.message} You can still build one and save it to a file, but it will not be here when you come back.`);
  plan = emptyPlan();
  renderAll();
  markBooted();
}

// A tab being closed or backgrounded must not take the last few seconds of
// typing with it. visibilitychange is the one that actually fires reliably on
// iOS and on a phone being locked; beforeunload covers the desktop close.
document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) commit(); });
window.addEventListener('beforeunload', () => { if (saveTimer) commit(); });
