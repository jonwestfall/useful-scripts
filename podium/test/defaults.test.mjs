// Run with: node podium/test/defaults.test.mjs
// Issue #173: saved controller defaults. Every default is opt-in, and the
// commands a set of defaults turns into follow a few rules: the mixer only
// when it is switched on, Pause Queue only when it is set, and the watermark
// only when the presenter has not already put up one of their own - never
// again after a plan loads.
import { normalizeDefaults, defaultCommands, watermarkDefaultReady, loadDefaults, DEFAULTS_KEY, defaultsDelta, changedDefaultCommands } from '../assets/js/defaults.js';
import { initialState, applyCommand } from '../assets/js/protocol.js';

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};
const assetRef = (id) => `asset:${id}`;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

console.log('-- nothing set means nothing happens --');
{
  const d = normalizeDefaults(null);
  chk('music switches start unset', d.music.autoplay === null && d.music.pauseQueue === null && d.music.untilQueue === null);
  chk('mixer and watermark start off', !d.mixer.enabled && !d.watermark.enabled);
  chk('no commands from empty defaults', defaultCommands(d, {}, { assetRef }).length === 0);
  chk('garbage in storage is treated as nothing', JSON.stringify(normalizeDefaults('nope')) === JSON.stringify(d));
  const store = { getItem: (k) => (k === DEFAULTS_KEY ? '{bad json' : null) };
  chk('unreadable storage loads as empty defaults', loadDefaults(store).mixer.enabled === false);
}

console.log('-- normalizing what was stored --');
{
  const d = normalizeDefaults({
    music: { autoplay: 'yes', pauseQueue: true, untilQueue: false, countdownText: 'x'.repeat(200) },
    mixer: { enabled: 1, master: 3, content: -1, music: 'abc', mic: 0.25 },
    watermark: { enabled: true, text: 'PSY 415', position: 'middle', imageId: 'wmdef-1', imageData: 'javascript:alert(1)' },
  });
  chk('a non-boolean switch is unset, not truthy', d.music.autoplay === null);
  chk('booleans survive', d.music.pauseQueue === true && d.music.untilQueue === false);
  chk('countdown text is capped', d.music.countdownText.length === 80);
  chk('levels are clamped to 0..1', d.mixer.master === 1 && d.mixer.content === 0 && d.mixer.mic === 0.25);
  chk('an unreadable level falls back to the usual default', d.mixer.music === 0.6);
  chk('an unknown corner becomes bottom right', d.watermark.position === 'br');
  chk('a logo that is not an image data URL is dropped, with its id', d.watermark.imageData === '' && d.watermark.imageId === '');
}

console.log('-- mixer and pause queue --');
{
  const d = normalizeDefaults({ music: { pauseQueue: false }, mixer: { enabled: true, master: 0.5, content: 0.9, music: 0.3, mic: 0.7 } });
  const cmds = defaultCommands(d, {}, { assetRef });
  chk('pause queue is sent when set, even to false', cmds.some((c) => c.op === 'music' && c.action === 'pauseQueue' && c.value === false));
  chk('master', cmds.some((c) => c.op === 'volume' && c.value === 0.5));
  chk('content', cmds.some((c) => c.op === 'contentVolume' && c.value === 0.9));
  chk('music', cmds.some((c) => c.op === 'music' && c.action === 'volume' && c.value === 0.3));
  chk('mics', cmds.some((c) => c.op === 'micVolume' && c.value === 0.7));
  chk('mixer levels are re-applied after a plan, winning over its music level',
    defaultCommands(d, {}, { assetRef, afterPlan: true }).some((c) => c.op === 'music' && c.action === 'volume' && c.value === 0.3));
  const off = normalizeDefaults({ mixer: { enabled: false, master: 0.1 } });
  chk('a mixer default that is switched off sends nothing', defaultCommands(off, {}, { assetRef }).length === 0);
}

console.log('-- the watermark --');
{
  const d = normalizeDefaults({ watermark: { enabled: true, text: 'PSY 415', position: 'tl', imageId: 'wmdef-abc', imageData: PNG } });
  chk('ready when switched on with something to show', watermarkDefaultReady(d));
  chk('not ready when switched on with nothing to show', !watermarkDefaultReady(normalizeDefaults({ watermark: { enabled: true } })));

  const onBlank = defaultCommands(d, { watermark: { enabled: false, text: '', image: '' } }, { assetRef });
  const wm = onBlank.find((c) => c.op === 'watermark');
  chk('goes up on a room with no watermark', !!wm && wm.enabled === true);
  chk('with its text, corner and logo reference', wm.text === 'PSY 415' && wm.position === 'tl' && wm.image === 'asset:wmdef-abc');

  chk('replaces a course default', defaultCommands(d, { watermark: { enabled: true, text: 'Course', fromCourse: true } }, { assetRef })
    .some((c) => c.op === 'watermark'));
  chk('never replaces one the presenter already set', !defaultCommands(d, { watermark: { enabled: true, text: 'Mine', fromCourse: false } }, { assetRef })
    .some((c) => c.op === 'watermark'));
  chk('a hidden one of the presenter’s own is no obstacle', defaultCommands(d, { watermark: { enabled: false, text: 'Mine', fromCourse: false } }, { assetRef })
    .some((c) => c.op === 'watermark'));
  chk('not re-applied after a plan loads', !defaultCommands(d, { watermark: { enabled: false } }, { assetRef, afterPlan: true })
    .some((c) => c.op === 'watermark'));

  const textOnly = normalizeDefaults({ watermark: { enabled: true, text: 'Only text' } });
  const t = defaultCommands(textOnly, { watermark: { enabled: true, image: 'asset:course', fromCourse: true } }, { assetRef })
    .find((c) => c.op === 'watermark');
  chk('a text-only default clears a course logo rather than sitting under it', t && t.image === '' && t.text === 'Only text');
}

console.log('-- a watermark a default put up is not the presenter\'s own (#178) --');
{
  const d = normalizeDefaults({ watermark: { enabled: true, text: 'Dr. New' } });
  const cmd = defaultCommands(d, {}, { assetRef }).find((c) => c.op === 'watermark');
  chk('the command says it came from a default', cmd?.fromDefault === true);
  const state = initialState();
  applyCommand(state, cmd);
  chk('and the room remembers that', state.watermark.fromDefault === true && state.watermark.text === 'Dr. New');
  // Next week, the default says something else: the display kept last week's.
  const changed = normalizeDefaults({ watermark: { enabled: true, text: 'Dr. Newer' } });
  const again = defaultCommands(changed, state, { assetRef }).find((c) => c.op === 'watermark');
  chk('so a changed default replaces it', again?.text === 'Dr. Newer');
  applyCommand(state, { op: 'watermark', text: 'Typed on the Say tab', enabled: true });
  chk('one typed on the Say tab is the presenter\'s own again', state.watermark.fromDefault === false);
  chk('and a default leaves that alone', !defaultCommands(changed, state, { assetRef }).some((c) => c.op === 'watermark'));
  applyCommand(state, { op: 'watermark', position: 'tl' });
  chk('moving it does not change whose it is', state.watermark.fromDefault === false);
  chk('a fresh room starts with nobody\'s default', initialState().watermark.fromDefault === false);
}

console.log('-- what changed in Settings, applied when it closes (#178) --');
{
  const before = normalizeDefaults(null);
  chk('nothing changed is nothing to do', !defaultsDelta(before, normalizeDefaults(null)).any
    && changedDefaultCommands(before, before, {}, { assetRef }).length === 0);

  const wmOn = normalizeDefaults({ watermark: { enabled: true, text: 'Dr. Default' } });
  const delta = defaultsDelta(before, wmOn);
  chk('a new watermark default is a watermark change and nothing else',
    delta.any && delta.watermark && !delta.mixer && !delta.autoplay && !delta.caption);
  const up = changedDefaultCommands(before, wmOn, { watermark: { enabled: false, text: '' } }, { assetRef });
  chk('it goes up when Settings closes', up.length === 1 && up[0].op === 'watermark' && up[0].text === 'Dr. Default' && up[0].fromDefault);
  chk('but not over the presenter\'s own', changedDefaultCommands(before, wmOn,
    { watermark: { enabled: true, text: 'Mine' } }, { assetRef }).length === 0);

  const wmOff = normalizeDefaults({ watermark: { enabled: false, text: 'Dr. Default' } });
  const down = changedDefaultCommands(wmOn, wmOff, { watermark: { enabled: true, text: 'Dr. Default', fromDefault: true } }, { assetRef });
  chk('turning it off takes down the one it put up', down.length === 1 && down[0].op === 'watermark' && down[0].enabled === false);
  chk('and never the presenter\'s own', changedDefaultCommands(wmOn, wmOff,
    { watermark: { enabled: true, text: 'Mine' } }, { assetRef }).length === 0);

  const autoplay = normalizeDefaults({ music: { autoplay: true } });
  const ad = defaultsDelta(before, autoplay);
  chk('Auto-play is a change of its own', ad.autoplay && !ad.pauseQueue);
  chk('and sends nothing to the room - it is this device\'s own switch',
    changedDefaultCommands(before, autoplay, {}, { assetRef }).length === 0);

  const pq = changedDefaultCommands(before, normalizeDefaults({ music: { pauseQueue: true } }), {}, { assetRef });
  chk('a changed Pause Queue is sent', pq.length === 1 && pq[0].action === 'pauseQueue' && pq[0].value === true);
  chk('one set back to "as is" sends nothing', changedDefaultCommands(normalizeDefaults({ music: { pauseQueue: true } }), before, {}, { assetRef }).length === 0);

  const mixed = normalizeDefaults({ music: { pauseQueue: true }, mixer: { enabled: true, master: 0.5 } });
  const only = changedDefaultCommands(mixed, { ...mixed, mixer: { ...mixed.mixer, master: 0.3 } }, {}, { assetRef });
  chk('changing a mixer level resends the mixer and not the untouched Pause Queue',
    only.some((c) => c.op === 'volume' && c.value === 0.3) && !only.some((c) => c.action === 'pauseQueue'));
  chk('switching the mixer default off leaves the room alone',
    changedDefaultCommands(mixed, { ...mixed, mixer: { ...mixed.mixer, enabled: false } }, {}, { assetRef }).length === 0);
  chk('a big logo is still seen as a change', defaultsDelta(before,
    { watermark: { enabled: true, imageId: 'wmdef-x', imageData: `data:image/png;base64,${'A'.repeat(300000)}` } }).watermark);
}

if (!ok) process.exit(1);
console.log('all defaults checks passed');
