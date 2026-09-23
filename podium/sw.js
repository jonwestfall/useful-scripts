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
// There is no version to bump, and no precache list to keep in step with the
// file tree: entries are written as they are fetched and overwritten by the
// next successful fetch of the same URL. "Clear settings & reload" unregisters
// this worker and drops the cache (see resetDevice in config.js).

const CACHE = 'podium-shell';

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
// nothing until you are offline. marp.esm.js is 1.1 MB and deliberately
// included - a deck that cannot render is the difference between a lecture and
// no lecture.
const WARM = [
  './', 'index.html', 'display.html', 'control.html', 'plan.html', 'admin.html', 'config.json',
  'manifest-control.webmanifest', 'manifest-display.webmanifest',
  'assets/css/podium.css',
  'assets/vendor/qrcode.js', 'assets/vendor/marp.esm.js', 'assets/vendor/pdf.min.js',
  'assets/icons/icon-192.png', 'assets/icons/apple-touch-icon.png',
  // Kept complete by test/offline-shell.test.mjs: a module control.js or
  // display.js imports that is missing here fails the whole page offline.
  ...[
    'admin', 'assets', 'bus', 'config', 'control', 'crypto', 'deck', 'display',
    'index', 'pdf-writer', 'pip', 'plan', 'planfile', 'protocol', 'renderers',
    'rtc', 'server', 'store', 'util', 'watermark', 'zip', 'zip-review',
  ].map((name) => `assets/js/${name}.js`),
  ...['index', 'mqtt', 'supabase', 'ws'].map((name) => `assets/js/transport/${name}.js`),
];

// cache.add() would be shorter, and wrong: it stores whatever the fetch ends
// up at, redirects followed. On a server with accounts, an update that happens
// to run while signed out would warm every entry with the login page - filed
// under control.html's key, index.html's key, and so on. Fetching and checking
// before storing is the same guard the fetch handler applies, for the same
// reason.
async function warm(cache, path) {
  try {
    const res = await fetch(path, { credentials: 'same-origin' });
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
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone()).catch(() => {});
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
      const hit = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
      if (hit) return hit;
      throw err;
    }
  })());
});
