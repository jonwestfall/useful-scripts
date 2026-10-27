// Gemini Notebook (formerly NotebookLM) links. No imports: deck-source.js,
// which the server loads too, uses this as well as the pages.
//
// A share link - a Video Overview's "Share", say - is Google's own page
// around the video, not the video. Google's pages refuse to be framed by
// other sites (google.com is on live-browser.js's list), the file behind the
// player is not reachable from outside it, and the live browser is muted, so
// none of Podium's ways of showing a page would play it with sound. The video
// itself downloads as an .mp4, which plays like any other: so these links are
// recognised wherever a video's address goes, and answered with how.
export function isNotebookLink(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { return false; }
  return /^(notebook|notebooklm)\.google\.com$/i.test(url.hostname) && /^\/notebook\//.test(url.pathname);
}

/** Why a Gemini Notebook link will not play, and how to get the video; each place adds where the .mp4 goes. */
export const NOTEBOOK_ADVICE = 'That is a Gemini Notebook link: Google’s page around the video, not the video itself, and Google does not let other sites play it. To show it, open the video in Gemini Notebook and choose ⋮ → Download, which gives you an .mp4.';
