// The controller's tab bar (Issue #197), split out of control.js: the tabs
// laid out by group in this device's order, the ones it has hidden under
// "More", and the list in Settings that reorders and hides them.

import { $, $$, el } from './util.js';
import { TAB_IDS, TAB_LABELS, TAB_GROUPS, groupOfTab } from './tabs.js';

/**
 * @param {object} deps
 * @param {object} deps.presentation - this device's preferences (presentation-prefs.js); tabOrder and hiddenTabs are changed in place.
 * @param {Function} deps.save - keeps `presentation` for next time.
 * @param {Function} deps.tabAvailable - whether this controller can use a tab where it is.
 * @param {Function} deps.tab - switches to a tab.
 * @returns {{ render: Function, renderSettings: Function }} the tab bar, and the Settings list.
 */
// On a phone (iPhone Duo review): thirteen tabs in a row that scrolls showed
// five or six of them, and the rest had to be hunted for sideways. There the
// row keeps the first few in this device's order - Library, Slides, Now and
// Ink, unless reordered - and More opens every other tab, by group, as a
// sheet of big buttons. The tab in front, if it is one of those, names the
// More button, so the row still says where you are.
const PHONE_TABS = 4;
const PHONE_QUERY = '(max-width: 640px)';

export function createTabBar({ presentation, save, tabAvailable, tab }) {
  const phone = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : null;
  const onPhone = () => !!phone?.matches;

  /**
   * Lay the tab buttons out by group (Issue #197), in presentation.tabOrder
   * within each group, hide the ones in presentation.hiddenTabs, put a divider
   * between groups, and keep #tabs-more in sync. The buttons themselves are
   * never rebuilt - appendChild on an existing node just moves it, so the click
   * listener wired once at startup keeps working on every one of them, hidden
   * or not, in whatever order they end up in.
   */
  function orderedTabs() {
    return TAB_GROUPS.flatMap(([group]) => presentation.tabOrder.filter((id) => groupOfTab(id) === group));
  }

  /** The tabs the row shows: on a phone, only the first few of those it would. */
  function rowTabs() {
    const shown = orderedTabs().filter((id) => !presentation.hiddenTabs.includes(id) && tabAvailable(id));
    return onPhone() ? shown.slice(0, PHONE_TABS) : shown;
  }

  function renderTabBar() {
    const nav = $('.tabs');
    const moreWrap = $('.tabs-more-wrap');
    if (!nav || !moreWrap) return;
    nav.querySelectorAll('.tab-divider').forEach((d) => d.remove());
    nav.classList.toggle('is-phone', onPhone());
    const inRow = new Set(rowTabs());
    let lastGroup = null;
    for (const id of orderedTabs()) {
      const btn = nav.querySelector(`.tab[data-tab="${id}"]`);
      if (!btn) continue;
      btn.hidden = !inRow.has(id);
      const group = groupOfTab(id);
      // A divider only between two groups that both have a tab showing.
      if (!btn.hidden && lastGroup && group !== lastGroup) {
        nav.insertBefore(el('span', { class: 'tab-divider', 'aria-hidden': 'true' }), moreWrap);
      }
      nav.insertBefore(btn, moreWrap);
      if (!btn.hidden) lastGroup = group;
    }
    renderTabsMoreMenu();
  }

  function renderTabsMoreMenu() {
    const inRow = new Set(rowTabs());
    const moreIds = orderedTabs().filter((id) => !inRow.has(id) && tabAvailable(id));
    const moreBtn = $('#tabs-more');
    const menu = $('#tabs-more-menu');
    if (!moreBtn || !menu) return;
    moreBtn.hidden = moreIds.length === 0;
    const pick = (id) => el('button', {
      type: 'button',
      'data-more-tab': id,
      onclick: () => { menu.hidden = true; tab(id); },
    }, TAB_LABELS[id] || id);
    if (onPhone()) {
      // A sheet, by group, so "where is Timer" has an answer at a glance.
      const sections = [];
      for (const [group, label] of TAB_GROUPS) {
        const ids = moreIds.filter((id) => groupOfTab(id) === group);
        if (!ids.length) continue;
        sections.push(el('div', { class: 'tabs-more-group' }, label), el('div', { class: 'tabs-more-grid' }, ...ids.map(pick)));
      }
      menu.replaceChildren(...sections);
    } else {
      menu.replaceChildren(...moreIds.map(pick));
    }
    menu.classList.toggle('is-sheet', onPhone());
    if (moreIds.length === 0) menu.hidden = true;
    syncMoreLabel();
  }

  /** The More button names the tab in front when that tab is one of its own. */
  function syncMoreLabel() {
    const moreBtn = $('#tabs-more');
    if (!moreBtn) return;
    const current = typeof document !== 'undefined' ? document.body?.dataset.tab : '';
    const inMore = !!current && !rowTabs().includes(current) && TAB_IDS.includes(current);
    moreBtn.textContent = `${inMore ? (TAB_LABELS[current] || current) : 'More'} \u25BE`;
    moreBtn.classList.toggle('is-on', inMore);
    if (inMore) moreBtn.setAttribute('aria-current', 'true');
    else moreBtn.removeAttribute('aria-current');
    $$('#tabs-more-menu [data-more-tab]').forEach((b) => b.classList.toggle('is-on', b.dataset.moreTab === current));
  }

  /** Swap tab `id` with its neighbour in its own group; `dir` is -1 or 1. */
  function moveTab(id, dir) {
    const group = TAB_GROUPS.find(([g]) => g === groupOfTab(id))?.[2] || [];
    const inGroup = presentation.tabOrder.filter((t) => group.includes(t));
    const i = inGroup.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= inGroup.length) return;
    const order = presentation.tabOrder.slice();
    const a = order.indexOf(inGroup[i]);
    const b = order.indexOf(inGroup[j]);
    [order[a], order[b]] = [order[b], order[a]];
    presentation.tabOrder = order;
    save();
    renderTabBar();
    renderTabOrderSettings();
  }

  function toggleTabHidden(id, hide) {
    const hiddenTabs = presentation.hiddenTabs.filter((t) => t !== id);
    if (hide) hiddenTabs.push(id);
    // Hiding every tab would leave nothing to tap without opening Settings
    // first - the one rule the reorder/hide UI enforces on itself.
    if (hiddenTabs.length >= TAB_IDS.length || !TAB_IDS.some((t) => tabAvailable(t) && !hiddenTabs.includes(t))) return;
    presentation.hiddenTabs = hiddenTabs;
    save();
    renderTabBar();
    renderTabOrderSettings();
  }

  function renderTabOrderSettings() {
    const list = $('#tab-order-list');
    if (!list) return;
    const rows = [];
    for (const [group, label] of TAB_GROUPS) {
      const ids = presentation.tabOrder.filter((id) => groupOfTab(id) === group && tabAvailable(id));
      if (!ids.length) continue;
      rows.push(el('div', { class: 'tab-order-group' }, label));
      ids.forEach((id, i) => {
        const isHidden = presentation.hiddenTabs.includes(id);
        rows.push(el('div', { class: 'tab-order-row' },
          el('div', { class: 'tab-order-move' },
            el('button', { type: 'button', disabled: i === 0, title: 'Move earlier', 'aria-label': `Move ${TAB_LABELS[id] || id} earlier`, onclick: () => moveTab(id, -1) }, '▲'),
            el('button', { type: 'button', disabled: i === ids.length - 1, title: 'Move later', 'aria-label': `Move ${TAB_LABELS[id] || id} later`, onclick: () => moveTab(id, 1) }, '▼')),
          el('span', { class: 'tab-order-label' }, TAB_LABELS[id] || id),
          el('label', { class: 'check tab-order-show' },
            el('input', {
              type: 'checkbox',
              checked: !isHidden,
              onchange: (ev) => toggleTabHidden(id, !ev.target.checked),
            }),
            'Show')));
      });
    }
    list.replaceChildren(...rows);
  }

  phone?.addEventListener?.('change', () => renderTabBar());
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && document.body) {
    new MutationObserver(syncMoreLabel).observe(document.body, { attributes: true, attributeFilter: ['data-tab'] });
  }

  $('#tabs-more')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const menu = $('#tabs-more-menu');
    menu.hidden = !menu.hidden;
    // The sheet hangs just under the row of tabs, wherever that is on screen.
    if (!menu.hidden && menu.classList.contains('is-sheet')) {
      menu.style.setProperty('--more-top', `${Math.round($('.tabs').getBoundingClientRect().bottom + 6)}px`);
    }
  });
  // Same dismissal a modal card gets elsewhere: tapping anything outside the
  // open menu closes it, so it never sits open over a tab you meant to press.
  document.addEventListener('click', (ev) => {
    const menu = $('#tabs-more-menu');
    if (menu && !menu.hidden && !ev.target.closest('.tabs-more-wrap')) menu.hidden = true;
  });

  return { render: renderTabBar, renderSettings: renderTabOrderSettings };
}
