import * as esbuild from 'esbuild';

// marp-core can render math with either KaTeX or MathJax. We use KaTeX, so
// MathJax (several megabytes) is replaced with a stub that throws if reached.
const stubMathJax = {
  name: 'stub-mathjax',
  setup(build) {
    build.onResolve({ filter: /^mathjax-full($|\/)/ }, () => ({ path: 'mathjax', namespace: 'stub-mathjax' }));
    build.onLoad({ filter: /.*/, namespace: 'stub-mathjax' }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
  },
};

// marp-core registers ~190 highlight.js languages one by one, which is well
// over a megabyte of grammars nobody is going to paste into a lecture slide.
// Keep a practical set; the rest resolve to an empty-but-valid grammar, so an
// unlisted language renders as plain unhighlighted code rather than throwing.
const KEEP = new Set(`bash c cpp csharp css diff dockerfile go graphql haskell ini java javascript
json julia kotlin latex less lua makefile markdown matlab objectivec perl php plaintext powershell
python python-repl r ruby rust scala scss shell sql stata swift typescript vbnet xml yaml`.split(/\s+/).filter(Boolean));

const trimHighlight = {
  name: 'trim-highlight',
  setup(build) {
    build.onResolve({ filter: /^highlight\.js\/lib\/languages\// }, (args) => {
      const lang = args.path.split('/').pop();
      return KEEP.has(lang) ? undefined : { path: lang, namespace: 'stub-hljs' };
    });
    // registerLanguage() expects a factory function, not a module object.
    build.onLoad({ filter: /.*/, namespace: 'stub-hljs' }, () => ({
      contents: 'module.exports = function () { return { contains: [] }; };',
      loader: 'js',
    }));
  },
};

const result = await esbuild.build({
  entryPoints: ['marp-entry.js'],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2020',
  minify: true, outfile: '../assets/vendor/marp.esm.js', plugins: [stubMathJax, trimHighlight], metafile: true,
  logLevel: 'warning',
});
const sizes = Object.entries(result.metafile.outputs)[0][1].inputs;
const top = Object.entries(sizes).sort((a,b)=>b[1].bytesInOutput-a[1].bytesInOutput).slice(0,8);
console.log('biggest contributors:');
for (const [f,v] of top) console.log(`  ${(v.bytesInOutput/1024).toFixed(0).padStart(6)} KB  ${f}`);
