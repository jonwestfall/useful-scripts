// Backups you can open (server/backup.js), against a real SQLite file and
// real stored files: a course's library and lectures, one lecture with all
// its files, what a person may and may not take, and that the ZIP written
// holds exactly that.
//
//   node podium/test/backup.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning'); // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const courses = require('../server/courses.js');
const library = require('../server/library.js');
const plans = require('../server/plans.js');
const lectures = require('../server/lectures.js');
const backup = require('../server/backup.js');
const yauzl = require('../server/node_modules/yauzl');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-backup-'));
const contentDir = path.join(dataDir, 'site-content');
fs.mkdirSync(path.join(contentDir, 'handouts'), { recursive: true });
fs.writeFileSync(path.join(contentDir, 'handouts', 'reading.pdf'), '%PDF-1.4 a shared reading');
const db = store.open(dataDir);
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password', displayName: 'Owen O' });
const tia = await accounts.createUser(db, { username: 'tia', password: 'a good long password', displayName: 'Tia T' });
const sam = await accounts.createUser(db, { username: 'sam', password: 'a good long password' });
courses.create(db, admin, { code: 'psy415', title: 'Intro to Psychology' });
courses.create(db, admin, { code: 'psy300', title: 'Research Methods' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'tia', role: 'member' });
courses.addMember(db, admin, 'psy300', { username: 'sam', role: 'owner' });

async function upload(user, { course, kind, title, filename, body, group = '', props = {} }) {
  const { sha256, bytes } = await library.storeUpload(dataDir, Readable.from([Buffer.from(body)]));
  const mediaId = library.rememberMedia(db, user, { sha256, bytes, contentType: 'application/octet-stream' });
  return { ...library.addItem(db, user, { courseCode: course, kind, title, group, filename, mediaId, props }), sha256 };
}

const photo = await upload(owen, { course: 'psy415', kind: 'image', title: 'Brain', filename: 'brain.png', body: 'PNG brain bytes', group: 'Deck media' });
const deck = await upload(owen, { course: 'psy415', kind: 'deck', title: 'Week 3 — Memory', filename: 'week3.md', group: 'Decks',
  body: `---\nmarp: true\n---\n\n# Memory\n\n![bg right](/media/${photo.sha256}/brain.png)\n` });
await upload(owen, { course: 'psy415', kind: 'pdf', title: 'Syllabus', filename: 'syllabus.pdf', body: '%PDF-1.4 syllabus' });
const video = await upload(owen, { course: 'psy415', kind: 'video', title: 'Demo', filename: 'demo.mp4', body: 'not really a video', group: 'Video' });
library.addItem(db, owen, { courseCode: 'psy415', kind: 'web', title: 'Course site', props: { src: 'https://example.edu/psy415' } });
const secret = await upload(sam, { course: 'psy300', kind: 'pdf', title: 'Exam key', filename: 'key.pdf', body: '%PDF-1.4 answers' });
const loose = await upload(tia, { course: '', kind: 'pdf', title: 'Shared rubric', filename: 'rubric.pdf', body: '%PDF-1.4 rubric' });

const planDoc = (title, items) => ({ podium: 'plan', v: 1, title, items, assets: {}, timers: [] });
const week3 = plans.savePlan(db, owen, { title: 'Week 3', courseCode: 'psy415', doc: planDoc('Week 3', [
  { id: 'a', type: 'deck', title: 'Memory', src: `/media/deck/${deck.id}/week3.md` },
  { id: 'b', type: 'video', title: 'Demo', src: `/media/${video.sha256}/demo.mp4` },
  { id: 'c', type: 'pdf', title: 'Reading', src: 'content/handouts/reading.pdf' },
  { id: 'd', type: 'pdf', title: 'Their key', src: `/media/${secret.sha256}/key.pdf` },
]) });
plans.savePlan(db, owen, { title: 'Week 9 draft', doc: planDoc('Week 9 draft', [
  { id: 'a', type: 'pdf', title: 'Rubric', src: `/media/${loose.sha256}/rubric.pdf` },
]) });

const session = lectures.startLecture(db, owen, { room: 'r1', title: 'Week 3', dataDir });
db.prepare('UPDATE lectures SET course_id = (SELECT id FROM courses WHERE code = ?) WHERE id = ?').run('psy415', session.id);
const { sha256: inkSha, bytes: inkBytes } = await library.storeUpload(dataDir, Readable.from([Buffer.from('ink PNG')]));
lectures.addFile(db, owen, session.id, { name: 'ink/slide-2.png', kind: 'ink', sha256: inkSha, bytes: inkBytes, contentType: 'image/png', dataDir });

const ctx = { dataDir, contentDir };
const pathsOf = (found) => found.entries.map((e) => e.path.slice(found.root.length + 1));
const textOf = (found, end) => found.entries.find((e) => e.path.endsWith(end))?.data?.toString('utf8') || '';

console.log('-- one lecture, and all its files --');
{
  const found = backup.collect(db, owen, ctx, { plans: [week3.id] });
  const paths = pathsOf(found);
  ok(`it is the lecture's folder, under its course (${paths.join(' | ')})`,
    paths.includes('PSY415 — Intro to Psychology/Lectures/Week 3/week-3.podium.json'));
  ok('the plan file is the plan, as the planner opens it', JSON.parse(textOf(found, 'week-3.podium.json')).podium === 'plan');
  ok('with its deck, as a folder of the .md and its pictures',
    paths.includes('PSY415 — Intro to Psychology/Lectures/Week 3/files/Week 3 — Memory/week3.md')
    && paths.includes('PSY415 — Intro to Psychology/Lectures/Week 3/files/Week 3 — Memory/media/brain.png'));
  ok('the deck pointed at its pictures there, so it opens anywhere', /!\[bg right\]\(media\/brain\.png\)/.test(textOf(found, 'week3.md')));
  ok('its video', paths.includes('PSY415 — Intro to Psychology/Lectures/Week 3/files/demo.mp4'));
  ok('and a file from the site\'s content folder', paths.includes('PSY415 — Intro to Psychology/Lectures/Week 3/files/content/handouts/reading.pdf'));
  ok('but not another course\'s file it happens to point at - left out, and said',
    !paths.some((p) => p.endsWith('key.pdf')) && found.summary.skipped.some((s) => /key\.pdf/.test(s.what)));
  ok('a README and a manifest come with it', paths.includes('README.txt') && paths.includes('manifest.json'));
  const manifest = JSON.parse(textOf(found, 'manifest.json'));
  ok('the manifest says where each file the lecture uses went', manifest.plans[0].files.length === 3
    && manifest.plans[0].files.some((f) => f.ref === `/media/${video.sha256}/demo.mp4` && f.path.endsWith('files/demo.mp4')));
  ok('nothing was left out of the library section, because none was asked for', found.summary.items === 0 && found.summary.plans === 1);
}

console.log('\n-- a whole course --');
{
  const found = backup.collect(db, tia, ctx, { courses: ['psy415'], recorded: true });
  const paths = pathsOf(found);
  ok(`a member (a TA) can back up their course (${found.summary.items} items, ${found.summary.plans} lectures, ${found.summary.lectures} recorded)`,
    found.summary.items === 5 && found.summary.plans === 1 && found.summary.lectures === 1);
  ok('the library, in its groups', paths.includes('PSY415 — Intro to Psychology/Library/syllabus.pdf')
    && paths.includes('PSY415 — Intro to Psychology/Library/Video/demo.mp4')
    && paths.includes('PSY415 — Intro to Psychology/Library/Deck media/brain.png'));
  ok('a deck as its folder', paths.includes('PSY415 — Intro to Psychology/Library/Decks/Week 3 — Memory/week3.md'));
  ok('a link has no file, so it is listed beside them', /Course site/.test(textOf(found, 'Links and text items.json'))
    && /example\.edu/.test(textOf(found, 'Links and text items.json')));
  ok('the lecture does not hold a second copy of what Library has',
    !paths.includes('PSY415 — Intro to Psychology/Lectures/Week 3/files/demo.mp4')
    && /Library\/Video\/demo\.mp4/.test(textOf(found, 'Files used, elsewhere in this backup.txt')));
  ok('but still has what Library does not (a content-folder file)', paths.includes('PSY415 — Intro to Psychology/Lectures/Week 3/files/content/handouts/reading.pdf'));
  ok('the recorded lecture, with its record and files', paths.some((p) => /Recorded lectures\/\d{4}-\d\d-\d\d \d{4} Week 3\/record\.json$/.test(p))
    && paths.some((p) => /Recorded lectures\/.*\/ink\/slide-2\.png$/.test(p)));
  ok('none of another course\'s files', !paths.some((p) => /Research Methods|key\.pdf/.test(p)));
  ok('someone else\'s draft, filed under no course, is not in it', !paths.some((p) => /Week 9 draft/.test(p)));
  const sizes = found.entries.filter((e) => !/\/(README\.txt|manifest\.json)$/.test(e.path)).reduce((n, e) => n + e.bytes, 0);
  ok(`the size it reports is the sum of the files it holds (${found.summary.bytes} = ${sizes})`, found.summary.bytes === sizes);
}

console.log('\n-- who may take what --');
{
  ok('a course you are not in is refused, not quietly empty',
    backup.collect(db, tia, ctx, { courses: ['psy300'] }).summary.skipped.some((s) => s.what === 'PSY300'));
  ok('a file you cannot see, asked for by id, is left out', backup.collect(db, tia, ctx, { items: [secret.id] }).summary.items === 0);
  ok('a lecture you cannot see, asked for by id, is left out', backup.collect(db, sam, ctx, { plans: [week3.id] }).summary.plans === 0);
  ok('the whole server is for administrators only', status(() => backup.collect(db, owen, ctx, { everything: true })) === 403);
  const mine = backup.collect(db, owen, ctx, { mine: true });
  ok(`"everything of mine" is what I added and wrote (${mine.summary.items} items, ${mine.summary.plans} lectures)`,
    mine.summary.items === 5 && mine.summary.plans === 2);
  ok('my own draft goes under No course', pathsOf(mine).some((p) => p.startsWith('No course/Lectures/Week 9 draft/')));
  const all = backup.collect(db, admin, ctx, { everything: true, recorded: true });
  ok(`an administrator's whole-server backup has every course, item and lecture (${all.summary.items} items, ${all.summary.plans} lectures)`,
    all.summary.items === 7 && all.summary.plans === 2 && all.summary.lectures === 1
    && pathsOf(all).some((p) => p.startsWith('PSY300 — Research Methods/Library/')));
  ok('someone else\'s draft is filed under their name', pathsOf(all).some((p) => p.startsWith('No course/Lectures/owen/Week 9 draft/')));
}

console.log('\n-- the ZIP --');
{
  const found = backup.collect(db, owen, ctx, { courses: ['psy415'], recorded: true });
  const file = path.join(dataDir, 'out.zip');
  const out = fs.createWriteStream(file);
  const written = await backup.writeZip(out, found);
  await new Promise((resolve) => out.end(resolve));
  ok(`its size was known before it was written (${backup.zipSize(found)} = ${written})`, backup.zipSize(found) === written && fs.statSync(file).size === written);
  const names = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true }, (err, z) => {
    if (err) { reject(err); return; }
    const list = [];
    z.on('entry', (e) => { list.push(e.fileName); z.readEntry(); });
    z.on('end', () => resolve(list));
    z.readEntry();
  }));
  ok(`it opens, every file under one folder (${names.length} entries)`, names.length === found.entries.length && names.every((n) => n.startsWith(found.root + '/')));

  const ticket = backup.ticketFor(owen, { courses: ['psy415'] });
  ok('a download ticket is for the person who asked', JSON.stringify(backup.specForTicket(owen, ticket)) === JSON.stringify({ courses: ['psy415'] })
    && backup.specForTicket(tia, ticket) === null && backup.specForTicket(owen, 'made-up') === null);

  const stopped = new PassThrough({ highWaterMark: 16 });
  setTimeout(() => stopped.destroy(), 5);
  let err = null;
  try { await backup.writeZip(stopped, found); } catch (e) { err = e; }
  ok('a download stopped halfway stops the writing', !!err?.aborted);
}

fs.rmSync(dataDir, { recursive: true, force: true });
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log('\nALL PASS');
