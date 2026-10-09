// Replay (Issue #132): a recorded lecture played back on its own clock.
//
// The lecture's clock is the one thing everything hangs off: the mic audio,
// what was on screen, the caption under the stage and the transcript all ask
// "what was happening at t?" (see replay-model.js). While a mic segment is
// playing, the clock is read from that audio element, so the words and the
// pictures stay with the sound even when the audio stalls to buffer; between
// segments, and in a lecture with no audio at all, it simply runs.
//
//   replay.html?lecture=<id>[&at=<ms into the lecture>]

import { $, el } from './util.js';
import { mountSessionBadge } from './server.js';
import { startPageTheme } from './theme.js';
import { dayAndTime, spanOf } from './recap-pdf.js';
import { buildReplay, segmentAt, indexAt, captionAt, clockOf } from './replay-model.js';

startPageTheme();

const params = new URLSearchParams(location.search);
const lectureId = Number(params.get('lecture'));

const SKIP_MS = 15000;
// How far an audio element may drift from the clock before it is moved back.
const DRIFT_MS = 400;
const CAPTION_HOLD_MS = 8000;

let model = null;
let t = 0;                 // the lecture's clock, ms since the epoch
let playing = false;
let rate = 1;
let lastTick = 0;
let frame = 0;
let shownScene = -2;
let shownLine = -2;
let dragging = false;
const players = [];        // one per mic track: { track, audio, url }

function warn(text) {
  const note = $('#rp-warn');
  note.textContent = text;
  note.hidden = !text;
}

async function load() {
  mountSessionBadge($('#session-badge'));
  if (!lectureId) { warn('No lecture to replay - open one from My Files › Recorded lectures.'); $('#rp-title').textContent = ''; return; }
  let detail;
  try {
    const res = await fetch(`/api/lectures/${lectureId}`, { credentials: 'same-origin' });
    if (res.status === 404) throw new Error('That lecture is not there, or it is not one you can open.');
    if (!res.ok) throw new Error(`It did not load (HTTP ${res.status}).`);
    detail = (await res.json()).lecture;
  } catch (err) {
    $('#rp-title').textContent = '';
    warn(err.message);
    return;
  }
  model = buildReplay(detail);
  const name = detail.title || detail.room || 'Untitled session';
  document.title = `${name} — Replay — Podium`;
  $('#rp-title').textContent = name;
  $('#rp-meta').textContent = [dayAndTime(detail.startedAt), detail.course && detail.course.toUpperCase(), spanOf(detail)].filter(Boolean).join(' · ');

  for (const track of model.tracks) {
    const audio = el('audio', { preload: 'auto' });
    audio.addEventListener('loadedmetadata', () => sync(true));
    document.body.append(audio);
    players.push({ track, audio, url: '' });
  }
  $('#rp-audio-note').textContent = model.hasAudio
    ? `${model.tracks.length === 1 ? 'The controller mic' : `${model.tracks.length} controller mics`} recorded into this lecture. Where nothing was recorded, the replay carries on silently.`
    : 'No microphone was recorded in this lecture, so the replay plays what was on screen and what was said, in time, without sound.';

  drawTranscript();
  drawMarks();
  const at = Number(params.get('at'));
  seek(model.start + (Number.isFinite(at) && at > 0 ? at : 0));
  $('#rp-main').hidden = false;
}

// --- the clock ----------------------------------------------------------------

/** The audio element the clock is read from right now, if any. */
function leader() {
  for (const p of players) {
    const seg = segmentAt(p.track, t);
    if (seg && p.url === seg.url && !p.audio.paused && p.audio.readyState >= 2) return { p, seg };
  }
  return null;
}

function tick(now) {
  if (playing) {
    const lead = leader();
    if (lead) t = lead.seg.start + lead.p.audio.currentTime * 1000;
    else t += (now - lastTick) * rate;
    if (t >= model.end) { t = model.end; pause(); }
  }
  lastTick = now;
  sync(false);
  draw();
  if (playing) frame = requestAnimationFrame(tick);
}

/** Every mic track playing whatever covers `t`, where `t` says it should be. */
function sync(force) {
  const lead = playing ? leader() : null;
  for (const p of players) {
    const seg = segmentAt(p.track, t);
    if (!seg) {
      if (!p.audio.paused) p.audio.pause();
      continue;
    }
    if (p.url !== seg.url) {
      p.url = seg.url;
      p.audio.src = seg.url;
      p.audio.playbackRate = rate;
      continue;   // loadedmetadata brings it back here to be placed
    }
    if (p.audio.readyState < 1) continue;
    const want = (t - seg.start) / 1000;
    const isLead = lead && lead.p === p;
    if (!isLead && (force || Math.abs(p.audio.currentTime - want) * 1000 > DRIFT_MS)) {
      try { p.audio.currentTime = want; } catch { /* not seekable yet */ }
    }
    if (p.audio.playbackRate !== rate) p.audio.playbackRate = rate;
    if (playing && p.audio.paused) p.audio.play().catch(() => {});
    if (!playing && !p.audio.paused) p.audio.pause();
  }
}

function play() {
  if (!model || playing) return;
  if (t >= model.end) t = model.start;
  playing = true;
  lastTick = performance.now();
  sync(true);
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(tick);
  drawButton();
}

function pause() {
  playing = false;
  cancelAnimationFrame(frame);
  for (const p of players) p.audio.pause();
  drawButton();
  remember();
}

function seek(to) {
  if (!model) return;
  t = Math.min(model.end, Math.max(model.start, to));
  lastTick = performance.now();
  sync(true);
  draw();
  if (!playing) remember();
}

// The address keeps the moment, so a reload or a copied link comes back here.
function remember() {
  if (!model) return;
  const url = new URL(location.href);
  url.searchParams.set('at', String(Math.round(t - model.start)));
  history.replaceState(null, '', url);
}

// --- drawing --------------------------------------------------------------------

function drawButton() {
  const button = $('#rp-play');
  button.textContent = playing ? '❚❚ Pause' : '▶ Play';
  button.title = playing ? 'Pause (Space)' : 'Play (Space)';
  button.setAttribute('aria-pressed', String(playing));
}

function draw() {
  const span = Math.max(1, model.end - model.start);
  $('#rp-time').textContent = `${clockOf(t - model.start)} / ${clockOf(span)}`;
  if (!dragging) $('#rp-seek').value = String(Math.round(((t - model.start) / span) * 1000));
  $('#rp-seek').setAttribute('aria-valuetext', clockOf(t - model.start));

  const sceneIndex = indexAt(model.scenes, t);
  if (sceneIndex !== shownScene) {
    shownScene = sceneIndex;
    const scene = model.scenes[sceneIndex];
    const picture = $('#rp-picture');
    if (scene?.image) {
      picture.src = scene.image;
      picture.alt = scene.title;
      picture.hidden = false;
    } else {
      picture.hidden = true;
      picture.removeAttribute('src');
    }
    $('#rp-card').hidden = !!scene?.image;
    $('#rp-scene-title').textContent = scene ? scene.title : 'Before anything went on screen';
    $('#rp-scene-note').textContent = scene?.note || '';
  }
  const line = captionAt(model.captions, t, CAPTION_HOLD_MS);
  $('#rp-caption').textContent = line ? line.text : '';
  $('#rp-caption').classList.toggle('is-empty', !line);

  const lineIndex = indexAt(model.captions, t);
  if (lineIndex !== shownLine) {
    shownLine = lineIndex;
    const list = $('#rp-transcript');
    list.querySelector('.is-current')?.classList.remove('is-current');
    const row = list.querySelector(`[data-line="${lineIndex}"]`);
    if (row) {
      row.classList.add('is-current');
      // Within the transcript's own box, never by scrolling the page.
      const top = row.offsetTop - list.offsetTop - list.clientHeight / 3;
      list.scrollTo({ top: Math.max(0, top), behavior: playing ? 'smooth' : 'auto' });
    }
  }
}

function drawTranscript() {
  const list = $('#rp-transcript');
  const rows = [
    ...model.scenes.map((s) => ({ at: s.at, scene: s })),
    ...model.captions.map((c, i) => ({ at: c.at, caption: c, index: i })),
  ].sort((a, b) => a.at - b.at || (a.scene ? -1 : 1));
  if (!model.captions.length) {
    list.append(el('li', { class: 'hint rp-none' }, 'No captions were saved in this lecture - turn on live captions in class and what you say is kept here.'));
  }
  for (const row of rows) {
    if (row.scene) {
      list.append(el('li', { class: 'rp-line rp-line-scene' },
        el('button', { type: 'button', onclick: () => seek(row.at) },
          el('span', { class: 'rp-at' }, clockOf(row.at - model.start)),
          el('span', {}, `On screen: ${row.scene.title}`))));
      continue;
    }
    list.append(el('li', { class: 'rp-line', dataset: { line: String(row.index) } },
      el('button', { type: 'button', onclick: () => seek(row.at) },
        el('span', { class: 'rp-at' }, clockOf(row.at - model.start)),
        el('span', {}, row.caption.text))));
  }
}

function drawMarks() {
  const span = Math.max(1, model.end - model.start);
  $('#rp-marks').replaceChildren(...model.marks.map((m) => el('span', {
    class: `rp-mark rp-mark-${m.kind}`,
    title: `${clockOf(m.at - model.start)} · ${m.label}`,
    style: { left: `${((m.at - model.start) / span) * 100}%` },
  })));
}

// --- controls ---------------------------------------------------------------------

$('#rp-play').addEventListener('click', () => (playing ? pause() : play()));
$('#rp-back').addEventListener('click', () => seek(t - SKIP_MS));
$('#rp-fwd').addEventListener('click', () => seek(t + SKIP_MS));
$('#rp-rate').addEventListener('change', (ev) => {
  rate = Number(ev.target.value) || 1;
  for (const p of players) p.audio.playbackRate = rate;
});
const seekInput = $('#rp-seek');
seekInput.addEventListener('input', () => {
  dragging = true;
  seek(model.start + (Number(seekInput.value) / 1000) * (model.end - model.start));
});
seekInput.addEventListener('change', () => { dragging = false; });

document.addEventListener('keydown', (ev) => {
  if (!model || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const tag = ev.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (!(tag === 'INPUT' && ev.target.type === 'range' && (ev.key === ' ' || ev.key === 'k'))) return;
  }
  if (ev.key === ' ' || ev.key === 'k') {
    if (ev.target?.tagName === 'BUTTON' && ev.key === ' ') return;   // the button's own click
    ev.preventDefault();
    if (playing) pause(); else play();
  } else if (ev.key === 'ArrowLeft' || ev.key === 'j') { ev.preventDefault(); seek(t - SKIP_MS); }
  else if (ev.key === 'ArrowRight' || ev.key === 'l') { ev.preventDefault(); seek(t + SKIP_MS); }
  else if (ev.key === 'Home') { ev.preventDefault(); seek(model.start); }
  else if (ev.key === 'End') { ev.preventDefault(); seek(model.end); }
});

// Tests reach the clock through this, the same way display.js offers its own
// hooks: nothing on the page depends on it.
window.__podiumReplay = {
  get t() { return model ? t - model.start : 0; },
  get playing() { return playing; },
  get model() { return model; },
  seek: (ms) => seek(model.start + ms),
};

load();
