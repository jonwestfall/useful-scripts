// Diagrams in the deck editor (Issue #235, phase 2): mermaid.live links in
// and out, the diagrams to start from, which block the cursor is in, and the
// pictures a .zip export names after each diagram.
//
//   node podium/test/deck-diagrams.test.mjs

import {
  STARTERS, starterFence, fenceFor, isMermaidLiveLink, readMermaidLiveLink, fenceFromLink, mermaidLiveLink, fenceAt,
} from '../assets/js/deck-diagrams.js';
import { stripDiagramNotes, noteDiagramPictures, mediaRefs } from '../assets/js/deck-export.js';
import { parseDeck, serializeDeck, mermaidFences, commentsIn } from '../assets/js/deck-source.js';

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};

console.log('-- diagrams to start from --');
chk('every starter is a whole ```mermaid block', STARTERS.every((s) => {
  const block = starterFence(s.id);
  return block.startsWith('```mermaid\n') && block.endsWith('\n```\n') && mermaidFences(block).length === 1;
}));
chk('the ones the issue asked for are there', ['flowchart', 'sequence', 'class', 'gantt', 'pie', 'mindmap'].every((id) => STARTERS.some((s) => s.id === id)));
chk('an unknown one is nothing', starterFence('nope') === null);
chk('a block always ends its text with one newline', fenceFor('pie\n  "a" : 1\n\n\n') === '```mermaid\npie\n  "a" : 1\n```\n');

console.log('-- mermaid.live links --');
const code = 'flowchart LR\n  A[Cause] --> B[Effect]\n';
const link = await mermaidLiveLink(code, { theme: 'dark' });
chk(`a diagram makes a mermaid.live link (${link.slice(0, 40)}...)`, /^https:\/\/mermaid\.live\/edit#pako:[A-Za-z0-9_-]+$/.test(link));
chk('which is a link this recognises', isMermaidLiveLink(link) && isMermaidLiveLink(`  ${link}\n`));
const back = await readMermaidLiveLink(link);
chk('and reads back to the same diagram and theme', back?.code === code && back.theme === 'dark');
chk('which goes in as a block with its theme at the top', fenceFromLink(back) === `\`\`\`mermaid\n%%{init: {"theme": "dark"}}%%\n${code}\`\`\`\n`);
const plain = await readMermaidLiveLink(await mermaidLiveLink(code));
chk('Mermaid\'s default theme is left out, so the diagram follows the deck', plain.theme === null && !fenceFromLink(plain).includes('%%{init'));
chk('a diagram that sets its own theme keeps it', !fenceFromLink({ code: '%%{init: {"theme": "neutral"}}%%\npie\n', theme: 'dark' }).includes('"dark"')
  && !fenceFromLink({ code: '---\nconfig:\n  theme: base\n---\npie\n', theme: 'dark' }).includes('"dark"'));

const state = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const older = await readMermaidLiveLink(`https://mermaid.live/edit#base64:${state({ code: 'pie\n  "a" : 1', mermaid: '{"theme":"forest"}' })}`);
chk('the older #base64: links read too', older?.code === 'pie\n  "a" : 1' && older.theme === 'forest');
chk('so do /view links and mermaid.ink pictures', isMermaidLiveLink(link.replace('/edit#', '/view#')) && isMermaidLiveLink(`https://mermaid.ink/img/${link.split('#')[1]}`)
  && (await readMermaidLiveLink(`https://mermaid.ink/svg/${link.split('#')[1]}`))?.code === code);
chk('a link with other text around it is just text', !isMermaidLiveLink(`see ${link}`) && !isMermaidLiveLink('https://mermaid.live/') && !isMermaidLiveLink('https://example.org/edit#pako:abc'));
chk('a broken link holds no diagram', (await readMermaidLiveLink('https://mermaid.live/edit#pako:notreallydeflated')) === null);
chk('nor does one with no code in it', (await readMermaidLiveLink(`https://mermaid.live/edit#base64:${state({ code: '  ' })}`)) === null);
chk('an unknown theme is not carried over', (await readMermaidLiveLink(`https://mermaid.live/edit#base64:${state({ code: 'pie', mermaid: '{"theme":"neon"}' })}`)).theme === null);
const big = 'flowchart TD\n' + Array.from({ length: 400 }, (_, i) => `  n${i} --> n${i + 1}`).join('\n') + '\n';
chk('a big diagram round-trips too', (await readMermaidLiveLink(await mermaidLiveLink(big)))?.code === big);

console.log('-- the block the cursor is in --');
const md = '# One\n\n```js\nx\n```\n\n```mermaid\npie\n```\n\n---\n\n# Two\n\n```mermaid\nflowchart LR\n```\n';
const second = md.indexOf('flowchart');
chk('found from inside its text', fenceAt(md, second)?.body === 'flowchart LR\n' && fenceAt(md, second).index === 1 && fenceAt(md, second).slide === 1);
chk('and on its opening and closing lines', fenceAt(md, md.indexOf('```mermaid\npie'))?.index === 0 && fenceAt(md, md.indexOf('```\n\n---'))?.index === 0);
chk('not in other code, or outside any block', fenceAt(md, md.indexOf('x\n')) === null && fenceAt(md, md.indexOf('# Two')) === null);

console.log('-- pictures of diagrams in a .zip --');
const deck = `---\nmarp: true\n---\n\n# A\n\n\`\`\`mermaid\npie\n\`\`\`\n\n---\n\n# B\n\n\`\`\`mermaid\nflowchart LR\n\`\`\``;
const noted = noteDiagramPictures(deck, ['media/diagrams/slide-1-1.png', 'media/diagrams/slide-2-1.png']);
chk('each diagram\'s picture is named on the line after it', noted.includes('```\n<!-- diagram: media/diagrams/slide-1-1.png -->\n\n---')
  && noted.endsWith('```\n<!-- diagram: media/diagrams/slide-2-1.png -->\n'));
chk('as a directive, never a presenter note', parseDeck(noted).slides.every((s) => s.notes === '')
  && commentsIn(parseDeck(noted).slides[0].raw).some((c) => c.directive && c.directives[0].key === 'diagram'));
chk('nor a picture the deck uses', mediaRefs(noted).length === 0);
chk('and it is still the same slides', parseDeck(noted).slides.length === 2 && serializeDeck(parseDeck(noted)) === noted);
chk('a second export replaces them rather than adding more', noteDiagramPictures(noted, ['a.png', 'b.png']).match(/<!-- diagram:/g).length === 2
  && noteDiagramPictures(noted, ['media/diagrams/x.png', null]).match(/<!-- diagram:/g).length === 1);
chk('taking them out gives back the deck exactly', stripDiagramNotes(noted) === `${deck}\n` && stripDiagramNotes(deck) === deck);
chk('only an export\'s own comments are taken out', stripDiagramNotes('<!-- diagram: somewhere/else.png -->\n# A\n').includes('somewhere/else'));

if (!ok) process.exit(1);
console.log('all deck-diagrams checks passed');
