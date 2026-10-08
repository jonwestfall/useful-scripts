// The showcase page. Unlike every other surface, this one has to work for
// someone who has never opened Podium before and may not be signed in at
// all - see AUTH_PUBLIC_WITH_ACCOUNTS in server/podium-server.js. It asks
// what kind of server it is talking to, same as admin.html and index.html's
// old inline script did, and draws one of three top bars:
//
//   - no server, or a server with no accounts yet: the three surfaces,
//     exactly as Podium has always offered them.
//   - a server with accounts, signed in: the surfaces plus who you are.
//   - a server with accounts, signed out: a Sign in link, and nothing that
//     would 401 if you clicked it.

import { $, el } from './util.js';
import { serverInfo, mountSessionBadge } from './server.js';
import { versionStamp } from './protocol.js';
import { startPageTheme } from './theme.js';

// Light or dark, as chosen for every page (see theme.js).
startPageTheme();

const stamp = $('#landing-version-stamp');
if (stamp) stamp.textContent = versionStamp();

const info = await serverInfo();
const loggedOut = info.auth.mode === 'accounts' && !info.user;
const nextParam = `?next=${encodeURIComponent('/index.html')}`;

function surfaceLinks(cls) {
  const links = [
    el('a', { href: 'display.html', class: cls }, 'Display'),
    el('a', { href: 'control.html', class: cls }, 'Controller'),
    el('a', { href: 'plan.html', class: cls }, 'Planning'),
    // Issue #226: the deck editor, its own page (opened from the planner too).
    el('a', { href: 'deck.html', class: cls }, 'Deck editor'),
    // Issue #161: reachable, but only ever functional once paired from the
    // display's own pairing sheet - see the comment beside its own link in
    // control.html's Settings. Not gated on any server feature: Guest
    // (Simple Mode) is pure client+relay, the same as every other surface
    // in this list.
    el('a', { href: 'guest.html', class: cls }, 'Guest'),
  ];
  // Same gate admin.html itself uses: present to any signed-in user on a
  // server with a library, not just administrators - a TA who can upload
  // decks should be able to find the page that lets them.
  if (info.features.includes('library')) links.push(el('a', { href: 'admin.html', class: cls }, 'Admin'));
  // Issue #243: everything that is yours, and your password. Accounts only -
  // without them nothing belongs to anybody.
  if (info.auth?.mode === 'accounts' && info.user) links.push(el('a', { href: 'me.html', class: cls }, 'My Files'));
  return links;
}

const nav = $('#topbar-nav');
const heroCta = $('#hero-cta');

if (loggedOut) {
  nav.append(el('a', { href: `login.html${nextParam}`, class: 'linkish landing-signin' }, 'Sign in'));
  heroCta.replaceChildren(
    el('a', { href: `login.html${nextParam}`, class: 'cta-link' }, el('button', { class: 'big-button landing-cta' }, 'Sign in to get started')),
  );
} else {
  nav.append(...surfaceLinks('linkish'));
  await mountSessionBadge($('#session-badge'));
  heroCta.replaceChildren(
    el('a', { href: 'control.html', class: 'cta-link' }, el('button', { class: 'big-button landing-cta' }, 'Open the Controller')),
    el('a', { href: 'display.html', class: 'cta-link' }, el('button', { class: 'landing-cta-secondary' }, 'Open the Display')),
  );
}
nav.hidden = false;
