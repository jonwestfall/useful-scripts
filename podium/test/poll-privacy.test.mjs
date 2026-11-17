// What the relay's poll routes tell a phone, and who may open polls on it,
// with a real server process and plain HTTP - no browser.
//
//   - A Q&A feed sent to phones carries the questions the room may see, how
//     many upvoted each and whether THIS phone did. Never an asker's device
//     id (holding it is voting as them), their name, who upvoted, or a
//     question the presenter hid.
//   - Opening a poll needs no account, so one address may only hold a few
//     open at once; a signed-in person is not counted.
//
//   node podium/test/poll-privacy.test.mjs

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

async function startRelay(env) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['podium-server.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', STATIC: '../', LIVE_BROWSER: 'off', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), 10000);
    proc.stdout.on('data', (d) => { if (String(d).includes('podium relay')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error(`relay exited with ${code} - did you run npm install in podium/server?`)));
  });
  return { base: `http://127.0.0.1:${port}`, proc };
}

const call = async (base, route, { method = 'GET', body, token, cookie } = {}) => {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

/** The first event on a poll's stream, as a phone with this voter id gets it. */
async function firstEvent(base, code, voter) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/poll/${code}/stream${voter ? `?voter=${encodeURIComponent(voter)}` : ''}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  ctrl.abort();
  return JSON.parse(text.slice(text.indexOf('data: ') + 6, text.indexOf('\n\n')));
}

// --- the Q&A feed a phone is sent ------------------------------------------
{
  const { base, proc } = await startRelay({});
  const { body: made } = await call(base, '/poll', { method: 'POST', body: {} });
  await call(base, `/poll/${made.code}`, { method: 'PUT', token: made.token, body: { kind: 'qna', question: 'Questions?', askName: true } });
  const ask = (voter, name, text) => call(base, `/poll/${made.code}/vote`, { method: 'POST', body: { voter, name, answer: { action: 'ask', text } } });
  await ask('device-of-alice', 'Alice Smith', 'Will this be on the exam?');
  await ask('device-of-bob', 'Bob Jones', 'Something embarrassing');
  const host = await call(base, `/poll/${made.code}/results`, { token: made.token });
  const [first, second] = host.body.qnaFeed;
  await call(base, `/poll/${made.code}/vote`, { method: 'POST', body: { voter: 'device-of-carol', answer: { action: 'upvote', id: first.id } } });
  await call(base, `/poll/${made.code}/qna-action`, { method: 'POST', token: made.token, body: { id: second.id, type: 'hidden', value: true } });

  const carol = await firstEvent(base, made.code, 'device-of-carol');
  const raw = JSON.stringify(carol);
  ok('a phone is sent the questions the room may see', carol.qnaFeed.length === 1 && carol.qnaFeed[0].text === 'Will this be on the exam?');
  ok('never a question the presenter hid', !raw.includes('Something embarrassing'));
  ok('never an asker\'s device id or name', !raw.includes('device-of-') && !raw.includes('Alice') && !raw.includes('Bob'));
  ok('only how many upvoted, and whether this phone did', carol.qnaFeed[0].votes === 1 && carol.qnaFeed[0].upvoted === true && !('upvotes' in carol.qnaFeed[0]));
  const dave = await firstEvent(base, made.code, 'device-of-dave');
  ok('another phone sees the same count, not as its own upvote', dave.qnaFeed[0].votes === 1 && dave.qnaFeed[0].upvoted === false);
  const nobody = await firstEvent(base, made.code, '');
  ok('and a stream opened with no id still gets the feed', nobody.qnaFeed.length === 1 && nobody.qnaFeed[0].upvoted === false);
  const hostAfter = await call(base, `/poll/${made.code}/results`, { token: made.token });
  ok('the host still has the whole feed, names and all', hostAfter.body.qnaFeed.length === 2 && hostAfter.body.qnaFeed[0].authorName === 'Alice Smith');
  proc.kill();
}

// --- how many polls one address may open -----------------------------------
{
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-poll-privacy-'));
  execFileSync(process.execPath, ['podium-admin.js', 'user', 'add', 'teacher', '--password-stdin'], {
    cwd: path.join(ROOT, 'server'), env: { ...process.env, DATA_DIR: data }, input: 'a good long password\n', stdio: ['pipe', 'ignore', 'ignore'],
  });
  const { base, proc } = await startRelay({ DATA_DIR: data, MAX_ANON_POLLS_PER_IP: '3' });
  const opened = [];
  for (let i = 0; i < 3; i++) opened.push(await call(base, '/poll', { method: 'POST', body: {} }));
  ok('an address with no account may open a few polls', opened.every((r) => r.status === 200 && r.body.code));
  const fourth = await call(base, '/poll', { method: 'POST', body: {} });
  ok(`but not more than its share (${fourth.status}: ${fourth.body.error})`, fourth.status === 429);
  const linked = await call(base, '/poll', { method: 'POST', body: { key: 'a-planned-poll-link-key-123' } });
  ok('a planned link\'s poll counts too', linked.status === 429);
  await call(base, `/poll/${opened[0].body.code}`, { method: 'DELETE', token: opened[0].body.token });
  const again = await call(base, '/poll', { method: 'POST', body: {} });
  ok('ending one makes room for another', again.status === 200);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'teacher', password: 'a good long password' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const signedIn = [];
  for (let i = 0; i < 4; i++) signedIn.push(await call(base, '/poll', { method: 'POST', body: {}, cookie }));
  ok('someone signed in is not held to it', signedIn.every((r) => r.status === 200));
  proc.kill();
  fs.rmSync(data, { recursive: true, force: true });
}

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
