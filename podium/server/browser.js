// The live browser - a real web browser, on this server, that the projector
// shows and the controller drives.
//
// Why it exists: a web page item is an <iframe>, and most of the sites a
// lecture actually wants (GitHub, Google, a news site, a journal) send
// X-Frame-Options or a CSP frame-ancestors rule that forbids exactly that. The
// browser obeys, and the projector shows its "refused to connect" face. There
// is no way around that from inside a page, and there should not be. And even
// a page that does embed cannot be clicked, scrolled or typed into from the
// iPad, because a cross-origin frame is sealed off from the page holding it.
//
// So the page is opened here instead, in a headless Chromium, as a top-level
// tab of its own - nothing is being framed, so nothing refuses. What it draws
// is sent as pictures to whoever is watching (the display, and the controllers
// in the room), and what the controller does - a tap, a drag, a word typed, a
// link followed, Back - is sent here and played into the tab as if a mouse and
// keyboard were attached to it.
//
// One Chromium process, started the first time somebody needs it, holds every
// open page. Each page is a session, in an incognito-style context of its own
// (its own cookies, its own storage) so that one lecture's sign-in can never
// leak into another's. A session is named by a key the devices in a room work
// out from their room passphrase and the item's own key (see
// assets/js/live-browser.js): this process never sees the passphrase, and only
// a device that holds it can find the session.
//
// The one honest caveat, stated where it is decided: this is the one part of
// Podium where the server necessarily sees what is on screen - it is the thing
// drawing it. Nothing is written to disk beyond Chromium's own throwaway
// profile, which is removed when the process ends.
//
// It talks to Chromium over the DevTools protocol, on the `ws` package the
// relay already depends on: no Puppeteer, no Playwright, nothing new to
// install beyond a Chromium binary, which is optional - without one, a web
// page item stays an embedded frame, exactly as before.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns');
const net = require('node:net');

// Loaded when a live browser is actually made, not when this file is: the
// doctor (podium-admin) reads findBrowser from here, and like its own relay
// check it should not need the relay's dependency just to say what it found.
const ws = () => require('ws');
const OPEN = 1;   // OPEN

// --- finding a browser -------------------------------------------------------

// Where Chromium tends to live. BROWSER_PATH wins over all of these; the rest
// are tried in order, on PATH and as absolute paths.
const CANDIDATES = [
  'chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'chrome',
  '/snap/bin/chromium',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

/** The Chromium to run, or null. Asked once at startup; see LIVE_BROWSER. */
function findBrowser(env = process.env) {
  if (env.BROWSER_PATH) return executable(env.BROWSER_PATH) ? env.BROWSER_PATH : null;
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of CANDIDATES) {
    if (path.isAbsolute(name)) { if (executable(name)) return name; continue; }
    for (const dir of dirs) {
      const file = path.join(dir, name);
      if (executable(file)) return file;
    }
  }
  return null;
}

// --- what a session may reach ------------------------------------------------
//
// A browser running on the server can reach whatever the server can: this
// process on 127.0.0.1, a cloud provider's metadata address, the machine
// room's switches. Somebody signed in to Podium has no business browsing any
// of that, so requests to a loopback, private, link-local or otherwise
// non-public address are refused unless BROWSER_ALLOW_PRIVATE says this
// deployment is on a campus network whose intranet is the point.

/** Whether an IP address (v4 or v6, as text) is anything but the public internet. */
function isPrivateAddress(address) {
  let ip = String(address || '').trim().replace(/^\[|\]$/g, '');
  if (!ip) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)      // carrier-grade NAT
      || (a === 169 && b === 254)                // link-local, and cloud metadata
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)                  // IETF protocol assignments
      || (a === 198 && (b === 18 || b === 19))   // benchmarking
      || a >= 224;                               // multicast and reserved
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::' || lower === '::1'
      || /^f[cd]/.test(lower)                    // unique local
      || /^fe[89ab]/.test(lower)                 // link-local
      || /^ff/.test(lower);                      // multicast
  }
  return true;   // not an address at all: refuse rather than guess
}

/**
 * What the address bar means: a URL to open, or null for one that may not be.
 *
 * Forgiving the way a browser's own address bar is - "github.com/jonwestfall"
 * is a web address, and "photosynthesis diagram" is a search - and strict
 * about the only part that matters: nothing but http and https is ever opened,
 * so no file:, no chrome:, no javascript:.
 */
function addressToUrl(input, searchUrl = 'https://duckduckgo.com/?q=') {
  const text = String(input || '').trim().slice(0, 2000);
  if (!text) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^\s/:]+:\d+(\/|$)/.test(text)) {
    try {
      const url = new URL(text);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
  }
  // Something with a dot and no spaces (or localhost) is a site; anything else
  // is a question.
  const looksLikeHost = !/\s/.test(text) && (/^[^/?#]+\.[^/?#]+/.test(text) || /^localhost(:\d+)?(\/|$)/i.test(text));
  if (looksLikeHost) {
    try { return new URL(`https://${text}`).href; } catch { /* fall through to a search */ }
  }
  return `${searchUrl}${encodeURIComponent(text)}`;
}

/**
 * A name's addresses: the system's own lookup first (getaddrinfo, as every
 * program on the box resolves names), then - if that fails - the DNS servers
 * in /etc/resolv.conf asked directly. getaddrinfo goes through the system's
 * name-service modules, and those can depend on things a service's sandbox
 * does not give it (systemd-resolved's socket, say), failing with EAI_AGAIN
 * for every name while the DNS servers themselves would answer. Both reasons
 * are kept when both fail: together they say where the problem is.
 */
async function systemThenDirect(host, opts, {
  system = dns.promises.lookup,
  makeResolver = () => new dns.promises.Resolver({ timeout: 3000, tries: 2 }),
} = {}) {
  try {
    return await system(host, opts);
  } catch (systemErr) {
    const resolver = makeResolver();
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    const found = [...(v4.value || []), ...(v6.value || [])];
    if (found.length) return found.map((address) => ({ address }));
    const direct = v4.reason?.code || v6.reason?.code || 'no answer';
    throw Object.assign(new Error(`${systemErr.code || systemErr.message}; asking its DNS servers directly: ${direct}`),
      { code: `${systemErr.code || 'lookup failed'}; asking its DNS servers directly: ${direct}`, cause: systemErr });
  }
}

/**
 * Where `host` may be reached: { addresses } - every public address it has,
 * in the order its resolver gave them - or { problem, detail } saying why
 * not. A name with any private address is refused outright, not raced: a
 * name that answers with both is exactly the trick.
 */
async function lookupPublic(host, { isBlocked = isPrivateAddress, lookup = systemThenDirect } = {}) {
  const bare = String(host || '').replace(/^\[|\]$/g, '');
  if (!bare) return { problem: 'name', detail: 'no address was given' };
  if (net.isIP(bare)) {
    return isBlocked(bare) ? { problem: 'private', detail: `${bare} is a private or reserved address` } : { addresses: [bare] };
  }
  if (/^localhost$/i.test(bare) || /\.(localhost|local|internal|lan|home\.arpa)$/i.test(bare)) {
    return { problem: 'private', detail: `${bare} is a name on this network` };
  }
  let found;
  try {
    found = await lookup(bare, { all: true, verbatim: true });
  } catch (err) {
    return { problem: 'unresolved', detail: `this server could not look ${bare} up (${err.code || err.message})` };
  }
  if (!found.length) return { problem: 'unresolved', detail: `this server could not look ${bare} up (no addresses)` };
  const blocked = found.find((a) => isBlocked(a.address));
  if (blocked) {
    return { problem: 'private', detail: `${bare} resolves to ${blocked.address}, which is a private or reserved address` };
  }
  return { addresses: found.map((a) => a.address) };
}

/** The first public address for `host`, or null. */
async function publicAddress(host, opts) {
  return (await lookupPublic(host, opts)).addresses?.[0] || null;
}

const CONNECT_TIMEOUT_MS = 10 * 1000;

/** A socket to the first of `addresses` that answers on `port`. Throws with each one's reason. */
function connectFirst(addresses, port) {
  return new Promise((resolve, reject) => {
    const failures = [];
    const attempt = (i) => {
      if (i >= addresses.length) { reject(new Error(failures.join(', '))); return; }
      const socket = net.connect({ host: addresses[i], port });
      const timer = setTimeout(() => socket.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), CONNECT_TIMEOUT_MS);
      socket.once('connect', () => { clearTimeout(timer); socket.removeAllListeners('error'); resolve(socket); });
      socket.once('error', (err) => {
        clearTimeout(timer);
        failures.push(`${addresses[i]}: ${err.code || err.message}`);
        attempt(i + 1);
      });
    };
    attempt(0);
  });
}

/**
 * A tunnel to host:port through another proxy - for a network that only
 * reaches the internet through one (BROWSER_UPSTREAM_PROXY). The address rule
 * is still checked here first; the upstream proxy then does the connecting.
 */
function tunnelVia(upstream, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: upstream.hostname, port: Number(upstream.port) || 80 });
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })), CONNECT_TIMEOUT_MS);
    const auth = upstream.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString('base64')}\r\n`
      : '';
    let reply = Buffer.alloc(0);
    const onData = (chunk) => {
      reply = Buffer.concat([reply, chunk]);
      const end = reply.indexOf('\r\n\r\n');
      if (end === -1) { if (reply.length > 16 * 1024) socket.destroy(new Error('the proxy said too much')); return; }
      clearTimeout(timer);
      socket.off('data', onData);
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(reply.toString('latin1'))?.[1];
      if (status !== '200') { socket.destroy(); reject(new Error(`the upstream proxy answered ${status || 'something else'}`)); return; }
      const rest = reply.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on('data', onData);
    socket.once('connect', () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`));
    socket.once('error', (err) => { clearTimeout(timer); reject(new Error(`the upstream proxy ${upstream.host}: ${err.code || err.message}`)); });
  });
}

/**
 * The private-address rule, enforced: a small HTTP proxy on 127.0.0.1 that
 * every connection Chromium makes goes through - pages, images, scripts,
 * iframes in their own process, workers, service workers, WebSockets. It
 * resolves the name itself, refuses anything that is not public, and then
 * connects to the very addresses it checked, so a name cannot answer "public"
 * to the check and "private" to the connection a moment later.
 *
 * Every connection it does not make is reported to `onProblem` - whether the
 * name would not resolve, resolved to a private address, or could not be
 * reached - since otherwise all the person at the controller sees is
 * Chromium's ERR_TUNNEL_CONNECTION_FAILED. `problemFor(host)` is the latest.
 */
function createGuardProxy({ isBlocked = isPrivateAddress, lookup = systemThenDirect, upstream = '', onProblem = () => {} } = {}) {
  const via = upstream ? new URL(/^[a-z]+:\/\//i.test(upstream) ? upstream : `http://${upstream}`) : null;
  const problems = new Map();   // host -> { message, at }
  const REFUSED = 'Podium’s live browser does not open addresses on private networks.';
  const report = (host, port, message) => {
    problems.set(host.toLowerCase(), { message, at: Date.now() });
    if (problems.size > 500) problems.delete(problems.keys().next().value);
    onProblem(host, port, message);
  };

  /** A socket to host:port, or a thrown { refused, message }. */
  async function open(host, port) {
    const found = await lookupPublic(host, { isBlocked, lookup });
    // With an upstream proxy, a name this server cannot look up itself may
    // still be one the proxy can: that is often how such networks work.
    if (found.problem && !(via && found.problem === 'unresolved')) {
      report(host, port, `${found.detail}${found.problem === 'private' ? ' (BROWSER_ALLOW_PRIVATE=1 lets pages reach those)' : ''}`);
      throw Object.assign(new Error(found.detail), { refused: found.problem === 'private' });
    }
    try {
      return via ? await tunnelVia(via, host, port) : await connectFirst(found.addresses, port);
    } catch (err) {
      const message = via
        ? `${host}:${port} could not be reached through ${via.host} (${err.message})`
        : `${host}:${port} could not be reached from this server (${err.message}) - is outgoing traffic blocked, or does this network need a proxy? (BROWSER_UPSTREAM_PROXY)`;
      report(host, port, message);
      throw new Error(message, { cause: err });
    }
  }

  const server = http.createServer((req, res) => {
    // Plain http: the request line carries the whole address. Sent over a
    // socket of our own, so it goes only where open() said it may.
    let url;
    try { url = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    if (url.protocol !== 'http:') { res.writeHead(400); res.end(); return; }
    const port = Number(url.port) || 80;
    open(url.hostname, port).then((socket) => {
      const headers = { ...req.headers, host: url.host };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      const upstreamReq = http.request({
        createConnection: () => socket, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false,
      }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      upstreamReq.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstreamReq);
    }, (err) => {
      res.writeHead(err.refused ? 403 : 502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(err.refused ? REFUSED : err.message);
    });
  });
  // https and WebSockets: a tunnel to host:port, opened only to a public address.
  server.on('connect', (req, client, head) => {
    const at = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url || '');
    if (!at) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    client.on('error', () => {});
    open(at[1], Number(at[2])).then((upstreamSocket) => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(client);
      client.pipe(upstreamSocket);
      upstreamSocket.on('error', () => client.destroy());
      client.on('close', () => upstreamSocket.destroy());
    }, (err) => {
      client.end(err.refused
        ? `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${REFUSED}`
        : `HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/plain\r\n\r\n${err.message}`);
    });
  });
  server.on('clientError', (err, socket) => socket.destroy());
  let listening = null;
  return {
    /** Start it (once): the port it listens on, on 127.0.0.1. */
    listen: () => (listening ??= new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => ok(server.address().port));
    })),
    /** Open a connection the way a page would, for a check (see probeReach). */
    open,
    /** Why `host` was last not opened, if that was in the last minute. */
    problemFor(host) {
      const found = problems.get(String(host || '').toLowerCase());
      return found && found.at > Date.now() - 60 * 1000 ? found.message : '';
    },
    close: () => { try { server.close(); } catch { /* not listening */ } server.closeAllConnections?.(); },
  };
}

/**
 * Can a live page reach `host` from this server - through the same guard,
 * and the same upstream proxy if there is one? For podium-admin doctor.
 */
async function probeReach({ host = 'github.com', port = 443, allowPrivate = false, upstream = '', lookup } = {}) {
  const guard = createGuardProxy({ isBlocked: allowPrivate ? () => false : isPrivateAddress, upstream, lookup });
  try {
    const socket = await guard.open(host, port);
    socket.destroy();
    return { ok: true, detail: `${host}:${port} is reachable${upstream ? ` through ${upstream}` : ''}` };
  } catch (err) {
    return { ok: false, detail: err.message };
  } finally {
    guard.close();
  }
}

// --- keys ----------------------------------------------------------------------
//
// The handful of keys a controller sends by name. Text goes as text (see
// 'text' below); these are the ones that are not text.
const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  End: { code: 'End', keyCode: 35 },
  Home: { code: 'Home', keyCode: 36 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Delete: { code: 'Delete', keyCode: 46 },
};

// --- the shape of the picture ------------------------------------------------
//
// The display says how big its panel is, in CSS pixels, and how many device
// pixels it has per CSS pixel. The page is laid out at that size divided by
// the zoom - so 150% zoom is a narrower page drawn bigger, exactly what Ctrl +
// does in a desktop browser - and pictures come back at the panel's own pixel
// size, capped so a 4K projector does not cost four times the bandwidth for
// text nobody in the room can tell apart.

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const MAX_FRAME_W = 1920;
const MAX_FRAME_H = 1200;

const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

function viewFrom(raw) {
  const w = Math.round(clamp(raw?.w, 320, 3840, 1280));
  const h = Math.round(clamp(raw?.h, 200, 2160, 720));
  let scale = clamp(raw?.scale, 0.5, 2, 1.5);
  scale = Math.min(scale, MAX_FRAME_W / w, MAX_FRAME_H / h);
  return { w, h, scale };
}

/** The tab's own metrics, and the most pixels a frame should carry, for a view and a zoom. */
function metricsFor(view, zoom) {
  const z = clamp(zoom, ZOOM_MIN, ZOOM_MAX, 1);
  return {
    width: Math.max(160, Math.round(view.w / z)),
    height: Math.max(100, Math.round(view.h / z)),
    deviceScaleFactor: view.scale * z,
    frameW: Math.round(view.w * view.scale),
    frameH: Math.round(view.h * view.scale),
  };
}

// --- talking to Chromium -----------------------------------------------------

/** A DevTools protocol connection, flattened: one socket for every tab. */
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new (ws())(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    let next = 1;
    const pending = new Map();
    const listeners = new Set();
    socket.on('open', () => resolve(cdp));
    socket.on('error', (err) => reject(err));
    socket.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: fail, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(`${method}: ${msg.error.message}`));
        else ok(msg.result || {});
        return;
      }
      if (msg.method) for (const fn of listeners) fn(msg.method, msg.params || {}, msg.sessionId || null);
    });
    socket.on('close', () => {
      for (const { reject: fail, method } of pending.values()) fail(new Error(`${method}: the browser went away`));
      pending.clear();
      for (const fn of listeners) fn('podium.closed', {}, null);
    });
    const cdp = {
      send(method, params = {}, sessionId) {
        if (socket.readyState !== OPEN) return Promise.reject(new Error(`${method}: the browser is not running`));
        const id = next++;
        return new Promise((ok, fail) => {
          pending.set(id, { resolve: ok, reject: fail, method });
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      close() { try { socket.close(); } catch { /* already closing */ } },
    };
  });
}

// --- the manager ---------------------------------------------------------------

const SESSION_KEY_RE = /^[A-Za-z0-9_-]{32,64}$/;
// What a device sends that is played into the page as input.
const INPUT_MESSAGES = new Set(['move', 'click', 'scroll', 'key', 'text']);
// A browser's very first start on a machine (its profile, fonts and caches
// all cold) can take tens of seconds - on a freshly installed server, the
// first web page anyone opens. Every start after that takes about one.
const LAUNCH_TIMEOUT_MS = 90 * 1000;
// Every connected device has its own send buffer; a phone on bad Wi-Fi that
// falls behind skips pictures rather than queueing a minute of them.
const MAX_BUFFERED = 2 * 1024 * 1024;
const MAX_CLIENT_MESSAGE = 16 * 1024;
const MAX_CLIENTS_PER_SESSION = 16;

/**
 * @param {object} opts
 * @param {string|null} opts.executable  Chromium to run, or null for none
 * @param {boolean} [opts.allowPrivate]  let pages reach private addresses
 * @param {number} [opts.maxSessions]    open pages at once, across the server
 * @param {number} [opts.idleMs]         how long a page nobody is watching stays open
 * @param {string} [opts.searchUrl]      where words typed in the address bar go
 * @param {string} [opts.extraArgs]      more Chromium switches, space-separated
 * @param {string} [opts.upstreamProxy]  http://host:port this network reaches the internet through
 * @param {boolean} [opts.sandbox]       false to run Chromium without its sandbox
 * @param {(ip: string) => boolean} [opts.isBlocked]  which addresses are private (tests)
 * @param {(msg: string) => void} [opts.log]
 */
function createLiveBrowser(opts = {}) {
  const exe = opts.executable || null;
  const allowPrivate = !!opts.allowPrivate;
  const maxSessions = Math.max(1, Number(opts.maxSessions) || 4);
  const idleMs = Math.max(5000, Number(opts.idleMs) || 10 * 60 * 1000);
  const searchUrl = opts.searchUrl || 'https://duckduckgo.com/?q=';
  const extraArgs = String(opts.extraArgs || '').split(/\s+/).filter(Boolean);
  const upstreamProxy = String(opts.upstreamProxy || '').trim();
  const sandbox = opts.sandbox !== false;
  // Which addresses count as private: isPrivateAddress, except in a test that
  // needs a "public" site on this machine.
  const isBlocked = opts.isBlocked || isPrivateAddress;
  const log = opts.log || ((msg) => console.log(`podium: ${msg}`));
  const wss = new (ws().Server)({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE });

  let proc = null;
  let profileDir = null;
  let cdpPromise = null;
  let closing = false;
  const sessions = new Map();       // key -> session
  const byTarget = new Map();       // targetId -> session
  const byCdpSession = new Map();   // CDP sessionId -> session
  // The private-address rule (see createGuardProxy), unless private
  // addresses are allowed or the deployment routes Chromium through a proxy
  // of its own (BROWSER_ARGS --proxy-server), which then decides.
  const guarded = !allowPrivate && !extraArgs.some((a) => a.startsWith('--proxy-server'));
  let guard = null;

  // --- the browser process ---------------------------------------------------

  // What the guard would not open, in the service's log - once a minute per
  // host, since one page can ask for the same blocked thing many times over.
  const problemLogged = new Map();
  function logProblem(host, port, message) {
    const key = `${host}:${port}`;
    if ((problemLogged.get(key) || 0) > Date.now() - 60 * 1000) return;
    if (problemLogged.size > 500) problemLogged.clear();
    problemLogged.set(key, Date.now());
    log(`live browser: did not open ${key} - ${message}`);
  }

  /** Why the guard did not open a page's address, for the controller to show. */
  function whyNot(url) {
    let host;
    try { host = new URL(url).hostname; } catch { return ''; }
    return guard?.problemFor(host) || '';
  }

  async function launch() {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-browser-'));
    let proxyArgs = [];
    if (guarded) {
      guard ??= createGuardProxy({ isBlocked, upstream: upstreamProxy, onProblem: logProblem });
      const port = await guard.listen();
      proxyArgs = [
        `--proxy-server=http://127.0.0.1:${port}`,
        // Even loopback goes through it: Chromium would otherwise go straight there.
        '--proxy-bypass-list=<-loopback>',
        // WebRTC's own UDP would go around any proxy.
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ];
    }
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--no-pings',
      '--disable-extensions', '--disable-sync', '--disable-default-apps',
      '--disable-background-networking', '--disable-component-update',
      '--disable-dev-shm-usage',
      // Chrome's own calls home - updates, safe-browsing lists, model
      // downloads, field trials - which nobody in the room asked for, and
      // which otherwise fill the log with addresses no page wanted.
      '--disable-features=Translate,MediaRouter,OptimizationHints,OptimizationGuideModelDownloading,OptimizationHintsFetching,AutofillServerCommunication,CertificateTransparencyComponentUpdater',
      '--disable-client-side-phishing-detection', '--disable-domain-reliability',
      '--disable-field-trial-config', '--metrics-recording-only',
      '--password-store=basic', '--use-mock-keychain',
      // Nobody in the room hears this browser - sound comes from Podium's own
      // video and audio items, which the mixer controls.
      '--mute-audio',
      '--hide-crash-restore-bubble',
      // BROWSER_ARGS: a deployment's own needs, such as an outbound proxy
      // (--proxy-server=...). Split on spaces; nothing here is quoted.
      ...proxyArgs,
      ...extraArgs,
      'about:blank',
    ];
    // Chromium's sandbox is what keeps a hostile page inside its tab, and it
    // stays on unless somebody says otherwise: BROWSER_SANDBOX=off, for a box
    // whose kernel will not give an unprivileged user one (Ubuntu 24.04's
    // AppArmor rules do that to a Chromium that is not the snap or Google's
    // own package). Chromium also refuses to start it as root - a developer
    // running this by hand as root gets a working browser and a line in the
    // log saying what that cost.
    if (!sandbox || process.getuid?.() === 0) {
      args.unshift('--no-sandbox');
      log(`live browser: Chromium runs without its sandbox (${sandbox ? 'running as root' : 'BROWSER_SANDBOX=off'})`);
    }
    return new Promise((resolve, reject) => {
      // Its home is its own throwaway profile: the service's unit hides /home
      // (ProtectHome) and makes most of the disk read-only, and Chromium
      // writes caches and a certificate store under HOME whatever it is told.
      const home = { HOME: profileDir, XDG_CONFIG_HOME: profileDir, XDG_CACHE_HOME: profileDir };
      const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...home } });
      proc = child;
      let seen = '';
      let tail = '';
      // What Chromium said before it gave up, for the log: "No usable
      // sandbox!" is the one an operator most needs to read.
      const why = () => tail.split('\n').map((l) => l.trim()).filter((l) => l && !/dbus|Fontconfig/i.test(l)).slice(-3).join(' | ');
      const timer = setTimeout(() => {
        reject(new Error(`Chromium did not start within ${LAUNCH_TIMEOUT_MS / 1000} seconds`));
        child.kill('SIGKILL');
      }, LAUNCH_TIMEOUT_MS);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        tail = (tail + chunk).slice(-4096);
        if (seen === null) return;
        seen += chunk;
        const found = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
        if (found) { clearTimeout(timer); seen = null; resolve(found[1]); }
        else if (seen.length > 64 * 1024) seen = seen.slice(-4096);
      });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (proc === child) proc = null;
        reject(new Error(`Chromium exited (${signal || code})${why() ? `: ${why()}` : ''}`));
        if (!closing) log(`live browser: Chromium stopped (${signal || `exit ${code}`}); it starts again when a page is next opened`);
        dropEverything('The live browser stopped. Opening the page again…');
        removeProfile();
      });
    });
  }

  function removeProfile() {
    if (!profileDir) return;
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* the OS cleans tmp eventually */ }
    profileDir = null;
  }

  function browser() {
    if (!exe) return Promise.reject(new Error('There is no Chromium on this server.'));
    cdpPromise ??= (async () => {
      const wsUrl = await launch();
      const cdp = await connectCdp(wsUrl);
      cdp.on(onEvent);
      // New tabs a page opens (target=_blank, window.open) are noticed here and
      // folded back into the session's own tab: the room is watching one tab.
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      log(`live browser: Chromium started (${path.basename(exe)})`);
      return cdp;
    })().catch((err) => {
      cdpPromise = null;
      log(`live browser: Chromium would not start (${err.message})`);
      throw err;
    });
    return cdpPromise;
  }

  /** Every session ends, and every device watching one is told why. */
  function dropEverything(reason) {
    cdpPromise = null;
    for (const session of [...sessions.values()]) {
      for (const client of session.clients) {
        sendJson(client, { t: 'error', message: reason, retry: true });
        try { client.close(1011, 'browser stopped'); } catch { /* already gone */ }
      }
      forget(session);
    }
  }

  // --- reaching an address ---------------------------------------------------

  // Asked before opening an address, to say plainly why one will not open;
  // the guard proxy is what actually stops it (and everything the page then
  // asks for). A name that does not resolve is let through to fail in
  // Chromium with its own error page.
  async function urlAllowed(raw) {
    let url;
    try { url = new URL(raw); } catch { return false; }
    if (!/^https?:$/.test(url.protocol)) return false;
    if (allowPrivate) return true;
    const bare = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bare) || /^localhost$/i.test(bare) || /\.(localhost|local|internal|lan|home\.arpa)$/i.test(bare)) {
      return !!(await publicAddress(bare, { isBlocked }));
    }
    try {
      const addresses = await systemThenDirect(bare, { all: true, verbatim: true });
      return addresses.every((a) => !isBlocked(a.address));
    } catch { return true; }
  }

  // --- sessions ----------------------------------------------------------------

  function sendJson(client, msg) {
    if (client.readyState === OPEN) {
      try { client.send(JSON.stringify(msg)); } catch { /* closing */ }
    }
  }

  function stateOf(session) {
    return {
      t: 'state',
      url: session.url, title: session.title, loading: session.loading,
      canBack: session.canBack, canForward: session.canForward,
      zoom: session.zoom, home: session.home,
      aspect: session.view.w / session.view.h,
      error: session.error || '',
    };
  }

  function broadcastState(session) {
    const msg = stateOf(session);
    session.lastSaid = JSON.stringify(msg);
    for (const client of session.clients) sendJson(client, msg);
  }

  function forget(session) {
    clearTimeout(session.idleTimer);
    clearTimeout(session.refreshTimer);
    if (sessions.get(session.key) === session) sessions.delete(session.key);
    if (session.targetId) byTarget.delete(session.targetId);
    if (session.cdpSession) byCdpSession.delete(session.cdpSession);
  }

  async function closeSession(session) {
    if (sessions.get(session.key) !== session && !session.contextId) return;
    forget(session);
    for (const client of session.clients) { try { client.close(1000, 'closed'); } catch { /* gone */ } }
    const cdp = await cdpPromise?.catch(() => null);
    if (cdp && session.contextId) {
      await cdp.send('Target.disposeBrowserContext', { browserContextId: session.contextId }).catch(() => {});
    }
    // The last page closed: Chromium itself goes too, so a server that showed
    // one web page on Monday is not holding a browser's memory until Friday.
    if (!sessions.size && !closing) shutdownBrowser();
  }

  function shutdownBrowser() {
    const cdp = cdpPromise;
    cdpPromise = null;
    cdp?.then((c) => c.close()).catch(() => {});
    if (proc) { try { proc.kill('SIGTERM'); } catch { /* already gone */ } }
  }

  function apply(session, method, params = {}) {
    if (!session.cdp) return Promise.reject(new Error(`${method}: the page is not open yet`));
    return session.cdp.send(method, params, session.cdpSession);
  }

  // A session is in the map from the moment it is asked for, with a promise
  // of its tab: the projector and a controller's preview ask for the same
  // page at the same instant when it is first put up, and both must end up
  // in the one tab rather than each opening their own.
  function createSession(key, home) {
    const session = {
      key, cdp: null, home, url: '', title: '', loading: true, canBack: false, canForward: false,
      zoom: 1, view: viewFrom(null), error: '', lastSaid: '',
      clients: new Set(), lastFrame: null, screencasting: false, idleTimer: null, refreshTimer: null,
      lastSeen: Date.now(), contextId: null, targetId: null, cdpSession: null, ready: null,
    };
    sessions.set(key, session);
    session.ready = (async () => {
      // Over the limit: the page nobody has watched for longest makes room.
      if (sessions.size > maxSessions) {
        const idle = [...sessions.values()]
          .filter((s) => s !== session && !s.clients.size && s.cdp)
          .sort((a, b) => a.lastSeen - b.lastSeen)[0];
        if (!idle) throw Object.assign(new Error(`The live browser already has ${maxSessions} pages open, which is as many as this server allows. Close one, or ask an administrator to raise BROWSER_MAX_SESSIONS.`), { busy: true });
        await closeSession(idle);
      }
      const cdp = await browser();
      session.cdp = cdp;
      const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
      session.contextId = browserContextId;
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
      session.targetId = targetId;
      byTarget.set(targetId, session);
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      session.cdpSession = sessionId;
      byCdpSession.set(sessionId, session);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId }).catch(() => {});
      await apply(session, 'Page.enable');
      await apply(session, 'Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
      await applyView(session);
      if (home) await navigate(session, home);
      return session;
    })().catch(async (err) => {
      await closeSession(session);
      throw err;
    });
    return session;
  }

  async function applyView(session) {
    const m = metricsFor(session.view, session.zoom);
    await apply(session, 'Emulation.setDeviceMetricsOverride', {
      width: m.width, height: m.height, deviceScaleFactor: m.deviceScaleFactor, mobile: false,
      screenWidth: m.width, screenHeight: m.height,
    });
    if (session.clients.size) await startScreencast(session, true);
  }

  async function startScreencast(session, restart = false) {
    const m = metricsFor(session.view, session.zoom);
    if (session.screencasting && !restart) return;
    if (session.screencasting) await apply(session, 'Page.stopScreencast').catch(() => {});
    session.screencasting = true;
    await apply(session, 'Page.startScreencast', {
      format: 'jpeg', quality: 72, maxWidth: m.frameW, maxHeight: m.frameH, everyNthFrame: 1,
    }).catch(() => { session.screencasting = false; });
  }

  async function stopScreencast(session) {
    if (!session.screencasting) return;
    session.screencasting = false;
    await apply(session, 'Page.stopScreencast').catch(() => {});
  }

  async function navigate(session, url) {
    if (!(await urlAllowed(url))) {
      session.error = 'That address is on a private network, which the live browser does not open.';
      broadcastState(session);
      return;
    }
    session.error = '';
    session.loading = true;
    broadcastState(session);
    const result = await apply(session, 'Page.navigate', { url }).catch((err) => ({ errorText: err.message }));
    if (result.errorText && result.errorText !== 'net::ERR_ABORTED') {
      // Chromium only knows the tunnel failed; the guard knows why.
      const why = whyNot(url);
      session.error = why ? `That page did not open: ${why}.` : `That page did not open (${result.errorText}).`;
      if (!why) log(`live browser: ${url} did not open (${result.errorText})`);
      session.loading = false;
      broadcastState(session);
    }
  }

  async function refreshHistory(session) {
    try {
      const { currentIndex, entries } = await apply(session, 'Page.getNavigationHistory');
      // The blank tab every session starts from is not somewhere to go Back to.
      const first = entries.findIndex((e) => e.url && e.url !== 'about:blank');
      session.canBack = first >= 0 && currentIndex > first;
      session.canForward = currentIndex < entries.length - 1;
      const entry = entries[currentIndex];
      if (entry) {
        if (entry.url && entry.url !== 'about:blank' && !entry.url.startsWith('chrome-error:')) session.url = entry.url;
        session.title = entry.title || session.title;
      }
    } catch { /* the tab is going away */ }
    // Said only when something a device shows has changed: this runs after
    // every tap and scroll.
    const said = JSON.stringify(stateOf(session));
    if (said === session.lastSaid) return;
    broadcastState(session);
  }

  async function goHistory(session, delta) {
    try {
      const { currentIndex, entries } = await apply(session, 'Page.getNavigationHistory');
      const entry = entries[currentIndex + delta];
      if (entry && entry.url !== 'about:blank') await apply(session, 'Page.navigateToHistoryEntry', { entryId: entry.id });
    } catch { /* nothing to go back to */ }
  }

  // --- what Chromium tells us --------------------------------------------------

  function onEvent(method, params, cdpSessionId) {
    if (method === 'podium.closed') return;
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      adoptPopup(params.targetInfo);
      return;
    }
    if (method === 'Target.targetDestroyed' || method === 'Target.detachedFromTarget') {
      const session = byTarget.get(params.targetId) || byCdpSession.get(params.sessionId);
      // The tab crashed or was closed out from under us: start that session
      // again from scratch the next time a device asks for it.
      if (session && session.targetId === (params.targetId || session.targetId)) {
        for (const client of session.clients) sendJson(client, { t: 'error', message: 'That page closed. Opening it again…', retry: true });
        for (const client of session.clients) { try { client.close(1011, 'page closed'); } catch { /* gone */ } }
        closeSession(session);
      }
      return;
    }
    const session = cdpSessionId ? byCdpSession.get(cdpSessionId) : null;
    if (!session) return;
    switch (method) {
      case 'Page.screencastFrame': {
        apply(session, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
        const frame = Buffer.from(params.data, 'base64');
        session.lastFrame = frame;
        for (const client of session.clients) {
          if (client.readyState === OPEN && client.bufferedAmount < MAX_BUFFERED) {
            try { client.send(frame, { binary: true }); } catch { /* closing */ }
          } else {
            client.missedFrame = true;
          }
        }
        return;
      }
      case 'Page.frameNavigated':
        if (!params.frame?.parentId) {
          // A page that failed to load is Chromium's own error page, at an
          // address of its own; the address bar keeps the one that was asked for.
          const shown = params.frame.unreachableUrl || params.frame.url;
          if (shown && shown !== 'about:blank' && !shown.startsWith('chrome-error:')) session.url = shown;
          if (!params.frame.unreachableUrl) session.error = '';
          else if (whyNot(params.frame.unreachableUrl)) session.error = `That page did not open: ${whyNot(params.frame.unreachableUrl)}.`;
          refreshHistory(session);
        }
        return;
      case 'Page.navigatedWithinDocument':
        refreshHistory(session);
        return;
      case 'Page.frameStartedLoading':
        if (params.frameId === session.targetId && !session.loading) { session.loading = true; broadcastState(session); }
        return;
      case 'Page.frameStoppedLoading':
        if (params.frameId === session.targetId) { session.loading = false; refreshHistory(session); }
        return;
      case 'Page.loadEventFired':
        session.loading = false;
        refreshHistory(session);
        return;
      // An alert, a confirm or a "leave this page?" would freeze the tab with
      // nobody to click it - answered yes, so the page carries on.
      case 'Page.javascriptDialogOpening':
        apply(session, 'Page.handleJavaScriptDialog', { accept: true, promptText: '' }).catch(() => {});
        return;
      default:
    }
  }

  function adoptPopup(info) {
    if (!info || info.type !== 'page') return;
    // A session's own tab: its title, kept current as the page changes it.
    const own = byTarget.get(info.targetId);
    if (own) {
      if (info.title && info.title !== own.title && !/^(about:blank|chrome-error:)/.test(info.title)) {
        own.title = info.title;
        broadcastState(own);
      }
      return;
    }
    if (byTarget.has(info.targetId)) return;
    const session = [...sessions.values()].find((s) => s.contextId && s.contextId === info.browserContextId);
    if (!session || !session.cdp) return;
    if (!info.url || info.url === 'about:blank') return;   // its address arrives in a moment
    byTarget.set(info.targetId, null);
    session.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    setTimeout(() => byTarget.delete(info.targetId), 5000);
    navigate(session, info.url);
  }

  // --- what a device asks for ------------------------------------------------

  // What a page does in answer to a tap or a key - a title it sets itself, a
  // hash it changes - Chromium does not always announce, so it is asked a
  // moment after each one.
  function refreshSoon(session) {
    clearTimeout(session.refreshTimer);
    session.refreshTimer = setTimeout(() => {
      if (sessions.get(session.key) === session) refreshHistory(session);
    }, 300);
  }

  async function handleClientMessage(session, client, msg) {
    session.lastSeen = Date.now();
    if (INPUT_MESSAGES.has(msg.t) && msg.t !== 'move') refreshSoon(session);
    const m = metricsFor(session.view, session.zoom);
    const at = (fx, fy) => ({ x: clamp(fx, 0, 1, 0.5) * m.width, y: clamp(fy, 0, 1, 0.5) * m.height });
    switch (msg.t) {
      case 'view': {
        // The display's panel, not a controller's preview of it: whoever is
        // showing the room the page decides its shape.
        if (client.role !== 'display') return;
        const view = viewFrom(msg);
        if (view.w === session.view.w && view.h === session.view.h && view.scale === session.view.scale) return;
        session.view = view;
        await applyView(session);
        broadcastState(session);
        return;
      }
      case 'go': {
        const url = addressToUrl(msg.url, searchUrl);
        if (!url) { session.error = 'Only web addresses (http and https) open in the live browser.'; broadcastState(session); return; }
        await navigate(session, url);
        return;
      }
      case 'home': if (session.home) await navigate(session, session.home); return;
      case 'back': await goHistory(session, -1); return;
      case 'forward': await goHistory(session, 1); return;
      case 'reload': await apply(session, 'Page.reload', {}).catch(() => {}); return;
      case 'stop': await apply(session, 'Page.stopLoading').catch(() => {}); return;
      case 'zoom': {
        const zoom = Math.round(clamp(msg.zoom, ZOOM_MIN, ZOOM_MAX, 1) * 100) / 100;
        if (zoom === session.zoom) return;
        session.zoom = zoom;
        await applyView(session);
        broadcastState(session);
        return;
      }
      case 'move': {
        const p = at(msg.x, msg.y);
        await apply(session, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }).catch(() => {});
        return;
      }
      case 'click': {
        const p = at(msg.x, msg.y);
        const count = msg.double ? 2 : 1;
        await apply(session, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }).catch(() => {});
        for (let n = 1; n <= count; n++) {
          await apply(session, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: n }).catch(() => {});
          await apply(session, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: n }).catch(() => {});
        }
        return;
      }
      case 'scroll': {
        // Fractions of the page's own window, so a drag the height of the
        // controller's preview scrolls the room's page by its height too.
        const p = at(msg.x ?? 0.5, msg.y ?? 0.5);
        await apply(session, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: p.x, y: p.y,
          deltaX: clamp(msg.dx, -20, 20, 0) * m.width, deltaY: clamp(msg.dy, -20, 20, 0) * m.height,
        }).catch(() => {});
        return;
      }
      case 'key': {
        const key = KEYS[msg.key];
        if (!key) return;
        const modifiers = msg.shift ? 8 : 0;
        const base = { key: msg.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers };
        await apply(session, 'Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}) }).catch(() => {});
        await apply(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base }).catch(() => {});
        return;
      }
      case 'text': {
        const text = String(msg.text || '').slice(0, 2000);
        if (text) await apply(session, 'Input.insertText', { text }).catch(() => {});
        return;
      }
      default:
    }
  }

  async function join(client, key, home, role) {
    let session = sessions.get(key);
    if (!session) session = createSession(key, home);
    if (!session.cdpSession) sendJson(client, { t: 'opening' });
    await session.ready;
    if (client.readyState !== OPEN) {
      // Nobody stayed to watch it open: it idles out like any other.
      if (!session.clients.size) armIdle(session);
      return null;
    }
    if (session.clients.size >= MAX_CLIENTS_PER_SESSION) throw new Error('Too many devices are watching this page.');
    client.role = role;
    session.clients.add(client);
    clearTimeout(session.idleTimer);
    session.lastSeen = Date.now();
    sendJson(client, stateOf(session));
    if (session.lastFrame) client.send(session.lastFrame, { binary: true });
    await startScreencast(session);
    return session;
  }

  function armIdle(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (!session.clients.size && sessions.get(session.key) === session) closeSession(session);
    }, idleMs);
    session.idleTimer.unref?.();
  }

  function leave(session, client) {
    if (!session.clients.delete(client)) return;
    session.lastSeen = Date.now();
    if (!session.clients.size) {
      stopScreencast(session);
      armIdle(session);
    }
  }

  // --- the socket ----------------------------------------------------------------

  /** Take over an HTTP upgrade to /browser. The caller has already decided who may. */
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    const key = url.searchParams.get('s') || '';
    if (!exe || !SESSION_KEY_RE.test(key)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (client) => {
      let session = null;
      let joining = null;
      // A frame that could not be sent to a device that had fallen behind is
      // sent once it has caught up, so a still page never stays half-drawn.
      const catchUp = setInterval(() => {
        if (session && client.missedFrame && client.bufferedAmount < MAX_BUFFERED && session.lastFrame) {
          client.missedFrame = false;
          try { client.send(session.lastFrame, { binary: true }); } catch { /* closing */ }
        }
      }, 250);
      client.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'hello') {
          if (joining) return;
          const home = addressToUrl(msg.home, searchUrl);
          const role = msg.role === 'display' ? 'display' : 'control';
          joining = join(client, key, home, role).then((s) => { session = s; return s; }).catch((err) => {
            sendJson(client, { t: 'error', message: err.busy ? err.message : `The live browser could not open that page: ${err.message}` });
            try { client.close(1011, 'could not open'); } catch { /* gone */ }
          });
          return;
        }
        joining?.then(() => {
          if (!session || sessions.get(key) !== session) return;
          // Taps, keys and typing one at a time, in the order they came: a tap
          // on a field is four calls to Chromium, and the text typed straight
          // after it must not arrive before the field has been focused.
          // Everything else (Stop above all) goes straight through.
          if (!INPUT_MESSAGES.has(msg.t)) { handleClientMessage(session, client, msg).catch(() => {}); return; }
          session.inputQueue = (session.inputQueue || Promise.resolve())
            .then(() => (sessions.get(key) === session ? handleClientMessage(session, client, msg) : null))
            .catch(() => {});
        });
      });
      client.on('close', () => {
        clearInterval(catchUp);
        if (session) leave(session, client);
        else joining?.then(() => { if (session) leave(session, client); });
      });
      client.on('error', () => client.terminate());
    });
  }

  function close() {
    closing = true;
    for (const session of [...sessions.values()]) forget(session);
    shutdownBrowser();
    removeProfile();
    guard?.close();
    guard = null;
  }

  return {
    available: !!exe,
    executable: exe,
    handleUpgrade,
    close,
    stats: () => ({ sessions: sessions.size, running: !!proc }),
  };
}

module.exports = {
  createLiveBrowser, createGuardProxy, publicAddress, lookupPublic, systemThenDirect, probeReach, findBrowser, isPrivateAddress, addressToUrl, viewFrom, metricsFor, KEYS, SESSION_KEY_RE,
};
