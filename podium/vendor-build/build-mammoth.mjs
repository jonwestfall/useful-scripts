import * as esbuild from 'esbuild';

// mammoth for Word files (Issue #258). One ESM file, loaded only when someone
// imports a .docx - see assets/js/word-import.js.
const result = await esbuild.build({
  entryPoints: ['mammoth-entry.js'],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
  minify: true, outfile: '../assets/vendor/mammoth.esm.js', metafile: true,
  legalComments: 'eof',
  logLevel: 'warning',
});
const out = Object.values(result.metafile.outputs)[0];
console.log(`mammoth.esm.js: ${(out.bytes / 1024).toFixed(0)} KB`);
