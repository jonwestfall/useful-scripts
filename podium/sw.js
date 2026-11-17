// Offline shell for Podium.
//
// The README has always told people to Add to Home Screen; without this that
// was a bookmark with a generic icon that failed the moment the Wi-Fi did.
//
// Network-FIRST, deliberately. Podium already has a build-freshness mechanism
// (see servedBuild in util.js) and a deploy has to take effect immediately, so
// a cache-first worker would be actively harmful: it would serve last week's
// control.js and then tell you, correctly but uselessly, that it was stale.
// Here the cache only ever answers when the network does not, which is exactly
// the case it is for.
//
// Entries are written as they are fetched and overwritten by the next
// successful fetch of the same file. "Clear settings & reload" unregisters
// this worker and drops the cache (see resetDevice in config.js).
//
// Served by Podium's own server, a page asks for its assets under the
// release's address - b/<id>/assets/... (Issue #340, see assetVersion in
// podium-server.js) - which the browser keeps for good, so asking the network
// first costs nothing for them: the browser's own cache answers. They are
// filed here under their plain path, assets/..., so whichever release is in
// the cache is what an offline page gets - one copy of each file, not one per
// release. The page registers this worker with its release (?release=<id>,
// see installOfflineShell), so warming asks for the same addresses the page
// itself just loaded, and a new release is a new worker that warms again.

// A new name (it was podium-shell) so a device drops the 2.8 MB the old,
// longer warm list put there; see activate below.
const CACHE = 'podium-shell-v2';
const RELEASE = (() => {
  try { return new URL(self.location.href).searchParams.get('release') || ''; } catch { return ''; }
})();
const VERSIONED = /\/b\/[A-Za-z0-9_-]{1,32}(?=\/assets\/)/;
/** A request's file under its plain path: b/<id>/assets/x.js -> assets/x.js. */
const plainUrl = (url) => String(url).replace(VERSIONED, '');

// What a page needs to start. Deliberately not content: a lecture's decks,
// photos and video belong to whatever storage that feature already uses, and
// silently holding copies of them here would be both surprising and large.
const SHELL = /\.(?:html|css|js|mjs|webmanifest|json|woff2?)$/;

// Warmed at install, so the FIRST visit is enough to go offline afterwards.
// Without this a service worker only starts catching files on the second load -
// by the time it activates, the page that registered it has already fetched
// everything - and "add it to the home screen, then teach from it" would not
// survive the classroom Wi-Fi on day one.
//
// This list is a hint, not a contract: anything missing simply fails its fetch
// and is skipped, and network-first means a file absent from the cache costs
// nothing until you are offline.
//
// Only the shell (Issue #342): the four pages a lecture starts from and what
// they import as they load - about 0.9 MB gzipped. It used to be everything,
// 2.8 MB on a device's first visit, editor tools included. The rest - Mermaid,
// the deck editor's CodeMirror, mammoth, KaTeX's fonts, pdf.js and the pages
// only an author opens - is cached the first time it is used online, by the
// fetch handler below, and from then on draws offline like the rest.
const WARM = [
  './', 'index.html', 'display.html', 'control.html', 'plan.html', 'config.json',
  'manifest-control.webmanifest', 'manifest-display.webmanifest',
  'assets/css/podium.css', 'assets/vendor/qrcode.js',
  // 1.1 MB (340 KB gzipped), and kept: decks are most of what goes on
  // screen, and a deck that cannot render is the difference between a lecture
  // and no lecture.
  'assets/vendor/marp.esm.js',
  'assets/icons/icon-192.png', 'assets/icons/apple-touch-icon.png',
  // Everything those pages import as they load; test/offline-shell.test.mjs
  // keeps this complete, since one missing fails the whole page offline.
  ...[
    'assets', 'attendance-panel', 'bus', 'caption-log', 'caption-panel', 'config', 'control', 'crypto', 'deck', 'deck-media', 'deck-mermaid', 'deck-qr',
    'deck-source', 'defaults', 'display', 'doc', 'doc-reader', 'duration-probe', 'file-browser', 'gestures', 'index', 'library-upload', 'live-browser',
    'live-browser-panel', 'math-fonts', 'message-editor', 'mic-panel', 'notebook-link', 'pdf-writer', 'pdfjs', 'pip', 'plan', 'planfile', 'poll-link',
    'poll-link-ui', 'poll-look', 'poll-look-theme', 'poll-look-ui', 'presentation-prefs', 'protocol', 'quicklook-open', 'renderers', 'rtc', 'screen-record',
    'server', 'slide-font', 'store', 'tab-bar', 'tabs', 'theme', 'theme-boot', 'thumbs', 'util', 'view-link', 'view-link-ui', 'watermark', 'word-import', 'word-upload',
    'zip', 'zip-review', 'zoom',
  ].map((name) => `assets/js/${name}.js`),
  // The face most slides are laid out in (slide-font.js), 48 KB: without it
  // offline, a slide falls back to each device's own Helvetica or Arial and
  // the iPad and the projector break its lines in different places again.
  ...['400-normal', '400-italic', '700-normal', '700-italic'].map((face) => `assets/vendor/slide-fonts/arimo-latin-${face}.woff2`),
  // Loaded by import() as a page starts - whichever relay it uses.
  ...['index', 'mqtt', 'supabase', 'ws'].map((name) => `assets/js/transport/${name}.js`),
];

// cache.add() would be shorter, and wrong: it stores whatever the fetch ends
// up at, redirects followed. On a server with accounts, an update that happens
// to run while signed out would warm every entry with the login page - filed
// under control.html's key, index.html's key, and so on. Fetching and checking
// before storing is the same guard the fetch handler applies, for the same
// reason.
//
// An asset is asked for under this release's address, the one the page that
// registered this worker just loaded it from - so the browser's cache answers
// and nothing is downloaded twice - and filed under its plain path.
async function warm(cache, path) {
  try {
    const from = RELEASE && path.startsWith('assets/') ? `b/${RELEASE}/${path}` : path;
    const res = await fetch(from, { credentials: 'same-origin' });
    if (res.ok && !res.redirected && res.type === 'basic') await cache.put(path, res);
  } catch { /* offline, or behind a gate: there is simply nothing to warm */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One at a time rather than cache.addAll, which rejects the whole install
    // if any single file 404s - a renamed module would otherwise leave the app
    // with no offline shell at all rather than one file short of a full one.
    await Promise.all(WARM.map((path) => warm(cache, path)));
    await self.skipWaiting();
  })());
});
// Any older cache goes: the previous worker's, or the long warm list's.
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

// Versioned assets already filed by this worker: their bytes cannot change, so
// a page load that finds them in the browser's cache need not write them again.
const filed = new Set();

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  // A Range request is how a browser scrubs a video. Passing one through a
  // Cache is how you end up with a 200 where a 206 was asked for, and a clip
  // that reports a duration of Infinity and refuses to seek.
  if (request.headers.has('range')) return;

  let url;
  try { url = new URL(request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  const wanted = request.mode === 'navigate' || SHELL.test(url.pathname);
  if (!wanted) return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(request);
      // Only a real same-origin answer is worth keeping; an opaque or errored
      // response cached here would be served back as though it were the page.
      //
      // `redirected` is the one that bites on a server with accounts: asking
      // for control.html while signed out follows the redirect and comes back
      // a perfectly valid, perfectly cacheable login page - which would then
      // be stored under CONTROL.HTML's key and served in its place, offline,
      // forever. A redirect is never the thing that was asked for.
      if (fresh && fresh.ok && fresh.type === 'basic' && !fresh.redirected) {
        const versioned = VERSIONED.test(request.url);
        if (!versioned || !filed.has(request.url)) {
          if (versioned) filed.add(request.url);
          const cache = await caches.open(CACHE);
          cache.put(plainUrl(request.url), fresh.clone()).catch(() => { filed.delete(request.url); });
        }
      }
      // A redirected response may not be handed back for a navigation at all:
      // the document would be the login page while the address bar still said
      // control.html, so browsers reject it outright. Re-issuing the redirect
      // ourselves lets the browser do the navigating, and the address bar ends
      // up saying what is actually on screen.
      if (fresh && fresh.redirected && request.mode === 'navigate') {
        return Response.redirect(fresh.url, 302);
      }
      return fresh;
    } catch (err) {
      // A static file's query string never changes what it is - a retry of
      // a failed module import asks under ?retry=… (see importMarp in
      // deck.js) and must still find the copy cached under its plain name.
      // And a versioned asset finds the copy filed under its plain path.
      const hit = await caches.match(plainUrl(request.url), { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
