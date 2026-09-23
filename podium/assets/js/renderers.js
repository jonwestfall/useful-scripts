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
//   snapshot(ctx, rect)  optional: paint what you are showing into someone
//                        else's canvas, for "take a photo of this panel".

import { el, miniMarkdown, fmtTime } from './util.js';
import { render as renderDeckSource, applyPolyfill, applyFits, cssForStandaloneSlide, FRAGMENT_CSS } from './deck.js';

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
  trackend:   { label: 'Track countdown', icon: '⏳' },
  whiteboard: { label: 'Whiteboard', icon: '✎' },
  camera:     { label: 'Camera',     icon: '\u{1F4F7}' },
  set:        { label: 'Automated set', icon: '\u{1F501}' },
  poll:       { label: 'Poll',       icon: '\u{1F4CA}' },
};

export function itemTitle(item) {
  if (!item) return 'Nothing';
  return item.title || TYPES[item.type]?.label || item.type;
}

const noTelemetry = () => ({ time: 0, duration: 0, playing: false });

// --- photographing a panel ---------------------------------------------------
//
// A renderer that can honestly produce pixels for what it is showing exposes
// snapshot(ctx, rect): "draw yourself into that rectangle of this canvas".
// The display composes panel photos and whole-screen shots out of these (see
// takeShot there), then paints the real ink canvas over the top, so a photo
// is the content and the annotation exactly as the room saw them.
//
// Types that genuinely cannot be photographed - an embedded web page, a PDF in
// the browser's own viewer, a YouTube player - deliberately do NOT define it.
// A page cannot read pixels out of a cross-origin frame, and inventing a
// picture of one would be worse than saying so, which is what the caller does.

function paintBackdrop(ctx, rect, node, fallback = '#000') {
  const bg = node ? getComputedStyle(node).backgroundColor : '';
  ctx.fillStyle = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? bg : fallback;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
}

// object-fit, done in canvas: the same letterbox or crop the CSS is applying
// on screen, so the photo is framed the way the projector framed it.
function drawFitted(ctx, rect, source, sw, sh, fit) {
  if (!sw || !sh || !rect.w || !rect.h) return false;
  if (fit === 'fill') { ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h); return true; }
  const scale = fit === 'cover'
    ? Math.max(rect.w / sw, rect.h / sh)
    : Math.min(rect.w / sw, rect.h / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.drawImage(source, rect.x + (rect.w - w) / 2, rect.y + (rect.h - h) / 2, w, h);
  ctx.restore();
  return true;
}

const objectFitOf = (node) => getComputedStyle(node).objectFit || 'fill';

/** An <svg> element, standalone, as a decoded image - the deck and QR route. */
function svgToImage(svg, css, width, height) {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  if (css) {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = css;
    clone.insertBefore(style, clone.firstChild);
  }
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  return new Promise((resolve, reject) => {
    const img = new Image();
    // A slide whose fonts or images never arrive would otherwise hang the
    // whole photo; one that fails is reported as a failure to photograph.
    const timer = setTimeout(() => reject(new Error('timed out rendering it')), 8000);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error('the browser could not render it')); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------

function staticRenderer(node) {
  return {
    el: node,
    update() {},
    reconcile() {},
    telemetry: noTelemetry,
    // A flat colour: the whole point of photographing one is the ink the
    // display paints on top of it afterwards.
    snapshot(ctx, rect) { paintBackdrop(ctx, rect, node); return true; },
    destroy() { node.remove(); },
  };
}

function renderBlack() {
  return staticRenderer(el('div', { class: 'r-black' }));
}

function renderImage(item) {
  const img = el('img', { class: 'r-image', src: item.src, alt: item.title || '', decoding: 'async' });
  const node = el('div', { class: 'r-fill' }, img);
  let fit = item.fit;
  const apply = (it) => { fit = it.fit; img.style.objectFit = it.fit === 'cover' ? 'cover' : 'contain'; };
  apply(item);
  return {
    el: node,
    update(it) { if (it.src !== img.getAttribute('src')) img.src = it.src; apply(it); },
    reconcile() {},
    telemetry: noTelemetry,
    // Where ink can land: a "contain"-fit image letterboxes inside its box
    // exactly like a video does, so annotating it needs the same math.
    contentAspect() {
      if (fit === 'cover') return null;
      return img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null;
    },
    snapshot(ctx, rect) {
      paintBackdrop(ctx, rect, node);
      return drawFitted(ctx, rect, img, img.naturalWidth, img.naturalHeight, objectFitOf(img));
    },
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

  // Without loop, the browser pauses on its own at the end - but nothing in
  // `state` ever hears about it, so `item.playing` stays whatever it was
  // (true, unless someone had pressed pause), and the very next reconcile()
  // that comes along for any unrelated reason calls play() again since
  // nothing told it otherwise: a clip that finished naturally starts back
  // over, indistinguishable from loop actually being on. onEnded is display.js's
  // hook to mark it played-out in state itself, once, the same way a manual
  // pause already does - not fired for a preview instance, which reconcile()
  // never actually lets run long enough to reach its own end.
  if (!opts.preview) media.addEventListener('ended', () => opts.onEnded?.());

  // Nothing here starts itself. reconcile() is the only thing that presses
  // play, so an item cued into the hidden layer stays parked on its first
  // frame instead of running out of sync behind whatever is on screen.
  //
  // A blocked play() (the Go Live unlock did not fully satisfy this engine's
  // autoplay policy) is made self-healing rather than silently staying
  // paused forever: the very next tap or keypress anywhere on the page
  // retries it once. This is what made "exit fullscreen" look like a fix in
  // practice - any interaction unlocks it - so it happens on ALL of them
  // instead of that one undocumented gesture.
  let retryArmed = false;
  const armRetry = () => {
    if (retryArmed) return;
    retryArmed = true;
    // Calls the wrapped play() below, not media.play() directly, so a retry
    // that is ALSO blocked re-arms itself for the next interaction instead
    // of giving up after one try.
    const retry = () => { retryArmed = false; play(); };
    document.addEventListener('pointerdown', retry, { once: true, capture: true });
    document.addEventListener('keydown', retry, { once: true, capture: true });
  };
  const play = () => media.play().catch(() => armRetry());

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
  let fit = item.fit;
  video.style.objectFit = item.fit === 'cover' ? 'cover' : 'contain';
  if (item.poster) video.poster = item.poster;
  const node = el('div', { class: 'r-fill' }, video);
  const base = mediaRenderer(item, opts, video, node);
  const parentUpdate = base.update;
  base.update = (it) => {
    parentUpdate(it);
    fit = it.fit;
    video.style.objectFit = it.fit === 'cover' ? 'cover' : 'contain';
  };
  base.contentAspect = () => {
    if (fit === 'cover') return null;
    return video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : null;
  };
  // The frame on screen this instant. A video served from another origin
  // without CORS headers taints the canvas instead, which surfaces as a clear
  // "the browser would not let Podium read those pixels" when it is encoded.
  base.snapshot = (ctx, rect) => {
    paintBackdrop(ctx, rect, node);
    return drawFitted(ctx, rect, video, video.videoWidth, video.videoHeight, objectFitOf(video));
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
//
// This uses www.youtube.com rather than www.youtube-nocookie.com. The two
// serve the same player, but nocookie embeds have a real history of dropping
// setVolume/unMute commands sent over postMessage - Chrome specifically was
// seen doing this in a classroom (audio played, but the room's volume slider
// had no effect on it, only the TV's own remote did), while the same page
// controlled a nocookie embed correctly in Safari. youtube.com is the domain
// Google's own IFrame API docs use for JS-API-controlled embeds; the cost is
// that YouTube can set its ordinary cookies once the frame loads, rather than
// only after playback starts.
function renderYouTube(item, opts) {
  const origin = location.origin.startsWith('http') ? location.origin : '';
  const params = new URLSearchParams({
    enablejsapi: '1', rel: '0', modestbranding: '1', playsinline: '1',
    autoplay: '0',
    mute: '0',
    start: String(item.startAt || 0),
  });
  if (origin) params.set('origin', origin);

  const HOST = 'https://www.youtube.com';
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
  // What we last told the player to be, vs. what it last reported back -
  // if a command is silently dropped (the failure mode this domain switch
  // targets) these drift apart instead of the room just going quiet with no
  // clue why. One warning per drift, not one per reconcile.
  let wantVolume = null;
  let wantMuted = null;
  let volumeWarned = false;

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
    if (!volumeWarned && wantVolume !== null && typeof info.volume === 'number' && typeof info.muted === 'boolean') {
      const appliedVolume = info.muted ? 0 : info.volume;
      const wantedVolume = wantMuted ? 0 : wantVolume;
      if (Math.abs(appliedVolume - wantedVolume) > 5) {
        volumeWarned = true;
        console.warn(`[podium] YouTube embed ignored a volume command: asked for ${wantedVolume}, player reports ${appliedVolume}. The room's volume control will not reach this video.`);
      }
    }
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
      wantMuted = !!audio.muted;
      wantVolume = Math.round((audio.muted ? 0 : audio.volume) * 100);
      post('unMute');
      post('setVolume', [wantVolume]);
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
    let sameOrigin;
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

// Client-side canvas PDF viewer (Issue #43)

// A page's aspect ratio, by src, filled in as any renderPdf instance
// anywhere - a mirror, a preview, the display itself - finishes loading a
// page. Item-keyed rather than tied to one renderer instance on purpose:
// the controller's ink pad (contentAspectFor in control.js) needs an answer
// for whichever item is focused, which is not always the one the "Now"
// preview mirror happens to be showing (a non-A panel, mid split-screen).
const pdfAspectCache = new Map();
export function pdfAspectFor(src) { return pdfAspectCache.get(src) || null; }

function renderPdf(item) {
  const node = el('div', { class: 'r-fill r-pdf' });
  const canvas = el('canvas', { class: 'r-pdf-canvas' });
  let pageNumber = item.page || 1;
  let src = item.src;
  let zoom = item.zoom || 1;
  let panX = Number.isFinite(item.panX) ? item.panX : 0.5;
  let panY = Number.isFinite(item.panY) ? item.panY : 0.5;
  let currentDoc = null;
  let currentDocSrc = null;
  let currentRenderTask = null;
  let isDestroyed = false;
  // The page's own aspect ratio, independent of dpr or of whichever box this
  // instance happens to be rendering into - unlike canvas.width/height below,
  // which differ between the controller's small preview and the display's
  // full stage on purpose (different pixel budgets), this must not, or ink
  // anchored to a fraction of "the content" lands in a different place on
  // each. Null until the first page load resolves it, the same async-then-
  // correct shape contentAspect() already has for a deck below.
  let aspect = null;

  node.appendChild(canvas);

  const render = async () => {
    if (!window.pdfjsLib || !src) {
      node.replaceChildren(el('iframe', {
        class: 'r-frame',
        src: `${src}#page=${pageNumber}&toolbar=0&navpanes=0&statusbar=0&view=FitH`,
        frameborder: '0',
      }));
      return;
    }

    if (window.pdfjsLib.GlobalWorkerOptions && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdf.worker.min.js';
    }

    try {
      if (currentDocSrc !== src) {
        currentDocSrc = src;
        currentDoc = await window.pdfjsLib.getDocument(src).promise;
      }
      if (isDestroyed || !currentDoc) return;

      const numPages = currentDoc.numPages;
      const targetPage = Math.max(1, Math.min(numPages, pageNumber));
      const page = await currentDoc.getPage(targetPage);
      if (isDestroyed) return;

      if (currentRenderTask) {
        try { currentRenderTask.cancel(); } catch { /* already finished or already cancelled */ }
        currentRenderTask = null;
      }

      const unscaledViewport = page.getViewport({ scale: 1 });
      aspect = unscaledViewport.width / unscaledViewport.height;
      if (src) pdfAspectCache.set(src, aspect);
      const containerWidth = node.clientWidth || 1920;
      const containerHeight = node.clientHeight || 1080;
      const dpr = window.devicePixelRatio || 1;
      
      const scale = Math.max(1, Math.min(
        (containerWidth / unscaledViewport.width) * dpr,
        (containerHeight / unscaledViewport.height) * dpr,
        3
      ));

      // The canvas stays sized to the un-zoomed window (viewport at `scale`)
      // regardless of zoom - what changes is a transform ahead of it that
      // renders the page bigger and slides it so the pan point lands centered
      // in that same window. Keeping the window's own size fixed is what
      // keeps contentAspect() (and every ink coordinate anchored to it)
      // correct at any zoom level - zooming crops the view, it never
      // reshapes the letterboxed surface ink is drawn onto.
      const viewport = page.getViewport({ scale });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);

      const ctx = canvas.getContext('2d');
      let transform;
      if (zoom > 1) {
        const bigW = viewport.width * zoom;
        const bigH = viewport.height * zoom;
        const offsetX = Math.min(bigW - viewport.width, Math.max(0, panX * bigW - viewport.width / 2));
        const offsetY = Math.min(bigH - viewport.height, Math.max(0, panY * bigH - viewport.height / 2));
        transform = [zoom, 0, 0, zoom, -offsetX, -offsetY];
      }
      currentRenderTask = page.render({
        canvasContext: ctx,
        viewport: viewport,
        transform,
      });

      await currentRenderTask.promise;
      currentRenderTask = null;
    } catch (err) {
      if (err?.name === 'RenderingCancelledException') return;
      node.replaceChildren(el('iframe', {
        class: 'r-frame',
        src: `${src}#page=${pageNumber}&toolbar=0&navpanes=0&statusbar=0&view=FitH`,
        frameborder: '0',
      }));
    }
  };

  render();

  return {
    el: node,
    update(it) {
      const nextPage = it.page || 1;
      const nextZoom = it.zoom || 1;
      const nextPanX = Number.isFinite(it.panX) ? it.panX : 0.5;
      const nextPanY = Number.isFinite(it.panY) ? it.panY : 0.5;
      if (it.src !== src || nextPage !== pageNumber || nextZoom !== zoom || nextPanX !== panX || nextPanY !== panY) {
        src = it.src;
        pageNumber = nextPage;
        zoom = nextZoom;
        panX = nextPanX;
        panY = nextPanY;
        render();
      }
    },
    reconcile() {},
    telemetry: noTelemetry,
    // Null until the first page finishes loading - callers already handle
    // that (see contentRectFor's own `?? null` and the deck renderer below),
    // falling back to an un-letterboxed guess for the one frame or two this
    // is missing rather than waiting on it.
    contentAspect() { return aspect; },
    snapshot(ctx, rect) {
      if (!canvas || !canvas.width || !canvas.height) return false;
      paintBackdrop(ctx, rect, node, '#000');
      return drawFitted(ctx, rect, canvas, canvas.width, canvas.height, 'contain');
    },
    destroy() {
      isDestroyed = true;
      if (currentRenderTask) {
        try { currentRenderTask.cancel(); } catch { /* already finished or already cancelled */ }
        currentRenderTask = null;
      }
      currentDoc = null;
      node.remove();
    },
  };
}

function renderText(item) {
  const body = el('div', { class: 'r-text-body', html: miniMarkdown(item.body || '') });
  // Optional (Issue #103): a picture under the text, its own caption under
  // that. `src` is resolved to real bytes by the caller before this ever
  // runs (see resolveAssets in control.js/display.js) - the same convention
  // renderImage already relies on, so there is nothing asset-specific here.
  const image = el('img', { class: 'r-text-image', alt: '' });
  const caption = el('div', { class: 'r-text-caption' });
  const imageWrap = el('div', { class: 'r-text-image-wrap' }, image, caption);
  const node = el('div', { class: 'r-text' }, body, imageWrap);
  const apply = (it) => {
    node.dataset.size = it.size || 'l';
    node.dataset.align = it.align || 'center';
    node.dataset.font = it.font || 'sans';
    node.style.background = it.bg || '';
    imageWrap.hidden = !it.src;
    if (it.src) image.src = it.src;
    caption.textContent = it.caption || '';
    caption.hidden = !it.caption;
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
    async snapshot(ctx, rect) {
      const svg = holder.querySelector('svg');
      if (!svg) return false;
      paintBackdrop(ctx, rect, node, '#0a0d12');
      const side = Math.round(Math.min(rect.w, rect.h) * 0.62);
      const img = await svgToImage(svg, '', side, side);
      ctx.drawImage(img, rect.x + (rect.w - side) / 2, rect.y + rect.h * 0.08, side, side);
      const text = caption.textContent || '';
      if (text) {
        ctx.fillStyle = '#e8ecf1';
        ctx.textAlign = 'center';
        ctx.font = `${Math.max(10, Math.round(rect.h * 0.045))}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.fillText(text.slice(0, 90), rect.x + rect.w / 2, rect.y + rect.h * 0.08 + side + rect.h * 0.07);
        ctx.textAlign = 'start';
      }
      return true;
    },
    destroy() { node.remove(); },
  };
}

const POLL_STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', "aren't",
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', "can't",
  'cannot', 'could', "couldn't", 'did', "didn't", 'do', 'does', "doesn't", 'doing', "don't", 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', "hadn't", 'has', "hasn't", 'have', "haven't", 'having',
  'he', "he'd", "he'll", "he's", 'her', 'here', "here's", 'hers', 'herself', 'him', 'himself', 'his',
  'how', "how's", 'i', "i'd", "i'll", "i'm", "i've", 'if', 'in', 'into', 'is', "isn't", 'it', "it's",
  'its', 'itself', 'just', "let's", 'me', 'more', 'most', "mustn't", 'my', 'myself', 'no', 'nor', 'not',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over',
  'own', 'same', "shan't", 'she', "she'd", "she'll", "she's", 'should', "shouldn't", 'so', 'some', 'such',
  'than', 'that', "that's", 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', "there's",
  'these', 'they', "they'd", "they'll", "they're", "they've", 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'very', 'was', "wasn't", 'we', "we'd", "we'll", "we're", "we've", 'were',
  "weren't", 'what', "what's", 'when', "when's", 'where', "where's", 'which', 'while', 'who', "who's",
  'whom', 'why', "why's", 'with', "won't", 'would', "wouldn't", 'you', "you'd", "you'll", "you're",
  "you've", 'your', 'yours', 'yourself', 'yourselves', 'like', 'really', 'also'
]);

function extractWordFrequencies(answers) {
  const counts = new Map();
  for (const text of answers) {
    if (!text || typeof text !== 'string') continue;
    const tokens = text.toLowerCase()
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .split(/[\s,.;:!?()"'`/\\]+/)
      .map((w) => w.trim().replace(/^['"-]+|['"-]+$/g, ''))
      .filter((w) => w.length > 1 && !POLL_STOP_WORDS.has(w));
    for (const token of tokens) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word));
}

// The join card (QR + code) is what's on screen while a poll is collecting
// answers; opts.getPollJoinUrl(pollId) supplies the URL since the renderer
// itself has no access to cfg. Reveal is a separate, explicit action (never
// automatic on close), so results only replace the join card once
// item.revealed is true.
function renderPoll(item, opts) {
  const question = el('div', { class: 'r-poll-question' }, item.question || '');
  const qrHolder = el('div', { class: 'r-poll-qr' });
  const code = el('div', { class: 'r-poll-code' }, item.pollId || '');
  // Off by default is not an option here - the QR and the code are always
  // shown; showUrl (a controller-local presentation preference, decided once
  // by whoever composed the poll - see protocol.js's normalizeItem) only
  // adds this third way in, for a room where typing a URL beats scanning.
  const urlText = el('div', { class: 'r-poll-url' }, '');
  const hint = el('div', { class: 'r-poll-hint' }, 'Scan, or join and enter the code');
  const countdownText = el('div', { class: 'r-poll-countdown' }, '');
  const joinCard = el('div', { class: 'r-poll-join' }, qrHolder, code, urlText, hint, countdownText);
  const status = el('div', { class: 'r-poll-status' }, '');
  const results = el('div', { class: 'r-poll-results' });
  const node = el('div', { class: 'r-poll' }, question, joinCard, status, results);

  const drawQr = (url) => {
    if (!url || typeof window.qrcode !== 'function') { qrHolder.replaceChildren(); return; }
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    qrHolder.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  };

  const drawResults = (it) => {
    if (it.kind === 'text') {
      const hidden = new Set(it.hiddenAnswers || []);
      const answers = (it.answers || []).filter((_, i) => !hidden.has(i));
      if (it.viewMode === 'cloud') {
        const words = extractWordFrequencies(answers);
        if (!words.length) {
          results.replaceChildren(el('div', { class: 'r-poll-answer r-poll-empty' }, answers.length ? 'No keywords found' : 'No answers yet'));
          return;
        }
        const maxCount = Math.max(1, ...words.map((w) => w.count));
        const minCount = Math.min(...words.map((w) => w.count));
        const palette = [
          'var(--accent)',
          'var(--ok)',
          'var(--cue)',
          '#a78bfa',
          '#38bdf8',
          '#fb7185',
          '#f472b6',
          '#2dd4bf',
          '#fb923c',
        ];
        const cloud = el('div', { class: 'r-poll-cloud' });
        const items = words.map(({ word, count }, i) => {
          const ratio = maxCount === minCount ? 0.5 : (count - minCount) / (maxCount - minCount);
          const fontSize = `clamp(${Math.round(16 + ratio * 18)}px, ${Number((2.2 + ratio * 4.3).toFixed(1))}cqw, ${Math.round(28 + ratio * 48)}px)`;
          const color = palette[i % palette.length];
          return el('span', {
            class: 'r-poll-cloud-word',
            style: `font-size: ${fontSize}; color: ${color};`,
            title: `${count} mention${count === 1 ? '' : 's'}`,
          },
            el('span', { class: 'r-poll-cloud-text' }, word),
            count > 1 ? el('span', { class: 'r-poll-cloud-count' }, String(count)) : ''
          );
        });
        cloud.replaceChildren(...items);
        results.replaceChildren(cloud);
        return;
      }
      if (it.showNames && Array.isArray(it.responses) && it.responses.length) {
        const visibleResponses = it.responses.filter((_, i) => !hidden.has(i));
        results.replaceChildren(...(visibleResponses.length
          ? visibleResponses.map((r) => el('div', { class: 'r-poll-answer' },
              r.name ? el('span', { class: 'r-poll-author', style: 'color: var(--accent); font-weight: 600; margin-right: 8px;' }, `${r.name}: `) : '',
              el('span', {}, r.answer)
            ))
          : [el('div', { class: 'r-poll-answer r-poll-empty' }, 'No answers yet')]));
        return;
      }
      results.replaceChildren(...(answers.length
        ? answers.map((a) => el('div', { class: 'r-poll-answer' }, a))
        : [el('div', { class: 'r-poll-answer r-poll-empty' }, 'No answers yet')]));
      return;
    } else if (it.kind === 'qna') {
      const qnaFeed = (it.qnaFeed || []).filter(q => !q.hidden && !q.answered);
      const projected = (it.qnaFeed || []).find(q => q.projected);
      
      if (projected) {
        results.replaceChildren(el('div', { class: 'r-poll-qna-projected', style: 'font-size: clamp(24px, 5cqw, 72px); font-weight: 600; text-align: center; margin: 4cqh 0; padding: 4cqw; background: var(--panel); border-radius: 2cqh;' },
          projected.text,
          (it.showNames && projected.authorName) ? el('div', { style: 'font-size: clamp(14px, 2.5cqw, 28px); color: var(--accent); margin-top: 12px; font-weight: 400;' }, `— ${projected.authorName}`) : ''
        ));
      } else {
        const topQuestions = qnaFeed.sort((a, b) => (b.upvotes?.length || 0) - (a.upvotes?.length || 0)).slice(0, 4);
        results.replaceChildren(...(topQuestions.length
          ? topQuestions.map((q) => el('div', { class: 'r-poll-answer' }, 
              el('span', { class: 'mono', style: 'color: var(--dim); margin-right: 12px;' }, `▲ ${q.upvotes?.length || 0}`),
              q.text,
              (it.showNames && q.authorName) ? el('span', { style: 'color: var(--accent); margin-left: 8px; font-size: 0.9em;' }, `(${q.authorName})`) : ''
            ))
          : [el('div', { class: 'r-poll-answer r-poll-empty' }, 'No questions yet')]));
      }
      return;
    }
    const counts = it.counts || [];
    const max = Math.max(1, ...counts, 0);
    results.replaceChildren(...(it.options || []).map((opt, i) => {
      const count = counts[i] || 0;
      const fill = el('div', { class: 'r-poll-bar-fill' });
      fill.style.width = `${Math.round((count / max) * 100)}%`;
      const isCorrect = it.revealed && it.correct === i;
      const letter = String.fromCharCode(65 + i);
      const votersForThisOption = (it.showNames && Array.isArray(it.responses))
        ? it.responses.filter((r) => r.answer === i && r.name).map((r) => r.name)
        : [];
      const namesList = votersForThisOption.length
        ? el('div', { class: 'r-poll-voters-list', style: 'font-size: 13px; color: var(--dim); margin-top: 3px;' }, votersForThisOption.join(', '))
        : '';
      return el('div', { class: 'r-poll-bar-row' },
        el('div', { class: 'r-poll-bar-label' }, 
          el('span', {}, isCorrect ? el('strong', { class: 'ok-text' }, `[${letter}] `) : '', opt), 
          el('span', { class: 'mono' }, String(count))
        ),
        el('div', { class: `r-poll-bar-track${isCorrect ? ' is-correct' : ''}` }, fill),
        namesList
      );
    }));
  };

  let tickTimer = null;
  let currentClosesAt = null;

  const tick = () => {
    if (!currentClosesAt) {
      countdownText.textContent = '';
      countdownText.hidden = true;
      return;
    }
    const remaining = Math.max(0, Math.ceil((currentClosesAt - Date.now()) / 1000));
    countdownText.hidden = false;
    const m = Math.floor(remaining / 60);
    const s = String(remaining % 60).padStart(2, '0');
    countdownText.textContent = remaining >= 60 ? `${m}:${s} left` : `${s} seconds left`;
    countdownText.style.color = remaining <= 10 ? '#ff9d9d' : 'var(--dim)';
    
    // Auto-close visually on projector (server handles actual rejection)
    if (remaining === 0) {
      currentClosesAt = null;
      countdownText.hidden = true;
      if (!node.classList.contains('is-closed')) {
        node.classList.add('is-closed');
        const countText = status.textContent.split(' · ')[0];
        status.textContent = `${countText} · closed`;
      }
    }
  };

  const draw = (it) => {
    const archived = !it.token && !!it.pollId;
    const joinUrl = it.pollId ? (opts.getPollJoinUrl?.(it.pollId) || '') : '';
    question.textContent = it.question || '';
    code.textContent = it.pollId || '';
    joinCard.classList.toggle('is-archived', archived);
    node.classList.toggle('is-lost', !!it.lost);
    if (it.lost) {
      // Issue #115: the relay keeps poll state only in memory - a restart
      // wipes it, code and all, so "reopen it" is not an option here. This
      // has to say plainly that it is gone, not retry a request that will
      // keep 404ing, and not sit there looking like a normal open poll.
      qrHolder.replaceChildren();
      urlText.textContent = '';
      hint.textContent = 'Connection to this poll was lost. If the relay restarted, its votes and join code are gone — create a new poll to keep going.';
      hint.style.color = '#ff9d9d';
      currentClosesAt = null;
    } else if (!it.pollId) {
      qrHolder.replaceChildren();
      urlText.textContent = '';
      hint.textContent = 'Not started yet.';
      hint.style.color = '';
      currentClosesAt = null;
    } else if (archived) {
      qrHolder.replaceChildren();
      urlText.textContent = '';
      hint.textContent = 'This poll has ended — results only, no new votes.';
      hint.style.color = '';
      currentClosesAt = null;
    } else {
      drawQr(joinUrl);
      urlText.textContent = it.showUrl !== false ? joinUrl : '';
      hint.textContent = 'Scan, or join and enter the code';
      hint.style.color = '';
      currentClosesAt = it.open ? it.closesAt : null;
    }
    urlText.hidden = !urlText.textContent;
    node.classList.toggle('is-revealed', !!it.revealed);
    node.classList.toggle('is-closed', it.open === false);
    status.textContent = it.revealed
      ? ''
      : `${it.voters || 0} response${it.voters === 1 ? '' : 's'}${it.open === false ? ' · closed' : ''}`;
    if (it.revealed) drawResults(it);
    else results.replaceChildren();
    
    tick();
    if (currentClosesAt && !tickTimer) tickTimer = setInterval(tick, 1000);
    if (!currentClosesAt && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  };
  draw(item);

  return {
    el: node,
    update: draw,
    reconcile() {},
    telemetry: noTelemetry,
    destroy() { 
      if (tickTimer) clearInterval(tickTimer);
      node.remove(); 
    },
  };
}

function renderTimer(item, opts) {
  const value = el('div', { class: 'r-timer-value' }, '0:00');
  const label = el('div', { class: 'r-timer-label' }, item.label || '');
  const node = el('div', { class: 'r-timer' }, label, value);
  const tick = () => {
    // Which clock this one shows. No id means "the countdown", which is what
    // an item made before there was more than one still means.
    const timer = opts.getTimer?.(item.timerId) || null;
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
    // Two lines of text on a flat ground: close enough to redraw honestly,
    // and a photo of a countdown is a photo of what the clock said.
    snapshot(ctx, rect) {
      paintBackdrop(ctx, rect, node, '#0a0d12');
      ctx.fillStyle = '#e8ecf1';
      ctx.textAlign = 'center';
      const text = label.textContent || '';
      if (text) {
        ctx.font = `${Math.max(9, Math.round(rect.h * 0.07))}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.fillText(text.slice(0, 60), rect.x + rect.w / 2, rect.y + rect.h * 0.34);
      }
      ctx.font = `700 ${Math.round(rect.h * 0.3)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillText(value.textContent || '0:00', rect.x + rect.w / 2, rect.y + rect.h * 0.62);
      ctx.textAlign = 'start';
      return true;
    },
    destroy() { clearInterval(handle); node.remove(); },
  };
}

// The room's own clock for "when does the music stop" - driven by the
// display's actual <audio> position via opts.getMusicNow(), the same way
// renderTimer above is driven by opts.getTimer(): the item carries only a
// label, and the number it shows comes from outside it, live.
function renderTrackEnd(item, opts) {
  const value = el('div', { class: 'r-timer-value' }, '--:--');
  const label = el('div', { class: 'r-timer-label' }, item.title || 'We begin in…');
  const node = el('div', { class: 'r-timer' }, label, value);
  const tick = () => {
    label.textContent = item.title || 'We begin in…';
    const now = opts.getMusicNow?.() || null;
    // Nothing queued, or a track just switched and its metadata has not
    // loaded yet: say so rather than counting down from a wrong number.
    let remainingMs = NaN;
    if (now?.hasTrack) {
      if (item.untilQueue) {
        if (Number.isFinite(now.queueRemaining) && now.queueRemaining >= 0) {
          remainingMs = now.queueRemaining * 1000;
        } else if (Number.isFinite(now.duration) && now.duration > 0) {
          remainingMs = Math.max(0, (now.duration - now.time) * 1000);
        }
      } else if (Number.isFinite(now.duration) && now.duration > 0) {
        remainingMs = Math.max(0, (now.duration - now.time) * 1000);
      }
    }
    value.textContent = Number.isFinite(remainingMs) ? fmtTime(Math.ceil(remainingMs / 1000)) : '--:--';
    node.classList.toggle('is-done', remainingMs <= 0);
    node.classList.toggle('is-urgent', remainingMs > 0 && remainingMs <= 30000);
  };
  tick();
  const handle = setInterval(tick, 200);
  return {
    el: node,
    update(it) { item = it; tick(); },
    reconcile() {},
    telemetry: noTelemetry,
    snapshot(ctx, rect) {
      paintBackdrop(ctx, rect, node, '#0a0d12');
      ctx.fillStyle = '#e8ecf1';
      ctx.textAlign = 'center';
      const text = label.textContent || '';
      if (text) {
        ctx.font = `${Math.max(9, Math.round(rect.h * 0.07))}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.fillText(text.slice(0, 60), rect.x + rect.w / 2, rect.y + rect.h * 0.34);
      }
      ctx.font = `700 ${Math.round(rect.h * 0.3)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.fillText(value.textContent || '--:--', rect.x + rect.w / 2, rect.y + rect.h * 0.62);
      ctx.textAlign = 'start';
      return true;
    },
    destroy() { clearInterval(handle); node.remove(); },
  };
}

// An automated set: whatever entry is currently up, rendered by ITS OWN
// factory - a photo is the image renderer, a slide is the deck renderer, a
// QR code the QR renderer. This is a thin shell that mounts and tears down
// one child renderer as `item.index` moves, and otherwise gets out of the
// way: reconcile, telemetry and snapshot all just forward to whichever child
// is currently up, so a set holding a video still plays audio correctly and
// a set holding a whiteboard can still be photographed.
//
// `opts.resolveAssets` is the one opt this needs that nothing else does: the
// outer item (the set itself) never carries a `src`, so display.js/control.js
// resolving assets on the item they hand to createRenderer never reaches an
// `asset:<id>` sitting on an ENTRY. Each child gets resolved here instead,
// the same call the top level already makes for everything else.
function renderSet(item, opts) {
  const node = el('div', { class: 'r-set' });
  let child = null;
  let childKey = '';

  const currentSub = (it) => {
    const entry = it.entries?.[it.index];
    if (!entry) return null;
    return opts.resolveAssets ? opts.resolveAssets(entry.item) : entry.item;
  };

  const mountChild = (it) => {
    child?.destroy();
    node.replaceChildren();
    child = createRenderer(currentSub(it) || { type: 'black' }, opts);
    node.append(child.el);
    childKey = `${it.key}:${it.index}`;
  };
  mountChild(item);

  return {
    el: node,
    update(it) {
      item = it;
      const key = `${it.key}:${it.index}`;
      if (key !== childKey) mountChild(it);
      else child?.update(currentSub(it) || { type: 'black' });
    },
    reconcile(it, av) { child?.reconcile(currentSub(it) || { type: 'black' }, av); },
    telemetry: () => child?.telemetry?.() ?? noTelemetry(),
    // Delegates entirely: a set holding a whiteboard or an image can be
    // photographed exactly as if that were staged directly, and one holding
    // an embedded page or a YouTube player honestly can't be - same as
    // everywhere else in the app, nothing new to teach whyNot() about it.
    snapshot(ctx, rect) { return child?.snapshot ? child.snapshot(ctx, rect) : false; },
    destroy() { child?.destroy(); node.remove(); },
  };
}

function renderWhiteboard(item) {
  const node = el('div', { class: 'r-whiteboard' });
  const apply = (it) => { node.style.background = it.bg || '#f7f5ef'; node.dataset.ink = it.bg && it.bg !== '#f7f5ef' ? 'light' : 'dark'; };
  apply(item);
  return {
    el: node,
    update: apply,
    reconcile() {},
    telemetry: noTelemetry,
    // The board itself is a flat colour; photographing one is really about the
    // ink the display paints over the top of this.
    snapshot(ctx, rect) { paintBackdrop(ctx, rect, node, '#f7f5ef'); return true; },
    destroy() { node.remove(); },
  };
}

const CAMERA_HINTS = {
  idle: 'Waiting for the camera on your phone… On the iPad, open the Camera tab and tap Start camera.',
  connecting: 'Connecting to the phone’s camera…',
  live: '',
  failed: 'Could not connect to the phone’s camera. If this is a guest Wi-Fi network, it may be blocking the two devices from reaching each other directly.',
};

// The stream is supplied by the WebRTC layer, which may connect after the
// renderer mounts, so re-check on every reconcile.
function renderCamera(item, opts) {
  const video = el('video', { class: 'r-video', autoplay: true, playsinline: true, muted: true });
  video.muted = true;
  const hint = el('div', { class: 'r-camera-hint' }, CAMERA_HINTS.idle);
  const frozenBadge = el('div', { class: 'r-camera-frozen' }, 'Frozen');
  const node = el('div', { class: 'r-fill r-camera' }, video, hint, frozenBadge);
  const attach = () => {
    const stream = opts.getStream?.();
    if (stream && video.srcObject !== stream) {
      video.srcObject = stream;
      video.play().catch(() => {});
    }
    const hasStream = !!stream;
    node.classList.toggle('has-stream', hasStream);
    if (!hasStream) hint.textContent = CAMERA_HINTS[opts.getCameraStatus?.() || 'idle'] ?? CAMERA_HINTS.idle;
  };
  // A camera feed is live video with no timeline of its own, so freezing it
  // has to mean something different than it does for a deck: pausing the
  // <video> element holds its current frame on screen (the underlying stream
  // keeps arriving invisibly) while unfreezing simply resumes rendering
  // whatever is live by then - there is no "seek back to where it paused".
  const syncFreeze = () => {
    if (!video.srcObject) return;
    const frozen = !!opts.getFrozen?.();
    node.classList.toggle('is-frozen', frozen);
    if (frozen && !video.paused) video.pause();
    else if (!frozen && video.paused) video.play().catch(() => {});
  };
  attach();
  return {
    el: node,
    update() { attach(); syncFreeze(); },
    reconcile() { attach(); syncFreeze(); },
    telemetry: noTelemetry,
    // Same frame the room is looking at. Nothing to photograph before the
    // phone connects, which is a failure worth reporting rather than a black
    // rectangle labelled "camera".
    snapshot(ctx, rect) {
      if (!video.srcObject || !video.videoWidth) return false;
      paintBackdrop(ctx, rect, node);
      return drawFitted(ctx, rect, video, video.videoWidth, video.videoHeight, objectFitOf(video));
    },
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
    ${FRAGMENT_CSS}
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
  let current = { slide: 0, step: 0 };

  const setStatus = (text) => {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  };

  // A build's fragments are just elements marked with a 1-based step number;
  // showing "step" reveals everything up to and including that number.
  function applyStep(svg, step) {
    if (!svg) return;
    svg.querySelectorAll('.podium-fragment').forEach((node) => {
      node.classList.toggle('is-shown', Number(node.dataset.podiumFragment) <= step);
    });
  }

  function showSlide(slide, step) {
    if (!slides.length) return;
    const clamped = Math.min(slides.length - 1, Math.max(0, slide || 0));
    current = { slide: clamped, step: step || 0 };
    slides.forEach((svg, i) => svg.classList.toggle('podium-on', i === clamped));
    applyStep(slides[clamped], current.step);
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
      // Before anything is shown, so an over-full slide arrives already shrunk
      // to fit rather than being seen to reflow on the projector.
      applyFits(wrap, deck.fits);
      slides = Array.from(wrap.querySelectorAll('svg[data-marpit-svg]'));
      // Marp needs its DOM polyfill for inline-SVG slides; without it Safari
      // (so, every iPad) lays foreignObject content out wrongly.
      polyfill?.cleanup?.();
      polyfill = await applyPolyfill(shadow);
      if (mine !== generation) return;
      mountedId = it.deckId;
      setStatus(slides.length ? '' : 'That markdown produced no slides.');
      showSlide(it.slide, it.step);
      // contentAspect() only has a real answer from here on - before this,
      // ink applied to this item was necessarily drawn against contentRect()'s
      // no-letterbox fallback (aspect unknown). The strokes themselves are
      // still correct (they are fractions captured on the controller,
      // unaffected by this display's own mount timing) but the CANVAS PIXELS
      // already painted from them are not, and nothing else re-draws ink
      // just because a deck finished mounting. Ask the host to redo it now
      // that there is a real box to redo it against.
      opts.onReady?.();
    } catch (err) {
      setStatus(`Marp could not render this deck.\n${err.message}`);
    }
  }

  mount(item);

  return {
    el: host,
    update(it) {
      if (it.deckId !== mountedId) { mount(it); return; }
      if ((it.slide || 0) !== current.slide || (it.step || 0) !== current.step) showSlide(it.slide, it.step);
    },
    reconcile() {},
    telemetry: noTelemetry,
    // The slide as it stands, mid-build included: the deck's own CSS and the
    // fragment rules travel with the clone, so a photo taken three bullets in
    // has three bullets on it.
    async snapshot(ctx, rect) {
      const svg = slides[current.slide];
      if (!svg) return false;
      const box = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
      const aspect = box.length === 4 && box[3] > 0 ? box[2] / box[3] : 16 / 9;
      const deckCss = wrap.querySelector('style')?.textContent || '';
      const width = Math.max(1, Math.round(Math.min(rect.w, rect.h * aspect)));
      const height = Math.max(1, Math.round(width / aspect));
      const img = await svgToImage(svg, `${cssForStandaloneSlide(deckCss)}\n${FRAGMENT_CSS}`, width, height);
      ctx.fillStyle = '#000';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.drawImage(img, rect.x + (rect.w - width) / 2, rect.y + (rect.h - height) / 2, width, height);
      return true;
    },
    // The aspect ratio baked into the visible slide's own viewBox, so ink can
    // be confined to exactly the slide instead of the whole (often
    // letterboxed) screen.
    contentAspect() {
      const svg = slides[current.slide];
      const box = svg && (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
      return box && box.length === 4 && box[2] > 0 && box[3] > 0 ? box[2] / box[3] : null;
    },
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
  trackend: renderTrackEnd,
  whiteboard: renderWhiteboard,
  camera: renderCamera,
  set: renderSet,
  poll: renderPoll,
};

export function createRenderer(item, opts = {}) {
  const factory = FACTORIES[item?.type] || renderBlack;
  const renderer = factory(item || { type: 'black' }, opts);
  renderer.type = item?.type || 'black';
  return renderer;
}
