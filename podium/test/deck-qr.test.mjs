// QR codes in decks (assets/js/deck-qr.js): what a ```qr block says, the
// markdown the deck editor's Link button puts in, and the code drawn for it.
//
//   node podium/test/deck-qr.test.mjs

import { createRequire } from 'node:module';
import { parseQrBlock, qrFence, linkMarkdown, followable, qrSvgFor, QR_SIZES, DEFAULT_QR_SIZE } from '../assets/js/deck-qr.js';

const require = createRequire(import.meta.url);
const qrcode = require('../assets/vendor/qrcode.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

ok('a block\'s first line is what the code holds', parseQrBlock('https://example.edu/a\n').data === 'https://example.edu/a');
ok('with medium the size when it says none', parseQrBlock('https://x.edu').size === DEFAULT_QR_SIZE && DEFAULT_QR_SIZE === 'medium');
ok('size: large is read', parseQrBlock('https://x.edu\nsize: large').size === 'large');
ok('in any case, and before the link too', parseQrBlock('  Size:SMALL \n https://x.edu ').size === 'small' && parseQrBlock('size: small\nhttps://x.edu').data === 'https://x.edu');
ok('a size that is not one is left as data rather than guessed at', parseQrBlock('https://x.edu\nsize: huge').size === 'medium');
ok('an empty block holds nothing', parseQrBlock('\n\n').data === '');
ok('every size is a slide width in pixels', Object.values(QR_SIZES).every((n) => n > 100 && n < 720));

ok('the fence for a link at the default size', qrFence('https://x.edu') === '```qr\nhttps://x.edu\n```\n');
ok('and at another size', qrFence('https://x.edu', 'large') === '```qr\nhttps://x.edu\nsize: large\n```\n');
ok('a line break cannot split the fence', qrFence('https://x.edu\n```\nboo').split('\n').filter((l) => l.startsWith('```')).length === 2);
ok('round trip', parseQrBlock(qrFence('https://x.edu/a?b=1', 'small').replace(/```(qr)?/g, '')).data === 'https://x.edu/a?b=1');

ok('the Link button: named link, then its code',
  linkMarkdown({ url: 'https://example.edu/survey', label: 'Course survey' }) === '[Course survey](https://example.edu/survey)\n\n```qr\nhttps://example.edu/survey\n```\n');
ok('no name: the address itself, as an autolink',
  linkMarkdown({ url: 'https://example.edu/s', qr: false }) === '<https://example.edu/s>\n');
ok('the code alone', linkMarkdown({ url: 'https://example.edu/s', text: false, size: 'large' }) === '```qr\nhttps://example.edu/s\nsize: large\n```\n');
ok('brackets in a name cannot break the link', linkMarkdown({ url: 'https://x.edu', label: 'a [b] c', qr: false }) === '[a  b  c](https://x.edu)\n');
ok('a space or bracket in an address cannot end it early', linkMarkdown({ url: 'https://x.edu/a b(c)', label: 'x', qr: false }) === '[x](https://x.edu/a%20b%28c%29)\n');
ok('no address, nothing', linkMarkdown({ url: '  ' }) === '');

ok('http, https and mailto can be followed', ['http://a.b', 'https://a.b', 'mailto:a@b.c'].every((u) => followable(u) === u));
ok('anything else is a code only, never a link', ['javascript:alert(1)', 'data:text/html,x', 'WIFI:S:x;;', 'plain words'].every((u) => followable(u) === ''));

const svg = qrSvgFor(qrcode, 'https://example.edu/survey');
ok('the code is drawn as an SVG on white', /^<svg\b/.test(svg) && /fill="white"/.test(svg));
let tooLong = false;
try { qrSvgFor(qrcode, 'x'.repeat(5000)); } catch { tooLong = true; }
ok('and something too long for any QR code is refused, not drawn wrong', tooLong);

if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
