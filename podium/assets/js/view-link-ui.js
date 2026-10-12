// A lecture's Guest View link made in advance (view-link.js), as the planner
// and the controller show it: the link, a copy button, its QR code (to see,
// and to save as a picture for a handout or an invite), and the typed code.

import { el } from './util.js';
import { qrSvg, downloadQr, copyText } from './poll-link-ui.js';
import { newViewLinkKey, isViewLinkKey, viewCodeForKey, formatViewCode, viewLinkUrl } from './view-link.js';

export { newViewLinkKey, isViewLinkKey };

/**
 * One lecture's viewer link.
 *
 *   base      resolvePollBase()'s answer (null: Podium's own server is not here)
 *   key       the lecture's key, or '' for none yet
 *   title     the lecture, for the QR picture's file name
 *   onChange  called with the new key ('' to remove the link); omitted, the
 *             link is shown without the buttons that change it
 */
export function viewLinkBlock({ base, key, title = '', onChange }) {
  const box = el('div', { class: 'poll-link view-link' });
  if (!base) {
    box.append(el('p', { class: 'hint' }, 'A viewer link made in advance needs Podium’s own server (or relay), which is what hands it to the display.'));
    return box;
  }
  if (!isViewLinkKey(key)) {
    if (!onChange) return box;
    box.append(
      el('button', { type: 'button', class: 'view-link-make', onclick: () => onChange(newViewLinkKey()) }, 'Make a viewer link to share in advance'),
      el('p', { class: 'hint' }, 'For an invitation, a handout or a chat message before the meeting: people open it on their own device and watch the classroom screen. It works once this lecture is loaded and the display goes live; anyone who opens it early waits for it.'),
    );
    return box;
  }
  const url = viewLinkUrl(base, key);
  box.append(
    el('div', { class: 'poll-link-row' },
      el('div', { class: 'poll-link-qr', html: qrSvg(url, 4) }),
      el('div', { class: 'poll-link-text' },
        el('a', { class: 'poll-link-url mono view-link-url', href: url, target: '_blank', rel: 'noopener' }, url),
        el('p', { class: 'hint' }, `Code ${formatViewCode(viewCodeForKey(key))}, or the QR. It works while this lecture is loaded on the controller and the display is live - watch and listen only.`),
        el('div', { class: 'inline poll-link-actions' },
          el('button', { type: 'button', onclick: (ev) => copyText(url, ev.currentTarget) }, 'Copy link'),
          el('button', { type: 'button', onclick: () => downloadQr(url, title, 'viewer') }, 'Save QR picture'),
          onChange ? el('button', {
            type: 'button',
            title: 'The old link stops working',
            onclick: () => { if (window.confirm('Make a new viewer link? The old one will stop working, so anything already sent out will need the new one.')) onChange(newViewLinkKey()); },
          }, 'New link') : null,
          onChange ? el('button', {
            type: 'button',
            onclick: () => { if (window.confirm('Remove this viewer link? Anything already sent out stops working.')) onChange(''); },
          }, 'Remove') : null,
        ))),
  );
  return box;
}
