// A course's roster (Issue #256, phase 1), against a real SQLite file: who may
// read and change it, adding and editing people, removing (softly) and putting
// back, and importing a CSV - preview first, then the same file applied.
//
//   node podium/test/roster.test.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning'); // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const courses = require('../server/courses.js');
const roster = require('../server/roster.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };

const db = store.open(mkdtempSync(path.join(tmpdir(), 'podium-roster-')));
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password' });
const tia = await accounts.createUser(db, { username: 'tia', password: 'a good long password' });
const sam = await accounts.createUser(db, { username: 'sam', password: 'a good long password' });
courses.create(db, admin, { code: 'psy415', title: 'PSY 415' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'tia', role: 'member' });

console.log('-- who may read and change it --');
ok('an owner may change it', roster.access(db, owen, 'psy415') === 'edit');
ok('an admin may change it', roster.access(db, admin, 'psy415') === 'edit');
ok('a TA (member) may read it', roster.access(db, tia, 'psy415') === 'read');
ok('someone outside the course is told there is no such course', status(() => roster.list(db, sam, 'psy415')) === 404);
ok('a TA cannot add to it', status(() => roster.add(db, tia, 'psy415', { name: 'Ann' })) === 403);

console.log('\n-- adding, editing, removing --');
const jane = roster.add(db, owen, 'psy415', { name: '  Jane   Doe ', studentId: 'A100', email: 'Jane@School.edu' });
ok(`a person is added, tidied (${JSON.stringify({ name: jane.name, email: jane.email })})`, jane.name === 'Jane Doe' && jane.email === 'jane@school.edu' && jane.source === 'manual');
ok('a name is required', status(() => roster.add(db, owen, 'psy415', { name: ' ' })) === 400);
ok('an email must look like one', status(() => roster.add(db, owen, 'psy415', { name: 'X', email: 'nope' })) === 400);
ok('two people cannot share a student ID', status(() => roster.add(db, owen, 'psy415', { name: 'Other', studentId: 'a100' })) === 409);
const lee = roster.add(db, owen, 'psy415', { name: 'Sam Lee', studentId: 'A200' });
ok('the TA sees both, by name', roster.list(db, tia, 'psy415').people.map((p) => p.name).join() === 'Jane Doe,Sam Lee'
  && roster.list(db, tia, 'psy415').mayEdit === false);
ok('an edit keeps what it does not change', roster.update(db, owen, 'psy415', lee.id, { email: 'sam@school.edu' }).studentId === 'A200');
ok('an edit cannot take another person\'s ID', status(() => roster.update(db, owen, 'psy415', lee.id, { studentId: 'A100' })) === 409);
roster.remove(db, owen, 'psy415', lee.id);
ok('removing takes them off the list', roster.list(db, owen, 'psy415').people.length === 1);
ok('but keeps them, marked, for an owner who asks', roster.list(db, owen, 'psy415', { removed: true }).people.find((p) => p.id === lee.id)?.removedAt > 0);
ok('a TA asking for removed people sees only the current list', roster.list(db, tia, 'psy415', { removed: true }).people.length === 1);
ok('and they can be put back', !roster.update(db, owen, 'psy415', lee.id, { removed: false }).removedAt
  && roster.list(db, owen, 'psy415').people.length === 2);
ok('a person in another course cannot be touched through this one', (() => {
  courses.create(db, admin, { code: 'bio101', title: 'BIO' });
  return status(() => roster.update(db, admin, 'bio101', jane.id, { name: 'X' })) === 404;
})());

console.log('\n-- CSV: reading what people actually have --');
ok('quotes, doubled quotes, CRLF and a BOM', JSON.stringify(roster.parseCsv('﻿name,id\r\n"Doe, ""JD"" Jane",7\r\n'))
  === JSON.stringify([['name', 'id'], ['Doe, "JD" Jane', '7']]));
ok('semicolons when that is the separator', roster.parseCsv('name;email\nAnn;a@b.co\n')[1][1] === 'a@b.co');
const canvas = roster.readRoster('Student,ID,SIS User ID,SIS Login ID,Section\n    Points Possible,,,,\n"Doe, Jane",123,A100,jdoe,01\n"Kim, Bo",124,A300,bkim,01\n');
ok(`a Canvas export: "Last, First" turned round, SIS ID preferred, the Points row skipped (${canvas.people.map((p) => `${p.name}/${p.studentId}`).join(' ')})`,
  canvas.people.length === 2 && canvas.people[0].name === 'Jane Doe' && canvas.people[0].studentId === 'A100' && canvas.columns.studentId === 'SIS User ID');
const split = roster.readRoster('First name,Last name,Email address\nAnn,Lee,ann@school.edu\n');
ok('first and last name columns are joined', split.people[0].name === 'Ann Lee' && split.people[0].email === 'ann@school.edu');
const bare = roster.readRoster('Ann Lee,A9,ann@school.edu\nBo Kim,A8,\n');
ok('a file with no header is name, ID, email', bare.people.length === 2 && bare.people[1].studentId === 'A8');
const unknown = roster.readRoster('Pupil,Code\nAnn,1\n');
ok('a header with no name column says so, rather than guessing', unknown.people.length === 0 && /no name column/.test(unknown.problems[0].message));
const bad = roster.readRoster('name,email\nAnn,not-an-email\nBo,bo@school.edu\n');
ok('a bad line is reported with its line number, the rest still read', bad.people.length === 1 && bad.problems[0].line === 2);

console.log('\n-- importing: preview, then apply --');
const csv = 'name,student id,email\nJane Doe,A100,jane@school.edu\nSam Lee,A200,sam.lee@school.edu\nBo Kim,A300,bo@school.edu\n';
const preview = roster.previewImport(db, owen, 'psy415', csv);
ok(`the preview says who is new, who changes, who is unchanged (${preview.add.length} new, ${preview.change.length} changed, ${preview.unchanged} same)`,
  preview.add.length === 1 && preview.add[0].name === 'Bo Kim' && preview.change.length === 1 && preview.change[0].after.email === 'sam.lee@school.edu' && preview.unchanged === 1);
ok('and changes nothing', roster.list(db, owen, 'psy415').people.length === 2);
ok('a TA cannot import', status(() => roster.previewImport(db, tia, 'psy415', csv)) === 403);
const applied = roster.applyImport(db, owen, 'psy415', csv);
ok(`applying does what the preview said (${JSON.stringify(applied)})`, applied.added === 1 && applied.changed === 1 && applied.unchanged === 1
  && roster.list(db, owen, 'psy415').people.find((p) => p.name === 'Bo Kim')?.source === 'csv');
ok('importing the same file again changes nothing', (() => { const again = roster.applyImport(db, owen, 'psy415', csv); return again.added === 0 && again.changed === 0 && again.unchanged === 3; })());
const smaller = 'name,student id\nJane Doe,A100\n';
ok('without "replace", people missing from the file stay', roster.previewImport(db, owen, 'psy415', smaller).remove.length === 0);
const replacing = roster.previewImport(db, owen, 'psy415', smaller, { replace: true });
ok(`with "replace", the preview lists who would come off (${replacing.remove.map((p) => p.name).join(', ')})`, replacing.remove.length === 2);
roster.applyImport(db, owen, 'psy415', smaller, { replace: true });
ok('and applying takes them off, softly', roster.list(db, owen, 'psy415').people.length === 1 && roster.list(db, owen, 'psy415', { removed: true }).people.length === 3);
ok('an import matches by ID before name: a renamed student is a change, not a new person', (() => {
  const r = roster.previewImport(db, owen, 'psy415', 'name,student id\nJanet Doe,A100\n');
  return r.add.length === 0 && r.change[0]?.after.name === 'Janet Doe';
})());
ok('a student ID twice in one file is a problem, not two people', roster.previewImport(db, owen, 'psy415', 'name,id\nA,X1\nB,X1\n').problems.length === 1);

console.log('\n-- export --');
const out = roster.exportCsv(db, tia, 'psy415');
ok(`a TA may export it, in the columns the import reads (${JSON.stringify(out.slice(0, 40))})`, out.startsWith('﻿name,student id,email\r\n') && /Jane Doe,A100,jane@school\.edu/.test(out));
ok('and what it writes reads back the same', roster.readRoster(out).people.length === 1);

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
