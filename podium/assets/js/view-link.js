// A Guest View link made before class (planner), so "watch on your own
// device" can go in a handout or a calendar invite ahead of the meeting.
//
// The display's own viewer link (see Guest View in display.js) is a long
// fragment carrying its view room, key and public signing key - made by the
// display, on the day. A planned link is short instead, view.html?c=CODE,
// and works the way a poll link does (poll-link.js): the lecture plan keeps
// a secret KEY, the code is worked out from it -
//
//   code = the first 10 characters of SHA-256("podium-view-link\n" + key),
//          in the relay's alphabet
//
// - and the display, given the key by the controller that loaded the plan,
// registers that code for its real viewer link when it goes live
// (server/view-codes.js). Before then the code answers nothing, and a phone
// that opens the link early waits and picks the class up by itself (the
// viewer side of display.js). Knowing the link is not enough to claim the
// code first: that takes the key.

import { isPollKey, newPollKey, linkCodeForKey, formatPollCode } from './poll-link.js';

export const isViewLinkKey = isPollKey;
export const newViewLinkKey = newPollKey;

/** The code a planned viewer link opens under, or '' for something that is not a key. */
export const viewCodeForKey = (key) => linkCodeForKey('podium-view-link', key);

/** "ABCDE-FGHJK", easier to read off a page. */
export const formatViewCode = formatPollCode;

/** The link a planned viewer key is watched at, given the relay's base URL (pollBaseUrl). */
export function viewLinkUrl(base, key) {
  const code = viewCodeForKey(key);
  return base && code ? `${base}view.html?c=${code}` : '';
}
