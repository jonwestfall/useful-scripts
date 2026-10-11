// Choosing how a poll looks (poll-look.js), as the controller's Settings and
// composer and the planner show it: light, dark or a slide theme's colours,
// which colours the results are drawn in, and a strip of what that comes to.

import { el } from './util.js';
import { LOOK_MODES, PALETTES, lookColors, normalizeLook } from './poll-look.js';
import { listThemes, resolveLook } from './poll-look-theme.js';

/**
 * The picker.
 *
 *   value        { mode, theme, palette } (mode '' = "as the controller is set",
 *                when allowDefault)
 *   onChange     called with the chosen look - for a theme, with its colours
 *                read in (see resolveLook) - or null for "as set"
 *   allowDefault offer "As the controller is set" (the planner)
 *   idPrefix     ids for the three selects, so labels and tests can find them
 */
export function pollLookPicker({ value = {}, onChange, allowDefault = false, defaultLabel = 'As the controller is set', idPrefix = 'poll-look' }) {
  const current = { mode: value.mode ?? (allowDefault ? '' : 'dark'), theme: value.theme || 'default', palette: value.palette || 'accent' };
  const mode = el('select', { id: `${idPrefix}-mode`, 'aria-label': 'Poll screen' },
    allowDefault ? el('option', { value: '' }, defaultLabel) : null,
    ...LOOK_MODES.map(([k, label]) => el('option', { value: k }, label)));
  const theme = el('select', { id: `${idPrefix}-theme`, 'aria-label': 'Slide theme' }, el('option', { value: current.theme }, current.theme));
  const palette = el('select', { id: `${idPrefix}-palette`, 'aria-label': 'Result colours' },
    ...PALETTES.map(([k, label]) => el('option', { value: k }, label)));
  const swatch = el('div', { class: 'poll-look-swatch', 'aria-hidden': 'true' });
  const note = el('p', { class: 'hint poll-look-note', role: 'status' });
  mode.value = current.mode;
  palette.value = current.palette;

  listThemes().then((names) => {
    theme.replaceChildren(...names.map((n) => el('option', { value: n }, n)));
    theme.value = names.includes(current.theme) ? current.theme : names[0];
    current.theme = theme.value;
  });

  let seq = 0;
  async function refresh(notify) {
    const fromDefault = allowDefault && !mode.value;
    theme.closest('.poll-look-row').hidden = mode.value !== 'theme';
    palette.closest('.poll-look-row').hidden = fromDefault;
    // "The theme's colours" only means something with a theme.
    palette.querySelector('option[value="theme"]').disabled = mode.value !== 'theme';
    if (mode.value !== 'theme' && palette.value === 'theme') palette.value = 'accent';
    const mine = ++seq;
    const look = fromDefault ? null : await resolveLook({ mode: mode.value, theme: theme.value, palette: palette.value });
    if (mine !== seq) return;
    note.textContent = mode.value === 'theme' && look?.mode !== 'theme' ? 'That theme could not be read; dark it is.' : '';
    drawSwatch(swatch, look);
    if (notify) onChange?.(look ? normalizeLook(look) : null);
  }
  const picker = el('div', { class: 'poll-look' },
    el('div', { class: 'poll-look-row' }, el('label', { for: mode.id }, 'Poll screen'), mode),
    el('div', { class: 'poll-look-row' }, el('label', { for: theme.id }, 'Theme'), theme),
    el('div', { class: 'poll-look-row' }, el('label', { for: palette.id }, 'Result colours'), palette),
    swatch, note);
  for (const select of [mode, theme, palette]) select.addEventListener('change', () => refresh(true));
  refresh(false);
  return picker;
}

/** A strip in the look's colours: its background, a line of text, and the result colours as bars. */
export function drawSwatch(holder, look) {
  if (!look) { holder.replaceChildren(); holder.hidden = true; return; }
  holder.hidden = false;
  const c = lookColors(look);
  holder.style.background = c.bg;
  holder.style.color = c.fg;
  holder.replaceChildren(
    el('span', { class: 'poll-look-swatch-text' }, 'Aa'),
    ...c.palette.slice(0, 7).map((color, i) => el('span', { class: 'poll-look-swatch-bar', style: { background: color, width: `${90 - i * 9}%` } })),
  );
}
