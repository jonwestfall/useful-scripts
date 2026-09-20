// Run with: node podium/test/deck_nav.test.mjs
// Unit tests for Slide Thumbnail Badges for Ink, Grid Auto-Scroll & Section Chips (Issue #34).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSections } from '../assets/js/deck.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let ok = true;
const chk = (label, cond) => {
  if (!cond) {
    ok = false;
    console.error('FAIL', label);
  } else {
    console.log('ok  ', label);
  }
};

console.log('-- section parsing in deck.js (parseSections) --');
{
  const makeMockRoot = (slides) => ({
    querySelectorAll: (sel) => {
      if (sel === 'svg[data-marpit-svg] section') {
        return slides.map((s) => ({
          querySelector: (subSel) => {
            if (subSel === 'h1, h2') {
              if (s.h1) return { tagName: 'H1', textContent: s.h1 };
              if (s.h2) return { tagName: 'H2', textContent: s.h2 };
              return null;
            }
            return null;
          },
        }));
      }
      return [];
    },
  });

  const slides = [
    { h1: '  Weighing the Evidence  ' },
    { h3: 'Detail note without top-level heading' },
    { h2: '1. Five-Minute Retrieval: Re-Stitching the Stool' },
    { p: 'Some body text' },
    { h2: '2. Today\'s Core Dilemma' },
    { h1: '3. Multi-Dimensional Evidence' },
  ];

  const sections = parseSections(makeMockRoot(slides));
  chk('parsed 4 top-level sections', sections.length === 4);
  chk('first section is H1 level 1 on slide 0', sections[0].title === 'Weighing the Evidence' && sections[0].slideIndex === 0 && sections[0].level === 1);
  chk('second section is H2 level 2 on slide 2', sections[1].title.startsWith('1. Five-Minute') && sections[1].slideIndex === 2 && sections[1].level === 2);
  chk('third section is H2 on slide 4', sections[2].slideIndex === 4 && sections[2].level === 2);
  chk('fourth section is H1 on slide 5', sections[3].slideIndex === 5 && sections[3].level === 1);

  // Deck with no headings
  const emptyDeck = [
    { p: 'Just text 1' },
    { p: 'Just text 2' },
  ];
  chk('deck with no H1/H2 returns empty array', parseSections(makeMockRoot(emptyDeck)).length === 0);
}

console.log('-- slide section index mapping --');
{
  function getSlideSectionIndex(sections, slideIndex) {
    if (!sections || !sections.length) return -1;
    let secIdx = -1;
    for (let k = 0; k < sections.length; k++) {
      if (sections[k].slideIndex <= slideIndex) {
        secIdx = k;
      } else {
        break;
      }
    }
    return secIdx;
  }

  const sections = [
    { title: 'Intro', slideIndex: 0 },
    { title: 'EBPP', slideIndex: 2 },
    { title: 'Dilemma', slideIndex: 5 },
  ];

  chk('slide 0 is in section 0', getSlideSectionIndex(sections, 0) === 0);
  chk('slide 1 is in section 0', getSlideSectionIndex(sections, 1) === 0);
  chk('slide 2 is in section 1', getSlideSectionIndex(sections, 2) === 1);
  chk('slide 3 is in section 1', getSlideSectionIndex(sections, 3) === 1);
  chk('slide 4 is in section 1', getSlideSectionIndex(sections, 4) === 1);
  chk('slide 5 is in section 2', getSlideSectionIndex(sections, 5) === 2);
  chk('slide 8 is in section 2', getSlideSectionIndex(sections, 8) === 2);

  // When first section starts after slide 0
  const lateSections = [
    { title: 'First Topic', slideIndex: 2 },
  ];
  chk('slides before first heading have section -1', getSlideSectionIndex(lateSections, 0) === -1);
  chk('slides at or after first heading have section 0', getSlideSectionIndex(lateSections, 2) === 0);
  chk('empty sections returns -1', getSlideSectionIndex([], 0) === -1);
}

console.log('-- wireState surfaces list in display.js --');
{
  const state = {
    ink: {
      color: '#ffd166',
      width: 6,
      bySurface: {
        'deck:abc:0': { strokes: [{ id: 's1' }], touched: 100 },
        'deck:abc:3': { strokes: [{ id: 's2' }, { id: 's3' }], touched: 200 },
        'deck:abc:5': { strokes: [], touched: 300 }, // cleared, empty
        'whiteboard:default': { strokes: [{ id: 'w1' }], touched: 400 },
      },
    },
  };

  const surfaces = Object.keys(state.ink.bySurface).filter((k) => state.ink.bySurface[k]?.strokes?.length > 0);
  chk('surfaces includes deck:abc:0', surfaces.includes('deck:abc:0'));
  chk('surfaces includes deck:abc:3', surfaces.includes('deck:abc:3'));
  chk('surfaces includes whiteboard:default', surfaces.includes('whiteboard:default'));
  chk('surfaces excludes cleared deck:abc:5', !surfaces.includes('deck:abc:5'));
  chk('total annotated surfaces is 3', surfaces.length === 3);
}

console.log('-- controller ink badge evaluation --');
{
  function evaluateSlideHasInk({ slideIndex, deckId, activeSlide, surfacesFromDisplay, inkCache, localActiveStrokes }) {
    const surfaceKey = `deck:${deckId}:${slideIndex}`;
    const surfacesWithInk = new Set(surfacesFromDisplay || []);
    if (activeSlide === slideIndex) {
      return (localActiveStrokes?.length || 0) > 0;
    }
    return surfacesWithInk.has(surfaceKey) || ((inkCache?.get(surfaceKey)?.length || 0) > 0);
  }

  const inkCache = new Map();
  inkCache.set('deck:d1:4', [{ id: 'cached1' }]);

  // 1. Authoritative display has ink for slide 1
  chk('slide 1 has ink from display broadcast', evaluateSlideHasInk({
    slideIndex: 1, deckId: 'd1', activeSlide: 0,
    surfacesFromDisplay: ['deck:d1:1'], inkCache, localActiveStrokes: [],
  }) === true);

  // 2. Slide 2 has no ink anywhere
  chk('slide 2 has no ink', evaluateSlideHasInk({
    slideIndex: 2, deckId: 'd1', activeSlide: 0,
    surfacesFromDisplay: ['deck:d1:1'], inkCache, localActiveStrokes: [],
  }) === false);

  // 3. Slide 4 has ink in local cache
  chk('slide 4 has ink from cache', evaluateSlideHasInk({
    slideIndex: 4, deckId: 'd1', activeSlide: 0,
    surfacesFromDisplay: [], inkCache, localActiveStrokes: [],
  }) === true);

  // 4. Current active slide (slide 0) just drew a stroke locally
  chk('current active slide reflects active strokes immediately', evaluateSlideHasInk({
    slideIndex: 0, deckId: 'd1', activeSlide: 0,
    surfacesFromDisplay: [], inkCache, localActiveStrokes: [{ id: 'live1' }],
  }) === true);

  // 5. Current active slide just cleared ink locally
  chk('current active slide cleared reflects immediately', evaluateSlideHasInk({
    slideIndex: 0, deckId: 'd1', activeSlide: 0,
    surfacesFromDisplay: ['deck:d1:0'], inkCache, localActiveStrokes: [],
  }) === false);
}

console.log('-- auto-scroll gating logic --');
{
  let lastScrolledSlideIndex = null;
  let scrollCalls = 0;

  function simulateHighlightGrid(index, isPanelVisible) {
    if (lastScrolledSlideIndex !== index && isPanelVisible) {
      lastScrolledSlideIndex = index;
      scrollCalls++;
    }
  }

  // Initial advance to slide 0
  simulateHighlightGrid(0, true);
  chk('scroll triggered on first slide load', scrollCalls === 1 && lastScrolledSlideIndex === 0);

  // Subsequent identical heartbeat on slide 0
  simulateHighlightGrid(0, true);
  chk('heartbeat does not re-scroll or fight manual scroll', scrollCalls === 1);

  // Clicker advances to slide 1
  simulateHighlightGrid(1, true);
  chk('scroll triggered on slide advance', scrollCalls === 2 && lastScrolledSlideIndex === 1);

  // Another identical heartbeat on slide 1
  simulateHighlightGrid(1, true);
  chk('subsequent heartbeat on slide 1 does not scroll', scrollCalls === 2);

  // Slide advance when panel is hidden
  simulateHighlightGrid(2, false);
  chk('hidden panel does not scroll', scrollCalls === 2);

  // Switching back to slides tab resets lastScrolledSlideIndex
  lastScrolledSlideIndex = null;
  simulateHighlightGrid(2, true);
  chk('switching to slides tab centers active slide', scrollCalls === 3 && lastScrolledSlideIndex === 2);
}

console.log('-- section chip interaction (Option A: Jump & Scroll + Filter) --');
{
  let activeSectionFilter = null;
  let selectedChipSection = null;
  let scrolledToSlide = null;

  function handleChipClick(chipKey, sections) {
    if (chipKey === 'all') {
      activeSectionFilter = null;
      selectedChipSection = null;
      return;
    }
    const k = Number(chipKey);
    const sec = sections[k];
    if (activeSectionFilter === k) {
      // Second tap when already filtered: toggle back to All
      activeSectionFilter = null;
      selectedChipSection = null;
    } else if (selectedChipSection === k || activeSectionFilter !== null) {
      // Second tap on jumped chip, or clicking another chip while filtered: isolate section
      activeSectionFilter = k;
      selectedChipSection = k;
      scrolledToSlide = sec.slideIndex;
    } else {
      // First tap: smoothly jump & scroll to topic's first slide
      selectedChipSection = k;
      scrolledToSlide = sec.slideIndex;
    }
  }

  const sections = [
    { title: 'Intro', slideIndex: 0 },
    { title: 'Methods', slideIndex: 5 },
    { title: 'Results', slideIndex: 12 },
  ];

  // 1. First tap on Methods (section 1) -> jumps/scrolls to slide 5, filter remains null
  handleChipClick('1', sections);
  chk('first tap selects chip 1', selectedChipSection === 1);
  chk('first tap scrolls to slide 5', scrolledToSlide === 5);
  chk('first tap does not hide other slides (filter is null)', activeSectionFilter === null);

  // 2. Second tap on Methods (section 1) -> activates section filter
  handleChipClick('1', sections);
  chk('second tap activates section filter 1', activeSectionFilter === 1);

  // 3. Third tap on Methods (section 1) -> toggles filter off
  handleChipClick('1', sections);
  chk('third tap toggles filter off', activeSectionFilter === null && selectedChipSection === null);

  // 4. Tap 'all' explicitly clears filter
  activeSectionFilter = 2;
  selectedChipSection = 2;
  handleChipClick('all', sections);
  chk('clicking all clears filter', activeSectionFilter === null && selectedChipSection === null);
}

console.log('-- DOM and CSS verification --');
{
  const html = fs.readFileSync(path.join(ROOT, 'control.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'assets/css/podium.css'), 'utf8');
  const controlJs = fs.readFileSync(path.join(ROOT, 'assets/js/control.js'), 'utf8');

  chk('control.html has #deck-grid-chips container', html.includes('id="deck-grid-chips"'));
  chk('control.html places chips above deck-grid-filter', html.indexOf('id="deck-grid-chips"') < html.indexOf('id="deck-grid-filter"'));

  chk('podium.css has .deck-chips styles', css.includes('.deck-chips'));
  chk('podium.css has .deck-chip styles', css.includes('.deck-chip'));
  chk('podium.css has .deck-chip.is-active styles', css.includes('.deck-chip.is-active'));

  chk('control.js styles .ink-badge in shadow DOM', controlJs.includes('.ink-badge'));
  chk('control.js styles .cell.has-ink .ink-badge', controlJs.includes('.cell.has-ink .ink-badge'));
  chk('control.js appends inkBadge to thumb', controlJs.includes('thumb.append(num, inkBadge)'));
  chk('control.js calls renderSectionChips', controlJs.includes('renderSectionChips(deck)'));
  chk('control.js calls updateActiveSectionChip', controlJs.includes('updateActiveSectionChip(index)'));
}

if (!ok) {
  console.error('\nSOME CHECKS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
