// A theme's cheat sheet and Admin's quick settings (assets/js/theme-sheet.js),
// read from real theme CSS.
//
//   node podium/test/theme-sheet.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeTheme, builtInSheet, sampleDeck, DIRECTIVES, BUILT_IN_SHEETS, readQuickSettings, writeQuickSettings,
} from '../assets/js/theme-sheet.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

// --- a real theme -------------------------------------------------------------------------
const dsu = analyzeTheme(fs.readFileSync(path.join(ROOT, 'marp-themes', 'psy415-dsu.css'), 'utf8'));
ok('the theme\'s name and what it is built on', dsu.name === 'psy415-dsu' && dsu.imports.join() === 'gaia');
ok(`its description is its first comment (${dsu.about.slice(0, 50)}…)`, /Delta State/.test(dsu.about) && !/@theme/.test(dsu.about));
const names = dsu.classes.map((c) => c.name);
ok(`its own classes are found (${names.join(', ')})`, ['lead', 'section-title', 'big-idea', 'quote-slide', 'green', 'compact', 'soft'].every((c) => names.includes(c)));
ok('each with the comment above its rules', dsu.classes.find((c) => c.name === 'green').about.includes('dark-green')
  && dsu.classes.find((c) => c.name === 'lead').about.includes('section-divider'));
ok('and those it gets from gaia, marked so', dsu.classes.find((c) => c.name === 'invert')?.from === 'gaia' && dsu.classes.find((c) => c.name === 'lead').from === '');
ok('a class is listed once however many rules it has', names.length === new Set(names).size);
ok('its colours are its custom properties', dsu.variables.some((v) => v.name === '--dsu-green' && v.value === '#008542' && v.color));
ok('a property that is not a colour is not marked as one', dsu.variables.every((v) => !v.color || !/^\d/.test(v.value)));
ok('its fonts', dsu.fonts.some((f) => /Helvetica Neue/.test(f)));

// --- small cases ------------------------------------------------------------------------
const tiny = analyzeTheme(`/* @theme tiny */
/* @size wide 1600px 900px */
@import url('uncover');
/* The opening slide. */
section.opener h1 { color: red; }
section.marpit { }
:root { --accent: rgb(1, 2, 3); --gap: 12px; }
section { font-family: Georgia, serif; }`);
ok('a theme with no description comment has none', tiny.about === 'The opening slide.' || tiny.about === '');
ok('@import url(…) is read too', tiny.imports.join() === 'uncover' && tiny.classes.some((c) => c.name === 'invert' && c.from === 'uncover'));
ok('a size preset is read', tiny.sizes.length === 1 && tiny.sizes[0].name === 'wide' && tiny.sizes[0].width === '1600px');
ok('Marp\'s own wrapper class is not a slide class', !tiny.classes.some((c) => c.name === 'marpit'));
ok('rgb() is a colour, 12px is not', tiny.variables.find((v) => v.name === '--accent').color && !tiny.variables.find((v) => v.name === '--gap').color);
ok('nothing at all is an empty sheet, not an error', analyzeTheme('').classes.length === 0 && analyzeTheme(undefined).name === '');

ok('Marp\'s own three have sheets', ['default', 'gaia', 'uncover'].every((n) => builtInSheet(n)?.classes.length >= 1));
ok('gaia\'s include lead', builtInSheet('gaia').classes.some((c) => c.name === 'lead'));
ok('a name that is not one of them has none', builtInSheet('psy415-dsu') === null && Object.keys(BUILT_IN_SHEETS).length === 3);

const sample = sampleDeck(dsu);
const slides = sample.split(/\n---\n/).slice(1);
ok(`the sample deck is in the theme, one slide plus one per class (${slides.length})`, /theme: psy415-dsu/.test(sample) && slides.length === dsu.classes.length + 1);
ok('each class slide carries its class', dsu.classes.every((c) => sample.includes(`<!-- _class: ${c.name} -->`)));
ok('the directives cover Marp\'s and Podium\'s own', ['theme', '_class', 'paginate', 'size', 'build', '_video', 'mermaidTheme'].every((d) => DIRECTIVES.some((x) => x.name.includes(d))));

// --- quick settings ------------------------------------------------------------------------
const css = '/* @theme x */\nsection { color: red; }\n';
ok('a theme without quick settings has none', readQuickSettings(css) === null);
const set = writeQuickSettings(css, { bg: '#FFFFFF', fg: '#222222', heading: '#00753e', accent: '#2596BE', font: 'Georgia, serif' });
ok('they are written after everything else', set.indexOf('section { color: red; }') < set.indexOf('podium:quick-settings'));
ok('and read back as written', JSON.stringify(readQuickSettings(set)) === JSON.stringify({ bg: '#ffffff', fg: '#222222', font: 'Georgia, serif', heading: '#00753e', accent: '#2596be' }));
const again = writeQuickSettings(set, { bg: '#000000' });
ok('writing again replaces the block rather than adding another', (again.match(/podium:quick-settings -/g) || []).length === 1 && readQuickSettings(again).bg === '#000000' && readQuickSettings(again).fg === '');
ok('setting nothing removes the block, leaving the theme as it was', writeQuickSettings(again, {}) === css);
const hostile = writeQuickSettings(css, { bg: 'red; } body { display: none', font: 'Arial; } section { display: none' });
const block = hostile.slice(hostile.indexOf('/* podium:quick-settings'));
ok('a colour that is not #rrggbb is not written', readQuickSettings(hostile).bg === '' && !/background-color/.test(block));
ok('and a font cannot open or close a rule: the block has only the one rule it writes', (block.match(/\{/g) || []).length === 1 && (block.match(/\}/g) || []).length === 1);

if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
