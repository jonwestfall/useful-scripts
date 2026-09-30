// Run with: node podium/test/music-reload.test.mjs
// Issue #180: a long music queue made the controller slow to reload (every
// render started another download per track), and old lectures' tracks
// piled up in the queue for good.
import { createDurationProber } from '../assets/js/duration-probe.js';
import { clearStaleMusic, MUSIC_IDLE_RESET_MS, initialState } from '../assets/js/protocol.js';

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};

// A stand-in <audio>: records every download started and stopped, and lets
// the test decide when each one answers.
function fakeAudioFactory() {
  const made = [];
  const make = () => {
    const listeners = {};
    const a = {
      duration: NaN, preload: '', stopped: false, _src: '',
      set src(v) { this._src = v; },
      get src() { return this._src; },
      addEventListener: (t, f) => { listeners[t] = f; },
      removeEventListener: (t) => { delete listeners[t]; },
      removeAttribute(name) { if (name === 'src') { this._src = ''; this.stopped = true; } },
      load() {},
      answer(d) { this.duration = d; listeners.loadedmetadata?.(); },
      fail() { listeners.error?.(); },
    };
    made.push(a);
    return a;
  };
  return { made, make };
}

// Timers the test fires by hand.
function manualTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn) => { const id = next++; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id),
    fireAll: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
  };
}

console.log('-- one probe per track, however often it is asked --');
{
  const { made, make } = fakeAudioFactory();
  const t = manualTimers();
  const prober = createDurationProber({ makeAudio: make, base: () => 'https://room.example/control.html', concurrent: 2, ...t });
  const tracks = Array.from({ length: 30 }, (_, i) => `music/t${i}.mp3`);
  // Four renders a second for five seconds, none of them answered yet.
  for (let render = 0; render < 20; render++) for (const src of tracks) prober.probe(src);
  chk(`twenty renders of thirty tracks start ${made.length} downloads, not 600`, made.length === 2);
  chk('the rest wait their turn', prober.queued() === 28 && prober.inFlight() === 2);
  made[0].answer(125);
  chk('an answer stops that download', made[0].stopped);
  chk('and starts the next track', made.length === 3 && prober.inFlight() === 2);
  chk('the length is kept under the src as written and as resolved',
    prober.durations.get('music/t0.mp3') === 125 && prober.durations.get('https://room.example/music/t0.mp3') === 125);
  t.fireAll();
  chk('a track that never answers gives up as unknown, and its download is stopped too',
    made[1].stopped && prober.durations.get('music/t1.mp3') === 0);
  for (const src of tracks) prober.probe(src);
  const before = made.length;
  prober.probe('music/t0.mp3');
  prober.probe('music/t1.mp3');
  chk('a track already answered - found or not - is never probed again', made.length === before);
}

console.log('-- callers still hear back --');
{
  const { made, make } = fakeAudioFactory();
  const t = manualTimers();
  let settled = 0;
  const prober = createDurationProber({ makeAudio: make, base: () => 'https://room.example/', onSettled: () => settled++, ...t });
  const heard = [];
  prober.probe('a.mp3', (d) => heard.push(['first', d]));
  prober.probe('https://room.example/a.mp3', (d) => heard.push(['second', d]));
  chk('the same track under two spellings is one download', made.length === 1);
  made[0].answer(61);
  chk('and both callers are told', heard.length === 2 && heard.every(([, d]) => d === 61));
  prober.probe('a.mp3', (d) => heard.push(['late', d]));
  chk('a caller asking afterwards is answered at once', heard.at(-1)[0] === 'late');
  prober.probe('b.mp3', () => heard.push(['never']));
  made[1].fail();
  chk('an error is not a length, so its caller is not told one', !heard.some(([w]) => w === 'never'));
  chk('onSettled fires once per track, found or not', settled === 2);
  prober.probe('');
  prober.probe('http://[bad');
  chk('an empty or unreadable src starts nothing', made.length === 2);
}

console.log('-- old lectures\' music does not pile up (#180) --');
{
  const now = Date.UTC(2026, 8, 30, 14);
  const withQueue = (playing = false) => {
    const s = initialState();
    s.music.tracks = [{ src: 'monday.mp3', title: 'Monday' }, { src: 'tuesday.mp3', title: 'Tuesday' }];
    s.music.index = 1;
    s.music.playlist = 'Last week';
    s.music.playing = playing;
    s.music.volume = 0.35;
    s.music.pauseQueue = true;
    return s;
  };
  const stale = withQueue();
  chk('a queue untouched since yesterday is cleared before today\'s first command',
    clearStaleMusic(stale, now - 20 * 3600 * 1000, now) && stale.music.tracks.length === 0
    && stale.music.index === 0 && stale.music.playlist === '');
  chk('keeping the room\'s music level and Pause Queue', stale.music.volume === 0.35 && stale.music.pauseQueue === true);
  const recent = withQueue();
  chk('one used within the last few hours is left alone',
    !clearStaleMusic(recent, now - MUSIC_IDLE_RESET_MS + 60000, now) && recent.music.tracks.length === 2);
  const playing = withQueue(true);
  chk('and one that is playing is never cleared, however old', !clearStaleMusic(playing, now - 48 * 3600 * 1000, now)
    && playing.music.tracks.length === 2);
  const unknown = withQueue();
  chk('with no idea when the room was last used, nothing is cleared', !clearStaleMusic(unknown, 0, now));
  chk('an empty queue has nothing to clear', !clearStaleMusic(initialState(), now - 48 * 3600 * 1000, now));
}

if (!ok) process.exit(1);
console.log('all music reload checks passed');
