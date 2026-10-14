// The Now tab's live browser controls on the controller (see
// live-browser.js and server/browser.js), split out of control.js.
//
// The page runs on the server; this drives it. The screen on the Now tab is
// the page as it is right now - the item being worked on, which while frozen
// may be ahead of what the room sees - and taps, drags, the wheel and a
// keyboard all go straight to it, not through the display: the projector is
// only ever shown pictures of the page, so there is nothing for it to apply.

import { $, $$, throttle, guessItemFromUrl } from './util.js';
import { focusedItem } from './protocol.js';
import { browseMode, refusesFraming, liveBrowserAvailableNow, watchLiveBrowser } from './live-browser.js';

/**
 * @param {object} deps
 * @param {Function} deps.send - the shared command dispatcher.
 * @param {Function} deps.stage - puts an item on the controller's stage.
 * @param {Function} deps.getState - the room's state as this controller has it now.
 * @param {Function} deps.workItem - the item being worked on (see workingItem).
 * @param {Function} deps.haptic - a tap's feedback.
 * @param {object} deps.liveWeb - liveBrowserOptions for this controller.
 * @returns {{ render: (item: object) => boolean }} render shows the web
 *   controls for `item`, and says whether it is a page in the live browser.
 */
export function createLiveBrowserPanel({ send, stage, getState, workItem, haptic, liveWeb }) {
  // The web page the Now tab is driving, and what it last said about itself.
  let webDriver = null;          // { id, handle }
  let webState = null;

  const WEB_ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  /** Show the Now tab's web controls for `item`; true when it is a page in the live browser. */
  function renderWebControls(item) {
    const web = item?.type === 'web' ? item : null;
    const liveNow = liveBrowserAvailableNow() === true;
    const live = !!web && browseMode(web, liveNow) === 'live';
    const nowOpen = !$('[data-panel="now"]').hidden;
    $('#web-tools').hidden = !live;
    $('#web-browse-row').hidden = !web || !liveNow;
    if (web && document.activeElement !== $('#web-browse')) $('#web-browse').value = web.browse || 'auto';
    const note = $('#web-embed-note');
    note.hidden = !web || live;
    if (web && !live) {
      const host = refusesFraming(web.src);
      note.textContent = host && web.browse !== 'embed'
        ? `${host} does not let other sites show its pages inside them, so the room sees a card saying so.${liveNow ? ' Show it as a live browser instead.' : ' A Podium server with Chromium installed can show it in a live browser.'}`
        : `Embedded: the page plays its own sound, but it can only be clicked or scrolled on the classroom computer.${liveNow ? ' Show it as a live browser to drive it from here.' : ''} If the projector shows a sad face, the site refuses to be embedded.`;
    }
    // The Now preview above already shows the room this page; while it is the
    // same page as the screen below, one picture of it is enough.
    $('#now-preview').hidden = live && workItem() === focusedItem(getState());
    $('#web-screen').classList.toggle('is-ahead', live && (getState().frozen || workItem() !== focusedItem(getState())));
    syncWebDriver(live && nowOpen ? web : null);
    return live;
  }

  function syncWebDriver(item) {
    const id = item ? `${item.liveId || item.key}` : null;
    if (id === (webDriver?.id ?? null)) return;
    webDriver?.handle.release();
    webDriver = null;
    webState = null;
    const canvas = $('#web-canvas');
    canvas.width = 0;
    $('#web-screen').classList.remove('has-frame');
    $('#web-screen-note').textContent = item ? 'Opening…' : '';
    if (!item) return;
    const handle = watchLiveBrowser({
      key: liveWeb.keyFor(item),
      home: item.src,
      role: 'control',
      lecture: liveWeb.lecture?.() || 0,
      onFrame: (bitmap) => {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        $('#web-screen').classList.add('has-frame');
        if (!webState?.error) $('#web-screen-note').textContent = '';
      },
      onState: (st) => { webState = st; renderWebState(); },
      onOpening: () => { $('#web-screen-note').textContent = 'Opening the page…'; },
      onError: (message) => { $('#web-screen-note').textContent = message; $('#web-status').textContent = message; },
    });
    webDriver = { id, handle };
  }

  function renderWebState() {
    const st = webState;
    if (!st) return;
    if (document.activeElement !== $('#web-url')) $('#web-url').value = st.url || '';
    $('#web-back').disabled = !st.canBack;
    $('#web-forward').disabled = !st.canForward;
    $('#web-reload').textContent = st.loading ? '✕' : '⟳';
    $('#web-reload').setAttribute('aria-label', st.loading ? 'Stop loading' : 'Reload');
    $('#web-zoom-level').textContent = `${Math.round((st.zoom || 1) * 100)}%`;
    $('#web-screen').style.aspectRatio = String(st.aspect || 16 / 9);
    $('#web-status').textContent = st.error || (st.loading ? `Loading ${st.title || st.url || ''}…` : (st.title || ''));
    $('#web-screen-note').textContent = st.error || '';
    $('#web-video-row').hidden = youTubeVideo(st.url) === null;
  }

  // A YouTube video's page (not a channel or a live stream, which have no
  // place to start from), as the YouTube item that would play it.
  function youTubeVideo(url) {
    const item = url ? guessItemFromUrl(url) : null;
    return item?.type === 'youtube' ? item : null;
  }

  // Played in Podium instead: from where the page had got to, which is then
  // paused, so the two do not run on side by side.
  $('#web-play-here').addEventListener('click', async () => {
    const st = webState;
    const video = youTubeVideo(st?.url);
    if (!video || !webDriver) return;
    const button = $('#web-play-here');
    button.disabled = true;
    try {
      const media = await webDriver.handle.askMedia({ pause: true });
      const title = String(st.title || '').replace(/\s*[-–]\s*YouTube\s*$/, '').trim() || 'YouTube';
      stage({ ...video, title, startAt: Math.floor(media?.time ?? video.startAt ?? 0) });
      haptic('tick');
    } finally {
      button.disabled = false;
    }
  });

  const webSend = (msg) => webDriver?.handle.send(msg);

  $('#web-address').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const url = $('#web-url').value.trim();
    if (!url) return;
    webSend({ t: 'go', url });
    $('#web-url').blur();
  });
  $('#web-back').addEventListener('click', () => webSend({ t: 'back' }));
  $('#web-forward').addEventListener('click', () => webSend({ t: 'forward' }));
  $('#web-reload').addEventListener('click', () => webSend({ t: webState?.loading ? 'stop' : 'reload' }));
  $('#web-home').addEventListener('click', () => webSend({ t: 'home' }));
  $('#web-page-up').addEventListener('click', () => webSend({ t: 'key', key: 'PageUp' }));
  $('#web-page-down').addEventListener('click', () => webSend({ t: 'key', key: 'PageDown' }));
  const webZoomStep = (dir) => {
    const now = webState?.zoom || 1;
    const next = dir > 0 ? WEB_ZOOMS.find((z) => z > now + 0.001) : [...WEB_ZOOMS].reverse().find((z) => z < now - 0.001);
    if (next) webSend({ t: 'zoom', zoom: next });
  };
  $('#web-zoom-in').addEventListener('click', () => webZoomStep(1));
  $('#web-zoom-out').addEventListener('click', () => webZoomStep(-1));
  $('#web-type').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('#web-text').value;
    if (text) webSend({ t: 'text', text });
    $('#web-text').value = '';
  });
  for (const b of $$('#web-type [data-key]')) b.addEventListener('click', () => webSend({ t: 'key', key: b.dataset.key }));
  $('#web-browse').addEventListener('change', (ev) => send({ op: 'web', browse: ev.target.value }));

  // The screen: a tap is a click where it lands; a drag scrolls the page the
  // way a finger scrolls a phone (the page follows the finger); the wheel and a
  // trackpad scroll as they would on a desktop; a mouse just moving over it
  // hovers, for menus that open on hover.
  {
    const screen = $('#web-screen');
    const canvas = $('#web-canvas');
    const at = (ev) => {
      const r = canvas.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (ev.clientX - r.left) / (r.width || 1))), y: Math.min(1, Math.max(0, (ev.clientY - r.top) / (r.height || 1))), r };
    };
    let press = null;
    let pending = { dx: 0, dy: 0, x: 0.5, y: 0.5 };
    const flushScroll = throttle(() => {
      if (!pending.dx && !pending.dy) return;
      webSend({ t: 'scroll', x: pending.x, y: pending.y, dx: pending.dx, dy: pending.dy });
      pending = { ...pending, dx: 0, dy: 0 };
    }, 50);
    const scrollBy = (p, dx, dy) => {
      pending = { x: p.x, y: p.y, dx: pending.dx + dx, dy: pending.dy + dy };
      flushScroll();
    };
    screen.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const p = at(ev);
      press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, lastX: ev.clientX, lastY: ev.clientY, dragging: false, p };
      screen.setPointerCapture?.(ev.pointerId);
      screen.focus({ preventScroll: true });
      ev.preventDefault();
    });
    const sendMove = throttle((p) => webSend({ t: 'move', x: p.x, y: p.y }), 120);
    screen.addEventListener('pointermove', (ev) => {
      if (!press) {
        if (ev.pointerType === 'mouse') sendMove(at(ev));
        return;
      }
      if (ev.pointerId !== press.id) return;
      if (!press.dragging && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 8) press.dragging = true;
      if (!press.dragging) return;
      const p = at(ev);
      scrollBy(p, -(ev.clientX - press.lastX) / (p.r.width || 1), -(ev.clientY - press.lastY) / (p.r.height || 1));
      press.lastX = ev.clientX;
      press.lastY = ev.clientY;
    });
    screen.addEventListener('pointerup', (ev) => {
      if (!press || ev.pointerId !== press.id) return;
      if (!press.dragging) {
        const p = at(ev);
        webSend({ t: 'click', x: p.x, y: p.y });
        haptic('tick');
      }
      press = null;
    });
    screen.addEventListener('pointercancel', () => { press = null; });
    screen.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = at(ev);
      const unit = ev.deltaMode === 1 ? 40 : ev.deltaMode === 2 ? p.r.height : 1;
      scrollBy(p, (ev.deltaX * unit) / (p.r.width || 1), (ev.deltaY * unit) / (p.r.height || 1));
    }, { passive: false });
    // A keyboard (a laptop as the controller, or a keyboard on the iPad): with
    // the screen selected, keys go to the page and nowhere else - none of the
    // controller's own shortcuts fire while typing into a search box.
    const NAMED = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Delete']);
    screen.addEventListener('keydown', (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'Escape' && !webState) return;
      ev.stopPropagation();
      if (ev.key.length === 1) { ev.preventDefault(); webSend(ev.key === ' ' ? { t: 'key', key: ' ' } : { t: 'text', text: ev.key }); return; }
      if (NAMED.has(ev.key)) { ev.preventDefault(); webSend({ t: 'key', key: ev.key, shift: ev.shiftKey }); }
    });
    screen.addEventListener('paste', (ev) => {
      const text = ev.clipboardData?.getData('text');
      if (text) { ev.preventDefault(); webSend({ t: 'text', text }); }
    });
  }

  return { render: renderWebControls };
}
