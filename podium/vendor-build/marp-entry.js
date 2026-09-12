// Browser bundle for Podium: the Marp renderer plus the DOM polyfill Marp needs
// for inline-SVG slides (Safari, and therefore every iPad, gets foreignObject
// sizing wrong without it).
import { Marp } from '@marp-team/marp-core';
import { browser } from '@marp-team/marp-core/lib/browser.cjs.js';

export { Marp, browser };
