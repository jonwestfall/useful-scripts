// Admin › Storage (server/space.js), against a real SQLite file and real
// stored files: where the disk went, taking back what nothing uses, and
// removing a course's files at the end of a term - without touching a file
// another course still has.
//
//   node podium/test/space.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning'); // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const courses = require('../server/courses.js');
const library = require('../server/library.js');
const plans = require('../server/plans.js');
const lectures = require('../server/lectures.js');
const space = require('../server/space.js');
const backup = require('../server/backup.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-space-'));
const db = store.open(dataDir);
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password', displayName: 'Owen O' });
courses.create(db, admin, { code: 'fall25', title: 'Fall 2025' });
courses.create(db, admin, { code: 'spr26', title: 'Spring 2026' });
courses.addMember(db, admin, 'fall25', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'spr26', { username: 'owen', role: 'owner' });

const KB = 1024;
async function upload(course, title, size, fill = title) {
  const body = Buffer.alloc(size, fill);
  const { sha256, bytes } = await library.storeUpload(dataDir, Readable.from([body]));
  const mediaId = library.rememberMedia(db, owen, { sha256, bytes, contentType: 'application/pdf' });
  return { ...library.addItem(db, owen, { courseCode: course, kind: 'pdf', title, filename: `${title}.pdf`, mediaId }), sha256 };
}
// Every file is a different size, so each figure below says which files it counted.
const oldOnly = await upload('fall25', 'old', 10 * KB);
const shared = await upload('fall25', 'shared', 20 * KB);
await upload('spr26', 'shared', 20 * KB);                // the same bytes, in the next term too
await upload('spr26', 'new', 40 * KB);
const gone = await upload('spr26', 'gone', 80 * KB);
library.deleteItem(db, owen, gone.id);
plans.savePlan(db, owen, { title: 'Fall week 1', courseCode: 'fall25', doc: { podium: 'plan', v: 1, title: 'Fall week 1', items: [] } });
const session = lectures.startLecture(db, owen, { room: 'r1', title: 'Fall week 1', dataDir });
db.prepare('UPDATE lectures SET course_id = (SELECT id FROM courses WHERE code = ?) WHERE id = ?').run('fall25', session.id);
const photo = await library.storeUpload(dataDir, Readable.from([Buffer.alloc(160 * KB, 'p')]));
lectures.addFile(db, owen, session.id, { name: 'photo-1.jpg', kind: 'photo', sha256: photo.sha256, bytes: photo.bytes, contentType: 'image/jpeg', dataDir });
// A file the database never knew about, from long ago.
const stray = path.join(dataDir, 'media', 'ff', 'f'.repeat(64));
fs.mkdirSync(path.dirname(stray), { recursive: true });
fs.writeFileSync(stray, Buffer.alloc(320 * KB));
fs.utimesSync(stray, new Date(Date.now() - 2 * 86400000), new Date(Date.now() - 2 * 86400000));

console.log('-- where the disk went --');
const r = space.report(db, { dataDir });
ok(`library files, each stored once (${r.kinds.library.files} files, ${r.kinds.library.bytes / KB} KB)`, r.kinds.library.files === 3 && r.kinds.library.bytes === 70 * KB);
ok(`recorded lecture files (${r.kinds.sessions.bytes / KB} KB)`, r.kinds.sessions.files === 1 && r.kinds.sessions.bytes === 160 * KB);
ok(`deleted from the library but still on disk (${r.kinds.deleted.bytes / KB} KB)`, r.kinds.deleted.files === 1 && r.kinds.deleted.bytes === 80 * KB);
ok(`on disk with nothing pointing at it (${r.kinds.unused.bytes / KB} KB)`, r.kinds.unused.files === 1 && r.kinds.unused.bytes === 320 * KB);
ok(`what can be taken back is those two together (${r.reclaimable.bytes / KB} KB)`, r.reclaimable.bytes === 400 * KB);
const fall = r.courses.find((c) => c.code === 'fall25');
const spring = r.courses.find((c) => c.code === 'spr26');
ok(`a course: its library, lectures and recorded lectures (${JSON.stringify({ lib: fall.libraryBytes / KB, sess: fall.sessionBytes / KB, items: fall.items, plans: fall.plans, lectures: fall.lectures })})`,
  fall.libraryBytes === 30 * KB && fall.sessionBytes === 160 * KB && fall.items === 2 && fall.plans === 1 && fall.lectures === 1);
ok(`and what removing it would free: not the file the next term shares (${fall.freesBytes / KB} KB, ${fall.sharedBytes / KB} KB shared)`,
  fall.freesBytes === 170 * KB && fall.sharedBytes === 20 * KB);
ok('the busiest course comes first', r.courses[0].code === 'fall25' && !!spring && typeof fall.lastUsed === 'number');
ok(`people, by what they have on the server (${r.people.map((p) => `${p.username}:${p.bytes / KB}KB`).join(', ')})`,
  r.people[0].username === 'owen' && r.people[0].bytes === 230 * KB && r.people[0].items === 4);
ok('the database and the disk are in it', r.database > 0 && r.disk.ok === true);

console.log('\n-- tidying --');
const tidied = space.tidy(db, dataDir);
ok(`it takes back what nothing uses (${tidied.files} files, ${tidied.bytes / KB} KB)`, tidied.bytes === 400 * KB && tidied.items === 1);
ok('the deleted item is gone for good, and its file', !db.prepare('SELECT 1 FROM library_items WHERE id = ?').get(gone.id)
  && !fs.existsSync(library.mediaPath(dataDir, gone.sha256)));
ok('and the stray file', !fs.existsSync(stray));
ok('nothing in use was touched', space.report(db, { dataDir }).kinds.library.bytes === 70 * KB);
const fresh = await library.storeUpload(dataDir, Readable.from([Buffer.from('an upload in flight')]));
library.rememberMedia(db, owen, { sha256: fresh.sha256, bytes: fresh.bytes, contentType: 'application/pdf' });
space.tidy(db, dataDir);
ok('a file stored a moment ago, not filed yet, is left alone', fs.existsSync(library.mediaPath(dataDir, fresh.sha256)));

console.log('\n-- removing a term --');
ok('only an administrator may', status(() => space.remove(db, owen, dataDir, { courses: ['fall25'] })) === 403);
ok('a course that is not there is refused', status(() => space.remove(db, admin, dataDir, { courses: ['nope'] })) === 404);
ok('the route wants a backup first, and knows when there has been one', !backup.backedUp(admin, ['fall25'], { recorded: true }));
backup.noteBackedUp(admin, { courses: ['fall25'] });
ok('one without recorded lectures does not cover removing them', !backup.backedUp(admin, ['fall25'], { recorded: true })
  && backup.backedUp(admin, ['fall25']));
backup.noteBackedUp(admin, { everything: true, recorded: true });
ok('a whole-server backup covers any course, No course too', backup.backedUp(admin, ['fall25', 'spr26', ''], { recorded: true }));
ok('and is only for the person who took it', !backup.backedUp(owen, ['fall25']));
const removed = space.remove(db, admin, dataDir, { courses: ['fall25'], archive: true });
ok(`it removes the course's files, lectures and recorded lectures (${JSON.stringify(removed)})`,
  removed.items === 2 && removed.plans === 1 && removed.lectures === 1 && removed.archived[0] === 'fall25');
ok(`and frees what only it used (${removed.bytes / KB} KB)`, removed.bytes === 170 * KB
  && !fs.existsSync(library.mediaPath(dataDir, oldOnly.sha256)) && !fs.existsSync(library.mediaPath(dataDir, photo.sha256)));
ok('the file the next term shares is still there, and still listed', fs.existsSync(library.mediaPath(dataDir, shared.sha256))
  && library.listItems(db, admin).some((i) => i.course === 'spr26' && i.title === 'shared'));
ok('the course is archived, not deleted', !!db.prepare("SELECT archived_at FROM courses WHERE code = 'fall25'").get().archived_at);
ok('the other course is as it was', space.report(db, { dataDir }).courses.find((c) => c.code === 'spr26').items === 2);
const keepPlans = space.remove(db, admin, dataDir, { courses: ['spr26'], library: false, recorded: false });
ok('removing only some of it removes only that', keepPlans.items === 0 && library.listItems(db, admin).filter((i) => i.course === 'spr26').length === 2);

fs.rmSync(dataDir, { recursive: true, force: true });
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log('\nALL PASS');
