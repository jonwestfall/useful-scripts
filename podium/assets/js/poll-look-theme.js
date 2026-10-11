// The Marp themes this Podium has, and their colours for a poll (poll-look.js).
//
// A theme is read the way it is really drawn: one sample slide in it - a
// heading, a subheading, a link and some bold text - rendered by Marp with
// every theme this Podium has installed (deck.js), mounted out of sight, and
// its computed colours read off. So a theme that only sets CSS variables, or
// imports another and changes two colours, comes out as it looks.

import { render } from './deck.js';
import { colorsFromSlide } from './poll-look.js';

const BUILT_IN = ['default', 'gaia', 'uncover'];
const cache = new Map();
let listed = null;

/** The theme names a deck here can use: Marp's own and those in marp-themes/. */
export function listThemes() {
  listed ??= (async () => {
    const names = [...BUILT_IN];
    try {
      const res = await fetch('marp-themes/themes.json', { cache: 'no-cache' });
      if (res.ok) {
        const data = await res.json();
        for (const file of Array.isArray(data) ? data : data.themes || []) {
          try {
            const css = await (await fetch(`marp-themes/${file}`, { cache: 'no-cache' })).text();
            const name = /@theme\s+([\w-]+)/.exec(css)?.[1];
            if (name && !names.includes(name)) names.push(name);
          } catch { /* one broken theme does not hide the rest */ }
        }
      }
    } catch { /* no themes folder: the built-ins are still there */ }
    return names;
  })();
  return listed;
}

const sample = (theme) => `---
marp: true
theme: ${theme}
---

# Which would you pick?

## A subheading

Some text with **bold words** and [a link](https://example.edu).
`;

/** A theme's colours for a poll: { bg, fg, accent, extras }. */
export function themeColors(theme) {
  if (!cache.has(theme)) {
    cache.set(theme, (async () => {
      const deck = await render(sample(theme));
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText = 'position:fixed;left:-30000px;top:0;width:1280px;visibility:hidden;pointer-events:none;z-index:-1';
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>svg[data-marpit-svg]{display:block;width:1280px;height:auto}</style><style>${deck.css}</style>${deck.html}`;
      document.body.append(host);
      try {
        const section = shadow.querySelector('section');
        const style = getComputedStyle(section);
        const colorOf = (sel) => { const n = section.querySelector(sel); return n ? getComputedStyle(n).color : ''; };
        const probe = document.createElement('span');
        probe.style.cssText = 'position:absolute;color:var(--color-highlight, transparent)';
        section.append(probe);
        const highlight = getComputedStyle(probe).color;
        probe.remove();
        return colorsFromSlide({
          background: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          color: style.color,
          heading: colorOf('h1'),
          subheading: colorOf('h2'),
          link: colorOf('a'),
          strong: colorOf('strong'),
          highlight,
        });
      } finally {
        host.remove();
      }
    })().catch((err) => {
      cache.delete(theme);
      throw err;
    }));
  }
  return cache.get(theme);
}

/**
 * A look ready to put on a poll item: for mode 'theme', with the theme's
 * colours read in. Falls back to dark if the theme cannot be read.
 */
export async function resolveLook({ mode = 'dark', theme = '', palette = 'accent' } = {}) {
  if (mode !== 'theme') return { mode: mode === 'light' ? 'light' : 'dark', palette };
  try {
    return { mode, theme, palette, colors: await themeColors(theme || 'default') };
  } catch {
    return { mode: 'dark', palette };
  }
}
