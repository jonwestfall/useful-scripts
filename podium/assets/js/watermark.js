// The watermark panel on the controller (Issue #121 - first slice of
// splitting control.js along its existing section boundaries, starting with
// the most self-contained features).
//
// A name or logo pinned to one corner for the whole lecture, not content - so
// it is set here once rather than picked and lost the next time the screen
// changes. Text and image are independent fields: typing new text does not
// erase an uploaded logo (Remove image is its own button), and the display
// shows whichever one is actually set, image first.

/**
 * @param {object} deps
 * @param {Function} deps.$ - control.js's own querySelector-by-id helper.
 * @param {Function} deps.uid - random id generator, for a newly uploaded logo.
 * @param {Function} deps.downscaleImage - shrinks an uploaded file to a data URL.
 * @param {number} deps.MAX_ASSET_CHARS - the same cap every uploaded asset is held to.
 * @param {Function} deps.assetRef - wraps an asset id as the `asset:<id>` reference items carry.
 * @param {Map} deps.assetStore - this device's id -> bytes cache (see assets.js).
 * @param {Function} deps.send - the shared command dispatcher; this panel never
 *   touches `state` or the bus directly, only through it.
 */
export function createWatermarkPanel({ $, uid, downscaleImage, MAX_ASSET_CHARS, assetRef, assetStore, send }) {
  function render(state) {
    const wm = state.watermark || { enabled: false, text: '', image: '', position: 'br' };
    if (document.activeElement !== $('#watermark-position')) $('#watermark-position').value = wm.position === 'tl' ? 'tl' : 'br';
    $('#watermark-hide').disabled = !wm.enabled;
    $('#watermark-image-clear').hidden = !wm.image;
    const parts = [wm.enabled ? 'showing' : 'hidden'];
    if (wm.image) parts.push('a logo');
    else if (wm.text) parts.push(`“${wm.text}”`);
    else parts.push('nothing set yet');
    $('#watermark-note').textContent = parts.join(' · ');
  }

  $('#watermark-position').addEventListener('change', () => send({ op: 'watermark', position: $('#watermark-position').value }));
  $('#watermark-hide').addEventListener('click', () => send({ op: 'watermark', enabled: false }));
  $('#watermark-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = $('#watermark-text').value.trim();
    if (!text) return;
    send({ op: 'watermark', text, enabled: true });
  });
  $('#watermark-image').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    $('#watermark-note').textContent = `Resizing ${file.name}…`;
    try {
      // PNG rather than the photo ladder's JPEG: a logo's transparent
      // background needs an alpha channel, or it comes out as a black box in
      // the corner. Small dimensions and a single-entry `qualities` (PNG
      // ignores it) keep this from wastefully re-encoding four times over.
      const shrunk = await downscaleImage(file, MAX_ASSET_CHARS, { widths: [480, 320, 200, 120], qualities: [1], mime: 'image/png' });
      const id = uid(10);
      assetStore.set(id, shrunk.dataUrl);
      send({ op: 'watermark', image: assetRef(id), enabled: true });
    } catch (err) {
      $('#watermark-note').textContent = `That did not load: ${err.message}`;
    }
  });
  $('#watermark-image-clear').addEventListener('click', () => send({ op: 'watermark', image: '' }));

  return { render };
}
