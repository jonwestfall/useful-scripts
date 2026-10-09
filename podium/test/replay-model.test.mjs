// Playing a lecture back (Issue #132, phase 1): where each mic segment sits
// on the lecture's clock, what was on screen and what was being said at any
// moment - the model replay.js draws from.
//
//   node podium/test/replay-model.test.mjs

import {
  parseSegmentName, buildTracks, segmentAt, buildScenes, buildReplay, captionAt, latestAt, indexAt, clockOf, SEGMENT_MS,
  buildPolls, buildPhotos, heldAt, replayUrl, POLL_HOLD_MS, PHOTO_HOLD_MS,
} from '../assets/js/replay-model.js';

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

const T0 = Date.UTC(2026, 9, 1, 14, 0, 0);

console.log('-- segment names --');
let p = parseSegmentName(`audio/ctl-ab12-${T0}-0003-t${T0 + 360500}-d119800.webm`);
ok(`a new name says its own start and length (${JSON.stringify(p)})`,
  p.device === 'ctl-ab12' && p.recording === T0 && p.seq === 3 && p.start === T0 + 360500 && p.length === 119800 && p.ext === 'webm');
p = parseSegmentName(`audio/mic-${T0}-0002.ogg`);
ok('an older one still parses, without them', p.device === 'mic' && p.seq === 2 && p.start === null && p.ext === 'ogg');
ok('anything else is not a segment', parseSegmentName('photos/abc.jpg') === null && parseSegmentName('audio/notes.txt') === null);

console.log('\n-- tracks --');
const file = (name, extra = {}) => ({ kind: 'audio', name, url: `/media/x/${name.split('/').pop()}`, ...extra });
const files = [
  file(`audio/a-${T0}-0001-t${T0 + 120400}-d119700.webm`),
  file(`audio/a-${T0}-0000-t${T0 + 100}-d120000.webm`),
  file(`audio/b-${T0 + 30000}-0000.webm`),
  file(`audio/b-${T0 + 30000}-0001.webm`),
  { kind: 'photo', name: 'photos/1.jpg', url: '/p' },
];
const tracks = buildTracks(files);
ok(`one track per device, in the order they began (${tracks.map((t) => `${t.device}:${t.label}`)})`,
  tracks.length === 2 && tracks[0].device === 'a' && tracks[0].label === 'Mic 1' && tracks[1].label === 'Mic 2');
ok('segments in order, placed exactly from their names', tracks[0].segments[0].start === T0 + 100 && tracks[0].segments[1].start === T0 + 120400
  && tracks[0].segments[1].end === T0 + 120400 + 119700 && tracks[0].segments.every((s) => s.exact));
ok('an older recording is placed by its sequence number', tracks[1].segments[1].start === T0 + 30000 + SEGMENT_MS && !tracks[1].segments[1].exact);
ok('one mic alone is just "Mic"', buildTracks([files[0]])[0].label === 'Mic');
ok('the segment playing at a moment', segmentAt(tracks[0], T0 + 60000) === tracks[0].segments[0]
  && segmentAt(tracks[0], T0 + 120200) === null && segmentAt(tracks[0], T0 + 130000) === tracks[0].segments[1]
  && segmentAt(tracks[0], T0 + 50) === null);

console.log('\n-- what was on screen --');
const timeline = [
  { at: T0 + 1000, kind: 'program', title: 'Working Memory', detail: { slide: 1 } },
  { at: T0 + 2000, kind: 'caption', title: 'hello', detail: { text: 'Hello everyone' } },
  { at: T0 + 60000, kind: 'program', title: 'Working Memory', detail: { slide: 2 } },
  { at: T0 + 90000, kind: 'caption', title: 'the loop', detail: { text: 'The phonological loop' } },
  { at: T0 + 120000, kind: 'program', title: 'Whiteboard' },
  { at: T0 + 200000, kind: 'program', title: 'Summary' },
];
const pictures = [
  { kind: 'session', name: 'slides/working-memory/slide-02.png', url: '/s2', at: T0 + 300000 },
  { kind: 'photo', name: 'screens/abc-Marked-up.png', url: '/board', at: T0 + 200000 },
];
const scenes = buildScenes(timeline, pictures);
ok(`each thing that went on screen is a scene (${scenes.map((s) => s.title)})`, scenes.length === 4);
ok('an annotated slide from the export goes with its slide', scenes[1].image === '/s2' && scenes[0].image === null);
ok('a marked-up screen goes with what was up just before it was saved', scenes[2].image === '/board' && scenes[3].image === null);

console.log('\n-- the whole replay --');
const r = buildReplay({ startedAt: T0, endedAt: T0 + 250000, timeline, files: [...files, ...pictures],
  pollResults: [{ id: 9, question: 'Which store?', endedAt: T0 + 150000, voters: 4 }] });
ok(`it runs from start to the last thing recorded (${(r.end - r.start) / 1000}s)`, r.start === T0 && r.end === T0 + 30000 + 2 * SEGMENT_MS && r.hasAudio);
ok(`captions in order, by their whole line (${r.captions.map((c) => c.text)})`, r.captions.length === 2 && r.captions[0].text === 'Hello everyone');
ok(`marks: what went on screen, and polls as they closed (${r.marks.map((m) => m.kind).join(',')})`,
  r.marks.length === 5 && r.marks[3].kind === 'poll' && r.marks[3].label === 'Poll: Which store?');
ok('what was on screen at a moment', latestAt(r.scenes, T0 + 130000).title === 'Whiteboard' && latestAt(r.scenes, T0 + 500) === null);
ok('and its position', indexAt(r.scenes, T0 + 61000) === 1 && indexAt(r.scenes, T0) === -1);
ok('the caption under the stage, for a few seconds', captionAt(r.captions, T0 + 3000)?.text === 'Hello everyone' && captionAt(r.captions, T0 + 30000) === null);
ok('a lecture with no audio still replays', buildReplay({ startedAt: T0, endedAt: T0 + 5000, timeline: [], files: [] }).hasAudio === false);

console.log('\n-- polls and photos (phase 2) --');
const polls = buildPolls([
  { id: 2, kind: 'text', question: 'One word?', answers: ['loop', 'rude word', 'buffer'], hiddenAnswers: [1], voters: 3, endedAt: T0 + 9000 },
  { id: 1, kind: 'choice', question: 'Which store?', options: ['Loop', 'Sketchpad'], counts: [3, 1], voters: 4, endedAt: T0 + 5000 },
  { id: 3, question: 'Never closed' },
]);
ok(`polls in the order they closed; one never closed is left out (${polls.map((p) => p.question)})`, polls.length === 2 && polls[0].question === 'Which store?');
ok(`a choice poll's rows with counts and shares (${JSON.stringify(polls[0].rows)})`, polls[0].rows[0].count === 3 && polls[0].rows[0].share === 0.75 && polls[0].rows[1].label === 'Sketchpad');
ok('a text poll shows only the answers the room saw', polls[1].answers.join() === 'loop,buffer');
const photos = buildPhotos([
  { kind: 'photo', name: 'photos/abc123-Lab-bench.jpg', url: '/p1', at: T0 + 7000 },
  { kind: 'photo', name: 'screens/xyz-Marked-up.png', url: '/s', at: T0 + 8000 },
]);
ok(`photos taken in the room, titled from their names (${JSON.stringify(photos)})`, photos.length === 1 && photos[0].title === 'Lab bench' && photos[0].url === '/p1');
ok('a poll result stays up a while after it closed, then goes', heldAt(polls, T0 + 6000, POLL_HOLD_MS)?.question === 'Which store?'
  && heldAt(polls, T0 + 4000, POLL_HOLD_MS) === null && heldAt(polls, T0 + 9000 + POLL_HOLD_MS + 1, POLL_HOLD_MS) === null);
ok('and so does a photo', heldAt(photos, T0 + 8000, PHOTO_HOLD_MS)?.url === '/p1' && heldAt(photos, T0 + 7000 + PHOTO_HOLD_MS, PHOTO_HOLD_MS) === null);
const withBoth = buildReplay({ startedAt: T0, endedAt: T0 + 20000, timeline: [], files: [{ kind: 'photo', name: 'photos/a-x.jpg', url: '/x', at: T0 + 1000 }],
  pollResults: [{ id: 1, question: 'Q', options: ['a'], counts: [1], voters: 1, endedAt: T0 + 2000 }] });
ok(`both are marked on the scrubber (${withBoth.marks.map((m) => m.kind)})`, withBoth.marks.map((m) => m.kind).join() === 'photo,poll' && withBoth.polls.length === 1 && withBoth.photos.length === 1);
ok(`"Play from here" starts a few seconds before the moment (${replayUrl(7, T0, T0 + 65000)})`,
  replayUrl(7, T0, T0 + 65000) === 'replay.html?lecture=7&at=62000' && replayUrl(7, T0, T0 + 1000) === 'replay.html?lecture=7');

console.log('\n-- screen video (phase 3) --');
const vname = `video/screen-ab-${T0}-0000-t${T0 + 500}-d30000.webm`;
ok(`a screen segment's name parses as video (${JSON.stringify(parseSegmentName(vname))})`, parseSegmentName(vname)?.media === 'video'
  && parseSegmentName(vname).device === 'screen-ab' && parseSegmentName(vname).length === 30000);
const vfiles = [
  { kind: 'video', name: vname, url: '/v0' },
  { kind: 'video', name: `video/screen-ab-${T0}-0001-t${T0 + 30600}-d29900.webm`, url: '/v1' },
  { kind: 'audio', name: `audio/mic-${T0}-0000-t${T0}-d60000.webm`, url: '/a0' },
];
const vr = buildReplay({ startedAt: T0, endedAt: T0 + 40000, timeline: [], files: vfiles });
ok(`video is its own track, apart from the mics (${vr.video.map((t) => `${t.label}:${t.segments.length}`)} / ${vr.tracks.map((t) => t.label)})`,
  vr.hasVideo && vr.video.length === 1 && vr.video[0].label === 'Screen' && vr.video[0].segments.length === 2 && vr.tracks.length === 1 && vr.tracks[0].label === 'Mic');
ok('the segment on screen at a moment', segmentAt(vr.video[0], T0 + 31000)?.url === '/v1' && segmentAt(vr.video[0], T0 + 30550) === null);
ok(`and the replay runs to the end of whatever ends last (${(vr.end - T0) / 1000}s)`, vr.end === T0 + 60500);
ok('no video, no video track', buildReplay({ startedAt: T0, timeline: [], files: [vfiles[2]] }).hasVideo === false);

console.log('\n-- the clock --');
ok(`m:ss, and h:mm:ss from an hour (${clockOf(75000)}, ${clockOf(3725000)})`, clockOf(75000) === '1:15' && clockOf(3725000) === '1:02:05' && clockOf(-5) === '0:00');

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
