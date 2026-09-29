// The WebSocket relay's own limits, with a real server process and real
// sockets but no browser - podium-server.js had no direct test coverage of
// any kind before this (see Issue #112/#122). Room names are not secret
// (only the passphrase is), so these are the guards against an attacker who
// knows or guesses one, or who just floods the upgrade path.
//
//   node podium/test/relay.test.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
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

// Opens a socket and waits briefly to see how the server actually responded:
// a clean handshake that stays open, a handshake that opens and is then
// closed with a code (MAX_PER_ROOM/MAX_ROOMS - the connection completed,
// the relay is declining it), or the raw socket being destroyed mid-upgrade
// (the per-IP throttle - never even gets to a WebSocket close code).
function connect(port, room, { cookie } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/podium?room=${encodeURIComponent(room)}`,
      cookie ? { headers: { cookie } } : undefined);
    const result = { ws, opened: false, closeCode: null, closeReason: '', errored: false };
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(result); } };
    ws.on('open', () => { result.opened = true; });
    ws.on('close', (code, reason) => { result.closeCode = code; result.closeReason = reason.toString(); finish(); });
    ws.on('error', () => { result.errored = true; finish(); });
    setTimeout(finish, 500);
  });
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
  await new Promise((r) => setTimeout(r, 300));
  ok('and the pass is worth nothing once the display stands down', (await get('/content/decks/example-builds.md')).status === 401);

  for (const p of [early, control, display, viewer]) p.ws.terminate();
  proc.kill();
  rmSync(dataDir, { recursive: true, force: true });
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
