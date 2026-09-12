// Small DOM + misc helpers shared by the display and controller.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export function uid(n = 8) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, n);
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return (h ? `${h}:` : '') + `${mm}:${String(s).padStart(2, '0')}`;
}

export function throttle(fn, ms) {
  let last = 0, pending = null, timer = null;
  return (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); return; }
    pending = args;
    timer ??= setTimeout(() => {
      timer = null; last = Date.now();
      if (pending) { fn(...pending); pending = null; }
    }, ms - (now - last));
  };
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Very small inline-markdown subset for the "big text" card: **bold**, *italic*, `code`.
export function miniMarkdown(str) {
  return escapeHtml(str)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

// Guess a content item from a pasted URL so the controller's "paste a link" box
// does something sensible without the user picking a type first.
export function guessItemFromUrl(raw) {
  const url = raw.trim();
  if (!url) return null;
  const lower = url.split('?')[0].toLowerCase();
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|live\/|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) {
    const t = url.match(/[?&#]t=(\d+)/);
    return { type: 'youtube', videoId: yt[1], startAt: t ? Number(t[1]) : 0, title: 'YouTube' };
  }
  if (/\.(png|jpe?g|gif|webp|avif|svg|bmp)$/.test(lower)) return { type: 'image', src: url, fit: 'contain', title: 'Image' };
  if (/\.(mp4|webm|ogv|mov|m4v)$/.test(lower)) return { type: 'video', src: url, title: 'Video' };
  if (/\.(mp3|m4a|aac|wav|ogg|flac|opus)$/.test(lower)) return { type: 'audio', src: url, title: 'Audio' };
  if (/\.pdf$/.test(lower)) return { type: 'pdf', src: url, page: 1, title: 'PDF' };
  return { type: 'web', src: url, title: url.replace(/^https?:\/\//, '').slice(0, 40) };
}

/**
 * Turn a button into a two-step destructive action. A plain confirm() dialog is
 * awkward on a fullscreen kiosk display and on an iPad home-screen app, and a
 * single tap is too easy to hit by accident five minutes before class.
 */
export function wireDangerButton(button, label, action, { armedLabel = 'Tap again to erase', window: ms = 5000 } = {}) {
  let armed = false;
  let timer = null;

  const disarm = () => {
    armed = false;
    clearTimeout(timer);
    button.textContent = label;
    button.classList.remove('is-danger');
  };

  button.textContent = label;
  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = armedLabel;
      button.classList.add('is-danger');
      timer = setTimeout(disarm, ms);
      return;
    }
    clearTimeout(timer);
    button.disabled = true;
    button.textContent = 'Clearing…';
    try {
      await action();
    } catch {
      button.disabled = false;
      disarm();
    }
  });

  return { disarm };
}

// What build the server is handing out RIGHT NOW, or null if it cannot be
// read. Each page compares this against the BUILD compiled into the copy it
// is actually running: they differ exactly when the browser served this tab
// something out of a cache the deploy has since replaced. Fetched with
// no-store so the check itself cannot be answered from that same cache, and
// pointed at protocol.js because that is where BUILD lives - one source of
// truth, no second file to drift out of step with it.
export async function servedBuild() {
  try {
    const res = await fetch('assets/js/protocol.js', { cache: 'no-store' });
    if (!res.ok) return null;
    const match = (await res.text()).match(/BUILD\s*=\s*(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    // Offline, or blocked: there is nothing to compare against, which is not
    // the same as being up to date. Say nothing rather than guess.
    return null;
  }
}

/**
 * A rolling record of what the relay did, rendered into every `.relay-log` on
 * the page.
 *
 * "Lost the relay - retrying" on its own is unactionable: it names no URL, no
 * close code and no attempt count, and it overwrites the first attempt - which
 * is the informative one - with the twentieth. Both pages need this, and a
 * diagnostic that exists twice is a diagnostic that rots in one of the copies.
 */
export function createRelayLog(limit = 8) {
  const entries = [];

  const render = () => {
    const text = entries
      .map((e) => `${e.at} · ${e.status}${e.detail ? ` — ${e.detail}` : ''}${e.n > 1 ? ` (×${e.n})` : ''}`)
      .join('\n');
    $$('.relay-log').forEach((box) => { box.textContent = text; box.hidden = !text; });
  };

  return {
    entries,
    render,
    push(status, detail = '') {
      const at = new Date().toLocaleTimeString();
      const last = entries[entries.length - 1];
      // A retry loop repeats the same line forever; collapse it into a count so
      // the first attempt, and anything that happened before it, stays visible.
      if (last && last.status === status && last.detail === detail) {
        last.n++;
        last.at = at;
      } else {
        entries.push({ at, status, detail, n: 1 });
        if (entries.length > limit) entries.shift();
      }
      render();
    },
  };
}

/**
 * Install the offline shell (sw.js), so the controller opens from the home
 * screen like an app and survives the Wi-Fi dropping out.
 *
 * `updateViaCache: 'none'` matters: without it the browser may serve sw.js
 * itself from the HTTP cache for up to a day, which is how a service worker
 * becomes the thing you cannot deploy past.
 *
 * Fails quietly and by design - a secure context is required, and the whole
 * app works without it.
 */
export function installOfflineShell() {
  if (!('serviceWorker' in navigator)) return;
  const go = () => navigator.serviceWorker
    .register('sw.js', { scope: './', updateViaCache: 'none' })
    .catch(() => { /* plain http, private mode, or blocked by policy */ });
  // Not simply window.addEventListener('load', ...): both pages that call this
  // use top-level await, so their module can finish evaluating AFTER load has
  // already fired, and a listener added then never runs at all.
  if (document.readyState === 'complete') go();
  else window.addEventListener('load', go, { once: true });
}
