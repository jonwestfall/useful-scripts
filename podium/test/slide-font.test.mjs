// One typeface for slides on every device (assets/js/slide-font.js).
//
// A theme starting its fonts with "Helvetica Neue", Arial got Helvetica Neue
// on the iPad and Arial on a Windows projector; Helvetica Neue is wider, so a
// table wrapped more on the iPad and ink drawn under a line there landed on
// empty space on the wall. Podium puts its own Arial-wide face in front.
//
//   node podium/test/slide-font.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = path.join(ROOT, 'assets', 'vendor', 'slide-fonts');

// embedSlideFont fetches the faces; here they come off the disk.
globalThis.fetch = async (url) => {
  const file = path.join(FONT_DIR, path.basename(new URL(url).pathname));
  if (!fs.existsSync(file)) return { ok: false, status: 404 };
  const buf = fs.readFileSync(file);
  return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};
globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64');

const { SLIDE_FONT, SLIDE_FONT_FACES, sameFontCss, usesSlideFont, embedSlideFont } = await import('../assets/js/slide-font.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const F = `'${SLIDE_FONT}'`;

console.log('-- which font lists get Podium\'s face --');
const theme = 'div.marpit>section{font-family:"Helvetica Neue", Arial, "Segoe UI", sans-serif;font-size:28px}';
ok('the course theme\'s list: Podium\'s face first, the rest kept', sameFontCss(theme).includes(`font-family: ${F}, "Helvetica Neue", Arial, "Segoe UI", sans-serif;`));
ok('Arial first', sameFontCss('h1{font-family: Arial, sans-serif}') === `h1{font-family: ${F}, Arial, sans-serif}`);
ok('Helvetica first, unquoted, any case', sameFontCss('p{font-family:HELVETICA,sans-serif}').includes(`${F}, HELVETICA`));
ok('!important kept', sameFontCss('p{font-family:Arial !important}') === `p{font-family: ${F}, Arial !important}`);
ok('the font shorthand', sameFontCss('h2{font:700 48px/1.08 "Helvetica Neue", Arial}') === `h2{font:700 48px/1.08 ${F}, "Helvetica Neue", Arial}`);
ok('the font shorthand without a line height', sameFontCss('h2{font: italic 2em Arial}') === `h2{font: italic 2em ${F}, Arial}`);
for (const css of [
  'section{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}',
  'section{font-family:"Lato","Avenir Next",Avenir,"Trebuchet MS",sans-serif}',
  'code{font-family:Consolas,"SFMono-Regular","Courier New",monospace}',
  'section{font-family:"Arial Narrow",sans-serif}',
  'h1{font:700 48px/1.1 Lato, Arial}',
  'section{font-size:28px;line-height:1.32}',
]) ok(`left alone: ${css}`, sameFontCss(css) === css);
ok('an @font-face naming Arial is not touched', sameFontCss('@font-face{font-family:Arial;src:url(a.woff2)}p{font-family:Arial}') === `@font-face{font-family:Arial;src:url(a.woff2)}p{font-family: ${F}, Arial}`);
ok('usesSlideFont: yes after the swap', usesSlideFont(sameFontCss(theme)));
ok('usesSlideFont: no for a theme with its own fonts', !usesSlideFont(sameFontCss('section{font-family:Lato}')));

console.log('\n-- the faces --');
const onDisk = fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2')).sort();
ok('every face declared is vendored, and nothing else', JSON.stringify(SLIDE_FONT_FACES.map((f) => f[0]).sort()) === JSON.stringify(onDisk));
ok('regular, bold, italic and bold italic', ['400 normal', '400 italic', '700 normal', '700 italic'].every((want) => SLIDE_FONT_FACES.some((f) => `${f[1]} ${f[2]}` === want)));
ok('the font\'s licence comes with it', fs.existsSync(path.join(FONT_DIR, 'LICENSE')) && /SIL Open Font License/.test(fs.readFileSync(path.join(FONT_DIR, 'LICENSE'), 'utf8')));

console.log('\n-- inside a slide drawn as an image --');
const css = sameFontCss(theme);
const plain = await embedSlideFont(css, '<section><h1>Four questions</h1></section>');
const faces = plain.match(/@font-face\{[^}]*\}/g) || [];
ok('the latin faces come as data', faces.length === 4 && faces.every((f) => /src:url\('data:font\/woff2;base64,[A-Za-z0-9+/=]{1000,}'\)/.test(f)));
ok('and the slide\'s own rules after them', plain.endsWith(css));
const accented = await embedSlideFont(css, '<section><p>Łukasz Dąbrowski</p></section>');
ok('text past latin brings the latin-ext faces too', (accented.match(/@font-face\{/g) || []).length === 8);
ok('a stylesheet not using the face is as it was', await embedSlideFont('p{font-family:Lato}', '<p>x</p>') === 'p{font-family:Lato}');

if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
