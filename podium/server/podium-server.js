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
// Give it a DATA_DIR and it gains a fourth: remembering things. That is the
// server-backed deployment, and it is entirely optional - see VPS.md.
//
//   PORT=8080            port to listen on
//   HOST=127.0.0.1       address to bind (omit to accept from anywhere)
//   STATIC=../           directory to serve (omit to run relay-only)
//   ORIGIN=https://a.b   comma-separated allowed Origins (omit to allow any)
//   DATA_DIR=/var/lib/podium   where accounts and uploads live (omit for none)
//   AUTH_PASSWORD=...    put the pages (not join.html) behind HTTP Basic Auth
//   AUTH_USER=podium     username to go with it (default: podium)

// node:sqlite is experimental in Node 22 and says so, once, on stderr. It is
// an accurate warning about a module whose API may change and a useless one in
// a log that someone has to read every morning, so it is swallowed by name
// here and every other warning is printed exactly as Node would have.
//
// Node prints warnings through a listener of its own, so adding one is not
// enough - the default has to come off first. Deliberately narrow: anything
// that is not this one specific notice still reaches the log.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  console.warn(warning.stack || String(warning));
});

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { WebSocketServer } = require('ws');
const store = require('./store.js');
const accounts = require('./accounts.js');
const api = require('./api.js');
const library = require('./library.js');
const lectures = require('./lectures.js');

const PORT = Number(process.env.PORT || 8080);
// Unset means every interface, which is what running this on a laptop for a
// room on the same Wi-Fi needs. A deployment with a TLS terminator in front
// wants 127.0.0.1 so the only way in is through it; deploy/install.sh writes
// that into the environment file, because on that box it is the right answer
// and the wildcard would expose the plain-HTTP port alongside the proxy.
const HOST = process.env.HOST || '';
const STATIC = process.env.STATIC ? path.resolve(__dirname, process.env.STATIC) : null;
const ORIGINS = process.env.ORIGIN ? process.env.ORIGIN.split(',').map((s) => s.trim()) : null;

const MAX_MESSAGE = 256 * 1024;   // ink batches and SDP are the biggest things
const MAX_PER_ROOM = 12;

// --- authentication (self-hosted pages only) ---------------------------------
//
// Off by default, like everything else here. Two ways to turn it on, and they
// are tried in a fixed order (see api.js): accounts in the database if there
// are any, otherwise AUTH_PASSWORD's HTTP Basic Auth if that is set. Either
// way it gates every page this process serves - the landing page, the display,
// the controller, the planning page, and every asset any of them load - which
// matters once this box is serving them itself from a plain domain rather than
// GitHub Pages' effectively unguessable URL. The room passphrase is what
// authorizes *control*; this is a coarser gate on who can load the tool at all.
//
// join.html is the deliberate exception, along with what it needs to run
// (assets/js/join.js) and the relay's own /poll routes: a room full of
// students answering a question must never be asked to log in, and has no
// password to give anyway - see the comment at the top of handlePoll.
// login.html is open for the obvious reason, and is self-contained so that
// nothing it needs is behind the gate it exists to get you through.
// /favicon.ico is open too, so a browser's automatic request for one on the
// (credential-free) join page gets a plain 404 rather than a login challenge.
//
// Basic Auth cannot reach the relay's own WebSocket route - browsers give page
// script no way to attach an Authorization header to a handshake. A cookie has
// no such problem, so once there are accounts the socket is gated too, which
// closes the one hole the AUTH_PASSWORD version had to leave open.
const AUTH_USER = process.env.AUTH_USER || 'podium';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const AUTH_OPEN_PATHS = new Set(['/join.html', '/assets/js/join.js', '/login.html', '/favicon.ico']);

/**
 * The build this PROCESS is serving, read once at startup and reported on
 * /healthz.
 *
 * Not decoration. A release goes live by flipping a symlink, and a service
 * resolves that symlink once - when it starts. Flip it without restarting and
 * every file on disk is the new release, every diagnostic agrees, and the code
 * answering requests is last week's. The only way to tell from outside is to
 * ask the process itself, and /healthz is the one route that answers without a
 * login (see podium-admin doctor, which compares this against the release it is
 * part of). The number is on every page already; it is not a secret.
 */
const SERVED = (() => {
  if (!STATIC) return { build: null, version: null, commit: null };
  try {
    const source = fs.readFileSync(path.join(STATIC, 'assets', 'js', 'protocol.js'), 'utf8');
    return {
      build: Number(source.match(/BUILD\s*=\s*(\d+)/)?.[1]) || null,
      // The release, for anybody asking what this box runs rather than
      // chasing a stale cache - the question the build number cannot answer.
      version: source.match(/VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] || null,
      commit: source.match(/COMMIT\s*=\s*['"]([^'"]+)['"]/)?.[1] || null,
    };
  } catch {
    return { build: null, version: null, commit: null };
  }
})();

const DATA_DIR = store.dataDirFromEnv();

// Configured storage that will not open is a hard stop, not a warning. Whether
// there is a database is what decides whether the account gate governs, so
// carrying on without one would answer "is this instance protected?" with
// "no" - quietly, at the exact moment something is already wrong with the box.
let db = null;
try {
  db = store.open(DATA_DIR);
} catch (err) {
  console.error(`podium: ${err.message}`);
  console.error('podium: DATA_DIR is set, so refusing to start without it - a server that has forgotten its accounts is an open one.');
  process.exit(1);
}

// Deliberately every account, disabled ones included: see countUsers.
const hasAccounts = () => !!db && accounts.countUsers(db) > 0;
const authContext = {
  db,
  dataDir: DATA_DIR,
  staticDir: STATIC || path.resolve(__dirname, '..'),
  hasAccounts,
  basicPassword: AUTH_PASSWORD,
  isBasicAuthorized: (req) => isAuthorized(req),
  openPaths: AUTH_OPEN_PATHS,
};

function timingSafeEqualString(given, want) {
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const sep = decoded.indexOf(':');
  const user = sep === -1 ? decoded : decoded.slice(0, sep);
  const pass = sep === -1 ? '' : decoded.slice(sep + 1);
  return timingSafeEqualString(user, AUTH_USER) && timingSafeEqualString(pass, AUTH_PASSWORD);
}

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
  '.flac': 'audio/flac', '.aac': 'audio/aac',
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

const { readJson } = api;

// What a phone is told: the question, and nothing else. Whether the room sees
// the answers is the presenter's call, made on the display - so the tally
// never goes anywhere near the devices doing the answering.
function questionPayload(poll) {
  return JSON.stringify({
    seq: poll.seq, open: poll.open, kind: poll.kind,
    question: poll.question, options: poll.options, closesAt: poll.closesAt,
    qnaFeed: poll.qnaFeed ? poll.qnaFeed.map(q => ({ ...q, upvotes: Array.from(q.upvotes) })) : [],
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
      votes: new Map(), qnaFeed: [], listeners: new Set(), touched: Date.now(),
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
    if (!poll.open || (poll.closesAt && Date.now() > poll.closesAt)) { pollJson(res, 409, { error: 'this question is closed' }); return; }
    const voter = String(body.voter || '').slice(0, 64);
    if (!voter) { pollJson(res, 400, { error: 'no voter id' }); return; }
    if (!poll.votes.has(voter) && poll.votes.size >= MAX_VOTERS) { pollJson(res, 503, { error: 'this poll is full' }); return; }
    let answer;
    if (poll.kind === 'qna') {
      const act = body.answer?.action;
      if (act === 'ask') {
        const text = String(body.answer?.text ?? '').trim().slice(0, MAX_ANSWER_CHARS);
        if (!text) { pollJson(res, 400, { error: 'empty question' }); return; }
        if (poll.qnaFeed.length >= MAX_VOTERS) { pollJson(res, 503, { error: 'too many questions' }); return; }
        const id = crypto.randomBytes(8).toString('hex');
        poll.qnaFeed.push({ id, text, author: voter, upvotes: new Set(), hidden: false, answered: false, projected: false });
        pushQuestion(poll);
      } else if (act === 'upvote') {
        const id = String(body.answer?.id ?? '');
        const q = poll.qnaFeed.find((x) => x.id === id);
        if (!q) { pollJson(res, 404, { error: 'question not found' }); return; }
        if (q.upvotes.has(voter)) q.upvotes.delete(voter);
        else q.upvotes.add(voter);
        pushQuestion(poll);
      } else {
        pollJson(res, 400, { error: 'invalid qna action' }); return;
      }
      poll.votes.set(voter, true); // just record participation
      pollJson(res, 200, { ok: true, seq: poll.seq });
      return;
    } else if (poll.kind === 'text') {
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

  if (req.method === 'POST' && action === 'qna-action') {
    let body;
    try { body = await readJson(req); } catch { pollJson(res, 400, { error: 'bad body' }); return; }
    const { id, type, value } = body;
    const q = poll.qnaFeed.find((x) => x.id === id);
    if (!q) { pollJson(res, 404, { error: 'question not found' }); return; }
    if (type === 'hidden') q.hidden = !!value;
    else if (type === 'answered') q.answered = !!value;
    else if (type === 'projected') {
      poll.qnaFeed.forEach((x) => { x.projected = false; });
      q.projected = !!value;
    }
    pushQuestion(poll);
    pollJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'PUT' && !action) {
    let body;
    try { body = await readJson(req); } catch { pollJson(res, 400, { error: 'bad body' }); return; }
    const kind = ['text', 'qna'].includes(body.kind) ? body.kind : 'choice';
    const options = Array.isArray(body.options)
      ? body.options.slice(0, MAX_OPTIONS).map((option) => String(option).slice(0, MAX_ANSWER_CHARS))
      : [];
    const question = String(body.question || '').slice(0, 500);
    // A different question is a different count: rewording it, or changing
    // what can be answered, starts the tally again rather than blending two
    // questions' answers into one set of numbers.
    const changed = kind !== poll.kind || question !== poll.question
      || options.join(' ') !== poll.options.join(' ');
    if (changed) { poll.votes.clear(); poll.qnaFeed = []; poll.seq += 1; }
    poll.kind = kind;
    poll.question = question;
    poll.options = options;
    poll.open = body.open !== false;
    poll.closesAt = Number.isFinite(Number(body.closesAt)) && body.closesAt > 0 ? Number(body.closesAt) : null;
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
    const qnaFeed = poll.qnaFeed ? poll.qnaFeed.map(q => ({ ...q, upvotes: Array.from(q.upvotes) })) : [];
    pollJson(res, 200, { seq: poll.seq, open: poll.open, closesAt: poll.closesAt, voters: poll.votes.size, counts, answers, qnaFeed });
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
    // "build N" stays spelled exactly this way: doctor's checkBuild reads it
    // back out of this line to compare against the release on disk.
    res.end(`ok Podium ${SERVED.version ?? '?'}, build ${SERVED.build ?? '?'}, ${rooms.size} rooms, ${polls.size} polls\n`);
    return;
  }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/poll' || url.pathname.startsWith('/poll/')) {
    handlePoll(req, res, url).catch(() => {
      try { pollJson(res, 500, { error: 'poll failed' }); } catch { /* response already begun */ }
    });
    return;
  }
  // Answered whether or not this process serves the pages: a display on
  // GitHub Pages pointed at this relay still needs to be able to ask what it
  // can do here.
  // Not routed through handleApi because it answers with a file rather than
  // JSON, and a consistent-looking API is not worth a second file-streaming
  // path. See serveBackup.
  if (url.pathname === '/api/backup' && req.method === 'GET') {
    serveBackup(req, res).catch(() => {
      try { api.json(res, 500, { error: 'could not take a copy of the database' }); } catch { /* response already begun */ }
    });
    return;
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    api.handleApi(req, res, url, authContext).catch(() => {
      try { api.json(res, 500, { error: 'request failed' }); } catch { /* response already begun */ }
    });
    return;
  }
  // Uploaded files. Served from this origin, which is why the headers below
  // are not optional - see serveMedia.
  if (url.pathname.startsWith('/media/')) { serveMedia(req, res, url); return; }

  if (!STATIC) { res.writeHead(404); res.end('not found'); return; }

  const requested = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!api.gate(req, res, requested, authContext)) return;
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

/**
 * An uploaded file, from the library.
 *
 * These bytes came from a person, and they are served from the same origin as
 * the controller and the display - so if a browser could ever be talked into
 * executing one, it would run with the session cookie and the projector inside
 * its reach. Three things stop that, and all three matter:
 *
 *   - library.js only accepts extensions that nothing executes (no .html,
 *     .svg, .js, .xml), and the type served is the one the extension implies,
 *     never the one the uploader declared;
 *   - nosniff, so a browser cannot decide a .png is really something else;
 *   - a sandboxing CSP, which leaves anything that slipped past the first two
 *     with no scripts, no origin, and nothing to talk to.
 *
 * The path carries the SHA-256 of the contents, so the bytes behind a URL can
 * never change and the cache can be told to keep them forever.
 */
function serveMedia(req, res, url) {
  if (!db) { res.writeHead(404); res.end('not found'); return; }
  const user = accounts.sessionUser(db, api.cookieToken(req));
  if (!user) { api.json(res, 401, { error: 'not signed in' }); return; }

  const sha256 = url.pathname.split('/')[2] || '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) { res.writeHead(404); res.end('not found'); return; }
  if (!library.mayReadMedia(db, user, sha256)) { res.writeHead(404); res.end('not found'); return; }

  const row = db.prepare('SELECT * FROM media WHERE sha256 = ?').get(sha256);
  const file = library.mediaPath(DATA_DIR, sha256);

  // The bytes behind a hash never change, so the temptation is to let the
  // browser keep them for a year. That would be wrong: a cached copy is served
  // without asking this process anything, so it would outlive being removed
  // from the course, the item being deleted, and signing out. `no-cache` still
  // lets the browser STORE it - it just has to ask first, and asking is where
  // the check above happens. An ETag makes that question cheap: one 304 rather
  // than a lecture's worth of video again.
  const etag = `"${sha256}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'private, no-cache' });
    res.end();
    return;
  }

  // The type follows the name in the URL rather than the row, because one set
  // of bytes can be shared by several items: media is deduplicated by hash, so
  // the same file uploaded as a .md and again as a .pdf has one row carrying
  // whichever type arrived first. Deriving it from the requested filename, and
  // only ever through the same allow-list the upload went through, gives each
  // item the type its own name implies.
  const byName = library.uploadKindFor(decodeURIComponent(url.pathname.split('/')[3] || ''));

  fs.stat(file, (err, info) => {
    if (err || !info.isFile()) { res.writeHead(404); res.end('not found'); return; }
    serve(req, res, file, info.size, {
      'content-type': byName?.type || row.content_type,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-cache',
      etag,
    });
  });
}

/**
 * A copy of the database, taken safely while the server is running.
 *
 * `VACUUM INTO` is the reason this is three lines rather than a stop-the-world
 * problem: SQLite writes a consistent snapshot of the whole database to a new
 * file, taking its own locks, with WAL and concurrent writers and all. Copying
 * podium.db with `cp` while the process is up would not be safe; this is.
 *
 * What it is NOT is a whole backup, and the page that offers it says so plainly:
 * uploaded files and session photos live on disk beside the database, not inside
 * it. The database alone restores your accounts, courses, settings, library
 * ENTRIES and session timelines, and leaves every one of those entries pointing
 * at bytes that are not there. Backing up the whole DATA_DIR is what deploy/
 * documents.
 *
 * Administrators only. It carries password hashes and every room's passphrase.
 */
// The worker VACUUM INTO runs in. node:sqlite's DatabaseSync is exactly
// that - synchronous - so running it on this process's own thread would
// block the event loop for the whole snapshot: every relay message and every
// other request on hold until an administrator's backup download finishes,
// which for a large database is not a rounding error. A worker thread opens
// its OWN connection to the same file (SQLite's WAL mode is built for
// concurrent readers, which is all VACUUM INTO's source side needs) and does
// the blocking work there, leaving this thread free to keep serving the room
// while it runs.
function vacuumInto(source, destination) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      try {
        const db = new DatabaseSync(workerData.source, { readOnly: true });
        // A quoted string literal, not a bound parameter: VACUUM INTO takes
        // no parameters. Both paths are this process's own, built from
        // DATA_DIR and random bytes, so there is nothing of anyone else's in
        // them to quote wrong.
        db.exec(\`VACUUM INTO '\${workerData.destination.replace(/'/g, "''")}'\`);
        db.close();
        parentPort.postMessage({ ok: true });
      } catch (err) {
        parentPort.postMessage({ ok: false, message: err.message });
      }
    `, { eval: true, workerData: { source, destination } });
    worker.once('message', (msg) => {
      worker.terminate();
      if (msg.ok) resolve(); else reject(new Error(msg.message));
    });
    worker.once('error', (err) => { worker.terminate(); reject(err); });
  });
}

async function serveBackup(req, res) {
  if (!db || !DATA_DIR) { res.writeHead(404); res.end('not found'); return; }
  const user = accounts.sessionUser(db, api.cookieToken(req));
  if (!user) { api.json(res, 401, { error: 'not signed in' }); return; }
  if (!user.isAdmin) { api.json(res, 403, { error: 'only an administrator can download a backup' }); return; }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const temp = path.join(DATA_DIR, `.backup-${crypto.randomBytes(6).toString('hex')}.db`);
  // Declared before the VACUUM even runs, and used in its catch too: a
  // VACUUM INTO that dies partway (a full disk, most likely) can still have
  // written a partial file at `temp` before throwing, and leaving THAT behind
  // is the same slow leak this whole cleanup exists to prevent - repeated
  // failed downloads filling the disk the backup endpoint is meant to protect.
  const drop = () => { try { fs.rmSync(temp, { force: true }); } catch { /* gone already, or never written */ } };
  try {
    await vacuumInto(path.join(DATA_DIR, 'podium.db'), temp);
  } catch (err) {
    drop();
    console.error(`podium: backup failed (${err.message})`);
    api.json(res, 500, { error: 'could not take a copy of the database' });
    return;
  }

  fs.stat(temp, (err, info) => {
    if (err) { drop(); api.json(res, 500, { error: 'could not take a copy of the database' }); return; }
    accounts.logEvent(db, {
      userId: user.id, username: user.username,
      action: 'backup_downloaded',
      ip: api.clientIp(req), userAgent: req.headers['user-agent'],
      details: { bytes: info.size }
    });
    res.writeHead(200, {
      'content-type': 'application/vnd.sqlite3',
      'content-length': info.size,
      'content-disposition': `attachment; filename="podium-${stamp}.db"`,
      'cache-control': 'no-store',
    });
    const stream = fs.createReadStream(temp);
    stream.pipe(res);
    // Whichever way this ends - sent, or a browser that went away mid-download
    // - the snapshot goes. A DATA_DIR quietly filling with abandoned copies of
    // itself is a good way to run a box out of disk.
    stream.on('close', drop);
    stream.on('error', () => { drop(); res.destroy(); });
    res.on('close', drop);
  });
}

// Range support is not optional here: without it a browser reports a video's
// duration as Infinity and refuses to seek, so scrubbing a self-hosted clip
// from the iPad would silently do nothing.
function serve(req, res, file, size, overrides = {}) {
  const headers = {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache',
    ...overrides,
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
  // The one thing HTTP Basic Auth could never cover. A browser will not let
  // page script set an Authorization header on a handshake, but it attaches
  // cookies to a same-origin one without being asked - so once this instance
  // has accounts, knowing a room name is no longer enough to join its relay.
  //
  // A deployment that serves the pages from somewhere else (GitHub Pages
  // talking to this relay) has no same-origin cookie to send: such an instance
  // wants ORIGIN rather than accounts. See VPS.md.
  if (hasAccounts() && !accounts.sessionUser(db, api.cookieToken(req))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

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

const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS || 90);

// Expired rows are harmless but they accumulate for as long as the box runs,
// and a login table nobody ever sweeps is a login table nobody can read.
const sessionSweep = db ? setInterval(() => {
  try { accounts.pruneSessions(db); } catch { /* the next sweep can have it */ }
  if (LOG_RETENTION_DAYS > 0) {
    try { accounts.pruneLogs(db, Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000); } catch { /* next sweep */ }
  }
}, 60 * 60 * 1000) : null;
sessionSweep?.unref();

// The retention control. Photos and rasterized slides are the two payloads that
// grow without bound, so they age out; a lecture's TIMELINE and its poll results
// do not, because they are a few hundred short rows and are exactly what somebody
// wants three years later when asked what a course covered.
//
// Unset means keep everything, which is the right default for a box one person
// runs for their own teaching: a retention policy that deleted a term's photos
// because nobody had read the documentation would be the worse mistake.
const LECTURE_RETENTION_DAYS = Number(process.env.LECTURE_RETENTION_DAYS || 0);

function pruneLectureFiles() {
  if (!db || !DATA_DIR || !(LECTURE_RETENTION_DAYS > 0)) return;
  try {
    const { removed, bytes } = lectures.pruneFiles(db, DATA_DIR, { days: LECTURE_RETENTION_DAYS });
    if (removed) {
      console.log(`podium: retention removed ${removed} session file(s) older than `
        + `${LECTURE_RETENTION_DAYS} days, freeing ${Math.round(bytes / 1024 / 1024)} MB`);
    }
  } catch (err) {
    console.error(`podium: session retention sweep failed (${err.message})`);
  }
}

const retentionSweep = db ? setInterval(pruneLectureFiles, 24 * 60 * 60 * 1000) : null;
retentionSweep?.unref();

// Every way a lecture can end without anybody saying so: a closed laptop, a
// browser that crashed, a machine that went to sleep between two classes in
// the same room. Standing down remains the precise answer and closes one
// immediately; this closes the rest, dated to the last time the display said
// it was there rather than to whenever this ran.
//
// Once a minute, rather than only at the next Go live in that room - which
// could be next week, and until then the session sits open in everybody's
// list looking like a class still in progress.
function sweepIdleLectures() {
  if (!db) return;
  try {
    const { closed, discarded } = lectures.closeIdleLectures(db, DATA_DIR);
    if (closed || discarded) {
      console.log(`podium: closed ${closed} session(s) nobody was teaching any more`
        + `${discarded ? `, and discarded ${discarded} that recorded nothing` : ''}`);
    }
  } catch (err) {
    console.error(`podium: idle session sweep failed (${err.message})`);
  }
}

const idleSweep = db ? setInterval(sweepIdleLectures, 60 * 1000) : null;
idleSweep?.unref();

/** Say out loud which of the three authentication configurations is live. */
function describeAuth() {
  if (!STATIC) return 'relay only';
  if (hasAccounts()) {
    // Worth saying out loud: with every account disabled the gate is still up
    // and nobody can get through it, which is the right failure but a
    // confusing one to debug from the outside.
    const noneEnabled = accounts.countEnabledUsers(db) === 0
      ? ' - every account is disabled, so nobody can sign in until one is enabled' : '';
    return AUTH_PASSWORD
      ? `accounts (AUTH_PASSWORD is set but ignored: accounts take precedence)${noneEnabled}`
      : `accounts${noneEnabled}`;
  }
  if (AUTH_PASSWORD) return 'shared password';
  return db ? 'open - no accounts yet, run podium-admin user add' : 'open';
}

server.on('close', () => {
  clearInterval(heartbeat);
  if (sessionSweep) clearInterval(sessionSweep);
  if (retentionSweep) clearInterval(retentionSweep);
});
server.listen(PORT, HOST || undefined, () => {
  console.log(`podium relay on ${HOST || '*'}:${PORT}${STATIC ? ` (serving ${STATIC})` : ' (relay only)'}`);
  console.log(`podium auth: ${describeAuth()}${db ? `, data in ${store.dataDirFromEnv()}` : ''}`);
  if (db) {
    console.log(`podium sessions: ${LECTURE_RETENTION_DAYS > 0
      ? `photos and exported pages are kept for ${LECTURE_RETENTION_DAYS} days; timelines are kept indefinitely`
      : 'kept indefinitely (set LECTURE_RETENTION_DAYS to age the bulky parts out)'}`);
  }
  // Once at startup as well as daily: a box that is only up during term would
  // otherwise never reach the first daily sweep.
  pruneLectureFiles();
  // And immediately, for the lectures this process's own predecessor left
  // open: a crash or a restart mid-class is exactly the case the idle sweep
  // exists for, and waiting a minute to notice serves nobody.
  sweepIdleLectures();
});
