// Connection settings, resolved from four places (later wins):
//   1. config.json committed next to the pages (optional, convenient)
//   2. a course on the server, when this Podium came from one and you are
//      signed in - which is what makes setting up a new iPad a login
//   3. localStorage on this device
//   4. the URL hash, which is how the pairing QR configures a new device
//
// The hash is used because fragments are never sent to a server: the pairing
// link can carry the passphrase without it landing in any access log.
//
// The server sits BELOW localStorage on purpose. Adopting a course's settings
// is for a device that has none of its own; a device somebody has already set
// up keeps what they set, and no amount of server-side change reaches out and
// re-points it mid-term.

import { uid } from './util.js';
import { serverInfo } from './server.js';

const LS_KEY = 'podium.config.v2';

// Everything Podium stores is namespaced. That matters on GitHub Pages, where
// every project on your site shares one origin: a blanket localStorage.clear()
// would take your other apps' data with it.
export const STORAGE_PREFIX = 'podium.';

export const DEFAULTS = {
  transport: 'supabase',                          // 'supabase' | 'mqtt' | 'ws'
  room: '',
  passphrase: '',
  supabaseUrl: '',
  supabaseKey: '',                                // anon/publishable key
  mqttUrl: 'wss://broker.emqx.io:8084/mqtt',
  wsUrl: '',                                      // wss://your-vps/podium
  manifest: 'content/manifest.json',
};

const KEYS = Object.keys(DEFAULTS);

function fromStorage() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch {
    return {};
  }
}

async function fromFile() {
  try {
    const res = await fetch('config.json', { cache: 'no-cache' });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * The courses on this server whose settings this account may use. Empty for
 * every other way of running Podium, which is what keeps the rest of this file
 * behaving exactly as it always has.
 *
 * Asked only when the capabilities probe says the feature is there, so a
 * static host is never sent a request that would 404.
 */
async function fromServer() {
  try {
    const info = await serverInfo();
    if (!info.features.includes('settings')) return [];
    const res = await fetch('/api/settings', { credentials: 'same-origin' });
    if (!res.ok) return [];
    const { courses } = await res.json();
    return Array.isArray(courses) ? courses : [];
  } catch {
    return [];
  }
}

function fromHash() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return {};
  const params = new URLSearchParams(hash);
  const out = {};
  const map = {
    t: 'transport', r: 'room', p: 'passphrase',
    su: 'supabaseUrl', sk: 'supabaseKey', mu: 'mqttUrl', wu: 'wsUrl',
  };
  for (const [short, long] of Object.entries(map)) {
    if (params.has(short)) out[long] = params.get(short);
    if (params.has(long)) out[long] = params.get(long);
  }
  return out;
}

function clean(obj) {
  const out = {};
  for (const k of KEYS) if (obj[k] !== undefined && obj[k] !== '') out[k] = obj[k];
  return out;
}

export async function loadConfig() {
  const [file, courses] = await Promise.all([fromFile(), fromServer()]);
  // Exactly one course's settings are adopted without asking: that is the
  // "log in and go" case, and there is nothing to choose between. Several and
  // nothing is adopted - the setup form shows them as buttons instead (see
  // serverCourses below), because picking the wrong room is the kind of
  // mistake you find out about in front of a class.
  const fromCourse = courses.length === 1 ? courses[0].settings : {};
  const stored = fromStorage();
  const adopting = Object.keys(fromCourse).length > 0 && !Object.keys(clean(stored)).length;
  const cfg = {
    ...DEFAULTS,
    ...clean(file),
    ...clean(fromCourse),
    ...clean(stored),
    ...clean(fromHash()),
  };
  // Carried for the setup form, never stored: clean() drops it on the way to
  // localStorage, the same as `generated` below.
  cfg.serverCourses = courses;
  // A brand-new device gets a room and a passphrase invented for it so the
  // setup form has something to offer rather than two empty boxes. They are a
  // suggestion, not a decision - which is what `generated` records, so
  // isConfigured can tell "nobody has set this up" from "somebody chose
  // these". clean() drops the marker on the way to storage.
  cfg.generated = { room: !cfg.room, passphrase: !cfg.passphrase };
  if (!cfg.room) cfg.room = `room-${uid(5)}`;
  if (!cfg.passphrase) cfg.passphrase = uid(10);
  // A device that just took its settings from a course keeps them, the same as
  // one configured by a pairing link does. Without this the config would live
  // only as long as the page: every load would have to reach /api/settings,
  // and the first time the classroom Wi-Fi went down the offline shell would
  // open to a setup form instead of a controller - which is the one situation
  // the offline shell exists for.
  //
  // It does mean a rotated passphrase does not reach an already-set-up device
  // on its own. That is the same as it has always been, and the same as the
  // pairing QR: rotating the key is a thing you then hand out.
  if (adopting) saveConfig(cfg);

  // A device configured by a pairing link should keep those settings, and the
  // hash should not linger in the address bar or in a bookmark.
  if (location.hash) {
    saveConfig(cfg);
    history.replaceState(null, '', location.pathname + location.search);
  }
  return cfg;
}

export function saveConfig(cfg) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(clean(cfg)));
  } catch { /* private browsing — settings just won't persist */ }
}

export function isConfigured(cfg) {
  // Never treat the invented room and passphrase above as a setup. Otherwise a
  // config.json naming a transport that needs no credentials of its own - MQTT,
  // whose broker URL already has a working default - would carry a first-run
  // device straight past the setup form and onto a random room with a random
  // passphrase that nobody had seen, let alone chosen. Which is exactly the
  // decision that setup form exists to put in front of someone.
  if (cfg.generated?.room || cfg.generated?.passphrase) return false;
  if (!cfg.room || !cfg.passphrase) return false;
  if (cfg.transport === 'supabase') return !!(cfg.supabaseUrl && cfg.supabaseKey);
  if (cfg.transport === 'ws') return !!cfg.wsUrl;
  return !!cfg.mqttUrl;
}

// A one-line, readable statement of what this device is about to dial, for
// the connection readouts. Worth showing even when everything works: half of
// "it won't connect" turns out to be two devices pointed at different relays,
// or a URL that was saved with a typo months ago and never looked at again.
export function relayTarget(cfg) {
  const names = { supabase: 'Supabase Realtime', mqtt: 'MQTT over WSS', ws: 'Self-hosted WebSocket' };
  const raw = cfg.transport === 'supabase' ? cfg.supabaseUrl
    : cfg.transport === 'ws' ? cfg.wsUrl
    : cfg.mqttUrl;
  let where = raw || '(not set)';
  try {
    const u = new URL(raw);
    where = `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch { /* show it verbatim - a URL too broken to parse is the finding */ }
  return `${names[cfg.transport] || cfg.transport} · ${where} · room ${cfg.room || '(not set)'}`;
}

// Where the audience-poll relay endpoints (and join.html) live: the same
// self-hosted relay this device already talks to over WebSocket, just over
// plain http(s) instead - see server/podium-server.js's /poll routes and
// ROADMAP.md's "why the self-hosted relay changes everything". Returns null
// for any other transport: Supabase and a public MQTT broker have no HTTP
// server of their own behind them, so there is nowhere for a poll to live.
export function pollBaseUrl(cfg) {
  if (cfg.transport !== 'ws' || !cfg.wsUrl) return null;
  try {
    const u = new URL(cfg.wsUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = '/';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

// The URL a student's phone actually opens - one tap from the QR, straight
// onto the question, no code to type. See join.html/join.js.
export function pollJoinUrl(cfg, code) {
  const base = pollBaseUrl(cfg);
  return base ? `${base}join.html?c=${encodeURIComponent(code)}` : null;
}

// Everything a second device needs, packed into a controller URL. Encoded into
// the QR the display shows while it is waiting to be paired.
export function pairingUrl(cfg, base = new URL('control.html', location.href)) {
  const params = new URLSearchParams({ t: cfg.transport, r: cfg.room, p: cfg.passphrase });
  if (cfg.transport === 'supabase') { params.set('su', cfg.supabaseUrl); params.set('sk', cfg.supabaseKey); }
  if (cfg.transport === 'mqtt') params.set('mu', cfg.mqttUrl);
  if (cfg.transport === 'ws') params.set('wu', cfg.wsUrl);
  const url = new URL(base);
  url.hash = params.toString();
  return url.toString();
}


/**
 * Wipe this device back to a stock, never-configured Podium and reload.
 *
 * Deliberately surgical rather than a blanket clear: only keys, caches,
 * databases and workers that belong to Podium, and only cookies scoped to this
 * folder. Returns a list of what it actually removed, for the UI to report.
 */
export async function resetDevice() {
  const removed = [];

  for (const [name, store] of [['localStorage', 'localStorage'], ['sessionStorage', 'sessionStorage']]) {
    try {
      const target = window[store];
      const keys = Object.keys(target).filter((k) => k.startsWith(STORAGE_PREFIX));
      keys.forEach((k) => target.removeItem(k));
      if (keys.length) removed.push(`${keys.length} setting${keys.length > 1 ? 's' : ''} from ${name}`);
    } catch { /* private browsing blocks the accessor itself */ }
  }

  // Podium sets no cookies, but a stale one scoped to this folder would ride
  // along on every request. Expire only this path, never the whole site.
  try {
    const dir = location.pathname.replace(/[^/]*$/, '');
    const names = document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
    for (const name of names) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${dir}`;
    }
    if (names.length) removed.push(`${names.length} cookie${names.length > 1 ? 's' : ''}`);
  } catch { /* nothing readable here */ }

  // A service worker from an earlier experiment would keep serving old files.
  try {
    const dir = new URL('.', location.href).href;
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    const mine = regs.filter((r) => r.scope.startsWith(dir));
    await Promise.all(mine.map((r) => r.unregister()));
    if (mine.length) removed.push(`${mine.length} service worker${mine.length > 1 ? 's' : ''}`);
  } catch { /* unsupported or blocked */ }

  try {
    const names = (await caches?.keys?.()) || [];
    const mine = names.filter((n) => n.startsWith(STORAGE_PREFIX) || n.startsWith('podium'));
    await Promise.all(mine.map((n) => caches.delete(n)));
    if (mine.length) removed.push(`${mine.length} cache${mine.length > 1 ? 's' : ''}`);
  } catch { /* unsupported */ }

  try {
    const dbs = (await indexedDB?.databases?.()) || [];
    const mine = dbs.filter((d) => d.name?.startsWith('podium'));
    await Promise.all(mine.map((d) => new Promise((done) => {
      const req = indexedDB.deleteDatabase(d.name);
      req.onsuccess = req.onerror = req.onblocked = () => done();
    })));
    if (mine.length) removed.push(`${mine.length} database${mine.length > 1 ? 's' : ''}`);
  } catch { /* Safari < 14 has no databases() */ }

  // Re-fetch this page past the HTTP cache so the reload cannot serve a stale
  // copy of the very file you are trying to reset.
  try { await fetch(location.pathname, { cache: 'reload' }); } catch { /* offline */ }

  return removed;
}

/** Navigate to the bare page, with no pairing hash or query left over. */
export function reloadClean() {
  location.replace(location.pathname);
}
