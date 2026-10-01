// Library tile thumbnails (Issue #192): a deck's first slide, a PDF's first
// page, the picture itself, a frame of the video - so a presenter finds the
// thing by sight, not by reading a title in front of a class.
//
// Made lazily and one at a time: a tile asks for its thumbnail only once it
// is scrolled near the screen, and rendering a deck or a PDF page is real
// work, so two never run at once and a long Library never stalls the tab.
// Each is made once per page load and kept in memory - renderLibrary rebuilds
// every tile on every filter keystroke, and a rebuilt tile picks its picture
// straight back up. Anything that cannot be made (a cross-origin video, a
// deck whose theme will not load) just keeps its icon; it is not asked again.
//
// How a thumbnail is made is the caller's business (`make`, from control.js,
// which has the deck and PDF machinery); this only decides when, and where it
// goes.

const keyOf = (item) => {
  const ref = item?.src || item?.deckId || item?.images?.[0]?.src;
  return ref ? `${item.type}:${ref}` : null;
};

/**
 * @param {(item: object) => Promise<string|null>} make - an image URL for the item, or null
 */
export function createThumbnailer(make) {
  const done = new Map();       // key -> url, or null for "could not"
  const slots = new Map();      // key -> Set of tile thumbnail elements waiting for it
  const queue = [];             // { key, item } not yet made, in the order they were seen
  const queued = new Set();
  let busy = false;

  const paint = (slot, url) => {
    slot.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
    slot.classList.add('has-thumb');
  };

  // Each one waits for the browser to be idle, so a picture is never made at
  // the expense of a tap the presenter is waiting on.
  const idle = () => new Promise((resolve) => (typeof requestIdleCallback === 'function'
    ? requestIdleCallback(() => resolve(), { timeout: 2000 })
    : setTimeout(resolve, 50)));

  async function next() {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    await idle();
    let url;
    try { url = await make(job.item); } catch { url = null; }
    done.set(job.key, url);
    queued.delete(job.key);
    for (const slot of slots.get(job.key) || []) if (url && slot.isConnected) paint(slot, url);
    slots.delete(job.key);
    busy = false;
    next();
  }

  function want(slot, key, item) {
    if (!slots.has(key)) slots.set(key, new Set());
    slots.get(key).add(slot);
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ key, item });
    next();
  }

  const watching = new WeakMap();   // slot -> { key, item }
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const job = watching.get(entry.target);
        if (job) want(entry.target, job.key, job.item);
      }
    }, { rootMargin: '300px' })
    : null;

  /** Give a tile's thumbnail element its picture, now or once it is near the screen. */
  function attach(slot, item) {
    const key = keyOf(item);
    if (!key) return;
    if (done.has(key)) { const url = done.get(key); if (url) paint(slot, url); return; }
    if (observer) { watching.set(slot, { key, item }); observer.observe(slot); } else want(slot, key, item);
  }

  return { attach };
}
