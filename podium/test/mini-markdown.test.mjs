// Run with:  node podium/test/mini-markdown.test.mjs
// miniMarkdown() in util.js - the "lite" markdown the full-screen message
// editor (Issue #103), the deck notes panel, and the live caption bar all
// share. No DOM, no network.
import { miniMarkdown } from '../assets/js/util.js';

let ok = true;
const chk = (label, cond) => { if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label); };

chk('plain text passes through untouched', miniMarkdown('hello') === 'hello');
chk('**bold**', miniMarkdown('**hi**') === '<b>hi</b>');
chk('*italic*', miniMarkdown('*hi*') === '<i>hi</i>');
chk('`code`', miniMarkdown('`hi`') === '<code>hi</code>');
chk('bold and italic together do not fight each other',
  miniMarkdown('**bold** and *italic*') === '<b>bold</b> and <i>italic</i>');
chk('a bare URL is auto-linked', miniMarkdown('see https://example.edu/demo').includes(
  '<a href="https://example.edu/demo" target="_blank" rel="noopener noreferrer">https://example.edu/demo</a>'));
chk('HTML in the input is escaped, not executed',
  miniMarkdown('<script>alert(1)</script>').includes('&lt;script&gt;') && !miniMarkdown('<script>alert(1)</script>').includes('<script>'));

// --- headings (Issue #103) ---------------------------------------------------
chk('# is an h1', miniMarkdown('# Title') === '<h1>Title</h1>');
chk('## is an h2', miniMarkdown('## Subtitle') === '<h2>Subtitle</h2>');
chk('a heading followed by a body line is two separate blocks, not joined by <br>',
  miniMarkdown('# Title\nBody text') === '<h1>Title</h1>Body text');
chk('### (three or more #) is not a heading - only one or two are recognized',
  !miniMarkdown('### Not a heading').startsWith('<h'));

// --- bulleted lists (pre-existing) -------------------------------------------
chk('consecutive - lines become one <ul>',
  miniMarkdown('- one\n- two') === '<ul class="mini-md-list"><li>one</li><li>two</li></ul>');
chk('* also starts a bullet', miniMarkdown('* one') === '<ul class="mini-md-list"><li>one</li></ul>');

// --- numbered lists (Issue #103) ---------------------------------------------
chk('consecutive numbered lines become one <ol>',
  miniMarkdown('1. one\n2. two') === '<ol class="mini-md-list"><li>one</li><li>two</li></ol>');
chk('1) is accepted too, not just 1.',
  miniMarkdown('1) one\n2) two') === '<ol class="mini-md-list"><li>one</li><li>two</li></ol>');
chk('the digits typed do not have to be sequential - the browser numbers the <ol>',
  miniMarkdown('5. one\n9. two') === '<ol class="mini-md-list"><li>one</li><li>two</li></ol>');

// --- switching between block kinds -------------------------------------------
chk('a bullet line straight into a numbered line closes the <ul> and opens a fresh <ol>',
  miniMarkdown('- a\n1. b') === '<ul class="mini-md-list"><li>a</li></ul><ol class="mini-md-list"><li>b</li></ol>');
chk('a heading closes an open list first',
  miniMarkdown('- a\n# Heading') === '<ul class="mini-md-list"><li>a</li></ul><h1>Heading</h1>');
chk('a plain line after a list closes it and resumes <br>-joining',
  miniMarkdown('- a\nplain\nmore') === '<ul class="mini-md-list"><li>a</li></ul>plain<br>more');

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
