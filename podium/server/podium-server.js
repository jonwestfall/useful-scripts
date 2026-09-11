#!/usr/bin/env node
// Podium relay — the self-hosted alternative to Supabase or a public broker.
//
//   npm install && node podium-server.js
//
// It does two things: relay messages between the devices in a room, and
// (optionally) serve the Podium pages themselves so the whole thing lives on
// your own box. It never sees plaintext: the browsers encrypt before sending.
//
//   PORT=8080            port to listen on
//   STATIC=../           directory to serve (omit to run relay-only)
//   ORIGIN=https://a.b   comma-separated allowed Origins (omit to allow any)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
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
  '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`ok ${rooms.size} rooms\n`);
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
