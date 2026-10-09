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

  async function loadCourses() {
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
    $('#att-summary').textContent = `${session.open ? 'Check-in is open' : 'Check-in is closed'} · ${here} checked in`
      + `${session.rosterSize ? ` of ${session.rosterSize}` : ''}${c.late ? ` · ${c.late} late` : ''}${c.excused ? ` · ${c.excused} excused` : ''}`;
    $('#att-toggle-open').textContent = session.open ? 'Close check-in' : 'Reopen check-in';
    $('#att-late-now').checked = session.lateNow;
    $('#att-late-rule').textContent = session.lateRule.after != null
      ? `Late after ${new Date(session.lateRule.from + session.lateRule.after * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${session.lateApplies && !session.lateNow ? ' — now marking late' : ''}`
      : '';
    renderList();
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
        el('span', { class: 'att-meta' }, [meta, when && `checked in ${when}`, mark?.how === 'hand' && 'by hand', extra].filter(Boolean).join(' · ')),
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
    try {
      const got = await api('/api/attendance/sessions', {
        method: 'POST',
        body: { course, lectureId: lectureId() || null, lateRule: { after, from: Date.now() } },
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
      title: `Check in · ${String(session.course).toUpperCase()}`,
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
  $('#att-search').addEventListener('input', renderList);

  return {
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
