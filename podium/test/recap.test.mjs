// The lecture recap (Issue #158): how the display turns a caption bar into
// finished lines, how a session's timeline, captions, polls and kept pictures
// are put in order, and how that order is laid out into pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptionLog, continuesCaption, MAX_CAPTION_CHARS } from '../assets/js/caption-log.js';
import { buildRecap, describeEvent, captionText } from '../assets/js/recap.js';
import { planRecapPages, wrapText, RECAP_STYLE } from '../assets/js/pdf-writer.js';

// --- caption-log.js ----------------------------------------------------------

function logOf() {
  const lines = [];
  const log = createCaptionLog((line) => lines.push(line));
  return { log, lines };
}

test('interim speech results growing one phrase become ONE line, at the time it started', () => {
  const { log, lines } = logOf();
  log.observe('so the', { now: 1000, live: true });
  log.observe('so the null', { now: 1300, live: true });
  log.observe('so the null hypothesis', { now: 1600, live: true });
  log.observe('so the null hypothesis says', { now: 1900, live: true });
  assert.equal(lines.length, 0, 'nothing is written while the phrase is still being said');
  log.observe('', { now: 5000 });
  assert.deepEqual(lines, [{ at: 1000, text: 'so the null hypothesis says', live: true }]);
});

test('the recognizer revising its last word keeps the same line', () => {
  const { log, lines } = logOf();
  log.observe('we reject the know', { now: 1 });
  log.observe('we reject the null', { now: 2 });
  log.observe('we reject the null hypothesis', { now: 3 });
  log.flush();
  assert.deepEqual(lines.map((l) => l.text), ['we reject the null hypothesis']);
});

test('a new phrase on the bar finishes the old one rather than overwriting it', () => {
  const { log, lines } = logOf();
  log.observe('first we collect the data', { now: 10 });
  log.observe('then we test it', { now: 20 });
  log.observe('', { now: 30 });
  assert.deepEqual(lines.map((l) => [l.at, l.text]), [[10, 'first we collect the data'], [20, 'then we test it']]);
});

test('the same text repeated (every commit re-observes the bar) is not a new line', () => {
  const { log, lines } = logOf();
  for (let i = 0; i < 5; i++) log.observe('Welcome to week 6', { now: i });
  log.flush();
  assert.equal(lines.length, 1);
});

test('a line cut short by the recognizer is the same line, and keeps the latest text', () => {
  assert.equal(continuesCaption('the mean of the sample', 'the mean of'), true);
  const { log, lines } = logOf();
  log.observe('the mean of the sample', { now: 1 });
  log.observe('the mean of', { now: 2 });
  log.flush();
  assert.deepEqual(lines.map((l) => l.text), ['the mean of']);
});

test('continuation is narrow: rewording an earlier word starts a new line rather than merging it away', () => {
  assert.equal(continuesCaption('the mean of the sample', 'a mean of the sample is'), false);
  assert.equal(continuesCaption('hyp', 'hypothesis testing'), true, 'one word still growing');
  assert.equal(continuesCaption('okay', 'right so'), false);
});

test('flush writes what is on the bar at stand-down; reset forgets it', () => {
  const a = logOf();
  a.log.observe('mid sentence when the', { now: 1 });
  a.log.flush();
  a.log.flush();
  assert.equal(a.lines.length, 1, 'flushing twice does not write the line twice');

  const b = logOf();
  b.log.observe('left over from yesterday', { now: 1 });
  b.log.reset();
  b.log.observe('', { now: 2 });
  assert.equal(b.lines.length, 0);
});

test('a caption line is capped, the same as anything else the timeline stores', () => {
  const { log, lines } = logOf();
  log.observe('x'.repeat(MAX_CAPTION_CHARS + 500), { now: 1 });
  log.flush();
  assert.equal(lines[0].text.length, MAX_CAPTION_CHARS);
});

// --- recap.js ----------------------------------------------------------------

const T0 = Date.UTC(2026, 8, 28, 14, 0, 0);
const at = (min) => T0 + min * 60000;

const detail = {
  id: 7, title: 'Week 6', room: 'psy415-room', course: 'psy415', startedAt: T0, endedAt: at(50),
  timeline: [
    { at: at(0.5), kind: 'caption', title: 'Good morning everyone', detail: { text: 'Good morning everyone', live: true } },
    { at: at(1), kind: 'program', title: 'Week 6', detail: { type: 'deck', slide: 1 } },
    { at: at(2), kind: 'caption', title: 'Today is hypothesis testing', detail: { text: 'Today is hypothesis testing', live: true } },
    { at: at(10), kind: 'program', title: 'Week 6', detail: { type: 'deck', slide: 7 } },
    { at: at(11), kind: 'caption', title: 'cut at 200', detail: { text: 'The full text of a long line, not the 200-character title', live: true } },
    { at: at(20), kind: 'program', title: 'Quick check', detail: { type: 'poll', pollId: 'p1' } },
    { at: at(26), kind: 'caption', title: 'Most of you got that', detail: { text: 'Most of you got that', live: true } },
    { at: at(30), kind: 'program', title: 'Whiteboard', detail: { type: 'whiteboard' } },
  ],
  pollResults: [{ pollId: 'p1', question: 'Which is H0?', kind: 'choice', options: ['A', 'B'], counts: [9, 3], voters: 12, endedAt: at(25) }],
  files: [
    { name: 'slides/week-6/slide-07.png', kind: 'export', url: '/media/a/slide-07.png' },
    { name: 'slides/week-6/slide-99.png', kind: 'export', url: '/media/b/slide-99.png' },
    { name: 'photos/abc-board.jpg', kind: 'photo', url: '/media/c/abc-board.jpg' },
    { name: 'ink.json', kind: 'ink', url: '/media/d/ink.json' },
    { name: 'polls/p1.csv', kind: 'export', url: '/media/e/p1.csv' },
  ],
};

test('the recap is in time order, with the poll placed where it closed', () => {
  const { blocks } = buildRecap(detail);
  assert.deepEqual(blocks.map((b) => b.type), ['opening', 'entry', 'entry', 'entry', 'poll', 'entry']);
  assert.equal(blocks[4].poll.question, 'Which is H0?');
});

test('each caption line goes with whatever was on screen when it was said', () => {
  const { blocks, captionCount } = buildRecap(detail);
  assert.equal(captionCount, 4);
  assert.deepEqual(blocks[0].captions.map((c) => c.text), ['Good morning everyone'], 'before anything was shown');
  assert.deepEqual(blocks[1].captions.map((c) => c.text), ['Today is hypothesis testing']);
  assert.deepEqual(blocks[2].captions.map((c) => c.text), ['The full text of a long line, not the 200-character title'],
    'the full detail.text, not the cut-down title');
  assert.deepEqual(blocks[4].captions.map((c) => c.text), ['Most of you got that'], 'said after the poll closed');
});

test('an annotated slide sits beside the entry that showed it; everything else is kept at the end', () => {
  const { blocks, extras } = buildRecap(detail);
  assert.deepEqual(blocks[2].images.map((f) => f.name), ['slides/week-6/slide-07.png']);
  assert.deepEqual(extras.map((f) => f.name), ['photos/abc-board.jpg', 'slides/week-6/slide-99.png'],
    'a slide no entry showed, and a photo - but never ink.json or a CSV');
});

test('a session with no captions and no pictures is still a recap', () => {
  const bare = { ...detail, timeline: detail.timeline.filter((e) => e.kind !== 'caption'), files: [] };
  const { blocks, extras, captionCount } = buildRecap(bare);
  assert.equal(captionCount, 0);
  assert.equal(extras.length, 0);
  assert.deepEqual(blocks.map((b) => b.type), ['entry', 'entry', 'entry', 'poll', 'entry']);
});

test('describeEvent and captionText read the stored shapes', () => {
  assert.equal(describeEvent({ detail: { type: 'deck', slide: 3 } }), 'slide 3');
  assert.equal(describeEvent({ detail: { type: 'whiteboard' } }), 'whiteboard');
  assert.equal(describeEvent({ detail: { type: 'black' } }), '');
  assert.equal(captionText({ title: 'short', detail: {} }), 'short', 'falls back to the title');
});

// --- pdf-writer.js: laying the recap out -------------------------------------

// Every character 12px wide: close enough to a 24px sans-serif to be a fair
// test of wrapping, and entirely predictable.
const measure = (text) => text.length * 12;

test('wrapText keeps lines inside the width, and breaks a word that is wider than a line', () => {
  const lines = wrapText('the quick brown fox jumps over the lazy dog', 120, measure);
  assert.ok(lines.every((line) => measure(line) <= 120), lines.join('|'));
  assert.equal(lines.join(' '), 'the quick brown fox jumps over the lazy dog');
  const broken = wrapText('https://example.com/a/very/long/address', 120, measure);
  assert.ok(broken.every((line) => measure(line) <= 120));
  assert.equal(broken.join(''), 'https://example.com/a/very/long/address');
});

test('the page plan puts text, pictures and polls in recap order', () => {
  const plan = planRecapPages(buildRecap(detail), measure, { summary: 'Mon 28 Sep — 50 min' });
  assert.deepEqual(plan.map((p) => p.kind), ['text', 'picture', 'text', 'poll', 'text', 'picture', 'picture']);
  assert.equal(plan[0].rows[0].style, 'summary');
  assert.equal(plan[1].file.name, 'slides/week-6/slide-07.png');
  assert.equal(plan[1].title, 'Week 6', 'a matched slide is titled with the entry it belongs to');
  assert.ok(plan[4].rows.some((r) => r.style === 'poll'), 'captions after a poll are headed by it');
});

test('a long lecture\'s captions run onto more pages, and every row stays inside the page', () => {
  const many = {
    ...detail,
    files: [],
    timeline: [
      { at: at(1), kind: 'program', title: 'Week 6', detail: { type: 'deck', slide: 1 } },
      ...Array.from({ length: 120 }, (_, i) => ({
        at: at(1) + (i + 1) * 1000, kind: 'caption', title: `line ${i}`,
        detail: { text: `caption line number ${i} with enough words to fill some of the page width` },
      })),
    ],
    pollResults: [],
  };
  const plan = planRecapPages(buildRecap(many), measure);
  assert.ok(plan.length > 1, `${plan.length} page(s)`);
  for (const page of plan) {
    for (const row of page.rows) assert.ok(row.y >= RECAP_STYLE.top && row.y < RECAP_STYLE.bottom, `row at ${row.y}`);
  }
  const captionRows = plan.flatMap((p) => p.rows).filter((r) => r.style === 'caption' && r.first);
  assert.equal(captionRows.length, 120, 'no caption line dropped across the page breaks');
  for (const page of plan.slice(1)) {
    assert.equal(page.rows[0].style, 'continued', 'a page that carries on an entry says which one');
    assert.equal(page.rows[0].text, 'Week 6 (continued)');
  }
});

test('a heading is never left alone at the foot of a page', () => {
  const crowded = {
    ...detail,
    files: [],
    pollResults: [],
    timeline: Array.from({ length: 60 }, (_, i) => ([
      { at: at(i), kind: 'program', title: `Entry ${i}`, detail: { type: 'deck', slide: i + 1 } },
      { at: at(i) + 1000, kind: 'caption', title: `said ${i}`, detail: { text: `said during entry ${i}` } },
    ])).flat(),
  };
  const plan = planRecapPages(buildRecap(crowded), measure);
  for (const page of plan) {
    const last = page.rows[page.rows.length - 1];
    assert.notEqual(last.style, 'heading', 'the last row on a page is never a bare heading');
  }
});
