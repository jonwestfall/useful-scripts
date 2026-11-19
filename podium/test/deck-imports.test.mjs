// A deck's @imports, taken out of the slide's own stylesheet (hoistImports in
// assets/js/deck.js). Safari applies none of a sheet's rules until its
// @imports have loaded, so a slide whose theme imports webfonts from another
// site (Gaia does) was unstyled for as long as that took - and measured
// unstyled, it always "fit", so an over-full slide was shown cut off.
//
//   node podium/test/deck-imports.test.mjs

import { hoistImports } from '../assets/js/deck.js';

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const gaia = '@charset "UTF-8";@import "https://fonts.bunny.net/css?family=Lato:400,900|Roboto+Mono:400,700&display=swap";div.marpit > svg > foreignObject > section{width:1280px;height:720px}';
const one = hoistImports(gaia);
ok('Gaia\'s webfont import is taken out', !/@import/.test(one.css));
ok('and named, whole', same(one.imports, [{ href: 'https://fonts.bunny.net/css?family=Lato:400,900|Roboto+Mono:400,700&display=swap', media: '' }]));
ok('every other rule is kept as it was', one.css === '@charset "UTF-8";div.marpit > svg > foreignObject > section{width:1280px;height:720px}');

const forms = hoistImports(`@import url(https://a.example/one.css);
@import url("https://a.example/two.css") screen and (min-width: 600px);
@import 'https://a.example/three.css' print;
section { color: red }`);
ok('url(), quoted url(), and a bare string', same(forms.imports.map((i) => i.href), ['https://a.example/one.css', 'https://a.example/two.css', 'https://a.example/three.css']));
ok('with their media', same(forms.imports.map((i) => i.media), ['', 'screen and (min-width: 600px)', 'print']));
ok('leaving the rules', forms.css.trim() === 'section { color: red }');

ok('a stylesheet with none is as it was', hoistImports('section{color:red}').css === 'section{color:red}' && hoistImports('section{color:red}').imports.length === 0);
ok('"@import" inside a value is not a rule', hoistImports('section::after{content:"@import"}').imports.length === 0);
ok('nothing in, nothing out', same(hoistImports(undefined), { css: '', imports: [] }));

if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
