// Regenerate the app icons in assets/icons/.
//
//   node podium/vendor-build/make-icons.mjs      # needs playwright
//
// Drawn as HTML and screenshotted rather than committed as opaque binaries, so
// the icon is editable: the glyph is a lit projector screen on a stand, on
// Podium's own background. Run this after changing it.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icons');

// `pad` is the share of the canvas kept clear, so a maskable icon survives
// being cropped to a circle by a launcher.
const markup = (size, pad, round) => `
<style>
  html,body{margin:0;width:${size}px;height:${size}px;background:transparent}
  .bg{width:${size}px;height:${size}px;background:#10161d;display:grid;place-items:center;
      border-radius:${round ? size * 0.22 : 0}px}
  .glyph{width:${size * (1 - pad * 2)}px;display:grid;gap:${size * 0.055}px;justify-items:center}
  .screen{width:100%;aspect-ratio:16/9;border-radius:${size * 0.045}px;
      background:linear-gradient(150deg,#6ea8fe,#3f6fd0);
      box-shadow:0 0 ${size * 0.08}px rgba(110,168,254,.45)}
  .stand{width:14%;height:${size * 0.055}px;background:#e8ecf1;border-radius:${size}px;opacity:.9}
</style>
<div class="bg"><div class="glyph"><div class="screen"></div><div class="stand"></div></div></div>`;

const SIZES = [
  // name, px, padding, own rounded corners
  ['icon-192.png', 192, 0.17, true],
  ['icon-512.png', 512, 0.17, true],
  ['icon-maskable-512.png', 512, 0.26, false],   // launcher supplies the shape
  ['apple-touch-icon.png', 180, 0.17, false],    // iOS rounds it itself
];

async function loadPlaywright() {
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
    try { return await import(spec); } catch { /* try the next one */ }
  }
  console.error('playwright not found. Run: npm i playwright && npx playwright install chromium');
  process.exit(2);
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
for (const [name, size, pad, round] of SIZES) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(markup(size, pad, round));
  await page.screenshot({ path: path.join(OUT, name), omitBackground: !round });
  await page.close();
  console.log(`wrote ${name}`);
}
await browser.close();
