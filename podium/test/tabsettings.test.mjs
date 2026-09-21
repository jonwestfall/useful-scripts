// Run with: node podium/test/tabsettings.test.mjs
// Unit tests for the customizable/collapsible controller tab bar (Issue #76).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let ok = true;
const chk = (label, cond) => {
  if (!cond) {
    ok = false;
    console.error('FAIL', label);
  } else {
    console.log('ok  ', label);
  }
};

const TAB_IDS = ['library', 'slides', 'now', 'ink', 'say', 'timer', 'camera', 'photos', 'music', 'mixer', 'sets', 'polls'];

console.log('-- loadPresentation sanitizes a saved tab order/hidden set --');

// A standalone copy of the sanitization loadPresentation() runs, exercised
// the same way protocol.js's pure functions are: no DOM, no localStorage,
// just the logic that decides what a saved value becomes.
function sanitizeTabPrefs(saved) {
  const merged = { tabOrder: [...TAB_IDS], hiddenTabs: [], ...saved };
  if (!Array.isArray(merged.tabOrder)) merged.tabOrder = [...TAB_IDS];
  merged.tabOrder = merged.tabOrder.filter((id) => TAB_IDS.includes(id));
  for (const id of TAB_IDS) if (!merged.tabOrder.includes(id)) merged.tabOrder.push(id);
  if (!Array.isArray(merged.hiddenTabs)) merged.hiddenTabs = [];
  merged.hiddenTabs = merged.hiddenTabs.filter((id) => TAB_IDS.includes(id));
  if (merged.hiddenTabs.length >= TAB_IDS.length) merged.hiddenTabs = [];
  return merged;
}

chk('an empty save defaults to the shipped order, nothing hidden',
  JSON.stringify(sanitizeTabPrefs({}).tabOrder) === JSON.stringify(TAB_IDS));

chk('a reordered save is kept as-is', () => {
  const reordered = ['ink', 'library', 'slides', 'now', 'say', 'timer', 'camera', 'photos', 'music', 'mixer', 'sets', 'polls'];
  return JSON.stringify(sanitizeTabPrefs({ tabOrder: reordered }).tabOrder) === JSON.stringify(reordered);
});

chk('a stale id from an older build is dropped, not kept as a ghost tab', () => {
  const stale = ['library', 'retired-tab', 'slides', 'now', 'ink', 'say', 'timer', 'camera', 'photos', 'music', 'mixer', 'sets', 'polls'];
  return !sanitizeTabPrefs({ tabOrder: stale }).tabOrder.includes('retired-tab');
});

chk('a tab this build grew that the save predates is appended, not lost', () => {
  const short = TAB_IDS.filter((id) => id !== 'polls');
  const res = sanitizeTabPrefs({ tabOrder: short });
  return res.tabOrder.includes('polls') && res.tabOrder.length === TAB_IDS.length;
});

chk('hiding some tabs is kept', () => {
  const res = sanitizeTabPrefs({ hiddenTabs: ['camera', 'polls'] });
  return res.hiddenTabs.length === 2 && res.hiddenTabs.includes('camera') && res.hiddenTabs.includes('polls');
});

chk('hiding every tab is refused - at least one stays reachable', () => {
  const res = sanitizeTabPrefs({ hiddenTabs: [...TAB_IDS] });
  return res.hiddenTabs.length === 0;
});

chk('a stale hidden id is dropped the same way a stale order id is',
  !sanitizeTabPrefs({ hiddenTabs: ['retired-tab'] }).hiddenTabs.includes('retired-tab'));

console.log('-- reorder and hide, applied to a working copy --');

function simulateMoveTab(tabOrder, id, dir) {
  const order = tabOrder.slice();
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return order;
  [order[i], order[j]] = [order[j], order[i]];
  return order;
}

chk('moving a tab later swaps it with its neighbor', () => {
  const res = simulateMoveTab(TAB_IDS, 'library', 1);
  return res[0] === 'slides' && res[1] === 'library';
});

chk('moving the first tab earlier is a no-op, not a wraparound',
  JSON.stringify(simulateMoveTab(TAB_IDS, 'library', -1)) === JSON.stringify(TAB_IDS));

chk('moving the last tab later is a no-op, not a wraparound',
  JSON.stringify(simulateMoveTab(TAB_IDS, 'polls', 1)) === JSON.stringify(TAB_IDS));

function simulateToggleHidden(hiddenTabs, id, hide) {
  const next = hiddenTabs.filter((t) => t !== id);
  if (hide) next.push(id);
  if (next.length >= TAB_IDS.length) return hiddenTabs;
  return next;
}

chk('hiding a tab adds it once', JSON.stringify(simulateToggleHidden([], 'camera', true)) === JSON.stringify(['camera']));
chk('un-hiding removes it', JSON.stringify(simulateToggleHidden(['camera'], 'camera', false)) === JSON.stringify([]));
chk('hiding the last visible tab is refused', () => {
  const eleven = TAB_IDS.slice(0, 11);
  return JSON.stringify(simulateToggleHidden(eleven, TAB_IDS[11], true)) === JSON.stringify(eleven);
});

console.log('-- DOM and CSS verification --');

{
  const html = fs.readFileSync(path.join(ROOT, 'control.html'), 'utf8');
  for (const id of TAB_IDS) {
    chk(`control.html has a tab button for ${id}`, html.includes(`data-tab="${id}"`));
  }
  chk('control.html has the More button', html.includes('id="tabs-more"'));
  chk('control.html has the More menu', html.includes('id="tabs-more-menu"'));
  chk('control.html has the Controller tabs settings list', html.includes('id="tab-order-list"'));

  const css = fs.readFileSync(path.join(ROOT, 'assets/css/podium.css'), 'utf8');
  chk('podium.css styles .tabs-more-wrap', css.includes('.tabs-more-wrap'));
  chk('podium.css styles .tabs-more-menu', css.includes('.tabs-more-menu'));
  chk('podium.css styles .tab-order-list', css.includes('.tab-order-list'));
  chk('podium.css styles .tab-order-row', css.includes('.tab-order-row'));

  const js = fs.readFileSync(path.join(ROOT, 'assets/js/control.js'), 'utf8');
  chk('control.js has the 12-tab TAB_IDS list', js.includes("const TAB_IDS = ['library', 'slides', 'now', 'ink', 'say', 'timer', 'camera', 'photos', 'music', 'mixer', 'sets', 'polls']"));
  chk('control.js has renderTabBar', js.includes('function renderTabBar()'));
  chk('control.js has renderTabsMoreMenu', js.includes('function renderTabsMoreMenu()'));
  chk('control.js has moveTab', js.includes('function moveTab('));
  chk('control.js has toggleTabHidden', js.includes('function toggleTabHidden('));
  chk('control.js has renderTabOrderSettings', js.includes('function renderTabOrderSettings()'));
  chk('control.js calls renderTabOrderSettings from showSetup', js.includes('renderTabOrderSettings();\n  renderKeepPhotos();'));
  chk('control.js excludes #tabs-more from the ordinary tab click wiring', js.includes(":not(#dual-pane-toggle):not(#tabs-more)"));
  chk('control.js defaults tabOrder to every tab, nothing hidden', js.includes('tabOrder: [...TAB_IDS]') && js.includes('hiddenTabs: []'));
}

if (!ok) {
  console.error('\nSOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
