// Gemini Notebook (NotebookLM) share links (assets/js/notebook-link.js):
// recognised wherever a video's address is pasted, and answered with how to
// get the video, since the link itself is Google's page and will not play.
//
//   node podium/test/notebook-link.test.mjs

import { isNotebookLink, NOTEBOOK_ADVICE } from '../assets/js/notebook-link.js';
import { guessItemFromUrl } from '../assets/js/util.js';
import { checkDeck } from '../assets/js/deck-source.js';

const fails = [];
const ok = (label, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + label); if (!cond) fails.push(label); };

const shared = 'https://notebook.google.com/notebook/45b35af0-aeae-48c4-b6c7-3f73573fcd8f/artifact/03629246-4dd3-4c47-ae74-3f088876078e?utm_source=nlm_web_share&utm_medium=google_oo&utm_campaign=art_share_1&utm_content=&utm_smc=nlm_web_share_google_oo_art_share_1_';
ok('a shared Video Overview link is a Gemini Notebook link', isNotebookLink(shared));
ok('so is the older NotebookLM address', isNotebookLink('https://notebooklm.google.com/notebook/45b35af0-aeae-48c4-b6c7-3f73573fcd8f'));
ok('and one pasted with spaces around it', isNotebookLink(`  ${shared}  `));
ok('Google Drive is not', !isNotebookLink('https://drive.google.com/file/d/abc/view'));
ok('a look-alike host is not', !isNotebookLink('https://notebook.google.com.example.com/notebook/x'));
ok('nor is the bare site, or nothing', !isNotebookLink('https://notebook.google.com/') && !isNotebookLink('') && !isNotebookLink('not a link'));

const guess = guessItemFromUrl(shared);
ok(`pasted as a link it is a web page called Gemini Notebook (${JSON.stringify(guess)})`, guess?.type === 'web' && guess.title === 'Gemini Notebook' && guess.src === shared);
ok('the advice says how to get the video', /⋮ → Download/.test(NOTEBOOK_ADVICE) && /\.mp4/.test(NOTEBOOK_ADVICE));

const deck = `---\nmarp: true\n---\n\n<!-- _video: ${shared} -->\n![bg](/media/x/poster.jpg)\n\n# Overview\n`;
const problems = checkDeck(deck);
const flagged = problems.find((p) => p.message.startsWith(NOTEBOOK_ADVICE));
ok(`a video slide given one is flagged by the deck checks (${problems.map((p) => p.message).join(' | ')})`, flagged?.severity === 'warning');

if (fails.length) { console.log(`\n${fails.length} failed`); process.exit(1); }
console.log('\nALL PASS');
