// Live captions on the controller (Issue #79), split out of control.js.
//
// Speech recognition runs on WHICHEVER device starts it here - normally
// this controller, since it is the one near the instructor's voice - using
// the browser's own SpeechRecognition. Recognized text rides the same
// bottom bar the manual caption beside it uses, through the 'caption' op (see
// protocol.js) rather than driving 'overlay' directly, so turning captions
// off does not depend on remembering whatever text happened to be there.
//
// The privacy trade-off (see the hint beside the button in control.html) is
// real and is not Podium's to fix: recognition happens inside the browser's
// own code, which this app never touches - in Chrome/Edge that means the
// room's audio leaves for Google's recognition service, exactly like any
// other page's use of dictation. There is nothing here for Podium's own
// encryption to cover, because there is nothing Podium ever receives.
//
// This device closing or losing its tab with captions still running leaves
// the bar showing whatever was last said, the same as any other state this
// controller alone was driving - there is no reliable send-on-unload here,
// and nothing else in this file pretends there is one for a mid-freeze cue
// either. Tap Stop, or Hide on the manual caption, to clear it.

import { $, throttle } from './util.js';

/**
 * @param {object} deps
 * @param {Function} deps.send - the shared command dispatcher.
 * @param {Function} deps.confirmOnce - asks once per device before something with a cost (see control.js).
 */
export function createCaptionPanel({ send, confirmOnce }) {
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  // A lull is not held speech - the bar clears itself rather than sitting on
  // the last thing said for the rest of class.
  const CAPTION_SILENCE_MS = 3000;
  // Interim results can fire many times a second while a phrase is being
  // refined; captions are read text; not a pointer that needs to feel
  // physically responsive, so this is throttled far softer than ink or laser.
  const sendCaptionText = throttle((text) => send({ op: 'caption', text }), 300);

  let recognizer = null;
  let captionSilenceTimer = null;

  function stopCaptions() {
    clearTimeout(captionSilenceTimer);
    if (recognizer) {
      recognizer.onend = null;   // this stop is deliberate, not a timeout to restart from
      recognizer.onerror = null;
      try { recognizer.stop(); } catch { /* already stopped */ }
      recognizer = null;
    }
    send({ op: 'caption', on: false });
    $('#caption-toggle').textContent = 'Start live captions';
    $('#caption-toggle').classList.remove('is-on');
    $('#caption-status').textContent = '';
  }

  function startCaptions() {
    if (!SpeechRecognitionCtor) {
      $('#caption-status').textContent = 'This browser has no speech recognition — try Chrome, Edge, or Safari.';
      return;
    }
    recognizer = new SpeechRecognitionCtor();
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.lang = navigator.language || 'en-US';

    recognizer.onresult = (ev) => {
      // Only the most recent phrase - continuous mode keeps every phrase said
      // all lecture in ev.results, and a caption bar showing all of it rather
      // than what is being said right now is not a caption bar any more.
      const text = (ev.results[ev.results.length - 1]?.[0]?.transcript || '').trim();
      if (!text) return;
      sendCaptionText(text);
      clearTimeout(captionSilenceTimer);
      captionSilenceTimer = setTimeout(() => sendCaptionText(''), CAPTION_SILENCE_MS);
    };
    recognizer.onerror = (ev) => {
      // 'no-speech' and 'aborted' are routine - a quiet room, a deliberate
      // stop - not a failure worth interrupting class over.
      if (ev.error === 'no-speech' || ev.error === 'aborted') return;
      $('#caption-status').textContent = `Captions stopped: ${ev.error}`;
      stopCaptions();
    };
    recognizer.onend = () => {
      // Chrome ends a recognition session on its own after a pause even with
      // continuous:true - restart it seamlessly. stopCaptions() clears this
      // handler first for a deliberate stop, so a null recognizer here always
      // means a timeout, never a choice.
      if (!recognizer) return;
      try { recognizer.start(); } catch { /* already restarting */ }
    };

    send({ op: 'caption', on: true });
    try {
      recognizer.start();
    } catch (err) {
      $('#caption-status').textContent = `Could not start: ${err.message}`;
      recognizer = null;
      send({ op: 'caption', on: false });
      return;
    }
    $('#caption-toggle').textContent = 'Stop live captions';
    $('#caption-toggle').classList.add('is-on');
    $('#caption-status').textContent = 'Listening…';
  }

  $('#caption-toggle').addEventListener('click', async () => {
    if (recognizer) { stopCaptions(); return; }
    // The first time on this device, say where the room's audio goes before it
    // goes there (Issue #189) - once, not as a paragraph on every visit.
    if (await confirmOnce('captions', $('#caption-privacy'), 'Start live captions')) startCaptions();
  });
}
