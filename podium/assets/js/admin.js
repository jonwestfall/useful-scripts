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

// --- past sessions -----------------------------------------------------------
//
// The display writes a lecture's timeline as it happens (see
// server/lectures.js for why it has to be the display and not the relay), and
// a controller files each poll's final tally under the same lecture. This is
// the other end of that: what was covered, when, and what the room answered,
// long after the browser that held it has been closed.

let lectures = [];
let openLecture = null;      // { id, detail } - the one expanded below its row

const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;

const dayAndTime = (ms) => new Date(ms).toLocaleString(undefined, {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

/** How long it ran, in the units a person would say it in. */
function spanOf(lecture) {
  if (!lecture.endedAt) return 'still open';
  const minutes = Math.max(0, Math.round((lecture.endedAt - lecture.startedAt) / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)}`;
}

/** The same rule server/lectures.js enforces, so no button is offered that would 403. */
function mayEditLecture(lecture) {
  if (!me) return false;
  if (me.isAdmin || lecture.ownerId === me.id) return true;
  return courses.some((course) => course.code === lecture.course && course.role === 'owner');
}

const download = (name, text, type) => {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
};

const csvText = (rows) =>
  rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');

// Deliberately the same columns as the controller's own poll export (see
// pollResultRows in control.js): a CSV pulled out of here weeks later and one
// saved in the lecture itself should open as the same spreadsheet.
function pollCsvRows(poll) {
  const rows = [['question', poll.question]];
  if (poll.kind === 'text') {
    const hidden = new Set(poll.hiddenAnswers || []);
    rows.push(['answer', 'shown to room']);
    (poll.answers || []).forEach((answer, i) => rows.push([answer, hidden.has(i) ? 'no' : 'yes']));
  } else {
    rows.push(['option', 'votes']);
    (poll.options || []).forEach((option, i) => rows.push([option, String(poll.counts?.[i] || 0)]));
  }
  return rows;
}

function timelineText(detail) {
  const lines = [
    detail.title || dayAndTime(detail.startedAt),
    `Room: ${detail.room}${detail.course ? ` · ${detail.course}` : ''}`,
    `${dayAndTime(detail.startedAt)} — ${spanOf(detail)}`,
    '',
  ];
  for (const event of detail.timeline) {
    lines.push(`${clock(event.at)}  ${event.title}${describe(event) ? `  (${describe(event)})` : ''}`);
  }
  if (detail.truncated) {
    lines.push('', 'This timeline reached the length Podium stores and stops short of the end.');
  }
  if (detail.pollResults.length) {
    lines.push('', 'Polls:');
    for (const poll of detail.pollResults) {
      lines.push(`${clock(poll.endedAt)}  ${poll.question} — ${poll.voters} voted`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The small print after an entry's name: which slide, which page. */
function describe(event) {
  const bits = [];
  if (event.detail?.slide) bits.push(`slide ${event.detail.slide}`);
  if (event.detail?.page) bits.push(`page ${event.detail.page}`);
  if (event.detail?.type && !bits.length && event.detail.type !== 'black') bits.push(event.detail.type);
  return bits.join(' · ');
}

function renderSessionBody(detail) {
  const body = el('div', { class: 'session-body' });

  const actions = el('div', { class: 'admin-actions' },
    el('button', {
      class: 'admin-small', type: 'button',
      onclick: () => download(`podium-${detail.id}-timeline.txt`, timelineText(detail), 'text/plain'),
    }, 'Download the timeline'));
  for (const poll of detail.pollResults) {
    actions.append(el('button', {
      class: 'admin-small', type: 'button',
      title: poll.question,
      onclick: () => download(`poll-${detail.id}-${poll.pollId}.csv`, csvText(pollCsvRows(poll)), 'text/csv'),
    }, `Poll CSV · ${poll.voters} voted`));
  }
  body.append(actions);

  if (!detail.timeline.length) {
    body.append(el('p', { class: 'hint' }, 'Nothing was recorded for this one.'));
    return body;
  }

  const list = el('div', { class: 'timeline' });
  for (const event of detail.timeline) {
    list.append(el('div', { class: 'timeline-row' },
      el('span', { class: 'timeline-at' }, clock(event.at)),
      el('span', { class: 'timeline-what' }, event.title || '—'),
      el('span', { class: 'timeline-note' }, describe(event))));
  }
  body.append(list);
  if (detail.truncated) {
    body.append(el('p', { class: 'hint' },
      'This lecture recorded as much as Podium keeps, so the timeline stops before the end did.'));
  }
  return body;
}

async function toggleSession(lecture) {
  if (openLecture?.id === lecture.id) { openLecture = null; renderSessions(); return; }
  openLecture = { id: lecture.id, detail: null };
  renderSessions();
  try {
    const res = await fetch(`/api/lectures/${lecture.id}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('could not read it');
    const { lecture: detail } = await res.json();
    if (openLecture?.id === lecture.id) { openLecture.detail = detail; renderSessions(); }
  } catch {
    if (openLecture?.id === lecture.id) { openLecture = null; renderSessions(); }
  }
}

function renameSession(lecture, value) {
  const title = value.trim();
  if (title === (lecture.title || '')) return;
  fetch(`/api/lectures/${lecture.id}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then(() => { lecture.title = title; }).catch(() => { /* the field keeps what was typed */ });
}

// Two taps, same as the library: a session record cannot be got back.
function removeSession(lecture, row) {
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
  fetch(`/api/lectures/${lecture.id}`, { method: 'DELETE', credentials: 'same-origin' })
    .then((res) => { if (!res.ok) throw new Error('no'); })
    .then(() => {
      lectures = lectures.filter((l) => l.id !== lecture.id);
      if (openLecture?.id === lecture.id) openLecture = null;
      renderSessions();
    })
    .catch(() => {
      button.disabled = false;
      button.textContent = 'Remove';
    });
}

function renderSessions() {
  const filter = $('#sess-search').value.trim().toLowerCase();
  const holder = $('#sessions');
  holder.replaceChildren();

  const shown = lectures.filter((l) => !filter
    || `${l.title} ${l.room} ${l.course || ''} ${l.owner}`.toLowerCase().includes(filter));

  $('#sess-note').textContent = lectures.length
    ? `${lectures.length} session${lectures.length === 1 ? '' : 's'} recorded.`
    : 'Nothing recorded yet — a session appears here once a display goes live.';

  if (!shown.length) {
    if (lectures.length) holder.append(el('p', { class: 'hint' }, 'Nothing matches that.'));
    return;
  }

  for (const lecture of shown) {
    const when = dayAndTime(lecture.startedAt);
    const row = el('div', { class: 'admin-row' });
    if (mayEditLecture(lecture)) {
      row.append(el('input', {
        class: 'admin-name', type: 'text', value: lecture.title || '',
        placeholder: when, 'aria-label': `Name for the session on ${when}`,
        onchange: (ev) => renameSession(lecture, ev.target.value),
      }));
    } else {
      row.append(el('span', { class: 'admin-title' }, lecture.title || when));
    }
    row.append(el('span', { class: 'admin-meta' },
      [when, lecture.room, lecture.course, lecture.owner, spanOf(lecture),
        `${lecture.events} moment${lecture.events === 1 ? '' : 's'}`,
        lecture.polls ? `${lecture.polls} poll${lecture.polls === 1 ? '' : 's'}` : '']
        .filter(Boolean).join(' · ')));
    row.append(el('button', {
      class: 'admin-small', type: 'button',
      onclick: () => toggleSession(lecture),
    }, openLecture?.id === lecture.id ? 'Close' : 'Open'));
    if (mayEditLecture(lecture)) {
      row.append(el('button', {
        class: 'admin-del', type: 'button',
        title: `Remove the session on ${when}`,
        onclick: () => removeSession(lecture, row),
      }, 'Remove'));
    }
    holder.append(row);

    if (openLecture?.id === lecture.id) {
      holder.append(openLecture.detail
        ? renderSessionBody(openLecture.detail)
        : el('div', { class: 'session-body' }, el('p', { class: 'hint' }, 'Reading it…')));
    }
  }
}

async function refreshSessions() {
  const res = await fetch('/api/lectures', { credentials: 'same-origin' });
  if (!res.ok) return;
  lectures = (await res.json()).lectures || [];
  renderSessions();
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
  // Separate probe from the library's: a server could gain session records
  // without the library, and the panel stays absent rather than empty.
  if (info.features.includes('sessions')) {
    $('#sessions-card').hidden = false;
    $('#sess-search').addEventListener('input', renderSessions);
    await refreshSessions();
  }
}
