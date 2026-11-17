// Run with: node podium/test/offline-shell.test.mjs
// The offline shell's warm list must cover everything the controller, the
// display, the planner and the front page load at startup (Issue #130). The
// service worker registers after the page has loaded, so on a device's first
// visit only WARM is in the cache - a module missing from it fails the whole
// page if the network drops before a second online load.
//
// And it must cover no more than that (Issue #342): a bundle a page loads
// only on demand - Mermaid for a diagram, CodeMirror in the deck editor,
// mammoth for a Word file, KaTeX's fonts, pdf.js - is cached the first time it
// is used, not downloaded by every device on its first visit. Marp is the one
// on-demand bundle the shell keeps: decks are most of what goes on screen.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

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

// The shell: what a lecture starts from. Any other page (the deck editor,
// Quick Look, Replay, Admin, My Files) is cached as it is opened online.
const SHELL_PAGES = ['control.html', 'display.html', 'index.html', 'plan.html'];

// The one on-demand bundle kept in the shell anyway.
const KEPT_ON_DEMAND = new Set([
  'assets/vendor/marp.esm.js',
  // The face most slides are laid out in (slide-font.js): offline without it,
  // the iPad and the projector each fall back to their own and break lines
  // in different places, which puts ink drawn on one off on the other.
  ...['400-normal', '400-italic', '700-normal', '700-italic'].map((face) => `assets/vendor/slide-fonts/arimo-latin-${face}.woff2`),
]);

// What the shell must not grow past, gzipped (it was 2.8 MB).
const BUDGET_BYTES = 1024 * 1024;

function warmList() {
  const source = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const sandbox = { self: { addEventListener() {}, location: { href: 'https://podium.test/sw.js' } }, globalThis: {} };
  vm.runInNewContext(`${source}\nglobalThis.__WARM = WARM;`, sandbox);
  return new Set(sandbox.globalThis.__WARM);
}

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

// Every local file a page references directly: stylesheets, manifests, icons,
// classic scripts and the entry module.
function pageRefs(page) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const refs = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
    if (!/^[a-z]+:|^\/\//i.test(m[1])) refs.push(m[1]);
  }
  return refs;
}

// Everything reachable from an entry module: static and literal dynamic
// imports, `new URL('…', import.meta.url)`, root-relative asset paths written
// as string literals (how renderers.js points pdf.js at its worker), and
// root-level JSON fetched by name (config.json - not content/*.json, which is
// lecture content the worker deliberately leaves alone).
function moduleGraph(entry, onDemand = new Set()) {
  const seen = new Set();
  const extra = new Set();
  const visit = (file) => {
    const key = rel(file);
    if (seen.has(key)) return;
    seen.add(key);
    const source = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    // A static import is needed as the page loads. So is a literal import()
    // of one of the app's own modules (a transport, as the page connects).
    // A vendor bundle reached by import() or new URL(…) is loaded on demand.
    const lazy = [
      ...source.matchAll(/\bimport\(\s*'(\.{1,2}\/[^']+)'\s*\)/g),
      ...source.matchAll(/new URL\(\s*'(\.{1,2}\/[^']+)'\s*,\s*import\.meta\.url\s*\)/g),
    ].map((m) => m[1]);
    const specifiers = [
      ...[...source.matchAll(/\b(?:from|import)\s*'(\.{1,2}\/[^']+)'/g)].map((m) => m[1]),
      ...lazy.filter((spec) => !rel(path.resolve(dir, spec)).startsWith('assets/vendor/')),
    ];
    for (const spec of lazy) {
      const target = path.resolve(dir, spec);
      if (!rel(target).startsWith('assets/vendor/')) continue;
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        for (const name of fs.readdirSync(target)) onDemand.add(rel(path.join(target, name)));
      } else onDemand.add(rel(target));
    }
    for (const spec of specifiers) {
      const target = path.resolve(dir, spec);
      if (target.endsWith('.js') || target.endsWith('.mjs')) {
        if (fs.existsSync(target) && !rel(target).startsWith('assets/vendor/')) visit(target);
        else extra.add(rel(target));
      } else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        // A folder of files a module loads by name (math-fonts.js's fonts):
        // every one of them, its licence aside.
        for (const name of fs.readdirSync(target)) if (!/^LICENSE/.test(name)) extra.add(rel(path.join(target, name)));
      } else {
        extra.add(rel(target));
      }
    }
    for (const m of source.matchAll(/'(assets\/[^'\s]+\.(?:js|mjs|css|json))'/g)) extra.add(m[1]);
    for (const m of source.matchAll(/\bfetch\(\s*'([\w.-]+\.json)'/g)) extra.add(m[1]);
  };
  visit(path.join(ROOT, entry));
  return new Set([...seen, ...extra]);
}

const WARM = warmList();
chk(`the warm list parses out of sw.js (${WARM.size} entries)`, WARM.size > 10);

const onDemand = new Set();
const neededByShell = new Set();
for (const page of SHELL_PAGES) {
  console.log(`\n-- ${page} --`);
  chk(`${page} itself is warmed`, WARM.has(page));
  const needed = new Set();
  for (const ref of pageRefs(page)) {
    needed.add(ref);
    if (/\.m?js$/.test(ref) && ref.startsWith('assets/js/')) for (const dep of moduleGraph(ref, onDemand)) needed.add(dep);
  }
  for (const f of needed) neededByShell.add(f);
  const missing = [...needed].filter((f) => !WARM.has(f)).sort();
  chk(`everything ${page} loads at startup is warmed (${needed.size} files)${missing.length ? ` - missing: ${missing.join(', ')}` : ''}`,
    missing.length === 0);
}

console.log('\n-- only the shell (Issue #342) --');
for (const kept of KEPT_ON_DEMAND) chk(`${kept} is warmed anyway: decks are most of a lecture`, WARM.has(kept));
// (Something a shell page also loads directly, as control.html does
// qrcode.js, is needed at startup, whatever else loads it later.)
const precachedOnDemand = [...onDemand].filter((f) => WARM.has(f) && !KEPT_ON_DEMAND.has(f) && !neededByShell.has(f)).sort();
chk(`nothing else loaded on demand is precached (${onDemand.size} on-demand files)${precachedOnDemand.length ? ` - precached: ${precachedOnDemand.join(', ')}` : ''}`,
  precachedOnDemand.length === 0);
for (const big of ['assets/vendor/mermaid.esm.js', 'assets/vendor/codemirror.esm.js', 'assets/vendor/mammoth.esm.js', 'assets/vendor/pdfjs/pdf.min.mjs']) {
  chk(`${big} is not precached`, !WARM.has(big));
}
const gzipped = [...WARM].filter((f) => f !== './').reduce((sum, f) => {
  const file = path.join(ROOT, f);
  return sum + (fs.existsSync(file) ? zlib.gzipSync(fs.readFileSync(file)).length : 0);
}, 0);
chk(`a first visit precaches ${(gzipped / 1024).toFixed(0)} KB gzipped, within ${BUDGET_BYTES / 1024} KB`, gzipped <= BUDGET_BYTES);

console.log('\n-- the warm list itself --');
const stale = [...WARM].filter((f) => f !== './' && !fs.existsSync(path.join(ROOT, f)));
chk(`every warm entry still exists on disk${stale.length ? ` - stale: ${stale.join(', ')}` : ''}`, stale.length === 0);

if (!ok) {
  console.error('\nSOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
