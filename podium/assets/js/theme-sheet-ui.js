// A theme's cheat sheet, drawn (see theme-sheet.js for what is in it): a
// sample slide for the theme and for each of its classes, rendered by the
// same Marp, with the same themes, that decks get - then its colours, fonts,
// sizes, and the directives any deck can use. Opened from Admin's theme list
// and from the deck editor (where a class can be put on the current slide).

import { el } from './util.js';
import { render as renderDeck, applyPolyfill } from './deck.js';
import { analyzeTheme, builtInSheet, sampleDeck, DIRECTIVES } from './theme-sheet.js';

/** The sheet for a theme by its @theme name, or null if no theme has that name. */
export async function loadThemeSheet(name) {
  const builtIn = builtInSheet(name);
  if (builtIn) return builtIn;
  const res = await fetch('marp-themes/themes.json', { cache: 'no-cache' });
  if (!res.ok) return null;
  const data = await res.json();
  for (const file of Array.isArray(data) ? data : data.themes || []) {
    try {
      const css = await (await fetch(`marp-themes/${encodeURIComponent(file)}`, { cache: 'no-cache' })).text();
      if (/@theme\s+([\w-]+)/.exec(css)?.[1] === name) return { ...analyzeTheme(css), file };
    } catch { /* one unreadable theme does not stop the search */ }
  }
  return null;
}

function slideCard(svg, css, title, about, code, onUse) {
  const frame = el('div', { class: 'theme-sheet-slide' });
  const shadow = frame.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>:host{display:block}svg[data-marpit-svg]{display:block;width:100%;height:auto}</style><style>${css}</style><div class="marpit">${svg.outerHTML}</div>`;
  applyPolyfill(shadow).catch(() => {});
  return el('figure', { class: 'theme-sheet-card' },
    frame,
    el('figcaption', {},
      el('strong', {}, title),
      about ? el('span', { class: 'hint' }, about) : null,
      code ? el('code', {}, code) : null,
      onUse ? el('button', { type: 'button', class: 'theme-sheet-use', onclick: onUse }, 'Use on this slide') : null));
}

/**
 * Draw `sheet` into `holder`.
 *   onUseClass(name)  offered on each class card when given (the deck editor)
 */
export async function renderThemeSheet(holder, sheet, { onUseClass } = {}) {
  holder.replaceChildren(el('p', { class: 'hint' }, 'Drawing the sample slides…'));
  const parts = [];
  if (sheet.about) parts.push(el('p', { class: 'theme-sheet-about' }, sheet.about));
  if (sheet.imports?.length) parts.push(el('p', { class: 'hint' }, `Built on ${sheet.imports.join(', ')}: anything not set here comes from ${sheet.imports.length === 1 ? 'it' : 'them'}.`));

  let grid;
  try {
    const deck = await renderDeck(sampleDeck(sheet));
    const doc = new DOMParser().parseFromString(deck.html, 'text/html');
    const svgs = [...doc.querySelectorAll('svg[data-marpit-svg]')];
    grid = el('div', { class: 'theme-sheet-grid' },
      svgs[0] ? slideCard(svgs[0], deck.css, 'No class', 'The theme as every slide gets it.', '', null) : null,
      ...sheet.classes.map((c, i) => (svgs[i + 1]
        ? slideCard(svgs[i + 1], deck.css, c.name, [c.about, c.from && `(from ${c.from})`].filter(Boolean).join(' '),
          `<!-- _class: ${c.name} -->`, onUseClass ? () => onUseClass(c.name) : null)
        : null)));
  } catch (err) {
    grid = el('p', { class: 'hint' }, `The sample slides could not be drawn: ${err.message}`);
  }
  parts.push(el('h3', {}, sheet.classes.length ? `Slide classes (${sheet.classes.length})` : 'Slides'), grid);
  if (!sheet.classes.length) parts.push(el('p', { class: 'hint' }, 'This theme styles every slide the same way; it has no classes of its own.'));

  const colours = sheet.variables.filter((v) => v.color);
  if (colours.length) {
    parts.push(el('h3', {}, 'Colours'), el('div', { class: 'theme-sheet-colours' },
      ...colours.map((v) => el('span', { class: 'theme-sheet-colour', title: `${v.name}: ${v.value}` },
        el('span', { class: 'theme-sheet-chip', style: { background: v.value } }), el('code', {}, v.name), el('span', { class: 'hint' }, v.value)))));
  }
  if (sheet.fonts.length) {
    parts.push(el('h3', {}, 'Fonts'), el('ul', { class: 'theme-sheet-fonts' }, ...sheet.fonts.map((f) => el('li', { style: { fontFamily: f } }, f))));
  }
  if (sheet.sizes.length) {
    parts.push(el('h3', {}, 'Slide sizes'), el('p', { class: 'hint' }, 'Besides 16:9 and 4:3, in the front matter as size:'),
      el('ul', {}, ...sheet.sizes.map((z) => el('li', {}, el('code', {}, `size: ${z.name}`), ` — ${z.width} × ${z.height}`))));
  }
  parts.push(el('h3', {}, 'Directives any deck can use'), el('table', { class: 'theme-sheet-directives' },
    el('tbody', {}, ...DIRECTIVES.map((d) => el('tr', {}, el('th', {}, d.name), el('td', {}, el('code', {}, d.example)), el('td', {}, d.about))))));
  holder.replaceChildren(...parts);
  noteUnchangedClasses(holder, sheet);
}

// A class a theme inherits (gaia's invert, say) can be undone by the theme's
// own colours: then it is worth saying it makes no visible difference here,
// rather than describing what it does in the theme it came from.
function noteUnchangedClasses(holder, sheet) {
  const cards = [...holder.querySelectorAll('.theme-sheet-card')];
  const look = (card) => {
    const section = card?.querySelector('.theme-sheet-slide')?.shadowRoot?.querySelector('section');
    if (!section) return null;
    const style = getComputedStyle(section);
    return `${style.backgroundColor}|${style.backgroundImage}|${style.color}`;
  };
  const plain = look(cards[0]);
  if (!plain) return;
  sheet.classes.forEach((c, i) => {
    if (!c.from || look(cards[i + 1]) !== plain) return;
    cards[i + 1].querySelector('figcaption .hint')?.replaceChildren(`From ${c.from}, but this theme\u2019s own colours override it: it looks the same as no class here.`);
  });
}

/** The cheat sheet for `name` in a dialog over the page. */
export async function openThemeSheet(name, { onUseClass } = {}) {
  const body = el('div', { class: 'theme-sheet' }, el('p', { class: 'hint' }, 'Reading the theme…'));
  const close = () => { dialog.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  const dialog = el('div', { class: 'deck-dialog theme-sheet-dialog', onclick: (ev) => { if (ev.target === dialog) close(); } },
    el('div', { class: 'deck-dialog-card theme-sheet-card-outer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Theme guide: ${name}` },
      el('div', { class: 'theme-sheet-head' },
        el('h2', {}, `Theme guide: ${name}`),
        el('button', { type: 'button', class: 'theme-sheet-close', onclick: close, 'aria-label': 'Close' }, '×')),
      body));
  document.body.append(dialog);
  document.addEventListener('keydown', onKey, true);
  dialog.querySelector('.theme-sheet-close').focus();
  try {
    const sheet = await loadThemeSheet(name);
    if (!sheet) { body.replaceChildren(el('p', {}, `No theme called “${name}” is installed here.`)); return; }
    await renderThemeSheet(body, sheet, { onUseClass: onUseClass ? (cls) => { onUseClass(cls); close(); } : undefined });
  } catch (err) {
    body.replaceChildren(el('p', {}, `The guide could not be read: ${err.message}`));
  }
}
