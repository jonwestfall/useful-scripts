// How long each queued music track is, for the Music tab's queue and the
// "We begin in…" countdown to the end of the queue. Shared by the controller
// and the display (Issue #180).
//
// Both used to carry their own copy of a prober that started a fresh
// <audio preload="metadata"> for every track on EVERY render until that
// track's answer came back - and both render several times a second. A queue
// of thirty tracks on a slow server was hundreds of downloads in the first
// few seconds, none of them ever stopped, which took every connection the
// browser would open to that server. The controller's own page then waited
// behind them: reloading it next to a room with a long queue took ten to
// twenty-five seconds.
//
// So: one probe per track, however often it is asked for; a few at a time;
// and each download stopped the moment its length is known, or it gives up.

/**
 * @param {object} [opts]
 * @param {() => HTMLAudioElement} [opts.makeAudio]
 * @param {() => string} [opts.base] - what a relative src resolves against
 * @param {number} [opts.timeoutMs] - a track that has not answered by then counts as unknown (0)
 * @param {number} [opts.concurrent] - probes allowed in flight at once
 * @param {() => void} [opts.onSettled] - after each track's answer, found or not
 */
export function createDurationProber({
  makeAudio = () => new Audio(),
  base = () => globalThis.location?.href,
  timeoutMs = 4000,
  concurrent = 2,
  onSettled = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  // Keyed by the src as written AND by the resolved URL, as both copies of
  // the old prober were: callers look tracks up by whichever they hold.
  const durations = new Map();
  const pending = new Map();   // resolved URL -> { srcs: Set, callbacks: [] }
  const waiting = [];          // resolved URLs not started yet, in order asked
  let running = 0;

  function resolve(src) {
    try { return new URL(src, base()).href; } catch { return null; }
  }

  function settle(url, duration) {
    const job = pending.get(url);
    pending.delete(url);
    durations.set(url, duration);
    for (const src of job?.srcs || []) durations.set(src, duration);
    for (const callback of job?.callbacks || []) {
      if (duration > 0) callback(duration);
    }
    onSettled(url, duration);
  }

  function start(url) {
    running++;
    const audio = makeAudio();
    let done = false;
    let timer = null;
    const finish = (duration) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('error', onError);
      // Stop the download: the length is all this wanted.
      audio.removeAttribute?.('src');
      try { audio.load?.(); } catch { /* nothing left to cancel */ }
      running--;
      settle(url, duration);
      pump();
    };
    const onLoaded = () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
    const onError = () => finish(0);
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('error', onError);
    timer = setTimer(() => finish(0), timeoutMs);
    audio.preload = 'metadata';
    audio.src = url;
  }

  function pump() {
    while (running < concurrent && waiting.length) start(waiting.shift());
  }

  /** Ask for a track's length. Answered once per track; `onDone(seconds)` only when one is found. */
  function probe(src, onDone) {
    if (!src) return;
    const known = durations.get(src);
    if (known !== undefined) { if (known > 0 && onDone) onDone(known); return; }
    const url = resolve(src);
    if (!url) { durations.set(src, 0); return; }
    if (durations.has(url)) {
      const d = durations.get(url);
      durations.set(src, d);
      if (d > 0 && onDone) onDone(d);
      return;
    }
    let job = pending.get(url);
    if (!job) {
      job = { srcs: new Set(), callbacks: [] };
      pending.set(url, job);
      waiting.push(url);
    }
    job.srcs.add(src);
    if (onDone) job.callbacks.push(onDone);
    pump();
  }

  return { durations, probe, inFlight: () => running, queued: () => waiting.length };
}
