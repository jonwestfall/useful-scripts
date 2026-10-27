// YouTube links of every shape the planner and controller are pasted
// (assets/js/util.js, guessItemFromUrl): the video id, and the start time.
//
//   node podium/test/youtube-url.test.mjs

import { guessItemFromUrl } from '../assets/js/util.js';

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const read = (url) => { const g = guessItemFromUrl(url); return g ? `${g.type} ${g.videoId ?? ''} ${g.startAt ?? ''}`.trim() : null; };

const cases = [
  ['https://www.youtube.com/watch?v=ZMLzP1VCANo', 'youtube ZMLzP1VCANo 0'],
  ['https://www.youtube.com/watch?v=ZMLzP1VCANo&t=42', 'youtube ZMLzP1VCANo 42'],
  ['https://youtu.be/ZMLzP1VCANo?t=42', 'youtube ZMLzP1VCANo 42'],
  ['https://youtu.be/ZMLzP1VCANo?si=abcDEF&t=42s', 'youtube ZMLzP1VCANo 42'],
  ['https://youtu.be/ZMLzP1VCANo?t=1m30s', 'youtube ZMLzP1VCANo 90'],
  ['https://m.youtube.com/watch?feature=share&v=ZMLzP1VCANo&t=1h2m3s', 'youtube ZMLzP1VCANo 3723'],
  ['https://www.youtube.com/watch?app=desktop&v=ZMLzP1VCANo', 'youtube ZMLzP1VCANo 0'],
  ['https://www.youtube.com/watch?list=PL123&v=ZMLzP1VCANo&index=2', 'youtube ZMLzP1VCANo 0'],
  ['https://www.youtube.com/watch?v=ZMLzP1VCANo#t=20', 'youtube ZMLzP1VCANo 20'],
  ['https://www.youtube.com/embed/ZMLzP1VCANo?start=15', 'youtube ZMLzP1VCANo 15'],
  ['https://youtube.com/shorts/ZMLzP1VCANo', 'youtube ZMLzP1VCANo 0'],
  ['  https://youtu.be/ZMLzP1VCANo  ', 'youtube ZMLzP1VCANo 0'],
];
for (const [url, want] of cases) ok(`${url.trim()} -> ${want}`, read(url) === want);
ok('half a link is not a video yet', read('https://www.youtube.com/watch?v=ZMLzP1V')?.startsWith('youtube') !== true);
ok('a live link is a stream, not a video', read('https://www.youtube.com/live/ZMLzP1VCANo')?.startsWith('stream') === true);
ok('a bare id is not a link', read('ZMLzP1VCANo')?.startsWith('youtube') !== true);

if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
