// How a poll looks (assets/js/poll-look.js): whatever background a look or a
// theme brings, everything drawn on it has to read from the back of a room.
//
//   node podium/test/poll-look.test.mjs

import {
  parseColor, contrast, readable, normalizeLook, lookColors, lookVars, colorsFromSlide, PALETTES, toHex,
} from '../assets/js/poll-look.js';
import { initialState, applyCommand } from '../assets/js/protocol.js';
import { readPlan, newItem } from '../assets/js/planfile.js';

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const c = (hex) => parseColor(hex);

// --- arithmetic -----------------------------------------------------------------
ok('contrast: black on white is 21:1', Math.abs(contrast(c('#000000'), c('#ffffff')) - 21) < 0.01);
ok('contrast: a colour against itself is 1:1', Math.abs(contrast(c('#777777'), c('#777777')) - 1) < 0.001);
ok('colours are read in every form a browser reports them',
  ['#abc', '#aabbcc', 'rgb(170, 187, 204)', 'rgba(170 187 204 / 1)', 'color(srgb 0.6667 0.7333 0.8)'].every((t) => toHex(parseColor(t)) === '#aabbcc'));
ok('readable() leaves a colour that already reads alone', toHex(readable(c('#000000'), c('#ffffff'), 4.5)) === '#000000');
ok('readable() moves one that does not until it does', contrast(readable(c('#fdd835'), c('#ffffff'), 3), c('#ffffff')) >= 3);

// --- looks ------------------------------------------------------------------------
ok('no look is no look', normalizeLook(null) === null && normalizeLook('dark') === null);
ok('an unknown mode or palette falls back rather than through', JSON.stringify(normalizeLook({ mode: 'neon', palette: 'glitter' })) === '{"mode":"dark","palette":"accent"}');
ok('a theme look keeps only colours that are colours',
  JSON.stringify(normalizeLook({ mode: 'theme', theme: 'gaia', palette: 'theme', colors: { bg: '#FFF8E1', fg: '#455a64', accent: 'red;}</style><script>', extras: ['#0288d1', 'url(x)', '#111111'] } }))
    === '{"mode":"theme","palette":"theme","theme":"gaia","colors":{"bg":"#fff8e1","fg":"#455a64","accent":"#455a64","extras":["#0288d1","#111111"]}}');
ok('a theme look with no colours read in is dark', normalizeLook({ mode: 'theme', theme: 'gaia' }).mode === 'dark');

ok('the dark look is the screen a poll always had', lookColors({ mode: 'dark' }).bg === '#0a0d12' && lookColors(null).bg === '#0a0d12');
ok('the light look is light', !lookColors({ mode: 'light' }).dark && lookColors({ mode: 'light' }).bg === '#f7f8fa');
ok('its custom properties are named for the stylesheet', Object.keys(lookVars({ mode: 'light' })).join() === '--poll-bg,--poll-fg,--poll-dim,--poll-accent,--poll-track,--poll-card,--poll-ok');

// Every look, every palette, on backgrounds from white through a muddy
// mid-grey to black and a saturated brand colour: text 7:1 (4.5:1 for the
// dimmer lines), bars and accent 3:1 - or as much as that background allows.
const backgrounds = ['#ffffff', '#f7f8fa', '#fff8e1', '#9e9e9e', '#777777', '#00753e', '#1e3a8a', '#0a0d12', '#000000'];
let worst = null;
for (const bg of backgrounds) {
  for (const [palette] of PALETTES) {
    const look = { mode: 'theme', theme: 't', palette, colors: { bg, fg: '#808080', accent: '#7f7f7f', extras: ['#808081', '#ff0000'] } };
    const out = lookColors(look);
    const b = c(out.bg);
    const checks = [
      ['fg', contrast(c(out.fg), b), 7], ['dim', contrast(c(out.dim), b), 4.5], ['accent', contrast(c(out.accent), b), 3],
      ...out.palette.map((p, i) => [`palette ${i}`, contrast(c(p), b), 3]),
    ];
    // On a mid grey nothing reaches 7:1; there the best any colour can do is the bar.
    const best = Math.max(contrast(c('#000000'), b), contrast(c('#ffffff'), b));
    for (const [what, ratio, want] of checks) {
      const need = Math.min(want, best);
      if (ratio < need - 0.01 && !worst) worst = `${bg} ${palette} ${what} ${ratio.toFixed(2)} < ${need.toFixed(2)}`;
    }
  }
}
ok(`everything reads on every background, in every palette${worst ? ` (${worst})` : ''}`, !worst);

ok('one colour is one colour', lookColors({ mode: 'dark', palette: 'accent' }).palette.length === 1);
ok('primary colours are four', lookColors({ mode: 'dark', palette: 'primary' }).palette.length === 4);
ok('rainbow is seven, all different', new Set(lookColors({ mode: 'light', palette: 'rainbow' }).palette).size === 7);
ok('shades are distinct shades', new Set(lookColors({ mode: 'dark', palette: 'shades' }).palette).size >= 4);
ok('a theme with one colour of its own still gets a few to tell bars apart',
  lookColors({ mode: 'theme', palette: 'theme', colors: { bg: '#ffffff', fg: '#222222', accent: '#00753e', extras: [] } }).palette.length >= 3);

// --- reading a theme from a slide ----------------------------------------------------
const gaia = colorsFromSlide({
  background: 'rgb(255, 248, 225)', color: 'rgb(69, 90, 100)', heading: 'rgb(69, 90, 100)',
  subheading: 'rgb(69, 90, 100)', link: 'rgb(2, 136, 209)', strong: 'rgb(69, 90, 100)', highlight: 'rgb(2, 136, 209)',
});
ok(`a theme's background, text and its own colour are read (${JSON.stringify(gaia)})`,
  gaia.bg === '#fff8e1' && gaia.fg === '#455a64' && gaia.accent === '#0288d1' && gaia.extras.length === 0);
const gradient = colorsFromSlide({ background: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(rgb(0, 0, 0), rgb(100, 100, 100))', color: '#ffffff' });
ok('a gradient background is its colours, averaged', gradient.bg === '#323232');
ok('a theme with no colour of its own has its text colour as the accent', colorsFromSlide({ background: '#ffffff', color: '#111111' }).accent === '#111111');

// --- through the protocol and the plan ----------------------------------------------
const stageIt = (item) => { const t = initialState(); applyCommand(t, { op: 'stage', item, where: 'program' }); return t.program || t.preview; };
const staged = stageIt({ type: 'poll', pollId: 'ABCD', token: 't', question: 'Q', options: ['a', 'b'], look: { mode: 'light', palette: 'rainbow', evil: '<x>' } });
ok('a staged poll keeps its look, and only its look', JSON.stringify(staged?.look) === '{"mode":"light","palette":"rainbow"}');
ok('and a poll without one has none', !('look' in stageIt({ type: 'poll', pollId: 'ABCD', token: 't', question: 'Q', options: ['a', 'b'] })));
const poll = { ...newItem('poll'), question: 'Q', look: { mode: 'light', palette: 'primary' } };
const { plan } = readPlan(JSON.stringify({ podium: 'plan', v: 1, title: 'T', items: [poll, { ...newItem('poll'), question: 'R', look: 'pink' }] }));
ok('a planned poll keeps its look', plan.items[0].look?.mode === 'light' && plan.items[0].look.palette === 'primary');
ok('and one that is not a look is dropped', plan.items[1].look === null);

if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
