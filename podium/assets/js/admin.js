// The admin page: the library, from a machine with a keyboard.
//
// Everything here is server-backed by definition, so the page begins by asking
// what it is talking to and shows one of two things: the library, or an
// explanation that there is nothing to manage. No half-working middle state.

import { $, el } from './util.js';
import { serverInfo, mountSessionBadge } from './server.js';
import { createZip } from './zip.js';
import { versionStamp } from './protocol.js';

mountSessionBadge($('#session-badge'));
const stampEl = $('#admin-version-stamp');
if (stampEl) stampEl.textContent = versionStamp();

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
let sessionUsage = null;

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
  // A split layout's other panels, recorded alongside panel A rather than as
  // events of their own - see noteSurface in display.js.
  if (event.detail?.panels?.length) {
    const labels = ['B', 'C', 'D'];
    bits.push(event.detail.panels.map((p, i) => `${labels[i] || '?'}: ${p.title || p.type || '—'}`).join(', '));
  }
  return bits.join(' · ');
}

const safeName = (detail) => String(detail.title || detail.room || 'session')
  .replace(/[^a-z0-9-_ ]+/gi, '').trim().replace(/\s+/g, '-')
  .slice(0, 48)
  .toLowerCase() || 'session';

/**
 * The session zip, rebuilt from what the lecture kept.
 *
 * The same files the controller put in the zip it handed you on the day - the
 * photos, the annotated slides, the boards, the poll CSVs, session.txt - packed
 * again here by the same writer, in a browser that was never in the room. That
 * is the whole point of phase 4b: the record stops depending on which tablet
 * was in whose hand when somebody remembered to press Export.
 */
async function downloadSessionZip(detail, button) {
  button.disabled = true;
  const was = button.textContent;
  try {
    // ink.json is the display's own raw strokes, filed at stand-down for the
    // Ink tool to reload later - exportSession() never puts it in a zip (it
    // rasterizes ink into the slides/boards PNGs instead), so "the same files
    // the controller put in the zip" has to leave it out too, or this ends up
    // rebuilding a zip the original export never produced.
    const sourceFiles = detail.files.filter((f) => f.kind !== 'ink');
    const files = [];
    for (const file of sourceFiles) {
      button.textContent = `Fetching ${files.length + 1} of ${sourceFiles.length}…`;
      const res = await fetch(file.url, { credentials: 'same-origin' });
      if (!res.ok) continue;           // named in the summary below rather than failing the lot
      files.push({ name: file.name, data: new Uint8Array(await res.arrayBuffer()) });
    }
    if (!files.length) { button.textContent = 'Nothing could be fetched'; return; }
    if (files.length < sourceFiles.length) {
      files.push({
        name: 'missing.txt',
        data: new TextEncoder().encode(
          `${sourceFiles.length - files.length} of this session's files could not be read back.\n`),
      });
    }
    button.textContent = 'Building the zip…';
    const stamp = new Date(detail.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const blob = await createZip(files);
    const a = el('a', { href: URL.createObjectURL(blob), download: `podium-${safeName(detail)}-${stamp}.zip` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch {
    button.textContent = 'That did not work';
    return;
  } finally {
    button.disabled = false;
  }
  button.textContent = was;
}

function renderSessionBody(detail) {
  const body = el('div', { class: 'session-body' });

  const actions = el('div', { class: 'admin-actions' },
    el('button', {
      class: 'admin-small', type: 'button',
      onclick: () => download(`podium-${detail.id}-timeline.txt`, timelineText(detail), 'text/plain'),
    }, 'Download the timeline'));

  if (detail.files.length) {
    const kept = detail.files.reduce((sum, file) => sum + file.bytes, 0);
    actions.append(el('button', {
      class: 'admin-small', type: 'button',
      onclick: (ev) => downloadSessionZip(detail, ev.target),
    }, `Download the session (${detail.files.length} files, ${bytes(kept)})`));
  }
  for (const poll of detail.pollResults) {
    actions.append(el('button', {
      class: 'admin-small', type: 'button',
      title: poll.question,
      onclick: () => download(`poll-${detail.id}-${poll.pollId}.csv`, csvText(pollCsvRows(poll)), 'text/csv'),
    }, `Poll CSV · ${poll.voters} voted`));
  }
  body.append(actions);

  // A lecture can hold a poll result or kept files with no timeline event at
  // all - polls and file uploads are recorded independently of the timeline
  // (see appendEvents/recordPoll/addFile in lectures.js) - so "no timeline"
  // is not "nothing happened". Only say that when there is truly nothing
  // else to show either; either way, the summaries below still run.
  if (detail.timeline.length) {
    const list = el('div', { class: 'timeline' });
    for (const event of detail.timeline) {
      list.append(el('div', { class: 'timeline-row' },
        el('span', { class: 'timeline-at' }, clock(event.at)),
        el('span', { class: 'timeline-what' }, event.title || '—'),
        el('span', { class: 'timeline-note' }, describe(event))));
    }
    body.append(list);
  } else if (!detail.files.length && !detail.pollResults.length) {
    body.append(el('p', { class: 'hint' }, 'Nothing was recorded for this one.'));
  }

  if (detail.files.length) {
    const photos = detail.files.filter((f) => f.kind === 'photo').length;
    const ink = detail.files.some((f) => f.kind === 'ink');
    body.append(el('p', { class: 'hint' },
      [`${detail.files.length} file${detail.files.length === 1 ? '' : 's'} kept`,
        photos ? `${photos} photo${photos === 1 ? '' : 's'}` : '',
        ink ? 'the ink' : ''].filter(Boolean).join(' · ')));
  }

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

function renameSession(lecture, value, field) {
  const title = value.trim();
  if (title === (lecture.title || '')) return;
  fetch(`/api/lectures/${lecture.id}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  }).then((res) => {
    if (!res.ok) throw new Error('rejected');
    lecture.title = title;
  }).catch(() => {
    // A 403 (a member other than the runner, somehow reaching a control that
    // should not be theirs) or a dropped connection both land here: the
    // server never actually saved this, so the field showing it as saved
    // would be a lie. Put back what it actually is rather than what was typed.
    if (field) field.value = lecture.title || '';
  });
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
    ? `${lectures.length} session${lectures.length === 1 ? '' : 's'} recorded`
      + (sessionUsage?.files ? `, keeping ${sessionUsage.files} file${sessionUsage.files === 1 ? '' : 's'} `
        + `(${bytes(sessionUsage.bytes)}) of photos, ink and exported pages.` : '.')
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
        onchange: (ev) => renameSession(lecture, ev.target.value, ev.target),
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
  const data = await res.json();
  lectures = data.lectures || [];
  sessionUsage = data.usage || null;
  renderSessions();
}

// --- people ------------------------------------------------------------------
//
// Administrators only, and the card is absent rather than disabled for everyone
// else: a page full of controls that all answer 403 tells you less than a page
// that simply does not offer them.
//
// Every rule enforced here is enforced again on the server (see changePerson in
// api.js). This decides what to draw; that decides what happens.

let people = [];

const when = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function sayPeople(text, bad = false) {
  const note = $('#people-note');
  note.textContent = text;
  note.classList.toggle('is-bad', bad);
}

async function patchPerson(person, body, row) {
  row?.classList.add('is-busy');
  try {
    const res = await fetch(`/api/people/${encodeURIComponent(person.username)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(answer.error || 'that did not work');
    sayPeople(`Saved ${person.username}.`);
    await refreshPeople();
  } catch (err) {
    sayPeople(err.message, true);
    renderPeople();            // put the checkbox back where the server thinks it is
  }
}

function renderPeople() {
  const filter = $('#people-search').value.trim().toLowerCase();
  const holder = $('#people');
  holder.replaceChildren();

  const shown = people.filter((person) => !filter
    || `${person.username} ${person.displayName}`.toLowerCase().includes(filter));
  if (!shown.length) {
    holder.append(el('p', { class: 'hint' }, people.length ? 'Nothing matches that.' : 'No accounts yet.'));
    return;
  }

  for (const person of shown) {
    const row = el('div', { class: 'admin-row' });
    row.append(el('span', { class: 'admin-title' },
      person.displayName === person.username ? person.username : `${person.displayName} (${person.username})`));
    row.append(el('span', { class: 'admin-meta' },
      [person.disabled ? 'disabled' : '',
        // Active sessions, not devices: signing in twice from the same
        // browser (a token that expired, a second tab) counts twice here,
        // the same as two different devices would - see accounts.js.
        person.activeSessions ? `${person.activeSessions} active session${person.activeSessions === 1 ? '' : 's'}` : '',
        person.lastSeen ? `last seen ${when(person.lastSeen)}` : 'never signed in',
        `added ${when(person.createdAt)}`].filter(Boolean).join(' · ')));

    // Yourself, in a list of accounts: the two switches that could sign you out
    // of the page you are standing on are not offered at all.
    const isMe = person.id === me?.id;
    row.append(el('label', { class: 'check', title: 'Can manage people, courses and settings' },
      el('input', {
        type: 'checkbox',
        checked: person.isAdmin,
        disabled: isMe,
        onchange: (ev) => patchPerson(person, { isAdmin: ev.target.checked }, row),
      }), ' admin'));
    row.append(el('button', {
      class: 'admin-small', type: 'button',
      onclick: () => changePassword(person),
    }, 'Set a password'));
    if (!isMe) {
      row.append(el('button', {
        class: 'admin-small', type: 'button',
        onclick: () => patchPerson(person, { disabled: !person.disabled }, row),
      }, person.disabled ? 'Enable' : 'Disable'));
    }
    holder.append(row);
  }
}

// Deliberately a prompt rather than a field on every row: setting somebody
// else's password is a rare, deliberate act, and a page carrying a dozen empty
// password boxes invites a browser to fill one of them in.
function changePassword(person) {
  // eslint-disable-next-line no-alert
  const password = prompt(`A new password for ${person.username}. Every device it is signed in on will be signed out.`);
  if (password === null) return;
  if (password.length < 8) { sayPeople('A password has to be at least 8 characters.', true); return; }
  patchPerson(person, { password });
}

async function addPerson() {
  const username = $('#new-user').value.trim();
  const password = $('#new-pass').value;
  if (!username || password.length < 8) {
    sayPeople('A username and a password of at least 8 characters, please.', true);
    return;
  }
  $('#new-user-go').disabled = true;
  try {
    const res = await fetch('/api/people', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username, password, displayName: $('#new-name').value.trim(), isAdmin: $('#new-admin').checked,
      }),
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(answer.error || 'that did not work');
    sayPeople(`Added ${answer.person.username}.`);
    for (const id of ['#new-user', '#new-name', '#new-pass']) $(id).value = '';
    $('#new-admin').checked = false;
    await refreshPeople();
  } catch (err) {
    sayPeople(err.message, true);
  } finally {
    $('#new-user-go').disabled = false;
  }
}

async function refreshPeople() {
  const res = await fetch('/api/people', { credentials: 'same-origin' });
  if (!res.ok) return;
  people = (await res.json()).people || [];
  renderPeople();
}

// --- courses, membership, and the room each one connects to -------------------
//
// A course is the only unit of sharing Podium has: a library item filed under
// one is visible to its members, a plan filed under one is shared with them, the
// room named in its settings hands them the passphrase, and a lecture held in
// that room is filed there. So this panel is where somebody joining a course
// actually gets everything, in one act.

let serverCourses = [];
let openCourse = null;

function sayCourses(text, bad = false) {
  const note = $('#courses-note');
  note.textContent = text;
  note.classList.toggle('is-bad', bad);
}

async function courseApi(path, options = {}) {
  const res = await fetch(`/api/courses${path}`, {
    credentials: 'same-origin',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(answer.error || 'that did not work');
  return answer;
}

const SETTING_FIELDS = [
  ['transport', 'Connection', 'ws / mqtt / supabase'],
  ['room', 'Room', 'psy415-live'],
  ['passphrase', 'Passphrase', ''],
  ['wsUrl', 'WebSocket URL', 'wss://podium.example.com/podium'],
  ['mqttUrl', 'Broker URL', ''],
  ['supabaseUrl', 'Supabase URL', ''],
  ['supabaseKey', 'Supabase key', ''],
];

/**
 * The room a course connects to, which is the thing that turns "add Sam to
 * PSY 415" into "Sam's iPad sets itself up by logging in".
 *
 * The passphrase is in here in plain sight, and that is what it is for - anyone
 * who can open this panel can already read it through /api/settings, because
 * being able to manage the course is being handed the key. Rotating it is how
 * you take it back from someone who has left.
 */
function renderCourseSettings(course, settings) {
  const form = el('div', { class: 'admin-form' });
  for (const [key, label, placeholder] of SETTING_FIELDS) {
    form.append(el('label', { class: 'field' },
      el('span', {}, label),
      el('input', {
        type: 'text', 'data-setting': key, value: settings[key] || '',
        placeholder, autocomplete: 'off', spellcheck: 'false',
      })));
  }
  const status = el('span', { class: 'hint', role: 'status' });

  // Shared by both buttons below: whatever is in the form right now, sent as
  // one PUT. "New passphrase" advertises itself as a one-button rotation (see
  // the PR/VPS.md), which means it has to actually save, not just fill the
  // field in and leave the old passphrase live until someone notices and
  // clicks Save separately.
  async function saveSettings(savingText, savedText) {
    const wanted = {};
    for (const input of form.querySelectorAll('[data-setting]')) {
      if (input.value.trim()) wanted[input.dataset.setting] = input.value.trim();
    }
    save.disabled = true;
    rotate.disabled = true;
    status.textContent = savingText;
    try {
      await fetch(`/api/settings/${encodeURIComponent(course.code)}`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: wanted }),
      }).then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'that did not work');
      });
      // Without this, courseSettings still holds what refreshCourses() last
      // fetched: closing and reopening this course would re-render the form
      // from that stale snapshot, showing a passphrase that was just
      // rotated as the old one - and saving again from there would send it
      // straight back to the server, undoing the rotation.
      courseSettings[course.code] = wanted;
      status.textContent = savedText;
    } catch (err) {
      status.textContent = err.message;
    } finally {
      save.disabled = false;
      rotate.disabled = false;
    }
  }

  const save = el('button', {
    class: 'admin-small', type: 'button',
    onclick: () => saveSettings('Saving…', 'Saved — devices pick it up the next time they sign in.'),
  }, 'Save the connection');

  const rotate = el('button', {
    class: 'admin-small', type: 'button',
    title: 'A new passphrase, which is how you take the room back from a device that has left',
    onclick: () => {
      const field = form.querySelector('[data-setting="passphrase"]');
      field.value = [...crypto.getRandomValues(new Uint8Array(8))]
        .map((n) => 'abcdefghijkmnopqrstuvwxyz23456789'[n % 33]).join('');
      saveSettings('Saving the new passphrase…', 'New passphrase saved — re-pair every device.');
    },
  }, 'New passphrase');

  return el('div', {}, form, el('div', { class: 'admin-actions' }, save, rotate, status));
}

function renderCourseBody(course) {
  const body = el('div', { class: 'session-body' });

  for (const person of course.people || []) {
    const row = el('div', { class: 'admin-row' },
      el('span', { class: 'admin-title' }, `${person.displayName} (${person.username})`),
      el('span', { class: 'admin-meta' }, [person.role, person.disabled ? 'disabled' : ''].filter(Boolean).join(' · ')),
      el('button', {
        class: 'admin-small', type: 'button',
        onclick: () => withCourse(() => courseApi(
          `/${encodeURIComponent(course.code)}/members`,
          { method: 'POST', body: JSON.stringify({ username: person.username, role: person.role === 'owner' ? 'member' : 'owner' }) },
        )),
      }, person.role === 'owner' ? 'Make a member' : 'Make an owner'),
      el('button', {
        class: 'admin-del', type: 'button',
        onclick: () => withCourse(() => courseApi(
          `/${encodeURIComponent(course.code)}/members/${encodeURIComponent(person.username)}`,
          { method: 'DELETE' },
        )),
      }, 'Remove'));
    body.append(row);
  }
  if (!course.people?.length) body.append(el('p', { class: 'hint' }, 'Nobody is in this course yet.'));

  const pick = el('select', {}, el('option', { value: '' }, 'Add somebody…'));
  for (const person of people.filter((p) => !(course.people || []).some((m) => m.username === p.username))) {
    pick.append(el('option', { value: person.username }, `${person.displayName} (${person.username})`));
  }
  // Only an administrator is handed the list of every account; a course owner
  // who is not one adds by typing a username they already know.
  const typed = el('input', { type: 'text', placeholder: 'username', autocomplete: 'off', spellcheck: 'false' });
  const add = el('button', {
    class: 'admin-small', type: 'button',
    onclick: () => {
      const username = (me?.isAdmin ? pick.value : typed.value.trim());
      if (!username) return;
      withCourse(() => courseApi(`/${encodeURIComponent(course.code)}/members`,
        { method: 'POST', body: JSON.stringify({ username, role: 'member' }) }));
    },
  }, 'Add to the course');
  body.append(el('div', { class: 'admin-actions' }, me?.isAdmin ? pick : typed, add));

  body.append(el('h3', { class: 'hint', style: 'margin:14px 0 0' }, 'What a device that signs in gets'));
  body.append(renderCourseSettings(course, courseSettings[course.code] || {}));
  return body;
}

async function withCourse(work) {
  try {
    await work();
    sayCourses('');
    await refreshCourses();
  } catch (err) {
    sayCourses(err.message, true);
  }
}

function renderCourses() {
  const holder = $('#courses');
  holder.replaceChildren();
  $('#new-course-row').hidden = !me?.isAdmin;

  if (!serverCourses.length) {
    holder.append(el('p', { class: 'hint' }, me?.isAdmin
      ? 'No courses yet. A course is how you share a library, a plan and a room with somebody.'
      : 'You are not in any courses yet.'));
    return;
  }

  for (const course of serverCourses) {
    const row = el('div', { class: 'admin-row' },
      el('span', { class: 'admin-title' }, course.title),
      el('span', { class: 'admin-meta' },
        [course.code, `${course.members} member${course.members === 1 ? '' : 's'}`,
          course.role, course.archived ? 'archived' : ''].filter(Boolean).join(' · ')));
    if (course.people) {
      row.append(el('button', {
        class: 'admin-small', type: 'button',
        onclick: () => { openCourse = openCourse === course.code ? null : course.code; renderCourses(); },
      }, openCourse === course.code ? 'Close' : 'Open'));
    }
    if (me?.isAdmin) {
      row.append(el('button', {
        class: 'admin-small', type: 'button',
        title: 'Archived courses keep everything filed under them and simply stop being listed',
        onclick: () => withCourse(() => courseApi(`/${encodeURIComponent(course.code)}`,
          { method: 'PATCH', body: JSON.stringify({ archived: !course.archived }) })),
      }, course.archived ? 'Bring back' : 'Archive'));
    }
    holder.append(row);
    if (openCourse === course.code) holder.append(renderCourseBody(course));
  }
}

async function addCourse() {
  const code = $('#new-course').value.trim();
  if (!code) { sayCourses('A course needs a code.', true); return; }
  $('#new-course-go').disabled = true;
  try {
    await courseApi('', { method: 'POST', body: JSON.stringify({ code, title: $('#new-course-title').value.trim() }) });
    $('#new-course').value = '';
    $('#new-course-title').value = '';
    sayCourses(`Added ${code.toLowerCase()}.`);
    await refreshCourses();
  } catch (err) {
    sayCourses(err.message, true);
  } finally {
    $('#new-course-go').disabled = false;
  }
}

let courseSettings = {};

async function refreshCourses() {
  const [list, settings] = await Promise.all([
    fetch('/api/courses', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : { courses: [] })),
    // ?archived=1 so an admin managing an archived course's row sees its real
    // stored settings instead of a blank form - the server only honours this
    // for an admin, and a blank form saved back would otherwise wipe the
    // room/transport/passphrase the read never showed (see forUser's own
    // comment in settings.js).
    fetch('/api/settings?archived=1', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : { courses: [] })),
  ]);
  serverCourses = list.courses || [];
  courseSettings = Object.fromEntries((settings.courses || []).map((row) => [row.course, row.settings]));
  renderCourses();
}

// --- what the box is holding --------------------------------------------------

async function refreshStorage() {
  const res = await fetch('/api/storage', { credentials: 'same-origin' });
  if (!res.ok) return;
  const held = await res.json();
  $('#storage-note').textContent = [
    `Library: ${held.library.files} file${held.library.files === 1 ? '' : 's'}, ${bytes(held.library.bytes)}`,
    `sessions: ${held.sessions.files} file${held.sessions.files === 1 ? '' : 's'}, ${bytes(held.sessions.bytes)}`,
    `database: ${bytes(held.database)}`,
    held.retentionDays
      ? `session files are kept for ${held.retentionDays} days`
      : 'session files are kept indefinitely',
  ].join(' · ') + `. All of it under ${held.dataDir}.`;
}

function downloadBackup() {
  // A plain navigation rather than fetch-then-blob: the file is the whole
  // database and holding a second copy of it in the tab's memory to hand it
  // straight back to the disk would be a strange thing to do.
  $('#backup-note').textContent = 'Taking a snapshot…';
  location.href = '/api/backup';
  setTimeout(() => { $('#backup-note').textContent = ''; }, 6000);
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

  // Courses are everyone's (you see the ones you are in); people and storage
  // are an administrator's. Each card appears only where it would work.
  if (info.features.includes('people')) {
    $('#courses-card').hidden = false;
    $('#new-course-go').addEventListener('click', addCourse);
    if (me?.isAdmin) {
      $('#people-card').hidden = false;
      $('#storage-card').hidden = false;
      $('#people-search').addEventListener('input', renderPeople);
      $('#new-user-go').addEventListener('click', addPerson);
      $('#backup-go').addEventListener('click', downloadBackup);
      await Promise.all([refreshPeople(), refreshStorage()]);
    }
    await refreshCourses();
  }
}
