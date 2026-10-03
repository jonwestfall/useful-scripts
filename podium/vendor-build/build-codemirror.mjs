import * as esbuild from 'esbuild';

// CodeMirror 6 for the deck editor (Issue #226). One ESM file, minified, no
// runtime dependencies - see codemirror-entry.js for what it exports.
const result = await esbuild.build({
  entryPoints: ['codemirror-entry.js'],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
  minify: true, outfile: '../assets/vendor/codemirror.esm.js', metafile: true,
  legalComments: 'eof',
  logLevel: 'warning',
});
const out = Object.values(result.metafile.outputs)[0];
console.log(`codemirror.esm.js: ${(out.bytes / 1024).toFixed(0)} KB`);
