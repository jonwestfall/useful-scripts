// Math in decks and documents (assets/js/math-fonts.js): KaTeX's fonts come
// from Podium, every one Marp's stylesheet names is here, and the places a
// slide is shown from - the page, a kiosk, offline - all have them. Without
// them a slide's "a ≠ b" reads "a = b": the slash is a glyph of KaTeX_Main's.
//
//   node podium/test/math-fonts.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const { MATH_FONT_DIR, mathFontFaces, localMathCss, embedMathFonts } = await import('../assets/js/math-fonts.js');
// The vendored Marp bundle expects a browser; these are all it touches at load.
for (const name of ['HTMLElement', 'HTMLHeadingElement', 'HTMLSpanElement']) globalThis[name] ??= class {};
globalThis.customElements ??= { define() {}, get() {} };
const { Marp, katexCss } = await import('../assets/vendor/marp.esm.js');

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

const FONT_DIR = path.join(ROOT, 'assets', 'vendor', 'katex-fonts');
const vendored = fs.readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2')).sort();

console.log('-- where the fonts come from --');
ok(`the fonts are next to the other bundles (${MATH_FONT_DIR})`, MATH_FONT_DIR === pathToFileURL(FONT_DIR).href + '/');

// A deck rendered as deck.js renders one.
const marp = new Marp({ inlineSVG: true, html: true, math: { lib: 'katex', katexFontPath: MATH_FONT_DIR } });
const { html, css } = marp.render('---\nmarp: true\nmath: katex\n---\n\n# Math\n\n$a \\neq b$\n\n$$\n\\sum_{i=1}^n x_i \\neq \\int_0^1 f\n$$\n');
const faces = mathFontFaces(css);
ok(`a deck with math declares KaTeX's faces (${faces.length})`, faces.length >= 20);
ok('none of them points at a CDN', !/jsdelivr|https?:\/\//.test(faces.join('\n')));
const named = [...new Set([...css.matchAll(/KaTeX_[\w-]+?\.woff2/g)].map((m) => m[0]))].sort();
const missing = named.filter((f) => !vendored.includes(f));
ok(`every font the stylesheet names is vendored (${named.length} named${missing.length ? `; missing ${missing.join(', ')}` : ''})`, named.length >= 20 && !missing.length);
ok('≠ is drawn with KaTeX\'s own slash (U+E020, in KaTeX_Main alone), which is why the font matters', /\uE020/.test(html));

console.log('\n-- documents --');
const docCss = localMathCss(katexCss);
ok('a document\'s KaTeX stylesheet reads the same fonts', mathFontFaces(docCss).length === faces.length
  && mathFontFaces(docCss).every((face) => face.includes(MATH_FONT_DIR)) && !/url\(fonts\//.test(docCss));

console.log('\n-- a slide rasterized on its own --');
const stub = 'data:font/woff2;base64,';
globalThis.fetch = async (url) => {
  const file = fileURLToPath(url);
  return fs.existsSync(file) ? new Response(fs.readFileSync(file)) : new Response('', { status: 404 });
};
const withMath = await embedMathFonts(css, html);
ok('with math in it, its fonts travel inside it as data', mathFontFaces(withMath).length === faces.length
  && mathFontFaces(withMath).every((face) => face.includes(stub)) && !withMath.includes(MATH_FONT_DIR));
const plain = await embedMathFonts(css, '<section><h1>No maths here</h1></section>');
ok('without, they are left out rather than carried for nothing', mathFontFaces(plain).length === 0 && plain.includes('section'));
ok('a stylesheet with no faces is as it was', await embedMathFonts('section{color:red}', html) === 'section{color:red}');

console.log('\n-- every place a slide is shown from has them --');
const sandbox = { self: { addEventListener() {} }, globalThis: {} };
vm.runInNewContext(`${fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8')}\nglobalThis.__WARM = WARM;`, sandbox);
const warm = new Set(sandbox.globalThis.__WARM);
const notWarm = vendored.filter((f) => !warm.has(`assets/vendor/katex-fonts/${f}`));
ok(`offline: the service worker keeps them all${notWarm.length ? ` - missing ${notWarm.join(', ')}` : ''}`, !notWarm.length);
const { KIOSK_OPEN_PATHS, VIEW_OPEN_PATHS } = require('../server/open-paths.js');
const shut = vendored.filter((f) => !KIOSK_OPEN_PATHS.has(`/assets/vendor/katex-fonts/${f}`) || !VIEW_OPEN_PATHS.has(`/assets/vendor/katex-fonts/${f}`));
ok(`a kiosk and a Guest View viewer may load them all${shut.length ? ` - not: ${shut.join(', ')}` : ''}`, !shut.length);
ok('and KaTeX\'s licence comes with them', fs.existsSync(path.join(FONT_DIR, 'LICENSE')));

if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log('\nALL PASS');
