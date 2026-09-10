// Connection settings, resolved from three places (later wins):
//   1. config.json committed next to the pages (optional, convenient)
//   2. localStorage on this device
//   3. the URL hash, which is how the pairing QR configures a new device
//
// The hash is used because fragments are never sent to a server: the pairing
// link can carry the passphrase without it landing in any access log.

import { uid } from './util.js';

const LS_KEY = 'podium.config.v2';

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
  const cfg = { ...DEFAULTS, ...clean(await fromFile()), ...clean(fromStorage()), ...clean(fromHash()) };
  if (!cfg.room) cfg.room = `room-${uid(5)}`;
  if (!cfg.passphrase) cfg.passphrase = uid(10);
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
  if (!cfg.room || !cfg.passphrase) return false;
  if (cfg.transport === 'supabase') return !!(cfg.supabaseUrl && cfg.supabaseKey);
  if (cfg.transport === 'ws') return !!cfg.wsUrl;
  return !!cfg.mqttUrl;
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
