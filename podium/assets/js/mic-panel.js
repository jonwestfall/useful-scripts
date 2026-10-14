// The controller's own mic (Issue #147), split out of control.js: recorded
// to the session, and amplified through the display.
//
// Independent of Live Captions (caption-panel.js), which never touches a MediaStream at
// all - this is the raw audio itself. Recorded in fixed-length segments,
// each a complete, independently playable file rather than a fragment only
// valid concatenated with the ones around it (a MediaRecorder timeslice
// would produce exactly that), uploaded as it goes the same reason
// chunkStrokes in display.js splits ink.json rather than holding it for one
// save at the end: a lecture that stops early keeps whatever already
// uploaded, not nothing. Stopping and immediately restarting the recorder
// at each boundary costs a sub-second gap in the audio, a fair trade for
// every segment standing on its own.
//
// Amplifying this same stream through the display is Issue #147's other
// half, layered on separately - this file only ever asks for the stream
// once (see startMic) and hands it out from here.

import { $ } from './util.js';
import { createMicSender } from './rtc.js';

/**
 * @param {object} deps
 * @param {Function} deps.getBus - the relay connection there is now, or null.
 * @param {Function} deps.recordingNow - whether this server is keeping a lecture now.
 * @param {Function} deps.getLectureId - the lecture a segment recorded now belongs to.
 * @param {Function} deps.fileWithLecture - uploads a file into a lecture's record.
 * @param {Function} deps.acknowledged - whether this device has already been asked about something.
 * @param {Function} deps.confirmOnce - asks once per device before something with a cost.
 */
export function createMicPanel({ getBus, recordingNow, getLectureId, fileWithLecture, acknowledged, confirmOnce }) {
  // Overridable the same way MAX_ASSET_ENTRIES is in display.js, so a test can
  // see a chunk boundary without actually waiting two minutes for one.
  const MIC_CHUNK_MS = Number(window.__PODIUM_TEST_MIC_CHUNK_MS__) || 120000;

  let micStream = null;
  // Sends this mic to the display to be heard in the room (rtc.js), for the
  // connection there is now (see connect).
  let micSender = null;
  let micRecorder = null;
  let micChunkTimer = null;
  let micRecordSeq = 0;
  let micSessionStamp = 0;

  function micMimeType() {
    for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
      if (window.MediaRecorder?.isTypeSupported?.(type)) return type;
    }
    return '';
  }

  // Named from this device's own bus id, a session start time and a sequence
  // number - never a local count alone, since more than one controller can be
  // recording into the same lecture at once (Issue #147 supports several
  // mics live together), and lecture_files is unique by name: two devices
  // racing to file "audio/0002.webm" would have the second replace the first
  // rather than both landing.
  //
  // Each segment also says when it started and how long it ran (Issue #132):
  // "-t<start ms>-d<length ms>" before the extension. A recorder's own file
  // carries no reliable duration (a MediaRecorder WebM reports Infinity), and
  // the stop-and-restart at each boundary means seq x 2 minutes drifts - the
  // replay lines each segment up with the timeline from these two numbers.
  // replay-model.js reads them, and places an older name without them from
  // its recording's start and its sequence number.
  function micChunkName(seq, startedAt, length) {
    const ext = micMimeType().includes('ogg') ? 'ogg' : 'webm';
    return `audio/${getBus()?.clientId || 'mic'}-${micSessionStamp}-${String(seq).padStart(4, '0')}-t${startedAt}-d${Math.max(0, Math.round(length))}.${ext}`;
  }

  function beginMicSegment() {
    if (!micStream || !recordingNow() || !window.MediaRecorder) return;
    const mimeType = micMimeType();
    const recorder = mimeType ? new MediaRecorder(micStream, { mimeType }) : new MediaRecorder(micStream);
    const seq = micRecordSeq++;
    // Captured now, not read back off state.lectureId when the upload actually
    // fires - the same reason the session export path takes an explicit
    // lectureId (see fileWithLecture's own comment): this segment can easily
    // still be uploading after standDown has already cleared it.
    const lectureId = getLectureId();
    const parts = [];
    let startedAt = Date.now();
    recorder.onstart = () => { startedAt = Date.now(); };
    recorder.ondataavailable = (ev) => { if (ev.data.size) parts.push(ev.data); };
    recorder.onstop = () => {
      if (!parts.length) return;
      fileWithLecture(micChunkName(seq, startedAt, Date.now() - startedAt), 'audio', new Blob(parts, { type: mimeType || 'audio/webm' }), mimeType || 'audio/webm', lectureId);
    };
    micRecorder = recorder;
    recorder.start();
    micChunkTimer = setTimeout(() => {
      if (micRecorder !== recorder) return;   // already stopped from elsewhere
      recorder.stop();
      beginMicSegment();
    }, MIC_CHUNK_MS);
  }

  function startMicRecording() {
    if (micRecorder || !micStream || !recordingNow()) return;
    micSessionStamp = Date.now();
    micRecordSeq = 0;
    beginMicSegment();
  }

  function stopMicRecording() {
    clearTimeout(micChunkTimer);
    micChunkTimer = null;
    const recorder = micRecorder;
    micRecorder = null;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function startMic() {
    if (micStream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      $('#mic-status').textContent = 'This browser has no microphone access.';
      return;
    }
    $('#mic-status').textContent = 'Requesting…';
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      $('#mic-status').textContent = `Could not start: ${err.message}`;
      return;
    }
    $('#mic-start').textContent = 'Stop my mic';
    $('#mic-start').classList.add('is-on');
    $('#mic-status').textContent = 'Live';
    if ($('#mic-record').checked) startMicRecording();
    if ($('#mic-amplify').checked) micSender?.start(micStream);
  }

  function stopMic() {
    stopMicRecording();
    micSender?.stop();
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    $('#mic-start').textContent = 'Start my mic';
    $('#mic-start').classList.remove('is-on');
    $('#mic-status').textContent = 'Off';
  }

  function setMicAmplifyState(status) {
    $('#mic-amplify-status').textContent = {
      idle: '',
      connecting: 'connecting…',
      live: 'live on the display',
      failed: 'could not connect - a guest network may be blocking the two devices from reaching each other',
    }[status] || status;
  }

  $('#mic-start').addEventListener('click', () => { if (micStream) stopMic(); else startMic(); });
  $('#mic-record').addEventListener('change', () => {
    if (!micStream) return;
    if ($('#mic-record').checked) startMicRecording();
    else stopMicRecording();
  });
  $('#mic-amplify').addEventListener('change', async () => {
    // Feedback is a hazard to the room's ears, so the warning is a question the
    // first time on this device rather than a paragraph every time (Issue #189).
    if ($('#mic-amplify').checked && !acknowledged('amplify')) {
      $('#mic-amplify').checked = false;
      if (!(await confirmOnce('amplify', $('#mic-amplify-warning'), 'Turn it on'))) return;
      $('#mic-amplify').checked = true;
    }
    if (!micStream) return;
    if ($('#mic-amplify').checked) micSender?.start(micStream);
    else micSender?.stop();
  });

  return {
    /** A new relay connection: the amplified mic goes out over it. */
    connect(bus) { micSender = createMicSender({ bus, onState: setMicAmplifyState }); },
    /** An 'rtc' message from the display, for the amplified mic's call. */
    handle(msg) { micSender?.handle(msg); },
    /** Whether a lecture is being kept changed: a recording with nowhere to go stops. */
    recordingChanged() { if (!recordingNow() && micRecorder) stopMicRecording(); },
  };
}
