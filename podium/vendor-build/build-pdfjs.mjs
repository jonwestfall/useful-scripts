// pdf.js (Issues #335, #341): copied, not bundled - pdfjs-dist ships ready-
// made ES modules. The LEGACY build, which carries polyfills for what the
// modern build assumes (Map.getOrInsertComputed, Math.sumPrecise and the
// like, which only the newest browsers have); it runs on Safari 16.4 /
// iPadOS 16.4 and later. Loaded on demand by assets/js/pdfjs.js.
//
// The wasm/ files are the image decoders pdf.js no longer carries in its own
// code: JPEG 2000 (openjpeg), JBIG2 and ICC colour (qcms), each with the
// plain-JavaScript fallback it uses where WebAssembly is unavailable. Without
// them a scanned article's JPEG 2000 pictures would not draw. QuickJS (for
// PDF form scripts, which Podium never runs) and the CJK character maps and
// standard fonts (which Podium has never shipped) are left out.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const out = path.resolve('../assets/vendor/pdfjs');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'wasm'), { recursive: true });

const copy = (from, to) => {
  fs.copyFileSync(path.join(pkgDir, from), path.join(out, to));
  return fs.statSync(path.join(out, to)).size;
};
let bytes = 0;
bytes += copy('legacy/build/pdf.min.mjs', 'pdf.min.mjs');
bytes += copy('legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs');
bytes += copy('LICENSE', 'LICENSE');
for (const name of fs.readdirSync(path.join(pkgDir, 'wasm'))) {
  if (/^quickjs|LICENSE_(PDFJS_)?QUICKJS/i.test(name)) continue;
  bytes += copy(`wasm/${name}`, `wasm/${name}`);
}
fs.writeFileSync(path.join(out, 'VERSION'), `pdfjs-dist ${version} (legacy build)\n`);
console.log(`pdfjs ${version}: ${(bytes / 1024).toFixed(0)} KB in assets/vendor/pdfjs/`);
