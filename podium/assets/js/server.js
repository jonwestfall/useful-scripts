// What kind of server is this?
//
// Podium runs from GitHub Pages, from a folder on disk, and from a box of your
// own, and only the last of those can remember anything. This module is the
// one place that asks which it is, and every server-backed feature hangs off
// the answer: no probe, no extra UI, and the page behaves exactly as it always
// has. See VPS.md.
//
// A static host answers the probe with a 404, which Chromium prints in the
// console. That single line is the whole cost of the arrangement, and it buys
// one set of pages that work everywhere rather than a "server edition".

const OFFLINE = Object.freeze({
  podium: false,
  version: 0,
  features: Object.freeze([]),
  auth: Object.freeze({ mode: 'none', required: false }),
  user: null,
});

let pending = null;

/** The capabilities of whatever served this page. Asked once, then cached. */
export function serverInfo() {
  pending ??= (async () => {
    try {
      const res = await fetch('/api/capabilities', { credentials: 'same-origin' });
      if (!res.ok) return OFFLINE;
      const body = await res.json();
      return body && body.podium ? body : OFFLINE;
    } catch {
      return OFFLINE;                 // offline, or no server at all: same thing
    }
  })();
  return pending;
}

/** Ask again - after signing in or out, when the answer has certainly changed. */
export function forgetServerInfo() {
  pending = null;
}

export async function hasFeature(name) {
  return (await serverInfo()).features.includes(name);
}

export async function signOut() {
  try {
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    });
  } catch { /* the cookie may outlive this, but the page is leaving anyway */ }

  // The offline shell holds the pages this account was allowed to load. The
  // cookie is gone now, but the service worker answers from that cache
  // whenever the network does not - so on a classroom PC with the Wi-Fi down,
  // the next person would be handed the controller a signed-out browser is
  // supposed to be refused. Signing out drops it; the next successful load
  // fills it again.
  try {
    await caches?.delete('podium-shell');
  } catch { /* no Cache API, or nothing cached: nothing to leak either */ }

  forgetServerInfo();
  location.href = '/login.html';
}

/**
 * Fill `el` with who is signed in and a way to stop being signed in. Does
 * nothing at all unless this server has accounts and one of them is us, which
 * is what keeps the bar unchanged on every other way of running Podium.
 */
export async function mountSessionBadge(el) {
  if (!el) return;
  const info = await serverInfo();
  if (info.auth.mode !== 'accounts' || !info.user) return;

  const who = document.createElement('span');
  who.className = 'session-who';
  who.textContent = info.user.displayName || info.user.username;

  const out = document.createElement('button');
  out.type = 'button';
  out.textContent = 'Sign out';
  out.addEventListener('click', signOut);

  el.replaceChildren(who, out);
  el.hidden = false;
}
