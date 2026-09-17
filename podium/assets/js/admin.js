// The admin page: the library, from a machine with a keyboard.
//
// Everything here is server-backed by definition, so the page begins by asking
// what it is talking to and shows one of two things: the library, or an
// explanation that there is nothing to manage. No half-working middle state.

import { $, el } from './util.js';
import { serverInfo, mountSessionBadge } from './server.js';

mountSessionBadge($('#session-badge'));

let items = [];
let courses = [];
let me = null;

const bytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function say(text, bad = false) {
  const note = $('#up-note');
  note.textContent = text;
  note.classList.toggle('is-bad', bad);
}

/**
 * Who may remove a given item, worked out the same way the server does so the
 * button is not offered where the answer would be 403. The server decides for
 * real; this only decides what to draw.
 */
function mayDelete(item) {
  if (!me) return false;
  if (me.isAdmin || item.createdBy === me.id) return true;
  return courses.some((course) => course.code === item.course && course.role === 'owner');
}

function render() {
  const filter = $('#lib-search').value.trim().toLowerCase();
  const list = $('#items');
  list.replaceChildren();

  const shown = items.filter((item) => !filter
    || `${item.title} ${item.type} ${item.course || ''} ${item.group || ''}`.toLowerCase().includes(filter));

  if (!shown.length) {
    list.append(el('p', { class: 'hint' },
      items.length ? 'Nothing matches that.' : 'Nothing uploaded yet.'));
    return;
  }

  for (const item of shown) {
    const row = el('div', { class: 'admin-row' },
      el('span', { class: 'admin-title' }, item.title),
      el('span', { class: 'admin-meta' },
        [item.type, item.course, item.group, item.bytes ? bytes(item.bytes) : '']
          .filter(Boolean).join(' · ')));
    if (mayDelete(item)) {
      row.append(el('button', {
        class: 'admin-del',
        type: 'button',
        title: `Remove ${item.title}`,
        onclick: () => remove(item, row),
      }, 'Remove'));
    }
    list.append(row);
  }
}

// Two taps, because this is the one irreversible thing on the page and it is a
// shared library: the first tap turns the button into the question.
function remove(item, row) {
  const button = row.querySelector('.admin-del');
  if (button.dataset.armed !== 'yes') {
    button.dataset.armed = 'yes';
    button.textContent = 'Really remove?';
    setTimeout(() => {
      if (!button.isConnected) return;
      button.dataset.armed = '';
      button.textContent = 'Remove';
    }, 4000);
    return;
  }
  button.disabled = true;
  fetch(`/api/library/${item.id}`, { method: 'DELETE', credentials: 'same-origin' })
    .then((res) => res.json().then((body) => {
      if (!res.ok) throw new Error(body.error || 'could not remove it');
      items = items.filter((i) => i.id !== item.id);
      render();
      refresh();
    }))
    .catch((err) => {
      button.disabled = false;
      button.textContent = 'Remove';
      say(err.message, true);
    });
}

async function refresh() {
  const res = await fetch('/api/library', { credentials: 'same-origin' });
  if (!res.ok) return;
  const data = await res.json();
  items = data.items || [];
  courses = data.courses || [];

  $('#usage').textContent = data.usage?.files
    ? `${data.usage.files} file${data.usage.files === 1 ? '' : 's'}, ${bytes(data.usage.bytes)} on disk.`
    : '';
  $('#upload-help').textContent =
    `Up to ${Math.round((data.limits?.uploadBytes || 0) / 1024 / 1024)} MB. `
    + `Accepted: ${(data.limits?.extensions || []).join(' ')}`;

  const select = $('#up-course');
  const chosen = select.value;
  select.replaceChildren(el('option', { value: '' }, 'Everyone on this server'));
  for (const course of courses) {
    select.append(el('option', { value: course.code }, course.title || course.code));
  }
  select.value = chosen;

  render();
}

async function upload() {
  const file = $('#up-file').files?.[0];
  if (!file) { say('Pick a file first.', true); return; }
  $('#up-go').disabled = true;
  say(`Uploading ${file.name}…`);

  // The file IS the body. No multipart: the three strings that go with it fit
  // in a query string, and parsing multipart by hand to carry them would be
  // the largest thing in this repository with no dependencies.
  const params = new URLSearchParams({
    filename: file.name,
    title: $('#up-title').value.trim(),
    course: $('#up-course').value,
    group: $('#up-group').value.trim(),
  });
  try {
    const res = await fetch(`/api/library/upload?${params}`, {
      method: 'POST',
      credentials: 'same-origin',
      body: file,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'that did not work');
    say(`Added ${body.item.title}.`);
    $('#up-file').value = '';
    $('#up-title').value = '';
    await refresh();
  } catch (err) {
    say(err.message, true);
  } finally {
    $('#up-go').disabled = false;
  }
}

const info = await serverInfo();
if (!info.features.includes('library')) {
  $('#no-server').hidden = false;
} else {
  me = info.user;
  $('#admin').hidden = false;
  $('#up-go').addEventListener('click', upload);
  $('#lib-search').addEventListener('input', render);
  await refresh();
}
