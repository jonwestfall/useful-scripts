// The JSON API, and the gate in front of the pages.
//
// Two jobs. The first is /api/capabilities, which is how a page finds out what
// kind of server it came from: a 404 or a non-JSON answer means "static
// Podium", and every server-backed feature stays invisible. That probe is the
// contract that keeps GitHub Pages, Supabase and a folder on a USB stick
// working unchanged - see VPS.md.
//
// The second is deciding whether a request for a page is allowed through at
// all. Three configurations, in strict order of precedence:
//
//   accounts exist   -> the session cookie governs; AUTH_PASSWORD is ignored
//   AUTH_PASSWORD    -> HTTP Basic, as it has worked since it shipped
//   neither          -> wide open, which is the default and always has been
//
// The precedence is deliberate and logged at startup. Two doors into the same
// house, one of them weaker, is how instances get embarrassed.

'use strict';

const accounts = require('./accounts.js');
const library = require('./library.js');
const lectures = require('./lectures.js');
const plans = require('./plans.js');
const settings = require('./settings.js');

const COOKIE = 'podium_session';
const API_VERSION = 1;

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

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    // decodeURIComponent throws on a malformed escape, and a Cookie header is
    // whatever a stranger decided to send. `Cookie: podium_session=%` would
    // otherwise throw straight out of the gate on the static path, where
    // nothing is waiting to catch it - one header, and the process is gone.
    // A cookie that cannot be decoded is a cookie nobody issued.
    try { out[name] = decodeURIComponent(raw); } catch { out[name] = raw; }
  }
  return out;
}

// X-Forwarded-Proto comes from the reverse proxy on this same box (see the
// nginx template in deploy/). Trusting it is what lets the cookie be marked
// Secure in production while still working over plain http on localhost.
const isSecureRequest = (req) =>
  !!req.socket?.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

const setCookie = (req, value, maxAgeSeconds) => [
  `${COOKIE}=${encodeURIComponent(value)}`,
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  `Max-Age=${maxAgeSeconds}`,
  ...(isSecureRequest(req) ? ['Secure'] : []),
].join('; ');

const cookieToken = (req) => parseCookies(req.headers.cookie)[COOKIE] || '';

/**
 * A relative, same-origin path is the only thing worth honouring after a
 * login. Anything else - an absolute URL, a protocol-relative "//evil.example"
 * - is how a login form becomes an open redirect.
 */
function safeNext(raw) {
  const next = String(raw || '');
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '';
  if (/[\x00-\x1f\x7f]/.test(next)) return '';
  return next;
}

/** Is this request a browser going to a page, rather than fetching an asset? */
function looksLikePage(req, pathname) {
  if (req.headers['sec-fetch-mode'] === 'navigate') return true;
  if (!String(req.headers.accept || '').includes('text/html')) return false;
  return pathname === '/' || pathname.endsWith('/') || pathname.endsWith('.html');
}

/**
 * Cross-site request forgery, handled without tokens. SameSite=Lax already
 * stops a cross-site form POST from carrying the cookie; requiring JSON stops
 * the form-encoded shapes that are all a plain <form> can send; and an Origin
 * that disagrees with the Host is refused outright when the browser sends one.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // curl, or a same-origin GET
  try {
    return new URL(origin).host === String(req.headers.host || '');
  } catch {
    return false;
  }
}

function capabilities(ctx, user) {
  // The library needs somewhere to store things AND someone to attribute them
  // to, so it is only advertised once an account exists. Otherwise a freshly
  // installed instance with no accounts yet would offer an Admin page whose
  // every request answers 401 - a feature announced before it can be used.
  const features = ctx.db && ctx.hasAccounts()
    ? ['auth', 'library', 'plans', 'settings', 'sessions']
    : (ctx.db ? ['auth'] : []);
  return {
    podium: true,
    version: API_VERSION,
    features,
    auth: {
      mode: ctx.hasAccounts() ? 'accounts' : (ctx.basicPassword ? 'password' : 'open'),
      required: ctx.hasAccounts() || !!ctx.basicPassword,
    },
    user: user || null,
  };
}

/**
 * Handle an /api/... request. Returns true if it took the request.
 */
async function handleApi(req, res, url, ctx) {
  const route = url.pathname.replace(/^\/api\/?/, '');
  // Same sliding-expiry refresh the static gate does. Without it, a controller
  // or admin page left open and used only through the API would slide its row
  // forward while the browser quietly reached the Max-Age it was given at
  // login, and would be signed out with a perfectly valid session behind it.
  const token = cookieToken(req);
  const refreshCookie = () => res.setHeader('set-cookie', setCookie(req, token, Math.floor(accounts.SESSION_MS / 1000)));
  const user = ctx.db ? accounts.sessionUser(ctx.db, token, { onSlide: refreshCookie }) : null;

  if (route === 'capabilities' && req.method === 'GET') {
    json(res, 200, capabilities(ctx, user));
    return true;
  }

  if (route === 'me' && req.method === 'GET') {
    if (!user) { json(res, 401, { error: 'not signed in' }); return true; }
    json(res, 200, { user });
    return true;
  }

  if (route === 'login' && req.method === 'POST') {
    if (!ctx.db || !ctx.hasAccounts()) { json(res, 404, { error: 'this server has no accounts' }); return true; }
    if (!sameOrigin(req)) { json(res, 403, { error: 'cross-origin request refused' }); return true; }
    let body;
    try { body = await readJson(req, 8 * 1024); } catch { json(res, 400, { error: 'bad body' }); return true; }
    const result = await accounts.login(ctx.db, body.username, body.password, {
      userAgent: req.headers['user-agent'] || '',
      ip: clientIp(req),
    });
    if (!result.ok) {
      const retry = result.retryAfterMs;
      json(res, retry ? 429 : 401,
        retry
          ? { error: 'too many attempts, try again shortly', retryAfterSeconds: Math.ceil(retry / 1000) }
          : { error: 'that username and password do not match' },
        retry ? { 'retry-after': String(Math.ceil(retry / 1000)) } : {});
      return true;
    }
    json(res, 200, { user: result.user, next: safeNext(body.next) || '/index.html' },
      { 'set-cookie': setCookie(req, result.token, Math.floor(accounts.SESSION_MS / 1000)) });
    return true;
  }

  if (route === 'logout' && req.method === 'POST') {
    if (!sameOrigin(req)) { json(res, 403, { error: 'cross-origin request refused' }); return true; }
    if (ctx.db) accounts.endSession(ctx.db, cookieToken(req));
    json(res, 200, { ok: true }, { 'set-cookie': setCookie(req, '', 0) });
    return true;
  }

  // --- everything past here needs to know who is asking -------------------
  if (!ctx.db) { json(res, 404, { error: 'this server stores nothing' }); return true; }
  if (!user) { json(res, 401, { error: 'not signed in' }); return true; }
  if (req.method !== 'GET' && !sameOrigin(req)) {
    json(res, 403, { error: 'cross-origin request refused' });
    return true;
  }

  const [head, ...rest] = route.split('/');

  try {
    if (head === 'courses' && req.method === 'GET') {
      json(res, 200, { courses: library.listCourses(ctx.db, user) });
      return true;
    }

    if (head === 'library' && rest[0] === 'upload' && req.method === 'POST') {
      json(res, 200, await receiveUpload(req, url, ctx, user));
      return true;
    }

    if (head === 'library' && !rest.length && req.method === 'GET') {
      json(res, 200, {
        items: library.listItems(ctx.db, user),
        courses: library.listCourses(ctx.db, user),
        usage: library.usage(ctx.db),
        limits: { uploadBytes: library.MAX_UPLOAD_BYTES, extensions: [...library.UPLOADABLE.keys()] },
      });
      return true;
    }

    // Items with no bytes behind them - a big text card, a web link, a QR.
    // The upload route is for everything that is a file.
    if (head === 'library' && !rest.length && req.method === 'POST') {
      const body = await readJson(req);
      if (!body.type || !body.title) { json(res, 400, { error: 'an item needs a type and a title' }); return true; }
      const { type, title, group, course, ...props } = body;
      json(res, 200, {
        item: library.addItem(ctx.db, user, { kind: type, title, group, courseCode: course, props }),
      });
      return true;
    }

    if (head === 'library' && rest.length === 1 && req.method === 'PATCH') {
      const body = await readJson(req);
      const item = library.renameItem(ctx.db, user, rest[0], {
        title: body.title, group: body.group,
        courseCode: 'course' in body ? body.course : undefined,
      });
      json(res, 200, { item });
      return true;
    }

    if (head === 'library' && rest.length === 1 && req.method === 'DELETE') {
      json(res, 200, { removed: library.deleteItem(ctx.db, user, rest[0]).id });
      return true;
    }

    // --- lecture plans ----------------------------------------------------

    if (head === 'plans' && !rest.length && req.method === 'GET') {
      json(res, 200, { plans: plans.listPlans(ctx.db, user), courses: library.listCourses(ctx.db, user) });
      return true;
    }

    if (head === 'plans' && !rest.length && req.method === 'POST') {
      const body = await readJson(req, plans.MAX_DOC_BYTES + 1024);
      json(res, 200, {
        plan: plans.savePlan(ctx.db, user, { title: body.title, courseCode: body.course, doc: body.doc }),
      });
      return true;
    }

    if (head === 'plans' && rest.length === 1 && req.method === 'GET') {
      const plan = plans.getPlan(ctx.db, user, rest[0]);
      if (!plan) { json(res, 404, { error: 'no such plan' }); return true; }
      json(res, 200, { plan });
      return true;
    }

    if (head === 'plans' && rest.length === 1 && req.method === 'PUT') {
      const body = await readJson(req, plans.MAX_DOC_BYTES + 1024);
      json(res, 200, {
        plan: plans.updatePlan(ctx.db, user, rest[0], {
          title: body.title,
          courseCode: 'course' in body ? body.course : undefined,
          doc: body.doc,
        }),
      });
      return true;
    }

    if (head === 'plans' && rest.length === 1 && req.method === 'DELETE') {
      json(res, 200, { removed: plans.deletePlan(ctx.db, user, rest[0]).id });
      return true;
    }

    // --- lectures: what happened in the room -------------------------------
    //
    // Written by the DISPLAY, which is the only device that holds the
    // decrypted state, and by a controller as it ends a poll. The relay writes
    // none of it and could not: it only ever sees ciphertext. See lectures.js.

    if (head === 'lectures' && !rest.length && req.method === 'GET') {
      json(res, 200, {
        lectures: lectures.listLectures(ctx.db, user),
        usage: lectures.usage(ctx.db),
        limits: { fileBytes: lectures.MAX_FILE_BYTES, lectureBytes: lectures.MAX_LECTURE_BYTES },
      });
      return true;
    }

    if (head === 'lectures' && !rest.length && req.method === 'POST') {
      const body = await readJson(req, 8 * 1024);
      json(res, 200, { lecture: lectures.startLecture(ctx.db, user, { room: body.room, title: body.title }) });
      return true;
    }

    if (head === 'lectures' && rest.length === 1 && req.method === 'GET') {
      const lecture = lectures.getLecture(ctx.db, user, rest[0]);
      if (!lecture) { json(res, 404, { error: 'no such lecture' }); return true; }
      json(res, 200, { lecture });
      return true;
    }

    if (head === 'lectures' && rest.length === 1 && req.method === 'PATCH') {
      const body = await readJson(req, 8 * 1024);
      json(res, 200, {
        lecture: lectures.renameLecture(ctx.db, user, rest[0], {
          title: body.title,
          courseCode: 'course' in body ? body.course : undefined,
        }),
      });
      return true;
    }

    if (head === 'lectures' && rest.length === 1 && req.method === 'DELETE') {
      json(res, 200, { removed: lectures.deleteLecture(ctx.db, user, rest[0], { dataDir: ctx.dataDir }).id });
      return true;
    }

    // A batch, because the display queues events and flushes them every few
    // seconds rather than spending a request on every slide.
    if (head === 'lectures' && rest.length === 2 && rest[1] === 'events' && req.method === 'POST') {
      const body = await readJson(req, 256 * 1024);
      json(res, 200, lectures.appendEvents(ctx.db, user, rest[0], body.events));
      return true;
    }

    if (head === 'lectures' && rest.length === 2 && rest[1] === 'polls' && req.method === 'POST') {
      const body = await readJson(req, 512 * 1024);
      json(res, 200, lectures.recordPoll(ctx.db, user, rest[0], body.poll || body));
      return true;
    }

    // The bulky half: photos, ink, and the pages an export rasterizes. The file
    // IS the body, as with a library upload and for the same reason - the two
    // strings that go with it fit in a query string, and multipart would be the
    // largest thing in this repository with no dependencies.
    if (head === 'lectures' && rest.length === 2 && rest[1] === 'files' && req.method === 'POST') {
      json(res, 200, { file: await receiveLectureFile(req, url, ctx, user, rest[0]) });
      return true;
    }

    if (head === 'lectures' && rest.length === 2 && rest[1] === 'end' && req.method === 'POST') {
      const body = await readJson(req, 8 * 1024).catch(() => ({}));
      json(res, 200, { lecture: lectures.endLecture(ctx.db, user, rest[0], { at: body.at }) });
      return true;
    }

    // --- connection settings ----------------------------------------------
    //
    // This hands out room passphrases, which is the whole point of it: a
    // device that has these can join the room. Membership of the course is
    // what earns them, and writing them takes more than membership.

    if (head === 'settings' && !rest.length && req.method === 'GET') {
      json(res, 200, { courses: settings.forUser(ctx.db, user) });
      return true;
    }

    if (head === 'settings' && rest.length === 1 && req.method === 'PUT') {
      const body = await readJson(req);
      json(res, 200, { saved: settings.write(ctx.db, user, rest[0], body.settings || body) });
      return true;
    }
  } catch (err) {
    json(res, err.status || 500, { error: err.status ? err.message : 'that did not work' });
    return true;
  }

  json(res, 404, { error: 'no such endpoint' });
  return true;
}

/**
 * An upload is the raw file as the request body, with its name and where it
 * belongs in the query string.
 *
 * Deliberately not multipart/form-data. Podium has no dependencies and parsing
 * multipart correctly is a hundred lines of boundary handling that exists only
 * to carry three short strings alongside the bytes - strings a query string
 * carries perfectly well. `fetch(url, { method: 'POST', body: file })` is the
 * whole client side of it.
 */
async function receiveUpload(req, url, ctx, user) {
  const filename = String(url.searchParams.get('filename') || '').split(/[\\/]/).pop().slice(0, 200);
  const allowed = library.uploadKindFor(filename);
  if (!allowed) {
    throw Object.assign(new Error(
      `Podium does not take ${filename.includes('.') ? `${filename.split('.').pop()} files` : 'files without an extension'}`,
    ), { status: 415 });
  }

  // Everything that can be checked without reading the body is checked BEFORE
  // reading the body. Resolving the course afterwards would mean a signed-in
  // outsider could spend 50 MB of disk per request on a course they are not a
  // member of, and only be told no once it had all landed.
  const courseCode = url.searchParams.get('course') || '';
  library.courseIdFor(ctx.db, user, courseCode);

  // The declared content type is ignored in favour of the extension's: these
  // bytes come back from this origin later, and what a browser is told they
  // are must not be something an uploader chose. The KIND comes from the same
  // mapping for the same reason - `week.md&type=web` would otherwise hand
  // markdown to the web-page renderer.
  const { sha256, bytes } = await library.storeUpload(ctx.dataDir, req);
  let mediaId;
  try {
    mediaId = library.rememberMedia(ctx.db, user, { sha256, bytes, contentType: allowed.type });
    const item = library.addItem(ctx.db, user, {
      courseCode,
      kind: allowed.kind,
      title: url.searchParams.get('title') || filename.replace(/\.[^.]+$/, ''),
      group: url.searchParams.get('group') || '',
      filename,
      mediaId,
    });
    return { item };
  } catch (err) {
    // The bytes are on disk and nothing ended up pointing at them. Content
    // addressing means this is safe to undo: if any other item shares the
    // hash, forgetMediaIfUnused leaves both alone.
    library.forgetMediaIfUnused(ctx.db, ctx.dataDir, sha256);
    throw err;
  }
}

/**
 * One file kept with a lecture: a photo, the ink, or a page from an export.
 *
 * Checked in the same order the library upload is, and for the same reason:
 * everything answerable without reading the body is answered first, so a
 * signed-in stranger cannot spend megabytes of disk per request on a lecture
 * they may not touch and only be told no once it has all landed.
 */
async function receiveLectureFile(req, url, ctx, user, lectureId) {
  const name = String(url.searchParams.get('name') || '');
  const type = lectures.keepableType(name);
  if (!type) {
    throw Object.assign(new Error(
      `a session keeps ${[...lectures.KEEPABLE.keys()].join(' ')} - not ${name.split('.').pop() || 'that'}`,
    ), { status: 415 });
  }
  // Resolves the lecture and this account's right to write to it before a byte
  // is read; addFile asks again afterwards, which is the check that counts.
  if (!lectures.visibleLecture(ctx.db, user, lectureId)) {
    throw Object.assign(new Error('no such lecture'), { status: 404 });
  }

  const { sha256, bytes } = await library.storeUpload(ctx.dataDir, req, { limit: lectures.MAX_FILE_BYTES });
  try {
    // The type comes from the name through our own allow-list, never from what
    // the request declared - these bytes are served back from this origin, and
    // what a browser is told they are must not be something a caller chose.
    return lectures.addFile(ctx.db, user, lectureId,
      { name, kind: url.searchParams.get('kind') || '', sha256, bytes, contentType: type, dataDir: ctx.dataDir });
  } catch (err) {
    library.forgetMediaIfUnused(ctx.db, ctx.dataDir, sha256);
    throw err;
  }
}

/**
 * Behind nginx every connection comes from 127.0.0.1, so the forwarded header
 * is the only thing that distinguishes one attacker from another for the
 * purposes of throttling.
 *
 * The LAST entry, not the first. `proxy_set_header X-Forwarded-For
 * $proxy_add_x_forwarded_for` APPENDS the address nginx actually saw to
 * whatever the client sent, so the header reads
 * "<whatever the client claimed>, <the real peer>". Reading the front of that
 * list means reading a value the client chose - and a login throttle keyed on
 * a value the attacker picks is no throttle at all, since a new one can be
 * invented for every attempt.
 *
 * This is right for exactly the deployment deploy/podium.nginx.conf describes:
 * one trusted proxy on this same box. Behind two, the last entry is the inner
 * proxy and this wants to count back one more.
 */
function clientIp(req) {
  const chain = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((part) => part.trim()).filter(Boolean);
  return chain.length ? chain[chain.length - 1] : (req.socket?.remoteAddress || '');
}

/**
 * Decide whether a static-file request may proceed. Writes the refusal itself
 * (a redirect to the login page for a browser, a 401 for anything else) and
 * returns false when it does.
 */
function gate(req, res, pathname, ctx) {
  if (ctx.openPaths.has(pathname)) return true;

  if (ctx.hasAccounts()) {
    const token = cookieToken(req);
    // Re-issue the cookie whenever the session's expiry slides forward.
    // setHeader rather than a writeHead argument, because the thing that
    // eventually answers this request (a file, a range, a redirect) writes its
    // own headers and knows nothing about sessions.
    const onSlide = () => res.setHeader('set-cookie', setCookie(req, token, Math.floor(accounts.SESSION_MS / 1000)));
    if (accounts.sessionUser(ctx.db, token, { onSlide })) return true;
    if (looksLikePage(req, pathname)) {
      const next = encodeURIComponent(pathname + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
      res.writeHead(302, { location: `/login.html?next=${next}`, 'cache-control': 'no-store' });
      res.end();
    } else {
      json(res, 401, { error: 'not signed in' });
    }
    return false;
  }

  if (ctx.basicPassword && !ctx.isBasicAuthorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Podium", charset="UTF-8"' });
    res.end('authentication required');
    return false;
  }

  return true;
}

module.exports = { handleApi, gate, readJson, json, parseCookies, safeNext, cookieToken, clientIp, COOKIE, API_VERSION };
