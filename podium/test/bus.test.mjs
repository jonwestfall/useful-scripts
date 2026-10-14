// The bus's answer to "did that go?", and big messages going as parts - with
// the real encryption and two real buses, over an in-memory transport rather
// than a relay.
//
//   node podium/test/bus.test.mjs

import { createBus, createAssembler, splitMessage, MAX_FRAME, PART_CHARS, MAX_PARTS } from '../assets/js/bus.js';
import { TRANSPORTS } from '../assets/js/transport/index.js';
import { sendOnce } from '../assets/js/assets.js';

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

// --- sendOnce -----------------------------------------------------------------

{
  const sent = new Set();
  ok('a send the transport refused is not counted as sent', !(await sendOnce(sent, 'a', () => Promise.resolve(false))) && !sent.has('a'));
  ok('nor one with no bus to send it on', !(await sendOnce(sent, 'a', () => undefined)) && !sent.has('a'));
  ok('nor one that threw', !(await sendOnce(sent, 'a', () => Promise.reject(new Error('boom')))) && !sent.has('a'));
  ok('one that went is counted', (await sendOnce(sent, 'a', () => Promise.resolve(true))) && sent.has('a'));
  let calls = 0;
  ok('and is not sent again', !(await sendOnce(sent, 'a', () => { calls++; return true; })) && calls === 0);

  let release;
  const slow = new Set();
  const first = sendOnce(slow, 'b', () => { calls++; return new Promise((r) => { release = r; }); });
  const second = await sendOnce(slow, 'b', () => { calls++; return true; });
  ok('a second push while the first is in flight does not send twice', !second && calls === 1);
  release(false);
  await first;
  ok('and a refusal of that first one leaves it free to go next time', !slow.has('b'));
}

// --- an in-memory transport ---------------------------------------------------

const hub = { peers: [], refuse: false, refuseAfter: Infinity, frames: [] };
TRANSPORTS.memory = {
  label: 'In-memory',
  load: async () => ({
    connect: async ({ onMessage, onStatus }) => {
      const me = { onMessage };
      hub.peers.push(me);
      onStatus('online');
      return {
        send(envelope) {
          if (hub.refuse || hub.frames.length >= hub.refuseAfter) return false;
          const text = JSON.stringify(envelope);
          hub.frames.push(text.length);
          for (const peer of hub.peers) if (peer !== me) setTimeout(() => peer.onMessage(JSON.parse(text)), 0);
          return true;
        },
        async close() { hub.peers.splice(hub.peers.indexOf(me), 1); },
      };
    },
  }),
};

const cfg = { transport: 'memory', room: 'bus-test', passphrase: 'correct horse' };
const got = [];
const display = await createBus({ cfg, role: 'display', onMessage: (msg) => got.push(msg) });
const control = await createBus({ cfg, role: 'control', onMessage: () => {} });
const reset = () => { hub.frames = []; hub.refuse = false; hub.refuseAfter = Infinity; got.length = 0; };

// --- what send() resolves to --------------------------------------------------

reset();
ok('send() resolves true when the transport takes the message', (await control.send({ t: 'asset', id: 'x', data: 'small' })) === true);
hub.refuse = true;
ok('and false when it refuses it', (await control.send({ t: 'asset', id: 'x', data: 'small' })) === false);

// --- big messages -------------------------------------------------------------

// A lecture plan's photo at the most planfile.js lets through.
reset();
const photo = `data:image/jpeg;base64,${'Q'.repeat(320 * 1024)}`;
ok('a 320 K-character photo is reported sent', (await control.send({ t: 'asset', id: 'p1', data: photo })) === true);
ok(`and went as parts, every one inside the relay's limit (${hub.frames.length} frames, largest ${Math.max(...hub.frames)} chars)`,
  hub.frames.length > 1 && Math.max(...hub.frames) <= MAX_FRAME);
await until(() => got.some((m) => m.id === 'p1'));
const arrived = got.find((m) => m.id === 'p1');
ok('and arrives whole, as the message that was sent', arrived?.id === 'p1' && arrived.data === photo && arrived.from === control.clientId && arrived.role === 'control');
ok('with no part of it reaching the page itself', !got.some((m) => m.t === 'part'));

// A deck that seals larger per character than any photo: quotes and
// backslashes to escape twice over, and characters three bytes long.
reset();
const deck = `# Title\n\n${'He said "\\x" — 漢字かな 🎓\n'.repeat(9000)}`;
await control.send({ t: 'deck', id: 'd1', source: deck });
ok(`a deck heavy in escapes and wide characters stays inside the limit too (largest ${Math.max(...hub.frames)} chars)`, Math.max(...hub.frames) <= MAX_FRAME);
await until(() => got.some((m) => m.id === 'd1'));
ok('and arrives intact', got.find((m) => m.id === 'd1')?.source === deck);

reset();
await control.send({ t: 'deck', id: 'd2', source: 'short' });
ok('a small message still goes as one frame, not parts', hub.frames.length === 1);

reset();
hub.refuseAfter = 2;
ok('a big message whose later part is refused is reported not sent', (await control.send({ t: 'asset', id: 'p2', data: photo })) === false);
ok('and stops at the refusal', hub.frames.length === 2);

reset();
const huge = 'Z'.repeat(PART_CHARS * (MAX_PARTS + 1));
ok('a message too big even in parts is refused', (await control.send({ t: 'asset', id: 'p3', data: huge })) === false && hub.frames.length === 0);

// Addressed to someone else: dropped before anything is held for it.
reset();
await control.send({ t: 'asset', id: 'p4', data: photo, to: 'somebody-else' });
await new Promise((r) => setTimeout(r, 100));
ok('parts addressed to another device are not delivered here', !got.some((m) => m.id === 'p4'));

await control.close();
await display.close();

// --- the assembler on its own -------------------------------------------------

{
  const text = JSON.stringify({ t: 'asset', id: 'z', data: 'y'.repeat(PART_CHARS * 2 + 5), from: 'A' });
  const slices = splitMessage(text);
  const parts = slices.map((s, i) => ({ t: 'part', pid: 'p', i, n: slices.length, s, from: 'A' }));
  ok('splitMessage cuts a message into PART_CHARS slices', slices.length === 3 && slices.join('') === text);

  let assemble = createAssembler();
  const results = [parts[2], parts[0], parts[0], parts[1]].map(assemble);
  ok('parts out of order and repeated still come together once', results.slice(0, 3).every((r) => r === null) && results[3]?.id === 'z');

  assemble = createAssembler();
  const forged = parts.map((p) => ({ ...p, from: 'B' }));
  ok('a whole that names a different sender than its parts is dropped', forged.map(assemble).every((r) => r === null));

  assemble = createAssembler();
  ok('a part claiming more than MAX_PARTS is dropped', assemble({ ...parts[0], n: MAX_PARTS + 1 }) === null);
  ok('as is one with an index out of range', assemble({ ...parts[0], i: 3 }) === null);

  let clock = 0;
  assemble = createAssembler({ now: () => clock });
  assemble(parts[0]);
  assemble(parts[1]);
  clock = 60000;
  ok('a message that lost a part is given up on, not held for ever', assemble(parts[2]) === null);
}

if (fails.length) {
  console.error(`\n${fails.length} failed`);
  process.exit(1);
}
console.log('\nall passed');
