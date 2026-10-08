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
//   syncTo(seconds)      optional, media only: jump to where the room is - a
//                        Guest View viewer (Issue #150) that joined late or
//                        drifted. Never part of `state`: the room's own seek
//                        is seekTo/seekNonce, and a viewer must not fake one.

import { el, miniMarkdown, fmtTime } from './util.js';
import { parseStreamSource, streamLabel } from './protocol.js';
import { render as renderDeckSource, applyPolyfill, applyFits, cssForStandaloneSlide, FRAGMENT_CSS } from './deck.js';
import { ASSET_REF } from './deck-source.js';
import { renderDoc, measureDoc, DOC_WIDTH, DOC_VIEW } from './doc.js';
import { BLANK_PIXEL } from './assets.js';

export const TYPES = {
  black:      { label: 'Black',      icon: '■' },
  image:      { label: 'Image',      icon: '\u{1F5BC}' },
  video:      { label: 'Video',      icon: '▶' },
  audio:      { label: 'Audio',      icon: '♪' },
  youtube:    { label: 'YouTube',    icon: '▶' },
  stream:     { label: 'Live stream', icon: '\u{1F4E1}' },
  web:        { label: 'Web page',   icon: '\u{1F310}' },
  slides:     { label: 'Slides',     icon: '\u{1F4D1}' },
  deck:       { label: 'Marp deck',  icon: '\u{1F4D6}' },
  document:   { label: 'Document',   icon: '\u{1F4C3}' },
  imagedeck:  { label: 'Picture deck', icon: '\u{1F39E}' },
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
export function svgToImage(svg, css, width, height) {
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

// A picture deck (Issue #106): one image per slide - PowerPoint's own "export
// as images" - shown one at a time. It is renderImage with a slide index, so
// fit, ink letterboxing and photographing all behave exactly as for a photo;
// the next slide is fetched ahead so advancing never waits on the network.
function renderImageDeck(item) {
  const img = el('img', { class: 'r-image', alt: item.title || '', decoding: 'async' });
  const node = el('div', { class: 'r-fill' }, img);
  let current = item;
  let ahead = null;
  const srcOf = (it) => it.images?.[it.slide || 0] || '';
  const apply = (it) => {
    current = it;
    const src = srcOf(it);
    if (src !== img.getAttribute('src')) {
      if (src) img.src = src;
      else img.removeAttribute('src');
    }
    img.style.objectFit = it.fit === 'cover' ? 'cover' : 'contain';
    const next = it.images?.[(it.slide || 0) + 1];
    if (next && ahead?.getAttribute('src') !== next) {
      ahead = new Image();
      ahead.decoding = 'async';
      ahead.src = next;
    }
  };
  apply(item);
  return {
    el: node,
    update: apply,
    reconcile() {},
    telemetry: noTelemetry,
    contentAspect() {
      if (current.fit === 'cover') return null;
      return img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : null;
    },
    snapshot(ctx, rect) {
      paintBackdrop(ctx, rect, node);
      return drawFitted(ctx, rect, img, img.naturalWidth, img.naturalHeight, objectFitOf(img));
    },
    destroy() { ahead = null; node.remove(); },
  };
}

// --- players Safari will let make a sound -------------------------------------
//
// Safari only lets a <video> or <audio> play with sound once that very element
// has been played from a click or tap. The display's one click is Go live, and
// a video picked ten minutes later is a brand-new element nobody clicked - so
// Safari refused it, the picture never moved on the projector, the music was
// never ducked, and the room heard nothing (Chrome lets the whole page play
// once it has been clicked, which is why only Safari showed it).
//
// So Go live makes a few players here and plays each one, for a moment and
// silently, inside its click - unmuted, which is what counts. A video or audio
// item, or a deck's video slide, then takes one of these instead of making
// its own, and hands it back when it is done, still allowed to make a sound.
// The same idea as howler.js's pool of unlocked HTML5 players.
const mediaPool = { video: [], audio: [] };
const blessed = new WeakSet();

/**
 * Inside a click or tap: make (up to) `counts` players and let each play a
 * silent clip, so each is allowed to make a sound from now on.
 */
export function blessMediaElements(silentClip, counts = { video: 6, audio: 3 }) {
  for (const tag of ['video', 'audio']) {
    while (mediaPool[tag].length < (counts[tag] || 0)) {
      const media = document.createElement(tag);
      media.src = silentClip;
      // Marked, so a test - or anyone inspecting the projector's page - can
      // tell a player Go live made from one made later.
      media.dataset.podiumBlessed = '';
      blessed.add(media);
      mediaPool[tag].push(media);
      // play() has to be called now, inside the click; what follows can wait.
      // A player already taken by the time it settles is someone else's.
      Promise.resolve(media.play())
        .catch(() => { /* blocked or cut short - it is still a player */ })
        .then(() => {
          if (!mediaPool[tag].includes(media)) return;
          media.pause();
          media.removeAttribute('src');
          media.load();
        });
    }
  }
}

function takeMedia(tag) {
  return mediaPool[tag].pop() || document.createElement(tag);
}

// A player from the pool goes back into it, emptied; any other is dropped.
function releaseMedia(media) {
  media.pause();
  if (media.getAttribute('src')) { media.removeAttribute('src'); media.load(); }
  media.remove();
  if (!blessed.has(media)) return;
  media.removeAttribute('class');
  media.removeAttribute('style');
  media.removeAttribute('poster');
  media.loop = false;
  media.muted = false;
  media.volume = 1;
  const tag = media.localName;
  if (!mediaPool[tag].includes(media)) mediaPool[tag].push(media);
}

// Shared plumbing for <video> and <audio>.
function mediaRenderer(item, opts, media, node) {
  // Listeners come off with the player: a pooled one goes on to play other
  // things, and must not tell this item it ended.
  const listening = new AbortController();
  const { signal } = listening;
  let lastSeek = item.seekNonce || 0;
  media.playsInline = true;
  media.preload = 'auto';
  media.src = item.src;
  if (item.loop) media.loop = true;
  if (opts.preview) media.muted = true;

  // currentTime before metadata is silently dropped, so cue on loadedmetadata.
  let cueTo = item.startAt || 0;
  const cue = () => { if (cueTo) { media.currentTime = cueTo; cueTo = 0; } };
  media.addEventListener('loadedmetadata', cue, { signal });
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
  if (!opts.preview) media.addEventListener('ended', () => opts.onEnded?.(), { signal });

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
    document.addEventListener('pointerdown', retry, { once: true, capture: true, signal });
    document.addEventListener('keydown', retry, { once: true, capture: true, signal });
  };
  // A refusal is also said out loud (opts.onSoundBlocked), so the presenter
  // learns the screen needs a click rather than wondering why it is silent.
  const play = () => media.play().then(() => opts.onSoundBlocked?.(false), (err) => {
    if (err?.name === 'NotAllowedError') opts.onSoundBlocked?.(true);
    armRetry();
  });

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
    syncTo(seconds) { if (Number.isFinite(seconds)) media.currentTime = Math.max(0, seconds); },
    destroy() {
      listening.abort();
      releaseMedia(media);
      node.remove();
    },
  };
}

function renderVideo(item, opts) {
  const video = takeMedia('video');
  video.className = 'r-video';
  video.setAttribute('playsinline', '');
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
  const audioEl = takeMedia('audio');
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
  // A live channel (Issue #175) embeds whatever that channel is broadcasting
  // now, by channel id, through the same player and the same postMessage API.
  if (item.liveChannel) params.set('channel', item.liveChannel);
  const path = item.liveChannel ? 'live_stream' : encodeURIComponent(item.videoId);
  const frame = el('iframe', {
    class: 'r-frame',
    src: `${HOST}/embed/${path}?${params}`,
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
    syncTo(seconds) { if (Number.isFinite(seconds)) post('seekTo', [Math.max(0, seconds), true]); },
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
    // Nothing picked yet (a freshly added item, before an upload or a typed
    // path lands) - render nothing rather than an iframe whose src is the
    // literal string "undefined", which the browser dutifully fetches.
    if (!src) { node.replaceChildren(); return; }
    if (!window.pdfjsLib) {
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
    node.style.color = it.color || '';
    imageWrap.hidden = !it.src;
    if (it.src) image.src = it.src;
    // A chosen text colour carries the caption with it; the default keeps
    // the caption a step quieter than the words.
    caption.style.color = it.color || '';
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
    // viewerLive: a guest viewer's copy of a live poll, whose token was
    // stripped before it left the display (see viewerPoll in protocol.js) -
    // live all the same, not an archived snapshot.
    const archived = !it.token && !it.viewerLive && !!it.pollId;
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
    /* A video slide's video (Issue #226): over the slide's own box, outside
       Marp's SVG - WebKit will not play a <video> inside a foreignObject
       properly - and hidden until it has a frame, so the poster the slide
       draws is what shows until then. */
    :host { container-type: size; }
    #video-box {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(100cqw, calc(100cqh * var(--aspect, 1.7778)));
      height: min(100cqh, calc(100cqw / var(--aspect, 1.7778)));
      display: none; pointer-events: none;
    }
    #video-box.is-on { display: block; }
    #video-box video { width: 100%; height: 100%; object-fit: contain; background: transparent; visibility: hidden; }
    #video-box video.has-frame { visibility: visible; }
  </style><div id="status">Loading deck…</div><div id="wrap"></div><div id="video-box"></div>`;

  const statusEl = shadow.getElementById('status');
  const wrap = shadow.getElementById('wrap');
  const videoBox = shadow.getElementById('video-box');
  // A player from the pool on the display, so Safari lets it make a sound.
  const video = takeMedia('video');
  video.setAttribute('playsinline', '');
  videoBox.append(video);
  let slides = [];
  let videos = [];
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
    showVideo();
  }

  // --- a video slide's video (Issue #226) ---
  //
  // One <video>, moved to whichever slide is showing. Each video slide keeps
  // where it got to, so leaving one (which pauses it - see 'nav' in
  // protocol.js) and coming back finds it where it was. Playback is driven
  // the same way as a video item's: reconcile() is the only thing that
  // presses play, from the item's playing / seekTo / seekNonce.
  const times = new Map();
  let videoSlide = -1;
  let cueTo = 0;
  let lastSeek = item.seekNonce || 0;
  video.preload = 'auto';
  video.muted = !!opts.preview;
  const listening = new AbortController();
  const { signal } = listening;
  video.addEventListener('loadedmetadata', () => { if (cueTo) { video.currentTime = cueTo; cueTo = 0; } }, { signal });
  video.addEventListener('loadeddata', () => video.classList.add('has-frame'), { signal });
  if (!opts.preview) video.addEventListener('ended', () => opts.onEnded?.(), { signal });

  function showVideo() {
    const wanted = videos[current.slide] || null;
    if (wanted && videoSlide === current.slide) return;
    if (videoSlide >= 0) { times.set(videoSlide, video.currentTime || 0); video.pause(); }
    video.classList.remove('has-frame');
    videoSlide = wanted ? current.slide : -1;
    videoBox.classList.toggle('is-on', !!wanted);
    if (!wanted) {
      if (video.getAttribute('src')) { video.removeAttribute('src'); video.load(); }
      return;
    }
    const box = (slides[current.slide]?.dataset.podiumBox || slides[current.slide]?.getAttribute('viewBox') || '')
      .trim().split(/\s+/).map(Number).slice(-2);
    if (box.length === 2 && box[0] > 0 && box[1] > 0) videoBox.style.setProperty('--aspect', String(box[0] / box[1]));
    cueTo = times.has(current.slide) ? times.get(current.slide) : wanted.start || 0;
    video.src = wanted.src;
  }

  // A blocked play() (an autoplay policy the Go Live tap did not satisfy)
  // retries on the next tap or key anywhere, as a video item's does.
  let retryArmed = false;
  const playVideo = () => video.play().then(() => opts.onSoundBlocked?.(false), (err) => {
    if (err?.name === 'NotAllowedError') opts.onSoundBlocked?.(true);
    if (retryArmed) return;
    retryArmed = true;
    const retry = () => { retryArmed = false; if (videoSlide >= 0) playVideo(); };
    document.addEventListener('pointerdown', retry, { once: true, capture: true, signal });
    document.addEventListener('keydown', retry, { once: true, capture: true, signal });
  });

  // A deck inside a lecture plan, with no server, keeps its pictures in the
  // plan as `asset:<id>` (Issue #226). They are swapped for their bytes here,
  // the same way an image item's are, before Marp sees the markdown - and any
  // this device does not hold yet are asked for, and the deck drawn again
  // once they arrive (see update below).
  let missingAssets = [];
  const resolved = (ref) => {
    const got = opts.resolveAssets?.({ src: ref })?.src;
    return got && got !== ref && got !== BLANK_PIXEL ? got : null;
  };
  function withAssets(source) {
    missingAssets = [];
    if (!opts.resolveAssets || !source.includes('asset:')) return source;
    return source.replace(ASSET_REF, (ref) => {
      const got = resolved(ref);
      if (!got) { missingAssets.push(ref); return BLANK_PIXEL; }
      return got;
    });
  }

  let failedAt = 0;
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
      const drawn = withAssets(source);
      // Keyed by the deck alone when nothing was swapped in, as always; by
      // what was actually drawn when something was, so a picture arriving
      // later is a different render rather than the cached one without it.
      const deck = await renderDeckSource(drawn, drawn === source ? it.deckId : undefined);
      if (mine !== generation) return;
      wrap.innerHTML = `<style>${deck.css}</style>${deck.html}`;
      videos = deck.videos || [];
      times.clear();
      videoSlide = -1;
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
      // Not the end of it (Issue #221): mountedId is still unset, so a later
      // update() mounts again, and deck.js no longer keeps a failed engine.
      failedAt = Date.now();
      setStatus(`Marp could not render this deck.\n${err.message}\nTrying again in a moment…`);
    }
  }

  mount(item);

  return {
    el: host,
    update(it) {
      if (missingAssets.length && it.deckId === mountedId && missingAssets.some(resolved)) { mount(it); return; }
      // A deck that would not render is mounted again on a later update
      // (Issue #221) - a few seconds apart, not on every one.
      if (it.deckId !== mountedId) {
        if (Date.now() - failedAt < 4000) return;
        mount(it);
        return;
      }
      if ((it.slide || 0) !== current.slide || (it.step || 0) !== current.step) showSlide(it.slide, it.step);
    },
    reconcile(it, audio) {
      if (videoSlide < 0) return;
      if (opts.preview) { video.muted = true; video.pause(); return; }
      video.volume = audio.muted ? 0 : audio.volume;
      video.muted = audio.muted;
      video.loop = !!it.loop;
      if ((it.seekNonce || 0) !== lastSeek) {
        lastSeek = it.seekNonce || 0;
        if (it.seekTo !== undefined) video.currentTime = it.seekTo;
        else if (it.seekBy !== undefined) video.currentTime = Math.max(0, video.currentTime + it.seekBy);
      }
      if (it.playing !== true && !video.paused) video.pause();
      if (it.playing === true && video.paused) playVideo();
    },
    telemetry: () => (videoSlide < 0 ? noTelemetry()
      : { time: video.currentTime || 0, duration: video.duration || 0, playing: !video.paused }),
    // A copy on a controller (Issue #182) or a Guest View viewer catching up.
    syncTo(seconds) {
      if (videoSlide < 0 || !Number.isFinite(seconds)) return;
      if (video.readyState >= 1) video.currentTime = Math.max(0, seconds);
      else cueTo = Math.max(0, seconds);
    },
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
      const slideRect = { x: rect.x + (rect.w - width) / 2, y: rect.y + (rect.h - height) / 2, w: width, h: height };
      ctx.drawImage(img, slideRect.x, slideRect.y, width, height);
      // The frame the video is on, over its poster - what the room is
      // actually looking at, paused mid-clip with marks on it (#182).
      if (videoSlide >= 0 && video.classList.contains('has-frame') && video.readyState >= 2) {
        drawFitted(ctx, slideRect, video, video.videoWidth, video.videoHeight, 'contain');
      }
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
      listening.abort();
      releaseMedia(video);
      host.remove();
    },
  };
}

// --- live streams (Issue #175) ------------------------------------------------
//
// Twitch through Twitch's own player script, loaded from player.twitch.tv the
// first time a Twitch stream is actually shown (never on a page that does not
// show one): the script is the only way to control a Twitch player's play,
// pause and volume, which is what lets the Mixer, Master, mute and the
// transport reach a stream the same way they reach YouTube. YouTube Live is
// the YouTube renderer above, by video id or by channel.
//
// `show` decides how much of it the room gets: 'both'; 'video', muted
// whatever the faders say; or 'audio', the player still running (browsers
// and Twitch both throttle a player they believe is hidden) under a card that
// says what is playing. It is switched on the live player - see the 'show'
// media action in protocol.js - never by reloading the stream.
//
// On the controller (opts.preview: the cue thumbnail, the Now and Next
// mirrors) a stream is a card rather than a second live player: the iPad has
// no business pulling a video stream just to show a thumbnail of it.

const TWITCH_SCRIPT = 'https://player.twitch.tv/js/embed/v1.js';
let twitchLoading = null;
function loadTwitch() {
  if (globalThis.Twitch?.Player) return Promise.resolve(globalThis.Twitch);
  twitchLoading ||= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TWITCH_SCRIPT;
    script.async = true;
    script.onload = () => (globalThis.Twitch?.Player ? resolve(globalThis.Twitch) : reject(new Error('the Twitch player script loaded but did not start')));
    script.onerror = () => { twitchLoading = null; script.remove(); reject(new Error(`could not load ${TWITCH_SCRIPT}`)); };
    document.head.append(script);
  });
  return twitchLoading;
}

let twitchSeq = 0;
function renderTwitch(item) {
  const host = el('div', { class: 'r-twitch-host', id: `podium-twitch-${++twitchSeq}` });
  const warn = el('div', { class: 'r-embed-warn' });
  const node = el('div', { class: 'r-fill r-twitch' }, host, warn);
  let player = null;
  let ready = false;
  let want = null;
  let channel = item.channel;
  const telemetry = { time: 0, duration: 0, playing: false };

  const say = (text) => { warn.replaceChildren(el('div', {}, text)); node.classList.remove('is-loaded'); };
  // Twitch refuses to play unless it is told the exact site embedding it, and
  // checks it: a page opened from a file, or from an address that is not a
  // proper host name, cannot show Twitch at all.
  const parent = location.hostname;
  if (!parent || location.protocol === 'file:') {
    say('Twitch only plays on a page served from a web address - not one opened from a file.');
  } else {
    say(`Loading twitch.tv/${channel}…`);
    loadTwitch().then((Twitch) => {
      player = new Twitch.Player(host, {
        channel, parent: [parent], width: '100%', height: '100%', autoplay: false, muted: true,
      });
      player.addEventListener(Twitch.Player.READY, () => { ready = true; node.classList.add('is-loaded'); apply(); });
      player.addEventListener(Twitch.Player.PLAY, () => { telemetry.playing = true; });
      player.addEventListener(Twitch.Player.PLAYING, () => { telemetry.playing = true; });
      player.addEventListener(Twitch.Player.PAUSE, () => { telemetry.playing = false; });
      player.addEventListener(Twitch.Player.OFFLINE, () => say(`twitch.tv/${channel} is not live right now.`));
      player.addEventListener(Twitch.Player.ONLINE, () => node.classList.add('is-loaded'));
    }).catch((err) => say(`The Twitch player did not load: ${err.message}. Check that this network allows twitch.tv.`));
  }

  function apply() {
    if (!ready || !player || !want) return;
    const { it, audio } = want;
    try {
      const silent = !!audio.muted || audio.volume <= 0;
      player.setMuted(silent);
      if (!silent) player.setVolume(Math.min(1, Math.max(0, audio.volume)));
      if (it.playing === false) player.pause();
      else player.play();
    } catch { /* a player mid-teardown - the next reconcile tries again */ }
  }

  return {
    el: node,
    update(it) {
      if (it.channel && it.channel !== channel) {
        channel = it.channel;
        try { player?.setChannel(channel); } catch { /* not ready yet - created with the old one, corrected on READY below */ }
      }
    },
    reconcile(it, audio) { want = { it, audio }; apply(); },
    telemetry: () => {
      try { if (player && ready) telemetry.time = player.getCurrentTime() || 0; } catch { /* keep the last reading */ }
      return { ...telemetry };
    },
    destroy() { try { player?.pause(); } catch { /* already gone */ } node.remove(); },
  };
}

function streamCard(item, detail) {
  return el('div', { class: 'r-stream-card' },
    el('div', { class: 'r-stream-icon', 'aria-hidden': 'true' }, item.show === 'audio' ? '\u{1F50A}' : '\u{1F4E1}'),
    el('div', { class: 'r-stream-title' }, item.title || 'Live stream'),
    el('div', { class: 'r-stream-sub' }, detail));
}

const SHOW_WORDS = { both: 'Video and sound', video: 'Video only, muted', audio: 'Sound only' };

// The planner previews an item before anything has normalized it (see
// normalizeItem in protocol.js), so a card reads the link itself if it has to.
function streamFields(it) {
  if (it.platform && (it.channel || it.videoId)) return it;
  return { ...it, ...(parseStreamSource(it.url || it.src || it.channel || it.videoId, it.platform) || {}) };
}

function renderStream(item, opts) {
  item = streamFields(item);
  const where = item.platform ? streamLabel(item) : 'No stream link yet';
  if (opts.preview) {
    const node = el('div', { class: 'r-fill r-stream is-preview' });
    const paint = (raw) => {
      const it = streamFields(raw);
      const here = it.platform ? streamLabel(it) : 'No stream link yet';
      node.replaceChildren(streamCard(it, `${here} · ${SHOW_WORDS[it.show] || SHOW_WORDS.both}`));
    };
    paint(item);
    return { el: node, update: paint, reconcile() {}, telemetry: noTelemetry, destroy() { node.remove(); } };
  }

  const inner = item.platform === 'twitch'
    ? renderTwitch(item)
    : renderYouTube(item.videoId ? { ...item, videoId: item.videoId } : { ...item, videoId: '', liveChannel: item.channel }, opts);
  const cover = el('div', { class: 'r-stream-cover' });
  const node = el('div', { class: 'r-fill r-stream' }, inner.el, cover);
  let show = item.show || 'both';
  const paintCover = (it) => {
    show = it.show || 'both';
    node.dataset.show = show;
    cover.hidden = show !== 'audio';
    if (show === 'audio') cover.replaceChildren(streamCard(it, `${where} · ${SHOW_WORDS.audio}`));
  };
  paintCover(item);

  return {
    el: node,
    update(it) { paintCover(it); inner.update(it); },
    reconcile(it, audio) {
      paintCover(it);
      inner.reconcile(it, show === 'video' ? { ...audio, muted: true } : audio);
    },
    telemetry: () => inner.telemetry(),
    destroy() { inner.destroy(); node.remove(); },
  };
}

// A markdown document (Issue #240): one page laid out at DOC_WIDTH and scaled
// to the screen - by its width, or by a 16:9 window's height on a screen
// wider than that - and scrolled to `at`, the y of the top of what the room
// sees, in the page's own pixels. A move is a short glide the room can
// follow, never a jump.
function renderDocument(item, opts) {
  const host = el('div', { class: 'r-doc' });
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host { display: block; position: absolute; inset: 0; overflow: hidden; background: #ffffff; }
    :host(.is-dark) { background: #14181d; }
    #view { position: absolute; left: 0; top: 0; width: ${DOC_WIDTH}px; transform-origin: 0 0; }
    #status {
      position: absolute; inset: 0; display: grid; place-items: center; padding: 4%;
      font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: #556; background: #fff; text-align: center; white-space: pre-wrap;
    }
    #status[hidden] { display: none; }
  </style><style id="doc-css"></style><div id="view"></div><div id="status">Loading document…</div>`;
  const view = shadow.getElementById('view');
  const cssEl = shadow.getElementById('doc-css');
  const statusEl = shadow.getElementById('status');
  let rendered = null;
  let mountedKey = null;
  let generation = 0;
  let failedAt = 0;
  let at = 0;          // where the room is
  let shownAt = 0;     // where this screen is, mid-glide
  let height = Number(item.height) || DOC_VIEW;
  let scale = 1;
  let left = 0;
  let metrics = null;
  let glide = 0;

  const setStatus = (text) => {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
  };
  const keyOf = (it) => `${it.deckId || it.src || ''}|${it.look || ''}`;

  function place() {
    view.style.transform = `translate(${left}px, ${-shownAt * scale}px) scale(${scale})`;
  }
  // A short glide the room can follow, stepped here rather than left to a CSS
  // transition, so ink pinned to the text (see pageRect) moves with it.
  function glideTo(target) {
    cancelAnimationFrame(glide);
    const from = shownAt;
    const start = performance.now();
    const ease = (t) => 1 - (1 - t) ** 3;
    const step = (now) => {
      const t = Math.min(1, (now - start) / 450);
      shownAt = from + (target - from) * ease(t);
      place();
      opts.onScroll?.();
      if (t < 1) glide = requestAnimationFrame(step);
    };
    if (typeof requestAnimationFrame !== 'function' || from === target) { shownAt = target; place(); opts.onScroll?.(); return; }
    glide = requestAnimationFrame(step);
  }
  function fit() {
    const w = host.clientWidth || DOC_WIDTH;
    const h = host.clientHeight || DOC_VIEW;
    scale = Math.min(w / DOC_WIDTH, h / DOC_VIEW) || 1;
    left = Math.max(0, (w - DOC_WIDTH * scale) / 2);
    place();
  }
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  resize?.observe(host);

  let missingAssets = [];
  const resolved = (ref) => {
    const got = opts.resolveAssets?.({ src: ref })?.src;
    return got && got !== ref && got !== BLANK_PIXEL ? got : null;
  };
  function withAssets(source) {
    missingAssets = [];
    if (!opts.resolveAssets || !source.includes('asset:')) return source;
    return source.replace(ASSET_REF, (ref) => {
      const got = resolved(ref);
      if (!got) { missingAssets.push(ref); return BLANK_PIXEL; }
      return got;
    });
  }

  // Measured once the page is laid out, and again once its pictures have
  // arrived (a picture with no size given grows the page when it loads).
  function remeasure() {
    const page = view.querySelector('.podium-doc');
    if (!page || !rendered) return;
    metrics = measureDoc(page, rendered);
    opts.onMeasure?.(metrics, rendered);
  }

  async function mount(it) {
    const mine = ++generation;
    let source;
    try {
      source = await opts.getDeckSource?.(it);
    } catch (err) {
      setStatus(`Could not load the document.\n${err.message}`);
      return;
    }
    if (mine !== generation) return;
    if (source == null) { setStatus('Waiting for the document…'); return; }
    try {
      const drawn = withAssets(source);
      const doc = await renderDoc(drawn, drawn === source ? it.deckId : undefined, { look: it.look });
      if (mine !== generation) return;
      rendered = doc;
      cssEl.textContent = doc.css;
      view.innerHTML = doc.html;
      host.classList.toggle('is-dark', doc.look === 'dark');
      mountedKey = keyOf(it);
      at = Number(it.at) || 0;
      shownAt = at;
      height = Number(it.height) || height;
      fit();
      setStatus('');
      remeasure();
      const pictures = Array.from(view.querySelectorAll('img')).filter((img) => !img.complete);
      if (pictures.length) {
        Promise.all(pictures.map((img) => new Promise((done) => {
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
        }))).then(() => { if (mine === generation) remeasure(); });
      }
      opts.onReady?.();
    } catch (err) {
      failedAt = Date.now();
      setStatus(`This document could not be shown.\n${err.message}\nTrying again in a moment…`);
    }
  }

  mount(item);

  return {
    el: host,
    update(it) {
      if (missingAssets.length && keyOf(it) === mountedKey && missingAssets.some(resolved)) { mount(it); return; }
      if (keyOf(it) !== mountedKey) {
        if (Date.now() - failedAt < 4000) return;
        mount(it);
        return;
      }
      height = Number(it.height) || height;
      const next = Number(it.at) || 0;
      if (next !== at) { at = next; glideTo(at); }
    },
    reconcile() {},
    telemetry: noTelemetry,
    /** Where everything is in the page, once it is laid out (or null). */
    measure: () => metrics,
    /** Where this copy is showing, mid-glide included. */
    shownAt: () => shownAt,
    /** The page as rendered: outline, notes, title. */
    rendered: () => rendered,
    contentAspect: () => null,
    // What the room sees of the page, for a photo of the panel - the ink
    // canvas is laid over it by whoever asked, as for a slide.
    async snapshot(ctx, rect) {
      const page = view.querySelector('.podium-doc');
      if (!page || !rendered) return false;
      const s = Math.min(rect.w / DOC_WIDTH, rect.h / DOC_VIEW) || 1;
      const visible = Math.ceil(rect.h / s);
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 ${Math.round(shownAt)} ${DOC_WIDTH} ${visible}`);
      const fo = document.createElementNS(ns, 'foreignObject');
      fo.setAttribute('x', '0');
      fo.setAttribute('y', '0');
      fo.setAttribute('width', String(DOC_WIDTH));
      fo.setAttribute('height', String(Math.max(height, Math.round(shownAt) + visible)));
      const holder = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
      holder.innerHTML = page.outerHTML;
      fo.append(holder);
      svg.append(fo);
      const width = Math.round(DOC_WIDTH * s);
      const img = await svgToImage(svg, rendered.css, width, Math.round(rect.h));
      ctx.fillStyle = rendered.look === 'dark' ? '#14181d' : '#ffffff';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.drawImage(img, rect.x + Math.max(0, (rect.w - width) / 2), rect.y, width, Math.round(rect.h));
      return true;
    },
    /**
     * The whole page's box on this screen, given the box this renderer fills -
     * what ink on a document is drawn in, so it stays on the text it was
     * drawn on (Issue #240). Uses the room's page height, the one every
     * screen shares, so a stroke lands on the same words everywhere.
     */
    pageRect(box) {
      const s = Math.min(box.w / DOC_WIDTH, box.h / DOC_VIEW) || 1;
      return {
        x: box.x + Math.max(0, (box.w - DOC_WIDTH * s) / 2),
        y: box.y - shownAt * s,
        w: DOC_WIDTH * s,
        h: height * s,
      };
    },
    destroy() {
      generation++;
      cancelAnimationFrame(glide);
      resize?.disconnect();
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
  stream: renderStream,
  web: renderWeb,
  slides: renderWeb,
  deck: renderDeck,
  document: renderDocument,
  imagedeck: renderImageDeck,
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
