// Run with: node podium/test/offline-shell.test.mjs
// The offline shell's warm list must cover everything the controller and the
// display load at startup (Issue #130). The service worker registers after the
// page has loaded, so on a device's first visit only WARM is in the cache - a
// module missing from it fails the whole page if the network drops before a
// second online load.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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

// Loaded only once a PDF is actually rendered, and PDFs themselves are never
// cached (SHELL in sw.js is app-shell file types only) - warming a 1 MB worker
// could not make an offline PDF work.
const NOT_NEEDED_OFFLINE = new Set(['assets/vendor/pdf.worker.min.js']);

function warmList() {
  const source = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const sandbox = { self: { addEventListener() {} }, globalThis: {} };
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
function moduleGraph(entry) {
  const seen = new Set();
  const extra = new Set();
  const visit = (file) => {
    const key = rel(file);
    if (seen.has(key)) return;
    seen.add(key);
    const source = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    const specifiers = [
      ...source.matchAll(/\bfrom\s*'(\.{1,2}\/[^']+)'/g),
      ...source.matchAll(/\bimport\(\s*'(\.{1,2}\/[^']+)'\s*\)/g),
      ...source.matchAll(/new URL\(\s*'(\.{1,2}\/[^']+)'\s*,\s*import\.meta\.url\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      const target = path.resolve(dir, spec);
      if (target.endsWith('.js') || target.endsWith('.mjs')) {
        if (fs.existsSync(target) && !rel(target).startsWith('assets/vendor/')) visit(target);
        else extra.add(rel(target));
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

for (const page of ['control.html', 'display.html']) {
  console.log(`\n-- ${page} --`);
  chk(`${page} itself is warmed`, WARM.has(page));
  const needed = new Set();
  for (const ref of pageRefs(page)) {
    needed.add(ref);
    if (/\.m?js$/.test(ref) && ref.startsWith('assets/js/')) for (const dep of moduleGraph(ref)) needed.add(dep);
  }
  const missing = [...needed].filter((f) => !WARM.has(f) && !NOT_NEEDED_OFFLINE.has(f)).sort();
  chk(`everything ${page} loads at startup is warmed (${needed.size} files)${missing.length ? ` - missing: ${missing.join(', ')}` : ''}`,
    missing.length === 0);
}

console.log('\n-- the warm list itself --');
const stale = [...WARM].filter((f) => f !== './' && !fs.existsSync(path.join(ROOT, f)));
chk(`every warm entry still exists on disk${stale.length ? ` - stale: ${stale.join(', ')}` : ''}`, stale.length === 0);

if (!ok) {
  console.error('\nSOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
