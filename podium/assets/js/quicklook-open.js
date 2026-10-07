// Opening something in Quick Look (Issue #242): quicklook.html, in a new tab,
// with no connection to the room.
//
// A library file opens by its id (?library=) and the tab fetches it with the
// presenter's own session. Anything else - a deck or picture kept inside a
// lecture plan, the deck editor's unsaved text - is handed over on this
// device: the tab opens with a one-use token in its address and asks for it
// on a BroadcastChannel, and this page answers. Nothing goes through the
// relay or the server, so it works offline, with no server at all.
//
// A handover can be kept open (the deck editor's rehearsal tab): update()
// sends a new version and the tab redraws it where it was.

const CHANNEL = 'podium-quicklook';
const KEEP_MS = 60_000;   // how long an unasked-for handover waits for its tab

/** Item types Quick Look can show. */
export const QUICK_LOOK_TYPES = new Set(['deck', 'document', 'imagedeck', 'image', 'pdf', 'video', 'audio', 'web', 'slides', 'youtube', 'text', 'set']);

export function canQuickLook(item) {
  if (!item || !QUICK_LOOK_TYPES.has(item.type)) return false;
  if (item.type === 'set') return Array.isArray(item.entries) && item.entries.some((e) => canQuickLook(e?.item || e));
  return true;
}

function token() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

let channel = null;
const handovers = new Map();   // token -> {pkg: Promise, live, timer}

function listen() {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.addEventListener('message', async (ev) => {
    const want = ev.data?.want;
    const held = want && handovers.get(want);
    if (!held || held.answering) return;
    held.answering = true;
    let pkg;
    try { pkg = await held.pkg; } catch (err) { pkg = { error: err.message || String(err) }; }
    channel.postMessage({ token: want, pkg });
    // One use, unless the opener keeps it going (see update).
    if (!held.live) forget(want);
    else held.answering = false;
  });
  return channel;
}

function forget(id) {
  const held = handovers.get(id);
  if (held) clearTimeout(held.timer);
  handovers.delete(id);
}

/**
 * Open an item in Quick Look. Call it straight from the click: a browser lets
 * a page open a tab only while it is answering one, so the tab opens at once
 * and `pkg` - which may be a promise, for something that takes a moment to
 * gather - follows it.
 *
 * @param {object|Promise<object>} pkg
 * @param {object} pkg.item - the item, as the room would get it, with any
 *   `asset:` addresses already swapped for their bytes
 * @param {string} [pkg.source] - a deck's markdown, when this page has it
 * @param {string} [pkg.from] - where it was opened from, said in the tab
 * @param {string} [pkg.destination] - for a deck: where it is saved, for its checks
 * @param {number|string} [pkg.libraryId] - a library file's id: the tab fetches it itself
 * @param {object} [opts]
 * @param {boolean} [opts.live] - keep the handover open for update()
 * @returns {{update(pkg: object): void, close(): void}}
 */
export function openQuickLook(pkg, { live = false } = {}) {
  const libraryId = !live && !(pkg instanceof Promise) && !pkg.source && pkg.libraryId;
  if (libraryId) {
    window.open(`quicklook.html?library=${encodeURIComponent(libraryId)}`, '_blank', 'noopener');
    return { update() {}, close() {} };
  }
  const id = token();
  if (!listen()) {
    // No BroadcastChannel (a very old browser): an address is all there is.
    const src = !(pkg instanceof Promise) && pkg.item?.src;
    if (src && !String(src).startsWith('data:')) {
      window.open(`quicklook.html?src=${encodeURIComponent(src)}&type=${encodeURIComponent(pkg.item.type)}`, '_blank', 'noopener');
    }
    return { update() {}, close() {} };
  }
  const ready = Promise.resolve(pkg);
  // Whatever goes wrong gathering it is the tab's to say (see listen), not an
  // unhandled rejection here in the meantime.
  ready.catch(() => {});
  handovers.set(id, { pkg: ready, live, timer: live ? null : setTimeout(() => forget(id), KEEP_MS) });
  window.open(`quicklook.html#handoff=${id}`, '_blank', 'noopener');
  return {
    update(next) {
      const held = handovers.get(id);
      if (!held) return;
      held.pkg = Promise.resolve(next);
      channel.postMessage({ token: id, pkg: next, update: true });
    },
    close() { forget(id); },
  };
}
