// Screen video kept with a lecture (Issue #132, phase 3), against a real
// SQLite file: refused until an administrator turns it on, served as video
// rather than audio, held to its own per-lecture budget - which never eats
// into the space photos, ink and audio have - and advertised to displays.
//
//   node podium/test/screen-video.test.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning'); // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const lectures = require('../server/lectures.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };

const db = store.open(mkdtempSync(path.join(tmpdir(), 'podium-screen-video-')));
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password' });
const lecture = lectures.startLecture(db, owen, { room: 'r1', resume: false });
const MB = 1024 * 1024;
let n = 0;
const file = (name, bytes) => lectures.addFile(db, owen, lecture.id, {
  name, kind: name.startsWith('video/') ? 'video' : 'audio', sha256: (++n).toString(16).padStart(64, '0'), bytes, contentType: lectures.keepableType(name),
});
const seg = (i) => `video/screen-ab-1790000000000-${String(i).padStart(4, '0')}-t1790000000000-d30000.webm`;

console.log('-- off by default --');
ok(`the setting starts off, with a default budget (${JSON.stringify(lectures.screenVideo(db))})`, lectures.screenVideo(db).enabled === false && lectures.screenVideo(db).mb === 1000);
ok('a screen segment is refused while it is off', status(() => file(seg(0), 4 * MB)) === 403);

console.log('\n-- on --');
lectures.setScreenVideo(db, { enabled: true, mb: 50 });
ok('an administrator turns it on and sets the budget', lectures.screenVideo(db).enabled && lectures.screenVideo(db).mb === 50);
ok('a budget outside 50-8000 MB is refused', status(() => lectures.setScreenVideo(db, { mb: 10 })) === 400 && status(() => lectures.setScreenVideo(db, { mb: 9001 })) === 400);
ok(`a screen segment is served as video, not audio (${lectures.keepableType(seg(0))})`, lectures.keepableType(seg(0)) === 'video/webm'
  && lectures.keepableType('audio/mic-1790000000000-0000.webm') === 'audio/webm');
file(seg(0), 15 * MB);
file(seg(1), 15 * MB);
file(seg(2), 15 * MB);
const kept = lectures.listFiles(db, lecture.id);
ok(`segments are kept as kind "video" (${kept.map((f) => f.kind)})`, kept.length === 3 && kept.every((f) => f.kind === 'video'));
ok('past the budget, the next one is refused with 413', status(() => file(seg(3), 15 * MB)) === 413);
ok('and the same file again (a retry) still fits, since it replaces itself', status(() => file(seg(2), 15 * MB)) === 200);
ok('the video budget never eats into the space for audio, photos and ink', status(() => file('audio/mic-1790000000000-0000-t1790000000000-d120000.webm', 15 * MB)) === 200);
ok('a "video" kind on anything else is not taken at its word', lectures.addFile(db, owen, lecture.id, {
  name: 'photos/p1-x.jpg', kind: 'video', sha256: 'f'.repeat(64), bytes: 10, contentType: 'image/jpeg',
}) && lectures.listFiles(db, lecture.id).find((f) => f.name === 'photos/p1-x.jpg').kind === 'session');
const ended = lectures.endLecture(db, owen, lecture.id, {});
ok('a lecture that recorded only the screen and a mic is kept when it ends, not thrown away as empty',
  !ended.discarded && lectures.listFiles(db, lecture.id).length === 5);
const empty = lectures.startLecture(db, owen, { room: 'r2', resume: false });
ok('one that recorded nothing at all still is', lectures.endLecture(db, owen, empty.id, {}).discarded === true);
lectures.setScreenVideo(db, { enabled: false });
ok('turned off again, new segments are refused', status(() => file(seg(9), MB)) === 403);
// (the lecture above has ended; a late segment from a display still finishing
// its last one is filed all the same, while screen video is on)

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
