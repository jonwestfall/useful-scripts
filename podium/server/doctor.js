// The things that actually go wrong on a Podium box, checked in one command.
//
//   DATA_DIR=/var/lib/podium node podium-admin.js doctor
//
// Not a monitoring system and not trying to be. This is the list somebody
// would work through by hand at the point where "it was fine last term" stops
// being true, written down so they do not have to remember it: is the disk
// full, is the database sound, did the deploy actually reach the process, is
// the certificate about to expire, is there anybody left who can administer
// this thing.
//
// Three levels, and the distinction is load-bearing because this is meant to be
// runnable from cron:
//
//   ok    nothing to do
//   warn  worth knowing, not worth waking up for - exit status is still 0
//   bad   something is broken or about to be - exit status 1
//
// Every check is wrapped: a check that cannot run says so and the rest still
// run. A doctor that dies on its third question is worse than no doctor.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const store = require('./store.js');
const accounts = require('./accounts.js');
const library = require('./library.js');
const lectures = require('./lectures.js');

const DAY = 24 * 60 * 60 * 1000;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** One finding. `detail` is the line a person reads; `fix` is what to do next. */
const say = (level, title, detail, fix = '') => ({ level, title, detail, fix });

// --- the checks ---------------------------------------------------------------

function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const recent = major > 22 || (major === 22 && minor >= 5);
  try {
    require('node:sqlite');
  } catch {
    return say('bad', 'node', `Node ${process.versions.node} has no node:sqlite`,
      'Podium needs Node 22.5 or newer to store anything at all.');
  }
  return recent
    ? say('ok', 'node', `Node ${process.versions.node}, with node:sqlite`)
    : say('warn', 'node', `Node ${process.versions.node} has node:sqlite but is older than 22.5`,
      'Upgrade when convenient; this is the version the storage was built against.');
}

function checkSchema(db) {
  const at = db.prepare('PRAGMA user_version').get().user_version;
  if (at === store.SCHEMA_VERSION) return say('ok', 'schema', `version ${at}, matching this release`);
  if (at > store.SCHEMA_VERSION) {
    return say('bad', 'schema', `the database is at version ${at} but this release only knows ${store.SCHEMA_VERSION}`,
      'This code is older than the database. Deploy the newer release again rather than rolling further back.');
  }
  // Only reachable if something opened the database without migrating, since
  // store.open() migrates on the way in.
  return say('bad', 'schema', `the database is at version ${at}, behind this release's ${store.SCHEMA_VERSION}`,
    'Restart the service; migrations run at startup.');
}

function checkIntegrity(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  const first = rows[0]?.integrity_check;
  if (first !== 'ok') {
    return say('bad', 'database', `integrity_check says ${first}`,
      'Stop the service and restore from a backup; a corrupt SQLite file does not get better on its own.');
  }
  const broken = db.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) {
    return say('bad', 'database', `${broken.length} row(s) point at something that is not there`,
      'Restore from a backup, or ask on the repository - this should not be reachable.');
  }
  return say('ok', 'database', 'integrity and foreign keys check out');
}

function checkDisk(dataDir) {
  let stats;
  try { stats = fs.statfsSync(dataDir); } catch (err) {
    return say('warn', 'disk', `could not measure ${dataDir} (${err.code})`);
  }
  const free = stats.bavail * stats.bsize;
  const total = stats.blocks * stats.bsize;
  const share = total ? (free / total) * 100 : 0;
  const line = `${mb(free)} free of ${mb(total)} (${share.toFixed(0)}%) on ${dataDir}`;
  // A relay that cannot write is a relay that cannot log anybody in: SQLite
  // fails a write before it fails a read, so the first symptom of a full disk
  // is a login form that refuses everybody.
  if (free < 200 * 1024 * 1024 || share < 5) {
    return say('bad', 'disk', line, 'Free some space now - a full disk stops logins before it stops anything else.');
  }
  if (free < 1024 * 1024 * 1024 || share < 15) {
    return say('warn', 'disk', line, 'Consider LECTURE_RETENTION_DAYS, or a bigger disk.');
  }
  return say('ok', 'disk', line);
}

function checkPermissions(dataDir) {
  let mode;
  try { mode = fs.statSync(dataDir).mode & 0o777; } catch (err) {
    return say('bad', 'permissions', `cannot stat ${dataDir} (${err.code})`);
  }
  if (mode & 0o077) {
    return say('bad', 'permissions', `${dataDir} is mode ${mode.toString(8)}`,
      `It holds password hashes and every room's passphrase. chmod 0700 ${dataDir}`);
  }
  return say('ok', 'permissions', `${dataDir} is mode ${mode.toString(8)}, private to its owner`);
}

/**
 * Bytes on disk with no row pointing at them, and rows pointing at bytes that
 * are not there. Both are recoverable and neither is dangerous, but they are
 * the shape a half-finished upload or a hand-edited data directory leaves.
 */
function checkMedia(db, dataDir) {
  const rows = db.prepare('SELECT sha256, bytes FROM media').all();
  const known = new Set(rows.map((row) => row.sha256));
  const missing = rows.filter((row) => !fs.existsSync(library.mediaPath(dataDir, row.sha256)));

  let onDisk = 0;
  const orphans = [];
  const mediaDir = path.join(dataDir, 'media');
  for (const shard of safeList(mediaDir)) {
    for (const name of safeList(path.join(mediaDir, shard))) {
      if (name.startsWith('.incoming-')) continue;     // an upload in flight
      onDisk += 1;
      if (!known.has(name)) orphans.push(path.join(shard, name));
    }
  }

  if (missing.length) {
    return say('bad', 'media', `${missing.length} of ${rows.length} stored files are missing from disk`,
      'Something removed files under media/ without going through Podium. Restore that directory from a backup.');
  }
  if (orphans.length) {
    return say('warn', 'media', `${onDisk} files on disk, ${orphans.length} of them unreferenced`,
      'Harmless, and safe to delete once you are sure nothing is mid-upload.');
  }
  return say('ok', 'media', `${rows.length} file(s), all present`);
}

const safeList = (dir) => {
  try { return fs.readdirSync(dir); } catch { return []; }
};

function checkAccounts(db) {
  const all = accounts.countUsers(db);
  if (!all) {
    return say('bad', 'accounts', 'there are no accounts, so these pages are open to anyone who can reach them',
      'podium-admin user add <name> --admin');
  }
  const admins = accounts.countEnabledAdmins(db);
  if (!admins) {
    return say('bad', 'accounts', `${all} account(s), none of them an administrator who can sign in`,
      'podium-admin user enable <name>, or add an administrator - nobody can manage this from a browser.');
  }
  const stale = db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE expires_at < ?').get(Date.now()).n;
  const line = `${all} account(s), ${admins} administrator(s) able to sign in`;
  return stale
    ? say('warn', 'accounts', `${line}; ${stale} expired login(s) still stored`, 'podium-admin sessions prune')
    : say('ok', 'accounts', line);
}

function checkStorage(db, env) {
  const held = library.usage(db);
  const sessions = lectures.usage(db);
  const days = Number(env.LECTURE_RETENTION_DAYS || 0);
  const line = `library ${held.files} file(s) ${mb(held.bytes)}, sessions ${sessions.files} file(s) ${mb(sessions.bytes)}`;
  // Unbounded growth is not a fault, but it is the thing that turns into one
  // quietly, and the operator is the only one who can decide it is fine.
  if (!days && sessions.bytes > 2 * 1024 * 1024 * 1024) {
    return say('warn', 'storage', `${line}; no retention is set and sessions are past 2 GB`,
      'Set LECTURE_RETENTION_DAYS, or decide out loud that you are keeping everything.');
  }
  return say('ok', 'storage', `${line}; ${days ? `session files kept ${days} days` : 'everything kept'}`);
}

/**
 * Did the deploy actually reach the running process?
 *
 * This is the failure this whole command exists for. `current` is a symlink and
 * the service resolves it once, at start - so flipping it without restarting
 * leaves a box where the files on disk are the new release, every diagnostic
 * agrees, and the code answering requests is last week's. The only way to tell
 * is to ask the process itself what it is serving and compare.
 *
 * Browsers have the same problem one layer out, which is why every page reads
 * its own BUILD against the served one (see servedBuild in util.js) and says so
 * on screen. This is the server-side half of the same question.
 */
async function checkBuild(releaseDir, healthUrl) {
  const onDisk = buildIn(path.join(releaseDir, 'assets', 'js', 'protocol.js'));
  if (onDisk === null) return say('warn', 'build', `no protocol.js under ${releaseDir}`);
  if (!healthUrl) return say('ok', 'build', `release is build ${onDisk} (nothing to compare it against)`);

  // Asked of /healthz rather than by fetching protocol.js over HTTP, because on
  // an instance with accounts that file is behind the login gate and answers
  // 401 - which is correct, and would make this check useless on exactly the
  // deployments it matters most for. /healthz is open by design and the server
  // reads its own build once at startup, which is the number that answers the
  // question: not what is on disk, but what this PROCESS resolved when it
  // started.
  let served;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return say('warn', 'build', `the service answered ${res.status} for its health check`);
    served = (await res.text()).match(/\bbuild (\d+)/)?.[1];
  } catch (err) {
    return say('warn', 'build', `could not ask the service what it is serving (${err.message})`);
  }

  if (served === undefined) {
    return say('warn', 'build', `release is build ${onDisk}; the service does not report one`,
      'It is older than this check, or is running as a relay with no pages to serve.');
  }
  if (Number(served) !== onDisk) {
    return say('bad', 'build', `this release is build ${onDisk} but the running service has ${served}`,
      'The deploy did not reach the running process - a symlink is resolved once, at start.'
      + ' systemctl restart podium.service');
  }
  return say('ok', 'build', `build ${onDisk}, deployed and running`);
}

function buildIn(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').match(/BUILD\s*=\s*(\d+)/)?.[1] ?? NaN) || null;
  } catch {
    return null;
  }
}

/**
 * How long the certificate has left.
 *
 * Certificates renew themselves right up until the day they stop, and the way
 * you find out is a room full of students looking at a browser warning. Given
 * a path, this reads notAfter; given none, it looks where certbot puts them.
 */
function checkCertificate(certPath) {
  const file = certPath || firstLetsEncryptCert();
  if (!file) return say('ok', 'certificate', 'no certificate to check (pass --cert to name one)');
  let cert;
  try {
    cert = new crypto.X509Certificate(fs.readFileSync(file));
  } catch (err) {
    return say('warn', 'certificate', `could not read ${file} (${err.code || err.message})`);
  }
  const left = Math.floor((Date.parse(cert.validTo) - Date.now()) / DAY);
  const line = `${path.basename(path.dirname(file))} expires ${cert.validTo} (${left} days)`;
  if (left < 0) return say('bad', 'certificate', `${line} - it has already expired`, 'Renew it now.');
  if (left < 10) return say('bad', 'certificate', line, 'Renewal should have happened by now: check the certbot timer.');
  if (left < 21) return say('warn', 'certificate', line);
  return say('ok', 'certificate', line);
}

function firstLetsEncryptCert() {
  const live = '/etc/letsencrypt/live';
  for (const name of safeList(live)) {
    const file = path.join(live, name, 'fullchain.pem');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function checkService(healthUrl) {
  if (!healthUrl) return say('warn', 'service', 'no health URL to try (pass --health-url)');
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(4000) });
    return res.ok
      ? say('ok', 'service', `${healthUrl} answers ${res.status}`)
      : say('bad', 'service', `${healthUrl} answers ${res.status}`, 'systemctl status podium.service');
  } catch (err) {
    return say('bad', 'service', `${healthUrl} did not answer (${err.message})`,
      'systemctl status podium.service, and journalctl -u podium.service -n 50');
  }
}

// --- running them -------------------------------------------------------------

/**
 * Run every check and return the findings in the order a person would want to
 * read them. `db` may be null, in which case the database checks say so rather
 * than being silently skipped.
 */
async function run({ db, dataDir, releaseDir, healthUrl, certPath, env = process.env } = {}) {
  const found = [];
  const attempt = async (work) => {
    try { found.push(await work()); } catch (err) {
      found.push(say('warn', 'check', `a check could not run (${err.message})`));
    }
  };

  await attempt(() => checkNode());
  if (!db) {
    found.push(say('bad', 'database', `no database under ${dataDir || 'DATA_DIR'}`,
      'Set DATA_DIR, or pass --data-dir.'));
  } else {
    await attempt(() => checkSchema(db));
    await attempt(() => checkIntegrity(db));
    await attempt(() => checkAccounts(db));
    await attempt(() => checkMedia(db, dataDir));
    await attempt(() => checkStorage(db, env));
  }
  await attempt(() => checkPermissions(dataDir));
  await attempt(() => checkDisk(dataDir));
  await attempt(() => checkBuild(releaseDir, healthUrl));
  await attempt(() => checkCertificate(certPath));
  await attempt(() => checkService(healthUrl));
  return found;
}

const MARK = { ok: ' ok ', warn: 'warn', bad: 'BAD ' };

/** The findings as a person reads them. Returns the process exit code. */
function report(found, write = (line) => process.stdout.write(`${line}\n`)) {
  for (const item of found) {
    write(`[${MARK[item.level]}] ${item.title.padEnd(12)} ${item.detail}`);
    if (item.fix && item.level !== 'ok') write(`${' '.repeat(21)}${item.fix}`);
  }
  const bad = found.filter((item) => item.level === 'bad').length;
  const warn = found.filter((item) => item.level === 'warn').length;
  write('');
  write(bad
    ? `${bad} thing(s) need attention${warn ? `, ${warn} worth knowing about` : ''}.`
    : (warn ? `Nothing broken; ${warn} thing(s) worth knowing about.` : 'Everything checks out.'));
  return bad ? 1 : 0;
}

module.exports = {
  run,
  report,
  checkNode,
  checkSchema,
  checkIntegrity,
  checkDisk,
  checkPermissions,
  checkMedia,
  checkAccounts,
  checkStorage,
  checkBuild,
  checkCertificate,
  checkService,
};
