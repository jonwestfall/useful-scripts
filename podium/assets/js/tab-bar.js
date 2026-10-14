// The controller's tab bar (Issue #197), split out of control.js: the tabs
// laid out by group in this device's order, the ones it has hidden under
// "More", and the list in Settings that reorders and hides them.

import { $, el } from './util.js';
import { TAB_IDS, TAB_LABELS, TAB_GROUPS, groupOfTab } from './tabs.js';

/**
 * @param {object} deps
 * @param {object} deps.presentation - this device's preferences (presentation-prefs.js); tabOrder and hiddenTabs are changed in place.
 * @param {Function} deps.save - keeps `presentation` for next time.
 * @param {Function} deps.tabAvailable - whether this controller can use a tab where it is.
 * @param {Function} deps.tab - switches to a tab.
 * @returns {{ render: Function, renderSettings: Function }} the tab bar, and the Settings list.
 */
export function createTabBar({ presentation, save, tabAvailable, tab }) {
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

  function renderTabBar() {
    const nav = $('.tabs');
    const moreWrap = $('.tabs-more-wrap');
    if (!nav || !moreWrap) return;
    nav.querySelectorAll('.tab-divider').forEach((d) => d.remove());
    let lastGroup = null;
    for (const id of orderedTabs()) {
      const btn = nav.querySelector(`.tab[data-tab="${id}"]`);
      if (!btn) continue;
      btn.hidden = presentation.hiddenTabs.includes(id) || !tabAvailable(id);
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
    const hiddenIds = orderedTabs().filter((id) => presentation.hiddenTabs.includes(id) && tabAvailable(id));
    const moreBtn = $('#tabs-more');
    const menu = $('#tabs-more-menu');
    if (!moreBtn || !menu) return;
    moreBtn.hidden = hiddenIds.length === 0;
    menu.replaceChildren(...hiddenIds.map((id) => el('button', {
      type: 'button',
      onclick: () => { menu.hidden = true; tab(id); },
    }, TAB_LABELS[id] || id)));
    if (hiddenIds.length === 0) menu.hidden = true;
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

  $('#tabs-more')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    $('#tabs-more-menu').hidden = !$('#tabs-more-menu').hidden;
  });
  // Same dismissal a modal card gets elsewhere: tapping anything outside the
  // open menu closes it, so it never sits open over a tab you meant to press.
  document.addEventListener('click', (ev) => {
    const menu = $('#tabs-more-menu');
    if (menu && !menu.hidden && !ev.target.closest('.tabs-more-wrap')) menu.hidden = true;
  });

  return { render: renderTabBar, renderSettings: renderTabOrderSettings };
}
