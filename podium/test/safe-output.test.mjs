// Run with: node podium/test/safe-output.test.mjs
//
// Three things Podium hands on that a stranger may have written:
//   - a link in a deck's raw HTML, which must not be able to run script
//     (safeLinkHref in deck.js; the deck render drops any other href);
//   - a CSV cell, which must not be a spreadsheet formula (server/csv.js
//     and csvCell in util.js, kept to the same rule);
//   - a PDF, opened with what pdf.js needs to decode its pictures (pdfSource).
import { createRequire } from 'node:module';
import { safeLinkHref } from '../assets/js/deck.js';
import { csvCell } from '../assets/js/util.js';
import { pdfSource } from '../assets/js/pdfjs.js';

const require = createRequire(import.meta.url);
const csv = require('../server/csv.js');
const roster = require('../server/roster.js');

let ok = true;
const chk = (label, cond) => {
  if (!cond) { ok = false; console.log('FAIL', label); } else console.log('ok  ', label);
};

// --- deck links ------------------------------------------------------------
for (const href of ['https://example.edu/reading', 'http://x.test', 'mailto:prof@example.edu', 'tel:+15555550100',
  '#slide-3', '/media/abc/notes.pdf', 'notes.pdf', '../x.html', '?q=1', '']) {
  chk(`a deck may link to ${JSON.stringify(href)}`, safeLinkHref(href));
}
for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
  'java\nscript:alert(1)', '\u0001javascript:alert(1)', 'vbscript:msgbox', 'data:text/html,<script>1</script>',
  'file:///etc/passwd', 'blob:https://x/1']) {
  chk(`but never to ${JSON.stringify(href)}`, !safeLinkHref(href));
}

// --- CSV cells: the server's ---------------------------------------------------
chk('a formula is written as text', csv.csvField('=HYPERLINK("https://evil.example","x")') === `"'=HYPERLINK(""https://evil.example"",""x"")"`);
for (const lead of ['=', '+', '-', '@']) chk(`so is anything starting ${lead}`, csv.neutralise(`${lead}cmd`) === `'${lead}cmd`);
chk('a cell starting with a tab is too', csv.neutralise('\t=1+1') === "'\t=1+1");
chk('a negative or signed number stays a number', csv.csvField(-3) === '-3' && csv.csvField('+1.5') === '+1.5' && csv.csvField('-12') === '-12');
chk('ordinary text, dates and empty cells are untouched',
  csv.csvField('Sam Lee') === 'Sam Lee' && csv.csvField('2026-11-17T10:00:00.000Z') === '2026-11-17T10:00:00.000Z' && csv.csvField(null) === '' && csv.csvField('') === '');
chk('quoting still happens where it has to', csv.csvField('Lee, Sam') === '"Lee, Sam"' && csv.csvLine(['a', '=b']) === "a,'=b");

// A roster export is meant to be imported again, as it was.
const exported = `name,student id,email\r\n${csv.csvLine(['=Robert, Tables', 'A100', 'r@example.edu'])}\r\n${csv.csvLine(["O'Brien", '-42', 'o@example.edu'])}\r\n`;
const back = roster.parseCsv(exported);
chk(`a roster export reads back as it was (${JSON.stringify(back.slice(1))})`,
  back[1][0] === '=Robert, Tables' && back[2][0] === "O'Brien" && back[2][1] === '-42');

// --- CSV cells: the pages' --------------------------------------------------------
chk('the pages\' exports guard a formula the same way', csvCell('=1+1') === `"'=1+1"` && csvCell('@SUM(A1)') === `"'@SUM(A1)"`);
chk('and leave numbers and text alone', csvCell(-5) === '"-5"' && csvCell('Yes') === '"Yes"' && csvCell('say "hi"') === '"say ""hi"""');

// --- PDFs ---------------------------------------------------------------------------
const decoders = pdfSource('/media/x/a.pdf').wasmUrl;
chk(`a PDF by address is opened with pdf.js's decoders beside it (${decoders})`,
  pdfSource('/media/x/a.pdf').url === '/media/x/a.pdf' && /\/assets\/vendor\/pdfjs\/wasm\/$/.test(decoders));
const bytes = new Uint8Array([37, 80, 68, 70]);
chk('so is one given as bytes', pdfSource(bytes).data === bytes && pdfSource(bytes).wasmUrl === decoders);
chk('and one already given as options keeps them', pdfSource({ url: 'a.pdf', withCredentials: true }).withCredentials === true
  && pdfSource({ url: 'a.pdf' }).wasmUrl === decoders);

console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
process.exit(ok ? 0 : 1);
