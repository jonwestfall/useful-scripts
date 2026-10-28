// The streaming ZIP writer behind backups (server/zip-writer.js): what it
// writes opens, with every name, byte and checksum intact - as a plain ZIP,
// and with ZIP64 forced on for every entry the way a backup past 4 GB has it.
//
//   node podium/test/zip-writer.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { ZipWriter, crc32, safePart, predictSize } = require(path.join(HERE, '..', 'server', 'zip-writer.js'));
const yauzl = require(path.join(HERE, '..', 'server', 'node_modules', 'yauzl'));

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-zipw-'));
const big = path.join(dir, 'clip.bin');
fs.writeFileSync(big, crypto.randomBytes(3 * 1024 * 1024 + 17));
const text = '# Week 3\n\n' + 'Memory is reconstructive. '.repeat(400);

async function build(file, opts) {
  const out = fs.createWriteStream(file);
  const zip = new ZipWriter(out, opts);
  await zip.addBuffer(zip.uniqueName('PSY 415/Lectures/Week 3 — Memory/Week 3.podium.json'), JSON.stringify({ podium: 'plan', title: 'Week 3' }));
  await zip.addBuffer(zip.uniqueName('PSY 415/Library/Decks/week3.md'), text);
  await zip.addBuffer(zip.uniqueName('PSY 415/Library/Decks/WEEK3.md'), 'a second file by the same name');
  await zip.addBuffer(zip.uniqueName('PSY 415/Library/empty.txt'), '');
  await zip.addFile(zip.uniqueName('PSY 415/Library/Video/clip.mp4'), big);
  await zip.finish();
  await new Promise((resolve) => out.end(resolve));
  return zip;
}

function read(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, z) => {
      if (err) { reject(err); return; }
      const got = new Map();
      z.on('entry', (entry) => {
        z.openReadStream(entry, (e, stream) => {
          if (e) { reject(e); return; }
          const parts = [];
          stream.on('data', (c) => parts.push(c));
          stream.on('end', () => { got.set(entry.fileName, { data: Buffer.concat(parts), entry }); z.readEntry(); });
          stream.on('error', reject);
        });
      });
      z.on('end', () => resolve(got));
      z.on('error', reject);
      z.readEntry();
    });
  });
}

for (const [label, opts] of [['plain', {}], ['ZIP64 for everything', { zip64At: 1 }]]) {
  const file = path.join(dir, `${label.replace(/\W+/g, '-')}.zip`);
  const zip = await build(file, opts);
  ok(`${label}: the byte count it reports is the file's size`, zip.written === fs.statSync(file).size);
  const predicted = predictSize([
    { name: 'PSY 415/Lectures/Week 3 — Memory/Week 3.podium.json', data: Buffer.from(JSON.stringify({ podium: 'plan', title: 'Week 3' })) },
    { name: 'PSY 415/Library/Decks/week3.md', data: Buffer.from(text) },
    { name: 'PSY 415/Library/Decks/WEEK3 (2).md', data: Buffer.from('a second file by the same name') },
    { name: 'PSY 415/Library/empty.txt', data: Buffer.alloc(0) },
    { name: 'PSY 415/Library/Video/clip.mp4', bytes: fs.statSync(big).size },
  ], opts);
  ok(`${label}: its size was known before a byte was written (${predicted} = ${zip.written})`, predicted === zip.written);
  let got;
  try { got = await read(file); } catch (err) { ok(`${label}: it opens (${err.message})`, false); continue; }
  ok(`${label}: every entry is there, names in UTF-8 (${[...got.keys()].join(' | ')})`,
    got.size === 5 && got.has('PSY 415/Lectures/Week 3 — Memory/Week 3.podium.json'));
  ok(`${label}: a second file of the same name (any case) is numbered, not overwritten`, got.has('PSY 415/Library/Decks/WEEK3 (2).md'));
  ok(`${label}: text is compressed and comes back the same`,
    got.get('PSY 415/Library/Decks/week3.md').data.toString() === text
    && got.get('PSY 415/Library/Decks/week3.md').entry.compressionMethod === 8);
  ok(`${label}: an empty file is an empty file`, got.get('PSY 415/Library/empty.txt').data.length === 0);
  ok(`${label}: a file from disk is stored as it is, every byte`,
    got.get('PSY 415/Library/Video/clip.mp4').data.equals(fs.readFileSync(big))
    && got.get('PSY 415/Library/Video/clip.mp4').entry.compressionMethod === 0);
  // Info-ZIP's own test: CRCs and headers, as the oldest common tool reads them.
  try {
    const out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    ok(`${label}: unzip -t finds no errors`, /No errors detected/.test(out));
  } catch (err) {
    if (err.code === 'ENOENT') console.log('     (unzip is not installed here; skipped)');
    else ok(`${label}: unzip -t finds no errors (${String(err.stdout || err.message).slice(-300)})`, false);
  }
}

ok('the CRC is the standard one', crc32(Buffer.from('123456789')) === 0xcbf43926);
ok('a name loses what a file system refuses', safePart('a/b\\c:d*e?"f<g>h|') === 'a b c d e f g h');
ok('and a leading dot, so nothing climbs out or hides', safePart('../secret') === 'secret' && safePart('.hidden') === 'hidden');
ok('nothing left is the fallback', safePart('   ', 'Untitled') === 'Untitled');
ok('a long name keeps its extension', safePart(`${'x'.repeat(300)}.pdf`).length === 100 && safePart(`${'x'.repeat(300)}.pdf`).endsWith('.pdf'));

// A download stopped halfway stops the writer, rather than reading on into nowhere.
{
  const { PassThrough } = await import('node:stream');
  const out = new PassThrough({ highWaterMark: 1024 });
  const zip = new ZipWriter(out);
  const pending = zip.addFile('clip.mp4', big);
  setTimeout(() => out.destroy(), 20);
  let stopped = null;
  try { await pending; } catch (err) { stopped = err; }
  ok(`a download the browser stops ends the writing (${stopped?.message})`, !!stopped?.aborted);
}

fs.rmSync(dir, { recursive: true, force: true });
if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log('\nALL PASS');
