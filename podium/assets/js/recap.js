// The lecture recap (Issue #158): one document per session, assembled from
// what the lecture already recorded - the timeline of what was on screen, the
// captions said over it, the polls it ran and the pictures it kept - rather
// than anything new collected for the purpose.
//
// This file only decides the ORDER and the grouping; it touches no DOM and no
// network, so it can be tested on its own. admin.js turns the result into
// pages with pdf-writer.js, the same machinery the session PDF already uses.
//
// The shape, in time order:
//
//   entry  something that went on the projector (a slide, a board, a message),
//          with the caption lines said while it was up and any annotated slide
//          the session kept that matches it
//   poll   a poll's final result, at the point it closed
//
// followed by `extras`: kept pictures (photos, boards, annotated slides that
// match no timeline entry) that have no moment of their own to sit beside.
// A session with no captions is still a recap - captions only ever add lines.

/** The small print after an entry's name: which slide, which page, which panels. */
export function describeEvent(event) {
  const bits = [];
  if (event.detail?.slide) bits.push(`slide ${event.detail.slide}`);
  if (event.detail?.page) bits.push(`page ${event.detail.page}`);
  if (event.detail?.type && !bits.length && event.detail.type !== 'black') bits.push(event.detail.type);
  // A split layout's other panels, recorded alongside panel A rather than as
  // events of their own - see noteSurface in display.js.
  if (event.detail?.panels?.length) {
    const labels = ['B', 'C', 'D'];
    bits.push(event.detail.panels.map((p, i) => `${labels[i] || '?'}: ${p.title || p.type || '—'}`).join(', '));
  }
  return bits.join(' · ');
}

/** The full text of a caption event - detail.text, since `title` is cut at 200. */
export const captionText = (event) =>
  String((typeof event.detail?.text === 'string' && event.detail.text) || event.title || '').trim();

// The same folder name the controller's export gives a deck's annotated
// slides (safeName in control.js), so a kept `slides/<deck>/slide-07.png`
// can be matched back to the timeline entry that showed slide 7 of that deck.
export const folderName = (text) => String(text || '')
  .replace(/[^a-z0-9-_ ]+/gi, '')
  .trim()
  .replace(/\s+/g, '-')
  .slice(0, 48)
  .toLowerCase() || 'deck';

const SLIDE_FILE_RE = /^slides\/([^/]+)\/slide-(\d+)\.png$/i;

const isPicture = (file) => /^(photos|slides|boards)\//.test(file.name);

/**
 * @param {object} detail - a lecture as GET /api/lectures/:id returns it
 * @returns {{ blocks: Array<object>, extras: Array<object>, captionCount: number }}
 */
export function buildRecap(detail) {
  const timeline = [...(detail.timeline || [])].sort((a, b) => a.at - b.at);
  const blocks = [];

  for (const event of timeline) {
    if (event.kind === 'caption') continue;
    blocks.push({
      type: 'entry', at: event.at, kind: event.kind,
      title: event.title || '—', note: describeEvent(event),
      slide: event.detail?.slide || null,
      captions: [], images: [],
    });
  }
  for (const poll of detail.pollResults || []) {
    blocks.push({ type: 'poll', at: poll.endedAt ?? poll.startedAt ?? 0, poll, captions: [] });
  }
  // Stable for equal times: an entry and the poll that closed in the same
  // millisecond keep entry-first, the order they were pushed in.
  blocks.sort((a, b) => a.at - b.at);

  // Each caption line goes with whatever was the latest thing in the recap
  // when it was said. Lines said before anything went on screen get a block
  // of their own at the top rather than being dropped.
  let captionCount = 0;
  for (const event of timeline) {
    if (event.kind !== 'caption') continue;
    const text = captionText(event);
    if (!text) continue;
    captionCount += 1;
    let owner = null;
    for (const block of blocks) {
      if (block.at > event.at) break;
      owner = block;
    }
    if (!owner) {
      owner = blocks[0]?.type === 'opening' ? blocks[0] : null;
      if (!owner) {
        owner = { type: 'opening', at: event.at, title: 'Before anything went on screen', note: '', captions: [], images: [] };
        blocks.unshift(owner);
      }
    }
    owner.captions.push({ at: event.at, text });
  }

  // Annotated slides go beside the first time that slide of that deck was on
  // screen. Everything else - photos, boards, and a slide the timeline never
  // recorded (a lecture that hit its event cap, say) - is kept at the end.
  const extras = [];
  const entries = blocks.filter((b) => b.type === 'entry');
  for (const file of (detail.files || []).filter(isPicture).sort((a, b) => a.name.localeCompare(b.name))) {
    const match = file.name.match(SLIDE_FILE_RE);
    if (match) {
      const [, folder, number] = match;
      const slide = Number(number);
      const home = entries.find((e) => e.slide === slide && folderName(e.title) === folder.toLowerCase());
      if (home) { home.images.push(file); continue; }
    }
    extras.push(file);
  }

  return { blocks, extras, captionCount };
}
