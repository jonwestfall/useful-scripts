// Poll links made in advance (assets/js/poll-link.js): the code a key opens
// under, worked out the same way by the page that makes the link and by the
// relay that opens the poll - checked here against a real server process.
//
//   node podium/test/poll-link.test.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sha256, newPollKey, isPollKey, pollCodeForKey, isLinkCode, formatPollCode, pollLinkUrl, POLL_ALPHABET, LINK_CODE_LENGTH,
} from '../assets/js/poll-link.js';
import { PLAN_TYPES, readPlan, planToJson, newItem, withoutPollLinks } from '../assets/js/planfile.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

// --- SHA-256 against node's own ----------------------------------------------
{
  const hex = (bytes) => Buffer.from(bytes).toString('hex');
  const inputs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'héllo wörld ✓'];
  ok('sha256 matches node:crypto across padding boundaries and UTF-8', inputs.every((text) => {
    const bytes = new TextEncoder().encode(text);
    return hex(sha256(bytes)) === crypto.createHash('sha256').update(bytes).digest('hex');
  }));
}

// --- keys and codes ------------------------------------------------------------
{
  const key = newPollKey();
  ok('a new key is 32 base64url characters', /^[A-Za-z0-9_-]{32}$/.test(key) && isPollKey(key));
  ok('keys are not repeated', newPollKey() !== key);
  const code = pollCodeForKey(key);
  ok('a key opens under a ten-character code', code.length === LINK_CODE_LENGTH && isLinkCode(code));
  ok('…in the relay\'s own alphabet (no O/0, no I/1)', [...code].every((c) => POLL_ALPHABET.includes(c)));
  ok('the same key always gives the same code', pollCodeForKey(key) === code);
  ok('a different key gives a different code', pollCodeForKey(newPollKey()) !== code);
  ok('something that is not a key gives no code', pollCodeForKey('short') === '' && pollCodeForKey(null) === '' && pollCodeForKey('a b c d e f g h i j') === '');
  ok('a four-character code is not a link code', !isLinkCode('ABCD'));
  ok('the code reads as two groups of five', formatPollCode(code) === `${code.slice(0, 5)}-${code.slice(5)}`);
  ok('an ordinary code is shown as it is', formatPollCode('AB2C') === 'AB2C' && formatPollCode(undefined) === '');
  ok('the link is the relay\'s join page with the code', pollLinkUrl('https://podium.example.edu/', key) === `https://podium.example.edu/join.html?c=${code}`);
  ok('no relay, no link', pollLinkUrl(null, key) === '' && pollLinkUrl('https://x/', 'nope') === '');
  // A fixed vector, so a change to the derivation (which would break every
  // link already handed out) cannot pass unnoticed.
  ok('a known key gives its known code', pollCodeForKey('podium-test-key-0123456789') === pollCodeForKey('podium-test-key-0123456789')
    && pollCodeForKey('podium-test-key-0123456789') === expectedCode('podium-test-key-0123456789'));
}

// The derivation written out independently with node:crypto, as the server does it.
function expectedCode(key) {
  const digest = crypto.createHash('sha256').update(`podium-poll-link\n${key}`).digest();
  let bits = '';
  for (const byte of digest) bits += byte.toString(2).padStart(8, '0');
  let code = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i++) code += POLL_ALPHABET[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  return code;
}
ok('the browser derivation matches an independent one for many keys', Array.from({ length: 200 }, newPollKey).every((k) => pollCodeForKey(k) === expectedCode(k)));

// --- the plan keeps the key ------------------------------------------------------
{
  ok('a planned poll has a link field', PLAN_TYPES.poll.fields.some((f) => f.key === 'link' && f.kind === 'poll-link'));
  const key = newPollKey();
  const poll = { ...newItem('poll'), question: 'Which bias?', link: key };
  const bad = { ...newItem('poll'), question: 'Bad', link: 'javascript:alert(1)' };
  const { plan } = readPlan(JSON.stringify({ podium: 'plan', v: 1, title: 'T', items: [poll, bad] }));
  ok('a plan round-trips a poll\'s link', plan.items[0].link === key);
  ok('a link that is not a key is dropped on the way in', plan.items[1].link === '');
  const again = readPlan(planToJson(plan)).plan;
  ok('…and survives saving and reading again', again.items[0].link === key);
  withoutPollLinks(again);
  ok('a copy of the lecture leaves the links behind', again.items.every((i) => i.link === ''));
}

// --- the relay ------------------------------------------------------------------
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

async function startRelay() {
  const port = await freePort();
  const proc = spawn(process.execPath, ['podium-server.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(port), STATIC: '../' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), 10000);
    proc.stdout.on('data', (d) => { if (String(d).includes('podium relay')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error(`relay exited with ${code} - did you run npm install in podium/server?`)));
  });
  return { port, proc };
}

{
  const { port, proc } = await startRelay();
  const base = `http://127.0.0.1:${port}/poll`;
  const post = (body) => fetch(base, body === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const put = (code, token, body) => fetch(`${base}/${code}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  try {
    const plain = await (await post()).json();
    ok('a poll with no key still gets a four-character code', /^[A-Z2-9]{4}$/.test(plain.code) && !!plain.token);

    const key = newPollKey();
    const code = pollCodeForKey(key);
    ok('before it starts, the link\'s code is not a poll (the phone waits)', (await fetch(`${base}/${code}/stream`)).status === 404);

    const first = await (await post({ key })).json();
    ok('starting with a key opens the poll under the code the link names', first.code === code && !!first.token);
    await put(code, first.token, { kind: 'choice', question: 'Q1', options: ['a', 'b'], open: true });
    const vote = await fetch(`${base}/${code}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voter: 'v1', answer: 1 }) });
    ok('a phone at the link can answer', vote.ok);
    const results = await (await fetch(`${base}/${code}/results`, { headers: { authorization: `Bearer ${first.token}` } })).json();
    ok('…and the answer counts', results.voters === 1 && results.counts[1] === 1);

    const second = await (await post({ key })).json();
    ok('starting it again keeps the code and the host\'s token', second.code === code && second.token === first.token);
    const after = await (await fetch(`${base}/${code}/results`, { headers: { authorization: `Bearer ${first.token}` } })).json();
    ok('…and starts from zero, closed until it is set up again', after.voters === 0 && after.open === false && after.seq > results.seq);

    ok('a key that is not shaped like one is refused', (await post({ key: 'nope' })).status === 400);
    ok('a body that is not JSON is refused', (await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status === 400);
    ok('knowing the code is not the host\'s token', (await put(code, 'x'.repeat(32), { question: 'hijack', open: true })).status === 401);
  } finally {
    proc.kill();
  }
}

if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
