// Every upload to this server's library goes through here: the controller,
// the planner, the deck editor's pictures and videos, Admin, My Files and
// Word files. One reason, in words, when one fails - never just "that did
// not work".
//
// The reasons an upload fails are few, and each looks different from here:
//
//   - too big: refused before a byte is sent, since the server says what it
//     takes (capabilities, uploadBytes). A proxy in front of Podium can be
//     stricter still; it answers 413 with a page of its own, not JSON.
//   - signed out, not allowed, a kind of file Podium does not take: Podium
//     answers with JSON saying so, passed on as it is.
//   - the server, or the proxy in front of it, gave up: 502/503/504, with no
//     JSON - restarting, or a slow upload that outlasted the proxy's wait.
//   - the connection was cut: the browser gets no answer at all. A server
//     refusing a too-big body mid-upload looks exactly like this.

import { serverInfo } from './server.js';

/** "48.2 MB", "730 KB". */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

const isVideo = (name) => /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(name || '');

function tooBigAdvice(name) {
  return isVideo(name)
    ? 'Trim the clip or export it smaller (720p is plenty for a projector), or put it on YouTube and add the link instead.'
    : 'Make the file smaller.';
}

/** The reason, when the file is bigger than the server takes; '' when it is not (or the limit is unknown). */
export function tooBigReason(name, bytes, limit) {
  if (!limit || !(bytes > limit)) return '';
  return `${name} is ${formatBytes(bytes)}, and this server takes files up to ${formatBytes(limit)}. ${tooBigAdvice(name)}`;
}

/**
 * Why an upload the server answered failed, in words. `answer` is its JSON,
 * or {} when it sent none (a proxy's own error page).
 */
export function uploadFailureReason({ status, answer = {}, name = 'That file', bytes = 0, limit = 0 }) {
  const said = typeof answer.error === 'string' ? answer.error.trim() : '';
  const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.');
  if (status === 413) {
    return tooBigReason(name, bytes, limit)
      || `${name}${bytes ? ` (${formatBytes(bytes)})` : ''} is bigger than this server accepts${said ? '' : ' - or than a proxy in front of it accepts (in nginx, client_max_body_size)'}. ${tooBigAdvice(name)}`;
  }
  if (status === 401) return 'You are signed out. Reload the page, sign in again, and try once more.';
  if (status === 415 && isVideo(name) && /\.(mov|m4v|avi|mkv)$/i.test(name)) {
    return `${said ? sentence(said) : `Podium does not take ${name.split('.').pop()} files.`} Videos need to be .mp4 or .webm: on an iPhone, share the video and choose "Options > Most Compatible", or convert it to .mp4 first.`;
  }
  if (said) return sentence(said);
  if (status === 403) return 'This account may not add files here.';
  if (status === 404) return 'This server has no library to upload to.';
  if (status === 502 || status === 503) return `The server did not answer (HTTP ${status}): it may be restarting. Wait a minute and try again.`;
  if (status === 504) {
    return `The server took too long to answer (HTTP 504)${bytes > 20 * 1024 * 1024 ? `: ${formatBytes(bytes)} can take longer to arrive than the proxy in front of Podium waits` : ''}. Try again on a faster connection, or with a smaller file.`;
  }
  if (status >= 500) return `Something went wrong on the server (HTTP ${status}). Whoever runs it can find the reason in Podium's log.`;
  return `The server refused it (HTTP ${status}).`;
}

/** Why an upload the server never answered failed - the connection itself broke. */
export function connectionFailureReason({ name = 'That file', bytes = 0, limit = 0 } = {}) {
  const big = bytes > 10 * 1024 * 1024;
  return `The connection was cut off before the server answered${bytes ? ` (${name}, ${formatBytes(bytes)})` : ''}. `
    + (big
      ? `A file this size is often refused partway by a proxy in front of Podium${limit ? ` (this server itself takes up to ${formatBytes(limit)})` : ''}, or the network dropped while it was sending. Try again on a steadier connection, or with a smaller file.`
      : 'Check this device is still online, then try again.');
}

/** What this server takes, in bytes, or 0 when it does not say. */
export async function uploadLimit() {
  try { return Number((await serverInfo()).uploadBytes) || 0; } catch { return 0; }
}

/**
 * Upload `body` (a File, Blob or string) to the library with these query
 * parameters (filename, title, course, ...). Resolves with the server's
 * answer ({ item, ... }); rejects with an Error whose message says why.
 */
export async function uploadToLibrary(params, body, { contentType = '' } = {}) {
  const query = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const name = query.get('filename') || 'That file';
  const blob = typeof body === 'string' ? new Blob([body]) : body;
  const bytes = blob?.size || 0;
  const limit = await uploadLimit();
  const early = tooBigReason(name, bytes, limit);
  if (early) throw Object.assign(new Error(early), { status: 413 });
  let res;
  try {
    res = await fetch(`/api/library/upload?${query}`, {
      method: 'POST', credentials: 'same-origin',
      ...(contentType ? { headers: { 'content-type': contentType } } : {}),
      body,
    });
  } catch {
    throw new Error(connectionFailureReason({ name, bytes, limit }));
  }
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(uploadFailureReason({ status: res.status, answer, name, bytes, limit })), { status: res.status });
  return answer;
}
