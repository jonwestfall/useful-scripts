// Where lecture plans live on a device.
//
// IndexedDB rather than localStorage, for one reason: a plan carries its
// photos. localStorage is a ~5 MB string bucket shared with everything else on
// the origin, and it throws when full - which would mean losing a lecture you
// spent an hour building, at save time, with no way to recover it. IndexedDB
// stores structured objects, has a quota measured in a percentage of the disk,
// and is what the tablet needs anyway to keep a loaded plan across a reload.

const DB_NAME = 'podium';
const DB_VERSION = 1;
const PLANS = 'plans';       // the office: every plan you have built
const CURRENT = 'current';   // the tablet: the one plan in use, if any

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis) || !indexedDB) { reject(new Error('This browser has no IndexedDB, so plans cannot be saved here.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PLANS)) db.createObjectStore(PLANS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(CURRENT)) db.createObjectStore(CURRENT);
    };
    req.onsuccess = () => resolve(req.result);
    // Private browsing in Safari, or a blocked origin: report it rather than
    // leaving every save silently pending forever.
    req.onerror = () => reject(req.error || new Error('IndexedDB refused to open.'));
    req.onblocked = () => reject(new Error('Another tab is holding the database open. Close it and reload.'));
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.onabort = () => reject(tx.error || new Error('The database refused the write (out of space?).'));
    if (req) { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }
    else tx.oncomplete = () => resolve();
  }));
}

export const savePlan = (plan) => run(PLANS, 'readwrite', (s) => s.put(plan));
export const loadPlan = (id) => run(PLANS, 'readonly', (s) => s.get(id));
export const removePlan = (id) => run(PLANS, 'readwrite', (s) => s.delete(id));
export const allPlans = () => run(PLANS, 'readonly', (s) => s.getAll()).then((rows) => (rows || []).sort((a, b) => (b.updated || 0) - (a.updated || 0)));

// The tablet's copy of the plan it is teaching from. One slot: loading a plan
// replaces whatever was there, which is what "open tonight's lecture" means.
export const saveCurrentPlan = (plan) => run(CURRENT, 'readwrite', (s) => s.put(plan, 'plan'));
export const loadCurrentPlan = () => run(CURRENT, 'readonly', (s) => s.get('plan'));
export const clearCurrentPlan = () => run(CURRENT, 'readwrite', (s) => s.delete('plan'));

// --- files in and out --------------------------------------------------------

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}.`));
    reader.readAsText(file);
  });
}

export function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

/**
 * Re-encode a photo small enough to survive one hop over the relay.
 *
 * A phone photo is 3-6 MB and every relay in Podium caps a message well below
 * that (the self-hosted one at 256 KB, and the envelope is the JSON encrypted
 * and then base64'd, so it arrives about a third larger than it went in). The
 * projector is 1920x1080: a 12-megapixel original has nothing to offer it. So
 * walk down a ladder of sizes and qualities and take the first that fits, which
 * keeps the best version that can actually be delivered rather than either
 * refusing the photo or picking one fixed quality that is wrong for most
 * pictures. The downscaled copy is what gets stored in the plan too - what you
 * approve in the office is then exactly what the class sees.
 */
export async function downscaleImage(file, maxChars, options = {}) {
  return encodeToFit(await loadBitmap(file), maxChars, options);
}

/**
 * The ladder itself, for anything already drawable: a decoded photo, or a
 * canvas the display has just painted a panel into.
 */
export function encodeToFit(source, maxChars, { widths = [1920, 1600, 1280, 1024, 800], qualities = [0.85, 0.75, 0.62, 0.5], mime = 'image/jpeg' } = {}) {
  const long = Math.max(source.width, source.height);
  let smallest = null;
  for (const width of widths) {
    // Never upscale: a 900px screenshot re-encoded at 1920 is bigger on the
    // wire and no better on the wall.
    const scale = Math.min(1, width / long);
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    for (const quality of qualities) {
      // Throws (rather than returning something unusable) when the source
      // canvas is tainted - a photo or video from another site, drawn in by a
      // renderer - which is a real failure the caller has to be able to report.
      // PNG (a logo watermark, so a transparent background survives rather
      // than flattening to black) ignores the quality argument entirely, so a
      // caller asking for one passes a single-entry `qualities` to avoid
      // re-encoding the same bytes for nothing.
      const url = canvas.toDataURL(mime, quality);
      if (!smallest || url.length < smallest.url.length) smallest = { url, w, h, quality };
      if (url.length <= maxChars) return { dataUrl: url, width: w, height: h, quality, bytes: url.length };
    }
  }
  // Every rung was too big. Hand back the smallest and let the caller say so,
  // rather than throwing away a photo the presenter may still want to try.
  return { dataUrl: smallest.url, width: smallest.w, height: smallest.h, quality: smallest.quality, bytes: smallest.url.length, tooBig: true };
}

async function loadBitmap(file) {
  if ('createImageBitmap' in globalThis) {
    try { return await createImageBitmap(file); } catch { /* fall back to <img>, e.g. an SVG Safari will not decode this way */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`${file.name} is not an image this browser can read.`));
      img.src = url;
    });
  } finally {
    // Revoked after decode: the bitmap/ImageElement keeps its own copy.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function downloadText(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
