// Poll links made in advance (poll-link.js), as the planner and the controller
// show them: the link itself, a copy button, its QR code (to see, and to save
// as a picture for a handout), and - for a whole lecture's polls at once - a
// list to copy and a sheet to print or save as a PDF, links still clickable.

import { el } from './util.js';
import { pollBaseUrl } from './config.js';
import { serverInfo } from './server.js';
import { newPollKey, pollCodeForKey, formatPollCode, pollLinkUrl, isPollKey } from './poll-link.js';

export { newPollKey, isPollKey };

/**
 * Where a poll's link points: the relay that runs polls (pollBaseUrl), or -
 * on a device not set up for a room yet, such as the planner at a desk - the
 * Podium server that served this page, which runs them too. Null when there
 * is neither: polls need Podium's own relay.
 */
export async function resolvePollBase(cfg) {
  const configured = cfg ? pollBaseUrl(cfg) : null;
  if (configured) return configured;
  try {
    if ((await serverInfo())?.podium) return new URL('/', location.href).toString();
  } catch { /* no server */ }
  return null;
}

/** The QR code for `url`, as an <svg> string. */
export function qrSvg(url, cellSize = 6) {
  if (!url || typeof window.qrcode !== 'function') return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true });
}

/** The QR code for `url` as a PNG data URL, about `size` pixels square. */
export function qrPng(url, size = 600) {
  if (!url || typeof window.qrcode !== 'function') return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  const margin = 2;
  const cell = Math.max(1, Math.floor(size / (count + margin * 2)));
  const side = cell * (count + margin * 2);
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
    }
  }
  return canvas.toDataURL('image/png');
}

const fileSafe = (text) => String(text || 'poll').replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'poll';

export function downloadQr(url, question) {
  const png = qrPng(url);
  if (!png) return;
  el('a', { href: png, download: `poll-${fileSafe(question)}-qr.png` }).click();
}

async function copyText(text, button, done = 'Copied!') {
  const was = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = done;
  } catch {
    // No clipboard (plain http, or the browser said no): select it instead.
    window.prompt('Copy this:', text);
  }
  setTimeout(() => { button.textContent = was; }, 1800);
}

/**
 * One poll's link, as a block for an editor.
 *
 *   base      resolvePollBase()'s answer (null: polls are not available here)
 *   key       the poll's key, or '' for none yet
 *   question  for the QR picture's file name
 *   onChange  called with the new key ('' to remove the link)
 */
export function pollLinkBlock({ base, key, question = '', onChange }) {
  const box = el('div', { class: 'poll-link' });
  if (!base) {
    box.append(el('p', { class: 'hint' }, 'Links made in advance need Podium’s own server (or relay), which is where polls run.'));
    return box;
  }
  if (!isPollKey(key)) {
    box.append(
      el('button', { type: 'button', class: 'poll-link-make', onclick: () => onChange(newPollKey()) }, 'Make a link to share in advance'),
      el('p', { class: 'hint' }, 'For a handout, an email or a chat message before class: the link opens this poll once you start it, and anyone who opens it early waits for it.'),
    );
    return box;
  }
  const url = pollLinkUrl(base, key);
  const qr = el('div', { class: 'poll-link-qr', html: qrSvg(url, 4) });
  box.append(
    el('div', { class: 'poll-link-row' },
      qr,
      el('div', { class: 'poll-link-text' },
        el('a', { class: 'poll-link-url mono', href: url, target: '_blank', rel: 'noopener' }, url),
        el('p', { class: 'hint' }, `Code ${formatPollCode(pollCodeForKey(key))}. It works from the moment you start this poll, every time you start it.`),
        el('div', { class: 'inline poll-link-actions' },
          el('button', { type: 'button', onclick: (ev) => copyText(url, ev.currentTarget) }, 'Copy link'),
          el('button', { type: 'button', onclick: () => downloadQr(url, question) }, 'Save QR picture'),
          el('button', {
            type: 'button',
            title: 'The old link stops working',
            onclick: () => { if (window.confirm('Make a new link? The old one will stop working, so anything already sent out will need the new one.')) onChange(newPollKey()); },
          }, 'New link'),
          el('button', {
            type: 'button',
            onclick: () => { if (window.confirm('Remove this link? Anything already sent out stops working; the poll gets a code when it starts, as usual.')) onChange(''); },
          }, 'Remove'),
        ))),
  );
  return box;
}

/** "1. Question\n   https://…" for every poll that has a link. */
export function pollLinksText(polls, base) {
  return polls
    .filter((p) => isPollKey(p.link))
    .map((p, i) => `${i + 1}. ${String(p.question || 'Poll').split('\n')[0]}\n   ${pollLinkUrl(base, p.link)}`)
    .join('\n\n');
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * A page listing every linked poll with its link and QR code, opened in a new
 * tab - to print, or to save as a PDF (the links stay clickable), or to copy
 * from into a handout of your own.
 */
export function openPollLinkSheet(title, polls, base) {
  const linked = polls.filter((p) => isPollKey(p.link));
  const rows = linked.map((p, i) => {
    const url = pollLinkUrl(base, p.link);
    return `<section><div class="qr">${qrSvg(url, 4)}</div><div><h2>${i + 1}. ${escapeHtml(String(p.question || 'Poll').split('\n')[0])}</h2>`
      + `<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p class="code">Or go to ${escapeHtml(base)}join.html and enter <b>${escapeHtml(formatPollCode(pollCodeForKey(p.link)))}</b></p></div></section>`;
  }).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - poll links</title><style>
body{font:15px/1.45 system-ui,sans-serif;color:#111;background:#fff;max-width:760px;margin:24px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 4px}.sub{color:#555;margin:0 0 20px}
section{display:flex;gap:16px;align-items:center;padding:14px 0;border-top:1px solid #ddd;break-inside:avoid}
.qr{width:120px;flex:none}.qr svg{width:100%;height:auto;display:block}
h2{font-size:17px;margin:0 0 6px}a{color:#0645ad;word-break:break-all}.code{color:#555;font-size:13px;margin:4px 0 0}
@media print{.noprint{display:none}}</style></head><body>
<h1>${escapeHtml(title)}</h1><p class="sub">Poll links. Each opens its question when the presenter starts it; open one early and it waits.</p>
<p class="noprint"><button onclick="print()">Print or save as PDF</button></p>${rows}</body></html>`;
  const win = window.open(URL.createObjectURL(new Blob([html], { type: 'text/html' })), '_blank');
  if (!win) window.alert('Your browser blocked the new tab. Allow pop-ups for this page and try again.');
}

/**
 * A lecture's polls and their links, all together:
 *
 *   polls      [{ id, question, link }]
 *   onMakeAll  called to give every poll without a link one
 */
export function pollLinksSummary({ title, polls, base, onMakeAll }) {
  const box = el('div', { class: 'poll-links-summary' });
  if (!polls.length) return box;
  const linked = polls.filter((p) => isPollKey(p.link)).length;
  const missing = polls.length - linked;
  box.append(el('p', { class: 'hint' },
    !base ? 'Links made in advance need Podium’s own server (or relay), which is where polls run.'
      : linked === polls.length ? `All ${polls.length} poll${polls.length === 1 ? ' has a link' : 's have links'}, ready to share before class.`
        : `${linked} of ${polls.length} poll${polls.length === 1 ? '' : 's'} ${linked === 1 ? 'has' : 'have'} a link to share in advance.`));
  if (!base) return box;
  box.append(el('div', { class: 'inline' },
    missing ? el('button', { type: 'button', onclick: onMakeAll }, missing === polls.length ? 'Make links for every poll' : `Make links for the other ${missing}`) : null,
    linked ? el('button', { type: 'button', onclick: (ev) => copyText(pollLinksText(polls, base), ev.currentTarget) }, 'Copy all links') : null,
    linked ? el('button', { type: 'button', onclick: () => openPollLinkSheet(title, polls, base) }, 'Sheet to print or save as PDF') : null,
  ));
  return box;
}
