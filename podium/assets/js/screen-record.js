// Recording the display's own screen (Issue #132, phase 3).
//
// The display asks the browser to share its own tab (the only thing a page
// may capture, and only from a click - see goLiveRecording in display.js),
// then records it the way the controller records its mic (#147): in short
// segments, each a complete, independently playable WebM, uploaded as it
// goes, so a lecture that stops early keeps what was already recorded and the
// browser never holds an hour of video in memory. Each segment's name says
// when it started and how long it ran, which is how the replay lines the
// video up with everything else:
//
//   video/<device>-<recording>-<seq>-t<start ms>-d<length ms>.webm
//
// No DOM and no lecture bookkeeping here: the display hands over the stream
// and an upload function, and is told when recording stops and why.

// Overridable so a test can see a segment boundary without waiting for one.
export const SCREEN_SEGMENT_MS = Number(globalThis.__PODIUM_TEST_SCREEN_SEGMENT_MS__) || 30000;

// Slides and text at a modest rate: 1.2 Mbit/s is 0.15 MB a second, so a
// 30-second segment is about 4.5 MB (well inside a lecture file's 16 MB) and
// an hour about 540 MB.
const VIDEO_BITS_PER_SECOND = 1200000;
const AUDIO_BITS_PER_SECOND = 96000;

/** What this browser can record a screen as, or ''. */
export function screenMimeType() {
  const R = globalThis.MediaRecorder;
  for (const type of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (R?.isTypeSupported?.(type)) return type;
  }
  return '';
}

/** Whether this browser could record its screen at all. */
export const canRecordScreen = () => !!(globalThis.navigator?.mediaDevices?.getDisplayMedia && globalThis.MediaRecorder && screenMimeType());

/**
 * Ask to share this tab. Must be called straight from a click: the browser
 * refuses otherwise. Resolves with the stream, or rejects if it was declined.
 */
export function requestScreen() {
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 15, max: 24 } },
    audio: true,
    // Chrome: offer this tab first, and do not let it switch to another.
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    surfaceSwitching: 'exclude',
  });
}

const pad = (n) => String(n).padStart(4, '0');

/**
 * Record `stream` in segments, handing each to `upload(name, blob)`, which
 * resolves with the HTTP status it got (or 0 for no network). A 403 or 413
 * means the server will take no more - turned off, or this lecture's budget
 * is used - and recording stops. So does the browser's own "Stop sharing".
 *
 *   onStop(reason)   'stopped' | 'ended' | 'refused' | 'full'
 *
 * Returns { stop(), get active }.
 */
export function createScreenRecorder({ stream, upload, onStop = () => {}, device = 'screen', segmentMs = SCREEN_SEGMENT_MS }) {
  const mimeType = screenMimeType();
  const recording = Date.now();
  let seq = 0;
  let recorder = null;
  let timer = null;
  let active = true;

  function finish(reason) {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    const r = recorder;
    recorder = null;
    if (r && r.state !== 'inactive') r.stop();
    for (const track of stream.getTracks()) track.stop();
    onStop(reason);
  }

  function begin() {
    if (!active) return;
    const r = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    const n = seq++;
    const parts = [];
    let startedAt = Date.now();
    r.onstart = () => { startedAt = Date.now(); };
    r.ondataavailable = (ev) => { if (ev.data.size) parts.push(ev.data); };
    r.onstop = () => {
      if (!parts.length) return;
      const name = `video/${device}-${recording}-${pad(n)}-t${startedAt}-d${Math.max(0, Date.now() - startedAt)}.webm`;
      Promise.resolve(upload(name, new Blob(parts, { type: 'video/webm' })))
        .then((status) => {
          if (status === 413) finish('full');
          else if (status === 403) finish('refused');
        })
        .catch(() => { /* no network: this segment is lost, the next may land */ });
    };
    recorder = r;
    r.start();
    timer = setTimeout(() => {
      if (recorder !== r) return;
      r.stop();
      begin();
    }, segmentMs);
  }

  // The browser's own "Stop sharing" button ends the video track.
  for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => finish('ended'));
  begin();

  return {
    stop: () => finish('stopped'),
    get active() { return active; },
  };
}
