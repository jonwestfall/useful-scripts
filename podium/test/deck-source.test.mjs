// Run with: node podium/test/deck-source.test.mjs
// Issue #226: the deck editor's model of a Marp deck. Two promises, both
// checked against the real Marp engine (the same vendored bundle the
// projector uses):
//   - the markdown round-trips byte for byte, so open-and-save changes nothing;
//   - the slides found are the slides Marp renders.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDeck, serializeDeck, moveSlide, duplicateSlide, deleteSlide, insertSlide,
  setSlideDirective, setSlideBuild, setSlideNotes, setFrontMatter, slideAt, checkDeck, commentsIn,
  setSlideVideo, parseTimecode, formatTimecode, PODIUM_DIRECTIVES,
} from '../assets/js/deck-source.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};

// The vendored Marp bundle expects a browser; these are all it touches at load.
for (const name of ['HTMLElement', 'HTMLHeadingElement', 'HTMLSpanElement']) globalThis[name] ??= class {};
globalThis.customElements ??= { define() {}, get() {} };
const { Marp } = await import('../assets/vendor/marp.esm.js');
// Configured as deck.js configures it, Podium's own directives included.
const newMarp = () => {
  const marp = new Marp({ inlineSVG: true, html: true, math: 'katex' });
  for (const key of PODIUM_DIRECTIVES) marp.customDirectives.local[key] = () => ({});
  return marp;
};
const marpSlides = (md) => {
  const marp = newMarp();
  return (marp.render(md).html.match(/<svg data-marpit-svg/g) || []).length;
};
const marpNotes = (md) => {
  const marp = newMarp();
  return marp.render(md).comments.map((list) => list.join('\n\n').trim());
};

console.log('-- every committed deck --');
const decks = fs.readdirSync(path.join(ROOT, 'content', 'decks')).filter((f) => f.endsWith('.md'))
  .map((f) => [f, fs.readFileSync(path.join(ROOT, 'content', 'decks', f), 'utf8')]);
for (const [name, md] of decks) {
  const deck = parseDeck(md);
  chk(`${name}: round-trips byte for byte`, serializeDeck(deck) === md);
  const theirs = marpSlides(md);
  chk(`${name}: ${deck.slides.length} slides, the same as Marp (${theirs})`, deck.slides.length === theirs);
  const notes = marpNotes(md);
  chk(`${name}: the same presenter notes as Marp`, deck.slides.every((s, i) => s.notes === (notes[i] || '')));
}

console.log('-- where a slide starts, edge by edge --');
const cases = {
  'plain separator': 'a\n\n---\n\nb',
  'a --- under text is a heading, not a slide': 'text\n---\nb',
  'under a picture too': '![bg](x.png)\n---\n\nb',
  '*** always separates': 'text\n***\nb',
  '___ always separates': 'text\n___\nb',
  'spaced - - -': 'a\n\n- - -\n\nb',
  'longer -----': 'a\n\n-----\n\nb',
  'after a heading': '## h\n---\nb',
  'after a list item': '- a\n---\nb',
  'after a quote': '> q\n---\nb',
  'after a table': '| a |\n|---|\n| 1 |\n---\nb',
  'after a one-line comment': '<!-- _class: x -->\n---\nb',
  'inside a multi-line comment': 'a\n\n<!--\n---\n-->\n\nb',
  'inside a ``` fence': 'a\n\n```\n---\n```\nb',
  'inside a ~~~ fence': 'a\n\n~~~\n---\n~~~\nb',
  'a longer fence is not closed by a shorter one': 'a\n\n````\n```\n---\n````\nb',
  'indented four spaces is code': 'a\n\n    ---\n\nb',
  'inside an HTML block': '<div>x</div>\n---\n\nb',
  '=== under text is a heading': 'a\n===\n\nb',
  'front matter is not a slide break': '---\nmarp: true\n---\n\n# A\n\n---\n\n# B',
  'front matter only': '---\nmarp: true\n---\n',
  'empty deck': '',
  'CRLF line endings': 'a\r\n\r\n---\r\n\r\nb\r\n',
  'no final newline': '# A\n\n---\n\n# B',
};
for (const [label, md] of Object.entries(cases)) {
  const deck = parseDeck(md);
  const theirs = marpSlides(md);
  chk(`${label}: ${deck.slides.length} = Marp ${theirs}, and round-trips`, deck.slides.length === theirs && serializeDeck(deck) === md);
}

console.log('-- what each slide says about itself --');
{
  const md = [
    '---', 'marp: true', 'theme: gaia', 'paginate: true', '---', '',
    '<!-- _class: lead -->', '# Title slide', '', '<!--', 'Say hello.', '-->', '',
    '---', '', '<!-- class: invert -->', '## Carries forward', '- one', '',
    '---', '', '<!-- _class: build -->', '## Builds', '- a', '- b', '',
    '---', '', '## Still invert', '![w:300 A chart](/media/abc/chart.png)', '<img src="/x.png">', '',
  ].join('\n');
  const deck = parseDeck(md);
  chk('front matter fields are read', deck.frontMatter.fields.theme === 'gaia' && deck.frontMatter.fields.paginate === 'true');
  chk('titles come from the first heading', deck.slides.map((s) => s.title).join('|') === 'Title slide|Carries forward|Builds|Still invert');
  chk('a _class applies to its slide only', deck.slides[0].classes.join() === 'lead');
  chk('a class: carries forward', deck.slides[1].classes.join() === 'invert' && deck.slides[3].classes.join() === 'invert');
  chk('a _class overrides it for one slide', deck.slides[2].classes.join() === 'build' && deck.slides[2].hasBuild);
  chk('notes are the comments that are not directives', deck.slides[0].notes === 'Say hello.' && deck.slides[1].notes === '');
  const media = deck.slides[3].media;
  chk('pictures are found, with their alt text and options',
    media.length === 2 && media[0].src === '/media/abc/chart.png' && media[0].alt === 'A chart'
    && media[0].options.includes('w:300') && media[1].kind === 'html' && media[1].alt === null);
  const comments = commentsIn('<!-- _class: a -->\n<!-- just a note: with a colon -->');
  chk('a comment is a directive only if every key is one', comments[0].directive && !comments[1].directive);
}

console.log('-- structural edits --');
{
  const md = '---\nmarp: true\n---\n\n# One\n\n---\n\n# Two\n\n---\n\n# Three';
  const titles = (text) => parseDeck(text).slides.map((s) => s.title).join(',');
  const moved = moveSlide(md, 2, 0);
  chk(`moving the last slide (no final newline) to the front (${titles(moved)})`, titles(moved) === 'Three,One,Two');
  chk('still three slides to Marp', marpSlides(moved) === 3);
  const back = moveSlide(moved, 0, 2);
  chk('and back again', titles(back) === 'One,Two,Three' && marpSlides(back) === 3);
  chk('a slide whose text runs to the end gets a blank line before its new separator, not a heading underline',
    titles(moveSlide('# A\n\n---\n\ntext without a blank line', 1, 0)) === ',A' && marpSlides(moveSlide('# A\n\n---\n\ntext', 1, 0)) === 2);
  const dup = duplicateSlide(md, 1);
  chk(`duplicate (${titles(dup)})`, titles(dup) === 'One,Two,Two,Three' && marpSlides(dup) === 4);
  const del = deleteSlide(md, 0);
  chk(`delete (${titles(del)})`, titles(del) === 'Two,Three' && del.startsWith('---\nmarp: true\n---\n'));
  chk('the last slide cannot be deleted', deleteSlide('# Only', 0) === '# Only');
  const ins = insertSlide(md, 1, '## Inserted\n');
  chk(`insert (${titles(ins)})`, titles(ins) === 'One,Inserted,Two,Three' && marpSlides(ins) === 4);
  chk('inserting into an empty deck fills its one empty slide', parseDeck(insertSlide('', 0, '# First')).slides.length === 1);
  chk('slides that were not touched keep their exact text',
    parseDeck(moveSlide(md, 0, 1)).slides.find((s) => s.title === 'Two').raw === parseDeck(md).slides[1].raw);
}

console.log('-- directives, builds, notes, front matter --');
{
  const md = '---\nmarp: true\n---\n\n# One\n\n---\n\n## Two\n- a\n- b\n';
  const built = setSlideBuild(md, 1, true);
  chk('Build adds <!-- _class: build --> to that slide', parseDeck(built).slides[1].hasBuild && built.includes('<!-- _class: build -->'));
  chk('and only that slide', !parseDeck(built).slides[0].hasBuild);
  const unbuilt = setSlideBuild(built, 1, false);
  chk('turning it off removes the directive line again', unbuilt === md);
  const lead = setSlideDirective(md, 0, 'class', 'lead');
  const both = setSlideBuild(lead, 0, true);
  chk('Build keeps a slide\'s other classes', parseDeck(both).slides[0].classes.join(' ') === 'lead build');
  const multi = '# A\n\n<!--\n_class: lead\n_paginate: false\n-->\n';
  const edited = setSlideDirective(multi, 0, 'class', 'invert');
  chk('a directive inside a multi-line comment is edited where it is', edited === '# A\n\n<!--\n_class: invert\n_paginate: false\n-->\n');
  chk('and removed from it without touching the other', setSlideDirective(multi, 0, 'class', null) === '# A\n\n<!--\n_paginate: false\n-->\n');
  const bg = setSlideDirective(md, 1, 'backgroundColor', '#fffbe6');
  chk('a colour directive is written so Marp reads it', parseDeck(bg).slides[1].directives.backgroundColor === '#fffbe6' && marpSlides(bg) === 2);

  const noted = setSlideNotes(md, 1, 'Ask who has seen this before.');
  chk('notes are written as a comment Marp reads as notes', marpNotes(noted)[1] === 'Ask who has seen this before.');
  const renoted = setSlideNotes(noted, 1, 'Changed.');
  chk('setting them again replaces, not appends', marpNotes(renoted)[1] === 'Changed.' && parseDeck(renoted).slides[1].notes === 'Changed.');
  chk('clearing them removes the comment', !setSlideNotes(renoted, 1, '').includes('<!--'));
  chk('a note containing --> cannot end the comment early', marpNotes(setSlideNotes(md, 0, 'arrow --> here'))[0].includes('arrow'));
  chk('directives are not notes', parseDeck(setSlideNotes(built, 1, 'Hi')).slides[1].directives.class === 'build');

  const themed = setFrontMatter(md, 'theme', 'gaia');
  chk('a front matter field is added before the closing ---', parseDeck(themed).frontMatter.fields.theme === 'gaia' && marpSlides(themed) === 2);
  chk('and changed in place', parseDeck(setFrontMatter(themed, 'theme', 'uncover')).frontMatter.fields.theme === 'uncover');
  chk('and removed', !('theme' in parseDeck(setFrontMatter(themed, 'theme', null)).frontMatter.fields));
  const fresh = setFrontMatter('# A\n', 'size', '4:3');
  chk('a deck with no front matter gets one, with marp: true', fresh.startsWith('---\nmarp: true\nsize: "4:3"\n---\n') && marpSlides(fresh) === 1);
}

console.log('-- where the cursor is --');
{
  const md = '# One\n\n---\n\n# Two\n\n---\n\n# Three\n';
  const deck = parseDeck(md);
  chk('a cursor in the first slide', slideAt(deck, 2) === 0);
  chk('on the second slide\'s heading', slideAt(deck, md.indexOf('# Two')) === 1);
  chk('on a separator belongs to the slide after it', slideAt(deck, md.lastIndexOf('---')) === 2);
  chk('at the very end', slideAt(deck, md.length) === 2);
}

console.log('-- checks --');
{
  const md = [
    '# A', '![](images/x.png)', '![bg](https://example.org/bg.png)', '![Chart](http://example.org/c.png)',
    '![x](data:image/png;base64,AAAA)', '', '```js', 'never closed',
  ].join('\n');
  const found = checkDeck(md, { destination: 'library', pageProtocol: 'https:' });
  const says = (re) => found.some((f) => re.test(f.message));
  chk('a relative path in a library deck', says(/relative path/));
  chk('http: media on an https: page', says(/is http:/));
  chk('a picture with no alt text', says(/no description/));
  chk('a background picture needs none', found.filter((f) => /no description/.test(f.message)).length === 1);
  chk('a pasted-in data: picture', says(/pasted into the deck/));
  chk('an unclosed code block', says(/never closed/));
  chk('relative paths are fine in a plain file', !checkDeck(md, { destination: 'file' }).some((f) => /relative path/.test(f.message)));
  chk('each finding knows its slide and where it is', found.every((f) => f.slide === 0 && Number.isInteger(f.offset)));
  chk('a headingDivider deck says why slide moves are off', checkDeck('---\nheadingDivider: 2\n---\n# A\n## B').some((f) => /headingDivider/.test(f.message)));
}

console.log('-- video slides (Phase 2) --');
{
  chk('1:05 is 65 seconds', parseTimecode('1:05') === 65);
  chk('1:02:03 is 3723 seconds', parseTimecode('1:02:03') === 3723);
  chk('a bare number is seconds', parseTimecode('90') === 90 && parseTimecode('2.5') === 2.5);
  chk('nonsense is 0', parseTimecode('soon') === 0 && parseTimecode('') === 0 && parseTimecode(undefined) === 0);
  chk('written back as m:ss', formatTimecode(65) === '1:05' && formatTimecode(0) === '0:00' && formatTimecode(3723) === '1:02:03');

  const md = '---\nmarp: true\n---\n\n# One\n\n---\n\n## Two\n\n<!-- What to say. -->\n\n---\n\n# Three\n';
  const made = setSlideVideo(md, 1, { src: '/media/abc/clip.webm', start: 65, poster: '/media/def/clip-poster.jpg' });
  const slide = parseDeck(made).slides[1];
  chk('a video slide knows its video', slide.video?.src === '/media/abc/clip.webm');
  chk('and where it starts', slide.video?.start === 65);
  chk('its poster is a background picture', slide.media.some((m) => m.background && m.src === '/media/def/clip-poster.jpg'));
  chk('the directives are directives, not presenter notes', slide.notes === 'What to say.');
  chk('Marp agrees: the slide\'s notes are only the note', marpNotes(made)[1] === 'What to say.');
  chk('and makes no extra slide of it', marpSlides(made) === 3);
  chk('the other slides are untouched', parseDeck(made).slides[0].raw === parseDeck(md).slides[0].raw && parseDeck(made).slides[2].raw === parseDeck(md).slides[2].raw);
  chk('a video slide round-trips', serializeDeck(parseDeck(made)) === made);
  chk('the video is only on its own slide', parseDeck(made).slides[2].video === null);
  chk('written the way the spec shows it', /<!-- _video: \/media\/abc\/clip\.webm -->\n<!-- _videoStart: "1:05" -->\n!\[bg contain\]\(\/media\/def\/clip-poster\.jpg\)/.test(made));

  const again = setSlideVideo(made, 1, { src: '/media/abc/clip.webm', start: 0, poster: '/media/def/clip-poster.jpg' });
  chk('setting it again does not add a second poster', parseDeck(again).slides[1].media.length === 1);
  chk('a start of 0 is no _videoStart', parseDeck(again).slides[1].video.start === 0 && !again.includes('_videoStart'));
  const removed = setSlideVideo(made, 1, {});
  chk('removing it takes the directives away', parseDeck(removed).slides[1].video === null && !removed.includes('_video'));
  chk('and leaves the poster as a plain picture', parseDeck(removed).slides[1].media.length === 1);

  chk('a plain `video:` (not `_video:`) is no video slide', parseDeck('<!-- video: /media/a/b.webm -->\n# A').slides[0].video === null);

  const checks = (text, opts) => checkDeck(text, opts).map((f) => f.message).join('\n');
  chk('a video slide with no poster is flagged', /no poster/.test(checks('<!-- _video: /media/a/b.webm -->\n# A')));
  chk('one with a poster is not', !/no poster/.test(checks(made)));
  chk('a relative video address is flagged', /not a full address/.test(checks('<!-- _video: clip.webm -->\n![bg](/media/p.jpg)')));
  chk('an http: video on an https: page is flagged', /is http:/.test(checks('<!-- _video: http://example.org/v.mp4 -->\n![bg](/media/p.jpg)', { pageProtocol: 'https:' })));
}

if (!ok) process.exit(1);
console.log('all deck-source checks passed');
