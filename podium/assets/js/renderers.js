// Content renderers.
//
// One factory per content type. The display and the controller's preview pane
// both use these, so what you cue really is what goes live. Renderers are
// declarative: the display hands over an item and reconciles; it never issues
// imperative "play this now" calls from outside.
//
// A renderer exposes:
//   el          the DOM node to mount
//   update(it)  adopt a changed item of the same type
//   reconcile(it, audio)  apply playback/nav intent
//   telemetry() { time, duration, playing }
//   destroy()

import { el, miniMarkdown, fmtTime } from './util.js';
import { render as renderDeckSource, applyPolyfill } from './deck.js';

export const TYPES = {
  black:      { label: 'Black',      icon: '■' },
  image:      { label: 'Image',      icon: '\u{1F5BC}' },
  video:      { label: 'Video',      icon: '▶' },
  audio:      { label: 'Audio',      icon: '♪' },
  youtube:    { label: 'YouTube',    icon: '▶' },
  web:        { label: 'Web page',   icon: '\u{1F310}' },
  slides:     { label: 'Slides',     icon: '\u{1F4D1}' },
  deck:       { label: 'Marp deck',  icon: '\u{1F4D6}' },
  pdf:        { label: 'PDF',        icon: '\u{1F4C4}' },
  text:       { label: 'Big text',   icon: 'T' },
  qr:         { label: 'QR code',    icon: '⌗' },
  timer:      { label: 'Timer',      icon: '⏱' },
  whiteboard: { label: 'Whiteboard', icon: '✎' },
  camera:     { label: 'Camera',     icon: '\u{1F4F7}' },
};

export function itemTitle(item) {
  if (!item) return 'Nothing';
  return item.title || TYPES[item.type]?.label || item.type;
}

const noTelemetry = () => ({ time: 0, duration: 0, playing: false });

// ---------------------------------------------------------------------------

function staticRenderer(node) {
  return { el: node, update() {}, reconcile() {}, telemetry: noTelemetry, destroy() { node.remove(); } };
}

function renderBlack() {
  return staticRenderer(el('div', { class: 'r-black' }));
}

function renderImage(item) {
  const img = el('img', { class: 'r-image', src: item.src, alt: item.title || '', decoding: 'async' });
  const node = el('div', { class: 'r-fill' }, img);
  const apply = (it) => { img.style.objectFit = it.fit === 'cover' ? 'cover' : 'contain'; };
  apply(item);
  return {
    el: node,
    update(it) { if (it.src !== img.getAttribute('src')) img.src = it.src; apply(it); },
    reconcile() {},
    telemetry: noTelemetry,
    destroy() { node.remove(); },
  };
}

// Shared plumbing for <video> and <audio>.
function mediaRenderer(item, opts, media, node) {
  let lastSeek = item.seekNonce || 0;
  media.playsInline = true;
  media.preload = 'auto';
  media.src = item.src;
  if (item.loop) media.loop = true;
  if (opts.preview) media.muted = true;

  // currentTime before metadata is silently dropped, so cue on loadedmetadata.
  let cueTo = item.startAt || 0;
  const cue = () => { if (cueTo) { media.currentTime = cueTo; cueTo = 0; } };
  media.addEventListener('loadedmetadata', cue);
  if (media.readyState >= 1) cue();

  // Nothing here starts itself. reconcile() is the only thing that presses
  // play, so an item cued into the hidden layer stays parked on its first
  // frame instead of running out of sync behind whatever is on screen.
  const play = () => media.play().catch(() => { /* blocked until the display is armed */ });

  return {
    el: node,
    update(it) {
      if (it.src !== media.src && it.src !== media.getAttribute('src')) {
        media.src = it.src;
        if (it.startAt) media.currentTime = it.startAt;
      }
      media.loop = !!it.loop;
    },
    reconcile(it, audio) {
      if (opts.preview) { media.muted = true; media.pause(); return; }
      media.volume = audio.muted ? 0 : audio.volume;
      media.muted = audio.muted;
      if ((it.seekNonce || 0) !== lastSeek) {
        lastSeek = it.seekNonce || 0;
        if (it.seekTo !== undefined) media.currentTime = it.seekTo;
        else if (it.seekBy !== undefined) media.currentTime = Math.max(0, media.currentTime + it.seekBy);
      }
      if (it.playing === false && !media.paused) media.pause();
      if (it.playing !== false && media.paused) play();
    },
    telemetry: () => ({ time: media.currentTime || 0, duration: media.duration || 0, playing: !media.paused }),
    destroy() {
      media.pause();
      media.removeEventListener('loadedmetadata', cue);
      media.removeAttribute('src');
      media.load();
      node.remove();
    },
  };
}

function renderVideo(item, opts) {
  const video = el('video', { class: 'r-video', playsinline: true });
  video.style.objectFit = item.fit === 'cover' ? 'cover' : 'contain';
  if (item.poster) video.poster = item.poster;
  const node = el('div', { class: 'r-fill' }, video);
  const base = mediaRenderer(item, opts, video, node);
  const parentUpdate = base.update;
  base.update = (it) => {
    parentUpdate(it);
    video.style.objectFit = it.fit === 'cover' ? 'cover' : 'contain';
  };
  return base;
}

function renderAudio(item, opts) {
  const audioEl = el('audio');
  const bars = el('div', { class: 'r-bars' }, ...Array.from({ length: 9 }, (_, i) => el('span', { style: { animationDelay: `${i * 0.11}s` } })));
  const title = el('div', { class: 'r-audio-title' }, item.title || 'Audio');
  const sub = el('div', { class: 'r-audio-sub' }, item.artist || '');
  const art = item.art ? el('img', { class: 'r-audio-art', src: item.art, alt: '' }) : null;
  const node = el('div', { class: 'r-audio' }, art, el('div', { class: 'r-audio-meta' }, title, sub, bars), audioEl);
  const base = mediaRenderer(item, opts, audioEl, node);
  const parentUpdate = base.update;
  const parentReconcile = base.reconcile;
  base.update = (it) => { parentUpdate(it); title.textContent = it.title || 'Audio'; sub.textContent = it.artist || ''; };
  base.reconcile = (it, a) => {
    parentReconcile(it, a);
    node.classList.toggle('is-playing', !audioEl.paused);
  };
  return base;
}

// YouTube without the IFrame API library: the embed accepts the same commands
// over postMessage, and reports playhead back through "infoDelivery" events.
function renderYouTube(item, opts) {
  const origin = location.origin.startsWith('http') ? location.origin : '';
  const params = new URLSearchParams({
    enablejsapi: '1', rel: '0', modestbranding: '1', playsinline: '1',
    autoplay: '0',
    mute: '0',
    start: String(item.startAt || 0),
  });
  if (origin) params.set('origin', origin);

  const HOST = 'https://www.youtube-nocookie.com';
  const frame = el('iframe', {
    class: 'r-frame',
    src: `${HOST}/embed/${encodeURIComponent(item.videoId)}?${params}`,
    allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
    allowfullscreen: true,
    frameborder: '0',
  });
  const node = el('div', { class: 'r-fill r-yt' }, frame);

  let loaded = false;
  let lastSeek = item.seekNonce || 0;
  const queue = [];
  const state = { time: 0, duration: 0, playing: false };

  const post = (func, args = []) => {
    const msg = JSON.stringify({ event: 'command', func, args });
    if (!loaded) { queue.push(msg); return; }
    frame.contentWindow?.postMessage(msg, HOST);
  };

  frame.addEventListener('load', () => {
    loaded = true;
    // Subscribing is what makes the embed start posting progress back.
    frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'podium', channel: 'widget' }), HOST);
    queue.splice(0).forEach((m) => frame.contentWindow?.postMessage(m, HOST));
  });

  const onMessage = (ev) => {
    if (!ev.origin.includes('youtube')) return;
    if (ev.source !== frame.contentWindow) return;
    let data;
    try { data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch { return; }
    const info = data?.info;
    if (!info) return;
    if (typeof info.currentTime === 'number') state.time = info.currentTime;
    if (typeof info.duration === 'number') state.duration = info.duration;
    if (typeof info.playerState === 'number') state.playing = info.playerState === 1;
  };
  window.addEventListener('message', onMessage);

  return {
    el: node,
    update(it) {
      if (it.videoId !== item.videoId) {
        item = it;
        post('loadVideoById', [{ videoId: it.videoId, startSeconds: it.startAt || 0 }]);
      }
    },
    reconcile(it, audio) {
      if (opts.preview) { post('mute'); post('pauseVideo'); return; }
      post('unMute');
      post('setVolume', [Math.round((audio.muted ? 0 : audio.volume) * 100)]);
      if ((it.seekNonce || 0) !== lastSeek) {
        lastSeek = it.seekNonce || 0;
        if (it.seekTo !== undefined) post('seekTo', [it.seekTo, true]);
        else if (it.seekBy !== undefined) post('seekTo', [Math.max(0, state.time + it.seekBy), true]);
      }
      post(it.playing === false ? 'pauseVideo' : 'playVideo');
    },
    telemetry: () => ({ ...state }),
    destroy() { window.removeEventListener('message', onMessage); node.remove(); },
  };
}

// Generic embedded page, also used for HTML slide decks. Deck navigation works
// three ways, best first: a same-origin deck is driven directly, reveal.js
// listens on postMessage, and anything else gets a synthetic arrow key that it
// may or may not honour.
function renderWeb(item, opts) {
  const frame = el('iframe', {
    class: 'r-frame',
    src: item.src,
    allow: 'autoplay; encrypted-media; fullscreen; clipboard-read; clipboard-write',
    allowfullscreen: true,
    referrerpolicy: 'no-referrer-when-downgrade',
    frameborder: '0',
  });
  const warn = el('div', { class: 'r-embed-warn' },
    el('div', {}, 'If this stays blank, the site refuses to be embedded.'),
    el('div', { class: 'r-embed-url' }, item.src));
  const node = el('div', { class: 'r-fill r-web' }, frame, warn);

  // Sites that send X-Frame-Options never fire load; leave the hint visible.
  frame.addEventListener('load', () => node.classList.add('is-loaded'));

  let lastNav = item.navNonce || 0;

  const navigate = (dir) => {
    const win = frame.contentWindow;
    if (!win) return;
    let sameOrigin = false;
    try { sameOrigin = !!win.document; } catch { sameOrigin = false; }
    if (sameOrigin) {
      const reveal = win.Reveal;
      if (reveal?.next) { dir === 'prev' ? reveal.prev() : reveal.next(); return; }
      const key = dir === 'prev' ? { key: 'ArrowLeft', keyCode: 37 } : { key: 'ArrowRight', keyCode: 39 };
      win.document.dispatchEvent(new win.KeyboardEvent('keydown', { ...key, bubbles: true }));
      return;
    }
    // reveal.js with postMessage enabled understands this shape.
    win.postMessage(JSON.stringify({ method: dir === 'prev' ? 'prev' : 'next', args: [] }), '*');
  };

  return {
    el: node,
    update(it) {
      if (it.src !== frame.getAttribute('src')) { frame.src = it.src; node.classList.remove('is-loaded'); }
    },
    reconcile(it) {
      if (opts.preview) return;
      if ((it.navNonce || 0) !== lastNav) { lastNav = it.navNonce || 0; navigate(it.navDir); }
    },
    telemetry: noTelemetry,
    destroy() { node.remove(); },
  };
}

// The built-in PDF viewer only honours #page= on load, so a page change swaps
// the frame. The file itself comes from cache, so it is quick after the first.
function renderPdf(item) {
  const node = el('div', { class: 'r-fill r-pdf' });
  let page = item.page || 1;
  let src = item.src;

  const mount = () => {
    node.replaceChildren(el('iframe', {
      class: 'r-frame',
      src: `${src}#page=${page}&toolbar=0&navpanes=0&statusbar=0&view=FitH`,
      frameborder: '0',
    }));
  };
  mount();

  return {
    el: node,
    update(it) {
      const nextPage = it.page || 1;
      if (it.src !== src || nextPage !== page) { src = it.src; page = nextPage; mount(); }
    },
    reconcile() {},
    telemetry: noTelemetry,
    destroy() { node.remove(); },
  };
}

function renderText(item) {
  const body = el('div', { class: 'r-text-body', html: miniMarkdown(item.body || '') });
  const node = el('div', { class: 'r-text' }, body);
  const apply = (it) => {
    node.dataset.size = it.size || 'l';
    node.dataset.align = it.align || 'center';
    node.style.background = it.bg || '';
  };
  apply(item);
  return {
    el: node,
    update(it) { body.innerHTML = miniMarkdown(it.body || ''); apply(it); },
    reconcile() {},
    telemetry: noTelemetry,
    destroy() { node.remove(); },
  };
}

function renderQr(item) {
  const holder = el('div', { class: 'r-qr-code' });
  const caption = el('div', { class: 'r-qr-caption' }, item.caption || item.data || '');
  const node = el('div', { class: 'r-qr' }, holder, caption);
  const draw = (it) => {
    const data = it.data || '';
    caption.textContent = it.caption || data;
    if (!data || typeof window.qrcode !== 'function') { holder.replaceChildren(); return; }
    // Type 0 lets the library pick the smallest version that fits.
    const qr = window.qrcode(0, 'M');
    qr.addData(data);
    qr.make();
    holder.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  };
  draw(item);
  return {
    el: node,
    update: draw,
    reconcile() {},
    telemetry: noTelemetry,
    destroy() { node.remove(); },
  };
}

function renderTimer(item, opts) {
  const value = el('div', { class: 'r-timer-value' }, '0:00');
  const label = el('div', { class: 'r-timer-label' }, item.label || '');
  const node = el('div', { class: 'r-timer' }, label, value);
  const tick = () => {
    const timer = opts.getTimer?.() || null;
    const ms = timer ? (timer.running ? Math.max(0, timer.endsAt - Date.now()) : timer.remainingMs) : 0;
    value.textContent = fmtTime(Math.ceil(ms / 1000));
    label.textContent = timer?.label || item.label || '';
    node.classList.toggle('is-done', ms <= 0 && !!timer && (timer.endsAt > 0 || timer.remainingMs > 0));
    node.classList.toggle('is-urgent', ms > 0 && ms <= 30000);
  };
  tick();
  const handle = setInterval(tick, 200);
  return {
    el: node,
    update(it) { item = it; tick(); },
    reconcile() {},
    telemetry: noTelemetry,
    destroy() { clearInterval(handle); node.remove(); },
  };
}

function renderWhiteboard(item) {
  const node = el('div', { class: 'r-whiteboard' });
  const apply = (it) => { node.style.background = it.bg || '#f7f5ef'; node.dataset.ink = it.bg && it.bg !== '#f7f5ef' ? 'light' : 'dark'; };
  apply(item);
  return { el: node, update: apply, reconcile() {}, telemetry: noTelemetry, destroy() { node.remove(); } };
}

// The stream is supplied by the WebRTC layer, which may connect after the
// renderer mounts, so re-check on every reconcile.
function renderCamera(item, opts) {
  const video = el('video', { class: 'r-video', autoplay: true, playsinline: true, muted: true });
  video.muted = true;
  const hint = el('div', { class: 'r-camera-hint' }, 'Waiting for the camera on your phone…');
  const node = el('div', { class: 'r-fill r-camera' }, video, hint);
  const attach = () => {
    const stream = opts.getStream?.();
    if (stream && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }
    node.classList.toggle('has-stream', !!stream);
  };
  attach();
  return {
    el: node,
    update() { attach(); },
    reconcile() { attach(); },
    telemetry: noTelemetry,
    destroy() { video.srcObject = null; node.remove(); },
  };
}

// A Marp deck. The whole deck is rendered once into a shadow root - which keeps
// the theme's `section {...}` rules from leaking into Podium's own UI - and
// changing slide is then just a matter of which <svg> is visible. No reload, so
// stepping through slides is instant and a cued deck keeps its place.
function renderDeck(item, opts) {
  const host = el('div', { class: 'r-deck' });
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host { display: block; position: absolute; inset: 0; background: #fff; }
    #wrap, #wrap .marpit { position: absolute; inset: 0; }
    #wrap svg[data-marpit-svg] { position: absolute; inset: 0; width: 100%; height: 100%; display: none; }
    #wrap svg[data-marpit-svg].podium-on { display: block; }
    #status {
      position: absolute; inset: 0; display: grid; place-items: center; padding: 4%;
      font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #556; background: #fff; text-align: center; white-space: pre-wrap;
    }
    #status[hidden] { display: none; }
  </style><div id="status">Loading deck…</div><div id="wrap"></div>`;

  const statusEl = shadow.getElementById('status');
  const wrap = shadow.getElementById('wrap');
  let slides = [];
  let mountedId = null;
  let polyfill = null;
  let generation = 0;

  const setStatus = (text) => {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  };

  function showSlide(index) {
    if (!slides.length) return;
    const clamped = Math.min(slides.length - 1, Math.max(0, index || 0));
    slides.forEach((svg, i) => svg.classList.toggle('podium-on', i === clamped));
  }

  async function mount(it) {
    const mine = ++generation;
    let source;
    try {
      source = await opts.getDeckSource?.(it);
    } catch (err) {
      setStatus(`Could not load the deck.\n${err.message}`);
      return;
    }
    if (mine !== generation) return;
    if (source == null) { setStatus('Waiting for the deck…'); return; }

    try {
      const deck = await renderDeckSource(source, it.deckId);
      if (mine !== generation) return;
      wrap.innerHTML = `<style>${deck.css}</style>${deck.html}`;
      slides = Array.from(wrap.querySelectorAll('svg[data-marpit-svg]'));
      // Marp needs its DOM polyfill for inline-SVG slides; without it Safari
      // (so, every iPad) lays foreignObject content out wrongly.
      polyfill?.cleanup?.();
      polyfill = await applyPolyfill(shadow);
      if (mine !== generation) return;
      mountedId = it.deckId;
      setStatus(slides.length ? '' : 'That markdown produced no slides.');
      showSlide(it.slide);
    } catch (err) {
      setStatus(`Marp could not render this deck.\n${err.message}`);
    }
  }

  mount(item);

  return {
    el: host,
    update(it) {
      if (it.deckId !== mountedId) { mount(it); return; }
      showSlide(it.slide);
    },
    reconcile() {},
    telemetry: noTelemetry,
    destroy() {
      generation++;
      polyfill?.cleanup?.();
      host.remove();
    },
  };
}

const FACTORIES = {
  black: renderBlack,
  image: renderImage,
  video: renderVideo,
  audio: renderAudio,
  youtube: renderYouTube,
  web: renderWeb,
  slides: renderWeb,
  deck: renderDeck,
  pdf: renderPdf,
  text: renderText,
  qr: renderQr,
  timer: renderTimer,
  whiteboard: renderWhiteboard,
  camera: renderCamera,
};

export function createRenderer(item, opts = {}) {
  const factory = FACTORIES[item?.type] || renderBlack;
  const renderer = factory(item || { type: 'black' }, opts);
  renderer.type = item?.type || 'black';
  return renderer;
}
