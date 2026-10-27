// Why an upload failed, in words (assets/js/library-upload.js): every way one
// can fail says what happened and what to do, never just "that did not work".
//
//   node podium/test/library-upload.test.mjs

import { formatBytes, tooBigReason, uploadFailureReason, connectionFailureReason } from '../assets/js/library-upload.js';

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const MB = 1024 * 1024;
const LIMIT = 50 * MB;

ok('sizes read naturally', formatBytes(730 * 1024) === '730 KB' && formatBytes(4.25 * MB) === '4.3 MB' && formatBytes(212 * MB) === '212 MB');

const big = tooBigReason('lecture.mp4', 212 * MB, LIMIT);
ok(`too big, before sending: names the file, its size and the limit, and what to do ("${big}")`,
  /lecture\.mp4 is 212 MB/.test(big) && /up to 50 MB/.test(big) && /720p/.test(big));
ok('a file within the limit is not too big', tooBigReason('a.mp4', 10 * MB, LIMIT) === '' && tooBigReason('a.mp4', 999 * MB, 0) === '');

const proxy413 = uploadFailureReason({ status: 413, answer: {}, name: 'lecture.mp4', bytes: 40 * MB, limit: LIMIT });
ok(`a proxy's 413 (no JSON) points at the proxy ("${proxy413}")`, /proxy/.test(proxy413) && /40 MB/.test(proxy413));
ok('Podium’s own 413 says the sizes', /212 MB.*50 MB/.test(uploadFailureReason({ status: 413, answer: { error: 'that file is larger than the 50 MB limit' }, name: 'lecture.mp4', bytes: 212 * MB, limit: LIMIT })));
ok('signed out says to sign in again', /sign in again/.test(uploadFailureReason({ status: 401, answer: { error: 'sign in first' } })));
const mov = uploadFailureReason({ status: 415, answer: { error: 'Podium does not take mov files' }, name: 'IMG_0042.MOV' });
ok(`an iPhone .mov says how to get an .mp4 ("${mov}")`, /does not take mov/.test(mov) && /Most Compatible/.test(mov));
ok('the server’s own reason is passed on, as a sentence', uploadFailureReason({ status: 403, answer: { error: 'only an owner of PSY415 can add files' } }) === 'Only an owner of PSY415 can add files.');
ok('a gateway timeout on a big file says why', /took too long.*40 MB/.test(uploadFailureReason({ status: 504, answer: {}, name: 'clip.mp4', bytes: 40 * MB })));
ok('a restarting server says to wait', /restarting/.test(uploadFailureReason({ status: 502, answer: {} })));
ok('an unexplained server error says where the reason is', /Podium's log/.test(uploadFailureReason({ status: 500, answer: {} })));
const cut = connectionFailureReason({ name: 'lecture.mp4', bytes: 45 * MB, limit: LIMIT });
ok(`a cut connection on a big file names the likely causes ("${cut}")`, /cut off/.test(cut) && /proxy/.test(cut) && /45 MB/.test(cut));
ok('on a small one, to check the connection', /still online/.test(connectionFailureReason({ name: 'a.png', bytes: 20 * 1024 })));
ok('no reason is ever the old "that did not work"', ![big, proxy413, mov, cut, uploadFailureReason({ status: 418, answer: {} })].some((m) => /did not work/i.test(m)));

if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
