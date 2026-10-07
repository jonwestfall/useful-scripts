// Diagrams in decks (Issue #235): which theme a diagram is drawn in, and what
// a slide says when one cannot be drawn. Drawing itself needs a browser and
// is covered by the editor's end-to-end group.
//
//   node podium/test/deck-mermaid.test.mjs

import { diagramConfig, describeError } from '../assets/js/deck-mermaid.js';
import { MERMAID_THEMES } from '../assets/js/deck-source.js';

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};

// Slides as getComputedStyle reads them (see slideLooks in deck-mermaid.js).
const plain = { background: 'rgb(255, 255, 255)', color: 'rgb(36, 41, 47)', heading: 'rgb(36, 41, 47)', fontFamily: 'Helvetica, sans-serif', fontSize: 29 };
const inverted = { ...plain, background: 'rgb(13, 17, 23)', color: 'rgb(230, 237, 243)', heading: 'rgb(230, 237, 243)' };
const gaia = {
  background: 'rgb(255, 248, 225)', color: 'rgb(69, 90, 100)', heading: 'rgb(69, 90, 100)',
  highlight: 'rgb(2, 136, 209)', fontFamily: 'Lato, sans-serif', fontSize: 35,
};
const branded = {
  background: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(135deg, rgb(255, 255, 255) 0%, rgb(245, 250, 247) 100%)',
  color: 'rgb(38, 50, 56)', heading: 'rgb(0, 117, 62)', highlight: 'rgb(2, 136, 209)', fontFamily: 'Arial', fontSize: 28,
};
const greenLead = {
  ...branded, color: 'rgb(255, 255, 255)', heading: 'rgb(255, 255, 255)',
  backgroundImage: 'linear-gradient(135deg, rgb(0, 75, 39) 0%, rgb(0, 117, 62) 50%, rgb(0, 133, 66) 100%)',
};

console.log('-- the deck decides, by default --');
chk('a light slide gets Mermaid\'s default theme', diagramConfig(plain).theme === 'default');
chk('a dark one its dark theme', diagramConfig(inverted).theme === 'dark');
chk('in the slide\'s type', diagramConfig(plain).fontFamily === 'Helvetica, sans-serif');
const g = diagramConfig(gaia);
chk('a theme that names its colours (gaia) gets them', g.theme === 'base' && g.themeVariables.primaryBorderColor === '#0288d1'
  && g.themeVariables.textColor === '#455a64' && g.themeVariables.background === '#fff8e1' && g.themeVariables.darkMode === false);
const b = diagramConfig(branded);
chk('a heading in its own colour is the accent (a course\'s brand colour)', b.themeVariables.primaryBorderColor === '#00753e');
chk('a gradient background is read from its colours', b.themeVariables.darkMode === false && /^#f[0-9a-f]{5}$/.test(b.themeVariables.background));
const lead = diagramConfig(greenLead);
chk('a dark gradient is dark', lead.themeVariables.darkMode === true);
chk('where the heading is the text colour, the theme\'s highlight is the accent', lead.themeVariables.primaryBorderColor === '#0288d1');
const parts = Array.from({ length: 12 }, (_, i) => g.themeVariables[`pie${i + 1}`]);
chk('a pie\'s slices are twelve different colours', parts.every(Boolean) && new Set(parts).size === 12);
chk('so are a mindmap\'s branches, with text that reads on them',
  new Set(Array.from({ length: 12 }, (_, i) => lead.themeVariables[`cScale${i}`])).size === 12 && lead.themeVariables.cScaleLabel0 === '#ffffff');

console.log('-- mermaidTheme beats it --');
for (const theme of MERMAID_THEMES) chk(`mermaidTheme: ${theme}`, diagramConfig(gaia, theme).theme === theme);
chk('base keeps the deck\'s colours', diagramConfig(plain, 'base').themeVariables.textColor === '#24292f');
chk('a theme Mermaid does not have is ignored (and flagged by checkDeck)', diagramConfig(inverted, 'drak').theme === 'dark');

console.log('-- and nothing beats strict --');
chk('every diagram is drawn with securityLevel strict', [plain, inverted, gaia, branded].every((look) => diagramConfig(look, 'base').securityLevel === 'strict'));
chk('and is never looked for on the page by Mermaid itself', diagramConfig(plain).startOnLoad === false);

console.log('-- when a diagram cannot be drawn --');
const parse = describeError(new Error("Parse error on line 3:\n...A -->\n-------^\nExpecting 'AMP', 'COLON', got 'EOF'"), 'flowchart LR\n  A -->\n');
chk(`Mermaid's parse error, short, with what it expected (${parse.message})`, /^Parse error on line 3: Expecting 'AMP'/.test(parse.message) && !parse.message.includes('^'));
chk('and the line it is about', parse.line === 3);
chk('an unknown first line says what one should be', /does not recognise the first line/.test(describeError(new Error('No diagram type detected matching given configuration for text: flowchat LR'), 'flowchat LR').message));
chk('an empty diagram says so', describeError(new Error('No diagram type detected matching given configuration for text: '), '').message === 'This diagram is empty.');
chk('a very long complaint is cut short', describeError(new Error('x'.repeat(5000))).message.length <= 400);
chk('something thrown that is not an Error still says something', describeError('boom').message === 'boom' && describeError(undefined).message.length > 0);

if (!ok) process.exit(1);
console.log('all deck-mermaid checks passed');
