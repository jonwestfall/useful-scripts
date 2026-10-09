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

const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const accounts = require('./accounts.js');
const courses = require('./courses.js');
const library = require('./library.js');
const lectures = require('./lectures.js');
const plans = require('./plans.js');
const recent = require('./recent.js');
const settings = require('./settings.js');
const templates = require('./templates.js');
const deckTemplates = require('./deck-templates.js');
const content = require('./content.js');
const store = require('./store.js');
const kiosks = require('./kiosks.js');
const pptxConvert = require('./pptx-convert.js');
const roster = require('./roster.js');
const attendance = require('./attendance.js');
const zipImport = require('./zip-import.js');
const zipStaging = require('./zip-staging.js');

const COOKIE = 'podium_session';
const KIOSK_COOKIE = 'podium_kiosk';
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

function readBuffer(req, limit = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
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

const setCookie = (req, value, maxAgeSeconds, name = COOKIE, httpOnly = true) => [
  `${name}=${encodeURIComponent(value)}`,
  'Path=/',
  ...(httpOnly ? ['HttpOnly'] : []),
  'SameSite=Lax',
  `Max-Age=${maxAgeSeconds}`,
  ...(isSecureRequest(req) ? ['Secure'] : []),
].join('; ');

const cookieToken = (req) => parseCookies(req.headers.cookie)[COOKIE] || '';

// A kiosk's cookie is deliberately its own name, not a variant of
// podium_session - the two credentials mean different things (a person vs. a
// device nobody is watching) and gate() below needs to be able to tell them
// apart, not just accept whichever one shows up.
const kioskCookieToken = (req) => parseCookies(req.headers.cookie)[KIOSK_COOKIE] || '';

// A second, readable cookie riding alongside the real one - not HttpOnly, and
// carrying no secret, just a "yes" a kiosk's own JS can see. Without it,
// config.js's fromKioskSession would have no way to tell "worth asking" from
// "definitely not a kiosk" ahead of time, since the real cookie is
// deliberately invisible to script; asking anyway on every device that is not
// one - which is most of them - would 404 on every single load. Set and
// refreshed in lockstep with the real cookie everywhere that mints or slides
// one, so it is never more stale than the session it is a hint about.
const KIOSK_HINT_COOKIE = 'podium_kiosk_hint';
const setKioskCookies = (req, value, maxAgeSeconds) => [
  setCookie(req, value, maxAgeSeconds, KIOSK_COOKIE),
  setCookie(req, '1', maxAgeSeconds, KIOSK_HINT_COOKIE, false),
];

/**
 * A relative, same-origin path is the only thing worth honouring after a
 * login. Anything else - an absolute URL, a protocol-relative "//evil.example"
 * - is how a login form becomes an open redirect.
 */
function safeNext(raw) {
  const next = String(raw || '');
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '';
  // Deliberate: rejecting control characters (a CRLF hidden in a redirect
  // target, say) is the point here.
  // eslint-disable-next-line no-control-regex
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
  const allowPollNames = ctx.db ? store.getSystemSetting(ctx.db, 'allow_poll_names', '0') === '1' : false;
  const features = ctx.db && ctx.hasAccounts()
    ? ['auth', 'library', 'plans', 'templates', 'deckTemplates', 'settings', 'sessions', 'people', 'attendance', ...(user?.isAdmin ? ['content', 'kiosks'] : [])]
    : (ctx.db ? ['auth'] : []);
  return {
    podium: true,
    version: API_VERSION,
    features,
    allowPollNames,
    // Word/RTF as a PDF, and old .doc files at all, need LibreOffice (#258).
    officeConvert: !!(ctx.db && ctx.hasAccounts() && pptxConvert.hasLibreOffice()),
    auth: {
      mode: ctx.hasAccounts() ? 'accounts' : (ctx.basicPassword ? 'password' : 'open'),
      required: ctx.hasAccounts() || !!ctx.basicPassword,
    },
    user: user || null,
  };
}

function auditLog(ctx, req, user, action, details) {
  if (ctx.db) {
    accounts.logEvent(ctx.db, {
      userId: user?.id,
      username: user?.username,
      action,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      details,
    });
  }
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
    if (ctx.db) accounts.endSession(ctx.db, cookieToken(req), {
      userAgent: req.headers['user-agent'] || '',
      ip: clientIp(req),
    });
    json(res, 200, { ok: true }, { 'set-cookie': setCookie(req, '', 0) });
    return true;
  }

  // A blank kiosk device redeeming a provisioning link (Issue #151) has no
  // session and never will until this very request hands it something to
  // save - so, like capabilities/login/logout above, this has to answer
  // before the "must be signed in" gate right below, not after it. The token
  // itself is the only credential a device in this position can possibly
  // hold; see kiosks.provision's own comment for why that is enough.
  //
  // This is navigated to directly - the QR and the link admin.js hands out
  // both point straight here, not at display.html - because display.html
  // itself stays behind gate() even for a kiosk (see KIOSK_OPEN_PATHS in
  // podium-server.js): a page nobody has to sign in for on the FIRST visit
  // and stays reachable after a profile is revoked would defeat the whole
  // reason a kiosk cookie exists. So the cookie has to be minted and stored
  // in the browser BEFORE display.html is ever asked for, which a redirect
  // does and a JSON response the page's own JS would have to fetch does not
  // - there would be nothing there yet to run that fetch. The settings
  // themselves never ride along here or on display.html's own URL, even
  // fleetingly: see kiosks/session-config below, which display.html asks
  // itself once it has the cookie this hands it.
  if (route.startsWith('kiosks/provision/') && req.method === 'GET') {
    if (!ctx.db) { json(res, 404, { error: 'this server stores nothing' }); return true; }
    const provisioned = kiosks.provision(ctx.db, decodeURIComponent(route.slice('kiosks/provision/'.length)),
      req.headers['user-agent'] || '');
    if (!provisioned) { json(res, 404, { error: 'no such kiosk, or it has been revoked' }); return true; }
    res.writeHead(302, {
      'set-cookie': setKioskCookies(req, provisioned.sessionToken, Math.floor(kiosks.SESSION_MS / 1000)),
      location: '/display.html',
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }

  // What display.html asks on every load (see fromKioskSession in config.js)
  // to learn what it is - the counterpart to provisioning above, but keyed
  // by the cookie a device already holds rather than a one-time token, so a
  // reboot with no token left in any URL still works. Public for the same
  // reason the route above is: the cookie itself, checked inside
  // sessionConfig, is the only credential involved.
  if (route === 'kiosks/session-config' && req.method === 'GET') {
    if (!ctx.db) { json(res, 404, { error: 'this server stores nothing' }); return true; }
    const kioskToken = kioskCookieToken(req);
    const onSlide = () => res.setHeader('set-cookie', setKioskCookies(req, kioskToken, Math.floor(kiosks.SESSION_MS / 1000)));
    const config = kiosks.sessionConfig(ctx.db, kioskToken, { onSlide });
    if (!config) { json(res, 404, { error: 'not a provisioned kiosk' }); return true; }
    json(res, 200, { config });
    return true;
  }

  // What a kiosk polls (Issue #152) to find out which plan it should be
  // showing right now - resolved from its schedule against this moment,
  // server-side, so a device's own clock (or lack of a battery-backed one
  // after a power cut) is never what a schedule boundary is judged against.
  // Same public-by-cookie reasoning as session-config above.
  if (route === 'kiosks/session-plan' && req.method === 'GET') {
    if (!ctx.db) { json(res, 404, { error: 'this server stores nothing' }); return true; }
    const kioskToken = kioskCookieToken(req);
    const onSlide = () => res.setHeader('set-cookie', setKioskCookies(req, kioskToken, Math.floor(kiosks.SESSION_MS / 1000)));
    const resolved = kiosks.sessionPlan(ctx.db, kioskToken, { onSlide });
    if (!resolved) { json(res, 404, { error: 'not a provisioned kiosk' }); return true; }
    json(res, 200, resolved);
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
    if (head === 'courses' && !rest.length && req.method === 'GET') {
      // Two shapes from one route: the flat list every page has always read
      // (code, title, role), and - for a course this account runs - who is in
      // it. See courses.list for why membership is not shown to everyone.
      json(res, 200, { courses: courses.list(ctx.db, user) });
      return true;
    }

    if (head === 'courses' && !rest.length && req.method === 'POST') {
      const body = await readJson(req, 8 * 1024);
      // Issue #224: a class typed into the planner, which any signed-in
      // account may make (and then owns) - see courses.createFromPlanner.
      if (body.fromPlanner) {
        const course = courses.createFromPlanner(ctx.db, user, { name: body.title || body.code });
        if (!course.existed) {
          auditLog(ctx, req, user, 'course_created', { courseCode: course.code, title: course.title, fromPlanner: true });
        }
        json(res, 200, { course });
        return true;
      }
      const course = courses.create(ctx.db, user, { code: body.code, title: body.title });
      auditLog(ctx, req, user, 'course_created', { courseCode: course.code, title: course.title });
      json(res, 200, { course });
      return true;
    }

    if (head === 'courses' && rest.length === 1 && req.method === 'PATCH') {
      const body = await readJson(req, 8 * 1024);
      const course = courses.update(ctx.db, user, rest[0], { title: body.title, archived: body.archived });
      auditLog(ctx, req, user, 'course_modified', { courseCode: course.code, title: course.title, archived: course.archived });
      json(res, 200, { course });
      return true;
    }

    // A course's default watermark (Issue #157). Big enough for the logo's
    // own cap plus the JSON around it, and no bigger.
    if (head === 'courses' && rest.length === 2 && rest[1] === 'branding' && req.method === 'PUT') {
      const body = await readJson(req, courses.MAX_BRANDING_IMAGE_CHARS + 8 * 1024);
      const branding = courses.setBranding(ctx.db, user, rest[0], body.branding || {});
      auditLog(ctx, req, user, 'course_branding_modified', {
        courseCode: String(rest[0]).toLowerCase(), text: branding.text, image: !!branding.image, position: branding.position,
      });
      json(res, 200, { branding });
      return true;
    }

    if (head === 'courses' && rest.length === 2 && rest[1] === 'members' && req.method === 'POST') {
      const body = await readJson(req, 8 * 1024);
      json(res, 200, { people: courses.addMember(ctx.db, user, rest[0], { username: body.username, role: body.role }) });
      return true;
    }

    if (head === 'courses' && rest.length === 3 && rest[1] === 'members' && req.method === 'DELETE') {
      json(res, 200, { people: courses.removeMember(ctx.db, user, rest[0], decodeURIComponent(rest[2])) });
      return true;
    }

    // --- a course's roster (Issue #256) -------------------------------------
    //
    // Who attendance is taken for. Its owners (and admins) change it; its
    // other members can read it. See roster.js.

    if (head === 'courses' && rest[1] === 'roster') {
      const code = rest[0];
      const what = rest.slice(2);
      if (!what.length && req.method === 'GET') {
        json(res, 200, roster.list(ctx.db, user, code, { removed: url.searchParams.get('removed') === '1' }));
        return true;
      }
      if (!what.length && req.method === 'POST') {
        const person = roster.add(ctx.db, user, code, await readJson(req, 8 * 1024));
        auditLog(ctx, req, user, 'roster_added', { courseCode: String(code).toLowerCase(), name: person.name });
        json(res, 200, { person });
        return true;
      }
      if (what.length === 1 && what[0] === 'export' && req.method === 'GET') {
        const csv = roster.exportCsv(ctx.db, user, code);
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${String(code).toLowerCase().replace(/[^a-z0-9._-]/g, '')}-roster.csv"`,
          'cache-control': 'no-store',
        });
        res.end(csv);
        return true;
      }
      // An import: the CSV is the body. ?apply=1 does it; otherwise it is a
      // preview of what it would do. ?replace=1 also takes off anyone not in it.
      if (what.length === 1 && what[0] === 'import' && req.method === 'POST') {
        const text = (await readBuffer(req, 2 * 1024 * 1024)).toString('utf8');
        const replace = url.searchParams.get('replace') === '1';
        if (url.searchParams.get('apply') === '1') {
          const result = roster.applyImport(ctx.db, user, code, text, { replace });
          auditLog(ctx, req, user, 'roster_imported', { courseCode: String(code).toLowerCase(), replace, ...result, problems: result.problems.length });
          json(res, 200, result);
        } else {
          json(res, 200, roster.previewImport(ctx.db, user, code, text, { replace }));
        }
        return true;
      }
      if (what.length === 1 && req.method === 'PATCH') {
        const person = roster.update(ctx.db, user, code, what[0], await readJson(req, 8 * 1024));
        auditLog(ctx, req, user, 'roster_modified', { courseCode: String(code).toLowerCase(), id: person.id, name: person.name });
        json(res, 200, { person });
        return true;
      }
      if (what.length === 1 && req.method === 'DELETE') {
        const person = roster.remove(ctx.db, user, code, what[0]);
        auditLog(ctx, req, user, 'roster_removed', { courseCode: String(code).toLowerCase(), id: person.id, name: person.name });
        json(res, 200, { person });
        return true;
      }
    }

    // --- taking attendance (Issue #256) -----------------------------------
    //
    // Anyone in a course (owner or TA) opens and closes check-in, watches it
    // fill and marks people by hand. The students' side is public and lives
    // under /attend - see handleAttend in podium-server.js.

    if (head === 'attendance') {
      const courseCode = (session) => String(session.course || '').toLowerCase();
      if (rest[0] === 'current' && rest.length === 1 && req.method === 'GET') {
        json(res, 200, attendance.currentSession(ctx.db, user, {
          course: url.searchParams.get('course'), lectureId: url.searchParams.get('lecture') || null,
        }));
        return true;
      }
      if (rest[0] === 'sessions' && rest.length === 1 && req.method === 'POST') {
        const body = await readJson(req, 8 * 1024);
        const { session, reopened } = attendance.openSession(ctx.db, user, body);
        auditLog(ctx, req, user, reopened ? 'attendance_reopened' : 'attendance_opened', { courseCode: courseCode(session), sessionId: session.id });
        if (session.lectureId) {
          lectures.noteAttendance(ctx.db, session.lectureId, {
            title: reopened ? 'Attendance reopened' : 'Attendance opened', detail: { sessionId: session.id, open: true },
          });
        }
        json(res, 200, { session, reopened });
        return true;
      }
      if (rest[0] === 'sessions' && rest.length === 2 && req.method === 'GET') {
        json(res, 200, attendance.getSession(ctx.db, user, rest[1]));
        return true;
      }
      if (rest[0] === 'sessions' && rest.length === 2 && req.method === 'PATCH') {
        const body = await readJson(req, 8 * 1024);
        const session = attendance.changeSession(ctx.db, user, rest[1], body);
        if (body.open !== undefined) {
          auditLog(ctx, req, user, session.open ? 'attendance_reopened' : 'attendance_closed', { courseCode: courseCode(session), sessionId: session.id });
          if (session.lectureId) {
            const here = session.counts.present + session.counts.late;
            lectures.noteAttendance(ctx.db, session.lectureId, session.open
              ? { title: 'Attendance reopened', detail: { sessionId: session.id, open: true } }
              : { title: `Attendance closed · ${here} checked in${session.rosterSize ? ` of ${session.rosterSize}` : ''}`,
                detail: { sessionId: session.id, open: false, count: here, late: session.counts.late, roster: session.rosterSize } });
          }
        }
        json(res, 200, { session });
        return true;
      }
      if (rest[0] === 'sessions' && rest[2] === 'marks' && rest.length === 3 && req.method === 'POST') {
        const changed = attendance.markByHand(ctx.db, user, rest[1], await readJson(req, 8 * 1024));
        auditLog(ctx, req, user, 'attendance_marked', { sessionId: Number(rest[1]), ...changed });
        json(res, 200, changed);
        return true;
      }
      if (rest[0] === 'sessions' && rest[2] === 'marks' && rest.length === 4 && req.method === 'PATCH') {
        const changed = attendance.changeMark(ctx.db, user, rest[1], rest[3], await readJson(req, 8 * 1024));
        auditLog(ctx, req, user, 'attendance_marked', { sessionId: Number(rest[1]), ...changed });
        json(res, 200, changed);
        return true;
      }
      // After class (phase 3): flags let go, a guest put on the roster, a
      // session deleted, the course's sessions, the term grid and exports.
      if (rest[0] === 'sessions' && rest[2] === 'marks' && rest[4] === 'dismiss' && rest.length === 5 && req.method === 'POST') {
        const changed = attendance.dismissFlags(ctx.db, user, rest[1], rest[3]);
        auditLog(ctx, req, user, 'attendance_flags_dismissed', { sessionId: Number(rest[1]), ...changed });
        json(res, 200, changed);
        return true;
      }
      if (rest[0] === 'sessions' && rest[2] === 'marks' && rest[4] === 'roster' && rest.length === 5 && req.method === 'POST') {
        const { person, linked } = attendance.addGuestToRoster(ctx.db, user, rest[1], rest[3]);
        auditLog(ctx, req, user, 'roster_added', { sessionId: Number(rest[1]), name: person.name, fromGuest: true, linked });
        json(res, 200, { person, linked });
        return true;
      }
      if (rest[0] === 'sessions' && rest.length === 2 && req.method === 'DELETE') {
        const gone = attendance.deleteSession(ctx.db, user, rest[1]);
        auditLog(ctx, req, user, 'attendance_session_deleted', { courseCode: gone.course, sessionId: gone.id, marks: gone.marks });
        json(res, 200, gone);
        return true;
      }
      const range = () => ({
        from: Number(url.searchParams.get('from')) || 0,
        to: Number(url.searchParams.get('to')) || 0,
        tz: Number(url.searchParams.get('tz')) || 0,
      });
      if (rest[0] === 'courses' && rest.length === 3 && rest[2] === 'sessions' && req.method === 'GET') {
        json(res, 200, attendance.listSessions(ctx.db, user, rest[1], range()));
        return true;
      }
      if (rest[0] === 'courses' && rest.length === 3 && rest[2] === 'grid' && req.method === 'GET') {
        json(res, 200, attendance.grid(ctx.db, user, rest[1], range()));
        return true;
      }
      if (rest[0] === 'courses' && rest.length === 3 && rest[2] === 'export' && req.method === 'GET') {
        const format = ['long', 'grid', 'canvas'].includes(url.searchParams.get('format')) ? url.searchParams.get('format') : 'long';
        const points = Object.fromEntries(['present', 'late', 'excused', 'absent']
          .map((k) => [k, url.searchParams.get(k) ?? undefined]));
        const csv = attendance.exportCsv(ctx.db, user, rest[1], { ...range(), format, points });
        const name = String(rest[1]).toLowerCase().replace(/[^a-z0-9._-]/g, '');
        res.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${name}-attendance${format === 'long' ? '' : `-${format}`}.csv"`,
          'cache-control': 'no-store',
        });
        res.end(csv);
        return true;
      }
      if (rest[0] === 'sessions' && rest[2] === 'marks' && rest.length === 4 && req.method === 'DELETE') {
        const changed = attendance.removeMark(ctx.db, user, rest[1], rest[3]);
        auditLog(ctx, req, user, 'attendance_unmarked', { sessionId: Number(rest[1]), ...changed });
        json(res, 200, changed);
        return true;
      }
    }

    // --- accounts ---------------------------------------------------------
    //
    // Administrators only, all of it. Who else has an account here is not a
    // member's business, and neither is making one.

    if (head === 'people') {
      if (!user.isAdmin) { json(res, 403, { error: 'only an administrator can manage accounts' }); return true; }

      if (!rest.length && req.method === 'GET') {
        json(res, 200, { people: accounts.listUsers(ctx.db), me: user.id });
        return true;
      }

      if (!rest.length && req.method === 'POST') {
        const body = await readJson(req, 8 * 1024);
        const person = await accounts.createUser(ctx.db, {
          username: body.username,
          password: body.password,
          displayName: body.displayName,
          isAdmin: !!body.isAdmin,
        });
        auditLog(ctx, req, user, 'user_created', { targetUsername: person.username });
        json(res, 200, { person });
        return true;
      }

      if (rest.length === 1 && req.method === 'PATCH') {
        json(res, 200, { person: await changePerson(ctx, req, user, decodeURIComponent(rest[0]), await readJson(req, 8 * 1024)) });
        return true;
      }
    }

    // --- kiosk profiles (Issue #151) ----------------------------------------
    //
    // Administrators only, the same as accounts - a device nobody is
    // physically watching is exactly the wrong thing to let course
    // membership decide who can repoint. The one exception, redeeming a
    // provisioning link, is public on purpose and lives before the auth gate
    // above, not here.

    if (head === 'kiosks') {
      if (!user.isAdmin) { json(res, 403, { error: 'only an administrator can manage kiosks' }); return true; }

      if (!rest.length && req.method === 'GET') {
        json(res, 200, { kiosks: kiosks.list(ctx.db), plans: plans.listPlans(ctx.db, user) });
        return true;
      }

      if (!rest.length && req.method === 'POST') {
        const body = await readJson(req, 8 * 1024);
        const kiosk = kiosks.create(ctx.db, user, { name: body.name, settings: body.settings, planId: body.planId });
        auditLog(ctx, req, user, 'kiosk_created', { kioskId: kiosk.id, name: kiosk.name });
        json(res, 200, { kiosk });
        return true;
      }

      if (rest.length === 1 && req.method === 'PATCH') {
        const body = await readJson(req, 8 * 1024);
        const kiosk = kiosks.update(ctx.db, user, rest[0], {
          name: body.name, settings: body.settings, planId: body.planId, revoked: body.revoked, schedule: body.schedule,
        });
        auditLog(ctx, req, user, 'kiosk_modified', { kioskId: kiosk.id, name: kiosk.name, revoked: kiosk.revoked });
        json(res, 200, { kiosk });
        return true;
      }
    }

    // --- what the box is holding -------------------------------------------

    if (head === 'storage' && req.method === 'GET') {
      if (!user.isAdmin) { json(res, 403, { error: 'only an administrator can see this' }); return true; }
      json(res, 200, storageReport(ctx));
      return true;
    }

    if (head === 'library' && rest[0] === 'upload' && req.method === 'POST') {
      json(res, 200, await receiveUpload(req, url, ctx, user));
      return true;
    }

    // An old binary Word .doc, turned into a .docx by LibreOffice so the
    // browser can make a document of it the way it does any .docx (#258).
    // Nothing is kept: the bytes go back in the answer.
    if (head === 'convert' && rest[0] === 'docx' && req.method === 'POST') {
      const raw = await readBuffer(req, library.MAX_UPLOAD_BYTES);
      const docx = await pptxConvert.convertToDocx(raw);
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-length': docx.length,
        'cache-control': 'no-store',
      });
      res.end(docx);
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

    // A deck's new markdown, from the deck editor (Issue #226). The body IS the
    // text; If-Match carries the version the editor opened, so two people
    // saving over each other is a 412 with the current version rather than a
    // silent overwrite.
    if (head === 'library' && rest.length === 2 && rest[1] === 'content' && req.method === 'PUT') {
      const text = (await readBuffer(req, library.MAX_DECK_SOURCE_BYTES)).toString('utf8');
      try {
        const item = await library.replaceDeckContent(ctx.db, user, ctx.dataDir, rest[0], text, {
          ifMatch: req.headers['if-match'] || '',
        });
        json(res, 200, { item });
      } catch (err) {
        if (err.status === 412) { json(res, 412, { error: err.message, version: err.version }); return true; }
        throw err;
      }
      return true;
    }

    // A deck's earlier versions (Issue #226), each readable at its own
    // /media/<sha>/ address by anyone who can see the deck.
    // Which library deck a content address belongs to (see deckForVersion).
    if (head === 'library' && rest.length === 2 && rest[0] === 'deck-for' && req.method === 'GET') {
      const item = /^[0-9a-f]{64}$/i.test(rest[1]) ? library.deckForVersion(ctx.db, user, rest[1]) : null;
      if (!item) { json(res, 404, { error: 'no deck you can see has that version' }); return true; }
      json(res, 200, { item });
      return true;
    }

    if (head === 'library' && rest.length === 2 && rest[1] === 'revisions' && req.method === 'GET') {
      json(res, 200, { revisions: library.deckRevisions(ctx.db, user, rest[0]) });
      return true;
    }

    if (head === 'library' && rest.length === 1 && req.method === 'PATCH') {
      const body = await readJson(req);
      const item = library.renameItem(ctx.db, user, rest[0], {
        title: body.title, group: body.group,
        courseCode: 'course' in body ? body.course : undefined,
        kind: 'type' in body ? body.type : undefined,
      });
      json(res, 200, { item });
      return true;
    }

    if (head === 'library' && rest.length === 1 && req.method === 'DELETE') {
      json(res, 200, { removed: library.deleteItem(ctx.db, user, rest[0]).id });
      return true;
    }

    // --- lecture plans ----------------------------------------------------

    // --- the decks this person has had open in the deck editor (Issue #241) ---

    if (head === 'me' && rest.length === 1 && rest[0] === 'recent-decks' && req.method === 'GET') {
      json(res, 200, { decks: recent.list(ctx.db, user) });
      return true;
    }

    if (head === 'me' && rest.length === 1 && rest[0] === 'recent-decks' && req.method === 'POST') {
      const body = await readJson(req, 8 * 1024);
      json(res, 200, recent.note(ctx.db, user, { src: body.src, title: body.title, saved: body.saved === true }));
      return true;
    }

    // --- My Files (Issue #243): who I am, and my own password -----------------

    if (head === 'me' && rest.length === 1 && rest[0] === 'profile' && req.method === 'GET') {
      json(res, 200, { user, courses: courses.memberships(ctx.db, user) });
      return true;
    }

    // Light or dark on every page they open, from any device (set on My Files).
    if (head === 'me' && rest.length === 1 && rest[0] === 'preferences' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024);
      json(res, 200, { ok: true, theme: accounts.setTheme(ctx.db, user, body.theme) });
      return true;
    }

    if (head === 'me' && rest.length === 1 && rest[0] === 'password' && req.method === 'POST') {
      const body = await readJson(req, 8 * 1024);
      const result = await accounts.changeOwnPassword(ctx.db, user, body.current, body.password, {
        userAgent: req.headers['user-agent'] || '',
        ip: clientIp(req),
      });
      if (!result.ok) {
        const retry = result.retryAfterMs;
        json(res, retry ? 429 : 403,
          { error: retry ? 'too many attempts, try again shortly' : 'that is not your current password' },
          retry ? { 'retry-after': String(Math.ceil(retry / 1000)) } : {});
        return true;
      }
      // Every other session of this account has just ended; this browser is
      // handed the one fresh session changeOwnPassword made.
      json(res, 200, { ok: true }, { 'set-cookie': setCookie(req, result.token, Math.floor(accounts.SESSION_MS / 1000)) });
      return true;
    }

    if (head === 'plans' && !rest.length && req.method === 'GET') {
      // ?archived=1 / 0: only the lectures this caller has archived from
      // their own list (Issue #239), or only the rest. Left out: all, each
      // saying which it is.
      const which = url.searchParams.get('archived');
      const archived = which === '1' ? true : which === '0' ? false : undefined;
      json(res, 200, { plans: plans.listPlans(ctx.db, user, { archived }), courses: library.listCourses(ctx.db, user) });
      return true;
    }

    // Before /api/plans/:id below, which would otherwise take "archive" for an id.
    if (head === 'plans' && rest.length === 1 && rest[0] === 'archive' && req.method === 'PUT') {
      const body = await readJson(req, 64 * 1024);
      json(res, 200, plans.setArchived(ctx.db, user, body.ids, body.archived !== false));
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
          baseUpdatedAt: body.baseUpdatedAt,
        }),
      });
      return true;
    }

    if (head === 'plans' && rest.length === 1 && req.method === 'DELETE') {
      json(res, 200, { removed: plans.deletePlan(ctx.db, user, rest[0]).id });
      return true;
    }

    // --- course plan templates (Issue #80) ---------------------------------
    //
    // Read follows course membership, same as settings - starting from the
    // template is not different from being handed the room's passphrase,
    // both are things membership already grants. Writing one is an owner's
    // or an admin's, enforced inside templates.write/remove themselves.

    if (head === 'templates' && !rest.length && req.method === 'GET') {
      json(res, 200, { templates: templates.forUser(ctx.db, user) });
      return true;
    }

    if (head === 'templates' && rest.length === 1 && req.method === 'PUT') {
      const body = await readJson(req, templates.MAX_DOC_BYTES + 1024);
      json(res, 200, { saved: templates.write(ctx.db, user, rest[0], body.doc) });
      return true;
    }

    if (head === 'templates' && rest.length === 1 && req.method === 'DELETE') {
      json(res, 200, { removed: templates.remove(ctx.db, user, rest[0]) });
      return true;
    }

    // --- deck templates (Issue #226) ----------------------------------------
    //
    // A course's and your own; the built-ins are files under
    // content/deck-templates/, of which the server only keeps which an admin
    // has hidden. Who may write which is decided in deck-templates.js.

    if (head === 'deck-templates' && !rest.length && req.method === 'GET') {
      json(res, 200, deckTemplates.forUser(ctx.db, user));
      return true;
    }

    if (head === 'deck-templates' && !rest.length && req.method === 'POST') {
      const body = await readJson(req, deckTemplates.MAX_MARKDOWN_BYTES + 4096);
      json(res, 200, { template: deckTemplates.create(ctx.db, user, body) });
      return true;
    }

    if (head === 'deck-templates' && rest.length === 2 && rest[0] === 'builtin' && req.method === 'PUT') {
      const body = await readJson(req);
      json(res, 200, deckTemplates.hideBuiltIn(ctx.db, user, rest[1], !!body.hidden));
      return true;
    }

    if (head === 'deck-templates' && rest.length === 1 && req.method === 'PUT') {
      const body = await readJson(req, deckTemplates.MAX_MARKDOWN_BYTES + 4096);
      json(res, 200, { template: deckTemplates.update(ctx.db, user, rest[0], body) });
      return true;
    }

    if (head === 'deck-templates' && rest.length === 1 && req.method === 'DELETE') {
      json(res, 200, { removed: deckTemplates.remove(ctx.db, user, rest[0]).id });
      return true;
    }

    // --- lectures: what happened in the room -------------------------------
    //
    // Written by the DISPLAY, which is the only device that holds the
    // decrypted state, and by a controller as it ends a poll. The relay writes
    // none of it and could not: it only ever sees ciphertext. See lectures.js.

    if (head === 'lectures' && !rest.length && req.method === 'GET') {
      json(res, 200, {
        // Each says whether this caller may delete it (Issue #243), so My Files
        // offers Delete only where the server will allow it.
        lectures: lectures.listLectures(ctx.db, user).map((l) => ({ ...l, mayDelete: lectures.mayDelete(ctx.db, user, l) })),
        // Scoped to what this caller may see, the same as the lecture list
        // just above it - the instance-wide total is the Storage card's own,
        // admin-only question (see the comment on usage()).
        usage: lectures.usage(ctx.db, user),
        limits: { fileBytes: lectures.MAX_FILE_BYTES, lectureBytes: lectures.MAX_LECTURE_BYTES },
      });
      return true;
    }

    if (head === 'lectures' && !rest.length && req.method === 'POST') {
      const body = await readJson(req, 8 * 1024);
      // `fresh` is the display saying this is a NEW class rather than the same
      // one after a reload - what "Clear this room's saved session" on the
      // arming screen means. Without it, a lecture still inside the idle
      // window is resumed (see startLecture).
      json(res, 200, {
        lecture: lectures.startLecture(ctx.db, user, {
          room: body.room, title: body.title, dataDir: ctx.dataDir, resume: !body.fresh,
        }),
      });
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

    // Re-exporting is supposed to replace what a previous export left, not
    // just add to it (see addFile's own comment on the same-name upsert) -
    // but a file the newer export no longer produces at all (a photo the
    // switch has since turned off, one deleted from the strip, a poll aged
    // out of history) has no name for that upsert to replace. This is the
    // other half: an explicit removal, same permission as filing one in the
    // first place.
    if (head === 'lectures' && rest.length === 2 && rest[1] === 'files' && req.method === 'DELETE') {
      json(res, 200, lectures.removeFile(ctx.db, user, rest[0], url.searchParams.get('name'), { dataDir: ctx.dataDir }));
      return true;
    }

    if (head === 'lectures' && rest.length === 2 && rest[1] === 'end' && req.method === 'POST') {
      const body = await readJson(req, 8 * 1024).catch(() => ({}));
      json(res, 200, { lecture: lectures.endLecture(ctx.db, user, rest[0], { at: body.at, dataDir: ctx.dataDir }) });
      return true;
    }

    // "Still here." The display says this on a timer while it is live, and it
    // is the only thing standing between a lecture and the idle sweep (see
    // closeIdleLectures). No body, nothing to read: a class where nothing
    // changes for twenty minutes is still a class, so this deliberately says
    // nothing about what is on screen.
    if (head === 'lectures' && rest.length === 2 && rest[1] === 'alive' && req.method === 'POST') {
      json(res, 200, lectures.keepAlive(ctx.db, user, rest[0]));
      return true;
    }

    // --- connection settings ----------------------------------------------
    //
    // This hands out room passphrases, which is the whole point of it: a
    // device that has these can join the room. Membership of the course is
    // what earns them, and writing them takes more than membership.

    if (head === 'settings' && !rest.length && req.method === 'GET') {
      // Archived courses only for admin.html's own settings card asking for
      // them by name (?archived=1) - never for an ordinary device's silent
      // auto-setup (config.js hits this same route with no query string),
      // which has no business being offered a course that is meant to have
      // stopped being usable. forUser ignores the flag for a non-admin
      // anyway, but the query string is also the only way a plain device
      // could ask, so it is worth being deliberate about here too.
      const includeArchived = url.searchParams.get('archived') === '1';
      json(res, 200, { courses: settings.forUser(ctx.db, user, { includeArchived }) });
      return true;
    }

    if (head === 'settings' && rest.length === 1 && req.method === 'PUT') {
      const body = await readJson(req, 8 * 1024);
      const saved = settings.write(ctx.db, user, rest[0], body.settings || body);
      auditLog(ctx, req, user, 'settings_updated', { courseCode: rest[0] });
      json(res, 200, { saved });
      return true;
    }

    if (head === 'logs' && rest[0] === 'download' && req.method === 'GET') {
      if (!user.isAdmin) { json(res, 403, { error: 'only an administrator can download logs' }); return true; }
      auditLog(ctx, req, user, 'logs_downloaded', {});
      const rows = ctx.db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC').all();
      let csv = 'ID,Timestamp,User ID,Username,Action,IP Address,User Agent,Details\n';
      for (const row of rows) {
        csv += [
          row.id,
          new Date(row.created_at).toISOString(),
          row.user_id || '',
          row.username || '',
          row.action || '',
          row.ip_address || '',
          row.user_agent || '',
          row.details || ''
        ].map(val => `"${String(val).replace(/"/g, '""')}"`).join(',') + '\n';
      }
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="podium-logs-${new Date().toISOString().slice(0, 10)}.csv"`,
        'cache-control': 'no-store'
      });
      res.end(csv);
      return true;
    }

    // --- ZIP imports (Issue #106) ------------------------------------------
    //
    // Upload stages and inspects; the review screen then commits or cancels.
    // Every step after the upload is the uploader's alone (see loadJob).

    if (head === 'import' && rest[0] === 'zip') {
      const id = rest[1];
      if (rest.length === 1 && req.method === 'POST') {
        const surface = url.searchParams.get('surface') === 'admin' ? 'admin' : 'planner';
        if (surface === 'admin' && !user.isAdmin) {
          json(res, 403, { error: 'only an administrator can import into the content folders' });
          return true;
        }
        const uploadMb = zipImport.uploadMbSetting(ctx.db, store);
        // Refused before a byte is read when the browser says up front how
        // big it is, which it does for a file.
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > uploadMb * 1024 * 1024) {
          json(res, 413, { error: `This ZIP is ${Math.round(declared / 1024 / 1024)} MB; the most this server takes is ${uploadMb} MB.` });
          return true;
        }
        const job = await zipStaging.stage({
          db: ctx.db, dataDir: ctx.dataDir, user, surface, stream: req, uploadMb,
          archiveName: url.searchParams.get('filename') || 'Import.zip',
          contentDir: content.resolveRoots(ctx).contentDir,
        });
        json(res, 200, { job });
        return true;
      }
      if (rest.length === 2 && req.method === 'GET') {
        json(res, 200, { job: await zipStaging.getJob(ctx.dataDir, user, id) });
        return true;
      }
      if (rest.length === 2 && req.method === 'DELETE') {
        json(res, 200, await zipStaging.cancel(ctx.dataDir, user, id));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'preview' && req.method === 'GET') {
        const { type, body } = await zipStaging.preview(ctx.dataDir, user, id, url.searchParams.get('path') || '');
        res.writeHead(200, {
          'content-type': type,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'cache-control': 'private, no-store',
        });
        res.end(body);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'commit' && req.method === 'POST') {
        const body = await readJson(req, 512 * 1024);
        const result = await zipStaging.commit(ctx, user, id, body);
        auditLog(ctx, req, user, 'zip_imported', {
          surface: result.surface, imported: result.imported.length, skipped: result.skipped.length, failed: result.failed.length,
        });
        json(res, 200, result);
        return true;
      }
    }

    // --- system settings (Issue #72) --------------------------------------
    if (head === 'system' && rest[0] === 'settings') {
      const current = () => ({
        allowPollNames: ctx.db ? store.getSystemSetting(ctx.db, 'allow_poll_names', '0') === '1' : false,
        // Issue #106: the largest ZIP an import accepts, in MB.
        maxZipUploadMb: zipImport.uploadMbSetting(ctx.db, store),
        // Issue #256: how long the device and network hashes behind an
        // attendance flag are kept. The marks themselves stay.
        attendanceRetentionDays: attendance.retentionDays(ctx.db),
      });
      if (rest.length === 1 && req.method === 'GET') {
        json(res, 200, current());
        return true;
      }
      if (rest.length === 1 && req.method === 'PUT') {
        if (!user.isAdmin) { json(res, 403, { error: 'only an administrator can change system settings' }); return true; }
        const body = await readJson(req, 8 * 1024);
        const changed = {};
        if (body.maxZipUploadMb !== undefined) {
          const mb = Number(body.maxZipUploadMb);
          if (!Number.isInteger(mb) || mb < 1 || mb > zipImport.MAX_UPLOAD_MB) {
            json(res, 400, { error: `the ZIP upload limit must be a whole number of MB from 1 to ${zipImport.MAX_UPLOAD_MB}` });
            return true;
          }
          store.setSystemSetting(ctx.db, 'max_zip_upload_mb', String(mb));
          changed.maxZipUploadMb = mb;
        }
        if (body.attendanceRetentionDays !== undefined) {
          changed.attendanceRetentionDays = attendance.setRetentionDays(ctx.db, body.attendanceRetentionDays);
        }
        if (body.allowPollNames !== undefined) {
          store.setSystemSetting(ctx.db, 'allow_poll_names', body.allowPollNames ? '1' : '0');
          changed.allowPollNames = !!body.allowPollNames;
        }
        auditLog(ctx, req, user, 'system_settings_updated', changed);
        json(res, 200, current());
        return true;
      }
    }

    // --- content management (Issue #54) -----------------------------------
    if (head === 'content') {
      if (!user.isAdmin) {
        json(res, 403, { error: 'only an administrator can manage content' });
        return true;
      }

      // Marp Themes
      if (rest[0] === 'themes') {
        if (rest.length === 1 && req.method === 'GET') {
          json(res, 200, content.listThemes(ctx));
          return true;
        }

        if (rest.length === 1 && req.method === 'POST') {
          const isJson = (req.headers['content-type'] || '').includes('application/json');
          let filename = url.searchParams.get('filename') || '';
          let css = '';
          if (isJson) {
            const body = await readJson(req, 10 * 1024 * 1024);
            filename = body.filename || filename;
            css = typeof body.css === 'string' ? body.css : '';
          } else {
            const buf = await readBuffer(req, 10 * 1024 * 1024);
            css = buf.toString('utf8');
          }
          if (!filename) {
            json(res, 400, { error: 'filename required' });
            return true;
          }
          json(res, 200, { saved: content.saveTheme(ctx, filename, css) });
          return true;
        }

        if (rest.length === 2 && req.method === 'GET') {
          const themeName = decodeURIComponent(rest[1]);
          const theme = content.getTheme(ctx, themeName);
          if (url.searchParams.get('download') === '1') {
            res.writeHead(200, {
              'content-disposition': `attachment; filename="${encodeURIComponent(theme.filename)}"`,
              'content-type': 'text/css; charset=utf-8',
            });
            res.end(theme.css);
            return true;
          }
          json(res, 200, { theme });
          return true;
        }

        if (rest.length === 2 && req.method === 'PUT') {
          const themeName = decodeURIComponent(rest[1]);
          const isJson = (req.headers['content-type'] || '').includes('application/json');
          let css = '';
          if (isJson) {
            const body = await readJson(req, 10 * 1024 * 1024);
            css = typeof body.css === 'string' ? body.css : '';
          } else {
            const buf = await readBuffer(req, 10 * 1024 * 1024);
            css = buf.toString('utf8');
          }
          json(res, 200, { saved: content.saveTheme(ctx, themeName, css) });
          return true;
        }

        if (rest.length === 2 && req.method === 'DELETE') {
          json(res, 200, content.deleteTheme(ctx, decodeURIComponent(rest[1])));
          return true;
        }
      }

      // Pre-load Files
      if (rest[0] === 'files') {
        if (rest.length === 1 && req.method === 'GET') {
          const category = url.searchParams.get('category') || null;
          json(res, 200, content.listFiles(ctx, category));
          return true;
        }

        if (rest.length === 2 && req.method === 'POST') {
          const category = rest[1];
          let filename = url.searchParams.get('filename') || '';
          if (!filename) {
            json(res, 400, { error: 'filename required in query parameter (?filename=...)' });
            return true;
          }
          const spec = content.CATEGORIES[category];
          if (!spec) {
            json(res, 400, { error: `invalid category: ${category}` });
            return true;
          }
          let buf = await readBuffer(req, spec.maxBytes);
          // A PowerPoint file into the PDFs category becomes a PDF on the way
          // in (Issue #107), read up to that category's own limit since that
          // is what it is about to be - the rest of this route never learns
          // the upload was anything else.
          const ext = path.extname(filename).toLowerCase();
          // A Word or RTF file put into PDFs (Issue #258) was chosen as a PDF.
          if (category === 'pdfs' && (pptxConvert.CONVERTIBLE_EXTS.has(ext) || pptxConvert.WORD_EXTS.has(ext))) {
            buf = await pptxConvert.convertToPdf(buf, ext);
            filename = `${filename.slice(0, -ext.length)}.pdf`;
          }
          json(res, 200, { saved: content.saveContentFile(ctx, category, filename, buf) });
          return true;
        }

        if (rest.length === 3 && req.method === 'GET') {
          const category = rest[1];
          const filename = decodeURIComponent(rest[2]);
          const item = content.getContentFile(ctx, category, filename);
          if (url.searchParams.get('download') === '1') {
            const roots = content.resolveRoots(ctx);
            const catDir = path.join(roots.contentDir, content.CATEGORIES[category]?.dir || category);
            const safe = content.safePath(catDir, filename);
            res.writeHead(200, {
              'content-disposition': `attachment; filename="${encodeURIComponent(item.filename)}"`,
              'content-length': item.size,
              'content-type': 'application/octet-stream',
            });
            fs.createReadStream(safe.full).pipe(res);
            return true;
          }
          json(res, 200, { file: item });
          return true;
        }

        if (rest.length === 3 && req.method === 'PUT') {
          const category = rest[1];
          const filename = decodeURIComponent(rest[2]);
          // The deck editor (Issue #226) says which version it opened, as the
          // file's mtime; a file changed since is a 412 rather than lost work.
          const expected = url.searchParams.get('ifMtime');
          if (expected) {
            let current = null;
            try { current = content.getContentFile(ctx, category, filename).mtime; } catch { /* a new file */ }
            if (current !== null && String(current) !== String(expected)) {
              json(res, 412, { error: 'this file was changed by someone else since you opened it', mtime: current });
              return true;
            }
          }
          const isJson = (req.headers['content-type'] || '').includes('application/json');
          let data;
          if (isJson) {
            const body = await readJson(req, 25 * 1024 * 1024);
            data = body.text !== undefined ? body.text : (body.data || '');
          } else {
            const buf = await readBuffer(req, 25 * 1024 * 1024);
            data = buf.toString('utf8');
          }
          json(res, 200, { saved: content.saveContentFile(ctx, category, filename, data) });
          return true;
        }

        if (rest.length === 3 && req.method === 'DELETE') {
          const category = rest[1];
          const filename = decodeURIComponent(rest[2]);
          json(res, 200, content.deleteContentFile(ctx, category, filename));
          return true;
        }
      }

      // Manifest
      if (rest[0] === 'manifest') {
        if (rest.length === 1 && req.method === 'GET') {
          json(res, 200, { manifest: content.getManifest(ctx) });
          return true;
        }
        if (rest.length === 1 && req.method === 'PUT') {
          const body = await readJson(req, 1024 * 1024);
          json(res, 200, content.saveManifest(ctx, body.manifest || body));
          return true;
        }
      }

      // Music
      if (rest[0] === 'music') {
        if (rest.length === 1 && req.method === 'GET') {
          json(res, 200, { music: content.getMusic(ctx) });
          return true;
        }
        if (rest.length === 1 && req.method === 'PUT') {
          const body = await readJson(req, 1024 * 1024);
          json(res, 200, content.saveMusic(ctx, body.music || body));
          return true;
        }
      }
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
  let filename = String(url.searchParams.get('filename') || '').split(/[\\/]/).pop().slice(0, 200);
  const ext = path.extname(filename).toLowerCase();
  // A Word or RTF file (Issue #258) is stored as a PDF only when the person
  // chose that over a markdown document; the document is made in the browser
  // and arrives here as an ordinary .md, so the raw file is not taken.
  const word = pptxConvert.WORD_EXTS.has(ext);
  if (word && url.searchParams.get('as') !== 'pdf') {
    throw Object.assign(new Error(
      'Choose how to show a Word or RTF file: as a document (it is converted in your browser) or as a PDF (keeping its layout).',
    ), { status: 415 });
  }
  const converts = word || pptxConvert.CONVERTIBLE_EXTS.has(ext);
  const allowed = converts ? { type: 'application/pdf', kind: 'pdf' } : library.uploadKindFor(filename);
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
  // A picture or video for a deck (Issue #226): filed where the deck's own
  // editors can file it, and kept with the deck's other media.
  const deckMedia = String(url.searchParams.get('deckMedia') || '').trim().slice(0, 200);
  if (deckMedia && !['image', 'video'].includes(allowed.kind)) {
    throw Object.assign(new Error('only pictures and videos can be added to a deck'), { status: 415 });
  }
  if (deckMedia && !library.mayAddDeckMedia(ctx.db, user, courseCode)) {
    throw Object.assign(new Error(`only an owner of ${courseCode.toUpperCase()} or an admin can add pictures and videos to its decks`), { status: 403 });
  }

  // A PowerPoint file becomes a PDF on the way in (Issue #107) - read up to
  // the same limit an ordinary PDF upload already has, since that is what it
  // is about to become, then hand it to LibreOffice before anything is
  // stored. Everything after this point never learns the upload was
  // anything but a plain PDF.
  let body = req;
  if (converts) {
    const raw = await readBuffer(req, library.MAX_UPLOAD_BYTES);
    body = Readable.from(await pptxConvert.convertToPdf(raw, ext));
    filename = `${filename.slice(0, -ext.length)}.pdf`;
  }

  // The declared content type is ignored in favour of the extension's: these
  // bytes come back from this origin later, and what a browser is told they
  // are must not be something an uploader chose. The KIND comes from the same
  // mapping for the same reason - `week.md&type=web` would otherwise hand
  // markdown to the web-page renderer.
  const { sha256, bytes } = await library.storeUpload(ctx.dataDir, body);
  let mediaId;
  try {
    mediaId = library.rememberMedia(ctx.db, user, { sha256, bytes, contentType: allowed.type });
    // The same photo put on a second slide is the item already there.
    if (deckMedia) {
      const same = library.findSameMedia(ctx.db, user, { kind: allowed.kind, sha256, courseCode });
      if (same) return { item: same, existing: true };
    }
    // A .md is a deck only when it says `marp: true` (Issue #240); anything
    // else is a document to read. Its front matter is in the first few KB.
    let kind = allowed.kind;
    if (kind === 'deck') {
      const handle = await fs.promises.open(library.mediaPath(ctx.dataDir, sha256), 'r');
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(8192), 0, 8192, 0);
        kind = library.markdownKind(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally { await handle.close(); }
    }
    const item = library.addItem(ctx.db, user, {
      courseCode,
      kind,
      title: url.searchParams.get('title') || filename.replace(/\.[^.]+$/, ''),
      group: url.searchParams.get('group') || (deckMedia ? library.DECK_MEDIA_GROUP : ''),
      filename,
      mediaId,
      props: deckMedia ? { deckMedia } : {},
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
 * Change one account, from the admin page.
 *
 * Four separate things behind one route because they are four checkboxes on one
 * row: the name, administrator or not, disabled or not, and a new password.
 *
 * The two that can strand the instance are refused HERE rather than in
 * accounts.js, which is deliberate - see assertAnotherAdminRemains. A browser
 * is where a slip happens; podium-admin at a shell is what a slip is recovered
 * with, and it keeps its teeth.
 */
async function changePerson(ctx, req, user, username, body) {
  const person = accounts.findUser(ctx.db, username);
  if (!person) throw Object.assign(new Error(`no account called ${username}`), { status: 404 });

  if (body.displayName !== undefined) accounts.setDisplayName(ctx.db, username, body.displayName);

  if (body.isAdmin !== undefined && !!body.isAdmin !== !!person.is_admin) {
    if (!body.isAdmin) {
      // The admin.js client already hides this switch on your own row (see
      // isMe there), but the route is the thing that actually has to hold -
      // a client-side hidden checkbox is not a permission check.
      if (person.id === user.id) {
        throw Object.assign(new Error('you cannot take away your own administrator rights'), { status: 409 });
      }
      accounts.assertAnotherAdminRemains(ctx.db, username, 'taking that away');
    }
    accounts.setAdmin(ctx.db, username, !!body.isAdmin);
  }

  if (body.disabled !== undefined && !!body.disabled !== !!person.disabled_at) {
    if (body.disabled) {
      // Signing yourself out of the page you are standing on, permanently, is
      // never what the click meant.
      if (person.id === user.id) {
        throw Object.assign(new Error('you cannot disable the account you are signed in as'), { status: 409 });
      }
      accounts.assertAnotherAdminRemains(ctx.db, username, 'disabling it');
    }
    accounts.setDisabled(ctx.db, username, !!body.disabled);
  }

  // Last, so that a request which also disables an account cannot leave it with
  // a new password it can never use. setPassword drops every session that
  // account had, which is the point of doing it in a hurry.
  if (body.password) await accounts.setPassword(ctx.db, username, body.password);

  auditLog(ctx, req, user, 'user_modified', {
    targetUsername: username,
    updates: Object.keys(body).filter((k) => ['displayName', 'isAdmin', 'disabled', 'password'].includes(k)),
  });

  return accounts.publicUser(accounts.findUser(ctx.db, username));
}

/**
 * What this box is actually holding, in the three numbers an operator wants
 * before they go looking for more disk: the library, the session records, and
 * the database itself.
 */
function storageReport(ctx) {
  // WAL mode (see store.open) keeps recently-written pages in podium.db-wal
  // until the next checkpoint, plus a small -shm index alongside it - both
  // real bytes on disk that podium.db alone does not account for, and on a
  // busy instance they are not a rounding error.
  let database = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { database += fs.statSync(path.join(ctx.dataDir, `podium.db${suffix}`)).size; } catch { /* not there */ }
  }
  return {
    library: library.usage(ctx.db),
    sessions: lectures.usage(ctx.db),
    database,
    dataDir: ctx.dataDir,
    // The same disk-pressure thresholds `podium-admin doctor` uses, so the
    // admin page can warn before the box is actually full rather than only
    // once someone thinks to open this tab (Issue #160).
    disk: store.diskPressure(ctx.dataDir),
    // Media bytes live on disk beside the database, not inside it - so a copy
    // of the database alone is not a backup, and the page says so.
    // Matches doctor.checkStorage's own validation: only a finite, positive
    // number is a real retention setting, the same thing pruneFiles itself
    // requires - a stray "-1" must not be presented as a working setting.
    retentionDays: (() => {
      const days = Number(process.env.LECTURE_RETENTION_DAYS);
      return Number.isFinite(days) && days > 0 ? days : null;
    })(),
  };
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
    // The showcase page: public even here, so it can sell Podium and offer
    // a Sign in link to someone who has not signed in yet. See
    // AUTH_PUBLIC_WITH_ACCOUNTS in podium-server.js for why this sits below
    // openPaths rather than in it - it excuses only the accounts check, not
    // AUTH_PASSWORD further down.
    if (ctx.publicPaths?.has(pathname)) return true;
    const token = cookieToken(req);
    // Re-issue the cookie whenever the session's expiry slides forward.
    // setHeader rather than a writeHead argument, because the thing that
    // eventually answers this request (a file, a range, a redirect) writes its
    // own headers and knows nothing about sessions.
    const onSlide = () => res.setHeader('set-cookie', setCookie(req, token, Math.floor(accounts.SESSION_MS / 1000)));
    if (accounts.sessionUser(ctx.db, token, { onSlide })) return true;
    // A kiosk carries its own cookie, not a user session, and is only ever
    // let through for the narrow set of paths display.html actually needs
    // (see KIOSK_OPEN_PATHS in podium-server.js) - never control.html,
    // admin.html, or the authenticated API surface a stolen kiosk cookie
    // would otherwise unlock.
    if (ctx.kioskOpenPaths?.has(pathname)) {
      const kioskToken = kioskCookieToken(req);
      const kioskOnSlide = () =>
        res.setHeader('set-cookie', setKioskCookies(req, kioskToken, Math.floor(kiosks.SESSION_MS / 1000)));
      if (kiosks.sessionKiosk(ctx.db, kioskToken, { onSlide: kioskOnSlide })) return true;
    }
    // A Guest View viewer's pass (Issue #150): the files a live display is
    // showing, never a page or the API - see viewerMayRead in podium-server.js.
    if (ctx.viewerMayRead?.(req, pathname)) return true;
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

module.exports = {
  handleApi, gate, readJson, json, parseCookies, setCookie, safeNext, cookieToken, kioskCookieToken, clientIp, COOKIE, API_VERSION,
};
