// Tables' columns, decided by Podium rather than each browser (shareColumns
// in assets/js/deck.js). Safari and Chrome share a table's width out by their
// own rules, so a label column wrapped on the iPad only and ink drawn below
// the table there landed off on the projector. Podium shares it out by the
// CSS Tables rule Chrome follows, from each column's min- and max-content
// widths, and fixes the result into the deck.
//
//   node podium/test/table-columns.test.mjs

import { shareColumns } from '../assets/js/deck.js';

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };
const near = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 0.01);
const pct = (widths) => { const t = widths.reduce((a, b) => a + b, 0); return widths.map((w) => w / t * 100); };

// Room for some of what each column wants: each gets its minimum, and the
// rest in proportion to how much more it would take.
{
  const min = [180, 240];
  const max = [380, 2400];
  const width = 1143;
  const t = (width - 420) / (2780 - 420);
  ok('between min and max: interpolated from the minimums toward the maximums',
    near(shareColumns(min, max, width), pct([180 + 200 * t, 240 + 2160 * t])));
}
ok('room for everything: each its widest, the rest shared by it', near(shareColumns([20, 30], [100, 300], 800), [25, 75]));
ok('exactly room for everything: each its widest', near(shareColumns([20, 30], [100, 300], 400), [25, 75]));
ok('less room than the minimums: the minimums (the table overflows)', near(shareColumns([200, 100], [400, 900], 250), pct([200, 100])));
ok('exactly the minimums', near(shareColumns([200, 100], [400, 900], 300), pct([200, 100])));
ok('a column that cannot grow keeps its minimum', near(shareColumns([50, 100], [50, 1100], 600), pct([50, 550])));
ok('three columns with room to spare: in proportion to their widest', near(shareColumns([10, 50, 40], [10, 650, 440], 1143), pct([10, 650, 440])));
ok('the shares add up to the whole table', Math.abs(shareColumns([180, 240, 90], [380, 2400, 300], 1143).reduce((a, b) => a + b, 0) - 100) < 0.01);
ok('an empty row is not a table to lay out', shareColumns([], [], 100) === null);
ok('mismatched measurements are refused', shareColumns([1, 2], [3], 100) === null);
ok('empty columns share the table evenly', near(shareColumns([0, 0], [0, 0], 500), [50, 50]));

if (fails.length) { console.log(`\nSOME TESTS FAILED (${fails.length})`); process.exit(1); }
console.log('\nALL PASS');
