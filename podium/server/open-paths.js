// Which files the gate (gate() in api.js) lets through without a signed-in
// account, and to whom. See podium-server.js for why there is a gate at all,
// and why join.html, guest.html and login.html are its exceptions.

'use strict';

// Open to everyone, accounts or not.
//
// join.html (a student answering a poll), attend.html (a student checking
// in, Issue #256) and login.html need no account by their nature. guest.html
// (Issue #77) is a real controller for a substitute handed a guest link, so
// it needs most of what control.html needs to run.
const AUTH_OPEN_PATHS = new Set([
  '/join.html', '/assets/js/join.js', '/login.html', '/favicon.ico',
  // A student checking in (Issue #256) has no account either; the page is
  // self-contained, and its /attend routes answer nothing without a code.
  '/attend.html',
  '/guest.html', '/assets/js/guest.js', '/assets/js/bus.js', '/assets/js/config.js',
  '/assets/js/crypto.js', '/assets/js/transport/index.js', '/assets/js/transport/ws.js',
  '/assets/js/transport/mqtt.js', '/assets/js/transport/supabase.js',
  // index.html is the showcase page (see below) - these are the static
  // files it loads to render, none of which carry anything a stranger
  // could not already read in the public repo. Opening them exposes no
  // page: gate() still checks each request's own path, so control.html,
  // display.html, plan.html and admin.html are untouched by this.
  '/assets/css/podium.css', '/assets/js/server.js', '/assets/js/protocol.js', '/assets/js/zoom.js', '/assets/js/poll-look.js',
  '/assets/js/util.js', '/assets/js/notebook-link.js', '/assets/js/index.js', '/assets/icons/apple-touch-icon.png',
  // Light or dark (theme.js): the landing page, the guide and a guest's
  // controller all start with it, and it is no more than a colour choice.
  '/assets/js/theme.js', '/assets/js/theme-boot.js',
]);

// index.html itself, reachable without signing in even where accounts are
// configured - it is the showcase, meant to sell Podium to someone who has
// not signed in yet and hand them a Sign in link, not a wall. This is
// narrower than AUTH_OPEN_PATHS above on purpose: it excuses the splash
// from the *accounts* check only (see gate() in api.js). A self-hosted
// instance using the simpler AUTH_PASSWORD gate instead of accounts chose
// that specifically to keep the whole thing off the public internet, splash
// included, and still gets challenged for these paths like every other.
// guide.html is the same kind of page: a self-contained tour of what Podium
// is, linked from the showcase, loading nothing but the light/dark choice
// (theme.js, open above).
const AUTH_PUBLIC_WITH_ACCOUNTS = new Set(['/', '/index.html', '/guide.html']);

// What display.js loads to run, whichever page starts it: display.html on a
// kiosk, view.html for a Guest View viewer. One list, so a renderer module
// display.js starts importing is open to both at once.
// test/kiosk-open-paths.test.mjs checks it against what the pages really load.
const DISPLAY_RUNTIME = [
  '/assets/vendor/marp.esm.js', '/assets/vendor/mermaid.esm.js', '/assets/vendor/pdf.min.js', '/assets/vendor/pdf.worker.min.js',
  '/assets/vendor/qrcode.js', '/assets/icons/icon-192.png',
  '/assets/js/display.js', '/assets/js/assets.js', '/assets/js/caption-log.js', '/assets/js/screen-record.js', '/assets/js/deck.js', '/assets/js/deck-mermaid.js', '/assets/js/deck-qr.js', '/assets/js/deck-source.js', '/assets/js/doc.js', '/assets/js/doc-reader.js', '/assets/js/duration-probe.js',
  '/assets/js/planfile.js', '/assets/js/renderers.js', '/assets/js/live-browser.js', '/assets/js/rtc.js', '/assets/js/store.js', '/assets/js/theme.js',
  '/assets/js/zoom.js', '/assets/js/poll-link.js', '/assets/js/poll-look.js', '/assets/js/view-link.js',
];

// What a provisioned kiosk (Issue #151) is let onto with its own cookie
// instead of a signed-in user: display.html and what it runs. Deliberately
// NOT control.html, plan.html or admin.html: a kiosk cookie is scoped to the
// one page a device nobody is watching has any business reaching.
const KIOSK_OPEN_PATHS = new Set(['/display.html', '/config.json', '/manifest-display.webmanifest', ...DISPLAY_RUNTIME]);

// What view.html (Guest View, Issue #150) needs, open to everyone the same
// way guest.html's files are: a viewer has no account and is not meant to
// have one. Never display.html itself, and never config.json: a viewer's
// whole configuration arrives in its link, and the deployment's default
// config is none of a stranger's business.
const VIEW_OPEN_PATHS = new Set(['/view.html', ...DISPLAY_RUNTIME]);
for (const openPath of VIEW_OPEN_PATHS) AUTH_OPEN_PATHS.add(openPath);

module.exports = { AUTH_OPEN_PATHS, AUTH_PUBLIC_WITH_ACCOUNTS, KIOSK_OPEN_PATHS, VIEW_OPEN_PATHS };
