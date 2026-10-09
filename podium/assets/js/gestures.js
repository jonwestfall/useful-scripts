// Pinch, drag, double-tap and wheel on one element (Issue #262, phase 3).
//
// Listens in the CAPTURE phase on the element, so it sees a pointer before
// anything inside it does - the Ink pad's own drawing in particular. One
// finger is left alone (it draws, or scrolls a document); the moment a second
// finger lands, the pair is a pinch: `onPinchStart` is told (the pad uses it
// to take back the stroke the first finger began), and from then on those two
// pointers' events stop here and never reach the element underneath until both
// have lifted.
//
// Everything is reported in the element's own pixels, relative to where the
// gesture started:
//
//   onPinchStart({ x, y })              x/y: the two fingers' midpoint
//   onPinch({ scale, x, y, dx, dy })    scale since the start; midpoint now and how far it moved
//   onPinchEnd()
//   onDrag({ x, y, dx, dy, phase })     one pointer, only when canDrag() says so; phase start|move|end
//   onDoubleTap({ x, y })
//   onWheel({ factor, x, y })           factor > 1 zooms in; a trackpad pinch arrives as ctrl+wheel
//
// Return false from canDrag()/onWheel to let the event through untouched.

const TAP_MS = 260;          // a tap is quicker than this...
const TAP_SLOP = 10;         // ...and moves less than this
const DOUBLE_MS = 320;       // two taps this close together are a double tap
const DOUBLE_SLOP = 36;
const DRAG_SLOP = 4;

export function attachGestures(el, handlers = {}) {
  const touches = new Map();   // pointerId -> {x, y}
  let pinch = null;            // { dist, x, y } at the start
  const swallowed = new Set(); // pointers whose events stop here until they lift
  let drag = null;             // { id, x0, y0, started }
  let tap = null;              // { t, x, y } of a pointer going down
  let lastTap = null;          // { t, x, y } of the last completed tap

  // Where the element was when the gesture began. Zooming can reshape what
  // is being pinched (the Now preview grows from a page to the screen's
  // shape), and fingers measured against a moving box would drift.
  let frozen = null;
  const local = (ev) => {
    const r = frozen || el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };
  const pair = () => {
    const [a, b] = [...touches.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };
  const stop = (ev) => { ev.stopPropagation(); if (ev.cancelable) ev.preventDefault(); };

  el.addEventListener('pointerdown', (ev) => {
    if (!touches.size && !drag) frozen = el.getBoundingClientRect();
    const at = local(ev);
    tap = { t: performance.now(), x: at.x, y: at.y, id: ev.pointerId };
    if (ev.pointerType === 'touch') {
      touches.set(ev.pointerId, at);
      if (touches.size === 2) {
        drag = null;
        const p = pair();
        pinch = { dist: p.dist, x: p.x, y: p.y };
        for (const id of touches.keys()) swallowed.add(id);
        tap = null;
        handlers.onPinchStart?.({ x: p.x, y: p.y });
        stop(ev);
        return;
      }
      if (touches.size > 2) { swallowed.add(ev.pointerId); stop(ev); return; }
    }
    if (!pinch && handlers.canDrag?.(ev)) {
      drag = { id: ev.pointerId, x0: at.x, y0: at.y, started: false };
    }
  }, true);

  el.addEventListener('pointermove', (ev) => {
    if (touches.has(ev.pointerId)) touches.set(ev.pointerId, local(ev));
    if (pinch && touches.size >= 2 && swallowed.has(ev.pointerId)) {
      const p = pair();
      handlers.onPinch?.({ scale: p.dist / pinch.dist, x: p.x, y: p.y, dx: p.x - pinch.x, dy: p.y - pinch.y });
      stop(ev);
      return;
    }
    if (swallowed.has(ev.pointerId)) { stop(ev); return; }
    if (drag && drag.id === ev.pointerId) {
      const at = local(ev);
      const dx = at.x - drag.x0;
      const dy = at.y - drag.y0;
      if (!drag.started && Math.hypot(dx, dy) < DRAG_SLOP) return;
      if (!drag.started) {
        drag.started = true;
        el.setPointerCapture?.(ev.pointerId);
        handlers.onDrag?.({ x: drag.x0, y: drag.y0, dx: 0, dy: 0, phase: 'start' });
      }
      handlers.onDrag?.({ x: at.x, y: at.y, dx, dy, phase: 'move' });
      stop(ev);
    }
  }, true);

  const lift = (ev) => {
    const wasSwallowed = swallowed.has(ev.pointerId);
    touches.delete(ev.pointerId);
    swallowed.delete(ev.pointerId);
    if (pinch && touches.size < 2) { pinch = null; handlers.onPinchEnd?.(); }
    if (wasSwallowed) { stop(ev); return; }
    if (drag && drag.id === ev.pointerId) {
      const was = drag;
      drag = null;
      if (was.started) {
        const at = local(ev);
        handlers.onDrag?.({ x: at.x, y: at.y, dx: at.x - was.x0, dy: at.y - was.y0, phase: 'end' });
        stop(ev);
        return;
      }
    }
    // A quick, still tap - and a second one close after it is a double tap.
    if (ev.type === 'pointerup' && tap && tap.id === ev.pointerId && handlers.onDoubleTap) {
      const at = local(ev);
      const now = performance.now();
      const still = Math.hypot(at.x - tap.x, at.y - tap.y) < TAP_SLOP && now - tap.t < TAP_MS;
      if (still && lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) < DOUBLE_SLOP) {
        lastTap = null;
        handlers.onDoubleTap({ x: at.x, y: at.y });
      } else {
        lastTap = still ? { t: now, x: at.x, y: at.y } : null;
      }
    }
    tap = null;
    if (!touches.size && !drag) frozen = null;
  };
  el.addEventListener('pointerup', lift, true);
  el.addEventListener('pointercancel', lift, true);

  if (handlers.onWheel) {
    el.addEventListener('wheel', (ev) => {
      // A trackpad pinch is a ctrl+wheel with small steps; a mouse wheel's
      // notches are big. Either way: up is in, down is out.
      const factor = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
      const at = local(ev);
      if (handlers.onWheel({ factor, x: at.x, y: at.y }) === false) return;
      ev.preventDefault();
    }, { passive: false });
  }

  return {
    /** Whether two fingers are down on it right now. */
    get pinching() { return !!pinch; },
  };
}
