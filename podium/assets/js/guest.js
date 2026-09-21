// Simple Presentation Mode: a substitute's clicker (Issue #77).
//
// Same room, same passphrase, the same shared state as the instructor's own
// control.html - reached over a distinct pairing link/QR (see "Guest (Simple
// Mode)" in display.js's pairing sheet) so the instructor never touches their
// own device's settings to hand one out. There is no cueing concept here on
// purpose: Next/Previous/Blank all pass `where: 'program'`, which
// stageTarget/resolveVisualTarget in protocol.js already let a caller use to
// bypass freeze - so a guest's remote shares a room with a frozen, mid-cue
// instructor controller without ever touching what they have staged.
//
// Deliberately built on the same bus/config/protocol modules control.js uses
// (this is a real controller, just a smaller one) rather than join.html's
// "nothing shared" approach - join.html's audience has no passphrase to give
// and never joins the room at all, which is a different problem. This page
// does join the room, so it needs what joining takes.

import { $, $$, throttle } from './util.js';
import { loadConfig, isConfigured } from './config.js';
import { createBus } from './bus.js';
import { focusedItem, BLACK, versionStamp } from './protocol.js';

const cfg = await loadConfig();

// A short, local label map rather than importing renderers.js: that module
// pulls in the deck/PDF rendering machinery this page has no use for, and
// guest.js is meant to stay small enough to read start to finish.
const TYPE_LABELS = {
  black: 'Black', image: 'Image', video: 'Video', audio: 'Audio', youtube: 'YouTube',
  web: 'Web page', slides: 'Slides', deck: 'Marp deck', pdf: 'PDF', text: 'Big text',
  qr: 'QR code', timer: 'Timer', whiteboard: 'Whiteboard', camera: 'Camera', poll: 'Poll',
};
function itemTitle(item) {
  if (!item) return 'Nothing';
  return item.title || TYPE_LABELS[item.type] || item.type;
}

// The types Next/Previous actually page through - the same set control.js
// gates its own arrow-key shortcuts on (see the 'nav' case in protocol.js's
// applyCommand for what each one means).
const NAVIGABLE = new Set(['pdf', 'slides', 'web', 'deck']);

const LASER_COLORS = ['red', 'green', 'blue'];
let laserColor = 'red';

let bus = null;
let state = { program: { ...BLACK }, blank: false, focus: 0, panels: [] };

function send(cmd) {
  bus?.send({ t: 'cmd', ...cmd });
}

function setStatus(status) {
  const bar = $('#status');
  bar.dataset.status = status;
  bar.textContent = {
    connecting: 'Connecting…',
    online: 'Connected',
    offline: 'Reconnecting…',
    error: 'Connection problem',
    mismatch: 'Wrong passphrase somewhere',
  }[status] || status;
}

function renderConnection() {
  const display = (bus?.peers() || []).find((p) => p.role === 'display');
  $('#display-state').textContent = display ? 'Display connected' : 'No display connected yet';
  $('#display-state').classList.toggle('is-bad', !display);
}

function renderNow() {
  // focus 0 is state.program itself, exactly like every other controller -
  // see focusedItem's own comment in protocol.js for why it is never the
  // frozen preview.
  const item = focusedItem(state) || state.program;
  $('#guest-now').textContent = `Now showing: ${itemTitle(item)}`;
  const navigable = NAVIGABLE.has(item?.type);
  $('#guest-prev').disabled = !navigable;
  $('#guest-next').disabled = !navigable;
  $('#guest-blank').classList.toggle('is-on', !!state.blank);
  $('#guest-blank').textContent = state.blank ? 'Unblank' : 'Blank screen';
}

async function connect() {
  bus = await createBus({
    cfg,
    role: 'control',
    onStatus: setStatus,
    onPeers: renderConnection,
    onMessage: (msg) => {
      if (msg.t !== 'state') return;
      state = { ...state, ...msg.state };
      renderNow();
      renderConnection();
    },
  });
  bus.send({ t: 'sync' });
  renderConnection();
}

$('#guest-prev').addEventListener('click', () => send({ op: 'nav', dir: 'prev', where: 'program' }));
$('#guest-next').addEventListener('click', () => send({ op: 'nav', dir: 'next', where: 'program' }));
$('#guest-blank').addEventListener('click', () => send({ op: 'blank' }));

// --- laser ----------------------------------------------------------------
//
// A raw, ephemeral relay message, exactly like control.js's own laser tool -
// not part of shared state, so it needs no protocol change and leaves
// nothing behind if the guest device just walks away. The pointing surface
// below is a plain fixed-aspect box, not a mirror of the actual slide (see
// the comment on #guest-pad in guest.html) - the drag math is the same
// fraction-of-a-box conversion control.js's laserPoint does.
let laserActive = false;
let laserDragging = false;
const pad = $('#guest-pad');
const dot = $('#guest-laser-dot');
const sendLaser = throttle((x, y) => bus?.send({ t: 'laser', x, y, on: true, color: laserColor }), 40);

function setLaserColor(color) {
  laserColor = LASER_COLORS.includes(color) ? color : 'red';
  dot.dataset.color = laserColor;
  $$('.laser-swatch').forEach((b) => b.classList.toggle('is-on', b.dataset.color === laserColor));
}

function setLaserActive(on) {
  laserActive = on;
  $('#guest-laser').classList.toggle('is-on', on);
  $('#guest-laser-colors').hidden = !on;
  pad.hidden = !on;
  if (!on) { dot.classList.remove('is-on'); bus?.send({ t: 'laser', on: false }); }
}

function laserPoint(ev) {
  const rect = pad.getBoundingClientRect();
  return [
    Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
    Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)),
  ];
}

$('#guest-laser').addEventListener('click', () => setLaserActive(!laserActive));
$$('.laser-swatch').forEach((b) => b.addEventListener('click', () => setLaserColor(b.dataset.color)));
setLaserColor(laserColor);

pad.addEventListener('pointerdown', (ev) => {
  if (!laserActive) return;
  laserDragging = true;
  pad.setPointerCapture(ev.pointerId);
  const [x, y] = laserPoint(ev);
  dot.style.left = `${x * 100}%`;
  dot.style.top = `${y * 100}%`;
  dot.classList.add('is-on');
  sendLaser(x, y);
});
pad.addEventListener('pointermove', (ev) => {
  if (!laserDragging) return;
  ev.preventDefault();
  const [x, y] = laserPoint(ev);
  dot.style.left = `${x * 100}%`;
  dot.style.top = `${y * 100}%`;
  sendLaser(x, y);
});
const endLaserDrag = (ev) => {
  if (!laserDragging) return;
  laserDragging = false;
  dot.classList.remove('is-on');
  bus?.send({ t: 'laser', on: false });
  try { pad.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
};
pad.addEventListener('pointerup', endLaserDrag);
pad.addEventListener('pointercancel', endLaserDrag);

// --- keyboard, the same keys a real presentation remote sends -------------
document.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
  if (ev.key === 'ArrowRight' || ev.key === 'PageDown' || ev.key === ' ') { ev.preventDefault(); $('#guest-next').click(); }
  else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); $('#guest-prev').click(); }
  else if (ev.key.toLowerCase() === 'b') send({ op: 'blank' });
});

// --- bootstrap --------------------------------------------------------------

$('#guest-version-tag').textContent = versionStamp();

if (!isConfigured(cfg)) {
  $('#guest-setup').hidden = false;
} else {
  $('#app').hidden = false;
  try {
    await connect();
  } catch (err) {
    setStatus('error');
    $('#guest-now').textContent = err?.message || String(err);
  }
  renderNow();
}
