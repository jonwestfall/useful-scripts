// "Check before class" for a deck (Issue #226): what could go wrong in the
// room, from the markdown and from how it rendered. Shared by the deck editor
// and Quick Look (Issue #242), so both give the same list.
//
// Each problem is {slide, offset, severity: 'warning'|'info', message}, with
// offset into the markdown so an editor can take the cursor there.

import { parseDeck, checkDeck, mermaidFences } from './deck-source.js';
import { describeBuild } from './deck.js';

/** Every picture and video address a deck uses on this server, with where each is. */
export function serverMedia(deck) {
  const out = [];
  for (const slide of deck.slides) {
    const uses = [
      ...slide.media.map((m) => ({ src: m.src, at: m.start })),
      ...(slide.video ? [{ src: slide.video.src, at: Math.max(0, slide.raw.indexOf(slide.video.src)) }] : []),
    ];
    for (const use of uses) if (/^\/(?!\/)/.test(use.src)) out.push({ slide, ...use });
  }
  return out;
}

/**
 * Ask the server whether each of a deck's pictures and videos is really
 * there - once per address, with a HEAD request. `found` (src -> true |
 * 'HTTP 404' | null while asking) is kept by the caller across checks;
 * `onMissing` is called when an answer adds a problem.
 */
export function checkServerMedia(deck, found, onMissing = () => {}) {
  for (const { src } of serverMedia(deck)) {
    if (found.has(src)) continue;
    found.set(src, null);
    fetch(src, { method: 'HEAD', credentials: 'same-origin', cache: 'no-cache' })
      .then((res) => {
        found.set(src, res.ok || `HTTP ${res.status}`);
        if (!res.ok) onMissing();
      })
      .catch(() => found.delete(src));
  }
}

/**
 * The problems with a deck: from its markdown (checkDeck), its pictures and
 * videos the server said are missing, and what only rendering knows - the
 * theme, slides shrunk to fit, diagrams that could not be drawn, builds with
 * nothing to build.
 *
 * @param {string} md
 * @param {object|null} rendered - what render() in deck.js gave back for this markdown
 * @param {object} [opts]
 * @param {string} [opts.destination] - see checkDeck
 * @param {string} [opts.pageProtocol] - see checkDeck
 * @param {Map} [opts.mediaFound] - see checkServerMedia
 */
export function deckProblems(md, rendered, { destination = 'file', pageProtocol = '', mediaFound = new Map() } = {}) {
  const deck = parseDeck(md);
  const found = checkDeck(md, { destination, pageProtocol });
  for (const { slide, src, at } of serverMedia(deck)) {
    const status = mediaFound.get(src);
    if (typeof status === 'string') found.push({ slide: slide.index, offset: slide.start + at, severity: 'warning', message: `"${src}" is not on this server (${status}), so the room will see nothing there.` });
  }
  if (rendered?.themeWarning) found.push({ slide: 0, offset: 0, severity: 'warning', message: rendered.themeWarning });
  (rendered?.fits || []).forEach((fit, i) => {
    if (fit < 0.98 && deck.slides[i]) {
      found.push({ slide: i, offset: deck.slides[i].start, severity: 'info', message: `Shrunk to ${Math.round(fit * 100)}% to fit. Consider splitting this slide.` });
    }
  });
  // A diagram Mermaid could not draw (Issue #235), at the line it complains
  // about when it says which.
  (rendered?.diagrams || []).forEach((d) => {
    const slide = deck.slides[d.slide];
    if (!d.error || !slide) return;
    const fence = mermaidFences(slide.raw)[d.nth];
    let offset = slide.start + (fence ? fence.start : 0);
    if (fence && d.error.line > 0) {
      const lines = fence.body.split('\n');
      const n = Math.min(d.error.line, Math.max(1, lines.length - 1)) - 1;
      offset = slide.start + fence.bodyStart + lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
    }
    found.push({ slide: d.slide, offset, severity: 'warning', message: `This diagram could not be drawn: ${d.error.message}` });
  });
  (rendered?.builds || []).forEach((b, i) => {
    const said = describeBuild(b);
    if (said.warn && deck.slides[i]) found.push({ slide: i, offset: deck.slides[i].start, severity: 'warning', message: said.text });
  });
  return found.sort((a, b) => a.offset - b.offset);
}
