// Asking the server for a backup and saving it (server/backup.js), for My
// Files and the admin page.
//
// Two steps. Asking says what is wanted and gets back what that holds and how
// big the ZIP will be; saving is an ordinary download of the ticket it hands
// back, so the browser writes the file as it arrives and shows its own
// progress, however many gigabytes it is - nothing here holds it in memory.
// A big backup, or one with things left out, is shown first and confirmed.

import { el } from './util.js';

const CONFIRM_OVER = 200 * 1024 * 1024;

export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "12 files, 3 lectures and 1 recorded lecture" */
export function describeSummary(s) {
  const parts = [
    s.items && plural(s.items, 'library item'),
    s.plans && plural(s.plans, 'lecture'),
    s.lectures && plural(s.lectures, 'recorded lecture'),
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'nothing';
}

/** Ask the server what a backup holds. Throws with the server's reason. */
export async function askForBackup(spec) {
  const res = await fetch('/api/export', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `the server said ${res.status}`);
  return data;
}

/** Save a backup the server has said it will make. */
export function saveBackup(answer) {
  const link = el('a', { href: `/api/export/${encodeURIComponent(answer.ticket)}`, download: answer.fileName, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
}

function confirmBackup(answer, title) {
  return new Promise((resolve) => {
    const s = answer.summary;
    const card = el('div', { class: 'deck-dialog-card me-dialog backup-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('h2', {}, title),
      el('p', {}, `${describeSummary(s)}: ${plural(s.files, 'file')}, a ${formatSize(answer.zipBytes)} ZIP.`),
      answer.zipBytes > CONFIRM_OVER
        ? el('p', { class: 'hint' }, 'A big download. Keep this page open until your browser says it has finished.')
        : null,
      s.skipped?.length
        ? el('div', { class: 'backup-skipped' },
          el('p', { class: 'hint' }, `Left out (${s.skipped.length}):`),
          el('ul', {}, ...s.skipped.slice(0, 12).map((x) => el('li', {}, `${x.what}: ${x.why}`)),
            s.skipped.length > 12 ? el('li', {}, `…and ${s.skipped.length - 12} more, listed in the backup's README.`) : null))
        : null);
    const wrap = el('div', { class: 'deck-dialog' }, card);
    const done = (value) => { wrap.remove(); resolve(value); };
    card.append(el('div', { class: 'admin-actions' },
      el('button', { type: 'button', class: 'primary', onclick: () => done(true) }, 'Download'),
      el('button', { type: 'button', onclick: () => done(false) }, 'Cancel')));
    wrap.addEventListener('click', (ev) => { if (ev.target === wrap) done(false); });
    wrap.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') done(false); });
    document.body.append(wrap);
    card.querySelector('button.primary').focus();
  });
}

/**
 * Back up what `spec` names: ask, confirm if it is big or leaves things out,
 * save. `say(text, bad)` is told how it went.
 */
export async function runBackup(spec, { title = 'Back up', say = () => {} } = {}) {
  say('Working out what goes in the backup…');
  let answer;
  try { answer = await askForBackup(spec); } catch (err) { say(`No backup: ${err.message}`, true); return null; }
  if ((answer.zipBytes > CONFIRM_OVER || answer.summary.skipped?.length) && !(await confirmBackup(answer, title))) {
    say('');
    return null;
  }
  saveBackup(answer);
  say(`Downloading ${answer.fileName}: ${describeSummary(answer.summary)}, ${formatSize(answer.zipBytes)}.`);
  return answer;
}
