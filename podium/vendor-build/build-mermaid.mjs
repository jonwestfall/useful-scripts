import * as esbuild from 'esbuild';

// Mermaid for diagrams in decks (Issue #235). One ESM file: Mermaid loads each
// diagram type with import(), and without code splitting esbuild folds every
// one of those into this file, so a deck can draw any kind of diagram offline.
const result = await esbuild.build({
  entryPoints: ['mermaid-entry.js'],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
  minify: true, outfile: '../assets/vendor/mermaid.esm.js', metafile: true,
  legalComments: 'eof',
  logLevel: 'warning',
});
const out = Object.values(result.metafile.outputs)[0];
console.log(`mermaid.esm.js: ${(out.bytes / 1024).toFixed(0)} KB`);
const top = Object.entries(out.inputs).sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput).slice(0, 8);
for (const [file, v] of top) console.log(`  ${(v.bytesInOutput / 1024).toFixed(0).padStart(6)} KB  ${file}`);
