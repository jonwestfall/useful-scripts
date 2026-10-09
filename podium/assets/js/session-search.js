// Searching past sessions (Issue #159, phase 2): one box, used by My Files'
// Recorded lectures and the admin page's Sessions tab.
//
// The server does the finding (GET /api/lectures/search, see lectures.js):
// only sessions this account could already open, best match first, each hit
// naming the timeline moment it came from. This is the other half - showing
// the hits, and opening one: the session's whole timeline, scrolled to that
// moment and marked, with the lines around it for context and the other
// matches in the same session a step away.
//
// Snippets arrive as [{ text, hit }] parts, never markup, so nothing here
// renders a string as HTML.

import { el } from './util.js';
import { describeEvent, captionText } from './recap.js';
import { dayAndTime, spanOf } from './recap-pdf.js';
import { replayUrl } from './replay-model.js';

// "Play from here" (Issue #132): the replay, in a tab of its own, from just
// before the moment.
const playFrom = (lectureId, startedAt, at) => window.open(replayUrl(lectureId, startedAt, at), '_blank', 'noopener');

const KIND_LABEL = {
  caption: 'Said', program: 'On screen', note: 'Note', poll: 'Poll', attendance: 'Attendance',
  questions: 'Check-in questions', parking: 'Parking lot',
};
const kindLabel = (kind) => KIND_LABEL[kind] || kind;
const pad = (n) => String(n).padStart(2, '0');
const clock = (ms) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`;
const into = (ms, start) => {
  const m = Math.max(0, Math.round((ms - start) / 60000));
  return m < 60 ? `${m} min in` : `${Math.floor(m / 60)} h ${pad(m % 60)} in`;
};

/** A snippet's parts as nodes, the matched words in <mark>. */
const snippetNodes = (parts) => parts.map((p) => (p.hit ? el('mark', {}, p.text) : p.text));

/** `text` with each of `words` (any case, wherever they occur) in <mark>. */
function marked(text, words) {
  const wanted = [...new Set(words.map((w) => w.trim()).filter(Boolean))];
  if (!wanted.length) return [text];
  const escape = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // split() with one capture group alternates: text, match, text, match...
  return String(text).split(new RegExp(`(${wanted.map(escape).join('|')})`, 'iu'))
    .map((piece, i) => (i % 2 ? el('mark', {}, piece) : piece))
    .filter((piece) => piece !== '');
}

const hitKey = (hit) => (hit.parkingId ? `k${hit.parkingId}`
  : hit.kind === 'questions' ? `q${hit.attendanceId}`
    : hit.pollId ? `p${hit.pollId}` : `e${hit.eventId}`);
// Who asked a parking-lot question: a name only when it was asked in one. An
// anonymous question never had a name kept to show.
const askedBy = (hit) => (hit.kind !== 'parking' ? null : hit.who ? `asked by ${hit.who}` : 'anonymous');

/**
 * Mount the search box into `host`.
 *
 *   onActive(active)  told when a search starts showing results (the page
 *                     hides its own list) and when it is cleared again
 *   label             the box's accessible name
 *
 * Returns { setCourses(codes), search(q), clear() }.
 */
export function mountSessionSearch(host, { onActive = () => {}, label = 'Search past sessions' } = {}) {
  const input = el('input', {
    type: 'search', class: 'ss-input', autocomplete: 'off', enterkeyhint: 'search',
    placeholder: 'Search what was said and shown…', 'aria-label': label,
  });
  const course = el('select', { class: 'ss-course', 'aria-label': 'Which course to search', hidden: true },
    el('option', { value: '' }, 'All courses'));
  const note = el('p', { class: 'hint ss-note', role: 'status', 'aria-live': 'polite' });
  const results = el('div', { class: 'ss-results' });
  const form = el('form', { class: 'ss-bar', role: 'search', onsubmit: (ev) => { ev.preventDefault(); run(); } }, input, course);
  host.replaceChildren(form, note, results);

  let timer = null;
  let inflight = null;
  let active = false;
  let lastQuery = '';
  const sessions = new Map();     // lecture id -> GET /api/lectures/:id, once read

  const setActive = (on) => { if (on !== active) { active = on; onActive(on); } };

  function clear() {
    clearTimeout(timer);
    inflight?.abort();
    lastQuery = '';
    note.textContent = '';
    results.replaceChildren();
    setActive(false);
  }

  async function run() {
    clearTimeout(timer);
    const q = input.value.trim();
    const key = `${q}\u0000${course.value}`;
    if (!q) { clear(); return; }
    if (key === lastQuery) return;
    lastQuery = key;
    inflight?.abort();
    inflight = new AbortController();
    note.textContent = 'Searching…';
    setActive(true);
    try {
      const params = new URLSearchParams({ q });
      if (course.value) params.set('course', course.value);
      const res = await fetch(`/api/lectures/search?${params}`, { credentials: 'same-origin', signal: inflight.signal });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      show(body.results || []);
    } catch (err) {
      if (err.name === 'AbortError') return;
      lastQuery = '';
      note.textContent = `The search did not work: ${err.message}`;
      results.replaceChildren();
    }
  }

  function show(found) {
    const hits = found.reduce((n, r) => n + r.hits.length + (r.more || 0), 0);
    note.textContent = found.length
      ? `${hits} match${hits === 1 ? '' : 'es'} in ${found.length} session${found.length === 1 ? '' : 's'}, best first.`
      : 'Nothing in your sessions matches that. Try fewer or shorter words - "memor*" finds memory, memorise and memorable.';
    results.replaceChildren(...found.map(sessionResult));
  }

  // A check-in taken with no recorded lecture (Issue #159, phase 3): its
  // questions are found, but there is no timeline to open.
  function attendanceResult({ attendance, hits, more }) {
    const name = attendance.title || 'Check-in';
    return el('section', { class: 'ss-session', 'aria-label': name },
      el('div', { class: 'ss-head' },
        el('span', { class: 'fb-title' }, name),
        el('span', { class: 'fb-meta' }, [dayAndTime(attendance.startedAt), attendance.course && attendance.course.toUpperCase(),
          'check-in, no recorded lecture'].filter(Boolean).join(' · '))),
      el('ul', { class: 'ss-hits' }, ...hits.map((hit) => el('li', { class: 'ss-hit is-static' },
        el('span', { class: 'timeline-at' }, clock(hit.at)),
        el('span', { class: 'ss-kind' }, kindLabel(hit.kind)),
        el('span', { class: 'ss-snip' }, ...snippetNodes(hit.snippet),
          askedBy(hit) ? el('span', { class: 'ss-who' }, ` — ${askedBy(hit)}`) : null)))),
      el('p', { class: 'hint' }, `${more ? `…and ${more} more. ` : ''}Its answers and the rest of its parking lot are on My Files › Attendance.`));
  }

  function sessionResult(result) {
    if (!result.lecture) return attendanceResult(result);
    const { lecture, hits, more } = result;
    const viewer = el('div', { class: 'ss-viewer', hidden: true });
    const name = lecture.title || lecture.room || 'Untitled session';
    const section = el('section', { class: 'ss-session', 'aria-label': name },
      el('div', { class: 'ss-head' },
        el('span', { class: 'fb-title' }, name),
        el('span', { class: 'fb-meta' }, [dayAndTime(lecture.startedAt), lecture.course && lecture.course.toUpperCase(), spanOf(lecture),
          lecture.owner && `by ${lecture.owner}`].filter(Boolean).join(' · '))),
      el('ul', { class: 'ss-hits' }, ...hits.map((hit, i) => el('li', { class: 'ss-hit-row' },
        el('button', {
          type: 'button', class: 'ss-hit', dataset: { key: hitKey(hit) },
          onclick: () => open(lecture, hits, i, viewer),
        },
        el('span', { class: 'timeline-at' }, clock(hit.at)),
        el('span', { class: 'ss-kind' }, kindLabel(hit.kind)),
        el('span', { class: 'ss-snip' }, ...snippetNodes(hit.snippet),
          askedBy(hit) ? el('span', { class: 'ss-who' }, ` — ${askedBy(hit)}`) : null)),
        el('button', {
          type: 'button', class: 'ss-play', title: 'Play from here', 'aria-label': `Play from ${clock(hit.at)}`,
          onclick: () => playFrom(lecture.id, lecture.startedAt, hit.at),
        }, '▶')))),
      more ? el('p', { class: 'hint' }, `…and ${more} more in this session - open it to see them all.`) : null,
      viewer);
    return section;
  }

  async function open(lecture, hits, index, viewer) {
    for (const other of results.querySelectorAll('.ss-viewer')) if (other !== viewer) { other.hidden = true; other.replaceChildren(); }
    viewer.hidden = false;
    if (!sessions.has(lecture.id)) {
      viewer.replaceChildren(el('p', { class: 'hint' }, 'Reading it…'));
      try {
        const res = await fetch(`/api/lectures/${lecture.id}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(res.status === 404 ? 'it is no longer there' : `HTTP ${res.status}`);
        sessions.set(lecture.id, (await res.json()).lecture);
      } catch (err) {
        viewer.replaceChildren(el('p', { class: 'hint is-bad' }, `That session did not open: ${err.message}`));
        return;
      }
    }
    renderViewer(sessions.get(lecture.id), hits, index, viewer);
  }

  function renderViewer(detail, hits, index, viewer) {
    // The words each matching row was found by, from its own snippet.
    const words = new Map(hits.map((h) => [hitKey(h), h.snippet.filter((p) => p.hit).map((p) => p.text)]));
    const rows = [
      ...(detail.timeline || []).map((e) => ({ key: `e${e.id}`, at: e.at, kind: e.kind, event: e })),
      ...(detail.pollResults || []).map((p) => ({ key: `p${p.id}`, at: p.endedAt, kind: 'poll', poll: p })),
      // What attendance asked is not part of the timeline itself; a match in
      // it is placed there, at its moment, as the snippet that found it.
      ...hits.filter((h) => h.kind === 'questions' || h.kind === 'parking')
        .map((h) => ({ key: hitKey(h), at: h.at, kind: h.kind, asked: h })),
    ].sort((a, b) => a.at - b.at);
    const list = el('div', { class: 'timeline ss-timeline', tabindex: '-1', 'aria-label': `Timeline of ${detail.title || detail.room || 'this session'}` });
    let current = null;
    for (const row of rows) {
      const match = words.get(row.key);
      const text = row.asked ? `${kindLabel(row.kind)}: ${row.asked.snippet.map((p) => p.text).join('')}`
        : row.poll ? `Poll: ${row.poll.question}` : row.kind === 'caption' ? `“${captionText(row.event)}”` : (row.event.title || '—');
      const node = el('div', {
        class: `timeline-row${row.kind === 'caption' ? ' timeline-caption' : ''}${match ? ' is-match' : ''}`,
        dataset: { key: row.key },
      },
      el('button', {
        type: 'button', class: 'timeline-at timeline-play', title: 'Play from here', 'aria-label': `Play from ${clock(row.at)}`,
        onclick: () => playFrom(detail.id, detail.startedAt, row.at),
      }, `▶ ${clock(row.at)}`),
      el('span', { class: 'timeline-what' }, ...(match ? marked(text, match) : [text])),
      row.asked ? (askedBy(row.asked) ? el('span', { class: 'timeline-note' }, askedBy(row.asked)) : null)
        : row.poll ? el('span', { class: 'timeline-note' }, `${row.poll.voters} voted`)
          : row.kind !== 'caption' ? el('span', { class: 'timeline-note' }, describeEvent(row.event)) : null);
      if (row.key === hitKey(hits[index])) { node.classList.add('is-current'); node.setAttribute('aria-current', 'true'); current = node; }
      list.append(node);
    }
    const step = (d) => renderViewer(detail, hits, (index + d + hits.length) % hits.length, viewer);
    const hit = hits[index];
    viewer.replaceChildren(
      el('div', { class: 'ss-nav' },
        el('span', { class: 'ss-where' }, `Match ${index + 1} of ${hits.length} · ${clock(hit.at)}, ${into(hit.at, detail.startedAt)}`),
        el('button', { type: 'button', class: 'admin-small ss-play-here', onclick: () => playFrom(detail.id, detail.startedAt, hit.at) }, '▶ Play from here'),
        hits.length > 1 ? el('button', { type: 'button', class: 'admin-small', onclick: () => step(-1) }, '‹ Previous') : null,
        hits.length > 1 ? el('button', { type: 'button', class: 'admin-small', onclick: () => step(1) }, 'Next ›') : null,
        el('button', { type: 'button', class: 'admin-small', onclick: () => { viewer.hidden = true; viewer.replaceChildren(); } }, 'Close')),
      list);
    // Into the middle of the timeline's own box, not by scrolling the page:
    // the lines before and after are the context.
    if (current) list.scrollTop = Math.max(0, current.offsetTop - list.offsetTop - (list.clientHeight - current.offsetHeight) / 2);
    if (!current) list.append(el('p', { class: 'hint' }, 'That moment is no longer in this session.'));
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (!input.value.trim()) { clear(); return; }
    timer = setTimeout(run, 300);
  });
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && input.value) { ev.preventDefault(); input.value = ''; clear(); } });
  course.addEventListener('change', () => { lastQuery = ''; if (input.value.trim()) run(); });

  return {
    /** The courses on offer in the filter; hidden with fewer than two. */
    setCourses(codes) {
      const list = [...new Set((codes || []).filter(Boolean))].sort();
      const was = course.value;
      course.replaceChildren(el('option', { value: '' }, 'All courses'), ...list.map((c) => el('option', { value: c }, c.toUpperCase())));
      course.value = list.includes(was) ? was : '';
      course.hidden = list.length < 2;
    },
    search(q) { input.value = q; lastQuery = ''; return run(); },
    clear() { input.value = ''; clear(); },
  };
}
