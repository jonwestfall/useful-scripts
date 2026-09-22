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

// The returned function also carries .flush(): run a still-pending trailing
// call right now instead of waiting out its window. Needed wherever a caller
// clears state a pending call depends on reading (Issue #119's eraser throttle
// reads ink.lastErasePoint, which a stroke ending resets) - without it, that
// state would already be gone by the time the deferred call finally ran.
export function throttle(fn, ms) {
  let last = 0, pending = null, timer = null;
  const wrapped = (...args) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); return; }
    pending = args;
    timer ??= setTimeout(() => {
      timer = null; last = Date.now();
      if (pending) { fn(...pending); pending = null; }
    }, ms - (now - last));
  };
  wrapped.flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (pending) { last = Date.now(); fn(...pending); pending = null; }
  };
  return wrapped;
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// `#`/`##` headings and `1.` numbered lists, alongside the bullet lists this
// already had - the three block-level constructs Issue #103's full-screen
// message editor needs ("headings and body text, bulleted lists, numbered
// lists"), on the same line-by-line pass bullets already used rather than a
// second one. A line only ever starts one kind of block; switching from a
// bullet line straight to a numbered one (or either to a heading) closes
// whatever was open first, the same way a plain line always did.
export function miniMarkdown(str) {
  let html = escapeHtml(str);

  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

  const lines = html.split('\n');
  let listTag = null; // 'ul' | 'ol' | null - which list (if any) is open
  const out = [];

  const closeList = () => {
    if (listTag) { out.push(`</${listTag}>`); listTag = null; }
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,2})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${heading[2]}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (listTag !== 'ul') { closeList(); out.push('<ul class="mini-md-list">'); listTag = 'ul'; }
      out.push(`<li>${bullet[1]}</li>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      if (listTag !== 'ol') { closeList(); out.push('<ol class="mini-md-list">'); listTag = 'ol'; }
      out.push(`<li>${numbered[1]}</li>`);
      continue;
    }
    closeList();
    out.push(line);
  }
  closeList();

  const isBlockTag = (l) => /^<(?:ul|\/ul|ol|\/ol|li|h1|h2|\/h1|\/h2)/.test(l);
  let finalHtml = '';
  for (let i = 0; i < out.length; i++) {
    const l = out[i];
    finalHtml += l;
    if (!isBlockTag(l) && i < out.length - 1 && !isBlockTag(out[i + 1])) {
      finalHtml += '<br>';
    }
  }
  return finalHtml;
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

/**
 * Press and hold, as a second meaning for a button that already does
 * something when tapped.
 *
 * The hold has to be visible while it is happening - a control that only
 * responds after you have held it long enough, with no sign that anything is
 * underway, feels broken rather than deliberate - so the element is marked
 * `is-holding` for the duration and told how long that is (`--hold-ms`),
 * which the stylesheet turns into a sweep across the button.
 *
 * The click that a tap-and-release would normally produce is swallowed when
 * the hold fires, so holding the "four panels" button photographs the screen
 * instead of also rearranging it.
 */
// Which element's next click a completed hold has already spent, and the one
// listener that swallows it.
//
// It has to be on WINDOW, in the capture phase. A capture listener on the
// element itself does not help: when that element is the event's own target -
// which a button with nothing but text inside it always is - the DOM runs its
// listeners in the order they were added and ignores the capture flag
// entirely, so the button's own click handler (added first, by el()) would run
// before it. Holding "B" would photograph panel B and move the room's focus to
// it. On window the capture phase genuinely comes first, for every target.
let spentClick = null;
let swallowerInstalled = false;

function installClickSwallower() {
  if (swallowerInstalled) return;
  swallowerInstalled = true;
  window.addEventListener('click', (ev) => {
    const node = spentClick;
    if (!node) return;
    spentClick = null;
    if (node !== ev.target && !node.contains(ev.target)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
}

export function onLongPress(node, ms, onHold) {
  let timer = null;

  const stop = () => {
    clearTimeout(timer);
    timer = null;
    node.classList.remove('is-holding');
  };

  installClickSwallower();
  node.style.setProperty('--hold-ms', `${ms}ms`);
  node.addEventListener('pointerdown', (ev) => {
    if (ev.button > 0) return;         // a right-click is not a hold
    timer = setTimeout(() => { spentClick = node; stop(); onHold(); }, ms);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) node.addEventListener(type, stop);
  // Without this, holding a button on an iPad raises the system callout menu
  // over the top of the thing you are trying to do.
  node.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

// --- fullscreen -------------------------------------------------------------
//
// Safari needs both halves of this, and got neither for a while.
//
// The prefix: Safari only learned the standard `requestFullscreen` in 16.4.
// Before that - including on Macs that cannot run a newer Safari - the whole
// API is `webkit`-prefixed, and an unprefixed call simply is not there.
//
// The timing: a fullscreen request is only granted while the click that asked
// for it is still the browser's "current user gesture". Chrome is forgiving
// about awaiting something first; Safari is not, and drops the request on the
// floor without an error. So these are written to be CALLED synchronously from
// inside the handler - the returned promise is for reporting, not sequencing.

export function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

export function enterFullscreen(target = document.documentElement) {
  try {
    if (target.requestFullscreen) return target.requestFullscreen({ navigationUI: 'hide' }) || Promise.resolve();
    if (target.webkitRequestFullscreen) { target.webkitRequestFullscreen(); return Promise.resolve(); }
  } catch (err) {
    return Promise.reject(err);
  }
  return Promise.reject(new Error('This browser will not put the page fullscreen.'));
}

export function exitFullscreen() {
  try {
    if (!isFullscreen()) return Promise.resolve();
    if (document.exitFullscreen) return document.exitFullscreen() || Promise.resolve();
    if (document.webkitExitFullscreen) { document.webkitExitFullscreen(); return Promise.resolve(); }
  } catch (err) {
    return Promise.reject(err);
  }
  return Promise.resolve();
}

export function toggleFullscreen(target = document.documentElement) {
  return isFullscreen() ? exitFullscreen() : enterFullscreen(target);
}

/** Both spellings of the event, since Safari before 16.4 only fires its own. */
export function onFullscreenChange(fn) {
  document.addEventListener('fullscreenchange', fn);
  document.addEventListener('webkitfullscreenchange', fn);
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
