// Course-level plan templates (Issue #80), against a real SQLite file.
//
//   node podium/test/templates.test.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning'); // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const courses = require('../server/courses.js');
const templates = require('../server/templates.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

const dataDir = mkdtempSync(path.join(tmpdir(), 'podium-templates-'));
const db = store.open(dataDir);

const admin = await accounts.createUser(db, { username: 'jon', password: 'a good long password', isAdmin: true });
const owner = await accounts.createUser(db, { username: 'owner', password: 'a good long password' });
const member = await accounts.createUser(db, { username: 'member', password: 'a good long password' });
const outsider = await accounts.createUser(db, { username: 'outsider', password: 'a good long password' });

courses.create(db, admin, { code: 'psy415', title: 'PSY 415' });
courses.addMember(db, admin, 'psy415', { username: 'owner', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'member', role: 'member' });

const skeleton = { version: 1, title: 'Weekly shape', items: [{ type: 'qr', data: 'https://example.com' }] };

console.log('-- writing a template --');

ok('a plain member may not save one', (() => {
  try { templates.write(db, member, 'psy415', skeleton); return false; } catch (err) { return err.status === 403; }
})());
ok('a course owner may', !!templates.write(db, owner, 'psy415', skeleton));
ok('and so may an admin', !!templates.write(db, admin, 'psy415', skeleton));
ok('an outsider (not even a member) may not', (() => {
  try { templates.write(db, outsider, 'psy415', skeleton); return false; } catch (err) { return err.status === 403; }
})());
ok('a course that does not exist is refused the same way, not distinguished from "not yours"', (() => {
  try { templates.write(db, admin, 'no-such-course', skeleton); return false; } catch (err) { return err.status === 403; }
})());
ok('an oversized doc is refused', (() => {
  try { templates.write(db, owner, 'psy415', 'x'.repeat(templates.MAX_DOC_BYTES + 1)); return false; } catch (err) { return err.status === 413; }
})());

console.log('-- reading it back --');

const forOwner = templates.forUser(db, owner);
ok('the owner sees it in their list', forOwner.some((row) => row.course === 'psy415'));
ok('with the doc round-tripped intact', forOwner.find((row) => row.course === 'psy415').doc.title === 'Weekly shape');

const forMember = templates.forUser(db, member);
ok('a plain member sees it too - starting from it is not different from being handed the room passphrase',
  forMember.some((row) => row.course === 'psy415'));

const forOutsider = templates.forUser(db, outsider);
ok('an outsider sees nothing - no membership, no template', forOutsider.length === 0);

console.log('-- a course with no template --');

courses.create(db, admin, { code: 'psy101', title: 'PSY 101' });
courses.addMember(db, admin, 'psy101', { username: 'member', role: 'member' });
ok('does not appear in the list at all - not an empty entry, just absent',
  !templates.forUser(db, member).some((row) => row.course === 'psy101'));

console.log('-- removing it --');

ok('a plain member may not remove it', (() => {
  try { templates.remove(db, member, 'psy415'); return false; } catch (err) { return err.status === 403; }
})());
ok('the owner may', !!templates.remove(db, owner, 'psy415'));
ok('and it is really gone', !templates.forUser(db, owner).some((row) => row.course === 'psy415'));

if (fails.length) {
  console.log(`\n${fails.length} FAILED`);
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
