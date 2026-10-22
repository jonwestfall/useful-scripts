// The cloud spike's test page (issue #308). Each button answers one question
// the plan depends on, and writes what happened - with timings - to the log,
// which "Copy results" hands back as JSON to paste into the issue.
//
// Deliberately no SDKs: OneDrive is reached with the OAuth authorization-code
// flow with PKCE by hand, and Supabase through its REST API, so the spike also
// shows how little Podium would need. Google's sign-in has no supported way
// round its own script (Google Identity Services), so that one is loaded.

import { linkCodeForKey, newPollKey } from '../../assets/js/poll-link.js';
import { viewCodeForKey } from '../../assets/js/view-link.js';

const $ = (sel) => document.querySelector(sel);
const SETTINGS_KEY = 'podium.spike.cloud';
const REDIRECT = new URL(location.pathname, location.origin).toString();

// --- the log ----------------------------------------------------------------

const entries = [];
function log(area, text, result = 'info', data = undefined) {
  const at = new Date().toISOString();
  entries.push({ at, area, result, text, ...(data === undefined ? {} : { data }) });
  const line = document.createElement('div');
  line.className = result === 'pass' ? 'ok' : result === 'fail' ? 'bad' : '';
  line.textContent = `${at.slice(11, 19)} [${area}] ${result === 'pass' ? 'PASS ' : result === 'fail' ? 'FAIL ' : ''}${text}`;
  $('#log').append(line);
  $('#log').scrollTop = $('#log').scrollHeight;
}
const pass = (area, text, data) => log(area, text, 'pass', data);
const fail = (area, text, data) => log(area, text, 'fail', data);
const ms = (t0) => Math.round(performance.now() - t0);
const mbps = (bytes, millis) => (bytes / 1048576 / (millis / 1000)).toFixed(1);

/** Run a button's test, logging anything it throws. */
function wire(id, area, fn) {
  $(id).addEventListener('click', async () => {
    try { await fn(); } catch (err) { fail(area, err.message || String(err)); }
  });
}

$('#copy').addEventListener('click', async () => {
  const report = JSON.stringify({ page: location.href, userAgent: navigator.userAgent, entries }, null, 2);
  try { await navigator.clipboard.writeText(report); log('page', 'Results copied.'); } catch { window.prompt('Copy this:', report); }
});
$('#clear').addEventListener('click', () => { entries.length = 0; $('#log').replaceChildren(); $('#media').replaceChildren(); });

// --- settings, this browser only ------------------------------------------

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
}
const settings = loadSettings();
for (const [id, key] of [['#ms-client', 'msClient'], ['#g-client', 'gClient'], ['#sb-url', 'sbUrl'], ['#sb-key', 'sbKey']]) {
  $(id).value = settings[key] || '';
  $(id).addEventListener('change', () => {
    settings[key] = $(id).value.trim();
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode: retype it */ }
  });
}

/** A file to upload: the one picked, or - cancelled - a generated one of `mb` MB. */
function pickFile() {
  return new Promise((resolve) => {
    const input = $('#file');
    input.value = '';
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

/** Show what came back: a video plays, a PDF draws its first page. */
async function showMedia(area, blob, name) {
  const box = $('#media');
  box.replaceChildren();
  const t0 = performance.now();
  if (/^video\//.test(blob.type) || /\.(mp4|webm|mov|m4v)$/i.test(name)) {
    const video = document.createElement('video');
    video.controls = true;
    video.muted = true;
    video.src = URL.createObjectURL(blob);
    box.append(video);
    await new Promise((resolve, reject) => {
      video.oncanplay = resolve;
      video.onerror = () => reject(new Error('the browser could not play it'));
    });
    pass(area, `video plays from the downloaded copy (${ms(t0)} ms to playable, ${Math.round(video.duration)} s long)`);
    return;
  }
  if (blob.type === 'application/pdf' || /\.pdf$/i.test(name)) {
    const { pdfjsLib } = window;
    pdfjsLib.GlobalWorkerOptions.workerSrc = '../../assets/vendor/pdf.worker.min.js';
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    box.append(canvas);
    pass(area, `PDF opens from the downloaded copy (${doc.numPages} pages, first drawn in ${ms(t0)} ms)`);
  }
}

// --- a renewal soak, for either provider ------------------------------------

function soak(area, renew) {
  const every = Math.max(1, Number($('#soak-every').value) || 10) * 60000;
  const total = Math.max(1, Number($('#soak-for').value) || 75) * 60000;
  const start = Date.now();
  let round = 0;
  log(area, `renewal soak started: every ${every / 60000} min for ${total / 60000} min. Leave this tab open and the device awake.`);
  const tick = async () => {
    round += 1;
    const t0 = performance.now();
    try {
      const how = await renew();
      pass(area, `renewal ${round} at ${Math.round((Date.now() - start) / 60000)} min: ${how} (${ms(t0)} ms)`);
    } catch (err) {
      fail(area, `renewal ${round} at ${Math.round((Date.now() - start) / 60000)} min: ${err.message}`);
    }
    if (Date.now() - start + every <= total) setTimeout(tick, every);
    else log(area, 'renewal soak finished.');
  };
  setTimeout(tick, every);
}

// --- OneDrive Personal -------------------------------------------------------
//
// Microsoft's consumer endpoint, the authorization-code flow with PKCE, as a
// single-page app: no client secret, and the token endpoint answers the
// browser directly because the app registration lists this page's address
// under the "Single-page application" platform.

const MS_AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const MS_SCOPE = 'openid offline_access Files.ReadWrite.AppFolder';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const ms_ = { token: '', refresh: '', expires: 0 };

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

function keepMs(body) {
  ms_.token = body.access_token;
  ms_.refresh = body.refresh_token || ms_.refresh;
  ms_.expires = Date.now() + (body.expires_in || 3600) * 1000;
  // This tab only, never disk: the same rule a classroom PC would follow.
  sessionStorage.setItem('podium.spike.ms', JSON.stringify(ms_));
}
try { Object.assign(ms_, JSON.parse(sessionStorage.getItem('podium.spike.ms') || '{}')); } catch { /* none yet */ }

async function msToken(form) {
  const res = await fetch(`${MS_AUTH}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: settings.msClient, ...form }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token endpoint said ${body.error}: ${body.error_description?.split('\r\n')[0] || ''}`);
  return body;
}

async function graph(path, { method = 'GET', headers = {}, body, raw = false } = {}) {
  if (!ms_.token) throw new Error('sign in first');
  if (Date.now() > ms_.expires - 60000 && ms_.refresh) keepMs(await msToken({ grant_type: 'refresh_token', refresh_token: ms_.refresh, scope: MS_SCOPE }));
  const res = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, { method, headers: { authorization: `Bearer ${ms_.token}`, ...headers }, body });
  if (raw) return res;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(`Graph ${method} ${path} said ${res.status}: ${data?.error?.message || ''}`), { status: res.status });
  return data;
}

wire('#ms-signin', 'onedrive', async () => {
  if (!settings.msClient) throw new Error('enter the client ID first');
  const verifier = randomString(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomString(16);
  sessionStorage.setItem('podium.spike.ms-pkce', JSON.stringify({ verifier, state }));
  location.assign(`${MS_AUTH}/authorize?${new URLSearchParams({
    client_id: settings.msClient, response_type: 'code', redirect_uri: REDIRECT, response_mode: 'query',
    scope: MS_SCOPE, code_challenge: challenge, code_challenge_method: 'S256', state,
  })}`);
});

// Coming back from Microsoft's sign-in page.
(async () => {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  history.replaceState(null, '', REDIRECT);
  if (params.has('error')) { fail('onedrive', `sign-in refused: ${params.get('error')} ${params.get('error_description') || ''}`); return; }
  const pkce = JSON.parse(sessionStorage.getItem('podium.spike.ms-pkce') || '{}');
  sessionStorage.removeItem('podium.spike.ms-pkce');
  if (pkce.state !== params.get('state')) { fail('onedrive', 'sign-in state did not match'); return; }
  try {
    const t0 = performance.now();
    const body = await msToken({ grant_type: 'authorization_code', code: params.get('code'), redirect_uri: REDIRECT, code_verifier: pkce.verifier });
    keepMs(body);
    pass('onedrive', `signed in from ${location.origin}; access token for ${body.expires_in} s, refresh token ${body.refresh_token ? 'given' : 'NOT given'} (${ms(t0)} ms)`,
      { scope: body.scope });
  } catch (err) { fail('onedrive', err.message); }
})();

wire('#ms-folder', 'onedrive', async () => {
  const t0 = performance.now();
  const root = await graph('/me/drive/special/approot');
  pass('onedrive', `app folder is "${root.name}" at ${root.parentReference?.path || '(no path)'}, reached as approot (${ms(t0)} ms)`, { id: root.id, webUrl: root.webUrl });
  if (!/\/Apps$/.test(root.parentReference?.path || '') && root.parentReference?.path) log('onedrive', 'The Apps folder has a localized name on this account - note it for the issue.');
});

wire('#ms-rw', 'onedrive', async () => {
  const doc = { podium: 'plan', title: 'Spike', at: Date.now() };
  let t0 = performance.now();
  const item = await graph('/me/drive/special/approot:/spike/plan.json:/content', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc) });
  pass('onedrive', `wrote a plan file (${ms(t0)} ms)`);
  t0 = performance.now();
  const back = await (await graph(`/me/drive/items/${item.id}/content`, { raw: true })).json();
  (back.at === doc.at ? pass : fail)('onedrive', `read it back (${ms(t0)} ms)`);
  // Another device writes it; this one, still holding the old version tag, tries to.
  const newer = await graph(`/me/drive/items/${item.id}/content`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...doc, at: Date.now() }) });
  try {
    await graph(`/me/drive/items/${item.id}/content`, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': item.eTag }, body: JSON.stringify({ ...doc, stale: true }) });
    fail('onedrive', 'a write from a stale copy was accepted - it should have been refused');
  } catch (err) {
    (err.status === 412 ? pass : fail)('onedrive', `a write from a stale copy is refused (${err.status})`, { stale: item.eTag, current: newer.eTag });
  }
});

wire('#ms-big', 'onedrive', async () => {
  const file = await pickFile();
  if (!file) return;
  const name = file.name.replace(/[^\w.-]+/g, '_');
  let t0 = performance.now();
  const session = await graph(`/me/drive/special/approot:/spike/${name}:/createUploadSession`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  });
  const CHUNK = 32 * 327680;   // 10 MiB, a multiple of the 320 KiB Graph requires
  let item = null;
  for (let at = 0; at < file.size; at += CHUNK) {
    const end = Math.min(file.size, at + CHUNK);
    const res = await fetch(session.uploadUrl, { method: 'PUT', headers: { 'content-range': `bytes ${at}-${end - 1}/${file.size}` }, body: file.slice(at, end) });
    if (!res.ok) throw new Error(`upload chunk at ${at} said ${res.status}`);
    if (end === file.size) item = await res.json();
  }
  const up = ms(t0);
  pass('onedrive', `uploaded ${(file.size / 1048576).toFixed(1)} MB in ${up} ms (${mbps(file.size, up)} MB/s)`);
  t0 = performance.now();
  const meta = await graph(`/me/drive/items/${item.id}`);
  const res = await fetch(meta['@microsoft.graph.downloadUrl']);
  const blob = new Blob([await res.arrayBuffer()], { type: file.type });
  const down = ms(t0);
  (blob.size === file.size ? pass : fail)('onedrive', `downloaded it back in ${down} ms (${mbps(blob.size, down)} MB/s) - as the display would`);
  await showMedia('onedrive', blob, file.name);
});

wire('#ms-soak', 'onedrive', async () => {
  if (!ms_.refresh) throw new Error('sign in first');
  soak('onedrive', async () => {
    keepMs(await msToken({ grant_type: 'refresh_token', refresh_token: ms_.refresh, scope: MS_SCOPE }));
    return 'quietly, with the refresh token';
  });
});

wire('#ms-signout', 'onedrive', async () => {
  sessionStorage.removeItem('podium.spike.ms');
  Object.assign(ms_, { token: '', refresh: '', expires: 0 });
  log('onedrive', 'signed out on this device (tokens forgotten).');
});

// --- Google Drive ---------------------------------------------------------------

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const g = { client: null, token: '', expires: 0, folder: '' };

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Google’s sign-in script did not load'));
    document.head.append(s);
  });
}

/** Ask Google for a token; `prompt: ''` is the quiet renewal the soak measures. */
async function googleToken(prompt) {
  await loadGis();
  return new Promise((resolve, reject) => {
    g.client = window.google.accounts.oauth2.initTokenClient({
      client_id: settings.gClient,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (r) => {
        if (r.error) { reject(new Error(`${r.error}: ${r.error_description || ''}`)); return; }
        g.token = r.access_token;
        g.expires = Date.now() + Number(r.expires_in || 3600) * 1000;
        resolve(r);
      },
      error_callback: (e) => reject(new Error(`${e.type}${e.message ? `: ${e.message}` : ''} (a pop-up was needed or blocked)`)),
    });
    g.client.requestAccessToken({ prompt });
  });
}

async function drive(url, { method = 'GET', headers = {}, body, raw = false } = {}) {
  if (!g.token) throw new Error('sign in first');
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${g.token}`, ...headers }, body });
  if (raw) return res;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`Drive ${method} said ${res.status}: ${data?.error?.message || ''}`), { status: res.status });
  return data;
}

wire('#g-signin', 'google', async () => {
  if (!settings.gClient) throw new Error('enter the client ID first');
  const t0 = performance.now();
  const r = await googleToken('consent');
  pass('google', `signed in from ${location.origin}; token for ${r.expires_in} s, scope ${r.scope} (${ms(t0)} ms). Note in the issue whether Google showed an "unverified app" screen.`);
});

async function podiumFolder() {
  if (g.folder) return g.folder;
  const q = encodeURIComponent("name = 'Podium spike' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
  const found = await drive(`${DRIVE}/files?q=${q}&fields=files(id,name)`);
  if (found.files.length) { g.folder = found.files[0].id; return g.folder; }
  const made = await drive(`${DRIVE}/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Podium spike', mimeType: 'application/vnd.google-apps.folder' }) });
  g.folder = made.id;
  return g.folder;
}

wire('#g-folder', 'google', async () => {
  const t0 = performance.now();
  const id = await podiumFolder();
  pass('google', `a visible "Podium spike" folder in My Drive (${ms(t0)} ms)`, { id });
});

wire('#g-rw', 'google', async () => {
  const folder = await podiumFolder();
  const doc = { podium: 'plan', title: 'Spike', at: Date.now() };
  const boundary = `podium${Date.now()}`;
  const multipart = `--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ name: 'plan.json', parents: [folder] })}\r\n--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(doc)}\r\n--${boundary}--`;
  let t0 = performance.now();
  const file = await drive(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: multipart });
  pass('google', `wrote a plan file (${ms(t0)} ms)`);
  t0 = performance.now();
  const back = await (await drive(`${DRIVE}/files/${file.id}?alt=media`, { raw: true })).json();
  (back.at === doc.at ? pass : fail)('google', `read it back (${ms(t0)} ms)`);
  // Another device changes it; this one checks before writing, as Podium would.
  await drive(`${UPLOAD}/files/${file.id}?uploadType=media`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...doc, at: Date.now() }) });
  const now = await drive(`${DRIVE}/files/${file.id}?fields=modifiedTime`);
  (now.modifiedTime !== file.modifiedTime ? pass : fail)('google', 'a change made elsewhere is seen before writing (modified time moved)', { was: file.modifiedTime, now: now.modifiedTime });
});

wire('#g-big', 'google', async () => {
  const file = await pickFile();
  if (!file) return;
  const folder = await podiumFolder();
  let t0 = performance.now();
  const start = await drive(`${UPLOAD}/files?uploadType=resumable`, {
    method: 'POST', raw: true,
    headers: { 'content-type': 'application/json', 'x-upload-content-type': file.type || 'application/octet-stream', 'x-upload-content-length': String(file.size) },
    body: JSON.stringify({ name: file.name, parents: [folder] }),
  });
  const session = start.headers.get('location');
  if (!session) throw new Error(`no upload session (status ${start.status}; the Location header may not be readable from this page)`);
  const res = await fetch(session, { method: 'PUT', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
  if (!res.ok) throw new Error(`upload said ${res.status}`);
  const made = await res.json();
  const up = ms(t0);
  pass('google', `uploaded ${(file.size / 1048576).toFixed(1)} MB in ${up} ms (${mbps(file.size, up)} MB/s)`);
  t0 = performance.now();
  const blob = new Blob([await (await drive(`${DRIVE}/files/${made.id}?alt=media`, { raw: true })).arrayBuffer()], { type: file.type });
  const down = ms(t0);
  (blob.size === file.size ? pass : fail)('google', `downloaded it back in ${down} ms (${mbps(blob.size, down)} MB/s) - as the display would`);
  await showMedia('google', blob, file.name);
});

wire('#g-soak', 'google', async () => {
  if (!g.token) throw new Error('sign in first');
  soak('google', async () => {
    await googleToken('');
    return 'quietly (no pop-up asked for)';
  });
});

wire('#g-signout', 'google', async () => {
  if (g.token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(g.token, () => {});
  Object.assign(g, { token: '', expires: 0, folder: '' });
  log('google', 'signed out on this device (token revoked).');
});

// --- Supabase -------------------------------------------------------------------

async function rpc(fn, args) {
  if (!settings.sbUrl || !settings.sbKey) throw new Error('enter the project URL and public key first');
  const res = await fetch(`${settings.sbUrl.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: settings.sbKey, authorization: `Bearer ${settings.sbKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${fn} said ${res.status}: ${data?.message || text}`);
  return data;
}

wire('#sb-codes', 'supabase', async () => {
  let same = 0;
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) {
    const key = newPollKey();
    const [poll, view] = await Promise.all([rpc('podium_link_code', { p_label: 'podium-poll-link', p_key: key }), rpc('podium_link_code', { p_label: 'podium-view-link', p_key: key })]);
    if (poll === linkCodeForKey('podium-poll-link', key) && view === viewCodeForKey(key)) same += 1;
  }
  (same === 10 ? pass : fail)('supabase', `the project works out the same link codes as Podium (${same} of 10; ${Math.round(ms(t0) / 20)} ms a call)`);
});

wire('#sb-poll', 'supabase', async () => {
  let t0 = performance.now();
  const { code, token } = await rpc('poll_open', {});
  pass('supabase', `opened poll ${code} (${ms(t0)} ms)`);
  const { seq } = await rpc('poll_ask', { p_code: code, p_token: token, p_question: JSON.stringify({ q: 'Spike?', options: ['A', 'B', 'C'] }) });
  t0 = performance.now();
  const views = await Promise.all(Array.from({ length: 40 }, () => rpc('poll_view', { p_code: code })));
  pass('supabase', `40 phones loaded the question at once (${ms(t0)} ms for all)`, { open: views.every((v) => v.open) });
  t0 = performance.now();
  await Promise.all(Array.from({ length: 40 }, (_, i) => rpc('poll_vote', { p_code: code, p_seq: seq, p_voter: `phone-${i}`, p_answer: i % 3 })));
  const voteMs = ms(t0);
  const results = await rpc('poll_results', { p_code: code, p_token: token });
  (results.answers.length === 40 ? pass : fail)('supabase', `40 phones voted at once (${voteMs} ms for all); the presenter sees ${results.answers.length} answers`);
  try {
    await rpc('poll_results', { p_code: code, p_token: 'guess' });
    fail('supabase', 'results were readable without the presenter’s token');
  } catch { pass('supabase', 'results are not readable without the presenter’s token'); }
  await rpc('poll_close', { p_code: code, p_token: token });
});

wire('#sb-view', 'supabase', async () => {
  const key = newPollKey();
  const code = viewCodeForKey(key);
  const link = 't=supabase&r=view.Spike12345&p=spike-view-key';
  let t0 = performance.now();
  const early = await rpc('view_code_lookup', { p_code: code });
  (early.waiting ? pass : fail)('supabase', `a planned viewer link opened early is told to wait (${ms(t0)} ms)`);
  t0 = performance.now();
  const claimed = await rpc('view_code_register', { p_link: link, p_key: key });
  (claimed.code === code ? pass : fail)('supabase', `the display claims the planned code ${code} with its key (${ms(t0)} ms)`);
  const found = await rpc('view_code_lookup', { p_code: code });
  (found.link === link ? pass : fail)('supabase', 'and the waiting phone finds the class');
  try {
    await rpc('view_code_register', { p_link: 't=ws&r=psy415&p=room-key' });
    fail('supabase', 'a link to the real room was accepted');
  } catch { pass('supabase', 'a link that opens the real room is refused'); }
  await rpc('view_code_release', { p_code: code, p_token: claimed.token });
});

log('page', `ready. Sign-in redirect address for both app registrations: ${REDIRECT}`);
