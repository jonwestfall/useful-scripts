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
