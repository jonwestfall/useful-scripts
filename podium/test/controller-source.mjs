// The controller's code as text, for the checks that look for something in
// it: control.js and every module of its own it imports (control.js has been
// split along its features, Issue #121), so a check does not care which file
// a feature ended up in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'js');

export function controllerSource() {
  const control = fs.readFileSync(path.join(JS, 'control.js'), 'utf8');
  const own = [...control.matchAll(/^import [^;]*? from '\.\/([\w-]+\.js)';/gm)].map((m) => m[1]);
  return [control, ...own.map((file) => fs.readFileSync(path.join(JS, file), 'utf8'))].join('\n');
}
