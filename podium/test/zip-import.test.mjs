// Run with: node podium/test/zip-import.test.mjs
// Inspecting a ZIP before import: what each file is taken to be, and the
// limits that stop a hostile archive (Issue #106).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createZip } from '../assets/js/zip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const zip = require(path.join(HERE, '..', 'server', 'zip-import.js'));
const store = require(path.join(HERE, '..', 'server', 'store.js'));

let ok = true;
const chk = (label, cond) => {
  if (!cond) {
    ok = false;
    console.error('FAIL', label);
  } else {
    console.log('ok  ', label);
  }
};

const f = (p, size = 1000) => ({ path: p, size });
const kinds = (r) => r.items.map((i) => `${i.kind}:${i.title}`).sort();

console.log('-- picture decks --');
{
  const r = zip.classifyEntries([
    f('Week 1/Slide1.PNG'), f('Week 1/Slide2.PNG'), f('Week 1/Slide10.PNG'), f('Week 1/Slide3.PNG'),
  ], { surface: 'admin' });
  chk('a folder of SlideN images is one picture deck, named for the folder', kinds(r).join() === 'imagedeck:Week 1');
  chk('in numeric order, so Slide10 comes after Slide3',
    r.items[0].files.join() === 'Week 1/Slide1.PNG,Week 1/Slide2.PNG,Week 1/Slide3.PNG,Week 1/Slide10.PNG');
}
{
  const r = zip.classifyEntries([f('Lec/Slide1.jpg'), f('Lec/Slide2.jpg')], { surface: 'planner' });
  chk('two numbered images are enough for a deck', kinds(r).join() === 'imagedeck:Lec');
}
{
  const r = zip.classifyEntries([f('Lec/Slide1.jpg'), f('Lec/cover.jpg')], { surface: 'planner' });
  chk('a lone numbered image is a photo, not a one-slide deck', kinds(r).join() === 'photo:Slide1,photo:cover');
}
{
  const r = zip.classifyEntries([f('Talk/Talk.001.png'), f('Talk/Talk.002.png'), f('Talk/Talk.003.png')], { surface: 'admin' });
  chk("Keynote's Name.NNN export groups the same way", kinds(r).join() === 'imagedeck:Talk');
}
{
  const r = zip.classifyEntries([
    f('Semester/Week 1/Slide1.png'), f('Semester/Week 1/Slide2.png'),
    f('Semester/Week 2/Slide1.png'), f('Semester/Week 2/Slide2.png'), f('Semester/Week 2/Slide3.png'),
  ], { surface: 'admin' });
  chk('each slide folder in one ZIP becomes its own deck', kinds(r).join() === 'imagedeck:Week 1,imagedeck:Week 2');
}
{
  const r = zip.classifyEntries([f('Mixed/a1.png'), f('Mixed/a2.png'), f('Mixed/b1.png'), f('Mixed/b2.png')], { surface: 'admin' });
  chk('two numbered sequences in one folder are two decks, told apart by prefix', kinds(r).join() === 'imagedeck:Mixed - a,imagedeck:Mixed - b');
}
{
  const r = zip.classifyEntries([f('Deck/Slide1.png'), f('Deck/Slide2.png'), f('Deck/Slide2.jpg')], { surface: 'admin' });
  chk('a repeated slide number is not guessed at - it needs a decision', r.items.length === 0 && r.needsInput.length === 1);
  chk('and says why', /more than once/.test(r.needsInput[0].reason) && r.needsInput[0].suggestedKind === 'imagedeck');
}
{
  const r = zip.classifyEntries([f('Slide1.png'), f('Slide2.png')], { surface: 'admin', archiveName: 'Chapter 4.zip' });
  chk('a deck at the top of the ZIP is named for the ZIP', kinds(r).join() === 'imagedeck:Chapter 4');
}

console.log('\n-- one file, one item --');
{
  const r = zip.classifyEntries([
    f('decks/intro.md'), f('music/walk_in.mp3'), f('handout.pdf'), f('clip.mp4'), f('photo.jpg'),
  ], { surface: 'planner' });
  chk('deck, audio, PDF, video and photo are each their own item',
    kinds(r).join() === 'audio:walk in,deck:intro,pdf:handout,photo:photo,video:clip');
}

console.log('\n-- what each destination will and will not take --');
{
  const admin = zip.classifyEntries([f('a.svg'), f('b.mov'), f('c.flac')], { surface: 'admin' });
  const planner = zip.classifyEntries([f('a.svg'), f('b.mov'), f('c.flac')], { surface: 'planner' });
  chk('the admin content tree takes SVG, MOV and FLAC, as its own uploads do', admin.items.length === 3);
  chk('the planner library does not, as its own uploads do not', planner.items.length === 0);
  chk('and an SVG it refuses is said out loud, not silently dropped', planner.skipped.some((s) => s.path === 'a.svg'));
}
{
  const big = zip.classifyEntries([f('huge.pdf', 30 * 1024 * 1024)], { surface: 'admin' });
  chk("a file over its category's own size limit is skipped with the limit named",
    big.items.length === 0 && /25 MB/.test(big.skipped[0]?.reason || ''));
}

console.log('\n-- HTML, presentations, nested ZIPs, junk --');
{
  const files = [f('site/index.html'), f('site/css/deck.css'), f('site/fonts/x.woff2'), f('site/img/a.png'), f('notes.md')];
  const admin = zip.classifyEntries(files, { surface: 'admin' });
  const planner = zip.classifyEntries(files, { surface: 'planner' });
  const web = admin.items.find((i) => i.kind === 'webdeck');
  chk('for an admin, a folder with index.html is one web deck', web?.title === 'site');
  chk('with its stylesheets and fonts, which alone would have been nothing', web?.files.length === 4);
  chk('and the rest of the ZIP is still sorted normally', admin.items.some((i) => i.kind === 'deck'));
  chk('from the planner, HTML needs a decision and never becomes an item',
    !planner.items.some((i) => i.kind === 'webdeck') && planner.needsInput.some((n) => n.paths.includes('site/index.html')));
  chk('with a reason that says to ask an administrator', /administrator/.test(planner.needsInput[0].reason));
}
{
  const r = zip.classifyEntries([f('Lecture 3.pptx')], { surface: 'admin' });
  chk('a PowerPoint file needs a decision, with what to do instead', r.needsInput.length === 1 && /PDF/.test(r.needsInput[0].reason));
}
{
  const r = zip.classifyEntries([f('more.zip')], { surface: 'admin' });
  chk('a ZIP inside the ZIP is skipped, not opened', r.skipped.length === 1 && /on its own/.test(r.skipped[0].reason));
}
{
  const r = zip.classifyEntries([{ path: 'secret.pdf', size: 10, encrypted: true }], { surface: 'admin' });
  chk('a password-protected file is skipped and says so', r.skipped.length === 1 && /password/.test(r.skipped[0].reason));
}
{
  const r = zip.classifyEntries([
    f('__MACOSX/Week 1/._Slide1.png'), f('Week 1/.DS_Store'), f('Thumbs.db'), f('~$Lecture.pptx'), f('notes.xyz'), f('folder/'),
  ], { surface: 'admin' });
  chk('OS droppings, lock files and unknown types are quietly ignored, not rows to review',
    r.items.length === 0 && r.needsInput.length === 0 && r.skipped.length === 0 && r.ignored === 5);
}

console.log('\n-- reading a real archive --');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-zip-'));
const writeZip = async (name, entries) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, Buffer.from(await (await createZip(entries)).arrayBuffer()));
  return file;
};
try {
  const good = await writeZip('good.zip', [
    { name: 'Week 1/Slide1.png', data: 'x' }, { name: 'Week 1/Slide2.png', data: 'y' }, { name: 'intro.md', data: '# Hi' },
  ]);
  const r = await zip.inspectZip(good, { surface: 'admin' });
  chk('a real ZIP is read and sorted without extracting it', kinds(r).join() === 'deck:intro,imagedeck:Week 1');
  chk('and nothing was written next to it', fs.readdirSync(tmp).join() === 'good.zip');

  const limits = { ...zip.limitsFor(), maxFiles: 3, maxDepth: 2, maxUnpackedBytes: 50 };
  const tooMany = await writeZip('many.zip', ['a', 'b', 'c', 'd'].map((n) => ({ name: `${n}.md`, data: '#' })));
  const deep = await writeZip('deep.zip', [{ name: 'a/b/c/deep.md', data: '#' }]);
  const bomb = await writeZip('bomb.zip', [{ name: 'big.md', data: 'x'.repeat(80) }]);
  const reject = async (file, lim) => zip.inspectZip(file, { surface: 'admin', limits: lim }).then(() => null, (e) => e);

  const e1 = await reject(tooMany, limits);
  chk(`too many files is refused as too large (${e1?.message})`, e1 instanceof zip.ZipLimitError && e1.status === 413);
  const e2 = await reject(deep, limits);
  chk(`folders nested too deep are refused, naming the path (${e2?.message})`, e2 instanceof zip.ZipLimitError && /a\/b\/c\/deep\.md/.test(e2.message));
  const e3 = await reject(bomb, limits);
  chk(`more unpacked bytes than allowed is refused (${e3?.message})`, e3 instanceof zip.ZipLimitError);
  const e4 = await reject(good, { ...zip.limitsFor(), maxUploadBytes: 10 });
  chk(`an archive over the upload limit is refused before it is opened (${e4?.message})`, e4 instanceof zip.ZipLimitError);

  const escape = await writeZip('escape.zip', [{ name: '../../etc/evil.md', data: '#' }]);
  const e5 = await reject(escape, zip.limitsFor());
  chk(`a path that climbs out of the archive is refused (${e5?.message})`, !!e5 && e5.status === 400);

  const notZip = path.join(tmp, 'not.zip');
  fs.writeFileSync(notZip, 'this is not a zip');
  const e6 = await reject(notZip, zip.limitsFor());
  chk('a file that is not a ZIP gets a plain answer, not a crash', !!e6 && e6.status === 400 && /not a ZIP/.test(e6.message));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n-- the upload limit is an admin setting --');
{
  chk('200 MB unless an administrator says otherwise', zip.limitsFor().maxUploadBytes === 200 * 1024 * 1024);
  chk('raising it raises what may be unpacked, so a ZIP of videos still fits',
    zip.limitsFor(800).maxUnpackedBytes === 5 * 800 * 1024 * 1024);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-zip-db-'));
  try {
    const db = store.open(dataDir);
    chk('with nothing stored, the setting reads as 200', zip.uploadMbSetting(db, store) === 200);
    store.setSystemSetting(db, 'max_zip_upload_mb', '500');
    chk('a stored value is used', zip.uploadMbSetting(db, store) === 500);
    store.setSystemSetting(db, 'max_zip_upload_mb', '0');
    chk('a nonsense stored value falls back to 200 rather than refusing everything', zip.uploadMbSetting(db, store) === 200);
    db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

if (!ok) {
  console.error('\nSOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
