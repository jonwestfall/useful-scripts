// The controller's Attendance tab (Issue #256, phase 2): open check-in for a
// course, put the rotating code on screen, watch the room check in, and mark
// by hand anyone without a phone. Only on a server with accounts - see
// server/attendance.js for the rules, and attend.html for the students' side.
//
// Anyone in a course takes attendance (a TA too); the course picked here
// defaults to the one the live lecture is filed under, then to the last one
// this device used.

import { $, el, safeStorageSet } from './util.js';

const COURSE_KEY = 'podium.attendance.course';
const LIVE_MS = 3000;     // how often the list refreshes while the tab is open
const STATUS_LABELS = { present: 'Present', late: 'Late', excused: 'Excused', absent: 'Absent' };

/**
 * Questions as a teacher types them, one per line: the question, then its
 * choices after bars - `Which reading? | Ch 3 | Ch 4`. No choices (or only
 * one) is a short answer. At most three; the server tidies the rest.
 */
export function parseQuestionLines(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 3).map((line) => {
    const [prompt, ...options] = line.split('|').map((part) => part.trim());
    return { prompt, options: options.filter(Boolean) };
  });
}

/** The other way: questions back into lines, to edit. */
export function questionLines(questions) {
  return (questions || []).map((q) => [q.prompt, ...(q.options || [])].join(' | ')).join('\n');
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `that did not work (${res.status})`), { status: res.status });
  return data;
}

/**
 * @param {object} deps
 * @param {(item: object) => void} deps.stage - put an item on screen
 * @param {() => (number|string|null)} deps.lectureId - the live (or just-ended) lecture
 */
export function createAttendancePanel({ stage, lectureId }) {
  let courses = null;      // [{code, title, role}]
  let session = null;      // the session view, or null
  let detail = null;       // { people, guests } of the session
  let timer = 0;
  let visible = false;
  let busy = false;

  const say = (text, bad = false) => {
    $('#att-note').textContent = text || '';
    $('#att-note').classList.toggle('is-bad', !!bad);
  };

  // The server's defaults (radius choices), once.
  let settings = null;
  async function loadSettings() {
    if (settings) return;
    try { settings = await api('/api/attendance/settings'); } catch { settings = { radius: 100, radii: [50, 100, 200, 500] }; }
    $('#att-radius').replaceChildren(...settings.radii.map((m) => el('option', { value: String(m) }, `${m} m`)));
    $('#att-radius').value = String(settings.radius);
  }

  // This device's position, as the room's. Remembered per course, so a
  // device that cannot say where it is right now can use where it last was.
  const ROOM_KEY = (course) => `podium.attendance.room.${course}`;
  function roomHere(course) {
    return new Promise((resolve, reject) => {
      const remembered = () => { try { return JSON.parse(localStorage.getItem(ROOM_KEY(course)) || 'null'); } catch { return null; } };
      if (!navigator.geolocation) { const r = remembered(); if (r) resolve(r); else reject(new Error('this device cannot say where it is')); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        const room = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        safeStorageSet(localStorage, ROOM_KEY(course), JSON.stringify(room));
        resolve(room);
      }, () => {
        const r = remembered();
        if (r) resolve(r); else reject(new Error('this device did not give its location - allow it in the browser, or turn “Only from phones in the room” off'));
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    });
  }

  async function loadCourses() {
    await loadSettings();
    if (courses) return;
    try {
      courses = ((await api('/api/courses')).courses || []).filter((c) => !c.archived);
    } catch {
      courses = [];
    }
    const pick = $('#att-course');
    pick.replaceChildren(...courses.map((c) => el('option', { value: c.code },
      `${String(c.code).toUpperCase()}${c.title && c.title !== c.code ? ` — ${c.title}` : ''}`)));
    $('#att-none').hidden = courses.length > 0;
    $('#att-body').hidden = !courses.length;
    let start = '';
    const lecture = lectureId();
    if (lecture) {
      try { start = (await api(`/api/lectures/${encodeURIComponent(lecture)}`)).lecture?.course || ''; } catch { /* not filed, or not ours */ }
    }
    if (!courses.some((c) => c.code === start)) {
      try { start = localStorage.getItem(COURSE_KEY) || ''; } catch { start = ''; }
    }
    if (courses.some((c) => c.code === start)) pick.value = start;
  }

  async function loadCurrent() {
    const course = $('#att-course').value;
    if (!course) return;
    const lecture = lectureId();
    try {
      session = (await api(`/api/attendance/current?course=${encodeURIComponent(course)}${lecture ? `&lecture=${encodeURIComponent(lecture)}` : ''}`)).session;
    } catch (err) {
      session = null;
      say(err.message, true);
    }
    await refresh();
  }

  async function refresh() {
    if (session) {
      try {
        const got = await api(`/api/attendance/sessions/${session.id}`);
        session = got.session;
        detail = got;
      } catch (err) {
        say(err.message, true);
      }
    } else {
      detail = null;
    }
    render();
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    if (visible && session?.open) timer = setTimeout(() => { if (!busy) refresh(); else schedule(); }, LIVE_MS);
  }

  function render() {
    // A closed session from this lecture is reopened from the list's own
    // button; one from earlier (no lecture, or another) leaves room to start anew.
    const thisLecture = !!session?.lectureId && String(session.lectureId) === String(lectureId() || '');
    $('#att-start').hidden = !!session?.open || thisLecture;
    $('#att-live').hidden = !session;
    $('#att-open').textContent = session ? 'Start a new check-in' : 'Open check-in';
    if (!session) { $('#att-list').replaceChildren(); return; }
    const c = session.counts;
    const here = c.present + c.late;
    const what = session.phase === 'exit' ? 'The exit ticket' : 'Check-in';
    $('#att-summary').textContent = `${what} is ${session.open ? 'open' : 'closed'} · ${here} checked in`
      + `${session.rosterSize ? ` of ${session.rosterSize}` : ''}${c.late ? ` · ${c.late} late` : ''}${c.excused ? ` · ${c.excused} excused` : ''}`
      + `${session.geofence ? ` · phones within ${session.geofence.radius} m only` : ''}`;
    $('#att-toggle-open').textContent = session.open ? `Close ${session.phase === 'exit' ? 'the exit ticket' : 'check-in'}` : 'Reopen check-in';
    $('#att-exit').hidden = session.open && session.phase === 'exit';
    if (!$('#att-exit-form').hidden && document.activeElement !== $('#att-exit-questions')) {
      $('#att-exit-questions').value ||= questionLines(session.questions.exit);
    }
    $('#att-parking').checked = session.parking;
    renderAnswers();
    renderParking();
    $('#att-late-now').checked = session.lateNow;
    $('#att-late-rule').textContent = session.lateRule.after != null
      ? `Late after ${new Date(session.lateRule.from + session.lateRule.after * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${session.lateApplies && !session.lateNow ? ' — now marking late' : ''}`
      : '';
    renderList();
  }

  // What the room answered, question by question.
  function renderAnswers() {
    const blocks = [];
    for (const phase of ['entry', 'exit']) {
      for (const q of detail?.summary?.[phase] || []) {
        const body = q.kind === 'choice'
          ? el('div', { class: 'att-bars' }, ...q.options.map((option, i) => {
            const n = q.counts[i] || 0;
            const fill = el('span', { class: 'att-bar-fill' });
            fill.style.width = `${q.answered ? Math.round((n / q.answered) * 100) : 0}%`;
            return el('div', { class: 'att-bar' }, el('span', { class: 'att-bar-label' }, `${option} — ${n}`), el('span', { class: 'att-bar-track' }, fill));
          }))
          : el('ul', { class: 'att-answers' }, ...q.answers.slice(-30).reverse().map((a) => el('li', {}, a)));
        blocks.push(el('div', { class: 'att-question' },
          el('div', { class: 'att-question-prompt' }, `${phase === 'exit' ? 'Exit' : 'Entry'}: ${q.prompt}`, el('span', { class: 'hint' }, ` · ${q.answered} answered`)),
          body));
      }
    }
    $('#att-answers').hidden = !blocks.length;
    $('#att-answers').replaceChildren(...blocks);
  }

  // The parking lot: newest first, unanswered ones on top.
  function renderParking() {
    const list = [...(detail?.parking || [])].sort((a, b) => (!!a.answeredAt - !!b.answeredAt) || b.at - a.at);
    $('#att-parking-box').hidden = !session?.parking && !list.length;
    $('#att-parking-list').replaceChildren(...(list.length ? list.map((q) => el('div', { class: `att-row att-parked${q.answeredAt ? ' is-answered' : ''}`, role: 'listitem' },
      el('span', { class: 'att-who' },
        el('span', { class: 'att-name' }, q.text),
        el('span', { class: 'att-meta' }, `${q.anonymous ? 'anonymous' : q.name} · ${new Date(q.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${q.answeredAt ? ' · answered' : ''}`)),
      el('span', { class: 'att-actions' },
        el('button', { type: 'button', class: 'btn-small', onclick: () => stage({ type: 'text', title: 'Parking lot', body: q.text, caption: q.anonymous ? '' : `— ${q.name}`, size: 'l' }) }, 'Show on screen'),
        el('button', { type: 'button', class: 'btn-small', onclick: () => answerParked(q, !q.answeredAt) }, q.answeredAt ? 'Not answered' : 'Answered'))))
      : [el('p', { class: 'hint' }, 'No questions yet. Phones that check in can ask one, named or anonymously.')]));
  }

  async function answerParked(q, answered) {
    try { await api(`/api/attendance/sessions/${session.id}/parking/${q.id}`, { method: 'PATCH', body: { answered } }); } catch (err) { say(err.message, true); }
    await refresh();
  }

  function flagText(flags) {
    return flags.map((f) => (f.kind === 'device'
      ? `⚑ same phone as ${f.with.join(', ')}`
      : `⚐ same network as ${f.with.join(', ')}`)).join(' · ');
  }

  function statusPicker(current, onPick, label) {
    const select = el('select', { 'aria-label': label, class: `att-status is-${current || 'none'}` },
      el('option', { value: '' }, current ? 'Not marked' : '—'),
      ...Object.entries(STATUS_LABELS).map(([value, text]) => el('option', { value }, text)));
    select.value = current || '';
    select.addEventListener('focus', () => { busy = true; });
    select.addEventListener('blur', () => { busy = false; });
    select.addEventListener('change', () => { busy = false; onPick(select.value); });
    return select;
  }

  function renderList() {
    const q = $('#att-search').value.trim().toLowerCase();
    const match = (name, id = '') => !q || `${name} ${id}`.toLowerCase().includes(q);
    const rows = [];
    for (const p of detail?.people || []) {
      if (!match(p.name, p.studentId)) continue;
      if (p.removed && !p.mark) continue;
      rows.push(row(p.name, p.studentId ? `ID ${p.studentId}` : '', p.mark,
        (value) => markRoster(p, value), p.removed ? 'no longer on the roster' : ''));
    }
    for (const g of detail?.guests || []) {
      if (!match(g.name, `${g.studentId} ${g.email}`)) continue;
      rows.push(row(g.name, ['guest', g.email].filter(Boolean).join(' · '), g.mark, (value) => markGuest(g, value)));
    }
    $('#att-list').replaceChildren(...(rows.length ? rows : [el('p', { class: 'hint' },
      q ? 'Nobody matches that search.' : 'Nobody on this course’s roster yet — everyone checks in as a guest. Owners add the class list on My Files → Rosters.')]));
  }

  function row(name, meta, mark, onPick, extra = '') {
    const flags = mark?.flags?.length ? flagText(mark.flags) : '';
    const when = mark && mark.how !== 'hand' ? new Date(mark.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    return el('div', { class: `att-row${flags ? ' is-flagged' : ''}${mark ? '' : ' is-unmarked'}`, role: 'listitem' },
      el('span', { class: 'att-who' },
        el('span', { class: 'att-name' }, name),
        el('span', { class: 'att-meta' }, [meta, when && `checked in ${when}`, mark?.distance != null && `${mark.distance} m from the room`,
          mark?.how === 'hand' && 'by hand', extra].filter(Boolean).join(' · ')),
        flags ? el('span', { class: 'att-flag' }, flags) : null),
      statusPicker(mark?.status || '', onPick, `Attendance for ${name}`));
  }

  async function markRoster(p, value) {
    try {
      if (!value) {
        if (p.mark) await api(`/api/attendance/sessions/${session.id}/marks/${p.mark.id}`, { method: 'DELETE' });
      } else {
        await api(`/api/attendance/sessions/${session.id}/marks`, { method: 'POST', body: { rosterId: p.rosterId, status: value } });
      }
      say(value ? `${p.name}: ${STATUS_LABELS[value].toLowerCase()}.` : `${p.name} is not marked.`);
    } catch (err) { say(err.message, true); }
    await refresh();
  }

  async function markGuest(g, value) {
    try {
      if (!value) await api(`/api/attendance/sessions/${session.id}/marks/${g.mark.id}`, { method: 'DELETE' });
      else await api(`/api/attendance/sessions/${session.id}/marks/${g.mark.id}`, { method: 'PATCH', body: { status: value } });
      say(value ? `${g.name}: ${STATUS_LABELS[value].toLowerCase()}.` : `${g.name}'s check-in is taken off.`);
    } catch (err) { say(err.message, true); }
    await refresh();
  }

  async function open() {
    const course = $('#att-course').value;
    const after = $('#att-late-after-on').checked ? Number($('#att-late-after').value) : null;
    let geofence = null;
    if ($('#att-in-room').checked) {
      say('Finding where this device is…');
      try {
        geofence = { ...(await roomHere(course)), radius: Number($('#att-radius').value) };
      } catch (err) { say(`Check-in was not opened: ${err.message}.`, true); return; }
    }
    try {
      const got = await api('/api/attendance/sessions', {
        method: 'POST',
        body: {
          course, lectureId: lectureId() || null, lateRule: { after, from: Date.now() }, phase: 'entry',
          questions: { entry: parseQuestionLines($('#att-entry-questions').value) }, parking: $('#att-parking-start').checked, geofence,
        },
      });
      session = got.session;
      say(got.reopened ? 'Check-in is open again for this lecture.' : 'Check-in is open.');
      show();
    } catch (err) { say(err.message, true); }
    await refresh();
  }

  async function change(body, done) {
    try {
      session = (await api(`/api/attendance/sessions/${session.id}`, { method: 'PATCH', body })).session;
      if (done) say(done);
    } catch (err) { say(err.message, true); }
    await refresh();
  }

  function show() {
    if (!session) return;
    stage({
      type: 'attendance',
      title: `${session.phase === 'exit' ? 'Exit ticket' : 'Check in'} · ${String(session.course).toUpperCase()}`,
      sessionId: session.id,
      screenKey: session.screenKey,
      course: String(session.course).toUpperCase(),
    });
  }

  $('#att-course').addEventListener('change', () => {
    safeStorageSet(localStorage, COURSE_KEY, $('#att-course').value);
    say('');
    loadCurrent();
  });
  $('#att-open').addEventListener('click', open);
  $('#att-show').addEventListener('click', show);
  $('#att-toggle-open').addEventListener('click', () => change({ open: !session.open },
    session.open ? 'Check-in is closed. The screen says so until you take it down.' : 'Check-in is open again.'));
  $('#att-late-now').addEventListener('change', (ev) => change({ lateNow: ev.target.checked },
    ev.target.checked ? 'Check-ins from now on count as late.' : 'Check-ins count as present again.'));
  $('#att-late-after-on').addEventListener('change', (ev) => { $('#att-late-after').disabled = !ev.target.checked; });
  $('#att-in-room').addEventListener('change', (ev) => { $('#att-room-row').hidden = !ev.target.checked; });
  $('#att-search').addEventListener('input', renderList);
  $('#att-parking').addEventListener('change', (ev) => change({ parking: ev.target.checked },
    ev.target.checked ? 'The parking lot is open: phones that checked in can ask a question.' : 'The parking lot is closed.'));
  $('#att-exit').addEventListener('click', () => {
    $('#att-exit-form').hidden = !$('#att-exit-form').hidden;
    if (!$('#att-exit-form').hidden) {
      $('#att-exit-questions').value = questionLines(session.questions.exit);
      $('#att-exit-questions').focus();
    }
  });
  $('#att-exit-go').addEventListener('click', () => openExit(parseQuestionLines($('#att-exit-questions').value)));

  // The exit ticket: the same session opened again at the end, asking its
  // own questions. A phone that checked in earlier answers without picking
  // its name again.
  async function openExit(questions) {
    await change({ open: true, phase: 'exit', questions: { exit: questions } }, 'The exit ticket is open.');
    $('#att-exit-form').hidden = true;
    show();
  }

  return {
    /**
     * A planned Attendance item (Issue #256): open check-in - or the exit
     * ticket - with what the plan says, and put it on screen.
     */
    async fromPlan(item) {
      visible = true;
      await loadCourses();
      if (item.course && courses.some((c) => c.code === String(item.course).toLowerCase())) $('#att-course').value = String(item.course).toLowerCase();
      await loadCurrent();
      const questions = parseQuestionLines(item.questions);
      if (item.phase === 'exit' && session) {
        if (item.parking) await change({ parking: true });
        await openExit(questions);
        return;
      }
      $('#att-late-after-on').checked = !!item.lateOn;
      $('#att-late-after').disabled = !item.lateOn;
      if (item.lateOn) $('#att-late-after').value = String(Number(item.lateAfter) || 0);
      $('#att-entry-questions').value = questionLines(questions);
      $('#att-parking-start').checked = !!item.parking;
      $('#att-in-room').checked = !!item.inRoom;
      $('#att-room-row').hidden = !item.inRoom;
      if (item.inRoom && [...$('#att-radius').options].some((o) => o.value === String(item.radius))) $('#att-radius').value = String(item.radius);
      if (session?.open) { show(); return; }
      await open();
    },
    /** The tab was opened: catch up. */
    async opened() {
      visible = true;
      await loadCourses();
      await loadCurrent();
    },
    /** The tab was left: stop asking the server every few seconds. */
    closed() {
      visible = false;
      clearTimeout(timer);
    },
  };
}
