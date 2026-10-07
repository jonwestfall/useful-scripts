// Quick Look (Issue #242): one file, privately, in its own tab.
//
// Drawn with the display's own renderers, so a deck here is the deck the room
// would see - but with its own navigation, and with NO connection to the room:
// this page never imports the transport, never joins a room and never sends a
// command. Nothing done here can reach the display, and nothing on the display
// moves this tab. (test/e2e/editor.mjs checks that no socket is ever opened.)
//
// What to show arrives one of three ways (see quicklook-open.js):
//   ?library=<id>      a library file, fetched with this browser's session
//   ?src=<path>&type=  a file by its address on this server
//   #handoff=<token>   handed over on this device by the page that opened us:
//                      a deck kept in a lecture plan, the deck editor's
//                      unsaved text. A reload uses the copy kept in this tab.

import { $, el, fmtTime } from './util.js';
import { createRenderer, TYPES } from './renderers.js';
import { render as renderDeckSource, deckId, forgetDeck, applyFits, applyPolyfill, deckLocation } from './deck.js';
import { deckStep } from './protocol.js';
import { deckProblems, checkServerMedia } from './deck-checks.js';
import { parseDeck } from './deck-source.js';

const CHANNEL = 'podium-quicklook';
const KEPT = 'podium.quicklook.';      // + token: the handover, kept for a reload of this tab
const ASK_MS = 8000;   // how long to wait for the page that opened this tab

const stage = $('#ql-stage');
let view = null;                        // what is showing: {next, prev, first, last, key, destroy, ...}

function warn(text) {
  $('#ql-warn').textContent = text || '';
  $('#ql-warn').hidden = !text;
}

function setWhere(text) { $('#ql-where').textContent = text || ''; }

function setTitle(title, from = '') {
  $('#ql-title').textContent = title || 'Quick Look';
  $('#ql-from').textContent = from;
  document.title = `Quick Look · ${title || 'Podium'}`;
}

function showControls(names) {
  for (const id of ['ql-prev', 'ql-next', 'ql-play', 'ql-mute', 'ql-grid-toggle', 'ql-notes-toggle', 'ql-checks-toggle']) {
    $(`#${id}`).hidden = !names.includes(id);
  }
}

function clearStage() {
  view?.destroy?.();
  view = null;
  stage.replaceChildren();
  stage.classList.remove('is-zoomed');
  $('#ql-notes').hidden = true;
  $('#ql-grid').hidden = true;
  $('#ql-checks').hidden = true;
  setWhere('');
  showControls([]);
}

const message = (text) => stage.replaceChildren(el('p', { class: 'ql-empty' }, text));

// --- a deck -------------------------------------------------------------------

let notesOpen = true;
const mediaFound = new Map();

async function showDeck(pkg, { keep = null } = {}) {
  let source = pkg.source;
  if (source == null) {
    const res = await fetch(pkg.item.src, { cache: 'no-cache', credentials: 'same-origin' });
    if (!res.ok) throw new Error(`${pkg.item.src}: HTTP ${res.status}`);
    source = await res.text();
  }
  const id = `quicklook:${await deckId(source)}`;
  const rendered = await renderDeckSource(source, id);
  const count = rendered.count || 0;
  let pos = { slide: Math.min(keep?.slide ?? pkg.item.slide ?? 0, Math.max(0, count - 1)), step: keep?.step ?? 0 };
  let playing = false;
  let muted = true;
  let seekNonce = 0;

  const box = el('div', { class: 'ql-slide' });
  stage.replaceChildren(box);
  const renderer = createRenderer({ type: 'deck', deckId: id, slide: pos.slide, step: pos.step, title: pkg.item.title }, {
    getDeckSource: () => source,
  });
  box.append(renderer.el);

  const isVideo = () => !!rendered.videos?.[pos.slide];
  function draw() {
    box.style.setProperty('--aspect', String(rendered.aspects?.[pos.slide] || 16 / 9));
    const it = { type: 'deck', deckId: id, slide: pos.slide, step: pos.step, playing, seekNonce };
    renderer.update(it);
    renderer.reconcile?.(it, { muted, volume: 1 });
    const steps = rendered.fragments?.[pos.slide] || 0;
    setWhere(`Slide ${pos.slide + 1} of ${count}${steps ? ` · build ${pos.step} of ${steps}` : ''}`);
    const note = rendered.notes?.[pos.slide] || '';
    $('#ql-notes-text').textContent = note || 'No notes on this slide.';
    $('#ql-notes-text').classList.toggle('is-empty', !note);
    $('#ql-notes').hidden = !notesOpen;
    $('#ql-notes-toggle').setAttribute('aria-pressed', String(notesOpen));
    $('#ql-play').hidden = !isVideo();
    $('#ql-mute').hidden = !isVideo();
    $('#ql-play').textContent = playing ? '⏸ Pause' : '▶ Play';
    $('#ql-mute').textContent = muted ? '🔇 Unmute' : '🔊 Mute';
    markGrid(pos.slide);
  }
  function go(next) {
    if (next.slide !== pos.slide) playing = false;
    pos = next;
    draw();
  }

  // Check before class: the same list the deck editor shows.
  const lives = deckLocation(pkg.item.src).kind;
  const destination = pkg.destination || { library: 'library', version: 'library', content: 'content' }[lives] || 'file';
  function checks() {
    const found = deckProblems(source, rendered, { destination, pageProtocol: location.protocol, mediaFound });
    $('#ql-checks-toggle').textContent = found.length ? `Check (${found.length})` : 'Check ✓';
    $('#ql-checks-list').replaceChildren(...(found.length
      ? found.map((p) => el('li', { class: `is-${p.severity}` },
        el('button', { type: 'button', onclick: () => { $('#ql-checks').hidden = true; go({ slide: p.slide, step: 0 }); } }, `Slide ${p.slide + 1}:`),
        ` ${p.message}`))
      : [el('li', { class: 'is-ok' }, 'Nothing to fix.')]));
  }
  checkServerMedia(parseDeck(source), mediaFound, checks);
  checks();

  // The grid: every slide, drawn once, as the room would see it.
  let grid = null;
  function buildGrid() {
    const host = el('div', { class: 'ql-cell-deck' });
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      .marpit { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
      svg[data-marpit-svg] { display: block; width: 100%; height: auto; border: 2px solid #2a3340; border-radius: 6px; cursor: pointer; background: #fff; }
      svg[data-marpit-svg].is-on { border-color: #6ea8fe; }
      .podium-fragment { opacity: 1 !important; }
    </style><style>${rendered.css}</style>${rendered.html}`;
    applyFits(shadow, rendered.fits);
    const slides = Array.from(shadow.querySelectorAll('svg[data-marpit-svg]'));
    slides.forEach((svg, i) => {
      svg.setAttribute('role', 'button');
      svg.setAttribute('aria-label', `Slide ${i + 1}: ${rendered.titles?.[i] || ''}`);
      svg.addEventListener('click', () => { $('#ql-grid').hidden = true; go({ slide: i, step: 0 }); });
    });
    $('#ql-grid-cells').replaceChildren(host);
    applyPolyfill(shadow);
    grid = slides;
    markGrid(pos.slide);
  }
  function markGrid(i) { grid?.forEach((svg, n) => svg.classList.toggle('is-on', n === i)); }

  $('#ql-grid-heading').textContent = 'Every slide';
  showControls(['ql-prev', 'ql-next', 'ql-grid-toggle', 'ql-notes-toggle', 'ql-checks-toggle']);
  draw();

  return {
    kind: 'deck',
    position: () => pos,
    next: () => go(deckStep(pos, 'next', rendered.fragments, count)),
    prev: () => go(deckStep(pos, 'prev', rendered.fragments, count)),
    first: () => go({ slide: 0, step: 0 }),
    last: () => go({ slide: Math.max(0, count - 1), step: 0 }),
    openGrid() { if (!grid) buildGrid(); markGrid(pos.slide); },
    toggleNotes() { notesOpen = !notesOpen; draw(); },
    play() { playing = !playing; draw(); },
    mute() { muted = !muted; draw(); },
    destroy() {
      renderer.destroy?.();
      forgetDeck(id);
      $('#ql-grid-cells').replaceChildren();
    },
  };
}

// --- a PDF ----------------------------------------------------------------------

async function pdfDocument(src) {
  const pdfjs = window.pdfjsLib;
  if (!pdfjs) return null;
  if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdf.worker.min.js';
  return pdfjs.getDocument(src).promise;
}

async function showPdf(pkg) {
  const item = pkg.item;
  let page = Math.max(1, item.page || 1);
  const doc = await pdfDocument(item.src).catch(() => null);
  const pages = doc?.numPages || 0;
  const box = el('div', { class: 'ql-fill' });
  stage.replaceChildren(box);
  const renderer = createRenderer({ ...item, type: 'pdf', page });
  box.append(renderer.el);
  function go(n) {
    page = pages ? Math.min(pages, Math.max(1, n)) : Math.max(1, n);
    renderer.update({ ...item, type: 'pdf', page });
    setWhere(pages ? `Page ${page} of ${pages}` : `Page ${page}`);
    cells?.forEach((cell, i) => cell.classList.toggle('is-on', i + 1 === page));
  }
  let cells = null;
  function buildGrid() {
    if (!doc) return;
    cells = Array.from({ length: pages }, (_, i) => el('button', {
      type: 'button', class: 'ql-cell', 'aria-label': `Page ${i + 1}`,
      onclick: () => { $('#ql-grid').hidden = true; go(i + 1); },
    }, el('span', { class: 'ql-cell-num' }, String(i + 1))));
    $('#ql-grid-cells').replaceChildren(...cells);
    // Each page drawn small as it scrolls into view, not all at once.
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        seen.unobserve(entry.target);
        const n = cells.indexOf(entry.target) + 1;
        doc.getPage(n).then((p) => {
          const viewport = p.getViewport({ scale: 1 });
          const scale = 240 / viewport.width;
          const canvas = el('canvas');
          canvas.width = Math.round(viewport.width * scale);
          canvas.height = Math.round(viewport.height * scale);
          entry.target.prepend(canvas);
          return p.render({ canvasContext: canvas.getContext('2d'), viewport: p.getViewport({ scale }) }).promise;
        }).catch(() => {});
      }
    }, { root: $('#ql-grid-cells') });
    cells.forEach((cell) => seen.observe(cell));
  }
  $('#ql-grid-heading').textContent = 'Every page';
  showControls(['ql-prev', 'ql-next', ...(doc ? ['ql-grid-toggle'] : [])]);
  go(page);
  return {
    kind: 'pdf',
    next: () => go(page + 1),
    prev: () => go(page - 1),
    first: () => go(1),
    last: () => go(pages || page),
    openGrid() { if (!cells) buildGrid(); go(page); },
    destroy() { renderer.destroy?.(); doc?.destroy?.(); },
  };
}

// --- pictures --------------------------------------------------------------------

function showPictureDeck(pkg) {
  const item = pkg.item;
  const images = item.images || [];
  let slide = Math.min(item.slide || 0, Math.max(0, images.length - 1));
  const box = el('div', { class: 'ql-fill' });
  stage.replaceChildren(box);
  const renderer = createRenderer({ ...item, slide });
  box.append(renderer.el);
  let cells = null;
  function go(n) {
    slide = Math.min(Math.max(0, n), Math.max(0, images.length - 1));
    renderer.update({ ...item, slide });
    setWhere(`Picture ${slide + 1} of ${images.length}`);
    cells?.forEach((cell, i) => cell.classList.toggle('is-on', i === slide));
  }
  $('#ql-grid-heading').textContent = 'Every picture';
  showControls(['ql-prev', 'ql-next', 'ql-grid-toggle']);
  go(slide);
  return {
    kind: 'imagedeck',
    next: () => go(slide + 1),
    prev: () => go(slide - 1),
    first: () => go(0),
    last: () => go(images.length - 1),
    openGrid() {
      if (!cells) {
        cells = images.map((src, i) => el('button', {
          type: 'button', class: 'ql-cell', 'aria-label': `Picture ${i + 1}`,
          onclick: () => { $('#ql-grid').hidden = true; go(i); },
        }, el('img', { src, alt: '', loading: 'lazy' }), el('span', { class: 'ql-cell-num' }, String(i + 1))));
        $('#ql-grid-cells').replaceChildren(...cells);
      }
      go(slide);
    },
    destroy() { renderer.destroy?.(); },
  };
}

function showPicture(pkg) {
  const renderer = createRenderer(pkg.item);
  stage.replaceChildren(renderer.el);
  // Click to see it at its own size, and again to fit it back in.
  renderer.el.addEventListener('click', () => stage.classList.toggle('is-zoomed'));
  setWhere('Click the picture to zoom');
  return { kind: 'image', destroy() { renderer.destroy?.(); } };
}

// --- video and audio: always muted to begin with -----------------------------------
//
// A presenter laptop is often what the room hears, so nothing here makes a
// sound until it is asked to.

function showMedia(pkg) {
  const item = pkg.item;
  const media = el(item.type === 'audio' ? 'audio' : 'video', { class: 'ql-media', controls: true, playsinline: true, preload: 'metadata' });
  media.muted = true;
  media.src = item.src;
  if (item.start) media.addEventListener('loadedmetadata', () => { media.currentTime = item.start; }, { once: true });
  stage.replaceChildren(media);
  const where = () => setWhere(`${fmtTime(media.currentTime || 0)} of ${media.duration ? fmtTime(media.duration) : '…'}${item.end ? ` · ends at ${fmtTime(item.end)} in class` : ''}`);
  media.addEventListener('timeupdate', where);
  media.addEventListener('loadedmetadata', where);
  const sync = () => {
    $('#ql-play').textContent = media.paused ? '▶ Play' : '⏸ Pause';
    $('#ql-mute').textContent = media.muted ? '🔇 Unmute' : '🔊 Mute';
  };
  media.addEventListener('play', sync);
  media.addEventListener('pause', sync);
  media.addEventListener('volumechange', sync);
  showControls(['ql-play', 'ql-mute']);
  sync();
  return {
    kind: item.type,
    element: media,
    play() { if (media.paused) media.play().catch(() => {}); else media.pause(); },
    mute() { media.muted = !media.muted; },
    destroy() { media.pause(); media.removeAttribute('src'); media.load(); },
  };
}

// --- web pages, YouTube, text --------------------------------------------------------

function showRendered(pkg) {
  const item = pkg.item;
  const box = el('div', { class: 'ql-fill' });
  stage.replaceChildren(box);
  const renderer = createRenderer(item, {});
  box.append(renderer.el);
  if (['web', 'slides', 'youtube'].includes(item.type) && !navigator.onLine) {
    warn('This is on another website, and this device is offline, so it may not show.');
  }
  return { kind: item.type, destroy() { renderer.destroy?.(); } };
}

// --- a set: its entries, each one a click away --------------------------------------

function showSet(pkg) {
  const entries = (pkg.item.entries || []).map((e) => e?.item || e).filter(Boolean);
  const list = el('ol');
  entries.forEach((entry) => list.append(el('li', {},
    el('button', { type: 'button', onclick: () => show({ ...pkg, item: entry }, { back: pkg }) },
      `${TYPES[entry.type]?.icon || ''} ${entry.title || TYPES[entry.type]?.label || entry.type}`))));
  stage.replaceChildren(el('div', { class: 'ql-set' }, el('h2', {}, `${entries.length} in this set`), list));
  setWhere(`${entries.length} entries`);
  return { kind: 'set' };
}

// --- showing one thing ----------------------------------------------------------------

async function show(pkg, { back = null, keep = null } = {}) {
  clearStage();
  warn('');
  const item = pkg.item || {};
  setTitle(item.title || TYPES[item.type]?.label || 'Quick Look', pkg.from ? `· ${pkg.from}` : '');
  try {
    if (item.type === 'deck') view = await showDeck(pkg, { keep });
    else if (item.type === 'pdf') view = await showPdf(pkg);
    else if (item.type === 'imagedeck') view = showPictureDeck(pkg);
    else if (item.type === 'image') view = showPicture(pkg);
    else if (item.type === 'video' || item.type === 'audio') view = showMedia(pkg);
    else if (['web', 'slides', 'youtube', 'text'].includes(item.type)) view = showRendered(pkg);
    else if (item.type === 'set') view = showSet(pkg);
    else message('There is nothing to look at for this kind of item.');
  } catch (err) {
    message(`That could not be opened: ${err.message}`);
  }
  if (back) {
    stage.append(el('button', { type: 'button', class: 'ql-back', onclick: () => show(back) }, '← Back to the set'));
  }
}

// --- where it comes from ---------------------------------------------------------------

function guessType(src) {
  const ext = (String(src).split(/[?#]/)[0].split('.').pop() || '').toLowerCase();
  if (['md', 'markdown'].includes(ext)) return 'deck';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'ogg', 'wav'].includes(ext)) return 'audio';
  return 'web';
}

function keep(token, pkg) {
  try { sessionStorage.setItem(KEPT + token, JSON.stringify(pkg)); } catch { /* too big to keep: a reload asks again */ }
}

function kept(token) {
  try { return JSON.parse(sessionStorage.getItem(KEPT + token) || 'null'); } catch { return null; }
}

/**
 * Ask the page that opened this tab for what to show - again every moment,
 * since it may still be gathering it - and keep listening for newer versions.
 */
function handover(token) {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve(null);
  const channel = new BroadcastChannel(CHANNEL);
  return new Promise((resolve, reject) => {
    let answered = false;
    const ask = setInterval(() => channel.postMessage({ want: token }), 400);
    const timer = setTimeout(() => { if (!answered) { clearInterval(ask); resolve(null); } }, ASK_MS);
    channel.addEventListener('message', (ev) => {
      if (ev.data?.token !== token || !ev.data.pkg) return;
      if (!answered) {
        answered = true;
        clearInterval(ask);
        clearTimeout(timer);
        if (ev.data.pkg.error) { reject(new Error(ev.data.pkg.error)); return; }
        keep(token, ev.data.pkg);
        resolve(ev.data.pkg);
        return;
      }
      // A newer version (the deck editor, as you type): redrawn where it was.
      if (ev.data.update) {
        keep(token, ev.data.pkg);
        show(ev.data.pkg, { keep: view?.position?.() || null });
      }
    });
    channel.postMessage({ want: token });
  });
}

async function fromLibrary(id) {
  const res = await fetch('/api/library', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(res.status === 401 ? 'Sign in to see the library.' : `the library said ${res.status}`);
  const { items } = await res.json();
  const item = (items || []).find((i) => String(i.id) === String(id));
  if (!item) throw new Error('that file is not in the library, or you cannot see it');
  return { item: { ...item, libraryId: item.id }, from: `Library${item.course ? ` · ${String(item.course).toUpperCase()}` : ''}` };
}

async function start() {
  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get('handoff');
  try {
    let pkg = null;
    if (token) {
      const stored = kept(token);
      pkg = await handover(token) || stored;
      if (!pkg) {
        setTitle('Quick Look');
        message('The page that opened this has gone, so there is nothing to show. Open it again from there.');
        return;
      }
    } else if (query.get('library')) {
      pkg = await fromLibrary(query.get('library'));
    } else if (query.get('src')) {
      const src = query.get('src');
      pkg = { item: { type: query.get('type') || guessType(src), src, title: decodeURIComponent(src.split('/').pop() || src) } };
    } else {
      setTitle('Quick Look');
      message('Open something from the controller, the planner or the deck editor with ↗ Quick Look.');
      return;
    }
    await show(pkg);
  } catch (err) {
    setTitle('Quick Look');
    message(`That could not be opened: ${err.message}`);
  }
}

// --- controls ---------------------------------------------------------------------------

function toggleOverlay(id) {
  const box = $(id);
  const opening = box.hidden;
  $('#ql-grid').hidden = true;
  $('#ql-checks').hidden = true;
  if (!opening) return;
  if (id === '#ql-grid') view?.openGrid?.();
  box.hidden = false;
}

$('#ql-prev').addEventListener('click', () => view?.prev?.());
$('#ql-next').addEventListener('click', () => view?.next?.());
$('#ql-play').addEventListener('click', () => view?.play?.());
$('#ql-mute').addEventListener('click', () => view?.mute?.());
$('#ql-grid-toggle').addEventListener('click', () => toggleOverlay('#ql-grid'));
$('#ql-checks-toggle').addEventListener('click', () => toggleOverlay('#ql-checks'));
$('#ql-notes-toggle').addEventListener('click', () => view?.toggleNotes?.());
$('#ql-grid-close').addEventListener('click', () => { $('#ql-grid').hidden = true; });
$('#ql-checks-close').addEventListener('click', () => { $('#ql-checks').hidden = true; });
$('#ql-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.body.requestFullscreen?.().catch(() => {});
});

document.addEventListener('keydown', (ev) => {
  if (ev.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  // A video's own controls keep their keys.
  if (view?.element && ev.target === view.element) return;
  const key = ev.key;
  if (key === 'Escape') { $('#ql-grid').hidden = true; $('#ql-checks').hidden = true; return; }
  const act = {
    ArrowRight: () => view?.next?.(), PageDown: () => view?.next?.(), ' ': () => view?.next?.(),
    ArrowLeft: () => view?.prev?.(), PageUp: () => view?.prev?.(),
    Home: () => view?.first?.(), End: () => view?.last?.(),
    g: () => !$('#ql-grid-toggle').hidden && toggleOverlay('#ql-grid'),
    c: () => !$('#ql-checks-toggle').hidden && toggleOverlay('#ql-checks'),
    n: () => view?.toggleNotes?.(),
    f: () => $('#ql-full').click(),
  }[key.length === 1 ? key.toLowerCase() : key];
  if (!act) return;
  if (key === ' ' && view?.element) { ev.preventDefault(); view.play(); return; }
  ev.preventDefault();
  act();
});

start();
