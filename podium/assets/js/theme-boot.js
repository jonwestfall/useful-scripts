// Light or dark, before the page draws (see theme.js). A classic script in
// <head> on purpose: a module runs after the first paint, and every page would
// flash dark before turning light. It only reads this device's copy of the
// choice; theme.js brings in the account's and keeps it up to date.
//
// Not loaded by the projector's page (display.html, view.html): its stage is
// never themed, and only its own setup sheets follow the choice.
(function () {
  try {
    var choice = localStorage.getItem('podium.theme');
    if (choice !== 'light' && choice !== 'dark') {
      choice = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.dataset.theme = choice;
  } catch (_e) { /* storage blocked: the page's own default */ }
}());
