// How many LibreOffice conversions run at once (Issue #337), with a stand-in
// `soffice` on PATH that records when each run starts and ends - so this runs
// everywhere, LibreOffice installed or not.
//
//   node podium/test/convert-queue.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const convert = require(path.join(HERE, '..', 'server', 'pptx-convert.js'));

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

// The stand-in: notes "start"/"end" with a timestamp, and whether its private
// profile came with active content switched off, then writes the output the
// real one would. STUB_MS is how long it "converts" for.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-fake-soffice-'));
const log = path.join(bin, 'runs.log');
fs.writeFileSync(path.join(bin, 'soffice'), `#!/bin/sh
outdir=""; profile=""; input=""; to=pdf
while [ $# -gt 0 ]; do
  case "$1" in
    --outdir) outdir="$2"; shift ;;
    --convert-to) to="$2"; shift ;;
    -env:UserInstallation=file://*) profile="\${1#-env:UserInstallation=file://}" ;;
    --*) ;;
    *) input="$1" ;;
  esac
  shift
done
locked=no
grep -q 'DisableMacrosExecution' "$profile/user/registrymodifications.xcu" 2>/dev/null \\
  && grep -q 'BlockUntrustedRefererLinks' "$profile/user/registrymodifications.xcu" && locked=yes
echo "start $(date +%s%N) $locked" >> "${log}"
sleep "$STUB_SECONDS"
printf 'converted' > "$outdir/input.$to"
echo "end $(date +%s%N)" >> "${log}"
`, { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const PPTX = Buffer.from('504b0304' + '00'.repeat(32), 'hex');
const settle = (promises) => Promise.all(promises.map((p) => p.then(() => 'ok', (err) => err)));
function overlap() {
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const events = lines.map((l) => l.split(' ')).map(([kind, at]) => ({ kind, at: BigInt(at) }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.kind === 'end' ? -1 : 1)));
  let now = 0;
  let most = 0;
  for (const e of events) { now += e.kind === 'start' ? 1 : -1; most = Math.max(most, now); }
  return { most, runs: lines.filter((l) => l.startsWith('start')).length, locked: lines.filter((l) => l.startsWith('start')).every((l) => l.endsWith(' yes')) };
}
const reset = (env) => {
  fs.rmSync(log, { force: true });
  for (const k of ['CONVERT_CONCURRENCY', 'CONVERT_QUEUE', 'CONVERT_PER_ACCOUNT', 'CONVERT_WAIT_MS']) delete process.env[k];
  Object.assign(process.env, env);
};

console.log('-- ten at once --');
reset({ CONVERT_QUEUE: '8', STUB_SECONDS: '0.3' });
let results = await settle(Array.from({ length: 10 }, () => convert.convertToPdf(PPTX, '.pptx')));
let seen = overlap();
ok(`all ten finish (${results.filter((r) => r === 'ok').length})`, results.every((r) => r === 'ok'));
ok(`never more than two running at once (at most ${seen.most})`, seen.most === 2 && seen.runs === 10);
ok('each one started with macros, OLE/DDE and outside links off in its profile', seen.locked);
ok('and nothing is left running or waiting', JSON.stringify(convert.convertLoad()) === '{"running":0,"waiting":0}');

console.log('\n-- a full queue --');
reset({ CONVERT_QUEUE: '3', STUB_SECONDS: '0.3' });
results = await settle(Array.from({ length: 10 }, () => convert.convertToPdf(PPTX, '.pptx')));
const busy = results.filter((r) => r instanceof convert.ConversionError && r.status === 503);
ok(`two running and three waiting go ahead, the other five are told the server is busy (${results.filter((r) => r === 'ok').length} / ${busy.length})`,
  results.filter((r) => r === 'ok').length === 5 && busy.length === 5);
ok('in words: try again in a minute', /busy converting/.test(busy[0]?.message || '') && /try again/i.test(busy[0]?.message || ''));
ok('and those five never started LibreOffice', overlap().runs === 5);

console.log('\n-- one account --');
reset({ CONVERT_CONCURRENCY: '4', STUB_SECONDS: '0.3' });
results = await settle([
  convert.convertToPdf(PPTX, '.pptx', { owner: 7 }),
  convert.convertToPdf(PPTX, '.pptx', { owner: 7 }),
  convert.convertToPdf(PPTX, '.pptx', { owner: 7 }),
  convert.convertToPdf(PPTX, '.pptx', { owner: 8 }),
]);
ok('a third at once from the same account is refused (429)', results[2] instanceof convert.ConversionError && results[2].status === 429
  && /already have 2 files converting/.test(results[2].message));
ok('its first two go ahead, and so does another account\'s', results[0] === 'ok' && results[1] === 'ok' && results[3] === 'ok');
ok('once they finish, that account may convert again', await convert.convertToPdf(PPTX, '.pptx', { owner: 7 }).then(() => true, () => false));
const docx = await settle([
  convert.convertToDocx(Buffer.from('d0cf11e0a1b11ae1' + '00'.repeat(16), 'hex'), { owner: 'x' }),
  convert.convertToDocx(Buffer.from('d0cf11e0a1b11ae1' + '00'.repeat(16), 'hex'), { owner: 'x' }),
  convert.convertToPdf(PPTX, '.pptx', { owner: 'x' }),
]);
ok('a .doc to .docx counts against the same limit', docx[0] === 'ok' && docx[1] === 'ok' && docx[2]?.status === 429);

console.log('\n-- waiting too long --');
reset({ CONVERT_CONCURRENCY: '1', CONVERT_WAIT_MS: '200', STUB_SECONDS: '0.8' });
const t0 = Date.now();
results = await settle([
  convert.convertToPdf(PPTX, '.pptx', { owner: 'w' }),
  convert.convertToPdf(PPTX, '.pptx', { owner: 'w' }).then(() => { throw new Error(`finished after ${Date.now() - t0}ms`); }, (err) => { err.after = Date.now() - t0; throw err; }),
]);
ok(`one still waiting after its time is told the server is busy, without waiting the whole conversion out (${results[1]?.after}ms)`,
  results[0] === 'ok' && results[1]?.status === 503 && results[1].after < 700);
process.env.CONVERT_WAIT_MS = '5000';
ok('and its place in the account\'s limit is given back', await settle([
  convert.convertToPdf(PPTX, '.pptx', { owner: 'w' }), convert.convertToPdf(PPTX, '.pptx', { owner: 'w' }),
]).then((r) => r.every((x) => x === 'ok')));
ok('nothing left running or waiting at the end', JSON.stringify(convert.convertLoad()) === '{"running":0,"waiting":0}');

console.log('\n-- a ZIP import\'s files wait their turn --');
reset({ CONVERT_CONCURRENCY: '1', CONVERT_QUEUE: '0', CONVERT_WAIT_MS: '100', STUB_SECONDS: '0.4' });
results = await settle([
  convert.convertToPdf(PPTX, '.pptx', { owner: 'someone else' }),
  convert.convertToPdf(PPTX, '.pptx', { owner: 'zip', patient: true }),
]);
ok('past a full queue and the usual wait, rather than failing an item of the import', results.every((r) => r === 'ok') && overlap().most === 1);

console.log('\n-- a refused file takes no turn --');
reset({ CONVERT_CONCURRENCY: '1', STUB_SECONDS: '0.1' });
const notOffice = await settle([convert.convertToPdf(Buffer.from('plain text'), '.pptx', { owner: 'n' }), convert.convertToPdf(Buffer.from('plain text'), '.pptx', { owner: 'n' }), convert.convertToPdf(Buffer.from('plain text'), '.pptx', { owner: 'n' })]);
ok('a file that is not really Office is refused before it queues (422, not 429)', notOffice.every((r) => r?.status === 422));

fs.rmSync(bin, { recursive: true, force: true });
if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
