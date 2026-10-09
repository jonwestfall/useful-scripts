// Where the landing page's and the guide's links go. A deployed Podium serves
// the app, not the repository: docs/*.md behind a sign-in (or not at all)
// would be raw markdown at best. So pages about the project link to it on
// GitHub, and pages of the installation (display, controller, guide...) stay
// relative, on whatever domain served them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(path.join(root, name), 'utf8');
const pages = readdirSync(root).filter((name) => name.endsWith('.html'));
const REPO = 'https://github.com/jonwestfall/useful-scripts/';

const hrefs = (html) => [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]);

test('no page links to the repository\'s files by a relative path', () => {
  for (const page of pages) {
    for (const href of hrefs(read(page))) {
      if (/^[a-z]+:|^#/i.test(href)) continue;
      assert.doesNotMatch(href.split(/[?#]/)[0], /\.md$|^(\.\/)?(docs|deploy|server)\//, `${page}: ${href}`);
    }
  }
});

test('the landing page and the guide keep their own pages on this domain', () => {
  for (const page of ['index.html', 'guide.html']) {
    for (const href of hrefs(read(page))) {
      if (/^[a-z]+:|^#/i.test(href)) continue;
      const file = href.split(/[?#]/)[0];
      assert.match(file, /^[a-z-]+\.html$/, `${page}: ${href}`);
      assert.ok(existsSync(path.join(root, file)), `${page}: ${href} is not a page here`);
    }
  }
});

test('every GitHub link names a file or folder that is in the repository', () => {
  for (const page of ['index.html', 'guide.html']) {
    for (const href of hrefs(read(page))) {
      if (!href.startsWith(REPO)) continue;
      const m = /^(?:blob|tree)\/main\/(.+)$/.exec(href.slice(REPO.length).split('#')[0]);
      if (!m) continue; // the repository itself, its issues
      assert.ok(existsSync(m[1].startsWith('podium/') ? path.join(root, m[1].slice('podium/'.length)) : path.join(root, '..', m[1])), `${page}: ${href}`);
    }
  }
});
