// A class typed into the planner's Course field (Issue #224), against a real
// SQLite file: made on the spot, its author its owner, and a lecture filed
// under it the same way as under any other class.
//
//   node podium/test/planner-courses.test.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning'); // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const courses = require('../server/courses.js');
const plans = require('../server/plans.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 0; } catch (err) { return err.status || -1; } };

const db = store.open(mkdtempSync(path.join(tmpdir(), 'podium-planner-courses-')));
const admin = await accounts.createUser(db, { username: 'jon', password: 'a good long password', isAdmin: true });
const ana = await accounts.createUser(db, { username: 'ana', password: 'a good long password' });
const bo = await accounts.createUser(db, { username: 'bo', password: 'a good long password' });
courses.create(db, admin, { code: 'psy415', title: 'PSY 415' });

console.log('-- a code from what was typed --');
ok('"PSY 415" becomes psy-415', courses.codeFor('PSY 415') === 'psy-415');
ok('a code that is already a code stays one', courses.codeFor('psy415') === 'psy415');
ok('odd punctuation collapses rather than piling up', courses.codeFor('  Intro to Psych!! (Fall) ') === 'intro-to-psych-fall');
ok('nothing usable is refused', status(() => courses.createFromPlanner(db, ana, { name: '!!!' })) === 400);

console.log('-- an instructor makes a class --');
ok('a non-admin may not use the administrators\' way of making one', status(() => courses.create(db, ana, { code: 'x1' })) === 403);
const made = courses.createFromPlanner(db, ana, { name: 'Intro to Statistics' });
ok(`but may make one from the planner (${made.code})`, made.code === 'intro-to-statistics' && made.title === 'Intro to Statistics');
ok('and owns it', courses.roleOf(db, ana, made.code) === 'owner');
ok('Administration sees who made it', courses.list(db, admin).find((c) => c.code === made.code)?.createdBy === 'ana');
ok('a class an administrator made says nothing of the sort', courses.list(db, admin).find((c) => c.code === 'psy415')?.createdBy === null);

const filed = plans.savePlan(db, ana, { title: 'Week 1', courseCode: made.code, doc: '{}' });
ok('a lecture can be filed under it straight away', filed.course === made.code);

console.log('-- one that already exists --');
const again = courses.createFromPlanner(db, ana, { name: 'intro to statistics' });
ok('typing it again uses it rather than failing or doubling it', again.code === made.code && again.existed === true);
ok('someone who is not in it is told to ask, not handed it', status(() => courses.createFromPlanner(db, bo, { name: 'Intro to Statistics' })) === 409);
ok('and is not quietly made a member', courses.roleOf(db, bo, made.code) === null);
courses.update(db, admin, made.code, { archived: true });
ok('an archived one is refused, even to its owner', status(() => courses.createFromPlanner(db, ana, { name: 'Intro to Statistics' })) === 409);

console.log('-- lectures with no class --');
const orphan = plans.savePlan(db, bo, { title: 'Loose notes', courseCode: '', doc: '{}' });
ok('a lecture with no class is listed to an administrator, with no class on it',
  plans.listPlans(db, admin).some((p) => p.id === orphan.id && p.course === null));
const refiled = plans.updatePlan(db, admin, orphan.id, { courseCode: 'psy415' });
ok('and an administrator can file it under one', refiled.course === 'psy415');

if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log('\nALL PASS');
