// The asset:<id> <-> real-bytes indirection every item's src goes through at
// render time - shared by control.js and display.js (Issue #124), after
// their two copies had already drifted: one backed onto a Map+Map, the other
// a Map+Set, and only one of the two throttled repeated asks.
//
// Only the local RENDERERS ever resolve it, and only at the point of handing
// an item to one - never on the way into `state`, which is rebroadcast
// continuously and is what ink surfaces are keyed by. Resolving any earlier
// would make every device's keys disagree.

import { assetIdOf } from './planfile.js';

// A 1x1 transparent GIF, for the moment between wanting a photo and holding
// its bytes. Without it an unresolved `asset:<id>` reaches an <img> as a URL
// with a scheme no browser knows, which is a broken image and a console
// error rather than a blank.
export const BLANK_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const ASK_INTERVAL_MS = 3000;

/**
 * @param {() => ({ send: Function } | null)} getBus - a getter, not the bus
 *   itself: both callers reassign their own `bus` variable once the
 *   connection comes up, so this needs whatever it currently holds on every
 *   call, not whatever it held at setup time.
 */
export function createAssetResolver(getBus) {
  const store = new Map();
  // id -> when this device last asked for it. resolveAssets() runs on every
  // render, so without a note of that it would ask again on every one of
  // them for as long as the answer took; with one it asks, waits, and asks
  // again only if nothing answered in time.
  const wanted = new Map();

  function want(id) {
    const now = Date.now();
    if (now - (wanted.get(id) || 0) < ASK_INTERVAL_MS) return;
    wanted.set(id, now);
    getBus()?.send({ t: 'asset-need', id });
  }

  function resolveAssets(item) {
    if (!item) return item;
    const id = assetIdOf(item.src);
    if (id === null) return item;
    if (store.has(id)) return { ...item, src: store.get(id) };
    // This device does not have the bytes: it reloaded mid-lecture, or the
    // photo was taken elsewhere before this device joined. Ask, and show
    // nothing rather than a broken image until it answers.
    want(id);
    return { ...item, src: BLANK_PIXEL };
  }

  return { store, wanted, want, resolveAssets };
}
