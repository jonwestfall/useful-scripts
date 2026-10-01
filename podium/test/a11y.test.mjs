// Accessibility guard rails (Issue #156): the things the controller/display
// audit fixed, checked statically so a new button or a new colour cannot
// quietly undo them. Not a substitute for trying the pages with a screen
// reader - see docs/accessibility.md for what this does and does not cover.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(path.join(root, name), 'utf8');
const pages = readdirSync(root).filter((name) => name.endsWith('.html'));

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

test('every page declares its language', () => {
  for (const page of pages) assert.match(read(page), /<html[^>]*\blang="[a-z-]+"/i, page);
});

// A button's text content beats its title in the accessible-name
// computation, so a symbol-only button with a title is still read out as the
// symbol's Unicode name ("black right-pointing triangle"). Real words, a
// number ("1m", "+30s", "50 / 50"), an aria-label, or - for a button with no
// content at all - a title are what count as a name here.
test('every button has a name a screen reader can say', () => {
  const unnamed = [];
  for (const page of pages) {
    const html = read(page);
    for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
      const [, attrs, body] = m;
      const text = body.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').trim();
      if (/\baria-label(ledby)?=/.test(attrs)) continue;
      if (/[a-z]{2}|\d/i.test(text)) continue;
      if (!text && /\btitle=/.test(attrs)) continue;
      // Empty and hidden until control.js fills it in - see renderSlotButton,
      // which names symbol-only slots from their title.
      if (!text && /\bclass="bar-slot"/.test(attrs) && /\bhidden\b/.test(attrs)) continue;
      unnamed.push(`${page}:${lineOf(html, m.index)} ${JSON.stringify(text)}`);
    }
  }
  assert.deepEqual(unnamed, []);
});

// A placeholder is not a label: it disappears as soon as somebody types, and
// screen readers do not reliably read it out as the field's name.
test('every form field on the controller and display has a label', () => {
  const unlabelled = [];
  for (const page of ['control.html', 'display.html']) {
    const html = read(page);
    const labelled = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
    for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      const attrs = m[2];
      if (/\btype="(hidden|file)"/.test(attrs) || /\baria-label(ledby)?=/.test(attrs)) continue;
      const id = attrs.match(/\bid="([^"]+)"/)?.[1];
      if (id && labelled.has(id)) continue;
      const before = html.slice(0, m.index);
      if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;   // wrapped in one
      unlabelled.push(`${page}:${lineOf(html, m.index)} ${id || m[1]}`);
    }
  }
  assert.deepEqual(unlabelled, []);
});

// Issue numbers are for whoever reads the code, not whoever is teaching
// (Issue #199): they belong in comments, never in text a page shows. Checked
// in every page's markup and in the item blurbs the planning page displays.
test('no issue numbers in text a page shows', () => {
  const leaks = [];
  for (const page of pages) {
    const visible = read(page).replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    for (const m of visible.matchAll(/Issue #\d+/g)) leaks.push(`${page}: ${m[0]}`);
  }
  for (const m of read('assets/js/planfile.js').matchAll(/blurb:\s*'[^']*Issue #\d+[^']*'/g)) leaks.push(`planfile.js: ${m[0]}`);
  assert.deepEqual(leaks, []);
});

test('the connection and caption changes are announced', () => {
  const control = read('control.html');
  const display = read('display.html');
  assert.match(control, /id="sr-announce"[^>]*role="status"/, 'the controller\'s connection announcer');
  assert.match(display, /id="overlay"[^>]*aria-live="polite"/, 'the display\'s caption bar');
  assert.match(display, /id="hud"[^>]*role="status"/, 'the display\'s connection line');
  assert.match(control, /id="update-banner"[^>]*role="alert"/);
  assert.match(control, /id="storage-warning"[^>]*role="alert"/);
});

// --- colour contrast ---------------------------------------------------------

const luminance = (hex) => {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const css = read('assets/css/podium.css');
// Two palettes: the dark one in the first :root block, and the light one
// (Issue #48, restored for #210) that redefines the same tokens. Read
// separately - one map over the whole file would let the light values
// silently replace the dark ones.
const tokensIn = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));
const tokens = tokensIn(css.match(/:root\s*\{[^}]*\}/)[0]);
const lightTokens = { ...tokens, ...tokensIn(css.match(/:root\[data-theme="light"\], body\[data-theme="light"\]\s*\{[^}]*\}/)?.[0] || '') };
const colourOf = (value, palette = tokens) => {
  if (!value) return null;
  const token = value.match(/var\(--([a-z0-9-]+)\)/);
  if (token) return palette[token[1]] || null;
  return value.trim().match(/^#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/i)?.[0] || null;
};

for (const [name, palette] of [['dark', tokens], ['light', lightTokens]]) {
  test(`the ${name} palette's text colours meet WCAG AA on the panels they sit on`, () => {
    for (const [fg, bg] of [['ink', 'bg'], ['ink', 'panel-2'], ['dim', 'bg'], ['dim', 'panel'], ['dim', 'panel-2'],
      ['accent', 'bg'], ['live', 'bg'], ['live', 'panel-2'], ['cue', 'bg'], ['ok', 'bg']]) {
      const ratio = contrast(palette[fg], palette[bg]);
      assert.ok(ratio >= 4.5, `${name}: --${fg} on --${bg} is ${ratio.toFixed(2)}:1`);
    }
    assert.ok(contrast('#ffffff', palette['live-fill']) >= 4.5, `${name}: white on --live-fill`);
    assert.ok(contrast(palette['on-accent'], palette.accent) >= 4.5,
      `${name}: --on-accent on --accent is ${contrast(palette['on-accent'], palette.accent).toFixed(2)}:1`);
  });
}

test('the light theme really is defined (it was once lost in a merge)', () => {
  assert.notEqual(lightTokens.bg, tokens.bg);
});

// Every rule that sets BOTH a text colour and a background it can be checked
// against - which is how the white-on-red and white-on-amber buttons were
// found in the first place.
test('no rule sets a text colour under 4.5:1 against its own background', () => {
  const failing = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2];
    // A light-theme rule's var(--x) means the light palette's --x.
    const palette = /data-theme="light"/.test(m[1]) ? lightTokens : tokens;
    const fg = colourOf(body.match(/(?:^|[;\s])color:\s*([^;]+)/)?.[1], palette);
    const bg = colourOf(body.match(/background(?:-color)?:\s*([^;]+)/)?.[1], palette);
    if (!fg || !bg) continue;
    const ratio = contrast(fg, bg);
    if (ratio < 4.5) failing.push(`line ${lineOf(css, m.index)} ${m[1].trim()}: ${fg} on ${bg} = ${ratio.toFixed(2)}:1`);
  }
  assert.deepEqual(failing, []);
});

test('keyboard focus is always drawn', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  assert.doesNotMatch(css, /outline:\s*(none|0)\b/, 'nothing takes the focus ring away');
});
