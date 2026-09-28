// Run with: node podium/test/zip-staging.test.mjs
// A ZIP import end to end on the server: staged for review, committed into
// the planner library or the admin content folders, cancelled, and swept
// away when abandoned (Issue #106).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createZip } from '../assets/js/zip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const server = (name) => require(path.join(HERE, '..', 'server', name));
const store = server('store.js');
const accounts = server('accounts.js');
const courses = server('courses.js');
const library = server('library.js');
const staging = server('zip-staging.js');

let ok = true;
const chk = (label, cond) => {
  if (!cond) {
    ok = false;
    console.error('FAIL', label);
  } else {
    console.log('ok  ', label);
  }
};
const rejects = async (promise) => {
  try { await promise; return null; } catch (err) { return err; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-zipstage-'));
const dataDir = path.join(tmp, 'data');
const contentDir = path.join(tmp, 'content');
process.env.CONTENT_DIR = contentDir;
const db = store.open(dataDir);
const ctx = { db, dataDir };

const admin = await accounts.createUser(db, { username: 'admin', password: 'a long admin password', isAdmin: true });
const ta = await accounts.createUser(db, { username: 'ta', password: 'a long ta password' });
const outsider = await accounts.createUser(db, { username: 'outsider', password: 'a long outside password' });

// Tiny stand-ins: the server never decodes an image, only stores its bytes.
const png = (label) => `\x89PNG fake ${label}`;
const writeZip = async (name, entries) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, Buffer.from(await (await createZip(entries)).arrayBuffer()));
  return file;
};
const stageFile = (file, user, surface, extra = {}) => staging.stage({
  db, dataDir, user, surface, archiveName: path.basename(file), stream: fs.createReadStream(file),
  uploadMb: 200, contentDir, ...extra,
});
const jobDirs = () => { try { return fs.readdirSync(staging.stagingDir(dataDir)); } catch { return []; } };
const byTitle = (list, title) => list.find((i) => i.title === title);

try {
  console.log('-- staging a planner import --');
  const lecture = await writeZip('Lecture 3.zip', [
    { name: 'Week 3/Slide1.png', data: png('w3-1') },
    { name: 'Week 3/Slide2.png', data: png('w3-2') },
    { name: 'Week 3/Slide10.png', data: png('w3-10') },
    { name: 'intro.md', data: '# Intro' },
    { name: 'cover.jpg', data: png('cover') },
    // Issue #107: a real conversion is covered end to end, with a genuine
    // presentation, in pptx-convert.test.mjs - this fixture uses fake bytes
    // on purpose, to prove the surrounding pipeline (classification, then a
    // failed conversion during commit) behaves the same in any environment,
    // with or without LibreOffice actually installed to convert it.
    { name: 'Old/Lecture.pptx', data: 'pptx' },
    { name: 'Dup/Slide3.png', data: png('dup-a') },
    { name: 'Dup/Slide3.jpg', data: png('dup-b') },
  ]);
  const job = await stageFile(lecture, ta, 'planner');
  chk('staging answers with the proposal: a picture deck, a Marp deck, a photo and a PowerPoint file',
    ['deck:intro', 'imagedeck:Week 3', 'photo:cover', 'pdf:Lecture'].every((k) => job.items.some((i) => `${i.kind}:${i.title}` === k)));
  chk('a picture deck may be split into photos on the review screen', byTitle(job.items, 'Week 3').options.join() === 'imagedeck,photo');
  const dupEntry = job.needsInput.find((n) => n.suggestedKind === 'imagedeck');
  chk('an ambiguous deck waits for a decision, offering deck or photos', dupEntry && dupEntry.options.join() === 'imagedeck,photo');
  chk('the PowerPoint file is a normal candidate now, not a decision to make (Issue #107)', job.needsInput.every((n) => n.paths[0] !== 'Old/Lecture.pptx'));
  chk('nothing is marked as already in the library the first time', job.items.every((i) => !i.duplicate));
  chk('the staged upload is kept, unextracted: the archive and a job file',
    fs.readdirSync(path.join(staging.stagingDir(dataDir), job.id)).sort().join() === 'archive.zip,job.json');
  chk('and the reply says when it expires', job.expiresAt > Date.now());

  console.log('\n-- thumbnails --');
  const thumb = await staging.preview(dataDir, ta, job.id, 'Week 3/Slide1.png');
  chk('a slide image can be previewed from the staged archive', thumb.type === 'image/png' && thumb.body.toString('utf8') === png('w3-1'));
  chk('a file that is not a picture cannot', (await rejects(staging.preview(dataDir, ta, job.id, 'intro.md')))?.status === 404);
  chk('nor a name that is not in the import', (await rejects(staging.preview(dataDir, ta, job.id, '../../etc/passwd')))?.status === 404);
  chk("and somebody else's staged upload does not exist as far as they are concerned",
    (await rejects(staging.getJob(dataDir, outsider, job.id)))?.status === 404);

  console.log('\n-- committing into the library --');
  const result = await staging.commit(ctx, ta, job.id, {
    course: '',
    group: 'Week 3 materials',
    items: {
      [byTitle(job.items, 'Week 3').id]: { title: 'Memory, week 3' },
      [byTitle(job.items, 'cover').id]: { include: false },
    },
    needsInput: { [dupEntry.id]: { kind: 'photo' } },
  });
  chk(`imports the deck, the Marp deck and the two ambiguous images as photos (${result.imported.map((i) => i.title).join(', ')})`,
    result.imported.length === 4 && result.imported.some((i) => i.title === 'Memory, week 3'));
  chk('the left-out photo is reported, not silently dropped', result.skipped.some((s) => s.title === 'cover'));
  chk('nothing was left needing a decision - the PowerPoint file was a normal item, not one of those', result.unresolved === 0);
  chk('and it failed cleanly (fake bytes cannot really convert) rather than crashing the whole import or landing a broken item',
    result.failed.length === 1 && result.failed[0].title === 'Lecture' && result.failed[0].reason.length > 0);
  chk('the staged upload is gone once it is imported', !jobDirs().includes(job.id));

  const deck = result.imported.find((i) => i.kind === 'imagedeck').item;
  chk('the picture deck is one library item, filed under the chosen group', deck.type === 'imagedeck' && deck.group === 'Week 3 materials');
  chk('with its slides in numeric order, each a served media URL',
    deck.images.length === 3 && deck.images.every((u) => /^\/media\/[0-9a-f]{64}\//.test(u)) && /Slide10\.png$/.test(deck.images[2]));
  const slideSha = deck.images[0].split('/')[2];
  chk('its slides are readable by anyone who can see the item (no course: everyone)', library.mayReadMedia(db, outsider, slideSha));
  chk('and they count as in use, so nothing tidies them away', library.forgetMediaIfUnused(db, dataDir, slideSha) === false);
  chk('the Marp deck is an ordinary one-file item', result.imported.some((i) => i.kind === 'deck' && /\/media\/.+\/intro\.md$/.test(i.item.src)));
  chk('a used-up import cannot be committed twice', (await rejects(staging.commit(ctx, ta, job.id, {})))?.status === 404);

  console.log('\n-- the same ZIP again --');
  const again = await stageFile(lecture, ta, 'planner');
  chk('the review screen already knows the deck is in the library', byTitle(again.items, 'Week 3').duplicate?.title === 'Memory, week 3');
  chk('and the Marp deck', !!byTitle(again.items, 'intro').duplicate);
  chk('but not the photo that was left out last time', !byTitle(again.items, 'cover').duplicate);
  chk('nor the PowerPoint file - never hashed for this, since converted bytes are what would actually be compared',
    !byTitle(again.items, 'Lecture').duplicate);
  const second = await staging.commit(ctx, ta, again.id, {});
  chk('importing it skips what is already there, saying so', second.skipped.filter((s) => /Already in the library/.test(s.reason)).length === 2);
  chk('brings in only the new photo', second.imported.map((i) => i.title).join() === 'cover');
  chk('and the PowerPoint file fails the same way a second time, not silently skipped as if it were a duplicate',
    second.failed.some((f) => f.title === 'Lecture'));

  console.log('\n-- course scope --');
  courses.create(db, admin, { code: 'psy101', title: 'Intro Psych' });
  courses.addMember(db, admin, 'psy101', { username: 'ta', role: 'owner' });
  const privateZip = await writeZip('private.zip', [{ name: 'Priv/Slide1.png', data: png('p1') }, { name: 'Priv/Slide2.png', data: png('p2') }]);
  const privateJob = await stageFile(privateZip, ta, 'planner');
  chk('a course the uploader is not in is refused before anything is read',
    (await rejects(staging.commit(ctx, outsider, privateJob.id, { course: 'psy101' })))?.status === 404);
  const badCourse = await rejects(staging.commit(ctx, ta, privateJob.id, { course: 'nope' }));
  chk('a course that does not exist is refused', badCourse?.status === 400);
  chk('and the staged upload survives that, so the choice can be corrected', jobDirs().includes(privateJob.id));
  const scoped = await staging.commit(ctx, ta, privateJob.id, { course: 'psy101' });
  const scopedDeck = scoped.imported[0].item;
  chk('filed under the course', scopedDeck.course === 'psy101');
  chk("its slides are not readable by someone outside the course", !library.mayReadMedia(db, outsider, scopedDeck.images[0].split('/')[2]));

  console.log('\n-- an admin import into the content folders --');
  fs.mkdirSync(path.join(contentDir, 'photos'), { recursive: true });
  fs.writeFileSync(path.join(contentDir, 'photos', 'cat.jpg'), 'already here');
  const adminZip = await writeZip('Unit 2.zip', [
    { name: 'cat.jpg', data: png('new cat') },
    { name: 'Talk/index.html', data: '<link rel="stylesheet" href="css/style.css">' },
    { name: 'Talk/css/style.css', data: 'body{}' },
    { name: 'Deck/Slide1.png', data: png('d1') },
    { name: 'Deck/Slide2.png', data: png('d2') },
    { name: 'music.mp3', data: 'ID3' },
    // Same reasoning as the planner fixture above: fake bytes, on purpose,
    // to prove adminPlacement's naming and commitAdmin's failure handling
    // without needing LibreOffice installed to run this file at all.
    { name: 'Slides/Old talk.pptx', data: 'pptx' },
  ]);
  const adminJob = await stageFile(adminZip, admin, 'admin');
  const cat = byTitle(adminJob.items, 'cat');
  chk(`a name already taken is shown with its new suffix before import (${cat.target})`, cat.renamed && cat.target === 'content/photos/cat-2.jpg');
  chk('an exported web deck is one item, kept as a folder', byTitle(adminJob.items, 'Talk').kind === 'webdeck');
  chk('where the deck folder lives is not sent to the browser', adminJob.items.every((i) => !('root' in i)));
  const talkPptx = byTitle(adminJob.items, 'Old talk');
  chk(`a PowerPoint file already shows its real, converted target before import (${talkPptx.target})`,
    talkPptx.kind === 'pdf' && talkPptx.target === 'content/pdfs/Old talk.pdf' && !talkPptx.renamed);
  const adminResult = await staging.commit(ctx, admin, adminJob.id, { group: 'Unit 2' });
  chk('everything else is imported', adminResult.imported.length === 4);
  chk('and the PowerPoint file fails cleanly (fake bytes) rather than landing a broken file in content/pdfs/',
    adminResult.failed.length === 1 && adminResult.failed[0].title === 'Old talk'
    && !fs.existsSync(path.join(contentDir, 'pdfs', 'Old talk.pdf')));
  chk('the existing file is untouched', fs.readFileSync(path.join(contentDir, 'photos', 'cat.jpg'), 'utf8') === 'already here');
  chk('and the new one sits beside it with the suffix', fs.existsSync(path.join(contentDir, 'photos', 'cat-2.jpg')));
  chk("the web deck keeps its own layout, so its stylesheet link still works",
    fs.existsSync(path.join(contentDir, 'slides', 'Talk', 'index.html')) && fs.existsSync(path.join(contentDir, 'slides', 'Talk', 'css', 'style.css')));
  chk('the picture deck gets a folder of its own', fs.readdirSync(path.join(contentDir, 'slides', 'Deck')).sort().join() === 'Slide1.png,Slide2.png');
  chk('audio lands in the audio folder', fs.existsSync(path.join(contentDir, 'audio', 'music.mp3')));
  const manifest = JSON.parse(fs.readFileSync(path.join(contentDir, 'manifest.json'), 'utf8'));
  const deckEntry = manifest.items.find((i) => i.type === 'imagedeck');
  chk('each item is added to the Library manifest, under the chosen group',
    manifest.items.length === 4 && manifest.items.every((i) => i.group === 'Unit 2'));
  chk('the picture deck entry lists its slides in order', deckEntry.images.join() === 'content/slides/Deck/Slide1.png,content/slides/Deck/Slide2.png');
  chk('the web deck entry opens its index page', manifest.items.some((i) => i.type === 'slides' && i.src === 'content/slides/Talk/index.html'));

  const secondAdmin = await stageFile(adminZip, admin, 'admin');
  const noManifest = await staging.commit(ctx, admin, secondAdmin.id, { addToLibrary: false });
  chk('importing the same ZIP again numbers every clash rather than overwriting',
    noManifest.imported.map((i) => i.target).sort().join()
      === 'content/audio/music-2.mp3,content/photos/cat-3.jpg,content/slides/Deck-2/,content/slides/Talk-2/');
  chk('and "add to the Library" can be turned off',
    JSON.parse(fs.readFileSync(path.join(contentDir, 'manifest.json'), 'utf8')).items.length === 4);

  console.log('\n-- cancelling, limits and the sweep --');
  const toCancel = await stageFile(privateZip, ta, 'planner');
  await staging.cancel(dataDir, ta, toCancel.id);
  chk('cancelling removes the staged upload', !jobDirs().includes(toCancel.id));
  chk('after which it cannot be imported', (await rejects(staging.commit(ctx, ta, toCancel.id, {})))?.status === 404);

  const big = await writeZip('big.zip', [{ name: 'huge.pdf', data: new Uint8Array(1024 * 1024 + 10) }]);
  const tooBig = await rejects(stageFile(big, ta, 'planner', { uploadMb: 1 }));
  chk(`an upload over the admin setting is refused (${tooBig?.message})`, tooBig?.status === 413);
  const notZip = path.join(tmp, 'not.zip');
  fs.writeFileSync(notZip, 'plain text, not an archive');
  chk('a file that is not a ZIP is refused', (await rejects(stageFile(notZip, ta, 'planner')))?.status === 400);
  chk('and neither leaves anything behind in staging', jobDirs().length === 0);

  const kept = [];
  for (let i = 0; i < staging.MAX_JOBS_PER_USER + 1; i++) kept.push((await stageFile(privateZip, ta, 'planner')).id);
  chk(`one person keeps at most ${staging.MAX_JOBS_PER_USER} staged uploads; the oldest goes first`,
    jobDirs().length === staging.MAX_JOBS_PER_USER && !jobDirs().includes(kept[0]));
  const other = await stageFile(privateZip, admin, 'planner');
  chk("and another person's upload does not push theirs out", jobDirs().length === staging.MAX_JOBS_PER_USER + 1);

  const later = Date.now() + staging.STAGING_TTL_MS + 1000;
  const expired = await rejects(staging.getJob(dataDir, admin, other.id, later));
  chk('an abandoned upload past its time is answered as expired, and removed',
    expired?.status === 410 && !jobDirs().includes(other.id));
  const swept = await staging.sweep(dataDir, { now: later });
  chk(`the sweep removes every other abandoned upload (${swept})`, swept === staging.MAX_JOBS_PER_USER && jobDirs().length === 0);
} finally {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
process.exit(ok ? 0 : 1);
