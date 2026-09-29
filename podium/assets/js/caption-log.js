// What the caption bar said, as lines a person could read back later (Issue
// #158) - the display's half of the lecture recap.
//
// The bar itself is a poor record on its own. Live captions (Issue #79) arrive
// as interim speech results, several a second, each one the WHOLE phrase so
// far and each one free to rewrite its last word; a pre-scripted or typed
// caption arrives once and sits there. Recording every update would file the
// same sentence thirty times over, so this watches the bar and writes a line
// down only once it is finished: when the bar clears, or when what is on it
// stops being a continuation of what was there before.
//
// "Continuation" is deliberately narrow. The new text must carry every word of
// the old one except, possibly, the last (the one speech recognition is still
// making its mind up about) - or be the old text cut short. When in doubt this
// writes a line and starts another: a near-duplicate line in a recap is a
// small blemish, a sentence silently merged away is a lost one.
//
// No DOM, no clock of its own and no network - the display hands it the bar's
// text and the time, and gets finished lines back through `onLine`.

export const MAX_CAPTION_CHARS = 1000;

const words = (text) => text.toLowerCase().split(/\s+/).filter(Boolean);

/** Whether `next` is the same phrase as `prev`, just further along (or revised at the end). */
export function continuesCaption(prev, next) {
  const a = words(prev);
  const b = words(next);
  if (!a.length || !b.length) return false;
  // Cut short: the recognizer backing off a word it had guessed.
  if (b.length < a.length) return b.every((word, i) => word === a[i]);
  const settled = a.slice(0, -1);
  if (!settled.length) {
    // One word so far. Only the very same word, or one it grows into
    // ("hyp" -> "hypothesis"), keeps it the same line.
    return b[0] === a[0] || b[0].startsWith(a[0]);
  }
  return settled.every((word, i) => word === b[i]);
}

/**
 * @param {(line: { at: number, text: string, live: boolean }) => void} onLine
 */
export function createCaptionLog(onLine) {
  let draft = null;   // { at, text, live } - the line still being said

  function finish() {
    if (draft?.text) onLine({ ...draft, text: draft.text.slice(0, MAX_CAPTION_CHARS) });
    draft = null;
  }

  /**
   * Called with whatever the bar shows right now ('' when it is hidden), as
   * often as the display likes - repeated identical calls are free.
   */
  function observe(text, { now = Date.now(), live = false } = {}) {
    const shown = String(text || '').trim();
    if (!shown) { finish(); return; }
    if (draft && shown === draft.text) return;
    if (draft && continuesCaption(draft.text, shown)) { draft.text = shown; return; }
    finish();
    // `at` is when the room first saw the line, not when it was finished.
    draft = { at: now, text: shown, live: !!live };
  }

  /** Write down whatever is still on the bar - a stand-down mid-sentence. */
  function flush() { finish(); }

  /** Forget the line in progress without writing it - a new lecture. */
  function reset() { draft = null; }

  return { observe, flush, reset };
}
