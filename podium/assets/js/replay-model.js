// Playing a lecture back (Issue #132): what the replay needs, worked out from
// a lecture as GET /api/lectures/:id returns it. No DOM in here - the page
// (replay.js) draws it and keeps the clock, and the tests check this.
//
// A replay runs on the lecture's own clock, in milliseconds since the epoch,
// from when it started to when it ended. At any moment on that clock:
//
//   tracks    each controller mic that recorded into it, as segments, and
//             which segment (if any) was playing then
//   scenes    what was on the projector, and the picture of it that was kept
//             - an annotated slide from the export, or a marked-up screen
//   captions  what was being said, as the caption bar showed it
//   marks     the things worth seeing on the scrubber: what went on screen,
//             each poll as it closed

import { captionText, describeEvent, folderName } from './recap.js';

// How long one mic segment runs (control.js's MIC_CHUNK_MS). Only used to
// place a segment recorded before segments said their own times.
export const SEGMENT_MS = 120000;

// A caption line stays under the stage this long after it was finished,
// unless the next one replaces it sooner.
export const CAPTION_HOLD_MS = 6000;

const SLIDE_FILE_RE = /^slides\/([^/]+)\/slide-(\d+)\.png$/i;

/**
 * What a mic segment's file name says about it:
 *   audio/<device>-<recording>-<seq>-t<start>-d<length>.<ext>   (Issue #132)
 *   audio/<device>-<recording>-<seq>.<ext>                       (before it)
 * Returns null for anything else.
 */
export function parseSegmentName(name) {
  const m = /^audio\/(.+)-(\d{10,})-(\d{1,6})(?:-t(\d{10,})-d(\d{1,9}))?\.(webm|ogg)$/i.exec(String(name || ''));
  if (!m) return null;
  const [, device, recording, seq, start, length, ext] = m;
  return {
    device,
    recording: Number(recording),
    seq: Number(seq),
    start: start ? Number(start) : null,
    length: length ? Number(length) : null,
    ext: ext.toLowerCase(),
  };
}

/**
 * The lecture's mic audio as tracks, one per device: each a list of segments
 * { url, name, start, end, exact } in order. A segment that says its own
 * times is placed exactly; an older one at its recording's start plus
 * SEGMENT_MS per segment before it, ending where the next one begins.
 */
export function buildTracks(files, { segmentMs = SEGMENT_MS } = {}) {
  const byDevice = new Map();
  for (const file of files || []) {
    if (file.kind !== 'audio') continue;
    const info = parseSegmentName(file.name);
    if (!info) continue;
    const exact = info.start != null;
    const start = exact ? info.start : info.recording + info.seq * segmentMs;
    const segment = { url: file.url, name: file.name, start, end: exact ? start + info.length : start + segmentMs, exact };
    if (!byDevice.has(info.device)) byDevice.set(info.device, []);
    byDevice.get(info.device).push(segment);
  }
  const tracks = [];
  for (const [device, segments] of byDevice) {
    segments.sort((a, b) => a.start - b.start);
    // A guessed end never runs over the next segment's start.
    for (let i = 0; i < segments.length - 1; i++) {
      if (!segments[i].exact) segments[i].end = Math.min(segments[i].end, segments[i + 1].start);
    }
    tracks.push({ device, segments: segments.filter((s) => s.end > s.start) });
  }
  tracks.sort((a, b) => (a.segments[0]?.start ?? 0) - (b.segments[0]?.start ?? 0));
  return tracks.map((t, i) => ({ ...t, label: tracks.length > 1 ? `Mic ${i + 1}` : 'Mic' }));
}

/** The segment of `track` playing at `t`, or null. */
export function segmentAt(track, t) {
  for (const s of track.segments) {
    if (s.start > t) return null;
    if (t < s.end) return s;
  }
  return null;
}

/**
 * What was on the projector, as scenes { at, title, note, slide, image }, in
 * order. The picture is the annotated slide the export kept for it, else the
 * marked-up screen saved when it was replaced (Issue #183) - filed at that
 * moment, so it belongs to the scene that was up just before.
 */
export function buildScenes(timeline, files) {
  const scenes = timeline
    .filter((e) => e.kind === 'program')
    .map((e) => ({ at: e.at, title: e.title || '—', note: describeEvent(e), slide: e.detail?.slide || null, image: null }));
  for (const file of files || []) {
    const m = SLIDE_FILE_RE.exec(file.name);
    if (!m) continue;
    const [, folder, number] = m;
    for (const scene of scenes) {
      if (!scene.image && scene.slide === Number(number) && folderName(scene.title) === folder.toLowerCase()) scene.image = file.url;
    }
  }
  const screens = (files || []).filter((f) => /^screens\//.test(f.name)).sort((a, b) => a.at - b.at);
  for (const file of screens) {
    let owner = null;
    for (const scene of scenes) {
      if (scene.at >= file.at) break;
      owner = scene;
    }
    if (owner && !owner.image) owner.image = file.url;
  }
  return scenes;
}

/** The latest entry of `list` (sorted by `at`) at or before `t`, or null. */
export function latestAt(list, t) {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].at <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? null : list[found];
}

/** The index of that entry, or -1. */
export function indexAt(list, t) {
  const entry = latestAt(list, t);
  return entry ? list.indexOf(entry) : -1;
}

/** The caption under the stage at `t`: the last line said, for a few seconds. */
export function captionAt(captions, t, hold = CAPTION_HOLD_MS) {
  const line = latestAt(captions, t);
  return line && t - line.at < hold ? line : null;
}

/**
 * Everything the replay needs from a lecture.
 *
 *   { start, end, tracks, scenes, captions, marks, hasAudio }
 */
export function buildReplay(detail, opts = {}) {
  const timeline = [...(detail.timeline || [])].sort((a, b) => a.at - b.at);
  const tracks = buildTracks(detail.files, opts);
  const scenes = buildScenes(timeline, detail.files);
  const captions = timeline
    .filter((e) => e.kind === 'caption')
    .map((e) => ({ at: e.at, text: captionText(e) }))
    .filter((c) => c.text);
  const marks = [
    ...scenes.map((s) => ({ at: s.at, kind: 'program', label: s.title })),
    ...(detail.pollResults || []).map((p) => ({ at: p.endedAt, kind: 'poll', label: `Poll: ${p.question || ''}`.trim() })),
  ].sort((a, b) => a.at - b.at);
  const start = Number(detail.startedAt) || timeline[0]?.at || 0;
  const lastSeen = Math.max(
    start,
    Number(detail.endedAt) || 0,
    timeline.length ? timeline[timeline.length - 1].at : 0,
    ...tracks.flatMap((t) => t.segments.map((s) => s.end)),
    ...marks.map((m) => m.at),
  );
  return { start, end: lastSeen, tracks, scenes, captions, marks, hasAudio: tracks.some((t) => t.segments.length) };
}

/** "m:ss", or "h:mm:ss" from an hour, for `ms` into the lecture. */
export function clockOf(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
