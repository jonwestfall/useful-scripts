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
function connect(port, room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/podium?room=${encodeURIComponent(room)}`);
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
