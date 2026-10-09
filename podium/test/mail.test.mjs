// Podium's own small SMTP client (Issue #256, phase 5), against a fake mail
// server on this machine: reading SMTP_URL and MAIL_FROM, the conversation
// itself, AUTH only where a password may be sent, the message's headers and
// body, and what a refusal says.
//
//   node podium/test/mail.test.mjs

import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mail = require('../server/mail.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

console.log('-- reading the settings --');
ok('no SMTP_URL is no mail, and says so', mail.mailConfig({}) === null && mail.describe(null).configured === false);
const cfg = mail.mailConfig({ SMTP_URL: 'smtp://pod%40ium:p%3Ass@mail.example.edu:2525', MAIL_FROM: 'Podium <podium@example.edu>' });
ok(`a URL's parts, percent-decoded (${cfg.user} @ ${cfg.host}:${cfg.port})`, cfg.user === 'pod@ium' && cfg.pass === 'p:ss' && cfg.port === 2525 && !cfg.secure);
ok('smtps:// is TLS from the start, on 465 by default', mail.mailConfig({ SMTP_URL: 'smtps://mail.example.edu', MAIL_FROM: 'a@b.co' }).port === 465);
ok('a missing MAIL_FROM is an error, not a guess', /MAIL_FROM/.test(mail.mailConfig({ SMTP_URL: 'smtp://x.y' }).error));
ok('an odd scheme is an error', /smtp:\/\//.test(mail.mailConfig({ SMTP_URL: 'http://x.y', MAIL_FROM: 'a@b.co' }).error));
ok('the description never includes the password', !JSON.stringify(mail.describe(cfg)).includes('p:ss') && mail.describe(cfg).server === 'mail.example.edu:2525');

console.log('\n-- the message --');
const msg = mail.message({ from: 'Podium <podium@example.edu>', to: 'jane@school.edu', subject: 'Checked in · PSY415', text: 'Line one\nLine two — ✓' });
const [head, body] = msg.split('\r\n\r\n');
ok('a non-ASCII subject is encoded', /^Subject: =\?UTF-8\?B\?/m.test(head));
ok('the body is base64 of the text, with CRLF line ends', Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') === 'Line one\r\nLine two — ✓');
ok('and it says it was sent by a machine', /^Auto-Submitted: auto-generated$/m.test(head));

// A fake server: records what it is told, answers as a real one would.
function fakeServer({ starttls = false, refuseRcpt = false } = {}) {
  const seen = { lines: [], data: '' };
  const server = net.createServer((sock) => {
    let inData = false;
    let buf = '';
    sock.write('220 fake.test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else seen.data += `${line}\r\n`;
          continue;
        }
        seen.lines.push(line);
        if (/^EHLO/.test(line)) sock.write(`250-fake.test\r\n${starttls ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN\r\n`);
        else if (/^AUTH PLAIN/.test(line)) sock.write('235 ok\r\n');
        else if (/^MAIL FROM/.test(line)) sock.write('250 ok\r\n');
        else if (/^RCPT TO/.test(line)) sock.write(refuseRcpt ? '550 no such user here\r\n' : '250 ok\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (line === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('502 what\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

console.log('\n-- the conversation --');
{
  const { server, seen, port } = await fakeServer();
  const config = mail.mailConfig({ SMTP_URL: `smtp://jane:secret@127.0.0.1:${port}`, MAIL_FROM: 'Podium <podium@example.edu>' });
  const sent = await mail.sendMail({ to: 'Jane Doe <jane@school.edu>', subject: 'Hello', text: 'Checked in.' }, { config });
  ok('a message is sent', sent.sent && sent.to === 'jane@school.edu');
  ok(`EHLO, AUTH, MAIL, RCPT, DATA, QUIT in order (${seen.lines.map((l) => l.split(' ')[0].split(':')[0]).join(' ')})`,
    seen.lines.map((l) => l.split(' ')[0].split(':')[0]).join(' ') === 'EHLO AUTH MAIL RCPT DATA QUIT');
  ok('the login is user and password, as AUTH PLAIN', Buffer.from(seen.lines[1].slice(11), 'base64').toString() === '\0jane\0secret');
  ok('to the address only, from MAIL_FROM\'s address', seen.lines[2] === 'MAIL FROM:<podium@example.edu>' && seen.lines[3] === 'RCPT TO:<jane@school.edu>');
  ok('and the message arrives whole', /^Subject: Hello\r\n/m.test(seen.data) && /Content-Transfer-Encoding: base64/.test(seen.data));
  server.close();
}
{
  const { server, port } = await fakeServer({ refuseRcpt: true });
  const config = mail.mailConfig({ SMTP_URL: `smtp://127.0.0.1:${port}`, MAIL_FROM: 'podium@example.edu' });
  const err = await mail.sendMail({ to: 'nobody@school.edu', subject: 'x', text: 'y' }, { config }).catch((e) => e);
  ok(`a refusal says what the server said (${err.message})`, err.status === 502 && /550 to RCPT: no such user here/.test(err.message));
  server.close();
}
{
  // 127.0.0.2 is this machine on Linux, but not one Podium treats as local:
  // a password goes nowhere unencrypted.
  const seen = { lines: [] };
  const remote = await new Promise((resolve) => {
    const s = net.createServer((sock) => {
      sock.write('220 fake\r\n');
      sock.on('data', (c) => { seen.lines.push(String(c).trim()); if (/^EHLO/.test(String(c))) sock.write('250 AUTH PLAIN\r\n'); });
    });
    s.listen(0, '127.0.0.2', () => resolve(s));
  }).catch(() => null);
  if (remote) {
    const config = mail.mailConfig({ SMTP_URL: `smtp://jane:secret@127.0.0.2:${remote.address().port}`, MAIL_FROM: 'podium@example.edu' });
    const err = await mail.sendMail({ to: 'jane@school.edu', subject: 'x', text: 'y' }, { config }).catch((e) => e);
    ok(`with no STARTTLS on a server elsewhere, no password is sent (${err.message.slice(0, 60)}…)`,
      /will not send it a password/.test(err.message) && !seen.lines.some((l) => /^AUTH/.test(l)));
    remote.close();
  } else {
    console.log('skip  (no 127.0.0.2 here) a password is never sent unencrypted');
  }
}
{
  const err = await mail.sendMail({ to: 'jane@school.edu', subject: 'x', text: 'y' }, { config: null }).catch((e) => e);
  ok('with no mail set up, sending says so', err.status === 503 && /no SMTP_URL/.test(err.message));
  const bad = await mail.sendMail({ to: 'not an address', subject: 'x', text: 'y' }, { config: cfg }).catch((e) => e);
  ok('a bad recipient is refused before any connection', bad.status === 400);
}

console.log('\n-- podium-admin doctor --');
const doctor = require('../server/doctor.js');
ok('no mail is fine, and says receipts are off', doctor.checkMail({}).level === 'ok' && /receipts are off/.test(doctor.checkMail({}).detail));
ok('mail set up says where it sends from', /mail\.example\.edu:587 as Podium/.test(doctor.checkMail({ SMTP_URL: 'smtp://u:p@mail.example.edu', MAIL_FROM: 'Podium <p@example.edu>' }).detail));
ok('half set up is a warning, saying what is missing', doctor.checkMail({ SMTP_URL: 'smtp://mail.example.edu' }).level === 'warn');

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
