// The live browser, from a page's side (see server/browser.js).
//
// A web page item can be shown two ways. Embedded, it is an <iframe>: free,
// works everywhere, plays its own sound - and is refused outright by a great
// many sites, and cannot be clicked or scrolled from the iPad. Live, the page
// runs in a real browser on the Podium server; the projector and the
// controllers are shown pictures of it, and the controller's taps, drags and
// typing are played into it. This module decides which, finds the server-side
// session, and keeps one connection per session per page however many
// previews are watching it.

import { serverInfo } from './server.js';

// --- which way to show a page --------------------------------------------------

// Sites well known to refuse being shown inside another page (X-Frame-Options
// or a CSP frame-ancestors rule). Not a complete list and not meant to be: it
// is what lets a page with no server to ask say "this one will not embed"
// instead of leaving the room looking at the browser's sad face.
const REFUSES_FRAMING = [
  'github.com', 'gitlab.com', 'bitbucket.org',
  'google.com', 'bing.com', 'duckduckgo.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'reddit.com', 'tiktok.com',
  'stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com', 'askubuntu.com',
  'amazon.com', 'paypal.com', 'live.com', 'office.com', 'microsoftonline.com',
  'chatgpt.com', 'openai.com', 'claude.ai', 'slack.com', 'discord.com',
  'instructure.com', 'nytimes.com', 'netflix.com', 'youtube.com', 'twitch.tv',
];

/** The host of a page that is known to refuse framing, or '' for one that may embed. */
export function refusesFraming(src) {
  let url;
  try { url = new URL(src); } catch { return ''; }
  const host = url.hostname.toLowerCase();
  // Embed, publish and preview links (a YouTube player, a published Google
  // Slides deck, a Maps embed, a Drive file's preview) are made to be framed;
  // it is the sites' own pages that are not.
  if (/embed/i.test(url.pathname + url.search) || (/(^|\.)google\.com$/.test(host) && /\/(pub(html)?|preview)\b/.test(url.pathname))) return '';
  const match = REFUSES_FRAMING.find((d) => host === d || host.endsWith(`.${d}`));
  return match ? host : '';
}

/**
 * Whether a link points at some other site. A path on this Podium (a page in
 * content/, say) embeds fine and is never opened in the live browser: the
 * server's browser has nobody signed in, so it would only be shown the login.
 */
export function isOtherSite(src, base = globalThis.location?.href) {
  try {
    const url = new URL(src, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return !base || url.origin !== new URL(base).origin;
  } catch { return false; }
}

/**
 * How a web page item is shown here: 'live' or 'embed'.
 *
 * `browse` on the item is the presenter's choice: 'live', 'embed', or
 * (absent, 'auto') "live whenever this server has a live browser and the page
 * is on another site". Without a live browser, everything embeds.
 */
export function browseMode(item, liveAvailable) {
  if (!liveAvailable || item?.browse === 'embed') return 'embed';
  if (item?.browse === 'live') return /^https?:/i.test(item?.src || '') || isOtherSite(item?.src || '') ? 'live' : 'embed';
  return isOtherSite(item?.src || '') ? 'live' : 'embed';
}

/** Whether this server runs a live browser. Asked once. */
let available = null;
let availableNow = null;
export function liveBrowserAvailable() {
  available ??= serverInfo()
    .then((info) => (info.features || []).includes('browser'))
    .catch(() => false)
    .then((yes) => { availableNow = yes; return yes; });
  return available;
}

/** The same answer without waiting: true, false, or null while it is still being asked. */
export function liveBrowserAvailableNow() {
  return availableNow;
}

// --- finding the session ---------------------------------------------------------
//
// Every device in a room works out the same name for a page's session from the
// room passphrase and the item's own key - so the display and the controllers
// find each other's page without a message between them, the server never
// learns the passphrase, and nobody without it can find the page. PBKDF2 at
// the same strength as the room key itself (crypto.js), so the name is no
// shortcut to guessing the passphrase.

const enc = new TextEncoder();
const secrets = new Map();

function roomSecret(room, passphrase) {
  const id = `${room}\n${passphrase}`;
  if (!secrets.has(id)) {
    secrets.set(id, (async () => {
      const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
      return new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: enc.encode(`podium|browser|v1|${room}`), iterations: 150000, hash: 'SHA-256' },
        material, 256,
      ));
    })());
  }
  return secrets.get(id);
}

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The session name for one item in one room: 43 characters, opaque. */
export async function liveSessionKey(room, passphrase, itemKey) {
  const secret = await roomSecret(String(room || ''), String(passphrase || ''));
  const joined = new Uint8Array([...secret, ...enc.encode(`|${itemKey || ''}`)]);
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', joined)));
}

// --- the connection ----------------------------------------------------------------

const connections = new Map();
const RELEASE_GRACE_MS = 3000;

function socketUrl(key) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/browser?s=${encodeURIComponent(key)}`;
}

function connectionFor(key, role) {
  const id = `${role}:${key}`;
  let conn = connections.get(id);
  if (conn) { clearTimeout(conn.releaseTimer); return conn; }
  conn = {
    id, key, role, ws: null, subs: new Set(), frame: null, state: null, view: null, home: '', lecture: 0,
    retry: 0, retryTimer: null, releaseTimer: null, closed: false, decoding: null, pendingFrame: null,
    mediaAsks: new Map(),
  };
  connections.set(id, conn);
  open(conn);
  return conn;
}

function open(conn) {
  if (conn.closed) return;
  let ws;
  try { ws = new WebSocket(socketUrl(conn.key)); } catch { scheduleRetry(conn); return; }
  ws.binaryType = 'blob';
  conn.ws = ws;
  ws.onopen = () => {
    conn.retry = 0;
    ws.send(JSON.stringify({ t: 'hello', home: conn.home, role: conn.role, lecture: conn.lecture }));
    if (conn.view) ws.send(JSON.stringify({ t: 'view', ...conn.view }));
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') { decodeFrame(conn, ev.data); return; }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === 'state') {
      conn.state = msg;
      for (const sub of conn.subs) sub.onState?.(msg);
    } else if (msg.t === 'opening') {
      for (const sub of conn.subs) sub.onOpening?.();
    } else if (msg.t === 'media') {
      conn.mediaAsks.get(msg.id)?.(msg.media || null);
      conn.mediaAsks.delete(msg.id);
    } else if (msg.t === 'error') {
      for (const sub of conn.subs) sub.onError?.(msg.message || 'The live browser stopped.');
    }
  };
  ws.onclose = () => {
    if (conn.ws !== ws) return;
    conn.ws = null;
    if (!conn.closed && conn.subs.size) scheduleRetry(conn);
  };
}

function scheduleRetry(conn) {
  clearTimeout(conn.retryTimer);
  const wait = Math.min(15000, 1000 * 2 ** conn.retry);
  conn.retry += 1;
  conn.retryTimer = setTimeout(() => open(conn), wait);
}

// Pictures arrive faster than a slow device can decode them while a page
// scrolls; only the newest one waiting is ever decoded, the rest are dropped.
function decodeFrame(conn, blob) {
  if (conn.decoding) { conn.pendingFrame = blob; return; }
  conn.decoding = createImageBitmap(blob).then((bitmap) => {
    if (conn.closed) { bitmap.close?.(); return; }
    const old = conn.frame;
    conn.frame = bitmap;
    for (const sub of conn.subs) sub.onFrame?.(bitmap);
    old?.close?.();
  }).catch(() => { /* a truncated picture: the next one will do */ }).finally(() => {
    conn.decoding = null;
    const next = conn.pendingFrame;
    conn.pendingFrame = null;
    if (next) decodeFrame(conn, next);
  });
}

function send(conn, msg) {
  if (conn.ws?.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(msg));
}

/**
 * Watch (and drive) one page's session.
 *
 * `key` may be a promise - working it out takes a moment. Handlers get the
 * newest picture (an ImageBitmap, drawn by the caller and not kept: it is
 * closed when the next one arrives), the page's state, and any error.
 * `role` 'display' is the screen the room sees: its panel decides the page's
 * shape (see setView). Everything else is a controller. `lecture` is the
 * server's lecture it is opened in, if any.
 */
export function watchLiveBrowser({ key, home = '', role = 'control', lecture = 0, onFrame, onState, onError, onOpening }) {
  const sub = { onFrame, onState, onError, onOpening };
  let conn = null;
  let released = false;
  const queued = [];
  Promise.resolve(key).then((k) => {
    if (released || !k) return;
    conn = connectionFor(k, role === 'display' ? 'display' : 'control');
    if (home && !conn.home) conn.home = home;
    // The lecture it opens in: a course that keeps its live pages' sign-ins
    // (server/courses.js) starts the page with them.
    if (lecture && !conn.lecture) conn.lecture = lecture;
    conn.subs.add(sub);
    if (conn.state) onState?.(conn.state);
    if (conn.frame) onFrame?.(conn.frame);
    for (const msg of queued.splice(0)) handle.send(msg);
  });
  const handle = {
    /** Navigate, click, scroll, type: see handleClientMessage in server/browser.js. */
    send(msg) {
      if (!conn) { queued.push(msg); return; }
      if (msg.t === 'view') conn.view = { w: msg.w, h: msg.h, scale: msg.scale };
      send(conn, msg);
    },
    /**
     * Where the page's video is: { time, duration, paused }, or null when it
     * has none (or the server did not answer). `pause` stops it there too.
     */
    askMedia({ pause = false } = {}) {
      if (!conn || conn.ws?.readyState !== WebSocket.OPEN) return Promise.resolve(null);
      const id = Math.random().toString(36).slice(2, 10);
      return new Promise((resolve) => {
        const timer = setTimeout(() => { conn.mediaAsks.delete(id); resolve(null); }, 4000);
        conn.mediaAsks.set(id, (media) => { clearTimeout(timer); resolve(media); });
        send(conn, { t: 'media', id, pause });
      });
    },
    get state() { return conn?.state || null; },
    get frame() { return conn?.frame || null; },
    release() {
      if (released) return;
      released = true;
      if (!conn) return;
      conn.subs.delete(sub);
      if (conn.subs.size) return;
      // A preview being remounted (a TAKE, a tab switch) is back within a
      // moment; closing and reopening the socket for that would only flicker.
      const c = conn;
      c.releaseTimer = setTimeout(() => {
        if (c.subs.size) return;
        c.closed = true;
        clearTimeout(c.retryTimer);
        connections.delete(c.id);
        try { c.ws?.close(); } catch { /* already closing */ }
        c.frame?.close?.();
        c.frame = null;
      }, RELEASE_GRACE_MS);
    },
  };
  return handle;
}

/**
 * What a page hands its renderers as `liveBrowser` (see renderWebItem in
 * renderers.js). `getCfg` is read each time, so a room changed in Settings
 * finds its own sessions.
 */
export function liveBrowserOptions(getCfg, role, getLecture = () => 0) {
  return {
    role,
    lecture: () => Number(getLecture()) || 0,
    availableNow: liveBrowserAvailableNow,
    available: liveBrowserAvailable(),
    keyFor: (item) => {
      const cfg = getCfg();
      return liveSessionKey(cfg.room, cfg.passphrase, item?.liveId || item?.key || item?.src || '');
    },
  };
}
