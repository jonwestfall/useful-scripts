// The lecture recap as a PDF (Issue #158), shared by Administration's
// Lectures tab and My Files' Recorded lectures (Issue #243).

import { el } from './util.js';
import { createPdf, loadImage, planRecapPages, renderRecapPages } from './pdf-writer.js';
import { buildRecap } from './recap.js';

const pad = (n) => String(n).padStart(2, '0');

export const dayAndTime = (ms) => new Date(ms).toLocaleString(undefined, {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

/** How long it ran, in the units a person would say it in. */
export function spanOf(lecture) {
  if (!lecture.endedAt) return 'still open';
  const minutes = Math.max(0, Math.round((lecture.endedAt - lecture.startedAt) / 60000));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)}`;
}

export const safeName = (detail) => String(detail.title || detail.room || 'session')
  .replace(/[^a-z0-9-_ ]+/gi, '').trim().replace(/\s+/g, '-')
  .slice(0, 48)
  .toLowerCase() || 'session';

/**
 * The lecture recap (Issue #158): the timeline in order, the captions said
 * over each entry, annotated slides beside the moment they were shown, and
 * each poll's result where it closed - one PDF, from what the session already
 * recorded. See recap.js for the ordering and pdf-writer.js for the pages.
 */
export async function downloadSessionRecap(detail, button) {
  button.disabled = true;
  const was = button.textContent;
  try {
    const recap = buildRecap(detail);
    const meta = {
      title: detail.title || detail.room || 'Podium Session',
      course: detail.course || '',
      room: detail.room || '',
      date: detail.startedAt ? new Date(detail.startedAt) : new Date(),
    };
    const summary = [
      `${dayAndTime(detail.startedAt)} — ${spanOf(detail)}`,
      `${recap.blocks.filter((b) => b.type === 'entry').length} things on screen`,
      detail.pollResults.length ? `${detail.pollResults.length} poll${detail.pollResults.length === 1 ? '' : 's'}` : '',
      recap.captionCount ? `${recap.captionCount} caption line${recap.captionCount === 1 ? '' : 's'}` : 'no captions recorded',
      detail.truncated ? 'the timeline stops before the lecture did' : '',
    ].filter(Boolean).join('  ·  ');

    const measureCtx = document.createElement('canvas').getContext('2d');
    const measure = (text, font) => { measureCtx.font = font; return measureCtx.measureText(text).width; };
    const plan = planRecapPages(recap, measure, { summary });

    const pages = await renderRecapPages(plan, meta, {
      loadPicture: async (file) => {
        const res = await fetch(file.url, { credentials: 'same-origin' });
        return res.ok ? loadImage(await res.blob()) : null;
      },
      onProgress: (done, total) => { button.textContent = `Rendering page ${done} of ${total}…`; },
    });
    if (!pages.length) { button.textContent = 'Nothing to put in a recap'; return; }

    button.textContent = 'Building the PDF…';
    const stamp = new Date(detail.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const blob = createPdf(pages, { ...meta, title: `${meta.title} — recap` });
    const a = el('a', { href: URL.createObjectURL(blob), download: `podium-${safeName(detail)}-${stamp}-recap.pdf` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch {
    button.textContent = 'That did not work';
    return;
  } finally {
    button.disabled = false;
  }
  button.textContent = was;
}
