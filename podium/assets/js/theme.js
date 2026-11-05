// Light or dark, on every page.
//
// One choice - Dark, Light, or Follow this device - shared by every Podium page
// in this browser (localStorage 'podium.theme'), applied before the first paint
// by theme-boot.js and kept up to date here. On a server with accounts it is
// also the signed-in person's own (set on My Files): it follows them to every
// device they sign in from, and wins over whatever that device had.
//
// The projector's page is the exception: its stage is never themed, so it
// asks for `{ apply: false }` and themes only its own setup sheets through
// onThemeChange().
//
// The last choice made, anywhere, is the one that sticks. A choice is marked
// unsaved (THEME_UNSAVED_KEY) until the account has it, and a page that finds
// one waiting tells the account rather than taking the account's - so a
// click before the page knew who was signed in, a page left before the save
// arrived, or a choice made on the sign-in page (login.html, join.html and
// attend.html do the same in their own small scripts) is never undone by an
// older choice coming back from the server.

import { serverInfo } from './server.js';

export const THEME_KEY = 'podium.theme';
export const THEME_UNSAVED_KEY = 'podium.theme.unsaved';
export const THEMES = ['auto', 'light', 'dark'];
export const THEME_LABELS = { auto: 'Follow this device', light: 'Light', dark: 'Dark' };
const ICONS = { auto: '◐', light: '☀', dark: '☾' };

const lightPreferred = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: light)') : null;
const listeners = new Set();
let applyToPage = true;
let signedIn = false;
// Settles once this page knows whether someone is signed in (initTheme).
let ready = Promise.resolve();

/** What was chosen: 'auto', 'light' or 'dark'. */
export function themeChoice() {
  try {
    const choice = localStorage.getItem(THEME_KEY);
    return THEMES.includes(choice) ? choice : 'auto';
  } catch {
    return 'auto';
  }
}

/** What that comes to on this device right now: 'light' or 'dark'. */
export function effectiveTheme(choice = themeChoice()) {
  if (choice === 'light' || choice === 'dark') return choice;
  return lightPreferred?.matches ? 'light' : 'dark';
}

function apply() {
  const effective = effectiveTheme();
  if (applyToPage) {
    document.documentElement.dataset.theme = effective;
    if (document.body) document.body.dataset.theme = effective;
  }
  for (const button of document.querySelectorAll('.theme-toggle')) paintToggle(button);
  for (const listener of listeners) listener(effective, themeChoice());
}

function store(choice, { unsaved = false } = {}) {
  try {
    localStorage.setItem(THEME_KEY, choice);
    if (unsaved) localStorage.setItem(THEME_UNSAVED_KEY, '1');
    else localStorage.removeItem(THEME_UNSAVED_KEY);
  } catch { /* this visit only */ }
}

const unsaved = () => { try { return localStorage.getItem(THEME_UNSAVED_KEY) === '1'; } catch { return false; } };

/**
 * Tell the account. keepalive, so a page left straight after the click still
 * gets it there; the choice is only marked saved once the account has it,
 * and only if it is still the one on this device by then.
 */
async function saveToAccount(choice) {
  try {
    const res = await fetch('/api/me/preferences', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: choice }),
    });
    if (res.ok && themeChoice() === choice) store(choice);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Choose. Kept on this device and, when someone is signed in on a server with
 * accounts, on their account too. Resolves to whether the account took it.
 */
export async function setThemeChoice(choice) {
  if (!THEMES.includes(choice)) return false;
  store(choice, { unsaved: true });
  apply();
  // A click before the page has heard who is signed in waits for that,
  // rather than going unsaved and being undone by the account's older choice.
  await ready;
  if (!signedIn) return false;
  return saveToAccount(choice);
}

/** Called with (effective, choice) whenever either changes. */
export function onThemeChange(listener) {
  listeners.add(listener);
  listener(effectiveTheme(), themeChoice());
  return () => listeners.delete(listener);
}

function paintToggle(button) {
  const choice = themeChoice();
  const next = THEMES[(THEMES.indexOf(choice) + 1) % THEMES.length];
  button.textContent = ICONS[choice];
  button.title = `Theme: ${THEME_LABELS[choice]} — click for ${THEME_LABELS[next]}`;
  button.setAttribute('aria-label', `Theme: ${THEME_LABELS[choice]}. Change to ${THEME_LABELS[next]}`);
  button.dataset.themeChoice = choice;
}

/** A ☀ / ☾ / ◐ button that steps through the three choices. */
export function themeToggle() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'theme-toggle';
  button.addEventListener('click', () => {
    setThemeChoice(THEMES[(THEMES.indexOf(themeChoice()) + 1) % THEMES.length]);
  });
  paintToggle(button);
  return button;
}

/**
 * Start: apply this device's choice, follow the device's own light/dark when
 * that is the choice, and adopt the account's when someone is signed in.
 * `account: false` skips asking the server (pages nobody signs in to).
 */
export function initTheme({ apply: themePage = true, account = true } = {}) {
  applyToPage = themePage;
  apply();
  lightPreferred?.addEventListener?.('change', () => { if (themeChoice() === 'auto') apply(); });
  // Another tab changed it: follow.
  window.addEventListener('storage', (ev) => { if (ev.key === THEME_KEY) apply(); });
  if (!account) return Promise.resolve();
  ready = serverInfo().then((info) => {
    signedIn = !!info.user && info.auth?.mode === 'accounts';
    if (!signedIn) return;
    // A choice made here that the account has not got yet is newer than the
    // account's: it goes up. Otherwise the account's comes down.
    if (unsaved()) { saveToAccount(themeChoice()); return; }
    const theirs = info.user?.theme;
    if (THEMES.includes(theirs) && theirs !== themeChoice()) {
      store(theirs);
      apply();
    }
  });
  return ready;
}

/**
 * A page's whole part in it: start (see initTheme) and put the toggle at the
 * end of its top bar, or into `toggleIn` when that is somewhere else.
 */
export function startPageTheme({ toggleIn = '.topbar', ...opts } = {}) {
  const bar = typeof toggleIn === 'string' ? document.querySelector(toggleIn) : toggleIn;
  bar?.append(themeToggle());
  return initTheme(opts);
}
