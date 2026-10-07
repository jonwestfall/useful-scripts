// Reading a document at your own pace, in Guest View (Issue #240).
//
// A viewer following the class sees the page exactly as the room does: the
// projector's layout, scaled to their phone, at the presenter's place, with
// the presenter's ink. At a phone's width that layout is small, so a student
// can switch to *Read at my own pace*: the same document reflowed to fit the
// phone, scrolled however they like, with a marker for where the presenter
// is. *Back to the presenter* rejoins. Ink is not shown while reading - text
// reflowed for a phone no longer lines up with it.
//
// What arrives here never had its presenter notes: the display strips them
// before a document reaches a viewer (stripDeckNotes in protocol.js).

import { el } from './util.js';
import { renderDoc } from './doc.js';

const READER_CSS = `
  .doc-reader-page .podium-doc { width: auto; max-width: 46rem; margin: 0 auto; padding: 18px 16px 48px; font-size: 17px; }
  .doc-reader-page .podium-doc img.podium-diagram { max-width: 100%; height: auto; }
  .doc-reader-page .podium-doc .katex-display { overflow-x: auto; overflow-y: hidden; }
  .doc-reader-page .podium-doc table { display: block; overflow-x: auto; }
`;

/**
 * @param {object} opts
 * @param {(item: object) => (string|Promise<string>|null)} opts.getSource - the document's markdown
 */
export function createDocReader({ getSource }) {
  const toggle = el('button', { type: 'button', class: 'doc-reader-toggle', hidden: true }, 'Read at my own pace');
  const back = el('button', { type: 'button', class: 'doc-reader-back' }, 'Back to the presenter');
  const marker = el('div', { class: 'doc-reader-marker', 'aria-hidden': 'true' }, el('span', {}, 'The class is here'));
  const page = el('div', { class: 'doc-reader-page' });
  const styles = el('style');
  const scroller = el('div', { class: 'doc-reader-scroll' }, styles, page, marker);
  const panel = el('div', { class: 'doc-reader', role: 'dialog', 'aria-label': 'Reading the document', hidden: true },
    el('div', { class: 'doc-reader-bar' }, el('span', { class: 'doc-reader-title' }), back),
    scroller);
  document.body.append(toggle, panel);

  let item = null;
  let shownKey = null;
  let reading = false;
  let generation = 0;

  async function fill() {
    const mine = ++generation;
    const key = `${item?.deckId}|${item?.look || ''}`;
    if (key === shownKey) return;
    page.textContent = 'Loading the document…';
    try {
      const source = await getSource(item);
      if (mine !== generation) return;
      if (source == null) { page.textContent = 'Waiting for the document…'; setTimeout(() => { if (reading && mine === generation) fill(); }, 1000); return; }
      const doc = await renderDoc(source, item.deckId, { look: item.look });
      if (mine !== generation) return;
      styles.textContent = `${doc.css}\n${READER_CSS}`;
      page.innerHTML = doc.html;
      panel.querySelector('.doc-reader-title').textContent = doc.title;
      panel.classList.toggle('is-dark', doc.look === 'dark');
      shownKey = key;
      placeMarker();
    } catch (err) {
      page.textContent = `This document could not be shown: ${err.message}`;
    }
  }

  // Where the presenter is, as the same fraction of the reflowed page -
  // the layouts differ, so this is "about here", which is what it says.
  function placeMarker() {
    if (!item || !page.firstElementChild) return;
    const fraction = Math.min(1, Math.max(0, (Number(item.at) || 0) / Math.max(1, Number(item.height) || 1)));
    marker.style.top = `${Math.round(page.offsetTop + fraction * page.offsetHeight)}px`;
  }

  function open() {
    reading = true;
    panel.hidden = false;
    toggle.hidden = true;
    shownKey = null;
    fill().then(() => {
      // Start where the class is.
      scroller.scrollTop = Math.max(0, marker.offsetTop - 40);
    });
  }

  function close() {
    reading = false;
    panel.hidden = true;
    toggle.hidden = item?.type !== 'document';
  }

  toggle.addEventListener('click', open);
  back.addEventListener('click', close);

  return {
    /** What the class has on screen now. */
    update(next) {
      item = next?.type === 'document' && next.deckId ? next : null;
      if (!item) { if (reading) close(); toggle.hidden = true; return; }
      if (!reading) { toggle.hidden = false; return; }
      fill();
      placeMarker();
    },
    get reading() { return reading; },
  };
}
