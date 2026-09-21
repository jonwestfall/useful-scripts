// The admin page: the library, from a machine with a keyboard.
//
// Everything here is server-backed by definition, so the page begins by asking
// what it is talking to and shows one of two things: the library, or an
// explanation that there is nothing to manage. No half-working middle state.

import { $, el } from './util.js';
import { serverInfo, mountSessionBadge } from './server.js';
import { createZip } from './zip.js';
import { createPdf, renderSessionPageToJpeg, renderPollPageToJpeg, loadImage } from './pdf-writer.js';
import { versionStamp } from './protocol.js';
import { TYPES } from './renderers.js';

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
  const nameLabel = poll.namePrompt || 'Name';
  const hasNamedResponses = Array.isArray(poll.responses) && poll.responses.some((r) => r.name);

  if (poll.kind === 'text') {
    const hidden = new Set(poll.hiddenAnswers || []);
    if (hasNamedResponses) {
      rows.push([nameLabel, 'answer', 'shown to room']);
      poll.responses.forEach((resp, i) => {
        rows.push([resp.name || '(Anonymous)', resp.answer, hidden.has(i) ? 'no' : 'yes']);
      });
    } else {
      rows.push(['answer', 'shown to room']);
      (poll.answers || []).forEach((answer, i) => rows.push([answer, hidden.has(i) ? 'no' : 'yes']));
    }
  } else {
    rows.push(['option', 'votes']);
    (poll.options || []).forEach((option, i) => rows.push([option, String(poll.counts?.[i] || 0)]));
    if (hasNamedResponses) {
      rows.push([]);
      rows.push([nameLabel, 'choice', 'option']);
      poll.responses.forEach((resp) => {
        const optIdx = typeof resp.answer === 'number' ? resp.answer : -1;
        const optText = optIdx >= 0 && poll.options?.[optIdx] ? poll.options[optIdx] : String(resp.answer ?? '');
        const letter = optIdx >= 0 ? String.fromCharCode(65 + optIdx) : '';
        rows.push([resp.name || '(Anonymous)', letter, optText]);
      });
    }
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

async function downloadSessionPdf(detail, button) {
  button.disabled = true;
  const was = button.textContent;
  try {
    const imageFiles = (detail.files || []).filter((f) =>
      f.name.startsWith('photos/') || f.name.startsWith('slides/') || f.name.startsWith('boards/'));
    const pollResults = detail.pollResults || [];
    const totalPages = imageFiles.length + pollResults.length;

    if (!totalPages) {
      button.textContent = 'No pages to export';
      setTimeout(() => { if (button.isConnected) { button.textContent = was; button.disabled = false; } }, 2000);
      return;
    }

    const meta = {
      title: detail.title || detail.room || 'Podium Session',
      course: detail.course || '',
      room: detail.room || '',
      date: detail.startedAt ? new Date(detail.startedAt) : new Date(),
    };

    const pages = [];
    let pageNum = 1;
    for (const file of imageFiles) {
      button.textContent = `Rendering page ${pageNum} of ${totalPages}…`;
      const res = await fetch(file.url, { credentials: 'same-origin' });
      if (!res.ok) continue;
      const blob = await res.blob();
      const img = await loadImage(blob);

      let itemType = 'Image';
      let itemTitle = file.name;
      if (file.name.startsWith('slides/')) {
        itemType = 'Slide';
        const match = file.name.match(/slide-(\d+)\.png/);
        itemTitle = match ? `Slide ${parseInt(match[1], 10)}` : 'Slide';
      } else if (file.name.startsWith('boards/')) {
        itemType = 'Board';
        itemTitle = 'Whiteboard / Chalkboard';
      } else if (file.name.startsWith('photos/')) {
        itemType = 'Photo';
        itemTitle = 'Photo capture';
      }

      const jpegPage = await renderSessionPageToJpeg(img, { ...meta, itemTitle, itemType }, pageNum, totalPages);
      pages.push(jpegPage);
      pageNum++;
    }

    for (const poll of pollResults) {
      button.textContent = `Rendering poll ${pageNum} of ${totalPages}…`;
      const jpegPage = await renderPollPageToJpeg(poll, meta, pageNum, totalPages);
      pages.push(jpegPage);
      pageNum++;
    }

    if (!pages.length) {
      button.textContent = 'Nothing could be rendered';
      return;
    }

    button.textContent = 'Building the PDF…';
    const stamp = new Date(detail.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const blob = createPdf(pages, meta);
    const a = el('a', { href: URL.createObjectURL(blob), download: `podium-${safeName(detail)}-${stamp}.pdf` });
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
  if (detail.files.length || detail.pollResults?.length) {
    actions.append(el('button', {
      class: 'admin-small', type: 'button',
      onclick: (ev) => downloadSessionPdf(detail, ev.target),
    }, 'Download as PDF'));
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

async function refreshSystemSettings() {
  const check = $('#allow-poll-names-check');
  if (!check) return;
  try {
    const res = await fetch('/api/system/settings', { credentials: 'same-origin' });
    if (!res.ok) return;
    const body = await res.json();
    check.checked = !!body.allowPollNames;
  } catch { /* ignore */ }
}

async function updateAllowPollNames(ev) {
  const checked = ev.target.checked;
  const status = $('#system-settings-status');
  if (status) status.textContent = 'Saving…';
  try {
    const res = await fetch('/api/system/settings', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowPollNames: checked }),
    });
    if (res.ok) {
      if (status) {
        status.textContent = 'Saved — controllers can now ask for participant names.';
        setTimeout(() => { if (status.textContent.startsWith('Saved')) status.textContent = ''; }, 4000);
      }
    } else {
      if (status) status.textContent = 'Could not save setting.';
    }
  } catch {
    if (status) status.textContent = 'Could not reach server.';
  }
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

// --- content management (Issue #54) -------------------------------------------

let manifestData = { examplesEnabled: true, builtIns: {}, items: [] };
let editingManifestIndex = -1;

let themesData = [];
let previewDeckMd = '';
let marpEnginePromise = null;
let previewDebounceTimer = null;

let contentFilesData = [];
let activeFileCategory = '';

let musicData = { _comment: '', playlists: [] };

function setupSubtabs() {
  const tabs = document.querySelectorAll('.content-subtab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.content-tab-pane').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      const pane = document.getElementById(tab.dataset.pane);
      if (pane) pane.classList.add('active');
    });
  });
}

// 1. Manifest
async function refreshManifest() {
  try {
    const res = await fetch('/api/content/manifest', { credentials: 'same-origin' });
    if (!res.ok) return;
    const body = await res.json();
    manifestData = body.manifest || { examplesEnabled: true, builtIns: {}, items: [] };
    if (!Array.isArray(manifestData.items)) manifestData.items = [];

    $('#manifest-examples-check').checked = manifestData.examplesEnabled !== false;
    const bi = manifestData.builtIns || {};
    $('#builtin-black').checked = bi.black !== false;
    $('#builtin-whiteboard').checked = bi.whiteboard !== false;
    $('#builtin-chalkboard').checked = bi.chalkboard !== false;
    $('#builtin-camera').checked = bi.camera !== false;
    $('#builtin-timer').checked = bi.timer !== false;
    $('#builtin-trackend').checked = bi.trackend !== false;

    renderManifestItems();
  } catch (err) {
    $('#manifest-status').textContent = `Could not load manifest: ${err.message}`;
  }
}

function renderManifestItems() {
  const list = $('#manifest-items-list');
  list.replaceChildren();

  if (!manifestData.items.length) {
    list.append(el('p', { class: 'hint' }, 'No manifest items configured yet.'));
    return;
  }

  manifestData.items.forEach((item, idx) => {
    const typeSpec = TYPES[item.type] || { icon: '📄', label: item.type };
    const isEnabled = item.enabled !== false;

    const row = el('div', { class: 'admin-row', style: isEnabled ? '' : 'opacity:0.6;' },
      el('span', { style: 'font-size:16px; margin-right:4px;' }, typeSpec.icon),
      el('span', { class: 'admin-title' },
        el('strong', {}, item.title || '(untitled)'),
        el('span', { class: 'admin-meta', style: 'margin-left:8px;' },
          [typeSpec.label, item.group, item.order !== undefined ? `#${item.order}` : '', item.src || ''].filter(Boolean).join(' · '))
      ),
      el('button', {
        type: 'button',
        class: 'admin-small',
        title: isEnabled ? 'Click to disable' : 'Click to enable',
        onclick: () => {
          item.enabled = !isEnabled;
          renderManifestItems();
        },
      }, isEnabled ? 'Enabled' : 'Disabled'),
      el('button', {
        type: 'button',
        class: 'admin-small',
        disabled: idx === 0,
        title: 'Move up',
        onclick: () => {
          const prev = manifestData.items[idx - 1];
          manifestData.items[idx - 1] = item;
          manifestData.items[idx] = prev;
          renderManifestItems();
        },
      }, '↑'),
      el('button', {
        type: 'button',
        class: 'admin-small',
        disabled: idx === manifestData.items.length - 1,
        title: 'Move down',
        onclick: () => {
          const next = manifestData.items[idx + 1];
          manifestData.items[idx + 1] = item;
          manifestData.items[idx] = next;
          renderManifestItems();
        },
      }, '↓'),
      el('button', {
        type: 'button',
        class: 'admin-small',
        onclick: () => openManifestForm(idx),
      }, 'Edit'),
      el('button', {
        type: 'button',
        class: 'admin-del',
        onclick: (e) => removeManifestItem(idx, e.currentTarget),
      }, 'Remove')
    );

    list.append(row);
  });
}

function openManifestForm(idx = -1) {
  editingManifestIndex = idx;
  const box = $('#manifest-item-form-box');
  box.hidden = false;
  if (idx >= 0) {
    const item = manifestData.items[idx];
    $('#manifest-form-title').textContent = `Edit Manifest Item #${idx + 1}`;
    $('#m-type').value = item.type || 'deck';
    $('#m-title').value = item.title || '';
    $('#m-src').value = item.src || '';
    $('#m-group').value = item.group || '';
    $('#m-order').value = item.order !== undefined ? item.order : '';
    $('#m-note').value = item.note || '';
    $('#m-enabled').checked = item.enabled !== false;
  } else {
    $('#manifest-form-title').textContent = 'New Manifest Item';
    $('#m-type').value = 'deck';
    $('#m-title').value = '';
    $('#m-src').value = '';
    $('#m-group').value = 'Lecture';
    $('#m-order').value = '';
    $('#m-note').value = '';
    $('#m-enabled').checked = true;
  }
}

function saveManifestItemFromForm() {
  const type = $('#m-type').value;
  const title = $('#m-title').value.trim();
  if (!title) {
    alert('A title is required for this item.');
    return;
  }
  const item = {
    type,
    title,
    src: $('#m-src').value.trim() || undefined,
    group: $('#m-group').value.trim() || undefined,
    order: $('#m-order').value !== '' ? Number($('#m-order').value) : undefined,
    note: $('#m-note').value.trim() || undefined,
    enabled: $('#m-enabled').checked,
  };

  if (editingManifestIndex >= 0) {
    manifestData.items[editingManifestIndex] = item;
  } else {
    manifestData.items.push(item);
  }
  $('#manifest-item-form-box').hidden = true;
  renderManifestItems();
}

function removeManifestItem(idx, button) {
  if (button.dataset.armed !== 'yes') {
    button.dataset.armed = 'yes';
    button.textContent = 'Really?';
    setTimeout(() => {
      if (button.isConnected) {
        button.dataset.armed = '';
        button.textContent = 'Remove';
      }
    }, 4000);
    return;
  }
  manifestData.items.splice(idx, 1);
  renderManifestItems();
}

async function commitManifest() {
  const note = $('#manifest-status');
  note.textContent = 'Saving manifest…';
  note.classList.remove('is-bad');
  try {
    const payload = {
      examplesEnabled: $('#manifest-examples-check').checked,
      builtIns: {
        black: $('#builtin-black').checked,
        whiteboard: $('#builtin-whiteboard').checked,
        chalkboard: $('#builtin-chalkboard').checked,
        camera: $('#builtin-camera').checked,
        timer: $('#builtin-timer').checked,
        trackend: $('#builtin-trackend').checked,
      },
      items: manifestData.items,
    };
    const res = await fetch('/api/content/manifest', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: payload }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'could not save manifest');
    note.textContent = 'Manifest saved successfully.';
    setTimeout(() => { if (note.textContent.includes('successfully')) note.textContent = ''; }, 4000);
  } catch (err) {
    note.textContent = err.message;
    note.classList.add('is-bad');
  }
}

// 2. Marp Themes
async function getMarpEngine() {
  if (!marpEnginePromise) {
    marpEnginePromise = import('../vendor/marp.esm.js');
  }
  return marpEnginePromise;
}

async function loadPreviewDeckSource() {
  if (previewDeckMd) return previewDeckMd;
  try {
    const res = await fetch('content/decks/example-builds.md', { cache: 'no-cache' });
    if (res.ok) {
      previewDeckMd = await res.text();
      return previewDeckMd;
    }
  } catch {}
  previewDeckMd = `---
marp: true
theme: default
paginate: true
title: Progressive Builds
footer: Podium · example deck
---
<!-- _class: lead -->
# **Progressive Builds**
### Reveal one bullet at a time, PowerPoint-style

---
<!-- _class: build -->
## Opt a slide in with one directive
* First bullet point with **bold text**
* Second bullet point with \`inline code\`
* Third point showing clean typography

---
## Fine control with your own markup
A plain paragraph with normal styling.
`;
  return previewDeckMd;
}

function updateThemePreview() {
  clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(async () => {
    const statusEl = $('#theme-preview-note');
    const mount = $('#theme-preview-mount');
    if (!mount) return;
    const cssEditor = $('#theme-css-editor');
    const rawCss = cssEditor ? cssEditor.value : '';
    const slideIndex = parseInt($('#theme-preview-slide-select')?.value || '0', 10);

    try {
      const { Marp } = await getMarpEngine();
      const marp = new Marp({
        inlineSVG: true,
        html: {
          div: ['class', 'style', 'id'],
          span: ['class', 'style'],
          p: ['class', 'style'],
          section: ['class', 'style'],
          figure: ['class'], figcaption: ['class'],
          blockquote: ['class'], pre: ['class'], code: ['class'],
          h1: ['class'], h2: ['class'], h3: ['class'], h4: ['class'], h5: ['class'], h6: ['class'],
          ul: ['class'], ol: ['class', 'start'], li: ['class'],
          table: ['class'], thead: [], tbody: [], tfoot: [], tr: ['class'],
          th: ['class', 'colspan', 'rowspan', 'align'], td: ['class', 'colspan', 'rowspan', 'align'],
          a: ['href', 'title', 'target', 'rel', 'class'],
          img: ['src', 'alt', 'title', 'width', 'height', 'class', 'style'],
          b: [], i: [], em: [], strong: [], u: [], s: [], small: [], mark: [],
          sup: [], sub: [], kbd: [], abbr: ['title'], br: [], hr: ['class'],
        },
        math: 'katex',
      });

      let themeName = 'custom-theme';
      const match = rawCss.match(/@theme\s+([a-zA-Z0-9_-]+)/);
      let finalCss = rawCss;
      if (match) {
        themeName = match[1];
      } else {
        finalCss = `/* @theme ${themeName} */\n@import 'default';\n` + rawCss;
      }

      try {
        marp.themeSet.add(finalCss);
      } catch (themeErr) {
        if (statusEl) statusEl.textContent = `Theme notice: ${themeErr.message}`;
      }

      const baseDeck = await loadPreviewDeckSource();
      const customDeck = baseDeck.replace(/(theme:\s*)([^\n]+)/, `$1${themeName}`);
      const { html, css } = marp.render(customDeck);

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const svgs = doc.querySelectorAll('svg[data-marpit-svg]');
      const chosenSvg = svgs[slideIndex] || svgs[0];

      if (chosenSvg) {
        mount.innerHTML = `<style>${css}</style>${chosenSvg.outerHTML}`;
        if (statusEl && !statusEl.textContent.startsWith('Theme notice:')) {
          statusEl.textContent = 'Preview updated.';
        }
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = `Preview error: ${err.message}`;
    }
  }, 200);
}

async function refreshThemes() {
  try {
    const res = await fetch('/api/content/themes', { credentials: 'same-origin' });
    if (!res.ok) return;
    const body = await res.json();
    themesData = body.themes || [];
    renderThemes();
  } catch (err) {
    sayContent(`Could not load themes: ${err.message}`, true);
  }
}

function renderThemes() {
  const list = $('#themes-list');
  list.replaceChildren();

  if (!themesData.length) {
    list.append(el('p', { class: 'hint' }, 'No Marp themes in marp-themes/.'));
    return;
  }

  themesData.forEach((theme) => {
    const row = el('div', { class: 'admin-row' },
      el('span', { class: 'admin-title' },
        el('strong', {}, theme.filename),
        el('span', { class: 'admin-meta', style: 'margin-left:8px;' },
          [bytes(theme.size), theme.inManifest ? 'registered in themes.json' : 'not in themes.json'].join(' · '))
      ),
      el('button', {
        type: 'button',
        class: 'admin-small',
        onclick: () => openThemeEditor(theme.filename),
      }, 'Edit & Preview'),
      el('button', {
        type: 'button',
        class: 'admin-small',
        onclick: () => {
          location.href = `/api/content/themes/${encodeURIComponent(theme.filename)}?download=1`;
        },
      }, 'Download'),
      el('button', {
        type: 'button',
        class: 'admin-del',
        onclick: (e) => removeTheme(theme.filename, e.currentTarget),
      }, 'Remove')
    );
    list.append(row);
  });
}

async function openThemeEditor(filename = null) {
  const box = $('#theme-editor-box');
  const heading = $('#theme-editor-heading');
  const filenameInput = $('#theme-filename');
  const cssEditor = $('#theme-css-editor');
  box.hidden = false;

  if (filename) {
    heading.textContent = `Editing Theme: ${filename}`;
    filenameInput.value = filename;
    filenameInput.disabled = true;
    try {
      const res = await fetch(`/api/content/themes/${encodeURIComponent(filename)}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('could not read theme');
      const data = await res.json();
      cssEditor.value = data.theme?.css || '';
      updateThemePreview();
    } catch (err) {
      $('#theme-status').textContent = err.message;
    }
  } else {
    heading.textContent = 'New Marp Theme';
    filenameInput.value = 'custom.css';
    filenameInput.disabled = false;
    cssEditor.value = `/* @theme custom */\n@import 'default';\n\nsection {\n  background-color: #f7f9fc;\n  color: #1a202c;\n  font-family: system-ui, -apple-system, sans-serif;\n}\n\nh1, h2 {\n  color: #0b3954;\n}\n`;
    updateThemePreview();
  }
}

async function saveTheme() {
  const note = $('#theme-status');
  const filename = $('#theme-filename').value.trim();
  const css = $('#theme-css-editor').value;
  if (!filename.endsWith('.css')) {
    note.textContent = 'Theme filename must end with .css';
    note.classList.add('is-bad');
    return;
  }
  note.textContent = 'Saving theme…';
  note.classList.remove('is-bad');
  try {
    const res = await fetch(`/api/content/themes/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ css }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'could not save theme');
    note.textContent = `Saved ${filename} successfully.`;
    await refreshThemes();
    setTimeout(() => { if (note.textContent.includes('successfully')) note.textContent = ''; }, 4000);
  } catch (err) {
    note.textContent = err.message;
    note.classList.add('is-bad');
  }
}

function removeTheme(filename, button) {
  if (button.dataset.armed !== 'yes') {
    button.dataset.armed = 'yes';
    button.textContent = 'Really?';
    setTimeout(() => {
      if (button.isConnected) {
        button.dataset.armed = '';
        button.textContent = 'Remove';
      }
    }, 4000);
    return;
  }
  button.disabled = true;
  fetch(`/api/content/themes/${encodeURIComponent(filename)}`, { method: 'DELETE', credentials: 'same-origin' })
    .then((res) => res.json().then((body) => {
      if (!res.ok) throw new Error(body.error || 'could not delete theme');
      if ($('#theme-filename').value === filename) {
        $('#theme-editor-box').hidden = true;
      }
      refreshThemes();
    }))
    .catch((err) => {
      button.disabled = false;
      button.textContent = 'Remove';
      alert(err.message);
    });
}

// 3. Pre-load Files
async function refreshContentFiles() {
  try {
    const url = activeFileCategory
      ? `/api/content/files?category=${encodeURIComponent(activeFileCategory)}`
      : '/api/content/files';
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return;
    const body = await res.json();
    contentFilesData = body.files || [];
    renderContentFiles();
  } catch (err) {
    sayContent(`Could not load files: ${err.message}`, true);
  }
}

function renderContentFiles() {
  const list = $('#content-files-list');
  list.replaceChildren();

  const filter = ($('#file-search-input')?.value || '').trim().toLowerCase();
  const shown = contentFilesData.filter((file) => {
    if (activeFileCategory && file.category !== activeFileCategory) return false;
    if (filter && !`${file.filename} ${file.category} ${file.url}`.toLowerCase().includes(filter)) return false;
    return true;
  });

  if (!shown.length) {
    list.append(el('p', { class: 'hint' }, contentFilesData.length ? 'Nothing matches that filter.' : 'No files in this category.'));
    return;
  }

  shown.forEach((file) => {
    const row = el('div', { class: 'admin-row' },
      el('span', { class: 'admin-title' },
        el('strong', {}, file.filename),
        el('span', { class: 'admin-meta', style: 'margin-left:8px;' },
          [file.category, bytes(file.size), file.url].join(' · '))
      ),
      file.isText ? el('button', {
        type: 'button',
        class: 'admin-small',
        onclick: () => openFileEditor(file.category, file.filename),
      }, 'Edit') : null,
      el('button', {
        type: 'button',
        class: 'admin-small',
        onclick: () => {
          location.href = `/api/content/files/${encodeURIComponent(file.category)}/${encodeURIComponent(file.filename)}?download=1`;
        },
      }, 'Download'),
      el('button', {
        type: 'button',
        class: 'admin-del',
        onclick: (e) => removeContentFile(file.category, file.filename, e.currentTarget),
      }, 'Remove')
    );
    list.append(row);
  });
}

let activeEditingFile = null;
async function openFileEditor(category, filename) {
  const sheet = $('#file-editor-sheet');
  const titleEl = $('#file-editor-title');
  const pathEl = $('#file-editor-path');
  const contentEl = $('#file-editor-content');
  const statusEl = $('#file-editor-status');

  statusEl.textContent = 'Loading…';
  statusEl.classList.remove('is-bad');
  titleEl.textContent = `Edit ${filename}`;
  pathEl.textContent = `content/${category}/${filename}`;
  activeEditingFile = { category, filename };
  sheet.hidden = false;

  try {
    const res = await fetch(`/api/content/files/${encodeURIComponent(category)}/${encodeURIComponent(filename)}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not read file');
    contentEl.value = data.file?.text || '';
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.add('is-bad');
  }
}

async function saveFileEditor() {
  if (!activeEditingFile) return;
  const statusEl = $('#file-editor-status');
  statusEl.textContent = 'Saving…';
  statusEl.classList.remove('is-bad');
  try {
    const text = $('#file-editor-content').value;
    const res = await fetch(`/api/content/files/${encodeURIComponent(activeEditingFile.category)}/${encodeURIComponent(activeEditingFile.filename)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'could not save file');
    statusEl.textContent = 'Saved successfully.';
    await refreshContentFiles();
    setTimeout(() => { if (statusEl.textContent.includes('successfully')) statusEl.textContent = ''; }, 3000);
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.add('is-bad');
  }
}

async function uploadContentFile() {
  const cat = $('#file-upload-cat').value;
  const input = $('#file-upload-input');
  const status = $('#file-upload-status');
  const file = input.files[0];
  if (!file) {
    status.textContent = 'Please choose a file to upload.';
    status.classList.add('is-bad');
    return;
  }

  status.textContent = `Uploading ${file.name}…`;
  status.classList.remove('is-bad');
  $('#file-upload-btn').disabled = true;

  try {
    const res = await fetch(`/api/content/files/${encodeURIComponent(cat)}?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      body: file,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'upload failed');
    status.textContent = `Uploaded ${file.name} to ${cat}.`;
    input.value = '';
    await refreshContentFiles();
    setTimeout(() => { if (status.textContent.includes('Uploaded')) status.textContent = ''; }, 4000);
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('is-bad');
  } finally {
    $('#file-upload-btn').disabled = false;
  }
}

function removeContentFile(category, filename, button) {
  if (button.dataset.armed !== 'yes') {
    button.dataset.armed = 'yes';
    button.textContent = 'Really?';
    setTimeout(() => {
      if (button.isConnected) {
        button.dataset.armed = '';
        button.textContent = 'Remove';
      }
    }, 4000);
    return;
  }
  button.disabled = true;
  fetch(`/api/content/files/${encodeURIComponent(category)}/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
    .then((res) => res.json().then((body) => {
      if (!res.ok) throw new Error(body.error || 'could not delete file');
      refreshContentFiles();
    }))
    .catch((err) => {
      button.disabled = false;
      button.textContent = 'Remove';
      alert(err.message);
    });
}

// 4. Music Playlists
async function refreshMusic() {
  try {
    const res = await fetch('/api/content/music', { credentials: 'same-origin' });
    if (!res.ok) return;
    const body = await res.json();
    musicData = body.music || { playlists: [] };
    if (!Array.isArray(musicData.playlists)) musicData.playlists = [];
    renderMusicPlaylists();
  } catch (err) {
    sayContent(`Could not load music: ${err.message}`, true);
  }
}

function renderMusicPlaylists() {
  const container = $('#music-playlists-list');
  container.replaceChildren();

  if (!musicData.playlists.length) {
    container.append(el('p', { class: 'hint' }, 'No playlists configured in content/music.json.'));
    return;
  }

  musicData.playlists.forEach((pl, plIdx) => {
    const plBox = el('div', {
      style: 'background:var(--panel-2); border:1px solid var(--line); border-radius:var(--radius); padding:14px; margin-bottom:14px;',
    });

    const header = el('div', { style: 'display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:10px;' },
      el('label', { style: 'display:flex; align-items:center; gap:6px; font-weight:600; flex:1;' },
        'Playlist Name:',
        el('input', {
          type: 'text',
          value: pl.name || '',
          style: 'font-weight:600;',
          oninput: (e) => { pl.name = e.target.value; },
        })
      ),
      el('label', { class: 'check' },
        el('input', {
          type: 'checkbox',
          checked: !!pl.shuffle,
          onchange: (e) => { pl.shuffle = e.target.checked; },
        }),
        'Shuffle'
      ),
      el('label', { class: 'check' },
        el('input', {
          type: 'checkbox',
          checked: pl.loop !== false,
          onchange: (e) => { pl.loop = e.target.checked; },
        }),
        'Loop'
      ),
      el('button', {
        type: 'button',
        class: 'admin-small',
        onclick: () => {
          if (!Array.isArray(pl.tracks)) pl.tracks = [];
          pl.tracks.push({ title: 'New Track', artist: '', src: 'content/audio/' });
          renderMusicPlaylists();
        },
      }, '+ Add Track'),
      el('button', {
        type: 'button',
        class: 'admin-del',
        onclick: (e) => {
          const btn = e.currentTarget;
          if (btn.dataset.armed !== 'yes') {
            btn.dataset.armed = 'yes';
            btn.textContent = 'Really remove?';
            setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.textContent = 'Remove'; } }, 4000);
            return;
          }
          musicData.playlists.splice(plIdx, 1);
          renderMusicPlaylists();
        },
      }, 'Remove')
    );
    plBox.append(header);

    const trackList = el('div', { style: 'display:flex; flex-direction:column; gap:6px;' });
    const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
    if (!tracks.length) {
      trackList.append(el('p', { class: 'hint', style: 'margin:4px 0;' }, 'No tracks in this playlist.'));
    } else {
      tracks.forEach((tr, trIdx) => {
        const trRow = el('div', { class: 'admin-row', style: 'padding:6px 10px; background:var(--panel);' },
          el('input', {
            type: 'text',
            value: tr.title || '',
            placeholder: 'Track title',
            style: 'flex:1; min-width:120px;',
            oninput: (e) => { tr.title = e.target.value; },
          }),
          el('input', {
            type: 'text',
            value: tr.artist || '',
            placeholder: 'Artist (optional)',
            style: 'flex:1; min-width:100px;',
            oninput: (e) => { tr.artist = e.target.value; },
          }),
          el('input', {
            type: 'text',
            value: tr.src || '',
            placeholder: 'Path or URL (e.g. content/audio/song.mp3)',
            style: 'flex:2; min-width:160px;',
            oninput: (e) => { tr.src = e.target.value; },
          }),
          el('button', {
            type: 'button',
            class: 'admin-small',
            disabled: trIdx === 0,
            title: 'Move up',
            onclick: () => {
              const prev = tracks[trIdx - 1];
              tracks[trIdx - 1] = tr;
              tracks[trIdx] = prev;
              renderMusicPlaylists();
            },
          }, '↑'),
          el('button', {
            type: 'button',
            class: 'admin-small',
            disabled: trIdx === tracks.length - 1,
            title: 'Move down',
            onclick: () => {
              const next = tracks[trIdx + 1];
              tracks[trIdx + 1] = tr;
              tracks[trIdx] = next;
              renderMusicPlaylists();
            },
          }, '↓'),
          el('button', {
            type: 'button',
            class: 'admin-del',
            title: 'Remove track',
            onclick: () => {
              tracks.splice(trIdx, 1);
              renderMusicPlaylists();
            },
          }, '×')
        );
        trackList.append(trRow);
      });
    }
    plBox.append(trackList);
    container.append(plBox);
  });
}

async function saveMusicPlaylists() {
  const note = $('#music-status');
  note.textContent = 'Saving playlists…';
  note.classList.remove('is-bad');
  try {
    const res = await fetch('/api/content/music', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ music: musicData }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'could not save music');
    note.textContent = 'Playlists saved successfully.';
    setTimeout(() => { if (note.textContent.includes('successfully')) note.textContent = ''; }, 4000);
  } catch (err) {
    note.textContent = err.message;
    note.classList.add('is-bad');
  }
}

function sayContent(msg, isBad = false) {
  const note = $('#manifest-status');
  if (note) {
    note.textContent = msg;
    note.classList.toggle('is-bad', isBad);
  }
}

function setupContentManagement() {
  setupSubtabs();

  // 1. Manifest
  $('#manifest-add-btn').addEventListener('click', () => openManifestForm(-1));
  $('#m-save-item-btn').addEventListener('click', saveManifestItemFromForm);
  $('#m-cancel-item-btn').addEventListener('click', () => { $('#manifest-item-form-box').hidden = true; });
  $('#manifest-commit-btn').addEventListener('click', commitManifest);

  // 2. Marp Themes
  $('#theme-new-btn').addEventListener('click', () => openThemeEditor(null));
  $('#theme-upload-btn').addEventListener('click', () => $('#theme-upload-input').click());
  $('#theme-upload-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const res = await fetch(`/api/content/themes?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        credentials: 'same-origin',
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'could not upload theme');
      await refreshThemes();
      openThemeEditor(file.name);
    } catch (err) {
      alert(err.message);
    } finally {
      e.target.value = '';
    }
  });
  $('#theme-save-btn').addEventListener('click', saveTheme);
  $('#theme-download-btn').addEventListener('click', () => {
    const filename = $('#theme-filename').value.trim();
    if (filename) location.href = `/api/content/themes/${encodeURIComponent(filename)}?download=1`;
  });
  $('#theme-close-btn').addEventListener('click', () => { $('#theme-editor-box').hidden = true; });
  $('#theme-css-editor').addEventListener('input', updateThemePreview);
  $('#theme-preview-slide-select').addEventListener('change', updateThemePreview);

  // 3. Pre-load Files
  document.querySelectorAll('.cat-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.cat-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      activeFileCategory = pill.dataset.cat || '';
      renderContentFiles();
    });
  });
  $('#file-search-input').addEventListener('input', renderContentFiles);
  $('#file-upload-btn').addEventListener('click', uploadContentFile);
  $('#file-editor-close').addEventListener('click', () => { $('#file-editor-sheet').hidden = true; });
  $('#file-editor-save-btn').addEventListener('click', saveFileEditor);

  // 4. Music
  $('#music-add-playlist-btn').addEventListener('click', () => {
    musicData.playlists.push({ name: 'New Playlist', shuffle: false, loop: true, tracks: [] });
    renderMusicPlaylists();
  });
  $('#music-save-btn').addEventListener('click', saveMusicPlaylists);
}

async function refreshContentManagement() {
  await Promise.all([
    refreshManifest(),
    refreshThemes(),
    refreshContentFiles(),
    refreshMusic(),
  ]);
}

const info = await serverInfo();
function setupAdminTabs() {
  const tabs = document.querySelectorAll('.admin-tabs .tab');
  const panels = document.querySelectorAll('.admin-panel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('is-on'));
      panels.forEach(p => p.hidden = true);
      tab.classList.add('is-on');
      document.getElementById(tab.dataset.target).hidden = false;
    });
  });
}

if (!info.features.includes('library')) {
  $('#no-server').hidden = false;
} else {
  me = info.user;
  $('#admin').hidden = false;
  setupAdminTabs();

  $('#tab-library').hidden = false;
  $('#up-go').addEventListener('click', upload);
  $('#lib-search').addEventListener('input', render);
  await refresh();

  // Separate probe from the library's: a server could gain session records
  // without the library, and the panel stays absent rather than empty.
  if (info.features.includes('sessions')) {
    $('#tab-sessions').hidden = false;
    $('#sess-search').addEventListener('input', renderSessions);
    await refreshSessions();
  }

  // Courses are everyone's (you see the ones you are in); people and storage
  // are an administrator's. Each card appears only where it would work.
  if (info.features.includes('people')) {
    $('#tab-courses').hidden = false;
    $('#new-course-go').addEventListener('click', addCourse);
    if (me?.isAdmin) {
      $('#tab-people').hidden = false;
      $('#tab-storage').hidden = false;
      $('#people-search').addEventListener('input', renderPeople);
      $('#new-user-go').addEventListener('click', addPerson);
      $('#backup-go').addEventListener('click', downloadBackup);
      $('#allow-poll-names-check')?.addEventListener('change', updateAllowPollNames);
      await Promise.all([refreshPeople(), refreshStorage(), refreshSystemSettings()]);
    }
    await refreshCourses();
  }

  // Content management is for administrators only
  if (info.features.includes('content') && me?.isAdmin) {
    $('#tab-content').hidden = false;
    setupContentManagement();
    await refreshContentManagement();
  }

  // Select first available tab
  const firstVisibleTab = document.querySelector('.admin-tabs .tab:not([hidden])');
  if (firstVisibleTab) firstVisibleTab.click();
}

