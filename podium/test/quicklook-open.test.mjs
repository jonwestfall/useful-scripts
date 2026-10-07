// Quick Look's handover (Issue #242): how a page gives a new tab something to
// show on this device, with no server - by a one-use token, on a
// BroadcastChannel. Node has BroadcastChannel, so this runs against the real
// thing; only window.open is stood in for.
//
//   node podium/test/quicklook-open.test.mjs

const opened = [];
globalThis.window = { open: (url) => { opened.push(url); return null; } };

const { openQuickLook, canQuickLook } = await import('../assets/js/quicklook-open.js');

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};

// The tab's side: ask for a token, collect what comes back for a moment.
const tab = new BroadcastChannel('podium-quicklook');
const heard = [];
tab.addEventListener('message', (ev) => { if (ev.data?.token) heard.push(ev.data); });
const ask = async (token, ms = 80) => {
  heard.length = 0;
  tab.postMessage({ want: token });
  await new Promise((r) => setTimeout(r, ms));
  return heard.filter((m) => m.token === token);
};
const tokenOf = (url) => /#handoff=([0-9a-f]+)$/.exec(url)?.[1];

console.log('-- what can be looked at --');
chk('decks, PDFs, pictures, video, audio, web pages and text', ['deck', 'pdf', 'image', 'imagedeck', 'video', 'audio', 'web', 'slides', 'youtube', 'text'].every((type) => canQuickLook({ type })));
chk('not timers, polls, whiteboards, QR codes or streams', ['timer', 'poll', 'whiteboard', 'qr', 'stream', 'black'].every((type) => !canQuickLook({ type })));
chk('a set, when it has something that can be', canQuickLook({ type: 'set', entries: [{ item: { type: 'timer' } }, { item: { type: 'image' } }] })
  && !canQuickLook({ type: 'set', entries: [{ item: { type: 'timer' } }] }) && !canQuickLook(null));

console.log('-- a library file --');
openQuickLook({ libraryId: 12, item: { type: 'pdf', src: '/media/abc/x.pdf' } });
chk(`opens by its id, with nothing handed over (${opened.at(-1)})`, opened.at(-1) === 'quicklook.html?library=12');

console.log('-- handed over --');
const md = '# A deck kept in a plan\n';
openQuickLook({ item: { type: 'deck', title: 'Inside' }, source: md, from: 'From the lecture plan' });
const first = tokenOf(opened.at(-1));
chk(`opens a tab with a one-use token (${opened.at(-1)})`, /^quicklook\.html#handoff=[0-9a-f]{24}$/.test(opened.at(-1)));
const got = await ask(first);
chk('the tab that asks for it gets it', got.length === 1 && got[0].pkg.source === md && got[0].pkg.item.title === 'Inside');
chk('once: asking again gets nothing', (await ask(first)).length === 0);
chk('nor does a token nobody handed over', (await ask('0'.repeat(24))).length === 0);

let release;
openQuickLook(new Promise((resolve) => { release = resolve; }));
const slow = tokenOf(opened.at(-1));
chk('a tab opens at once, before what it shows is ready', !!slow);
const early = ask(slow, 200);
setTimeout(() => release({ item: { type: 'image', src: 'data:image/png;base64,AAAA' } }), 50);
chk('and gets it as soon as it is', (await early).some((m) => m.pkg.item?.type === 'image'));

openQuickLook(Promise.reject(new Error('that deck could not be read')));
const failed = await ask(tokenOf(opened.at(-1)));
chk('something that could not be gathered says why', failed.length === 1 && failed[0].pkg.error === 'that deck could not be read');

console.log('-- kept open (the deck editor\'s rehearsal) --');
const live = openQuickLook({ item: { type: 'deck' }, source: '# One\n' }, { live: true });
const liveToken = tokenOf(opened.at(-1));
chk('answers its tab', (await ask(liveToken))[0]?.pkg.source === '# One\n');
chk('and answers again - a reload of that tab', (await ask(liveToken))[0]?.pkg.source === '# One\n');
heard.length = 0;
live.update({ item: { type: 'deck' }, source: '# One\n\n---\n\n# Two\n' });
await new Promise((r) => setTimeout(r, 80));
chk('update() sends the new version, marked as one', heard.some((m) => m.token === liveToken && m.update && m.pkg.source.includes('# Two')));
chk('and a reload gets the newest', (await ask(liveToken))[0]?.pkg.source.includes('# Two'));
live.close();
chk('until it is closed', (await ask(liveToken)).length === 0);

tab.close();
if (!ok) process.exit(1);
console.log('all quicklook-open checks passed');
process.exit(0);
