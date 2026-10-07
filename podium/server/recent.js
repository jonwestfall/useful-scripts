// The decks someone has opened or saved in the deck editor lately (Issue
// #241): what the planner's "Choose from the server" lists first, so the deck
// you just made is a tap away rather than a path to remember.
//
// Kept per person, newest first, a few dozen at most. A deck in the library
// is only ever listed to someone who can still see it.

'use strict';

const library = require('./library.js');

const KEEP = 30;
const LIST = 12;
const MAX_SRC = 500;

const fail = (status, message) => Object.assign(new Error(message), { status });

// Only addresses of decks on this server: the library's, or content/decks.
function cleanSrc(src) {
  const text = String(src || '').trim();
  if (!text || text.length > MAX_SRC) return null;
  if (/^\/media\/deck\/\d+\/[^/]+$/.test(text)) return text;
  if (/^\/?content\/decks\/[^/]+\.(?:md|markdown)$/i.test(text) && !text.includes('..')) return text.replace(/^\//, '');
  return null;
}

/** Note that this person opened (or saved) the deck at `src` in the editor. */
function note(db, user, { src, title = '', saved = false } = {}) {
  const clean = cleanSrc(src);
  if (!clean) throw fail(400, 'that is not the address of a deck on this server');
  // Strictly after the last one, so two in the same millisecond still have
  // an order: "newest first" has to mean something.
  const last = db.prepare('SELECT MAX(at) AS at FROM deck_recent WHERE user_id = ?').get(user.id)?.at || 0;
  const at = Math.max(Date.now(), last + 1);
  db.prepare(`INSERT INTO deck_recent (user_id, src, title, saved, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, src) DO UPDATE SET title = CASE WHEN excluded.title = '' THEN title ELSE excluded.title END,
        saved = MAX(saved, excluded.saved), at = excluded.at`)
    .run(user.id, clean, String(title || '').slice(0, 200), saved ? 1 : 0, at);
  // Keep the newest few, not a history.
  db.prepare(`DELETE FROM deck_recent WHERE user_id = ? AND src NOT IN (
      SELECT src FROM deck_recent WHERE user_id = ? ORDER BY at DESC LIMIT ?)`).run(user.id, user.id, KEEP);
  return { src: clean };
}

/**
 * This person's recent decks, newest first - only ones they can still open:
 * a library deck they can still see, or content/decks.
 */
function list(db, user) {
  const rows = db.prepare('SELECT src, title, saved, at FROM deck_recent WHERE user_id = ? ORDER BY at DESC LIMIT ?').all(user.id, KEEP);
  const out = [];
  for (const row of rows) {
    const id = /^\/media\/deck\/(\d+)\//.exec(row.src)?.[1];
    if (id) {
      const item = library.getItem(db, user, id);
      if (!item) continue;
      out.push({ src: item.src, title: item.title || row.title, course: item.course || null, libraryId: item.id, saved: !!row.saved, at: row.at, where: 'library' });
    } else {
      out.push({ src: row.src, title: row.title, course: null, libraryId: null, saved: !!row.saved, at: row.at, where: 'content' });
    }
    if (out.length >= LIST) break;
  }
  return out;
}

module.exports = { note, list, cleanSrc };
