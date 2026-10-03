// Pictures and videos for deck slides (Issue #226).
//
// Everything put on a slide from this device goes into the library on the
// server first, and the slide links to it there: a deck stays a small text
// file, a picture is never pasted into it as a data: URL (one photo would be
// more than a controller can send a deck in), and the same photo on two
// slides is one library item. What is uploaded is filed under the deck's
// course - or under none, which by the library's own rule every signed-in
// account can see - in a "Deck media" group the controller keeps out of the
// way (see renderLibrary in control.js).
//
// A video slide is two directives and a poster:
//
//   <!-- _video: /media/<sha>/clip.webm -->
//   <!-- _videoStart: 1:05 -->
//   ![bg contain](/media/<sha>/clip-poster.jpg)
//
// The poster is grabbed here, from the frame the video starts on, and is what
// the slide shows until Play - and what thumbnails, slide photos and exports
// are made of. The display plays the video over it (see renderDeck in
// renderers.js).

import { $, $$, el } from './util.js';
import { encodeToFit } from './store.js';
import { parseTimecode, formatTimecode } from './deck-source.js';

// A projector is 1920 wide; a little more leaves room for zooming into a
// detail. Nothing bigger is ever worth sending to one.
const MAX_EDGE = 2560;
const KEEP_AS_IS_BYTES = 3 * 1024 * 1024;
const MAX_PICTURE_CHARS = Math.round(4 * 1024 * 1024 * 1.37);   // ~4 MB, as a data URL
const POSTER_EDGE = 1920;

/**
 * A picture ready to upload: as it is when it is already a sensible size for
 * a projector, otherwise scaled down (and a big PNG photo made a JPEG). An
 * animated GIF is never touched - re-encoding would keep only its first frame.
 *
 * @param {File|Blob} file
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function prepareImage(file) {
  const filename = pictureName(file);
  if (file.type === 'image/gif') return { blob: file, filename };
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return { blob: file, filename }; }
  const long = Math.max(bitmap.width, bitmap.height);
  if (long <= MAX_EDGE && file.size <= KEEP_AS_IS_BYTES) { bitmap.close?.(); return { blob: file, filename }; }
  // A PNG that is only too big because it is large (a big screenshot) stays
  // a PNG, so its text stays sharp - unless it is still too heavy that way,
  // which means it is really a photo and goes as a JPEG.
  let shrunk = file.type === 'image/png'
    ? encodeToFit(bitmap, MAX_PICTURE_CHARS, { widths: [MAX_EDGE], qualities: [1], mime: 'image/png' })
    : null;
  if (!shrunk || shrunk.tooBig) {
    shrunk = encodeToFit(bitmap, MAX_PICTURE_CHARS, { widths: [MAX_EDGE, 1920, 1600], qualities: [0.85, 0.75], mime: 'image/jpeg' });
  }
  bitmap.close?.();
  const blob = await (await fetch(shrunk.dataUrl)).blob();
  return { blob, filename: blob.type === 'image/jpeg' ? filename.replace(/\.\w+$/, '.jpg') : filename };
}

/** A name for an upload: its own, or for a pasted screenshot (always "image.png"), a dated one. */
function pictureName(file) {
  const raw = String(file.name || '').trim();
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[file.type] || '.png';
  if (!raw || /^image\.\w+$/i.test(raw)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    return `pasted-${stamp}${ext}`;
  }
  return /\.\w+$/.test(raw) ? raw : `${raw}${ext}`;
}

const waitFor = (target, event, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { target.removeEventListener(event, done); reject(new Error(`the video did not get to ${event}`)); }, ms);
  const done = () => { clearTimeout(timer); resolve(); };
  target.addEventListener(event, done, { once: true });
});

/**
 * The frame a video shows at `seconds`, as a JPEG. Throws when the browser
 * will not let the page read its pixels (a video from another site).
 *
 * @param {HTMLVideoElement} video - already given its src
 */
export async function grabPoster(video, seconds) {
  if (video.readyState < 1) await waitFor(video, 'loadedmetadata', 15000);
  const end = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : seconds;
  const at = Math.min(Math.max(0, seconds), end);
  if (Math.abs(video.currentTime - at) > 0.01 || video.readyState < 2) {
    const seeked = waitFor(video, 'seeked', 15000);
    video.currentTime = at;
    await seeked;
  }
  if (video.readyState < 2) await waitFor(video, 'loadeddata', 5000);
  const scale = Math.min(1, POSTER_EDGE / Math.max(video.videoWidth || 1, video.videoHeight || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((video.videoWidth || 1280) * scale));
  canvas.height = Math.max(1, Math.round((video.videoHeight || 720) * scale));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('the frame could not be saved'))), 'image/jpeg', 0.85);
    } catch (err) { reject(err); }
  });
}

/**
 * Put a picture or video into the library as deck media.
 * @returns {Promise<object>} the library item (with its /media/<sha>/<name> src)
 */
export async function uploadDeckMedia(blob, { filename, course = '', deckName = '' }) {
  const query = new URLSearchParams({
    filename, course, deckMedia: deckName || 'A deck', title: filename.replace(/\.\w+$/, ''),
  });
  const res = await fetch(`/api/library/upload?${query}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `the server said HTTP ${res.status}`);
  return body.item;
}

/**
 * The picture and video dialogs, and the paste and drop that open them.
 *
 * @param {object} deps
 * @param {() => boolean} deps.canUpload - signed in to a server with a library
 * @param {() => {code: string, title: string, role: string}[]} deps.courses
 * @param {() => string} deps.deckCourse - the course the deck is filed under, if any
 * @param {() => string} deps.deckName - what the uploads say they are for
 * @param {(tag: string) => void} deps.insertPicture
 * @param {(video: {src: string, start: number, poster: string}) => void} deps.makeVideoSlide
 * @param {() => ({src: string, start: number}|null)} deps.currentVideo
 * @param {() => void} deps.done - a dialog closed; give the editor its focus back
 */
export function createDeckMedia(deps) {
  let libraryCache = null;
  async function libraryItems() {
    if (!libraryCache) {
      libraryCache = fetch('/api/library', { credentials: 'same-origin' })
        .then((res) => (res.ok ? res.json() : { items: [] }))
        .then((body) => body.items || [])
        .catch(() => []);
    }
    return libraryCache;
  }

  // --- the bits both dialogs share ---

  function wireTabs(dialog, onChange) {
    const tabs = $$('[role="tab"]', dialog);
    const pick = (from) => {
      for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.from === from));
      for (const pane of $$('[data-pane]', dialog)) pane.hidden = pane.dataset.pane !== from;
      dialog.dataset.from = from;
      onChange?.(from);
    };
    tabs.forEach((tab) => tab.addEventListener('click', () => pick(tab.dataset.from)));
    return pick;
  }

  function prepareDialog(dialog, kind) {
    const online = deps.canUpload();
    for (const tab of $$('[role="tab"]', dialog)) tab.hidden = !online && tab.dataset.from !== 'address';
    $('.deck-media-offline', dialog).hidden = online;
    $('.deck-media-course', dialog).hidden = !online;
    if (online) fillCourses($(`#deck-${kind}-course`), $(`#deck-${kind}-course-hint`), kind);
    $(`#deck-${kind}-note`).textContent = '';
    dialog.hidden = false;
  }

  // Only courses whose decks you may edit - an owner's, or any for an admin.
  function fillCourses(select, hint, kind) {
    const owned = deps.courses().filter((c) => c.role === 'owner');
    select.replaceChildren(
      ...owned.map((c) => el('option', { value: c.code }, `${c.code.toUpperCase()} — ${c.title}`)),
      el('option', { value: '' }, 'No course'),
    );
    const wanted = (deps.deckCourse() || '').toLowerCase();
    select.value = owned.some((c) => c.code === wanted) ? wanted : '';
    const say = () => {
      const what = kind === 'video' ? 'this video and its poster' : 'this picture';
      hint.textContent = select.value
        ? `Everyone in ${select.value.toUpperCase()} can see ${what}, as they can the deck.`
        : `With no course, every signed-in account on this server can see ${what}.`;
    };
    select.onchange = say;
    say();
  }

  function fillLibrary(grid, search, type, onPick) {
    const show = async () => {
      const words = search.value.trim().toLowerCase();
      const items = (await libraryItems()).filter((item) => item.type === type
        && (!words || `${item.title} ${item.filename} ${item.group} ${item.deckMedia || ''} ${item.course || ''}`.toLowerCase().includes(words)));
      grid.replaceChildren(...(items.length ? items.slice(0, 120).map((item) => el('button', {
        type: 'button', role: 'option', class: 'deck-media-tile', 'aria-selected': 'false', title: item.title,
        onclick: (ev) => {
          $$('.deck-media-tile', grid).forEach((t) => t.setAttribute('aria-selected', String(t === ev.currentTarget)));
          onPick(item);
        },
      },
        type === 'image' ? el('img', { src: item.src, alt: '', loading: 'lazy' }) : el('span', { class: 'deck-media-icon', 'aria-hidden': 'true' }, '🎬'),
        el('span', {}, item.title || item.filename),
        item.course ? el('small', {}, item.course.toUpperCase()) : null)) : [el('p', { class: 'hint' }, words ? 'Nothing matches.' : `No ${type === 'image' ? 'pictures' : 'videos'} in the library yet.`)]));
    };
    search.oninput = show;
    show();
  }

  // --- pictures ---

  const picture = { file: null, src: '', item: null, objectUrl: '', prompted: false, busy: false };
  const pictureDialog = $('#deck-image-dialog');

  function chosePicture({ file = null, item = null } = {}) {
    if (picture.objectUrl) URL.revokeObjectURL(picture.objectUrl);
    picture.file = file;
    picture.item = item;
    picture.objectUrl = file ? URL.createObjectURL(file) : '';
    const chosen = $('.deck-media-chosen', pictureDialog);
    chosen.hidden = !file && !item;
    $('#deck-image-preview').src = picture.objectUrl || item?.src || '';
    $('#deck-image-chosen').textContent = file ? `${pictureName(file)} · ${Math.max(1, Math.round(file.size / 1024))} KB` : item ? `${item.title} · in the library` : '';
    if (file || item) $('#deck-image-alt').focus();
  }

  const pickPictureFrom = wireTabs(pictureDialog, (from) => {
    if (from === 'library') fillLibrary($('#deck-image-library'), $('#deck-image-search'), 'image', (item) => chosePicture({ item }));
    else if (from === 'address') { chosePicture(); $('#deck-image-src').focus(); }
  });

  function openPicture({ file = null } = {}) {
    picture.prompted = false;
    libraryCache = null;
    $('#deck-image-file').value = '';
    $('#deck-image-src').value = '';
    $('#deck-image-alt').value = '';
    $('#deck-image-width').value = '';
    $('#deck-image-place').value = 'inline';
    prepareDialog(pictureDialog, 'image');
    pickPictureFrom(deps.canUpload() ? 'device' : 'address');
    chosePicture(file ? { file } : {});
    if (!file) (deps.canUpload() ? $('#deck-image-file') : $('#deck-image-src')).focus();
  }

  function closePicture() {
    pictureDialog.hidden = true;
    chosePicture();
    deps.done();
  }

  $('#deck-image-file').addEventListener('change', (ev) => { if (ev.target.files?.[0]) chosePicture({ file: ev.target.files[0] }); });
  $('#deck-image-cancel').addEventListener('click', closePicture);
  $('#deck-image-go').addEventListener('click', async () => {
    if (picture.busy) return;
    const from = pictureDialog.dataset.from;
    const note = $('#deck-image-note');
    const place = $('#deck-image-place').value;
    const alt = $('#deck-image-alt').value.trim().replace(/[[\]]/g, '');
    if (from === 'device' && !picture.file) { note.textContent = 'Choose a picture first.'; $('#deck-image-file').focus(); return; }
    if (from === 'library' && !picture.item) { note.textContent = 'Pick a picture first.'; return; }
    if (from === 'address' && !$('#deck-image-src').value.trim()) { note.textContent = 'Give the picture\'s address first.'; $('#deck-image-src').focus(); return; }
    // A gentle nudge, once: a background is decoration, but a picture in the
    // slide is content, and its description is all some of the room gets.
    if (place === 'inline' && !alt && !picture.prompted) {
      picture.prompted = true;
      note.textContent = 'Describe the picture first: it is what screen readers and Guest View get instead. Press Add again to go ahead without one.';
      $('#deck-image-alt').focus();
      return;
    }
    let src;
    picture.busy = true;
    try {
      if (from === 'device') {
        note.textContent = 'Adding it to the library…';
        const ready = await prepareImage(picture.file);
        const item = await uploadDeckMedia(ready.blob, { filename: ready.filename, course: $('#deck-image-course').value, deckName: deps.deckName() });
        src = item.src;
      } else if (from === 'library') {
        src = picture.item.src;
      } else {
        src = $('#deck-image-src').value.trim();
      }
    } catch (err) {
      note.textContent = `That did not upload: ${err.message}`;
      return;
    } finally {
      picture.busy = false;
    }
    const width = Number($('#deck-image-width').value);
    const words = [place === 'inline' ? '' : place, width > 0 ? `w:${Math.round(width)}` : '', alt].filter(Boolean);
    closePicture();
    deps.insertPicture(`![${words.join(' ')}](${src.replace(/\s/g, '%20')})`);
  });

  // --- video slides ---

  const video = { file: null, item: null, objectUrl: '', busy: false };
  const videoDialog = $('#deck-video-dialog');
  const preview = $('#deck-video-preview');

  function choseVideo({ file = null, item = null, src = '' } = {}) {
    if (video.objectUrl) URL.revokeObjectURL(video.objectUrl);
    video.file = file;
    video.item = item;
    video.objectUrl = file ? URL.createObjectURL(file) : '';
    const url = video.objectUrl || item?.src || src;
    preview.hidden = !url;
    $('#deck-video-here').disabled = !url;
    if (url) {
      preview.src = url;
      const start = parseTimecode($('#deck-video-start').value);
      if (start) preview.addEventListener('loadedmetadata', () => { preview.currentTime = start; }, { once: true });
    } else {
      preview.removeAttribute('src');
      preview.load();
    }
  }

  const pickVideoFrom = wireTabs(videoDialog, (from) => {
    if (from === 'library') fillLibrary($('#deck-video-library'), $('#deck-video-search'), 'video', (item) => choseVideo({ item }));
    else if (from === 'address') { choseVideo({ src: $('#deck-video-src').value.trim() }); $('#deck-video-src').focus(); }
    else choseVideo({ file: $('#deck-video-file').files?.[0] || null });
  });

  function openVideo({ file = null } = {}) {
    libraryCache = null;
    const now = deps.currentVideo();
    $('#deck-video-file').value = '';
    $('#deck-video-src').value = now?.src || '';
    $('#deck-video-start').value = now?.start ? formatTimecode(now.start) : '';
    $('#deck-video-heading').textContent = now ? 'Change this slide\'s video' : 'Make this a video slide';
    prepareDialog(videoDialog, 'video');
    const from = file || (deps.canUpload() && !now) ? 'device' : 'address';
    pickVideoFrom(from);
    if (file) choseVideo({ file });
    (file ? $('#deck-video-start') : from === 'device' ? $('#deck-video-file') : $('#deck-video-src')).focus();
  }

  function closeVideo() {
    videoDialog.hidden = true;
    choseVideo();
    deps.done();
  }

  $('#deck-video-file').addEventListener('change', (ev) => choseVideo({ file: ev.target.files?.[0] || null }));
  $('#deck-video-src').addEventListener('change', (ev) => choseVideo({ src: ev.target.value.trim() }));
  $('#deck-video-start').addEventListener('change', (ev) => {
    const seconds = parseTimecode(ev.target.value);
    ev.target.value = ev.target.value.trim() ? formatTimecode(seconds) : '';
    if (preview.getAttribute('src') && preview.readyState >= 1) preview.currentTime = seconds;
  });
  $('#deck-video-here').addEventListener('click', () => {
    $('#deck-video-start').value = formatTimecode(preview.currentTime || 0);
  });
  $('#deck-video-cancel').addEventListener('click', closeVideo);
  $('#deck-video-go').addEventListener('click', async () => {
    if (video.busy) return;
    const from = videoDialog.dataset.from;
    const note = $('#deck-video-note');
    const typed = $('#deck-video-src').value.trim();
    if (from === 'device' && !video.file) { note.textContent = 'Choose a video first.'; $('#deck-video-file').focus(); return; }
    if (from === 'library' && !video.item) { note.textContent = 'Pick a video first.'; return; }
    if (from === 'address' && !typed) { note.textContent = 'Give the video\'s address first.'; $('#deck-video-src').focus(); return; }
    const start = parseTimecode($('#deck-video-start').value);
    const course = $('#deck-video-course').value;
    const deckName = deps.deckName();
    video.busy = true;
    $('#deck-video-go').disabled = true;
    try {
      let src = from === 'library' ? video.item.src : typed;
      let base = (from === 'device' ? video.file.name : decodeURIComponent(src.split(/[?#]/)[0].split('/').pop() || 'video')).replace(/\.\w+$/, '');
      if (from === 'device') {
        note.textContent = `Adding ${video.file.name} to the library…`;
        const item = await uploadDeckMedia(video.file, { filename: video.file.name, course, deckName });
        src = item.src;
        base = (item.filename || video.file.name).replace(/\.\w+$/, '');
      }
      let poster = '';
      if (deps.canUpload()) {
        note.textContent = 'Making its poster…';
        try {
          const frame = await grabPoster(preview, start);
          const item = await uploadDeckMedia(frame, { filename: `${base}-poster.jpg`, course, deckName });
          poster = item.src;
        } catch (err) {
          // A video from another site will not give up its pixels. The
          // slide still works; "Check before class" says it has no poster.
          note.textContent = `No poster: ${err.message}.`;
        }
      }
      closeVideo();
      deps.makeVideoSlide({ src, start, poster });
    } catch (err) {
      note.textContent = `That did not work: ${err.message}`;
    } finally {
      video.busy = false;
      $('#deck-video-go').disabled = false;
    }
  });

  // --- pasted and dropped files ---

  /** Open the right dialog for files pasted or dropped. True if any were used. */
  function takeFiles(files) {
    const list = Array.from(files || []);
    const image = list.find((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    const clip = list.find((f) => /^video\/(mp4|webm)$/.test(f.type) || /\.(mp4|webm)$/i.test(f.name || ''));
    if (!image && !clip) return false;
    if (!deps.canUpload()) return false;
    if (image) openPicture({ file: image });
    else openVideo({ file: clip });
    return true;
  }

  for (const dialog of [pictureDialog, videoDialog]) {
    dialog.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); (dialog === pictureDialog ? closePicture : closeVideo)(); }
    });
  }

  return { openPicture, openVideo, takeFiles };
}
