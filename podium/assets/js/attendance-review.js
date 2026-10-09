// Attendance after class, on My Files (Issue #256, phase 3): a course's
// check-in sessions, each one's review (status changes, flags looked at, a
// guest put on the roster, and the history of who changed what), the term
// grid, and the exports - a CSV, the grid as a CSV, and a Canvas gradebook
// import. See server/attendance.js for the rules: anyone in a course reviews
// and exports; only its owners (and admins) put guests on the roster or delete
// a session.

import { $, el } from './util.js';

const COURSE = (code) => String(code || '').toUpperCase();
const STATUS_LABELS = { present: 'Present', late: 'Late', excused: 'Excused', absent: 'Absent' };
const LETTER = { present: 'P', late: 'L', absent: 'A', excused: 'E' };
const ACTIONS = {
  marked: 'marked', changed: 'changed', removed: 'took off', flags_dismissed: 'dismissed the flags on', added_to_roster: 'put on the roster',
};

const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * @param {object} deps
 * @param {(path: string, opts?: object) => Promise<any>} deps.api
 * @param {(title: string, build: (card: HTMLElement, done: (v: any) => void) => void) => Promise<any>} deps.dialog
 * @param {() => {code: string, title: string}[]} deps.courses
 * @param {string} [deps.initial] - a course to open on
 */
export function createAttendanceReview({ api, dialog, courses, initial = '' }) {
  const pick = $('#attn-course');
  let view = 'sessions';      // sessions | grid | review
  let reviewing = null;       // the session id under review
  let mayEditRoster = false;

  const say = (text, bad = false) => {
    $('#attn-note').textContent = text || '';
    $('#attn-note').classList.toggle('is-bad', !!bad);
  };

  // The date range, as the server wants it: from the start of "from" to the
  // end of "to", in this browser's time zone.
  function range() {
    const from = $('#attn-from').value ? new Date(`${$('#attn-from').value}T00:00`).getTime() : 0;
    const to = $('#attn-to').value ? new Date(`${$('#attn-to').value}T00:00`).getTime() + 86400000 : 0;
    return new URLSearchParams({ from: String(from), to: String(to), tz: String(new Date().getTimezoneOffset()) });
  }
  const base = () => `/api/attendance/courses/${encodeURIComponent(pick.value)}`;

  function fillCourses() {
    const all = courses();
    pick.replaceChildren(...all.map((c) => el('option', { value: c.code }, `${COURSE(c.code)}${c.title && c.title !== c.code ? ` — ${c.title}` : ''}`)));
    if (initial && all.some((c) => c.code === initial)) pick.value = initial;
    $('#attn-none').hidden = all.length > 0;
    $('#attn-body').hidden = !all.length;
  }

  function show(which) {
    view = which;
    $('#attn-sessions').hidden = which !== 'sessions';
    $('#attn-grid').hidden = which !== 'grid';
    $('#attn-review').hidden = which !== 'review';
    $('#attn-show-sessions').classList.toggle('is-on', which !== 'grid');
    $('#attn-show-grid').classList.toggle('is-on', which === 'grid');
    $('#attn-range').hidden = which === 'review';
  }

  async function load() {
    if (!pick.value) return;
    history.replaceState(null, '', `#attendance:${pick.value}`);
    const q = range();
    $('#attn-export-long').href = `${base()}/export?format=long&${q}`;
    $('#attn-export-grid').href = `${base()}/export?format=grid&${q}`;
    if (view === 'grid') await loadGrid();
    else if (view === 'review' && reviewing) await loadReview(reviewing);
    else await loadSessions();
  }

  // --- the course's sessions ---------------------------------------------------

  async function loadSessions() {
    show('sessions');
    const list = $('#attn-sessions');
    list.replaceChildren(el('p', { class: 'hint' }, 'Looking…'));
    let data;
    try { data = await api(`${base()}/sessions?${range()}`); } catch (err) { say(err.message, true); list.replaceChildren(); return; }
    mayEditRoster = !!data.mayEditRoster;
    if (!data.sessions.length) {
      list.replaceChildren(el('p', { class: 'hint' }, 'No attendance taken in this course yet (in this range). Open check-in from the controller’s Attendance tab.'));
      return;
    }
    list.replaceChildren(...data.sessions.map((s) => {
      const c = s.counts;
      const absent = c.absent + (s.notCheckedIn || 0);
      const meta = [
        `${c.present} present`, c.late && `${c.late} late`, c.excused && `${c.excused} excused`,
        !s.open && `${absent} absent`, s.open && 'check-in open',
      ].filter(Boolean).join(' · ');
      return el('div', { class: 'me-row attn-session', role: 'listitem', 'data-id': String(s.id) },
        el('span', { class: 'fb-what' },
          el('span', { class: 'fb-title' }, `${when(s.createdAt)}${s.title ? ` — ${s.title}` : ''}`),
          el('span', { class: 'fb-meta' }, meta),
          s.flagged ? el('span', { class: 'attn-flag' }, `⚑ ${s.flagged} to look at`) : null),
        el('span', { class: 'me-actions' },
          el('button', { type: 'button', class: 'admin-small', onclick: () => loadReview(s.id) }, 'Review'),
          mayEditRoster ? el('button', { type: 'button', class: 'admin-small is-bad', onclick: () => deleteSession(s) }, 'Delete') : null));
    }));
  }

  async function deleteSession(s) {
    const sure = await dialog(`Delete the check-in of ${when(s.createdAt)}?`, (card, done) => {
      card.append(el('p', { class: 'hint' }, `Its ${s.counts.present + s.counts.late + s.counts.excused + s.counts.absent} marks go with it. This cannot be undone.`),
        el('div', { class: 'admin-actions' },
          el('button', { type: 'button', class: 'primary', onclick: () => done(true) }, 'Delete'),
          el('button', { type: 'button', onclick: () => done(null) }, 'Cancel')));
    });
    if (!sure) return;
    try {
      await api(`/api/attendance/sessions/${s.id}`, { method: 'DELETE' });
      say('Deleted.');
      await loadSessions();
    } catch (err) { say(err.message, true); }
  }

  // --- one session's review --------------------------------------------------------

  async function loadReview(id) {
    reviewing = id;
    show('review');
    let data;
    try { data = await api(`/api/attendance/sessions/${id}`); } catch (err) { say(err.message, true); return; }
    mayEditRoster = !!data.mayEditRoster;
    const s = data.session;
    const onlyFlagged = $('#attn-only-flagged')?.checked;
    const flagText = (flags) => flags.map((f) => (f.kind === 'device' ? `⚑ same phone as ${f.with.join(', ')}` : `⚐ same network as ${f.with.join(', ')}`)).join(' · ');
    const isFlagged = (mark) => mark?.flags?.length && !mark.dismissed;

    const statusPicker = (mark, onPick, label, derivedAbsent) => {
      const select = el('select', { 'aria-label': label, class: `att-status is-${mark?.status || (derivedAbsent ? 'absent' : 'none')}` },
        el('option', { value: '' }, derivedAbsent ? 'Absent (not checked in)' : mark ? 'Not marked' : '—'),
        ...Object.entries(STATUS_LABELS).map(([value, text]) => el('option', { value }, text)));
      select.value = mark?.status || '';
      select.addEventListener('change', () => onPick(select.value));
      return select;
    };

    // This person's answers to the entry and exit questions, in one line.
    const prompts = { entry: s.questions?.entry || [], exit: s.questions?.exit || [] };
    const answerLine = (mark) => ['entry', 'exit'].flatMap((phase) => prompts[phase]
      .filter((q) => mark?.answers?.[phase]?.[q.id] !== undefined)
      .map((q) => `${phase === 'exit' ? 'Exit' : 'Entry'} “${q.prompt}”: ${mark.answers[phase][q.id]}`)).join(' · ');

    const row = ({ name, meta, mark, onPick, derivedAbsent = false, extra = [] }) => {
      const flags = mark?.flags?.length ? flagText(mark.flags) : '';
      const bits = [meta,
        mark && mark.how !== 'hand' && `checked in ${timeOf(mark.at)} by ${mark.how === 'scan' ? 'scanning' : 'typing the code'}`,
        mark?.how === 'hand' && 'marked by hand',
        mark?.edited && `changed${mark.editedBy ? ` by ${mark.editedBy}` : ''}`].filter(Boolean).join(' · ');
      return el('div', { class: `att-row${isFlagged(mark) ? ' is-flagged' : ''}`, role: 'listitem' },
        el('span', { class: 'att-who' },
          el('span', { class: 'att-name' }, name),
          el('span', { class: 'att-meta' }, bits),
          flags ? el('span', { class: `att-flag${mark.dismissed ? ' is-dismissed' : ''}` },
            flags + (mark.dismissed ? ` — dismissed${mark.dismissed.by ? ` by ${mark.dismissed.by}` : ''}` : '')) : null,
          answerLine(mark) ? el('span', { class: 'att-meta attn-answer' }, answerLine(mark)) : null),
        el('span', { class: 'me-actions' },
          ...extra,
          isFlagged(mark) ? el('button', { type: 'button', class: 'admin-small', onclick: () => act(`/api/attendance/sessions/${id}/marks/${mark.id}/dismiss`, 'POST', `Flags on ${name} dismissed.`) }, 'Dismiss flag') : null,
          statusPicker(mark, onPick, `Attendance for ${name}`, derivedAbsent)));
    };

    const people = data.people.filter((p) => !onlyFlagged || isFlagged(p.mark)).map((p) => row({
      name: p.name,
      meta: [p.studentId && `ID ${p.studentId}`, p.removed && 'no longer on the roster'].filter(Boolean).join(' · '),
      mark: p.mark,
      derivedAbsent: p.absent,
      onPick: (value) => (value
        ? act(`/api/attendance/sessions/${id}/marks`, 'POST', `${p.name}: ${STATUS_LABELS[value].toLowerCase()}.`, { rosterId: p.rosterId, status: value })
        : p.mark ? act(`/api/attendance/sessions/${id}/marks/${p.mark.id}`, 'DELETE', `${p.name} is not marked.`) : null),
    }));
    const guests = data.guests.filter((g) => !onlyFlagged || isFlagged(g.mark)).map((g) => row({
      name: g.name,
      meta: ['guest', g.studentId && `ID ${g.studentId}`, g.email].filter(Boolean).join(' · '),
      mark: g.mark,
      extra: mayEditRoster ? [el('button', {
        type: 'button', class: 'admin-small',
        onclick: () => act(`/api/attendance/sessions/${id}/marks/${g.mark.id}/roster`, 'POST', `${g.name} is on the roster now, with their check-ins as a guest.`),
      }, 'Add to roster')] : [],
      onPick: (value) => (value
        ? act(`/api/attendance/sessions/${id}/marks/${g.mark.id}`, 'PATCH', `${g.name}: ${STATUS_LABELS[value].toLowerCase()}.`, { status: value })
        : act(`/api/attendance/sessions/${id}/marks/${g.mark.id}`, 'DELETE', `${g.name}'s check-in is taken off.`)),
    }));

    const c = s.counts;
    const absent = data.people.filter((p) => p.absent).length + c.absent;
    $('#attn-review').replaceChildren(
      el('div', { class: 'attn-review-head' },
        el('button', { type: 'button', class: 'admin-small', onclick: () => { reviewing = null; loadSessions(); } }, '← All sessions'),
        el('h3', {}, `${when(s.createdAt)}${s.title ? ` — ${s.title}` : ''}`)),
      el('p', { class: 'hint' }, [`${c.present} present`, `${c.late} late`, `${c.excused} excused`, s.open ? 'check-in still open' : `${absent} absent`,
        data.guests.length && `${data.guests.length} guest${data.guests.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')),
      el('label', { class: 'me-check' }, el('input', { type: 'checkbox', id: 'attn-only-flagged', checked: !!onlyFlagged, onchange: () => loadReview(id) }), 'Only what is flagged'),
      el('div', { class: 'att-list', role: 'list', id: 'attn-review-list' }, ...(people.length || guests.length ? [...people, ...guests]
        : [el('p', { class: 'hint' }, onlyFlagged ? 'Nothing flagged in this session.' : 'Nobody on the roster, and nobody checked in.')])),
      questionsBlock(data),
      parkingBlock(data),
      el('details', { class: 'help attn-history' },
        el('summary', {}, `History (${data.history.length})`),
        data.history.length
          ? el('ul', {}, ...data.history.map((h) => el('li', {},
            `${when(h.at)} — ${h.by || 'someone'} ${ACTIONS[h.action] || h.action} ${h.name}`
            + (h.action === 'changed' ? `: ${h.before} → ${h.after}` : h.action === 'marked' ? ` ${h.after}` : h.action === 'removed' ? ` (was ${h.before})` : ''))))
          : el('p', { class: 'hint' }, 'Nothing has been changed since check-in.')));
  }

  // The answers, question by question, and a CSV of every one.
  function questionsBlock(data) {
    const blocks = [];
    for (const phase of ['entry', 'exit']) {
      for (const q of data.summary?.[phase] || []) {
        blocks.push(el('div', { class: 'att-question' },
          el('div', { class: 'att-question-prompt' }, `${phase === 'exit' ? 'Exit ticket' : 'Entry ticket'}: ${q.prompt}`,
            el('span', { class: 'hint' }, ` · ${q.answered} answered`)),
          q.kind === 'choice'
            ? el('ul', { class: 'att-answers' }, ...q.options.map((o, i) => el('li', {}, `${o} — ${q.counts[i]}`)))
            : el('ul', { class: 'att-answers' }, ...q.answers.map((a) => el('li', {}, a)))));
      }
    }
    if (!blocks.length && !data.parking?.length) return null;
    return el('div', { class: 'stack attn-questions' },
      el('p', { class: 'hint' }, el('a', { class: 'linkish', href: `/api/attendance/sessions/${data.session.id}/answers`, download: '' }, 'Download the answers and the parking lot (CSV)')),
      ...blocks);
  }

  function parkingBlock(data) {
    if (!data.parking?.length) return null;
    return el('details', { class: 'help', open: true },
      el('summary', {}, `Parking lot (${data.parking.length})`),
      el('ul', { class: 'att-answers' }, ...data.parking.map((q) => el('li', { class: q.answeredAt ? 'is-answered' : '' },
        `${q.text} — ${q.anonymous ? 'anonymous' : q.name}, ${timeOf(q.at)}${q.answeredAt ? ' (answered)' : ''}`))));
  }

  async function act(path, method, done, body) {
    try {
      await api(path, { method, ...(body ? { body } : {}) });
      say(done);
    } catch (err) { say(err.message, true); }
    if (reviewing) await loadReview(reviewing);
  }

  // --- the term grid ----------------------------------------------------------------

  async function loadGrid() {
    show('grid');
    const holder = $('#attn-grid');
    holder.replaceChildren(el('p', { class: 'hint' }, 'Looking…'));
    let g;
    try { g = await api(`${base()}/grid?${range()}`); } catch (err) { say(err.message, true); holder.replaceChildren(); return; }
    if (!g.sessions.length) { holder.replaceChildren(el('p', { class: 'hint' }, 'No sessions in this range.')); return; }
    const pct = (rate) => (rate == null ? '—' : `${Math.round(rate * 100)}%`);
    const table = el('table', { class: 'attn-grid' },
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Name'),
        ...g.sessions.map((s) => el('th', { scope: 'col', title: [s.title, when(s.at)].filter(Boolean).join(' — ') },
          el('button', { type: 'button', class: 'linkish', onclick: () => loadReview(s.id) }, s.label.slice(5)))),
        ...['P', 'L', 'A', 'E', 'Rate'].map((h) => el('th', { scope: 'col', class: 'attn-total' }, h)))),
      el('tbody', {}, ...g.rows.map((r) => el('tr', { class: r.guest ? 'is-guest' : '' },
        el('th', { scope: 'row' }, r.name, r.guest ? el('span', { class: 'fb-meta' }, ' guest') : null),
        ...r.cells.map((cell) => el('td', { class: `attn-cell is-${cell || 'none'}`, title: cell ? STATUS_LABELS[cell] : 'not expected' }, LETTER[cell] || '')),
        el('td', { class: 'attn-total' }, String(r.totals.present)),
        el('td', { class: 'attn-total' }, String(r.totals.late)),
        el('td', { class: 'attn-total' }, String(r.totals.absent)),
        el('td', { class: 'attn-total' }, String(r.totals.excused)),
        el('td', { class: 'attn-total' }, pct(r.totals.rate))))));
    holder.replaceChildren(el('div', { class: 'attn-grid-wrap' }, table),
      el('p', { class: 'hint' }, 'P present · L late · A absent (including never checked in to a closed session) · E excused · blank: not on the roster yet, or check-in still open. The rate is present and late over present, late and absent; excused classes count for nothing.'));
  }

  // --- Canvas ---------------------------------------------------------------------------

  async function canvasExport() {
    const points = await dialog(`Canvas gradebook import for ${COURSE(pick.value)}`, (card, done) => {
      const field = (label, key, value) => el('label', {}, label, el('input', { type: 'text', inputmode: 'decimal', value, 'data-key': key, style: 'max-width: 90px' }));
      const form = el('form', { class: 'me-password' },
        el('p', { class: 'hint' }, 'One column per session, matched to Canvas by SIS User ID (the roster’s student ID). Points for each mark:'),
        field('Present', 'present', '1'), field('Late', 'late', '0.5'), field('Excused (a number, or EX)', 'excused', 'EX'), field('Absent', 'absent', '0'),
        el('div', { class: 'admin-actions' },
          el('button', { type: 'submit', class: 'primary' }, 'Download'),
          el('button', { type: 'button', onclick: () => done(null) }, 'Cancel')));
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        done(Object.fromEntries([...form.querySelectorAll('input[data-key]')].map((i) => [i.dataset.key, i.value.trim()])));
      });
      card.append(form);
    });
    if (!points) return;
    const url = `${base()}/export?format=canvas&${range()}&${new URLSearchParams(points)}`;
    // Asked first, so a refusal (points that make no sense) is said here
    // rather than downloaded as an error page.
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) { say((await res.json().catch(() => ({}))).error || 'That did not export.', true); return; }
    const link = el('a', { href: URL.createObjectURL(await res.blob()), download: `${pick.value}-attendance-canvas.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    say('Downloaded. In Canvas: Grades → Import, and choose this file.');
  }

  pick.addEventListener('change', () => { reviewing = null; say(''); load(); });
  $('#attn-from').addEventListener('change', load);
  $('#attn-to').addEventListener('change', load);
  $('#attn-show-sessions').addEventListener('click', () => { reviewing = null; view = 'sessions'; load(); });
  $('#attn-show-grid').addEventListener('click', () => { reviewing = null; view = 'grid'; load(); });
  $('#attn-export-canvas').addEventListener('click', canvasExport);

  return {
    async open() { fillCourses(); await load(); },
  };
}
