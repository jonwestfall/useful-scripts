// The live browser (server/browser.js, assets/js/live-browser.js): a web page
// run in Chromium on the server, shown on the projector as pictures and driven
// from the controller.
//
// The first half is pure - what the address bar means, which addresses are
// off limits, which pages go live, the session name every device in a room
// agrees on, and the protocol's part. The second half drives a real Chromium,
// when there is one to drive (BROWSER_PATH, or one found on PATH; the e2e
// harness's Playwright Chromium works too): a page that refuses to be framed
// opens, sends pictures, and follows a click, a scroll, typing, Back and a
// link that tries to open a new tab. Without a Chromium that half says it was
// skipped rather than failing - the server runs fine without one.
//
//   node podium/test/live-browser.test.mjs

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  browseMode, refusesFraming, isOtherSite, liveSessionKey,
} from '../assets/js/live-browser.js';
import { initialState, applyCommand, workingItem } from '../assets/js/protocol.js';

const require = createRequire(import.meta.url);
const doctor = require('../server/doctor.js');
const {
  createLiveBrowser, createGuardProxy, publicAddress, lookupPublic, systemThenDirect, probeReach, findBrowser, isPrivateAddress, addressToUrl, viewFrom, metricsFor, SESSION_KEY_RE,
} = require('../server/browser.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

// --- what is off limits -----------------------------------------------------------

ok('loopback is private', isPrivateAddress('127.0.0.1') && isPrivateAddress('::1'));
ok('cloud metadata (link-local) is private', isPrivateAddress('169.254.169.254'));
ok('RFC 1918 ranges are private', ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1'].every(isPrivateAddress));
ok('carrier-grade NAT and IPv6 unique-local are private', isPrivateAddress('100.64.0.1') && isPrivateAddress('fd00::1'));
ok('an IPv4-mapped IPv6 loopback is still loopback', isPrivateAddress('::ffff:127.0.0.1'));
ok('public addresses are not', !isPrivateAddress('140.82.112.3') && !isPrivateAddress('2606:4700::6810:84e5') && !isPrivateAddress('172.32.0.1'));
ok('something that is not an address is refused, not guessed at', isPrivateAddress('not-an-ip'));

// --- the doctor ---------------------------------------------------------------------

ok('the doctor\'s live browser line is not a fault, Chromium or none', doctor.checkLiveBrowser({ PATH: '/nonexistent' }).level === 'ok');
ok('a BROWSER_PATH that is not a program is worth knowing about', doctor.checkLiveBrowser({ BROWSER_PATH: '/nonexistent/chrome' }).level === 'warn');
ok('LIVE_BROWSER=off is a choice, said as one', /turned off/.test(doctor.checkLiveBrowser({ LIVE_BROWSER: 'off' }).detail));

// --- the guard proxy: the rule, enforced ------------------------------------------

{
  const lookup = (answers) => async () => answers.map((address) => ({ address }));
  ok('a loopback literal has no public address', (await publicAddress('127.0.0.1')) === null);
  ok('nor does localhost, or a .local name', (await publicAddress('localhost')) === null && (await publicAddress('printer.local')) === null);
  ok('a name that resolves publicly connects to the address that was checked',
    (await publicAddress('example.edu', { lookup: lookup(['93.184.216.34']) })) === '93.184.216.34');
  ok('a name that answers with a private address too is refused outright',
    (await publicAddress('rebind.example', { lookup: lookup(['93.184.216.34', '10.0.0.5']) })) === null);
  ok('a name that does not resolve is refused', (await publicAddress('nowhere.example', { lookup: async () => { throw new Error('ENOTFOUND'); } })) === null);

  const target = http.createServer((req, res) => res.end('inside'));
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const tport = target.address().port;
  const through = (proxyPort, opts) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, ...opts });
    req.on('response', (res) => { let body = ''; res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body })); });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); resolve({ status: res.statusCode }); return; }
      socket.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${tport}\r\nConnection: close\r\n\r\n`);
      let body = '';
      socket.on('data', (d) => { body += d; });
      socket.on('end', () => resolve({ status: 200, body }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
  const strictGuard = createGuardProxy();
  const strictPort = await strictGuard.listen();
  ok('the guard refuses a plain request to this machine', (await through(strictPort, { method: 'GET', path: `http://127.0.0.1:${tport}/` })).status === 403);
  ok('and a tunnel to it', (await through(strictPort, { method: 'CONNECT', path: `127.0.0.1:${tport}` })).status === 403);
  const openGuard = createGuardProxy({ isBlocked: () => false });
  const openPort = await openGuard.listen();
  ok('an allowed address is passed through, plain', (await through(openPort, { method: 'GET', path: `http://127.0.0.1:${tport}/` })).body === 'inside');
  ok('and tunnelled', /inside$/.test((await through(openPort, { method: 'CONNECT', path: `127.0.0.1:${tport}` })).body || ''));
  ok('listening twice is the same port', (await openGuard.listen()) === openPort);
  strictGuard.close();
  openGuard.close();

  // The system's lookup failing (EAI_AGAIN for every name, from a service
  // whose sandbox its name-service modules cannot work in): the DNS servers
  // are asked directly, and both reasons are kept if that fails too.
  const eaiAgain = async () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }); };
  const answering = () => ({ resolve4: async () => ['140.82.112.3'], resolve6: async () => { throw Object.assign(new Error('x'), { code: 'ENODATA' }); } });
  const silent = () => ({
    resolve4: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); },
    resolve6: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); },
  });
  const viaServers = await systemThenDirect('github.com', { all: true }, { system: eaiAgain, makeResolver: answering });
  ok('when the system lookup fails, the DNS servers are asked directly', viaServers.length === 1 && viaServers[0].address === '140.82.112.3');
  const neither = await systemThenDirect('github.com', { all: true }, { system: eaiAgain, makeResolver: silent }).catch((err) => err);
  ok(`and when they do not answer either, both reasons are said (${neither.code})`,
    neither instanceof Error && /^EAI_AGAIN; asking its DNS servers directly: ECONNREFUSED$/.test(neither.code));
  ok('which is what the guard then reports', /could not look github\.com up \(EAI_AGAIN; asking its DNS servers directly: ECONNREFUSED\)/.test(
    (await lookupPublic('github.com', { lookup: (h, o) => systemThenDirect(h, o, { system: eaiAgain, makeResolver: silent }) })).detail));
  ok('a system lookup that works is all that is asked', (await systemThenDirect('x.example', {}, { system: async () => [{ address: '93.184.216.34' }], makeResolver: () => { throw new Error('not asked'); } }))[0].address === '93.184.216.34');

  // Saying why (the ERR_TUNNEL_CONNECTION_FAILED a person sees otherwise).
  ok('a private answer says which address it was',
    /resolves to 10\.0\.0\.5/.test((await lookupPublic('rebind.example', { lookup: lookup(['93.184.216.34', '10.0.0.5']) })).detail));
  ok('a name that will not resolve says so', /could not look nowhere\.example up \(ENOTFOUND\)/.test(
    (await lookupPublic('nowhere.example', { lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } })).detail));
  const heard = [];
  const fake = (answers) => async () => answers.map((address) => ({ address }));
  const telling = createGuardProxy({ isBlocked: (ip) => ip === '10.0.0.5', lookup: fake(['10.0.0.5']), onProblem: (host, port, message) => heard.push(`${host}:${port} ${message}`) });
  const tellingPort = await telling.listen();
  ok('a refused tunnel is a 403', (await through(tellingPort, { method: 'CONNECT', path: 'intranet.example:443' })).status === 403);
  ok('and the guard says why, for the log', /intranet\.example:443 intranet\.example resolves to 10\.0\.0\.5.*BROWSER_ALLOW_PRIVATE/.test(heard[0] || ''));
  ok('and remembers it, for the controller', /resolves to 10\.0\.0\.5/.test(telling.problemFor('INTRANET.example')));
  telling.close();

  // An address that does not answer: the next one is tried; none, and it says so.
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const closedPort = closed.address().port;
  closed.close();
  const fallback = createGuardProxy({ isBlocked: () => false, lookup: fake(['127.0.0.3', '127.0.0.1']) });
  const fallbackPort = await fallback.listen();
  ok('an address that refuses is passed over for the next one',
    /inside$/.test((await through(fallbackPort, { method: 'CONNECT', path: `twoaddrs.example:${tport}` })).body || ''));
  fallback.close();
  const unreachable = createGuardProxy({ isBlocked: () => false, lookup: fake(['127.0.0.1']), onProblem: (h, p, m) => heard.push(m) });
  const unreachablePort = await unreachable.listen();
  ok('none answering is a 502, not a refusal', (await through(unreachablePort, { method: 'CONNECT', path: `down.example:${closedPort}` })).status === 502);
  ok('saying it could not be reached, and asking whether this network needs a proxy',
    /down\.example:\d+ could not be reached from this server \(127\.0\.0\.1: ECONNREFUSED\).*BROWSER_UPSTREAM_PROXY/.test(heard.at(-1) || ''));
  unreachable.close();

  // A network that only reaches out through a proxy of its own.
  let asked = '';
  const upstream = http.createServer();
  upstream.on('connect', (req, socket, head) => {
    asked = req.url;
    const onward = net.connect(tport, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) onward.write(head);
      onward.pipe(socket);
      socket.pipe(onward);
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const chained = createGuardProxy({
    isBlocked: isPrivateAddress, lookup: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); },
    upstream: `127.0.0.1:${upstream.address().port}`,
  });
  const chainedPort = await chained.listen();
  ok('through an upstream proxy, a name this server cannot look up still opens',
    /inside$/.test((await through(chainedPort, { method: 'CONNECT', path: 'outside.example:443' })).body || ''));
  ok('the upstream proxy is asked for the name, not an address', asked === 'outside.example:443');
  const chainedPrivate = createGuardProxy({ lookup: fake(['10.0.0.5']), upstream: `127.0.0.1:${upstream.address().port}` });
  const chainedPrivatePort = await chainedPrivate.listen();
  ok('and a private address is still refused before the proxy is asked', (await through(chainedPrivatePort, { method: 'CONNECT', path: 'intranet.example:443' })).status === 403);
  ok('plain http goes through it too', (await through(chainedPort, { method: 'GET', path: 'http://outside.example/' })).body === 'inside');
  chained.close();
  chainedPrivate.close();
  upstream.close();

  // podium-admin doctor's "web access" line: the same guard, asked for real.
  ok('the doctor\'s reach check opens what a page could', (await probeReach({ host: 'local.example', port: tport, allowPrivate: true, lookup: fake(['127.0.0.1']) })).ok);
  const refusedReach = await probeReach({ host: 'local.example', port: tport, lookup: fake(['127.0.0.1']) });
  ok(`and says why when it cannot (${refusedReach.detail})`, !refusedReach.ok && /private or reserved/.test(refusedReach.detail));
  const withChrome = { BROWSER_PATH: process.execPath };
  ok('a page that can get out is a plain ok', (await doctor.checkLiveBrowserReach(withChrome, { probe: async () => ({ ok: true, detail: 'github.com:443 is reachable' }) })).level === 'ok');
  const stuck = await doctor.checkLiveBrowserReach(withChrome, { probe: async () => ({ ok: false, detail: 'github.com:443 could not be reached from this server (140.82.112.3: ETIMEDOUT)' }) });
  ok('one that cannot is a problem, with the reason', stuck.level === 'bad' && /ETIMEDOUT/.test(stuck.detail));
  ok('and nothing is checked with the live browser off', (await doctor.checkLiveBrowserReach({ ...withChrome, LIVE_BROWSER: 'off' })) === null);
  target.close();
}

// --- the address bar ------------------------------------------------------------------

ok('a bare host becomes https', addressToUrl('github.com/jonwestfall') === 'https://github.com/jonwestfall');
ok('a full URL is kept', addressToUrl('http://example.edu/a?b=1') === 'http://example.edu/a?b=1');
ok('words are a search', addressToUrl('photosynthesis diagram') === 'https://duckduckgo.com/?q=photosynthesis%20diagram');
ok('the search can be somewhere else', addressToUrl('cells', 'https://www.google.com/search?q=') === 'https://www.google.com/search?q=cells');
ok('file: is never opened', addressToUrl('file:///etc/passwd') === null);
ok('javascript: is never opened', addressToUrl('javascript:alert(1)') === null);
ok('chrome: is never opened', addressToUrl('chrome://settings') === null);
ok('host:port is a site, not a scheme', addressToUrl('example.edu:8080/x') === 'https://example.edu:8080/x');
ok('nothing is nothing', addressToUrl('   ') === null);

// --- the picture's shape --------------------------------------------------------------

{
  const v = viewFrom({ w: 1920, h: 1080, scale: 2 });
  ok('a 1080p panel at 2x is capped to 1920 pixels across', Math.round(v.w * v.scale) === 1920);
  const m = metricsFor({ w: 1280, h: 720, scale: 1.5 }, 1.5);
  ok('150% zoom lays the page out narrower and draws it bigger', m.width === 853 && m.deviceScaleFactor === 2.25 && m.frameW === 1920);
  ok('nonsense sizes fall back to something sane', viewFrom({ w: 'x', h: -1 }).w === 1280 && viewFrom({ w: 'x', h: -1 }).h === 200);
}

// --- which pages go live -------------------------------------------------------------

{
  const base = 'https://podium.example.edu/control.html';
  ok('another site is another site', isOtherSite('https://github.com/jonwestfall', base));
  ok('a page on this Podium is not', !isOtherSite('content/web/sim.html', base) && !isOtherSite('https://podium.example.edu/x', base));
  globalThis.location = new URL(base);
  ok('automatic: another site goes live when the server has a live browser', browseMode({ src: 'https://github.com/jonwestfall' }, true) === 'live');
  ok('automatic: nothing goes live without one', browseMode({ src: 'https://github.com/jonwestfall' }, false) === 'embed');
  ok('automatic: a page on this Podium stays embedded', browseMode({ src: 'content/web/sim.html' }, true) === 'embed');
  ok('the presenter can insist on embedded', browseMode({ src: 'https://github.com/x', browse: 'embed' }, true) === 'embed');
  ok('or on live', browseMode({ src: 'https://example.edu/sim', browse: 'live' }, true) === 'live');
  delete globalThis.location;
  ok('github.com is known to refuse framing', refusesFraming('https://github.com/jonwestfall') === 'github.com');
  ok('so is a subdomain of a site that does', refusesFraming('https://gist.github.com/x') === 'gist.github.com');
  ok('an embed link is made to be framed', !refusesFraming('https://www.youtube.com/embed/abc') && !refusesFraming('https://www.google.com/maps/embed?pb=1'));
  ok('a published Google Slides deck is made to be framed', !refusesFraming('https://docs.google.com/presentation/d/abc/pub?start=false'));
  ok('so is a Drive file\'s preview, while a Doc being edited is not', !refusesFraming('https://drive.google.com/file/d/abc/preview') && refusesFraming('https://docs.google.com/document/d/x/edit') === 'docs.google.com');
  ok('an ordinary site is not assumed to refuse', !refusesFraming('https://en.wikipedia.org/wiki/Cell') && !refusesFraming('https://notgithub.com/'));
}

// --- the session name -------------------------------------------------------------------

{
  const a = await liveSessionKey('room-1', 'correct horse battery', 'k1');
  const again = await liveSessionKey('room-1', 'correct horse battery', 'k1');
  const otherItem = await liveSessionKey('room-1', 'correct horse battery', 'k2');
  const otherPass = await liveSessionKey('room-1', 'wrong horse battery', 'k1');
  const otherRoom = await liveSessionKey('room-2', 'correct horse battery', 'k1');
  ok('every device in a room works out the same name', a === again);
  ok('the name is one the server accepts', SESSION_KEY_RE.test(a) && a.length === 43);
  ok('another item, passphrase or room is another session', new Set([a, otherItem, otherPass, otherRoom]).size === 4);
  ok('the passphrase is not in it', !a.includes('horse'));
}

// --- the protocol's part ------------------------------------------------------------------

{
  const s = initialState();
  applyCommand(s, { op: 'stage', item: { type: 'web', src: 'https://github.com/jonwestfall', browse: 'sideways' } });
  const live = s.program;
  ok('a web page gets a live session id of its own', typeof live.liveId === 'string' && live.liveId === live.key);
  ok('an unknown "show as" is dropped', !('browse' in live));
  applyCommand(s, { op: 'web', browse: 'embed' });
  ok('the Now tab can switch it to embedded', s.program.browse === 'embed');
  applyCommand(s, { op: 'web', browse: 'auto' });
  ok('and back to automatic', !('browse' in s.program));
  applyCommand(s, { op: 'freeze', on: true });
  applyCommand(s, { op: 'nav', dir: 'next' });
  ok('a frozen Next cues a copy that shows the same page (same session)', s.preview && s.preview.key !== live.key && s.preview.liveId === live.liveId);
  ok('...and the Now tab drives the cue', workingItem(s) === s.preview);
  applyCommand(s, { op: 'stage', item: { ...live } });
  ok('staging it again (a "Back to") keeps the page where it was', s.preview.liveId === live.liveId);
  applyCommand(s, { op: 'stage', item: { type: 'web', src: 'https://github.com/jonwestfall', liveId: 'bad id!' } });
  ok('a malformed session id is replaced', /^[A-Za-z0-9_-]+$/.test(s.preview.liveId) && s.preview.liveId !== 'bad id!');
  ok('the "show as" op ignores anything that is not a web page', !applyCommand(initialState(), { op: 'web', browse: 'live' }));
}

// --- a real Chromium --------------------------------------------------------------------------

function chromium() {
  if (process.env.BROWSER_PATH) return process.env.BROWSER_PATH;
  const found = findBrowser();
  if (found) return found;
  for (const candidate of ['/opt/pw-browsers/chromium']) if (fs.existsSync(candidate)) return candidate;
  return null;
}

const exe = chromium();
if (!exe) {
  console.log('skip a real Chromium: none found (set BROWSER_PATH to run this half)');
} else {
  const WebSocket = require('../server/node_modules/ws');
  const pages = {
    '/': `<!doctype html><title>One</title><body style="margin:0;height:4000px">
      <a id="next" href="/two" style="display:block;width:400px;height:200px;background:#fd0">Two</a>
      <form action="/echo"><input id="q" name="q" style="position:absolute;left:0;top:300px;width:400px;height:60px"></form>
      <script>addEventListener('scroll', () => { document.title = 'One@' + Math.round(scrollY); });</script>`,
    '/two': '<!doctype html><title>Two</title><body style="margin:0"><a href="/three" target="_blank" style="display:block;width:400px;height:200px;background:#0c0">Three</a>',
    '/three': '<!doctype html><title>Three</title><body>three',
    '/set': '<!doctype html><title>Set</title><body>signed in',
    '/read': '<!doctype html><title>Read</title><script>document.title = `Read ${document.cookie || "none"}`</script>',
    // A video made in the page (a canvas, recorded live) - no file needed.
    '/video': `<!doctype html><title>Video</title><body style="margin:0"><video muted autoplay playsinline width="400"></video>
      <script>const c = Object.assign(document.createElement('canvas'), { width: 160, height: 90 });
      let n = 0; setInterval(() => { const g = c.getContext('2d'); g.fillStyle = 'hsl(' + (n++ * 20) % 360 + ',80%,50%)'; g.fillRect(0, 0, 160, 90); }, 50);
      document.querySelector('video').srcObject = c.captureStream(20);</script>`,
  };
  const site = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/set') res.setHeader('set-cookie', 'kept=yes; Max-Age=3600; Path=/');
    // The reason the live browser exists: this page refuses to be framed.
    res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'deny', 'content-security-policy': "frame-ancestors 'none'" });
    res.end(url.pathname === '/echo' ? `<!doctype html><title>Echo ${url.searchParams.get('q')}</title>` : (pages[url.pathname] || 'nope'));
  });
  const logs = [];
  // A course that keeps its live pages' sign-ins, for lecture 7 only.
  const kept = { cookies: [], saves: 0 };
  const signinsFor = (who, lectureId) => (lectureId === 7 ? {
    course: 'psy101',
    load: () => kept.cookies,
    save: (cookies) => { kept.cookies = cookies; kept.saves += 1; },
  } : null);
  const live = createLiveBrowser({ executable: exe, allowPrivate: true, idleMs: 5000, sandbox: false, log: (m) => logs.push(m), signinsFor });
  const strict = createLiveBrowser({ executable: exe, allowPrivate: false, idleMs: 5000, sandbox: false, log: (m) => logs.push(m) });
  const relay = http.createServer();
  relay.on('upgrade', (req, socket, head) => (req.url.includes('strict=1') ? strict : live).handleUpgrade(req, socket, head));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const home = `http://127.0.0.1:${site.address().port}/`;

  const connect = (key, role, extra = '', hello = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.address().port}/browser?s=${key}${extra}`);
    const client = { ws, frames: [], states: [], errors: [], media: [] };
    ws.on('message', (data, isBinary) => {
      if (isBinary) { client.frames.push(data); return; }
      const msg = JSON.parse(data.toString());
      if (msg.t === 'state') client.states.push(msg);
      if (msg.t === 'error') client.errors.push(msg.message);
      if (msg.t === 'media') client.media.push(msg);
    });
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', home, role, ...hello })); resolve(client); });
    ws.on('error', reject);
  });
  const until = async (label, test, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (test()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    console.log(`  (gave up waiting for ${label})`);
    return false;
  };
  const latest = (c) => c.states.at(-1) || {};
  const send = (c, msg) => c.ws.send(JSON.stringify(msg));

  try {
    const key = await liveSessionKey('room', 'pass', 'web-1');
    const display = await connect(key, 'display');
    send(display, { t: 'view', w: 800, h: 600, scale: 1 });
    // The first page waits on Chromium starting, which on a fresh machine (a
    // CI runner's first launch of its Chrome) can take far longer than the
    // second.
    ok('a page that refuses framing opens in the live browser', await until('the first page', () => latest(display).title === 'One', 100000));
    ok('and pictures of it arrive, as JPEG', await until('a frame', () => display.frames.some((f) => f[0] === 0xff && f[1] === 0xd8)));

    const controller = await connect(key, 'control');
    ok('a controller joining the same session is shown the same page at once', await until('controller state', () => latest(controller).title === 'One' && controller.frames.length > 0));
    ok('the page takes the display\'s shape', Math.abs((latest(controller).aspect || 0) - 800 / 600) < 0.01);

    send(controller, { t: 'scroll', x: 0.5, y: 0.5, dy: 0.5 });
    ok('a drag on the controller scrolls the page', await until('scroll', () => /^One@[1-9]/.test(latest(controller).title || '')));
    send(controller, { t: 'key', key: 'Home' });
    await until('back to the top', () => latest(controller).title === 'One@0');

    // Sent back to back, as a quick hand on the iPad does: the tap must have
    // focused the field before the typing lands.
    send(controller, { t: 'click', x: (200 / 800), y: (330 / 600) });
    send(controller, { t: 'text', text: 'mitochondria' });
    send(controller, { t: 'key', key: 'Enter' });
    ok('a tap focuses a field, typing fills it and Enter submits it, in that order', await until('the search', () => latest(display).title === 'Echo mitochondria'));

    send(controller, { t: 'back' });
    ok('Back goes back', await until('back', () => latest(display).url === home));
    ok('...and Forward becomes possible', latest(display).canForward === true);

    send(controller, { t: 'click', x: 100 / 800, y: 100 / 600 });
    ok('a tap on a link follows it', await until('page two', () => latest(display).title === 'Two'));
    send(controller, { t: 'click', x: 100 / 800, y: 100 / 600 });
    ok('a link that opens a new tab opens in this one instead', await until('page three', () => latest(display).title === 'Three'));

    send(controller, { t: 'zoom', zoom: 2 });
    ok('the page can be made bigger for the room', await until('zoom', () => latest(display).zoom === 2));

    send(controller, { t: 'go', url: 'file:///etc/passwd' });
    ok('a file: address is refused', await until('refusal', () => /only web addresses/i.test(latest(display).error || '')));

    send(controller, { t: 'home' });
    ok('Home goes back to where the item started', await until('home', () => latest(display).url === home));

    // "Play this in Podium": where the page's video has got to, and pausing it.
    const askMedia = async (id, extra = {}) => {
      send(controller, { t: 'media', id, ...extra });
      await until(`media answer ${id}`, () => controller.media.some((m) => m.id === id));
      return controller.media.find((m) => m.id === id).media;
    };
    ok('a page with no video says so', (await askMedia('none')) === null);
    send(controller, { t: 'go', url: home.replace(/\/$/, '') + '/video' });
    await until('the video page', () => latest(display).title === 'Video');
    let playing = null;
    for (let i = 0; i < 60 && !(playing?.time > 0); i++) {
      playing = await askMedia(`at-${i}`);
      if (!(playing?.time > 0)) await new Promise((r) => setTimeout(r, 250));
    }
    ok(`a page's video says where it is (${JSON.stringify(playing)})`, playing?.time > 0 && playing.paused === false);
    await askMedia('pause', { pause: true });
    ok('and asked to, pauses there', (await askMedia('after'))?.paused === true);
    send(controller, { t: 'home' });
    await until('home again', () => latest(display).url === home);

    // A course that keeps its live pages' sign-ins (courses.liveSignins): a
    // page opened in one of its lectures keeps the site's cookies as it
    // loads, and the next one starts with them - and no other page does.
    const keeping = await connect(await liveSessionKey('room', 'pass', 'web-kept'), 'display', '', { home: `${home}set`, lecture: 7 });
    await until('the sign-in page', () => latest(keeping).title === 'Set');
    ok('a page in a lecture whose course keeps sign-ins keeps the site\'s cookie as it loads',
      await until('kept', () => kept.cookies.some((c) => c.name === 'kept' && c.value === 'yes')));
    keeping.ws.close();
    const next = await connect(await liveSessionKey('room', 'pass', 'web-kept-2'), 'display', '', { home: `${home}read`, lecture: 7 });
    ok('and the next page opened in one of its lectures starts signed in', await until('signed in', () => latest(next).title === 'Read kept=yes'));
    next.ws.close();
    const other = await connect(await liveSessionKey('room', 'pass', 'web-unkept'), 'display', '', { home: `${home}read` });
    ok('but a page opened outside its lectures does not', await until('not signed in', () => latest(other).title === 'Read none'));
    other.ws.close();

    // Through the guard proxy, with 127.0.0.1 standing in for the internet
    // and 127.0.0.2 for the private network behind it: the page opens, and
    // nothing it asks for reaches the private address - not an image, not a
    // fetch, not an iframe, not a WebSocket.
    let secretHits = 0;
    const secret = http.createServer((req, res) => { secretHits += 1; res.end('secret'); });
    secret.on('upgrade', (req, socket) => { secretHits += 1; socket.destroy(); });
    const secretUp = await new Promise((r) => { secret.once('error', () => r(false)); secret.listen(0, '127.0.0.2', () => r(true)); });
    if (secretUp) {
      const inside = `127.0.0.2:${secret.address().port}`;
      pages['/reach'] = `<!doctype html><title>Reaching</title><img src="http://${inside}/img">
        <iframe src="http://${inside}/frame"></iframe>
        <script>fetch('http://${inside}/fetch', { mode: 'no-cors' }).catch(() => {});
        try { new WebSocket('ws://${inside}/ws'); } catch {}
        </script>`;
      const guarded = createLiveBrowser({ executable: exe, idleMs: 5000, sandbox: false, isBlocked: (ip) => ip.startsWith('127.0.0.2'), log: (m) => logs.push(m) });
      const guardedRelay = http.createServer();
      guardedRelay.on('upgrade', (req, socket, head) => guarded.handleUpgrade(req, socket, head));
      await new Promise((r) => guardedRelay.listen(0, '127.0.0.1', r));
      try {
        const g = await new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${guardedRelay.address().port}/browser?s=${'g'.repeat(43)}`);
          const client = { ws, frames: [], states: [], errors: [], media: [] };
          ws.on('message', (data, isBinary) => { if (isBinary) client.frames.push(data); else { const m = JSON.parse(data.toString()); if (m.t === 'state') client.states.push(m); } });
          ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', home: `${home}reach`, role: 'display' })); resolve(client); });
          ws.on('error', reject);
        });
        ok('through the guard, a public page opens', await until('the guarded page', () => latest(g).title === 'Reaching' && latest(g).loading === false, 100000));
        await new Promise((r) => setTimeout(r, 1500));
        ok('and nothing it asks for reaches a private address', secretHits === 0);
        // An address nothing answers at: the controller is told why, not
        // just Chromium's ERR_TUNNEL_CONNECTION_FAILED.
        const nobody = http.createServer();
        await new Promise((r) => nobody.listen(0, '127.0.0.1', r));
        const nobodyPort = nobody.address().port;
        nobody.close();
        g.ws.send(JSON.stringify({ t: 'go', url: `https://127.0.0.1:${nobodyPort}/` }));
        ok('a page the server cannot reach says why on the controller',
          await until('the reason', () => /could not be reached from this server \(127\.0\.0\.1: ECONNREFUSED\)/.test(latest(g).error || '')));
        ok('and the reason is in the log', logs.some((l) => /did not open 127\.0\.0\.1:\d+ - .*ECONNREFUSED/.test(l)));
        g.ws.close();
      } finally {
        guarded.close();
        guardedRelay.close();
      }
    } else {
      console.log('skip the guard proxy with a real Chromium: 127.0.0.2 is not available here');
    }
    secret.close();

    const strictKey = await liveSessionKey('room', 'pass', 'web-2');
    const guarded = await connect(strictKey, 'display', '&strict=1');
    ok('with private addresses off limits, a page on this machine is refused', await until('private refusal', () => /private network/i.test(latest(guarded).error || ''), 100000));
    guarded.ws.close();

    // The projector and a controller's preview ask for a new page at the same
    // instant when it first goes up: one tab, not one each.
    const raceKey = await liveSessionKey('room', 'pass', 'web-3');
    const [first, second] = await Promise.all([connect(raceKey, 'display'), connect(raceKey, 'control')]);
    await until('both open', () => latest(first).title === 'One' && latest(second).title === 'One');
    send(second, { t: 'go', url: `${home}two` });
    ok('two devices that ask for a new page at the same moment share one tab',
      await until('both on page two', () => latest(first).title === 'Two' && latest(second).title === 'Two'));
    first.ws.close();
    second.ws.close();

    const before = display.frames.length;
    display.ws.close();
    controller.ws.close();
    await new Promise((r) => setTimeout(r, 400));
    const back = await connect(key, 'display');
    ok('a display that reloads finds the page where it was left', await until('resume', () => latest(back).title === 'Three' || latest(back).url === home) && back.frames.length > 0);
    ok('(and was sent pictures before it went)', before > 0);
    back.ws.close();
  } catch (err) {
    ok(`the live browser ran without throwing (${err.message})`, false);
  } finally {
    live.close();
    strict.close();
    site.close();
    relay.close();
  }
  if (fails.length) console.log(logs.map((l) => `  log: ${l}`).join('\n'));
}

if (fails.length) {
  console.log(`\n${fails.length} FAILED`);
  process.exit(1);
}
console.log('\nall passed');
process.exit(0);
