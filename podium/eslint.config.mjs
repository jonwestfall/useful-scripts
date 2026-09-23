// Minimal correctness linting (Issue #123) - no-undef, no-unused-vars, and
// the rest of eslint:recommended, plus eqeqeq. Deliberately not a style or
// formatting pass: nothing here reformats a single line of the existing
// codebase, it only catches the class of bug manual review misses (an
// undefined global, a stale variable left after a refactor, an accidental
// == where two differently-typed values compare true by coercion).
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'server/node_modules/**', 'assets/vendor/**'],
  },
  js.configs.recommended,
  {
    rules: {
      // 'smart' still catches a stray == between two real values (the
      // coercion-bug class this issue is about) but leaves the codebase's
      // own `x == null` idiom alone - it means "null or undefined" on
      // purpose in dozens of places here, and the strict spelling of that
      // is more verbose for the exact same behavior.
      eqeqeq: ['error', 'smart'],
      // The codebase's own convention for "yes, I know this is unused" -
      // a destructured field kept only to be left out of a `...rest`, or an
      // argument a shared call signature requires but this one ignores.
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  // The pages themselves: browser ES modules, one <script type="module"> each.
  {
    files: ['assets/js/**/*.js', 'vendor-build/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
  // The service worker: its own global scope, not a page's.
  {
    files: ['sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
  },
  // The relay and everything it loads: plain Node, CommonJS.
  {
    files: ['server/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  // Test scripts: Node itself, plus the browser globals used inside
  // page.evaluate()/addInitScript() callbacks written inline in the same
  // file - those run in a page, not in the Node process, but are still
  // real JS syntax in this file that eslint parses as one program.
  {
    files: ['test/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
  },
  // Build-time scripts run by hand or from a workflow, never shipped to a
  // browser - plain Node, unlike marp-entry.js beside them.
  {
    files: ['vendor-build/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
];
