#!/usr/bin/env node
// Accounts and courses, from the shell.
//
// The first account has to come from somewhere, and it cannot come from a web
// form: a page that lets an anonymous visitor create the first admin is a page
// that lets whoever finds the box first own it. So the bootstrap is here,
// where standing at a root shell is the credential.
//
//   DATA_DIR=/var/lib/podium node podium-admin.js user add jon --admin
//   DATA_DIR=/var/lib/podium node podium-admin.js user list
//   DATA_DIR=/var/lib/podium node podium-admin.js course add psy415 --title "PSY 415"
//   DATA_DIR=/var/lib/podium node podium-admin.js member add psy415 ta-sam
//
// Passwords are prompted for without echo. --password-stdin reads one from a
// pipe instead, for the installer and anything else scripted; --password on
// the command line works and is visible in `ps`, which is why it warns.

'use strict';

// See the same block in podium-server.js: Node's default warning printer is a
// listener, so silencing one specific notice means removing it first.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return;
  console.warn(warning.stack || String(warning));
});

const fs = require('node:fs');
const path = require('node:path');

const store = require('./store.js');
const accounts = require('./accounts.js');
const doctor = require('./doctor.js');
const lectures = require('./lectures.js');
const settings = require('./settings.js');

const USAGE = `podium-admin — accounts and courses for a server-backed Podium

  user add <username> [--admin] [--name "Full Name"]
  user list
  user passwd <username>
  user disable <username>
  user enable <username>
  course add <code> [--title "PSY 415"]
  course list
  course settings <code> [--transport ws|mqtt|supabase] [--room ...] [--ws-url ...]
                         [--mqtt-url ...] [--supabase-url ...] [--supabase-key ...]
                         [--passphrase ...|--new-passphrase]
  member add <course-code> <username> [--role owner|member]
  member remove <course-code> <username>
  sessions prune
  lectures list [--limit 20]
  lectures prune --days <n>
  doctor [--health-url http://127.0.0.1:8080/healthz] [--cert /path/fullchain.pem]

Options
  --data-dir <path>    where the database lives (default: $DATA_DIR)
  --password <pw>      supply a password directly (visible in ps; prefer a prompt)
  --password-stdin     read the password from stdin, for scripts
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (['admin', 'password-stdin', 'new-passphrase'].includes(name)) { flags[name] = true; continue; }
    flags[name] = argv[++i] ?? '';
  }
  return { positional, flags };
}

function promptSecret(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('no terminal to prompt on — pass --password-stdin and pipe one in'));
      return;
    }
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (err, result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (err) reject(err); else resolve(result);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') { done(null, value); return; }
        if (ch === '\u0003') { done(new Error('cancelled')); return; }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const readStdin = () => new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
});

async function getPassword(flags, { confirm = true } = {}) {
  if (flags['password-stdin']) return readStdin();
  if (flags.password) {
    console.warn('warning: --password is visible to anyone who can run ps on this box');
    return flags.password;
  }
  const first = await promptSecret('Password: ');
  if (!confirm) return first;
  const again = await promptSecret('Again: ');
  if (first !== again) throw new Error('those did not match');
  return first;
}

// Standing at a root shell IS the credential here, so there is no account to
// act as. A null id records the change as nobody's rather than inventing one.
const ROOT = { id: null, isAdmin: true };

function courseByCode(db, code) {
  const row = db.prepare('SELECT * FROM courses WHERE code = ?').get(String(code || '').trim().toLowerCase());
  if (!row) throw new Error(`no course with the code ${code}`);
  return row;
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [group, action, ...rest] = positional;
  if (!group || group === 'help' || flags.help) { process.stdout.write(USAGE); return 0; }

  const dataDir = flags['data-dir'] || process.env.DATA_DIR;
  if (!dataDir) throw new Error('set DATA_DIR (or pass --data-dir) to say where the database lives');
  // open() throws with a reason of its own when a configured directory cannot
  // be used; main()'s catch prints it. null means only "no directory given",
  // which the check above has already ruled out.
  //
  // Except for `doctor`: a database that will not open - a future schema, a
  // corrupt file - is exactly the situation that command exists to diagnose,
  // so letting the throw here pre-empt it would mean the one command meant to
  // survive a broken box dies before it can say anything. Every other command
  // still needs a working database and fails loudly, as it always has.
  let db = null;
  let dbOpenError = null;
  try {
    db = store.open(path.resolve(dataDir));
  } catch (err) {
    if (group !== 'doctor') throw err;
    dbOpenError = err;
  }

  const say = (text) => process.stdout.write(`${text}\n`);

  if (group === 'user' && action === 'add') {
    const [username] = rest;
    if (!username) throw new Error('which username?');
    const user = await accounts.createUser(db, {
      username,
      password: await getPassword(flags),
      displayName: flags.name || '',
      isAdmin: !!flags.admin,
    });
    say(`created ${user.username}${user.isAdmin ? ' (admin)' : ''}`);
    if (accounts.countEnabledUsers(db) === 1) {
      say('this is the first account, so the cookie gate is now live and AUTH_PASSWORD is ignored');
      say('restart the service for it to notice: systemctl restart podium');
    }
    return 0;
  }

  if (group === 'user' && action === 'list') {
    const users = accounts.listUsers(db);
    if (!users.length) { say('no accounts yet'); return 0; }
    for (const user of users) {
      say(`${user.username.padEnd(20)} ${user.isAdmin ? 'admin ' : '      '} ${user.disabled ? 'disabled' : 'active'}  ${user.displayName}`);
    }
    return 0;
  }

  if (group === 'user' && action === 'passwd') {
    const [username] = rest;
    if (!username) throw new Error('which username?');
    await accounts.setPassword(db, username, await getPassword(flags));
    say(`changed the password for ${username}; every device signed in as them must sign in again`);
    return 0;
  }

  if (group === 'user' && (action === 'disable' || action === 'enable')) {
    const [username] = rest;
    if (!username) throw new Error('which username?');
    accounts.setDisabled(db, username, action === 'disable');
    say(`${username} is now ${action}d`);
    return 0;
  }

  if (group === 'course' && action === 'add') {
    const code = String(rest[0] || '').trim().toLowerCase();
    if (!code) throw new Error('which course code?');
    db.prepare('INSERT INTO courses (code, title, created_at) VALUES (?, ?, ?)')
      .run(code, flags.title || '', Date.now());
    say(`created course ${code}`);
    return 0;
  }

  if (group === 'course' && action === 'list') {
    const rows = db.prepare(`SELECT c.code, c.title, COUNT(m.user_id) AS members
        FROM courses c LEFT JOIN course_members m ON m.course_id = c.id
        GROUP BY c.id ORDER BY c.code`).all();
    if (!rows.length) { say('no courses yet'); return 0; }
    for (const row of rows) say(`${row.code.padEnd(16)} ${String(row.members).padStart(3)} member(s)  ${row.title}`);
    return 0;
  }

  // What a device that logs in gets handed. Held per course so that a TA who
  // may drive the projector has the passphrase to do it - and rotated from
  // here, which is the only way to take it back from someone who has left.
  if (group === 'course' && action === 'settings') {
    const course = courseByCode(db, rest[0]);
    const current = settings.forUser(db, ROOT).find((c) => c.course === course.code);
    const wanted = { ...(current?.settings || {}) };
    const map = {
      transport: 'transport', room: 'room', passphrase: 'passphrase',
      'ws-url': 'wsUrl', 'mqtt-url': 'mqttUrl',
      'supabase-url': 'supabaseUrl', 'supabase-key': 'supabaseKey',
    };
    for (const [flag, key] of Object.entries(map)) {
      if (flags[flag] !== undefined) wanted[key] = flags[flag];
    }
    if (flags['new-passphrase']) {
      wanted.passphrase = require('node:crypto').randomBytes(12).toString('base64url');
    }
    if (!Object.keys(wanted).length) {
      say(`${course.code} has no settings stored`);
      return 0;
    }
    const saved = settings.write(db, ROOT, course.code, wanted);
    say(`${course.code}: ${Object.entries(saved.settings)
      // A passphrase printed into a terminal is a passphrase in a scrollback
      // buffer. --new-passphrase is the one time you have to see it.
      .map(([k, v]) => `${k}=${k === 'passphrase' && !flags['new-passphrase'] ? '(unchanged, hidden)' : v}`)
      .join(' ')}`);
    if (flags['new-passphrase']) {
      say('every device already set up for this course must be given the new passphrase');
    }
    return 0;
  }

  if (group === 'member' && action === 'add') {
    const [code, username] = rest;
    const course = courseByCode(db, code);
    const user = accounts.findUser(db, username);
    if (!user) throw new Error(`no account called ${username}`);
    const role = flags.role === 'owner' ? 'owner' : 'member';
    db.prepare('INSERT OR REPLACE INTO course_members (course_id, user_id, role) VALUES (?, ?, ?)')
      .run(course.id, user.id, role);
    say(`${user.username} is a ${role} of ${course.code}`);
    return 0;
  }

  if (group === 'member' && action === 'remove') {
    const [code, username] = rest;
    const course = courseByCode(db, code);
    const user = accounts.findUser(db, username);
    if (!user) throw new Error(`no account called ${username}`);
    db.prepare('DELETE FROM course_members WHERE course_id = ? AND user_id = ?').run(course.id, user.id);
    say(`${user.username} is no longer a member of ${course.code}`);
    return 0;
  }

  if (group === 'sessions' && action === 'prune') {
    say(`removed ${accounts.pruneSessions(db)} expired session(s)`);
    return 0;
  }

  // "sessions" above is logins; a lecture is the other thing this program calls
  // a session, and the admin page calls "Past sessions". Two words for two
  // tables, kept apart here because pruning the wrong one is not a mistake you
  // want a tired operator to be able to make at 6pm.
  if (group === 'lectures' && action === 'list') {
    const limit = Number(flags.limit) || 20;
    const rows = lectures.listLectures(db, ROOT, { limit });
    if (!rows.length) { say('no lectures recorded'); return 0; }
    for (const row of rows) {
      const kept = db.prepare(`SELECT COUNT(*) AS files, COALESCE(SUM(m.bytes), 0) AS bytes
          FROM lecture_files lf JOIN media m ON m.id = lf.media_id WHERE lf.lecture_id = ?`).get(row.id);
      say([
        String(row.id).padStart(5),
        new Date(row.startedAt).toISOString().slice(0, 16).replace('T', ' '),
        (row.course || '-').padEnd(10),
        (row.title || row.room || '').slice(0, 40).padEnd(40),
        `${row.events} moments`,
        `${kept.files} files`,
        `${Math.round(kept.bytes / 1024)} KB`,
      ].join('  '));
    }
    return 0;
  }

  if (group === 'lectures' && action === 'prune') {
    const days = Number(flags.days);
    if (!Number.isFinite(days) || days <= 0) throw new Error('lectures prune needs --days <n>');
    const { removed, bytes } = lectures.pruneFiles(db, dataDir, { days });
    say(`removed ${removed} file(s) from lectures older than ${days} day(s), freeing ${Math.round(bytes / 1024)} KB`);
    say('their timelines and poll results are kept - only the photos, ink and exported pages go');
    return 0;
  }

  // Answers with an exit status as well as words, so it can be a cron line:
  // 0 for fine (warnings included), 1 for something that needs attention.
  if (group === 'doctor') {
    const found = await doctor.run({
      db,
      dataDir,
      openError: dbOpenError,
      // The release this copy of podium-admin is part of, which is the whole
      // point of asking from here: it is the code that was deployed, and the
      // question is whether the running service agrees.
      releaseDir: path.resolve(__dirname, '..'),
      healthUrl: flags['health-url'] || healthUrlFromEnvFile(),
      certPath: flags.cert || '',
      // process.env alone misses whatever this service only ever gets from
      // its systemd EnvironmentFile - LECTURE_RETENTION_DAYS chief among them
      // - since a bare `node podium-admin.js doctor` never sources that file
      // the way the unit does. File values fill in what process.env does not
      // already have; an operator's own exported env still wins.
      env: { ...envFile(), ...process.env },
    });
    return doctor.report(found);
  }

  process.stderr.write(USAGE);
  return 2;
}

/** The service's own systemd EnvironmentFile, wherever it can be found. */
function envFilePath() {
  return [process.env.PODIUM_ENV, '/etc/podium/podium.env'].filter(Boolean).find((f) => fs.existsSync(f)) || '';
}

/**
 * Where to knock, worked out the way update.sh does: the port out of the
 * service's own environment file. Saves passing --health-url on every run on
 * the one deployment the installer sets up.
 */
function healthUrlFromEnvFile() {
  const port = envFile().PORT;
  return port ? `http://127.0.0.1:${port}/healthz` : '';
}

/**
 * A minimal parser for the KEY=VALUE lines a systemd EnvironmentFile holds -
 * exactly the shape deploy/install.sh writes to podium.env. Not a general
 * dotenv implementation: no quoting, no export keyword, because the file this
 * reads is one Podium writes for itself.
 */
function envFile() {
  const file = envFilePath();
  if (!file) return {};
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) out[match[1]] = match[2];
    }
  } catch { /* file listed but unreadable - doctor's permissions check covers that */ }
  return out;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`podium-admin: ${err.message}\n`);
    process.exit(1);
  });
