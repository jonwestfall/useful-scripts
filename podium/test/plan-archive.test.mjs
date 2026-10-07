// Archiving lectures from one's own planner list (Issue #239), against a real
// SQLite file: personal, never anyone else's, and nothing about the plan
// itself changes.
//
//   node podium/test/plan-archive.test.mjs

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
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };

const db = store.open(mkdtempSync(path.join(tmpdir(), 'podium-plan-archive-')));
const admin = await accounts.createUser(db, { username: 'root', password: 'a good long password', isAdmin: true });
const owen = await accounts.createUser(db, { username: 'owen', password: 'a good long password' });
const tia = await accounts.createUser(db, { username: 'tia', password: 'a good long password' });
const outsider = await accounts.createUser(db, { username: 'outsider', password: 'a good long password' });
courses.create(db, admin, { code: 'psy415', title: 'PSY 415' });
courses.addMember(db, admin, 'psy415', { username: 'owen', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'tia', role: 'member' });

const week1 = plans.savePlan(db, owen, { title: 'Week 1', courseCode: 'psy415', doc: '{}' });
const week2 = plans.savePlan(db, owen, { title: 'Week 2', courseCode: 'psy415', doc: '{}' });
const mine = plans.savePlan(db, owen, { title: 'My notes', courseCode: '', doc: '{}' });
const titles = (user, opts) => plans.listPlans(db, user, opts).map((p) => p.title).sort().join(',');

console.log('-- one\'s own list --');
ok('nothing is archived to begin with', plans.listPlans(db, owen).every((p) => p.archived === false && p.archivedAt === null));
const done = plans.setArchived(db, owen, [week1.id], true);
ok('archiving a lecture says so', done.changed.join() === String(week1.id) && done.skipped.length === 0);
const listed = plans.listPlans(db, owen).find((p) => p.id === week1.id);
ok('it is still in the list, marked archived, with when', listed.archived === true && listed.archivedAt > 0);
ok('?archived=0 leaves it out', titles(owen, { archived: false }) === 'My notes,Week 2');
ok('?archived=1 is only it', titles(owen, { archived: true }) === 'Week 1');
ok('and opening it still works, marked archived', plans.getPlan(db, owen, week1.id)?.archived === true);

console.log('-- nobody else\'s --');
ok('the co-instructor still has it in their list', titles(tia, { archived: false }) === 'Week 1,Week 2');
ok('and can archive it from theirs, separately', plans.setArchived(db, tia, [week1.id, week2.id], true).changed.length === 2
  && titles(tia, { archived: true }) === 'Week 1,Week 2' && titles(owen, { archived: true }) === 'Week 1');
ok('archiving changes nothing about the plan', plans.getPlan(db, owen, week1.id).course === 'psy415'
  && plans.getPlan(db, owen, week1.id).updatedAt === week1.updatedAt && plans.getPlan(db, owen, week1.id).title === 'Week 1');
ok('a TA may archive a lecture they cannot edit', status(() => plans.updatePlan(db, tia, week2.id, { title: 'x' })) === 403
  && plans.listPlans(db, tia).find((p) => p.id === week2.id).archived === true);

console.log('-- bringing it back --');
ok('unarchiving puts it back in the list', plans.setArchived(db, owen, [week1.id], false).changed.length === 1
  && titles(owen, { archived: false }) === 'My notes,Week 1,Week 2' && titles(owen, { archived: true }) === '');
ok('archiving twice, or unarchiving what is not archived, is harmless',
  status(() => { plans.setArchived(db, owen, [mine.id], true); plans.setArchived(db, owen, [mine.id], true); plans.setArchived(db, owen, [week2.id], false); }) === 200
  && titles(owen, { archived: true }) === 'My notes');

console.log('-- what may be archived --');
const stray = plans.setArchived(db, outsider, [week1.id, mine.id], true);
ok('a lecture you cannot see is skipped, not archived', stray.changed.length === 0 && stray.skipped.length === 2
  && db.prepare('SELECT COUNT(*) AS n FROM plan_archive WHERE user_id = ?').get(outsider.id).n === 0);
ok('a mixed list archives what it can and skips the rest', (() => {
  const r = plans.setArchived(db, tia, [week1.id, mine.id, 999999], false);
  return r.changed.join() === String(week1.id) && r.skipped.sort().join() === [mine.id, 999999].sort().join();
})());
ok('no ids is refused', status(() => plans.setArchived(db, owen, [], true)) === 400 && status(() => plans.setArchived(db, owen, 'nope', true)) === 400);
ok('nor too many at once', status(() => plans.setArchived(db, owen, Array.from({ length: plans.MAX_ARCHIVE_IDS + 1 }, (_, i) => i + 1), true)) === 413);
ok('an administrator archives from their own list too', plans.setArchived(db, admin, [mine.id], true).changed.length === 1
  && plans.listPlans(db, admin).find((p) => p.id === mine.id).archived === true
  && plans.listPlans(db, owen).find((p) => p.id === mine.id).archived === true);

console.log('-- and when the plan goes --');
plans.deletePlan(db, owen, mine.id);
ok('a deleted lecture is gone from both lists', !plans.listPlans(db, owen).some((p) => p.id === mine.id)
  && !plans.listPlans(db, owen, { archived: true }).some((p) => p.id === mine.id));
ok('a kiosk still finds a plan by id, archived or not', plans.getPlanForKiosk(db, week2.id)?.title === 'Week 2'
  && plans.getPlanForKiosk(db, week2.id).archived === false);

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
