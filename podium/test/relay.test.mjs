// The WebSocket relay's own limits, with a real server process and real
// sockets but no browser - podium-server.js had no direct test coverage of
// any kind before this (see Issue #112/#122). Room names are not secret
// (only the passphrase is), so these are the guards against an attacker who
// knows or guesses one, or who just floods the upgrade path.
//
//   node podium/test/relay.test.mjs

import { spawn } from 'node:child_process';
import { createServer, connect as connectTcp } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('../server/node_modules/ws');
const doctor = require('../server/doctor.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function startRelay(env) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['podium-server.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(port), STATIC: '../', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), 10000);
    proc.stdout.on('data', (d) => { if (String(d).includes('podium relay')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error(`relay exited with ${code} - did you run npm install in podium/server?`)));
  });
  return { port, proc };
}

// Opens a socket and finds out how the server actually responded: a clean
// handshake that stays open, a handshake that opens and is then closed with
// a code (MAX_PER_ROOM/MAX_ROOMS - the connection completed, the relay is
// declining it), or the raw socket being destroyed mid-upgrade (the per-IP
// throttle - never even gets to a WebSocket close code).
//
// "Stays open" is known for certain, not waited out: the relay declines a
// socket in the same moment it accepts the handshake, before it reads
// anything from it, so a ping answered with a pong is one it kept - its
// close frame, had it declined, would have come first.
function connect(port, room, { cookie } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/podium?room=${encodeURIComponent(room)}`,
      cookie ? { headers: { cookie } } : undefined);
    const result = { ws, opened: false, closeCode: null, closeReason: '', errored: false };
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    ws.on('open', () => { result.opened = true; ws.ping(); });
    ws.on('pong', finish);
    ws.on('close', (code, reason) => { result.closeCode = code; result.closeReason = reason.toString(); finish(); });
    ws.on('error', () => { result.errored = true; finish(); });
    // Only if the server says nothing at all.
    const timer = setTimeout(finish, 5000);
  });
}

// Asks until `check` answers, rather than sleeping for a guess at how long
// the server takes to notice something.
async function until(check, { timeout = 5000, interval = 50 } = {}) {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, interval))) {
    if (await check()) return true;
  }
  return false;
}

// --- MAX_PER_ROOM: a room name is not secret, so an attacker who knows one
// can otherwise fill it and lock the real controller/display out with no
// passphrase at all. ---------------------------------------------------------
{
  const { port, proc } = await startRelay({});
  const peers = [];
  for (let i = 0; i < 12; i++) peers.push(await connect(port, 'relay-test-room-full'));
  ok('the first 12 peers in a room all connect', peers.every((p) => p.opened && p.closeCode === null));

  const extra = await connect(port, 'relay-test-room-full');
  ok('a 13th peer in the same room is turned away', extra.closeCode === 1013 && extra.closeReason === 'room full');

  const elsewhere = await connect(port, 'relay-test-room-full-2');
  ok('a full room does not affect a different one', elsewhere.opened && elsewhere.closeCode === null);

  for (const p of [...peers, extra, elsewhere]) p.ws.terminate();
  proc.kill();
}

// --- MAX_ROOMS: caps the RELAY, not any one room - joining a room that
// already exists never counts against it. --------------------------------
{
  const { port, proc } = await startRelay({ MAX_ROOMS: '3' });
  const first = await connect(port, 'cap-room-1');
  const second = await connect(port, 'cap-room-2');
  const third = await connect(port, 'cap-room-3');
  ok('three distinct rooms open under a cap of 3', [first, second, third].every((p) => p.opened && p.closeCode === null));

  const fourth = await connect(port, 'cap-room-4');
  ok('a 4th, brand-new room is turned away once the relay is at its cap',
    fourth.closeCode === 1013 && fourth.closeReason === 'relay full');

  const rejoin = await connect(port, 'cap-room-1');
  ok('a second peer joining an EXISTING room still gets in - the cap is on room count, not total peers',
    rejoin.opened && rejoin.closeCode === null);

  for (const p of [first, second, third, fourth, rejoin]) p.ws.terminate();
  proc.kill();
}

// --- per-IP upgrade throttle: protects the relay from one IP flooding
// connection attempts under ever-new room names, faster than MAX_ROOMS
// alone would reject them (and faster than dead sockets get reaped). ------
{
  const { port, proc } = await startRelay({ MAX_UPGRADES_PER_IP: '3', UPGRADE_WINDOW_MS: '60000' });
  const allowed = [];
  for (let i = 0; i < 3; i++) allowed.push(await connect(port, `throttle-room-${i}`));
  ok('the first 3 upgrade attempts from one IP succeed', allowed.every((p) => p.opened && p.closeCode === null));

  const throttled = await connect(port, 'throttle-room-4th');
  ok('a 4th attempt inside the same window never completes the handshake at all',
    !throttled.opened && throttled.errored);

  for (const p of allowed) p.ws.terminate();
  throttled.ws.terminate();
  proc.kill();
}

// --- checkRelay (Issue #118): plain HTTP answering does not prove the relay
// actually relays - this is the check that catches a reverse-proxy or
// firewall change that breaks WS specifically while /healthz stays green. ---
{
  const { port, proc } = await startRelay({});
  const healthUrl = `http://127.0.0.1:${port}/healthz`;
  const result = await doctor.checkRelay(healthUrl);
  ok(`a real relay round-trips a message between two peers (${result.detail})`, result.level === 'ok');
  proc.kill();
}
// --- Guest View rooms (Issue #150): a lecture hall of phones, not a handful
// of devices - their own ceiling, and the one kind of room an anonymous
// viewer may join on an instance with accounts, once a signed-in display is
// in it. -----------------------------------------------------------------------
{
  const { port, proc } = await startRelay({ MAX_VIEWERS_PER_ROOM: '15' });
  const viewers = [];
  for (let i = 0; i < 15; i++) viewers.push(await connect(port, 'view.RelayTest01'));
  ok('a view room takes more than the 12 a control room does', viewers.every((p) => p.opened && p.closeCode === null));
  const extra = await connect(port, 'view.RelayTest01');
  ok('but still has a ceiling of its own', extra.closeCode === 1013 && extra.closeReason === 'room full');
  const lookalike = [];
  for (let i = 0; i < 13; i++) lookalike.push(await connect(port, 'view-RelayTest02'));
  ok('a room merely named like one gets the ordinary 12', lookalike.filter((p) => p.opened && p.closeCode === null).length === 12);
  for (const p of [...viewers, extra, ...lookalike]) p.ws.terminate();
  proc.kill();
}
{
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const store = require('../server/store.js');
  const accounts = require('../server/accounts.js');
  const dataDir = mkdtempSync(path.join(tmpdir(), 'podium-relay-'));
  const db = store.open(dataDir);
  const user = await accounts.createUser(db, { username: 'presenter', password: 'a long enough password' });
  const cookie = `podium_session=${accounts.startSession(db, user.id)}`;
  db.close();
  const { port, proc } = await startRelay({ DATA_DIR: dataDir });

  const early = await connect(port, 'view.RelayTest03');
  ok('with accounts, an anonymous viewer cannot open a view room nobody is hosting', !early.opened);
  const control = await connect(port, 'relay-test-control-room');
  ok('and still cannot join an ordinary room at all', !control.opened);

  const display = await connect(port, 'view.RelayTest03', { cookie });
  ok('a signed-in display opens its view room', display.opened && display.closeCode === null);
  const viewer = await connect(port, 'view.RelayTest03');
  ok('after which an anonymous viewer may join it', viewer.opened && viewer.closeCode === null);

  const heard = new Promise((resolve) => { viewer.ws.once('message', (d) => resolve(String(d))); setTimeout(() => resolve(null), 1000); });
  display.ws.send('sealed-state-snapshot');
  ok('and receives what the display sends there', (await heard) === 'sealed-state-snapshot');

  // A guest clicker's room (Issue #336), on the same terms: a substitute has
  // no account, and the display takes nothing from it but a clicker's.
  const earlyGuest = await connect(port, 'guest.RelayTest04');
  ok('an anonymous guest cannot open a guest room nobody is hosting', !earlyGuest.opened);
  const guestHost = await connect(port, 'guest.RelayTest04', { cookie });
  const guest = await connect(port, 'guest.RelayTest04');
  ok('but may join one a signed-in display is in', guestHost.opened && guest.opened && guest.closeCode === null);
  const notGuest = await connect(port, 'guest-RelayTest05');
  ok('and a room merely named like one is not one', !notGuest.opened);
  for (const p of [earlyGuest, guestHost, guest, notGuest]) p.ws.terminate();

  // The viewer pass: the files a live display is showing, and nothing else.
  const base = `http://127.0.0.1:${port}`;
  const pass = async (room) => fetch(`${base}/view-pass`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room }),
  });
  ok('no pass for a view room nobody is hosting', (await pass('view.NobodyHere1')).status === 404);
  ok('or for something that is not a view room at all', (await pass('relay-test-control-room')).status === 400);
  const granted = await pass('view.RelayTest03');
  const viewerCookie = (granted.headers.get('set-cookie') || '').split(';')[0];
  ok('a viewer of a live view room is handed a pass', granted.status === 200 && viewerCookie.startsWith('podium_viewer='));
  const get = (p, withPass = true) => fetch(`${base}${p}`, { redirect: 'manual', headers: withPass ? { cookie: viewerCookie } : {} });
  ok('without it, a stranger cannot read the course\'s files', (await get('/content/decks/example-builds.md', false)).status === 401);
  ok('with it, the files the display shows are readable', (await get('/content/decks/example-builds.md')).status === 200);
  ok('but never a page', [302, 401].includes((await get('/control.html')).status));
  ok('or the API', (await get('/api/courses')).status === 401);

  display.ws.terminate();
  ok('and the pass is worth nothing once the display stands down',
    await until(async () => (await get('/content/decks/example-builds.md')).status === 401));

  for (const p of [early, control, display, viewer]) p.ws.terminate();
  proc.kill();
  rmSync(dataDir, { recursive: true, force: true });
}

// --- the app's own files: a validator, and compressed --------------------------
{
  const { port, proc } = await startRelay({});
  const { gunzipSync } = await import('node:zlib');
  const { readFileSync } = await import('node:fs');
  const file = '/assets/js/deck.js';
  const onDisk = readFileSync(path.join(ROOT, 'assets', 'js', 'deck.js'));
  // fetch() would unzip it for us and hide the header; http.get does not.
  const { get } = await import('node:http');
  const ask = (headers) => new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path: file, headers }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
    }).on('error', reject);
  });
  const zipped = await ask({ 'accept-encoding': 'gzip, br' });
  ok(`a script is sent compressed to a browser that takes it (${onDisk.length} -> ${zipped.body.length} bytes)`,
    zipped.status === 200 && zipped.headers['content-encoding'] === 'gzip' && gunzipSync(zipped.body).equals(onDisk));
  ok('with a validator, still to be asked about every time', !!zipped.headers.etag && zipped.headers['cache-control'] === 'no-cache');
  const again = await ask({ 'accept-encoding': 'gzip', 'if-none-match': zipped.headers.etag });
  ok('asked again with it, the answer is a 304 and no bytes', again.status === 304 && again.body.length === 0);
  const plain = await ask({});
  ok('a client that does not take gzip gets the file as it is', plain.status === 200 && !plain.headers['content-encoding'] && plain.body.equals(onDisk));
  const part = await ask({ 'accept-encoding': 'gzip', range: 'bytes=0-9' });
  ok('and a range is the file\'s own bytes', part.status === 206 && !part.headers['content-encoding'] && part.body.equals(onDisk.subarray(0, 10)));
  proc.kill();
}

// --- what the pages say about how they may be used -------------------------
{
  const { port, proc } = await startRelay({});
  const head = async (route, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { headers });
    await res.arrayBuffer();
    return res.headers;
  };
  const control = await head('/control.html');
  const csp = control.get('content-security-policy-report-only') || '';
  ok('a page may only be framed by this site', control.get('x-frame-options') === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(csp));
  ok('it carries a content security policy, report-only for now', /script-src 'self'/.test(csp) && /object-src 'none'/.test(csp)
    && /report-uri \/csp-report/.test(csp) && !control.get('content-security-policy'));
  ok('which never allows inline script wholesale', !/'unsafe-inline'[^;]*;/.test(csp.split('; ').find((d) => d.startsWith('script-src')) + ';'));
  const login = await head('/login.html');
  const loginHtml = await (await fetch(`http://127.0.0.1:${port}/login.html`)).text();
  const firstInline = /<script>([\s\S]*?)<\/script>/.exec(loginHtml)?.[1] ?? '';
  const { createHash } = await import('node:crypto');
  const want = `'sha256-${createHash('sha256').update(firstInline, 'utf8').digest('base64')}'`;
  ok('a page\'s own inline scripts are allowed by their hash', !!firstInline && (login.get('content-security-policy-report-only') || '').includes(want));
  const join = await head('/join.html');
  ok('an audience page may be framed anywhere (an LMS page, say)', !join.get('x-frame-options')
    && /frame-ancestors \*/.test(join.get('content-security-policy-report-only') || ''));
  ok('everything is nosniff', (await head('/assets/js/util.js')).get('x-content-type-options') === 'nosniff' && control.get('x-content-type-options') === 'nosniff');
  ok('HSTS only over HTTPS', !control.get('strict-transport-security')
    && /max-age=\d+/.test((await head('/control.html', { 'x-forwarded-proto': 'https' })).get('strict-transport-security') || ''));
  const report = await fetch(`http://127.0.0.1:${port}/csp-report`, {
    method: 'POST', headers: { 'content-type': 'application/csp-report' },
    body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src-elem', 'blocked-uri': 'inline', 'document-uri': 'http://x/join.html' } }),
  });
  ok('and a browser\'s violation report is taken quietly', report.status === 204);
  proc.kill();
}

// --- a request line nobody could parse: answered, never fatal --------------
//
// `GET //` is not a URL at all and `GET /%FF` will not decode. Each used to
// throw out of the request (or upgrade) handler and end the process, rooms
// and open polls with it. Sent over a raw socket, because every HTTP client
// worth the name tidies such a path up before sending it.
{
  const { port, proc } = await startRelay({});
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const raw = (lines) => new Promise((resolve) => {
    const sock = connectTcp(port, '127.0.0.1');
    let got = '';
    sock.on('data', (d) => { got += d; });
    sock.on('close', () => resolve(got));
    sock.on('error', () => resolve(got));
    sock.on('connect', () => sock.write(`${lines.join('\r\n')}\r\n\r\n`));
    setTimeout(() => sock.destroy(), 2000);
  });
  const status = (reply) => Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] || 0);
  for (const target of ['//', '/%FF', '/%E0%A4%A', '/media/%FF', '/%FF/x.html']) {
    const reply = await raw([`GET ${target} HTTP/1.1`, 'Host: x', 'Connection: close']);
    ok(`GET ${target} is answered (${status(reply) || 'no answer'}), not fatal`, status(reply) >= 400 && status(reply) < 500);
  }
  for (const target of ['//', '/%FF?room=x']) {
    await raw([`GET ${target} HTTP/1.1`, 'Host: x', 'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==']);
  }
  const health = await raw(['GET /healthz HTTP/1.1', 'Host: x', 'Connection: close']);
  ok('and the relay is still up after all of them, upgrades included', !exited && status(health) === 200);
  proc.kill();
}

// --- the app's own files, by release (Issue #340) -----------------------------
{
  const { port, proc } = await startRelay({});
  const base = `http://127.0.0.1:${port}`;
  const get = async (route) => {
    const res = await fetch(`${base}${route}`);
    return { status: res.status, headers: res.headers, body: await res.text() };
  };
  const page = await get('/control.html');
  const id = /src="b\/([A-Za-z0-9_-]+)\/assets\/js\/control\.js"/.exec(page.body)?.[1];
  ok(`a page is sent with its assets under the release's address (b/${id}/assets/…)`, !!id && !/(src|href)="assets\//.test(page.body));
  ok('and the page itself is still asked about every time', page.headers.get('cache-control') === 'no-cache');
  const current = await get(`/b/${id}/assets/js/util.js`);
  const plain = await get('/assets/js/util.js');
  ok('an asset under the current release is kept for good', /immutable/.test(current.headers.get('cache-control') || '') && /max-age=31536000/.test(current.headers.get('cache-control')));
  ok('and is the same file as under its plain path, which is still no-cache', current.body === plain.body && plain.headers.get('cache-control') === 'no-cache');
  const old = await get('/b/notthisone1/assets/js/util.js');
  ok('an older release\'s address gets today\'s file, to be asked about again', old.status === 200 && old.body === plain.body && old.headers.get('cache-control') === 'no-cache');
  const outside = await get(`/b/${id}/control.html`);
  ok('only assets are kept for good under a release', outside.headers.get('cache-control') === 'no-cache');
  const csp = page.headers.get('content-security-policy-report-only') || '';
  const { createHash } = await import('node:crypto');
  const inline = [...page.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  ok('the page\'s inline scripts are allowed by the hash of what was sent', inline.every((h) => csp.includes(h)));
  const etag = page.headers.get('etag') || '';
  ok('and the page\'s validator names the release', etag.includes(id));
  proc.kill();
}

{
  // Nothing listening on this port at all - the same shape of failure as a
  // firewall rule or a proxy that never forwards the WS upgrade.
  const deadPort = await freePort();
  const result = await doctor.checkRelay(`http://127.0.0.1:${deadPort}/healthz`);
  ok(`a relay that answers nothing is reported bad, not silently skipped (${result.detail})`, result.level === 'bad');
}
{
  const result = await doctor.checkRelay('');
  ok('no health URL at all is a warning, not a crash', result.level === 'warn');
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
