// Sending email, for attendance receipts (Issue #256, phase 5) and the admin
// page's test message. Optional, like everything else on the server: with no
// SMTP_URL nothing here does anything, and the pages say mail is not set up.
//
//   SMTP_URL=smtp://user:password@mail.example.edu:587    STARTTLS (required)
//   SMTP_URL=smtps://user:password@mail.example.edu:465   TLS from the start
//   SMTP_URL=smtp://127.0.0.1:25                          a local relay, no login
//   MAIL_FROM="Podium <podium@example.edu>"
//
// A small SMTP client of its own rather than a dependency: Podium's server
// keeps its dependencies to what it cannot do without, and sending one
// plain-text message to one address is a short conversation. It never sends a
// password over an unencrypted connection: smtp:// must offer STARTTLS before
// it is given one, unless the server is this machine.
//
// Special characters in the user or password are percent-encoded in the URL,
// as in any URL (an @ in a username is %40).

'use strict';

const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const crypto = require('node:crypto');

const TIMEOUT_MS = 15000;
const ADDRESS_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** Just the address out of "Name <a@b.c>" or "a@b.c". */
function addressOf(text) {
  const raw = String(text || '').trim();
  const angled = raw.match(/<([^>]+)>\s*$/);
  return (angled ? angled[1] : raw).trim();
}

const isLocal = (host) => ['localhost', '127.0.0.1', '::1'].includes(String(host).replace(/^\[|\]$/g, ''));

/**
 * The mail settings from the environment, or null when there are none.
 * An SMTP_URL that cannot be read is reported rather than ignored.
 */
function mailConfig(env = process.env) {
  if (!env.SMTP_URL) return null;
  let url;
  try { url = new URL(env.SMTP_URL); } catch { return { error: 'SMTP_URL is not a URL' }; }
  if (!['smtp:', 'smtps:'].includes(url.protocol)) return { error: 'SMTP_URL must start smtp:// or smtps://' };
  const secure = url.protocol === 'smtps:';
  const from = String(env.MAIL_FROM || '').replace(/[\r\n]/g, '').trim();
  if (!from || !ADDRESS_RE.test(addressOf(from))) return { error: 'MAIL_FROM is missing or is not an address' };
  return {
    host: url.hostname,
    port: Number(url.port) || (secure ? 465 : 587),
    secure,
    user: decodeURIComponent(url.username || ''),
    pass: decodeURIComponent(url.password || ''),
    from,
  };
}

/** What can be said about the mail setup without saying the password. */
function describe(config) {
  if (!config) return { configured: false, reason: 'no SMTP_URL is set on this server' };
  if (config.error) return { configured: false, reason: config.error };
  return { configured: true, server: `${config.host}:${config.port}${config.secure ? ' (TLS)' : ''}`, from: config.from };
}

// One SMTP conversation: send a line, wait for the whole (possibly multi-line)
// reply, and check its code.
function conversation(socket) {
  let buffer = '';
  let waiting = null;
  let closed = null;
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    if (waiting) check();
  };
  const check = () => {
    const lines = buffer.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      // The last line of a reply is "250 ..." (space), the others "250-...".
      if (/^\d{3}(?: |$)/.test(lines[i])) {
        const reply = lines.slice(0, i + 1);
        buffer = lines.slice(i + 1).join('\r\n');
        const done = waiting;
        waiting = null;
        done.resolve({ code: Number(reply[i].slice(0, 3)), lines: reply.map((l) => l.slice(4)) });
        return;
      }
    }
  };
  const attach = (s) => {
    s.on('data', onData);
    s.on('error', (err) => { closed = err; if (waiting) { waiting.reject(err); waiting = null; } });
    s.on('close', () => { if (waiting) { waiting.reject(closed || new Error('the mail server closed the connection')); waiting = null; } });
  };
  attach(socket);
  return {
    socket,
    reply() {
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        check();
      });
    },
    async send(line, expect) {
      this.socket.write(`${line}\r\n`);
      const r = await this.reply();
      if (!expect.includes(r.code)) {
        const what = line.startsWith('AUTH') ? 'AUTH' : line.split(' ')[0];
        throw fail(`the mail server answered ${r.code} to ${what}: ${r.lines.join(' ').slice(0, 200)}`, 502);
      }
      return r;
    },
    upgrade(next) {
      this.socket.removeListener('data', onData);
      this.socket = next;
      attach(next);
    },
  };
}

// RFC 2047 for a header that is not plain ASCII.
const header = (text) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`);

/** The message itself: plain text, base64 so no line or character needs escaping. */
function message({ from, to, subject, text, now = new Date() }) {
  const domain = addressOf(from).split('@')[1] || 'localhost';
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${header(subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    body,
  ].join('\r\n');
}

/**
 * Send one plain-text message to one address. Resolves when the server has
 * accepted it; rejects with what the server said otherwise.
 */
async function sendMail({ to, subject, text }, { config = mailConfig(), timeoutMs = TIMEOUT_MS } = {}) {
  if (!config || config.error) throw fail(describe(config).reason, 503);
  const rcpt = addressOf(to);
  if (!ADDRESS_RE.test(rcpt)) throw fail(`“${to}” is not an email address`);
  const cleanSubject = String(subject || '').replace(/[\r\n]+/g, ' ').slice(0, 200);

  const socket = config.secure
    ? tls.connect({ host: config.host, port: config.port, servername: config.host })
    : net.connect({ host: config.host, port: config.port });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('the mail server took too long to answer')));
  const smtp = conversation(socket);
  try {
    await new Promise((resolve, reject) => {
      socket.once(config.secure ? 'secureConnect' : 'connect', resolve);
      socket.once('error', reject);
    });
    const greeting = await smtp.reply();
    if (greeting.code !== 220) throw fail(`the mail server greeted with ${greeting.code}`, 502);
    const name = os.hostname().replace(/[^a-z0-9.-]/gi, '') || 'podium';
    let hello = await smtp.send(`EHLO ${name}`, [250]);
    let encrypted = config.secure;
    if (!encrypted && hello.lines.some((l) => /^STARTTLS\b/i.test(l))) {
      await smtp.send('STARTTLS', [220]);
      const secured = tls.connect({ socket: smtp.socket, servername: config.host });
      await new Promise((resolve, reject) => { secured.once('secureConnect', resolve); secured.once('error', reject); });
      smtp.upgrade(secured);
      encrypted = true;
      hello = await smtp.send(`EHLO ${name}`, [250]);
    }
    if (config.user) {
      if (!encrypted && !isLocal(config.host)) {
        throw fail('the mail server does not offer STARTTLS, so Podium will not send it a password - use smtps:// or a server that does', 502);
      }
      await smtp.send(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.pass}`, 'utf8').toString('base64')}`, [235]);
    }
    await smtp.send(`MAIL FROM:<${addressOf(config.from)}>`, [250]);
    await smtp.send(`RCPT TO:<${rcpt}>`, [250, 251]);
    await smtp.send('DATA', [354]);
    // Dot-stuffing: base64 never starts a line with a dot, but the headers
    // are checked anyway in case a subject ever did.
    const data = message({ from: config.from, to: rcpt, subject: cleanSubject, text })
      .split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
    await smtp.send(`${data}\r\n.`, [250]);
    try { await smtp.send('QUIT', [221]); } catch { /* sent is sent */ }
    return { sent: true, to: rcpt };
  } finally {
    smtp.socket.destroy();
  }
}

module.exports = { mailConfig, describe, sendMail, message, addressOf };
