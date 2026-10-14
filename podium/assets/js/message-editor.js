// The full-screen message editor on the controller (Issue #103), split out
// of control.js.
//
// One item shape - type 'text' with body/size/align/font/bg/color/src/caption -
// that normalizeItem() in protocol.js already validates and renderText() in
// renderers.js already draws; this modal is just a form for it, following
// the same open/close/Escape/click-outside convention #modal-countdown
// (in control.js) already established. The picture reuses the exact asset pipeline
// every other picture in this app uses - downscaleImage, assetStore,
// pushAssetIfHeld via stage() itself - by living on `src`, the same field
// name 'image' items already use, rather than a name of its own.

import { $, $$, uid } from './util.js';
import { createRenderer } from './renderers.js';
import { downscaleImage } from './store.js';
import { assetRef, MAX_ASSET_CHARS } from './planfile.js';

/**
 * @param {object} deps
 * @param {Function} deps.stage - puts an item on the controller's stage.
 * @param {Function} deps.resolveAssets - swaps asset:<id> references for the bytes this device holds.
 * @param {Map} deps.assetStore - this device's id -> bytes cache (see assets.js).
 */
export function createMessageEditor({ stage, resolveAssets, assetStore }) {
  let messageImageSrc = '';  // '' or an asset:<id> reference
  let messageBg = '';        // '' (Default) or a #hex, from a preset or the custom picker
  let messageFg = '';        // the same, for the words themselves (Issue #222)
  let messagePreviewRenderer = null;

  function currentMessageItem() {
    return {
      type: 'text',
      title: 'Message',
      body: $('#msg-body').value,
      size: $('#msg-size').value,
      align: $('#msg-align').value,
      font: $('#msg-font').value,
      bg: messageBg,
      color: messageFg,
      src: messageImageSrc,
      caption: $('#msg-caption').value,
    };
  }

  function updateMessagePreview() {
    // resolveAssets swaps the 'asset:<id>' reference back to the real data URL
    // this device is holding - the same step every other live preview in this
    // file takes before handing an item to the renderer (an 'asset:' string is
    // not a URL the <img> tag can load on its own).
    const item = resolveAssets(currentMessageItem());
    if (!messagePreviewRenderer) {
      messagePreviewRenderer = createRenderer(item, { preview: true });
      $('#message-preview-box').append(messagePreviewRenderer.el);
    } else {
      messagePreviewRenderer.update(item);
    }
  }

  function selectMessageBg(value, swatch) {
    messageBg = value;
    $$('#msg-bg-swatches .bg-swatch').forEach((b) => {
      b.classList.toggle('is-on', b === swatch);
      b.setAttribute('aria-pressed', String(b === swatch));
    });
    $('#msg-bg-custom-label').classList.toggle('is-on', !swatch);
    updateMessagePreview();
  }
  $$('#msg-bg-swatches .bg-swatch').forEach((b) => b.addEventListener('click', () => selectMessageBg(b.dataset.bg, b)));
  $('#msg-bg-custom').addEventListener('input', (ev) => {
    $('#msg-bg-custom-label').style.setProperty('--custom-bg-color', ev.target.value);
    selectMessageBg(ev.target.value, null);
  });

  function selectMessageFg(value, swatch) {
    messageFg = value;
    $$('#msg-fg-swatches .bg-swatch').forEach((b) => {
      b.classList.toggle('is-on', b === swatch);
      b.setAttribute('aria-pressed', String(b === swatch));
    });
    $('#msg-fg-custom-label').classList.toggle('is-on', !swatch);
    updateMessagePreview();
  }
  $$('#msg-fg-swatches .bg-swatch').forEach((b) => b.addEventListener('click', () => selectMessageFg(b.dataset.fg, b)));
  $('#msg-fg-custom').addEventListener('input', (ev) => {
    $('#msg-fg-custom-label').style.setProperty('--custom-bg-color', ev.target.value);
    selectMessageFg(ev.target.value, null);
  });

  function setMessageImage(src, note) {
    messageImageSrc = src;
    $('#msg-image-clear').hidden = !src;
    $('#msg-caption').hidden = !src;
    if (!src) $('#msg-caption').value = '';
    $('#msg-image-note').textContent = note || '';
    updateMessagePreview();
  }
  $('#msg-image').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    $('#msg-image-note').textContent = `Resizing ${file.name}…`;
    try {
      const shrunk = await downscaleImage(file, MAX_ASSET_CHARS);
      const id = uid(10);
      assetStore.set(id, shrunk.dataUrl);
      setMessageImage(assetRef(id), shrunk.tooBig
        ? `${file.name} is still ${Math.round(shrunk.dataUrl.length / 1024)} KB after resizing, which is more than a relay message can carry — it may not reach the projector.`
        : `${file.name} attached.`);
    } catch (err) {
      $('#msg-image-note').textContent = `That did not load: ${err.message}`;
    }
  });
  $('#msg-image-clear').addEventListener('click', () => setMessageImage('', ''));

  for (const id of ['msg-body', 'msg-size', 'msg-align', 'msg-font', 'msg-caption']) {
    $(`#${id}`).addEventListener('input', updateMessagePreview);
  }

  function openMessageEditor() {
    $('#message-editor').hidden = false;
    updateMessagePreview();
    $('#msg-body').focus();
  }
  function closeMessageEditor() {
    $('#message-editor').hidden = true;
  }
  $('#text-open-editor').addEventListener('click', openMessageEditor);
  $('#message-editor-cancel').addEventListener('click', closeMessageEditor);
  $('#message-editor').addEventListener('click', (ev) => {
    if (ev.target === $('#message-editor')) closeMessageEditor();
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('#message-editor').hidden) closeMessageEditor();
  });
  $('#message-editor-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    stage(currentMessageItem());
    closeMessageEditor();
  });
}
