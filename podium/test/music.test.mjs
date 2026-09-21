// podium/test/music.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime } from '../assets/js/util.js';

// Mimic trackDurationStr logic from control.js
function trackDurationStr(t, trackDurations = new Map()) {
  if (!t) return '';
  let dur = null;
  if (typeof t.duration === 'number' && t.duration > 0) dur = t.duration;
  else if (typeof t.duration === 'string' && t.duration.trim()) return t.duration.trim();
  else if (typeof t.length === 'number' && t.length > 0) dur = t.length;
  else if (typeof t.length === 'string' && t.length.trim()) return t.length.trim();
  else if (t.src && trackDurations.has(t.src) && trackDurations.get(t.src) > 0) dur = trackDurations.get(t.src);
  if (dur != null && dur > 0) return fmtTime(Math.round(dur));
  return '';
}

test('trackDurationStr formats numeric duration correctly', () => {
  assert.equal(trackDurationStr({ duration: 184 }), '3:04');
  assert.equal(trackDurationStr({ duration: 65 }), '1:05');
  assert.equal(trackDurationStr({ duration: 20 }), '0:20');
});

test('trackDurationStr formats string length/duration correctly', () => {
  assert.equal(trackDurationStr({ length: '3:45' }), '3:45');
  assert.equal(trackDurationStr({ duration: '4:12' }), '4:12');
});

test('trackDurationStr falls back to probed duration from map', () => {
  const map = new Map([['content/audio/waiting-music.wav', 42]]);
  assert.equal(trackDurationStr({ src: 'content/audio/waiting-music.wav' }, map), '0:42');
  assert.equal(trackDurationStr({ src: 'content/audio/unknown.wav' }, map), '');
});

test('dropdown label contains track duration', () => {
  const t = { title: 'Ambient Waves', artist: 'Artist X', duration: 195 };
  const d = trackDurationStr(t);
  const label = `1. ${t.title}${t.artist ? ` — ${t.artist}` : ''}${d ? ` (${d})` : ''}`;
  assert.equal(label, '1. Ambient Waves — Artist X (3:15)');
});
