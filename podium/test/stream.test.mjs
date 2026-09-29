// Run with: node podium/test/stream.test.mjs
// Issue #175: live streams. Every link shape a presenter might paste becomes
// the same few fields, a stream is switched between video and sound, video
// only and sound only on the live player (never restaged), and the planner,
// the paste-a-link box and a library manifest tile all land in the same place.
import { parseStreamSource, streamLabel, initialState, applyCommand, STREAM_SHOWS } from '../assets/js/protocol.js';
import { guessItemFromUrl } from '../assets/js/util.js';
import { PLAN_TYPES, itemForStage, readPlan, PLAN_VERSION } from '../assets/js/planfile.js';

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('-- reading a stream out of a link --');
chk('twitch.tv/<channel>', same(parseStreamSource('https://www.twitch.tv/NASA'), { platform: 'twitch', channel: 'nasa' }));
chk('twitch without a scheme, with a query', same(parseStreamSource('twitch.tv/some_channel?sr=a'), { platform: 'twitch', channel: 'some_channel' }));
chk('a Twitch popout link', same(parseStreamSource('https://www.twitch.tv/popout/nasa/chat'), { platform: 'twitch', channel: 'nasa' }));
chk('a Twitch player link', same(parseStreamSource('https://player.twitch.tv/?channel=nasa&parent=x'), { platform: 'twitch', channel: 'nasa' }));
chk('a Twitch site page is not a channel', parseStreamSource('https://www.twitch.tv/directory') === null);
chk('youtube.com/live/<id>', same(parseStreamSource('https://www.youtube.com/live/abcdefghijk?si=x'), { platform: 'youtube', videoId: 'abcdefghijk' }));
chk('a YouTube watch link', same(parseStreamSource('https://youtube.com/watch?v=abcdefghijk&t=3'), { platform: 'youtube', videoId: 'abcdefghijk' }));
chk('youtu.be', same(parseStreamSource('https://youtu.be/abcdefghijk'), { platform: 'youtube', videoId: 'abcdefghijk' }));
const UC = 'UC' + 'x'.repeat(22);
chk('a YouTube channel page', same(parseStreamSource(`https://www.youtube.com/channel/${UC}/live`), { platform: 'youtube', channel: UC }));
chk('a bare channel id', same(parseStreamSource(UC), { platform: 'youtube', channel: UC }));
chk('a bare name is a Twitch channel', same(parseStreamSource('Some_Channel'), { platform: 'twitch', channel: 'some_channel' }));
chk('a bare 11-char id is YouTube when that is the platform', same(parseStreamSource('abcdefghijk', 'youtube'), { platform: 'youtube', videoId: 'abcdefghijk' }));
chk('a YouTube @handle cannot be embedded, so it is refused', parseStreamSource('https://www.youtube.com/@nasa/live') === null);
chk('nonsense is refused', parseStreamSource('not a stream!!') === null && parseStreamSource('') === null);
chk('labels', streamLabel({ platform: 'twitch', channel: 'nasa' }) === 'twitch.tv/nasa' && streamLabel({ platform: 'youtube' }) === 'YouTube Live');

console.log('-- the paste-a-link box --');
{
  const t = guessItemFromUrl('https://www.twitch.tv/nasa');
  chk('a Twitch link becomes a stream', t?.type === 'stream' && t.platform === 'twitch' && t.channel === 'nasa' && t.show === 'both');
  const live = guessItemFromUrl('https://www.youtube.com/live/abcdefghijk');
  chk('a YouTube /live/ link becomes a stream', live?.type === 'stream' && live.videoId === 'abcdefghijk');
  chk('an ordinary YouTube watch link stays a YouTube video', guessItemFromUrl('https://www.youtube.com/watch?v=abcdefghijk')?.type === 'youtube');
  chk('a YouTube @handle live page is left as a web page, not a broken stream', guessItemFromUrl('https://www.youtube.com/@nasa/live')?.type === 'web');
}

console.log('-- staging normalizes, from any source --');
{
  const s = initialState();
  applyCommand(s, { op: 'stage', item: { type: 'stream', url: 'https://twitch.tv/NASA', show: 'audio' } });
  chk('a planner item with a url', s.program.platform === 'twitch' && s.program.channel === 'nasa' && s.program.show === 'audio');
  chk('the raw link is not carried on', s.program.url === undefined && s.program.src === undefined);
  chk('it starts playing, like any media', s.program.playing === true);
  chk('and gets a title', s.program.title === 'twitch.tv/nasa');

  applyCommand(s, { op: 'stage', item: { type: 'stream', title: 'Launch', src: 'https://youtube.com/live/abcdefghijk', show: 'sideways' } });
  chk('a manifest tile with a src', s.program.platform === 'youtube' && s.program.videoId === 'abcdefghijk' && s.program.title === 'Launch');
  chk('an unknown show falls back to both', s.program.show === 'both');

  const before = s.program;
  chk('an unreadable stream is refused, not staged broken', applyCommand(s, { op: 'stage', item: { type: 'stream', url: 'nope nope' } }) === false && s.program === before);
  const already = { type: 'stream', platform: 'twitch', channel: 'nasa', show: 'video' };
  applyCommand(s, { op: 'stage', item: already });
  chk('already-split fields survive a restage', s.program.channel === 'nasa' && s.program.show === 'video');
}

console.log('-- switching what the room gets, without restaging --');
{
  const s = initialState();
  applyCommand(s, { op: 'stage', item: { type: 'stream', url: 'twitch.tv/nasa' } });
  const key = s.program.key;
  for (const show of STREAM_SHOWS) {
    applyCommand(s, { op: 'media', action: 'show', value: show });
    chk(`show -> ${show}`, s.program.show === show && s.program.key === key);
  }
  chk('an unknown show is refused', applyCommand(s, { op: 'media', action: 'show', value: 'loud' }) === false);
  applyCommand(s, { op: 'media', action: 'pause' });
  chk('pause works like any media', s.program.playing === false);
  applyCommand(s, { op: 'stage', item: { type: 'video', src: 'x.mp4' } });
  chk('show means nothing to a plain video', applyCommand(s, { op: 'media', action: 'show', value: 'audio' }) === false);
}

console.log('-- the planner --');
{
  chk('Live stream is a plannable type', !!PLAN_TYPES.stream && PLAN_TYPES.stream.fields.some((f) => f.key === 'url'));
  const { plan } = readPlan(JSON.stringify({
    podium: 'plan', v: PLAN_VERSION, title: 'Streams',
    items: [{ type: 'stream', url: 'https://twitch.tv/nasa', show: 'audio' }, { type: 'stream', url: 'https://twitch.tv/nasa', show: 'bogus' }],
  }));
  chk('a plan keeps its stream items', plan.items.length === 2 && plan.items[0].url === 'https://twitch.tv/nasa');
  chk('with a valid show, and a bad one reset', plan.items[0].show === 'audio' && plan.items[1].show === 'both');
  const s = initialState();
  applyCommand(s, { op: 'stage', item: itemForStage(plan.items[0]) });
  chk('and a planned stream stages as one', s.program.type === 'stream' && s.program.channel === 'nasa' && s.program.show === 'audio');
}

if (!ok) process.exit(1);
console.log('all stream checks passed');
