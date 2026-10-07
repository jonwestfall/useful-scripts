// Run with: node podium/test/kiosk-open-paths.test.mjs
// KIOSK_OPEN_PATHS in server/podium-server.js is what lets a provisioned
// kiosk's own cookie (Issue #151) past gate() instead of a signed-in user -
// scoped to display.html and whatever it actually loads to run. A module
// display.js starts importing that is missing from this set (and not already
// in AUTH_OPEN_PATHS, open to everyone regardless of accounts) leaves an
// otherwise-provisioned kiosk stuck on the login page the next time it boots.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

let ok = true;
const chk = (label, cond) => {
  if (!cond) {
    ok = false;
    console.error('FAIL', label);
  } else {
    console.log('ok  ', label);
  }
};

// podium-server.js opens a real database and starts listening the moment it
// runs (it is an entrypoint, not a library) - so the two path sets are pulled
// out of its source text directly, the same way sw.js's WARM is pulled out
// without running sw.js's own event-listener setup.
function pathSet(name) {
  const source = fs.readFileSync(path.join(ROOT, 'server', 'podium-server.js'), 'utf8');
  const m = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!m) throw new Error(`${name} not found in server/podium-server.js`);
  return new Set(vm.runInNewContext(`[${m[1]}]`));
}

// Every local file display.html references directly: stylesheets, manifests,
// icons, classic scripts and the entry module.
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
// root-level JSON fetched by name (config.json).
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

// Loaded only once a PDF is actually rendered - the worker itself never
// blocks display.html from loading and running, only from rendering a PDF
// deck once it gets one, so its absence from either open-path set (should it
// ever go missing from KIOSK_OPEN_PATHS) is not what leaves a kiosk stuck.
// It is listed in KIOSK_OPEN_PATHS anyway, so this exists only to keep this
// test's requirement matching offline-shell.test.mjs's own carve-out.
const NOT_STRICTLY_NEEDED_TO_LOAD = new Set(['assets/vendor/pdf.worker.min.js']);

const AUTH_OPEN_PATHS = pathSet('AUTH_OPEN_PATHS');
const KIOSK_OPEN_PATHS = pathSet('KIOSK_OPEN_PATHS');
chk(`KIOSK_OPEN_PATHS parses out of server/podium-server.js (${KIOSK_OPEN_PATHS.size} entries)`, KIOSK_OPEN_PATHS.size > 5);

chk('display.html itself is a kiosk-open path', KIOSK_OPEN_PATHS.has('/display.html'));

const needed = new Set();
for (const ref of pageRefs('display.html')) {
  needed.add(ref);
  if (/\.m?js$/.test(ref) && ref.startsWith('assets/js/')) for (const dep of moduleGraph(ref)) needed.add(dep);
}

const openToKiosks = new Set([...AUTH_OPEN_PATHS, ...KIOSK_OPEN_PATHS]);
const missing = [...needed]
  .filter((f) => f !== 'display.html' && !NOT_STRICTLY_NEEDED_TO_LOAD.has(f))
  .filter((f) => !openToKiosks.has(`/${f}`))
  .sort();
chk(`everything display.html loads at startup is open to a kiosk cookie (${needed.size} files)${missing.length ? ` - missing: ${missing.join(', ')}` : ''}`,
  missing.length === 0);

console.log('\n-- KIOSK_OPEN_PATHS itself --');
const stale = [...KIOSK_OPEN_PATHS].filter((p) => !fs.existsSync(path.join(ROOT, p.replace(/^\//, ''))));
chk(`every kiosk-open entry still exists on disk${stale.length ? ` - stale: ${stale.join(', ')}` : ''}`, stale.length === 0);

const scoped = [...KIOSK_OPEN_PATHS].filter((p) => /^\/(control|admin|plan|deck|quicklook)\.html$/.test(p));
chk('never control.html, admin.html, plan.html, deck.html or quicklook.html - a kiosk cookie has no business past display.html', scoped.length === 0);

console.log('\n-- VIEW_OPEN_PATHS: Guest View (Issue #150) --');
// view.html is display.js in its viewer mode, opened by strangers with no
// account - so everything it loads has to be open to anyone, exactly like
// guest.html's files. config.json is the one deliberate gap: viewer mode
// never fetches it (see viewerConfig in config.js), and a deployment's
// defaults are none of a stranger's business.
const VIEW_OPEN_PATHS = pathSet('VIEW_OPEN_PATHS');
const VIEWER_NEVER_LOADS = new Set(['config.json']);
const viewNeeded = new Set();
for (const ref of pageRefs('view.html')) {
  viewNeeded.add(ref);
  if (/\.m?js$/.test(ref) && ref.startsWith('assets/js/')) for (const dep of moduleGraph(ref)) viewNeeded.add(dep);
}
const openToViewers = new Set([...AUTH_OPEN_PATHS, ...VIEW_OPEN_PATHS]);
const viewMissing = [...viewNeeded]
  .filter((f) => !NOT_STRICTLY_NEEDED_TO_LOAD.has(f) && !VIEWER_NEVER_LOADS.has(f))
  .filter((f) => !openToViewers.has(`/${f}`))
  .sort();
chk(`everything view.html loads is open to an anonymous viewer (${viewNeeded.size} files)${viewMissing.length ? ` - missing: ${viewMissing.join(', ')}` : ''}`,
  viewMissing.length === 0);
chk('view.html itself is open', VIEW_OPEN_PATHS.has('/view.html'));
chk('but never display.html, control.html, admin.html, plan.html, deck.html, quicklook.html or config.json',
  ![...VIEW_OPEN_PATHS].some((p) => /^\/(display|control|admin|plan|deck|quicklook)\.html$|^\/config\.json$/.test(p)));
// Quick Look (Issue #242) shows a presenter's files, notes included: never
// to someone who is not signed in, a kiosk or a viewer.
chk('quicklook.html is open to nobody who has not signed in', !AUTH_OPEN_PATHS.has('/quicklook.html')
  && !KIOSK_OPEN_PATHS.has('/quicklook.html') && !VIEW_OPEN_PATHS.has('/quicklook.html'));

if (!ok) {
  console.error('\nSOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
