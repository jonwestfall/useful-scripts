// Run with:  node podium/test/plan.test.mjs
// The lecture-plan document: what a plan is, and what reading an untrusted one
// does with the parts that are wrong. No DOM, no network.
import {
  emptyPlan, newItem, readPlan, planToJson, pruneAssets, referencedAssets,
  itemLabel, itemForStage, assetRef, assetIdOf, isAssetRef, PLAN_TYPES, PLAN_VERSION,
} from '../assets/js/planfile.js';

let ok = true;
const chk = (label, cond) => { if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label); };

// --- the shape ---------------------------------------------------------------
const plan = emptyPlan('Day 6');
chk('a new plan is empty but complete', plan.podium === 'plan' && plan.v === PLAN_VERSION
  && plan.items.length === 0 && plan.timers.length === 0 && plan.layout === 'single');

chk('every plannable type can be instantiated', Object.keys(PLAN_TYPES).every((t) => newItem(t).type === t));
chk('a new item arrives with its type’s defaults filled in', newItem('text').size === 'l' && newItem('text').align === 'center');
chk('an unknown type is refused rather than half-built', (() => {
  try { newItem('hologram'); return false; } catch { return true; }
})());

// --- labels: a row in the running order should never read as blank -----------
chk('a titled item uses its title', itemLabel({ type: 'image', title: 'Stroop' }) === 'Stroop');
chk('an untitled text sign shows its first line', itemLabel({ type: 'text', body: '**Group work**\nnext line' }) === 'Group work');
chk('an untitled countdown shows the length of the timer it points at',
  itemLabel({ type: 'timer', timerId: 'tb' }, { timers: [{ id: 'ta', label: 'A', mins: 3 }, { id: 'tb', label: 'Discuss', mins: 8 }] }) === '8 min — Discuss');
chk('and falls back to its own label where there is no plan to look in (the controller)',
  itemLabel({ type: 'timer', label: 'Discuss' }) === 'Discuss');
chk('a countdown with nothing at all still reads as one', itemLabel({ type: 'timer' }) === 'Countdown');
chk('an untitled path item shows the file name', itemLabel({ type: 'pdf', src: 'content/handouts/ch4.pdf' }) === 'ch4.pdf');
chk('an asset-backed item falls back to its type rather than printing base64',
  itemLabel({ type: 'image', src: assetRef('abc') }) === 'Photo');

// --- what goes on the wire ---------------------------------------------------
const staged = itemForStage({ id: 'row1', type: 'text', title: 'Hi', body: 'x', note: 'remember the demo' });
chk('the prep note and row id stay in the office', !('note' in staged) && !('id' in staged));
chk('everything the display needs survives', staged.type === 'text' && staged.body === 'x' && staged.title === 'Hi');

// --- assets ------------------------------------------------------------------
chk('asset refs round-trip', isAssetRef(assetRef('q1')) && assetIdOf(assetRef('q1')) === 'q1');
chk('a path is not an asset ref', !isAssetRef('content/img/a.png') && assetIdOf('content/img/a.png') === null);

const withAssets = {
  ...emptyPlan('assets'),
  items: [
    { id: 'r1', type: 'image', src: assetRef('keep'), fit: 'contain' },
    { id: 'r2', type: 'deck', asset: 'alsokeep', src: '' },
  ],
  assets: {
    keep: { name: 'a.jpg', mime: 'image/jpeg', data: 'data:image/jpeg;base64,AAA' },
    alsokeep: { name: 'd.md', mime: 'text/markdown', data: '# hi' },
    orphan: { name: 'gone.jpg', mime: 'image/jpeg', data: 'data:image/jpeg;base64,BBB' },
  },
};
chk('both asset-carrying field shapes are found', referencedAssets(withAssets).has('keep') && referencedAssets(withAssets).has('alsokeep'));
chk('an asset no item references is dropped on save', Object.keys(pruneAssets(withAssets).assets).sort().join() === 'alsokeep,keep');
chk('and pruning does not touch the items', pruneAssets(withAssets).items.length === 2);

// --- reading a plan from outside this device ---------------------------------
const round = readPlan(planToJson(withAssets));
chk('a plan survives a round trip through the file', round.warnings.length === 0 && round.plan.items.length === 2
  && round.plan.assets.keep.data === 'data:image/jpeg;base64,AAA');

const refuse = (input, why) => {
  try { readPlan(input); return false; } catch (err) { return new RegExp(why, 'i').test(err.message); }
};
chk('a file that is not JSON is refused by name', refuse('not json at all', 'not even JSON'));
chk('JSON that is not a plan is refused', refuse('{"hello":1}', 'not a Podium lecture plan'));
chk('an array is refused rather than treated as items', refuse('[]', 'not a lecture plan'));
chk('a plan from a newer Podium says so, and says to update this device',
  refuse(JSON.stringify({ podium: 'plan', v: PLAN_VERSION + 1 }), 'newer Podium'));

// A plan ten minutes before class should load its good rows even if some are
// bad - dropping the lecture because one item is broken is the wrong trade.
const messy = readPlan(JSON.stringify({
  podium: 'plan', v: 1, title: 'Messy',
  items: [
    { type: 'text', body: 'fine', size: 'nonsense' },
    { type: 'hologram', title: 'from the future' },
    { type: 'image', src: assetRef('missing') },
    { type: 'pdf', src: 'x.pdf', page: 999999 },
  ],
  timers: [{ label: 'ok', mins: 10 }, { label: 'bad', mins: 0 }],
  assets: { missing: { name: 'x', mime: 'image/png' } },
}));
chk('the good rows load', messy.plan.items.length === 3);
chk('an out-of-range select falls back to its default instead of reaching the projector',
  messy.plan.items[0].size === 'l');
chk('an absurd number is clamped, not passed through', messy.plan.items[2].page === 9999);
chk('an unknown type is dropped and named', messy.warnings.some((w) => /hologram/.test(w)));
chk('an item pointing at a file the plan does not carry is called out, not left to fail on the projector',
  messy.warnings.some((w) => /does not contain/.test(w)) && messy.plan.items[1].src === '');
chk('an asset with no data is dropped', !('missing' in messy.plan.assets));
chk('a timer with no length is dropped, and the real one kept',
  messy.plan.timers.length === 1 && messy.plan.timers[0].mins === 10);
chk('every loaded item has an id, so the editor can address it',
  messy.plan.items.every((i) => typeof i.id === 'string' && i.id.length > 0));

// Fields belonging to some other type must not ride along: the display would
// take `playing` or `fit` on a text sign at face value.
const smuggled = readPlan(JSON.stringify({
  podium: 'plan', v: 1,
  items: [{ type: 'text', body: 'hi', fit: 'cover', src: 'javascript:alert(1)', playing: true }],
}));
chk('fields that do not belong to the type are not carried through',
  !('fit' in smuggled.plan.items[0]) && !('src' in smuggled.plan.items[0]) && !('playing' in smuggled.plan.items[0]));

// A plan is a file that came from somewhere else, and its src values end up in
// an <img> or an <iframe> on a screen nobody is standing in front of.
const schemes = readPlan(JSON.stringify({
  podium: 'plan', v: 1,
  items: [
    { type: 'web', src: 'javascript:alert(document.cookie)' },
    { type: 'image', src: 'data:text/html,<script>x</script>' },
    { type: 'web', src: 'https://example.edu/demo' },
    { type: 'pdf', src: 'content/handouts/ch4.pdf', page: 2 },
    { type: 'image', src: assetRef('ok') },
  ],
  assets: { ok: { name: 'a.jpg', mime: 'image/jpeg', data: 'data:image/jpeg;base64,AAA' } },
}));
chk('a javascript: src is stripped, not carried to the projector', schemes.plan.items[0].src === '');
chk('and so is a data: URL smuggled in as an image', schemes.plan.items[1].src === '');
chk('the rejection names the scheme rather than silently blanking the item',
  schemes.warnings.filter((w) => /only http, https/.test(w)).length === 2);
chk('https is kept', schemes.plan.items[2].src === 'https://example.edu/demo');
chk('a relative path on your own server is kept', schemes.plan.items[3].src === 'content/handouts/ch4.pdf');
chk('and the plan\u2019s own asset references are kept', schemes.plan.items[4].src === assetRef('ok'));

// Countdown items name one of the lecture's timers, so a plan that points at a
// timer it does not define would put somebody else's clock on the wall.
const clocks = readPlan(JSON.stringify({
  podium: 'plan', v: 1,
  timers: [{ id: 'grp', label: 'Group work', mins: 8 }],
  items: [
    { type: 'timer', timerId: 'grp' },
    { type: 'timer', timerId: 'nope' },
    { type: 'timer' },
  ],
}));
chk('a countdown pointing at a timer the plan defines keeps it', clocks.plan.items[0].timerId === 'grp');
chk('one pointing at a timer that does not exist falls back to the first, and says so',
  clocks.plan.items[1].timerId === '' && clocks.warnings.some((w) => /does not define/.test(w)));
chk('and one naming none is left alone - that already means the first',
  clocks.plan.items[2].timerId === '');
chk('a lecture cannot define more timers than the display can hold',
  readPlan(JSON.stringify({
    podium: 'plan', v: 1,
    timers: [1, 2, 3, 4, 5, 6].map((n) => ({ id: `t${n}`, label: `T${n}`, mins: n })),
  })).plan.timers.length === 4);

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
