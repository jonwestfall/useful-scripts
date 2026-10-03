// Deck templates (Issue #226), against a real SQLite file: who sees which,
// who may change which, and the built-ins an admin can hide.
//
//   node podium/test/deck-templates.test.mjs

import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
process.removeAllListeners('warning'); // the node:sqlite experimental notice

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const courses = require('../server/courses.js');
const deckTemplates = require('../server/deck-templates.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const status = (fn) => { try { fn(); return 200; } catch (err) { return err.status || 500; } };

const dataDir = mkdtempSync(path.join(tmpdir(), 'podium-deck-templates-'));
const db = store.open(dataDir);

const admin = await accounts.createUser(db, { username: 'jon', password: 'a good long password', isAdmin: true });
const owner = await accounts.createUser(db, { username: 'owner', password: 'a good long password' });
const ta = await accounts.createUser(db, { username: 'ta', password: 'a good long password' });
const outsider = await accounts.createUser(db, { username: 'outsider', password: 'a good long password' });

courses.create(db, admin, { code: 'psy415', title: 'PSY 415' });
courses.addMember(db, admin, 'psy415', { username: 'owner', role: 'owner' });
courses.addMember(db, admin, 'psy415', { username: 'ta', role: 'member' });

const slide = '<!-- _class: lead -->\n\n# PSY 415\n\nWeek N\n';

console.log('-- a course\'s templates --');
ok('a TA may not add one', status(() => deckTemplates.create(db, ta, { scope: 'course', course: 'psy415', kind: 'slide', title: 'Title', markdown: slide })) === 403);
ok('nor may someone outside the course', status(() => deckTemplates.create(db, outsider, { scope: 'course', course: 'psy415', kind: 'slide', title: 'Title', markdown: slide })) === 403);
const course = deckTemplates.create(db, owner, { scope: 'course', course: 'PSY415', kind: 'slide', title: '  PSY 415 title  ', markdown: slide });
ok('a course owner may', course?.scope === 'course' && course.course === 'psy415' && course.kind === 'slide');
ok('its name is trimmed', course.title === 'PSY 415 title');
ok('everyone in the course can use it', deckTemplates.forUser(db, ta).templates.some((t) => t.id === course.id));
ok('but a TA cannot change it', deckTemplates.forUser(db, ta).templates.find((t) => t.id === course.id).editable === false
  && status(() => deckTemplates.update(db, ta, course.id, { title: 'Mine now' })) === 403
  && status(() => deckTemplates.remove(db, ta, course.id)) === 403);
ok('the owner can', deckTemplates.forUser(db, owner).templates.find((t) => t.id === course.id).editable === true);
ok('so can an admin', deckTemplates.forUser(db, admin).templates.find((t) => t.id === course.id).editable === true);
ok('someone outside the course does not see it', !deckTemplates.forUser(db, outsider).templates.some((t) => t.id === course.id)
  && status(() => deckTemplates.update(db, outsider, course.id, { title: 'x' })) === 404);

const renamed = deckTemplates.update(db, owner, course.id, { title: 'PSY 415 title slide' });
ok('renaming keeps the markdown', renamed.title === 'PSY 415 title slide' && renamed.markdown === slide);
const rewritten = deckTemplates.update(db, owner, course.id, { markdown: `${slide}\nwith a line more\n` });
ok('rewriting keeps the name, and says who changed it', rewritten.title === 'PSY 415 title slide' && rewritten.markdown.endsWith('with a line more\n'));
ok('a kind is a deck or a slide, nothing else', status(() => deckTemplates.update(db, owner, course.id, { kind: 'poster' })) === 400);
ok('a template needs a name', status(() => deckTemplates.update(db, owner, course.id, { title: '   ' })) === 400);
ok('and something in it', status(() => deckTemplates.create(db, owner, { scope: 'mine', kind: 'deck', title: 'Empty', markdown: '  \n' })) === 400);
ok('and has a size cap', status(() => deckTemplates.create(db, owner, { scope: 'mine', kind: 'deck', title: 'Huge', markdown: 'x'.repeat(deckTemplates.MAX_MARKDOWN_BYTES + 1) })) === 413);
ok('a course that does not exist is refused', status(() => deckTemplates.create(db, admin, { scope: 'course', course: 'nope101', kind: 'slide', title: 'x', markdown: slide })) === 403);
ok('and so is a scope that is neither', status(() => deckTemplates.create(db, owner, { scope: 'everyone', kind: 'slide', title: 'x', markdown: slide })) === 400);

console.log('-- your own --');
const mine = deckTemplates.create(db, ta, { scope: 'mine', kind: 'deck', title: 'My lab deck', markdown: '---\nmarp: true\n---\n\n# Lab\n' });
ok('anyone may keep templates of their own', mine?.scope === 'mine' && mine.editable === true);
ok('nobody else sees them, not even the course owner', !deckTemplates.forUser(db, owner).templates.some((t) => t.id === mine.id));
ok('or changes them', status(() => deckTemplates.update(db, owner, mine.id, { title: 'x' })) === 404);

console.log('-- removing --');
ok('the owner of a course template removes it', deckTemplates.remove(db, owner, course.id).id === course.id);
ok('and then nobody sees it', !deckTemplates.forUser(db, ta).templates.some((t) => t.id === course.id)
  && !deckTemplates.forUser(db, admin).templates.some((t) => t.id === course.id));
ok('or can change it', status(() => deckTemplates.update(db, owner, course.id, { title: 'back' })) === 404);

console.log('-- the built-ins --');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const index = JSON.parse(readFileSync(path.join(HERE, '..', 'content', 'deck-templates', 'index.json'), 'utf8'));
ok('content/deck-templates/index.json lists both kinds', index.templates.some((t) => t.kind === 'deck') && index.templates.some((t) => t.kind === 'slide'));
ok('every one it lists is there, with an id, a title and a kind',
  index.templates.every((t) => /^[\w-]+$/.test(t.id) && t.title && ['deck', 'slide'].includes(t.kind)
    && existsSync(path.join(HERE, '..', 'content', 'deck-templates', t.file))));
ok('ids are unique', new Set(index.templates.map((t) => t.id)).size === index.templates.length);
ok('nothing is hidden to begin with', deckTemplates.forUser(db, ta).hiddenBuiltIns.length === 0);
ok('only an admin can hide one', status(() => deckTemplates.hideBuiltIn(db, owner, 'quote', true)) === 403);
deckTemplates.hideBuiltIn(db, admin, 'quote', true);
ok('hidden, it is hidden for everyone', deckTemplates.forUser(db, ta).hiddenBuiltIns.includes('quote'));
deckTemplates.hideBuiltIn(db, admin, 'quote', false);
ok('and shown again', !deckTemplates.forUser(db, ta).hiddenBuiltIns.includes('quote'));
ok('an id that could not be a file name is refused', status(() => deckTemplates.hideBuiltIn(db, admin, '../evil', true)) === 400);

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASS');
process.exit(fails.length ? 1 : 0);
