// This device's presentation preferences on the controller, split out of
// control.js.
//
// Per device, like previewHidden and confidenceSplit in control.js - none of
// this is room state, so none of it goes through send()/state. Grouped into
// one object rather than loose keys because this is the one place in the app
// where "device preferences" has grown into its own settings surface (the
// Presentation tab) rather than a single quick-access toggle.

import { safeStorageSet } from './util.js';
import { TAB_IDS, DEFAULT_HIDDEN_TABS, TAB_LAYOUT_VERSION } from './tabs.js';

const PRESENTATION_KEY = 'podium.presentation.v1';
const PRESENTATION_DEFAULTS = {
  // Follows the device's own light/dark setting unless chosen here (Issue #210).
  theme: 'auto',
  showPollUrl: true,
  // Issue #297: the voting countdown on the poll screen, not just the phones.
  showPollCountdown: true,
  // How polls look (poll-look.js); null is the dark look polls always had.
  pollLook: null,
  blankOnConnect: true,
  keepAwake: true,
  haptics: true,
  keepPhotos: false,
  autoSaveInk: false,
  lectureDuration: 0,
  pacingAutoStart: true,
  bottomSlot1: 'music',
  bottomSlot2: 'play',
  bottomSlots: ['music', 'play', 'freeze', 'blank', 'none', 'none', 'none', 'none'],
  inkScrollGutter: false,
  inkControlsTop: false,
  snapShapes: true,
  autoSwitchTab: true,
  helpOpen: false,
  // Issue #209: tighter spacing, smaller buttons, help put away. Per device.
  compact: false,
  tabOrder: [...TAB_IDS],
  hiddenTabs: [...DEFAULT_HIDDEN_TABS],
  tabLayoutVersion: TAB_LAYOUT_VERSION,
};
/** This device's presentation preferences, with every one this build knows filled in. */
export function loadPresentation() {
  try {
    const saved = JSON.parse(localStorage.getItem(PRESENTATION_KEY) || '{}');
    const merged = { ...PRESENTATION_DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
    if (!['dark', 'light', 'auto'].includes(merged.theme)) merged.theme = 'auto';
    if (merged.haptics === undefined) merged.haptics = true;
    if (merged.snapShapes === undefined) merged.snapShapes = true;
    // A saved order is a permutation of whatever TAB_IDS was when it was
    // saved - drop ids this build no longer has and append ones it grew,
    // rather than reject the whole thing and silently reset someone's
    // careful reordering over an unrelated code change.
    // Once, when the default arrangement changes (Issue #197's groups): a
    // custom order saved for the old 12 tabs would scatter tabs across the
    // new group dividers, so this device starts from the new default order,
    // keeps whatever it had hidden, and has Camera and Photos tucked away too.
    if ((merged.tabLayoutVersion || 1) < TAB_LAYOUT_VERSION) {
      merged.tabOrder = [...TAB_IDS];
      merged.hiddenTabs = [...new Set([...(Array.isArray(merged.hiddenTabs) ? merged.hiddenTabs : []), ...DEFAULT_HIDDEN_TABS])];
      merged.tabLayoutVersion = TAB_LAYOUT_VERSION;
    }
    if (!Array.isArray(merged.tabOrder)) merged.tabOrder = [...TAB_IDS];
    merged.tabOrder = merged.tabOrder.filter((id) => TAB_IDS.includes(id));
    for (const id of TAB_IDS) if (!merged.tabOrder.includes(id)) merged.tabOrder.push(id);
    if (!Array.isArray(merged.hiddenTabs)) merged.hiddenTabs = [];
    merged.hiddenTabs = merged.hiddenTabs.filter((id) => TAB_IDS.includes(id));
    // At least one tab must stay reachable without opening Settings.
    if (merged.hiddenTabs.length >= TAB_IDS.length) merged.hiddenTabs = [];
    if (!Array.isArray(merged.bottomSlots) || merged.bottomSlots.length !== 8) {
      merged.bottomSlots = [
        merged.bottomSlot1 || 'music',
        merged.bottomSlot2 || 'play',
        'freeze',
        'blank',
        'none',
        'none',
        'none',
        'none',
      ];
    }
    return merged;
  } catch { return { ...PRESENTATION_DEFAULTS }; }
}
/** Keep `presentation` (as loadPresentation made it, and changed since) for next time. */
export function savePresentation(presentation) {
  safeStorageSet(localStorage, PRESENTATION_KEY, JSON.stringify(presentation));
}
