#!/usr/bin/env node
// Podium relay — the self-hosted alternative to Supabase or a public broker.
//
//   npm install && node podium-server.js
//
// It does three things: relay messages between the devices in a room,
// (optionally) serve the Podium pages themselves so the whole thing lives on
// your own box, and run audience polls.
//
// The first of those never sees plaintext - the browsers encrypt before
// sending, and this process has no key. The third one necessarily does: a
// student answering a question has no room passphrase and must not be given
// one, so their answer arrives here in the clear. That is the single
// exception, it is confined to the /poll routes, nothing it touches is ever
// written to disk, and none of it outlives this process.
//
//   PORT=8080            port to listen on
//   STATIC=../           directory to serve (omit to run relay-only)
//   ORIGIN=https://a.b   comma-separated allowed Origins (omit to allow any)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const STATIC = process.env.STATIC ? path.resolve(__dirname, process.env.STATIC) : null;
const ORIGINS = process.env.ORIGIN ? process.env.ORIGIN.split(',').map((s) => s.trim()) : null;

const MAX_MESSAGE = 256 * 1024;   // ink batches and SDP are the biggest things
const MAX_PER_ROOM = 12;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.woff2': 'font/woff2',
};

// --- audience polls ----------------------------------------------------------
//
// The one thing this relay is not merely a pipe for. Students have no room key
// - handing them one would hand them the projector, since knowing the
// passphrase is the whole of Podium's authorization - so their answers arrive
// here in the clear and are counted here. Nothing touches disk and nothing
// outlives this process: the display is what remembers a poll once it is over,
// the same as it is what remembers everything else that was on screen.
//
// A poll has two names. The CODE is public by design - it goes on a projector
// in front of a room - and is all it takes to see the question and answer it.
// The TOKEN, handed back once when the poll is created, is not: it is what
// separates "I am in this room" from "I am the one running this", so setting
// the question, reading the answers and ending the poll all require it.
// Without that split, anyone who could read the screen could also rewrite the
// question, or read answers the presenter had not chosen to show yet.

const POLL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no O/0, no I/1
const MAX_POLLS = 50;
const MAX_VOTERS = 500;            // per poll: a lecture hall, not a stadium
const MAX_ANSWER_CHARS = 200;
const MAX_OPTIONS = 8;
const POLL_TTL_MS = 12 * 60 * 60 * 1000;
const SSE_KEEPALIVE_MS = 25000;

const polls = new Map();

function makePollCode() {
  for (let i = 0; i < 50; i++) {
    const code = Array.from({ length: 4 }, () => POLL_ALPHABET[crypto.randomInt(POLL_ALPHABET.length)]).join('');
    if (!polls.has(code)) return code;
  }
  return null;
}

function pollJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('not JSON')); }
    });
    req.on('error', reject);
  });
}

// What a phone is told: the question, and nothing else. Whether the room sees
// the answers is the presenter's call, made on the display - so the tally
// never goes anywhere near the devices doing the answering.
function questionPayload(poll) {
  return JSON.stringify({
    seq: poll.seq, open: poll.open, kind: poll.kind,
    question: poll.question, options: poll.options,
  });
}

function pushQuestion(poll) {
  const data = questionPayload(poll);
  for (const listener of poll.listeners) {
    try { listener.write(`data: ${data}\n\n`); } catch { poll.listeners.delete(listener); }
  }
}

function reapPolls() {
  const cutoff = Date.now() - POLL_TTL_MS;
  for (const [code, poll] of polls) {
    if (poll.touched >= cutoff) continue;
    for (const listener of poll.listeners) { try { listener.end(); } catch { /* already gone */ } }
    polls.delete(code);
  }
}

async function handlePoll(req, res, url) {
  // ['', 'poll', code?, action?] - the leading empty segment is the path's
  // own leading slash.
  const [, , rawCode = '', action = ''] = url.pathname.split('/');
  const code = rawCode.toUpperCase();

  if (req.method === 'OPTIONS') {
    // The pages are normally served by this same process, so this is only
    // reached when they are not - a display on GitHub Pages talking to a
    // relay of its own, which the README has always described as a supported
    // way to run this.
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && !code) {
    reapPolls();
    if (polls.size >= MAX_POLLS) { pollJson(res, 503, { error: 'too many polls open' }); return; }
    const fresh = makePollCode();
    if (!fresh) { pollJson(res, 503, { error: 'no code available' }); return; }
    const token = crypto.randomBytes(24).toString('base64url');
    polls.set(fresh, {
      token, seq: 0, open: false, kind: 'choice', question: '', options: [],
      votes: new Map(), listeners: new Set(), touched: Date.now(),
    });
    pollJson(res, 200, { code: fresh, token });
    return;
  }

  const poll = polls.get(code);
  if (!poll) { pollJson(res, 404, { error: 'no such poll' }); return; }
  poll.touched = Date.now();

  const isHost = () => {
    const header = req.headers.authorization || '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const want = Buffer.from(poll.token);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  if (req.method === 'GET' && action === 'stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      // nginx buffers a proxied response by default, which for an event
      // stream means the phone hears nothing until the buffer fills.
      'x-accel-buffering': 'no',
    });
    res.write(`data: ${questionPayload(poll)}\n\n`);
    poll.listeners.add(res);
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* closing */ }
    }, SSE_KEEPALIVE_MS);
    req.on('close', () => { clearInterval(keepalive); poll.listeners.delete(res); });
    return;
  }

  // One answer each, last one wins: changing your mind before the question
  // closes is not cheating, and keying by the id the phone keeps is what stops
  // a double tap counting twice. It is not a guarantee and is not sold as one
  // - a private window is a new phone as far as this is concerned.
  if (req.method === 'POST' && action === 'vote') {
    let body;
    try { body = await readJson(req, 8 * 1024); } catch { pollJson(res, 400, { error: 'bad body' }); return; }
    if (!poll.open) { pollJson(res, 409, { error: 'this question is closed' }); return; }
    const voter = String(body.voter || '').slice(0, 64);
    if (!voter) { pollJson(res, 400, { error: 'no voter id' }); return; }
    if (!poll.votes.has(voter) && poll.votes.size >= MAX_VOTERS) { pollJson(res, 503, { error: 'this poll is full' }); return; }
    let answer;
    if (poll.kind === 'text') {
      answer = String(body.answer ?? '').trim().slice(0, MAX_ANSWER_CHARS);
      if (!answer) { pollJson(res, 400, { error: 'empty answer' }); return; }
    } else {
      answer = Number(body.answer);
      if (!Number.isInteger(answer) || answer < 0 || answer >= poll.options.length) {
        pollJson(res, 400, { error: 'not one of the options' });
        return;
      }
    }
    poll.votes.set(voter, answer);
    pollJson(res, 200, { ok: true, seq: poll.seq });
    return;
  }

  if (!isHost()) { pollJson(res, 401, { error: 'not the host of this poll' }); return; }

  if (req.method === 'PUT' && !action) {
    let body;
    try { body = await readJson(req); } catch { pollJson(res, 400, { error: 'bad body' }); return; }
    const kind = body.kind === 'text' ? 'text' : 'choice';
    const options = Array.isArray(body.options)
      ? body.options.slice(0, MAX_OPTIONS).map((option) => String(option).slice(0, MAX_ANSWER_CHARS))
      : [];
    const question = String(body.question || '').slice(0, 500);
    // A different question is a different count: rewording it, or changing
    // what can be answered, starts the tally again rather than blending two
    // questions' answers into one set of numbers.
    const changed = kind !== poll.kind || question !== poll.question
      || options.join(' ') !== poll.options.join(' ');
    if (changed) { poll.votes.clear(); poll.seq += 1; }
    poll.kind = kind;
    poll.question = question;
    poll.options = options;
    poll.open = body.open !== false;
    pushQuestion(poll);
    pollJson(res, 200, { seq: poll.seq, open: poll.open });
    return;
  }

  if (req.method === 'GET' && action === 'results') {
    const counts = poll.options.map(() => 0);
    const answers = [];
    for (const answer of poll.votes.values()) {
      if (poll.kind === 'text') answers.push(answer);
      else if (counts[answer] !== undefined) counts[answer] += 1;
    }
    pollJson(res, 200, { seq: poll.seq, open: poll.open, voters: poll.votes.size, counts, answers });
    return;
  }

  if (req.method === 'DELETE' && !action) {
    for (const listener of poll.listeners) { try { listener.end(); } catch { /* already gone */ } }
    polls.delete(code);
    pollJson(res, 200, { ok: true });
    return;
  }

  pollJson(res, 405, { error: 'not something a poll can do' });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok ${rooms.size} rooms, ${polls.size} polls\n`);
    return;
  }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/poll' || url.pathname.startsWith('/poll/')) {
    handlePoll(req, res, url).catch(() => {
      try { pollJson(res, 500, { error: 'poll failed' }); } catch { /* response already begun */ }
    });
    return;
  }
  if (!STATIC) { res.writeHead(404); res.end('not found'); return; }

  const requested = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const resolved = path.resolve(STATIC, `.${requested === '/' ? '/index.html' : requested}`);
  // Never serve outside the static root, whatever the request says.
  if (resolved !== STATIC && !resolved.startsWith(STATIC + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.stat(resolved, (err, stat) => {
    const file = !err && stat.isDirectory() ? path.join(resolved, 'index.html') : resolved;
    fs.stat(file, (statErr, info) => {
      if (statErr || !info.isFile()) { res.writeHead(404); res.end('not found'); return; }
      serve(req, res, file, info.size);
    });
  });
});

// Range support is not optional here: without it a browser reports a video's
// duration as Infinity and refuses to seek, so scrubbing a self-hosted clip
// from the iPad would silently do nothing.
function serve(req, res, file, size) {
  const headers = {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const [, rawStart, rawEnd] = range;
    let start = rawStart === '' ? size - Number(rawEnd) : Number(rawStart);
    let end = rawStart === '' || rawEnd === '' ? size - 1 : Number(rawEnd);
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'content-length': size });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
const rooms = new Map();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const room = (url.searchParams.get('room') || '').slice(0, 64);
  const origin = req.headers.origin;

  if (!room) { socket.destroy(); return; }
  if (ORIGINS && origin && !ORIGINS.includes(origin)) { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const peers = rooms.get(room) || new Set();
    if (peers.size >= MAX_PER_ROOM) { ws.close(1013, 'room full'); return; }
    peers.add(ws);
    rooms.set(room, peers);
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      for (const peer of peers) {
        if (peer !== ws && peer.readyState === peer.OPEN) peer.send(data, { binary: false });
      }
    });
    ws.on('close', () => {
      peers.delete(ws);
      if (!peers.size) rooms.delete(room);
    });
    ws.on('error', () => ws.terminate());
  });
});

// Campus Wi-Fi drops sockets without closing them; this reaps the dead ones.
const heartbeat = setInterval(() => {
  for (const peers of rooms.values()) {
    for (const ws of peers) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* about to be reaped anyway */ }
    }
  }
}, 25000);

server.on('close', () => clearInterval(heartbeat));
server.listen(PORT, () => {
  console.log(`podium relay on :${PORT}${STATIC ? ` (serving ${STATIC})` : ' (relay only)'}`);
});
