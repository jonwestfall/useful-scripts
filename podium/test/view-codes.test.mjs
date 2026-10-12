// Typed Guest View codes (Issue #150): stable across lectures, answering only
// while the display is live, never pointing anywhere but a view room, and
// not walkable by one address guessing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createViewCodes, cleanLink, CODE_LENGTH, LIVE_MS, MAX_MISSES_PER_WINDOW } = require('../server/view-codes.js');

const LINK = 't=ws&r=view.Abc123xyz9&p=viewkey&wu=wss%3A%2F%2Fpodium.example.com%2Fpodium';

function clockedCodes() {
  let t = 1_000_000;
  const codes = createViewCodes({ now: () => t });
  return { codes, advance: (ms) => { t += ms; } };
}

test('a code is six unambiguous characters and looks up to the link it was given', () => {
  const { codes } = clockedCodes();
  const made = codes.register({ link: LINK });
  assert.match(made.code, new RegExp(`^[A-HJ-NP-Z2-9]{${CODE_LENGTH}}$`));
  assert.ok(made.token.length > 20);
  assert.equal(codes.lookup(made.code, '1.1.1.1').link, LINK);
  assert.equal(codes.lookup(made.code.toLowerCase(), '1.1.1.1').link, LINK, 'typed in lower case still works');
});

test('only a viewer link can be registered - never one that opens the real room', () => {
  assert.equal(cleanLink('t=ws&r=psy415&p=room-passphrase'), null);
  assert.equal(cleanLink('t=ws&r=view.Abc123xyz9'), null, 'no key');
  assert.equal(cleanLink('t=carrier-pigeon&r=view.Abc123xyz9&p=k'), null);
  assert.equal(cleanLink(`#${LINK}`), LINK, 'a leading # is fine');
  const { codes } = clockedCodes();
  assert.equal(codes.register({ link: 't=ws&r=psy415&p=x' }).status, 400);
});

test('a code answers only while its display keeps it alive, and not after stand-down', () => {
  const { codes, advance } = clockedCodes();
  const { code, token } = codes.register({ link: LINK });
  advance(LIVE_MS - 1000);
  assert.ok(codes.touch(code, token), 'a live display keeps it');
  advance(LIVE_MS - 1000);
  assert.equal(codes.lookup(code, '2.2.2.2').link, LINK);
  advance(LIVE_MS + 1);
  assert.equal(codes.lookup(code, '2.2.2.2').status, 404, 'a display that went quiet');

  const again = codes.register({ link: LINK });
  assert.ok(codes.release(again.code, again.token));
  assert.equal(codes.lookup(again.code, '2.2.2.2').status, 404, 'stood down');
});

test('the display gets the same code back next lecture, and keeps it across a reload', () => {
  const { codes, advance } = clockedCodes();
  const first = codes.register({ link: LINK });
  codes.release(first.code, first.token);
  advance(24 * 60 * 60 * 1000);
  const next = codes.register({ want: first.code, link: LINK });
  assert.equal(next.code, first.code, 'the code on the syllabus still works next week');
  const reloaded = codes.register({ want: next.code, token: next.token, link: LINK });
  assert.equal(reloaded.code, next.code);
  assert.equal(reloaded.token, next.token, 'same holder, same token');
});

test('nobody else can take over, keep alive or release a code they do not hold', () => {
  const { codes } = clockedCodes();
  const mine = codes.register({ link: LINK });
  const theirs = codes.register({ want: mine.code, link: 't=ws&r=view.SomeoneElse1&p=k' });
  assert.notEqual(theirs.code, mine.code, 'asking for a held code gets a different one');
  assert.equal(codes.lookup(mine.code, '3.3.3.3').link, LINK, 'and the original still points where it did');
  assert.equal(codes.touch(mine.code, 'wrong-token'), false);
  assert.equal(codes.release(mine.code, 'wrong-token'), false);
  assert.equal(codes.lookup(mine.code, '3.3.3.3').link, LINK);
});

test('guessing is rate-limited per address, and every kind of miss counts the same', () => {
  const { codes, advance } = clockedCodes();
  const { code, token } = codes.register({ link: LINK });
  const ip = '4.4.4.4';
  for (let i = 0; i < MAX_MISSES_PER_WINDOW; i++) {
    const wrong = i % 2 ? 'ZZZZZZ' : 'bad';
    assert.equal(codes.lookup(wrong, ip).status, 404, 'unknown and malformed look alike');
  }
  assert.equal(codes.lookup(code, ip).status, 429, 'even the right code is refused once throttled');
  assert.equal(codes.lookup(code, '5.5.5.5').link, LINK, 'another address is unaffected');
  // A live display keeps its code alive the whole time; the throttle is
  // what runs out.
  advance(2 * 60 * 1000); codes.touch(code, token);
  advance(2 * 60 * 1000); codes.touch(code, token);
  advance(60 * 1000 + 1); codes.touch(code, token);
  assert.equal(codes.lookup(code, ip).link, LINK, 'and the window passes');
});

// --- a viewer link planned in advance (assets/js/view-link.js) ---------------

const { viewCodeForKey: serverViewCode, linkCodeForKey } = require('../server/view-codes.js');
const viewLink = await import('../assets/js/view-link.js');
const pollLink = await import('../assets/js/poll-link.js');
const { readPlan, emptyPlan, planToJson, withoutPollLinks } = await import('../assets/js/planfile.js');

test('a planned link\'s code is worked out the same way here as in the browser, and differs from a poll\'s', () => {
  for (let i = 0; i < 20; i++) {
    const key = viewLink.newViewLinkKey();
    const code = viewLink.viewCodeForKey(key);
    assert.match(code, /^[A-HJ-NP-Z2-9]{10}$/);
    assert.equal(serverViewCode(key), code);
    assert.notEqual(pollLink.pollCodeForKey(key), code, 'one key never opens a poll and a viewer link alike');
    assert.equal(linkCodeForKey('podium-poll-link', key), pollLink.pollCodeForKey(key));
  }
  assert.equal(viewLink.viewCodeForKey('short'), '');
  assert.equal(viewLink.viewLinkUrl('https://podium.example.com/', 'x'), '');
  const key = viewLink.newViewLinkKey();
  assert.equal(viewLink.viewLinkUrl('https://podium.example.com/', key), `https://podium.example.com/view.html?c=${viewLink.viewCodeForKey(key)}`);
});

test('a planned code is claimed with its key, answers only while live, and an early visitor is told to wait', () => {
  const { codes, advance } = clockedCodes();
  const key = viewLink.newViewLinkKey();
  const code = viewLink.viewCodeForKey(key);
  const early = codes.lookup(code, '3.3.3.3');
  assert.equal(early.status, 404);
  assert.equal(early.waiting, true);
  const made = codes.register({ key, link: LINK });
  assert.equal(made.code, code);
  assert.equal(codes.lookup(viewLink.formatViewCode(code).toLowerCase(), '3.3.3.3').link, LINK, 'typed as shown, any case');
  assert.equal(codes.touch(code, made.token), true);
  assert.equal(codes.release(code, made.token), true);
  assert.equal(codes.lookup(code, '3.3.3.3').waiting, true);
  const again = codes.register({ key, link: LINK });
  advance(LIVE_MS + 1000);
  assert.equal(codes.lookup(code, '3.3.3.3').waiting, true, 'not touched: gone again');
  assert.equal(codes.touch(code, again.token), false);
  assert.equal(codes.register({ key: 'not a key', link: LINK }).status, 400);
});

test('waiting on a planned code never locks the visitor out, but walking six-character codes still does', () => {
  const { codes } = clockedCodes();
  const key = viewLink.newViewLinkKey();
  for (let i = 0; i < MAX_MISSES_PER_WINDOW * 3; i++) assert.equal(codes.lookup(viewLink.viewCodeForKey(key), '4.4.4.4').status, 404);
  codes.register({ key, link: LINK });
  assert.equal(codes.lookup(viewLink.viewCodeForKey(key), '4.4.4.4').link, LINK);
});

test('the key is the proof: a display that lost its token takes its planned code back, a stranger with only the code cannot', () => {
  const { codes } = clockedCodes();
  const key = viewLink.newViewLinkKey();
  const first = codes.register({ key, link: LINK });
  const other = 't=ws&r=view.Other123xyz&p=k2';
  const second = codes.register({ key, link: other });
  assert.notEqual(second.token, first.token);
  assert.equal(codes.lookup(first.code, '5.5.5.5').link, other);
  assert.equal(codes.touch(first.code, first.token), false, 'the old token is out');
  // Knowing the code (everyone with the handout does) is not a way in.
  const stranger = codes.register({ want: first.code, link: 't=ws&r=view.Evil1234567&p=k3' });
  assert.notEqual(stranger.code, first.code);
  assert.equal(codes.lookup(first.code, '5.5.5.5').link, other);
});

test('a lecture plan keeps its viewer link key, and drops anything that is not one', () => {
  const plan = emptyPlan('Week 3');
  assert.equal(plan.viewLink, '');
  plan.viewLink = viewLink.newViewLinkKey();
  assert.equal(readPlan(planToJson(plan)).plan.viewLink, plan.viewLink);
  assert.equal(readPlan(planToJson({ ...plan, viewLink: '<script>' })).plan.viewLink, '');
  assert.equal(readPlan(JSON.stringify({ podium: 'plan', v: 1, title: 'Old', items: [] })).plan.viewLink, '');
  assert.equal(withoutPollLinks(readPlan(planToJson(plan)).plan).viewLink, '', 'a copy of the lecture gets a link of its own');
});
