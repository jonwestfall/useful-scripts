// End-to-end test for Podium.
//
//   npm i playwright && npx playwright install chromium
//   node podium/test/e2e.mjs                        every group, one after another
//   node podium/test/e2e.mjs --group ink-layout     one group (comma-separate for more)
//   node podium/test/e2e.mjs --only ink             sections matching "ink", in any group
//
// The suite is split into feature groups under test/e2e/, each starting its
// own relay and browser (see test/e2e/harness.mjs), so a failure in one group
// never stops the others from running and any group can be run on its own.
// CI runs the groups side by side on separate runners; locally they run in
// sequence, because some write the same fixture files.
//
// It drives displays and controllers in real browsers and checks the things
// that would embarrass you in front of a class: freeze really holds, TAKE puts
// the cued item up without reloading it, ink arrives, and a device with the
// wrong passphrase cannot touch the screen.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GROUPS = ['core', 'ink-layout', 'media', 'polls-server'];

const args = process.argv.slice(2);
let picked = GROUPS;
const groupAt = args.indexOf('--group');
if (groupAt !== -1) {
  picked = String(args[groupAt + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  args.splice(groupAt, 2);
  const unknown = picked.filter((g) => !GROUPS.includes(g));
  if (!picked.length || unknown.length) {
    console.error(`unknown group${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ') || '(none given)'} - pick from ${GROUPS.join(', ')}`);
    process.exit(2);
  }
}

const results = [];
for (const group of picked) {
  console.log(`\n==== ${group} ====`);
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'e2e', `${group}.mjs`), ...args], { stdio: 'inherit' });
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 1 : 0)));
  });
  results.push({ group, code, secs: Math.round((Date.now() - started) / 1000) });
}

console.log('\n==== summary ====');
for (const r of results) console.log(`${r.code === 0 ? 'pass' : 'FAIL'}  ${r.group} (${r.secs}s)`);
const failed = results.filter((r) => r.code !== 0);
console.log(failed.length ? `\n${failed.length} group${failed.length === 1 ? '' : 's'} FAILED` : '\nALL GROUPS PASS');
process.exit(failed.length ? 1 : 0);
