// Typed codes for Guest View (Issue #150): the fallback for a viewer who
// cannot scan the QR - type six characters on a phone, land on the same
// viewer link the QR carries.
//
// A poll code (see handlePoll in podium-server.js) is four characters and
// that is fine: a wrong guess shows a stranger somebody else's poll question.
// A wrong guess here would be silently watching somebody's live class, so
// this is built the other way round:
//
//   - six characters from the same unambiguous alphabet (32^6, about a
//     billion), not four;
//   - a code only answers while the display that owns it is LIVE. The display
//     keeps it alive with a touch every minute or so while it is on the air,
//     and drops it at stand-down; one not touched for LIVE_MS is gone. The
//     link itself is stable (the presenter rotates it deliberately), and the
//     display asks for the same code back each time it goes live, so a code
//     written on a syllabus keeps working - but it only works during class;
//   - lookups are rate-limited per IP, counting misses, so walking the code
//     space is not a thing one address can do;
//   - codes live in this process's memory only, so they are scoped to the
//     one server that issued them and gone on restart (the display registers
//     again on its next touch).
//
// What a code maps to is the link's fragment - the view room and view key -
// which this server can therefore read. That is the same trade the course
// settings table already makes for the room passphrase (see settings.js): a
// self-hosted instance holding its own keys. It never holds the ROOM
// passphrase for this: a view link can only ever open the view channel.

'use strict';

const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no O/0, no I/1 - read off a projector
const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);
const LIVE_MS = 3 * 60 * 1000;
const MAX_CODES = 500;
const MAX_LINK_CHARS = 1500;
const LOOKUP_WINDOW_MS = 5 * 60 * 1000;
const MAX_MISSES_PER_WINDOW = 20;
const MAX_TRACKED_IPS = 5000;

// The same test the client's isViewRoom makes (assets/js/protocol.js) - kept
// in step by hand, since this file is CommonJS and that one is not.
const VIEW_ROOM_RE = /^view\.[A-Za-z0-9_-]{8,40}$/;
const TRANSPORTS = new Set(['ws', 'mqtt', 'supabase']);

/**
 * The link must be a viewer link and nothing else: a view room, a view key,
 * and where to connect. A code is a public thing read off a projector, so it
 * must never be able to hand out anything that opens the real room.
 */
function cleanLink(raw) {
  const text = String(raw || '').replace(/^#/, '');
  if (!text || text.length > MAX_LINK_CHARS) return null;
  const params = new URLSearchParams(text);
  if (!TRANSPORTS.has(params.get('t')) || !VIEW_ROOM_RE.test(params.get('r') || '') || !params.get('p')) return null;
  return params.toString();
}

function createViewCodes({ now = () => Date.now() } = {}) {
  const codes = new Map();    // code -> { token, link, touched }
  const misses = new Map();   // ip -> { windowStart, count }

  const sweep = () => {
    const cutoff = now() - LIVE_MS;
    for (const [code, entry] of codes) if (entry.touched < cutoff) codes.delete(code);
  };

  const fresh = () => {
    for (let i = 0; i < 50; i++) {
      const code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
      if (!codes.has(code)) return code;
    }
    return null;
  };

  const tokenMatches = (entry, token) => {
    const given = Buffer.from(String(token || ''));
    const want = Buffer.from(entry.token);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  };

  /**
   * A display going live. `want` is the code it had last time: granted again
   * if nobody holds it, otherwise it gets a new one and should remember that
   * instead. Re-registering a code it already holds (same token) just keeps
   * it - that is what a display that reloaded mid-lecture does.
   */
  function register({ want, token, link }) {
    sweep();
    const clean = cleanLink(link);
    if (!clean) return { error: 'that is not a viewer link', status: 400 };
    const asked = String(want || '').toUpperCase();
    const held = CODE_RE.test(asked) ? codes.get(asked) : null;
    if (held && token && tokenMatches(held, token)) {
      held.link = clean;
      held.touched = now();
      return { code: asked, token: held.token };
    }
    if (codes.size >= MAX_CODES) return { error: 'too many viewer codes in use', status: 503 };
    const code = CODE_RE.test(asked) && !held ? asked : fresh();
    if (!code) return { error: 'no code available', status: 503 };
    const entry = { token: crypto.randomBytes(24).toString('base64url'), link: clean, touched: now() };
    codes.set(code, entry);
    return { code, token: entry.token };
  }

  /** Still live. False when the code is gone or not this caller's. */
  function touch(code, token) {
    const entry = codes.get(String(code || '').toUpperCase());
    if (!entry || !tokenMatches(entry, token) || entry.touched < now() - LIVE_MS) return false;
    entry.touched = now();
    return true;
  }

  /** Stand-down: the code stops answering now rather than in LIVE_MS. */
  function release(code, token) {
    const key = String(code || '').toUpperCase();
    const entry = codes.get(key);
    if (!entry || !tokenMatches(entry, token)) return false;
    codes.delete(key);
    return true;
  }

  function throttled(ip) {
    const entry = misses.get(ip);
    return !!entry && entry.windowStart + LOOKUP_WINDOW_MS > now() && entry.count >= MAX_MISSES_PER_WINDOW;
  }

  function noteMiss(ip) {
    const t = now();
    const entry = misses.get(ip);
    if (!entry || entry.windowStart + LOOKUP_WINDOW_MS <= t) misses.set(ip, { windowStart: t, count: 1 });
    else entry.count += 1;
    if (misses.size > MAX_TRACKED_IPS) {
      for (const [k, v] of misses) if (v.windowStart + LOOKUP_WINDOW_MS <= t) misses.delete(k);
      while (misses.size > MAX_TRACKED_IPS) misses.delete(misses.keys().next().value);
    }
  }

  /**
   * A viewer typing a code. Misses count against the caller's IP whether the
   * code was malformed, unknown or not live - the three must look identical
   * from outside, or the difference is itself something to probe for.
   */
  function lookup(code, ip) {
    if (throttled(ip)) return { error: 'too many tries - wait a few minutes', status: 429 };
    const key = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const entry = CODE_RE.test(key) ? codes.get(key) : null;
    if (!entry || entry.touched < now() - LIVE_MS) {
      noteMiss(ip);
      return { error: 'no class is live with that code right now', status: 404 };
    }
    return { link: entry.link };
  }

  return { register, touch, release, lookup, size: () => codes.size };
}

module.exports = { createViewCodes, cleanLink, CODE_LENGTH, LIVE_MS, MAX_MISSES_PER_WINDOW, VIEW_ROOM_RE };
