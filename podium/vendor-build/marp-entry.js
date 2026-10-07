// Browser bundle for Podium: the Marp renderer plus the DOM polyfill Marp needs
// for inline-SVG slides (Safari, and therefore every iPad, gets foreignObject
// sizing wrong without it).
import { Marp } from '@marp-team/marp-core';
import { browser } from '@marp-team/marp-core/lib/browser.cjs.js';

// Markdown documents (Issue #240) are rendered without Marp's slides, by the
// same markdown-it, KaTeX and HTML filter Marp already carries (and a Marp
// instance's own highlight.js) -
// re-exported here rather than bundled a second time.
import shared from './shared-cjs.cjs';
import { FilterXSS } from 'xss';
import katexCss from 'katex/dist/katex.min.css';

const { katex, MarkdownIt } = shared;

export { Marp, browser, MarkdownIt, katex, FilterXSS, katexCss };
