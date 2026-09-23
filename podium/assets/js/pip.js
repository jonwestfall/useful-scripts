// The Picture-in-Picture settings panel on the controller (Issue #110) - a
// small, explicit interface, the same pattern watermark.js already
// established for splitting control.js along its own section boundaries
// (Issue #121).
//
// One pane full screen (main), another as a small bordered inset over a
// corner of it (inset) - which two, out of the same up-to-four independently
// staged panes every other layout already offers, is state.pip's own choice
// (see initialState/LAYOUTS.pip in protocol.js), not fixed by position the
// way B/C/D are under every other layout.

const LETTERS = ['A', 'B', 'C', 'D'];

/**
 * @param {object} deps
 * @param {Function} deps.$ - control.js's own querySelector-by-id helper.
 * @param {Function} deps.el - control.js's own DOM-builder helper.
 * @param {Function} deps.send - the shared command dispatcher; this panel
 *   never touches `state` or the bus directly, only through it.
 */
export function createPipPanel({ $, el, send }) {
  function render(state) {
    const settings = $('#pip-settings');
    if (!settings) return;
    const active = state.layout === 'pip';
    settings.hidden = !active;
    if (!active) return;

    const mainSelect = $('#pip-main');
    const insetSelect = $('#pip-inset');
    if (document.activeElement !== mainSelect) {
      mainSelect.replaceChildren(...LETTERS.map((l) =>
        el('option', { value: l, selected: l === state.pip.main }, `Pane ${l}`)));
    }
    if (document.activeElement !== insetSelect) {
      // Excludes whichever pane is main right now - not a static list, since
      // main can be any of the four and changes independently.
      insetSelect.replaceChildren(...LETTERS.filter((l) => l !== state.pip.main).map((l) =>
        el('option', { value: l, selected: l === state.pip.inset }, `Pane ${l}`)));
    }
    const cornerSelect = $('#pip-corner');
    if (document.activeElement !== cornerSelect) cornerSelect.value = state.pip.corner;
    const sizeInput = $('#pip-size');
    if (document.activeElement !== sizeInput) sizeInput.value = String(state.pip.size);
    $('#pip-size-label').textContent = `${state.pip.size}%`;
  }

  // A collision (picking the pane already on the other side) is resolved by
  // protocol.js itself, against whatever state.pip actually holds when the
  // command lands - not computed here, which would mean caching "what it
  // used to be" and risking exactly the kind of staleness a second change
  // in quick succession would expose.
  $('#pip-main').addEventListener('change', () => send({ op: 'pip', main: $('#pip-main').value }));
  $('#pip-inset').addEventListener('change', () => send({ op: 'pip', inset: $('#pip-inset').value }));
  $('#pip-corner').addEventListener('change', () => send({ op: 'pip', corner: $('#pip-corner').value }));
  $('#pip-size').addEventListener('input', () => {
    const value = $('#pip-size').value;
    $('#pip-size-label').textContent = `${value}%`;
    send({ op: 'pip', size: Number(value) });
  });

  return { render };
}
