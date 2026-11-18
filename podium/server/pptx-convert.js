// PowerPoint uploads, converted to a PDF Podium already knows how to show
// (Issue #107).
//
// The issue itself weighs four approaches and recommends this one: shell out
// to LibreOffice for a PDF rather than HTML, and let the existing pdf.js-based
// `pdf` item type (#82) do the rest. That is the whole design - nothing else
// in Podium has to learn about slide masters, layouts or embedded fonts, and
// nothing HTML-shaped is ever produced or served, so the admin/planner trust
// split #106 drew around HTML never comes up here: a converted deck is an
// ordinary PDF, filed exactly where an uploaded PDF already would be.
//
// LibreOffice is a real, system-level dependency this brings in - not an
// `npm install` - so it is optional and fails loudly rather than silently:
// missing, a corrupt file, or a conversion that runs too long each say so in
// plain language, naming what to install rather than producing a mysterious
// half-imported deck.

'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Exactly what Issue #107 asked for - PowerPoint's own current and legacy
// formats - not the wider range of presentation formats LibreOffice's Impress
// filter can actually open (Keynote's .key, OpenDocument's .odp, the old
// "PowerPoint Show" .pps/.ppsx). Those still say so plainly on the review
// screen (see zip-import.js) instead of this quietly growing past its title.
const CONVERTIBLE_EXTS = new Set(['.ppt', '.pptx']);

// Word and RTF (Issue #258) go through LibreOffice too, but only when the
// person uploading chose a PDF over a markdown document - never on their own,
// unlike PowerPoint, which has nothing else to become.
const WORD_EXTS = new Set(['.doc', '.docx', '.rtf']);

const WHAT = (ext) => (WORD_EXTS.has(ext) ? { noun: 'document', plural: 'Word or RTF files', alt: 'save it as a PDF from Word and upload that instead' }
  : { noun: 'presentation', plural: 'PowerPoint files', alt: 'export the slides as images or a PDF and upload those instead' });

// A very large, image-heavy deck is the case this has to be generous for;
// anything actually stuck this long is not going to finish on its own.
const TIMEOUT_MS = 120000;

// What an Office file starts with. LibreOffice will open almost anything -
// handed a text file named .pptx, it imports the text and makes a PDF of it -
// so a file that is none of these is refused here, before it is ever started.
// Any of them under any of the names: LibreOffice tells formats apart by
// content, and a .docx saved as .doc, or an RTF named .doc, is common.
const SIGNATURES = [
  Buffer.from('504b0304', 'hex'), // a ZIP: .pptx and .docx (Office Open XML)
  Buffer.from('d0cf11e0a1b11ae1', 'hex'), // OLE2: the legacy .ppt and .doc
  Buffer.from('{\\rtf', 'latin1'), // RTF
];

/**
 * Whether these bytes could be the Office file the extension says. Word also
 * saves "XML Document" and "Web Page" files a .doc may turn out to be.
 */
function looksLikeOffice(buffer, ext) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (SIGNATURES.some((sig) => buffer.subarray(0, sig.length).equals(sig))) return true;
  if (!WORD_EXTS.has(ext)) return false;
  return /^(\ufeff)?\s*</.test(buffer.subarray(0, 64).toString('utf8'));
}

class ConversionError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

// --- How many run at once (Issue #337) -------------------------------------
//
// LibreOffice takes hundreds of MB and a CPU core per conversion, and any
// signed-in account can start one with an upload. Unlimited, one account (or
// a script holding one session cookie) could start dozens at once and stall
// the whole server mid-lecture - relay, polls and attendance included. So at
// most CONVERT_CONCURRENCY run at a time (2), up to CONVERT_QUEUE more wait
// their turn (6), and one account has at most CONVERT_PER_ACCOUNT under way,
// running or waiting (2). Past any of those, or after waiting a minute
// without starting (an upload request does not stay open much longer than
// that behind the proxy), the answer says to try again shortly.

const envCount = (name, fallback, min) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min ? n : fallback;
};
const limits = () => ({
  concurrency: envCount('CONVERT_CONCURRENCY', 2, 1),
  queue: envCount('CONVERT_QUEUE', 6, 0),
  perAccount: envCount('CONVERT_PER_ACCOUNT', 2, 1),
  waitMs: envCount('CONVERT_WAIT_MS', 60000, 0),
});

let running = 0;
const waiting = [];        // { start, timer }, oldest first
const underWay = new Map(); // owner -> conversions running or waiting

const BUSY = 'The server is busy converting other files right now. Try again in a minute.';

/**
 * Wait for a turn; resolves with the function that gives it back. `patient`
 * is for work no request is standing open for (a ZIP import's files, one at a
 * time): it waits however long it takes, past a full queue, rather than
 * failing an item of an import because someone else was converting.
 */
async function takeTurn(owner, patient = false) {
  const { concurrency, queue, perAccount } = limits();
  const waitMs = patient ? null : limits().waitMs;
  const key = owner === undefined || owner === null || owner === '' ? null : String(owner);
  if (key !== null && (underWay.get(key) || 0) >= perAccount) {
    throw new ConversionError(
      `You already have ${perAccount === 1 ? 'a file' : `${perAccount} files`} converting. Wait for ${perAccount === 1 ? 'it' : 'them'} to finish, then try this one.`, 429,
    );
  }
  if (!patient && running >= concurrency && waiting.length >= queue) throw new ConversionError(BUSY, 503);
  if (key !== null) underWay.set(key, (underWay.get(key) || 0) + 1);
  const forget = () => {
    if (key === null) return;
    const left = (underWay.get(key) || 1) - 1;
    if (left > 0) underWay.set(key, left); else underWay.delete(key);
  };
  let done = false;
  const giveBack = () => {
    if (done) return;
    done = true;
    forget();
    const next = waiting.shift();
    if (next) { clearTimeout(next.timer); next.start(); } else running -= 1;
  };
  if (running < concurrency) {
    running += 1;
    return giveBack;
  }
  await new Promise((resolve, reject) => {
    const entry = {
      // A turn handed on keeps `running` as it was: one finished, one starts.
      start: resolve,
      timer: waitMs === null ? null : setTimeout(() => {
        const at = waiting.indexOf(entry);
        if (at >= 0) waiting.splice(at, 1);
        forget();
        reject(new ConversionError(BUSY, 503));
      }, waitMs),
    };
    waiting.push(entry);
  });
  return giveBack;
}

/** How many conversions are running and waiting right now (for tests and the doctor). */
function convertLoad() {
  return { running, waiting: waiting.length };
}

// A private profile for each conversion (see convert) is also where its
// settings live, so each one starts with active content off: no macros, no
// embedded OLE objects or DDE links, and no links fetched from outside the
// document - an uploaded file is someone else's, and converting it should
// never run it or make the server reach out on its behalf.
const LOCKED_PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
`;

/**
 * Turn a PowerPoint file's bytes into a PDF's bytes. Runs synchronously as
 * part of the request that uploaded it - the lightest processing model here,
 * since a queued/polled job would need its own staging area, status route and
 * UI, and a single deck converts in a couple of seconds (see docs/vps.md).
 *
 * Everything happens inside its own temp directory, including a private
 * LibreOffice profile (`-env:UserInstallation`): two conversions sharing one
 * profile is a documented way to deadlock them both on the same lock file,
 * and `--headless` alone does not prevent that.
 */
async function convertToPdf(buffer, ext, { owner, patient = false } = {}) {
  return convert(buffer, ext, 'pdf', owner, patient);
}

/**
 * A legacy Word .doc as a .docx (Issue #258), which the browser can then turn
 * into a markdown document itself: one converter for both, not a second one
 * on the server.
 */
async function convertToDocx(buffer, { owner, patient = false } = {}) {
  return convert(buffer, '.doc', 'docx', owner, patient);
}

/**
 * `owner` is who asked (an account id, or an address with no accounts), for
 * the per-account limit; `patient` waits for a turn however long it takes.
 * See takeTurn.
 */
async function convert(buffer, ext, to, owner, patient) {
  const what = WHAT(ext);
  if (!looksLikeOffice(buffer, ext)) {
    throw new ConversionError(
      `That file could not be converted: it is not really a ${what.noun === 'document' ? 'Word or RTF document' : 'PowerPoint presentation'} inside, whatever its name says.`,
    );
  }
  const giveBack = await takeTurn(owner, patient);
  let dir = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'podium-convert-'));
    const inputPath = path.join(dir, `input${ext}`);
    await fs.writeFile(inputPath, buffer, { mode: 0o600 });
    await fs.mkdir(path.join(dir, 'profile', 'user'), { recursive: true });
    await fs.writeFile(path.join(dir, 'profile', 'user', 'registrymodifications.xcu'), LOCKED_PROFILE, { mode: 0o600 });
    await new Promise((resolve, reject) => {
      execFile('soffice', [
        '--headless', '--norestore', `-env:UserInstallation=file://${path.join(dir, 'profile')}`,
        '--convert-to', to, '--outdir', dir, inputPath,
      ], { timeout: TIMEOUT_MS, killSignal: 'SIGKILL' }, (err) => {
        if (err?.killed) {
          reject(new ConversionError(
            `Converting that ${what.noun} took too long and was stopped. A smaller or simpler file is more likely to work.`, 504,
          ));
        } else if (err?.code === 'ENOENT') {
          reject(new ConversionError(
            `This server cannot convert ${what.plural}: LibreOffice (the "soffice" command) is not installed. `
            + `Ask an administrator to install it (see docs/vps.md), or ${what.alt}.`,
          ));
        } else {
          // Anything else - LibreOffice does not use its exit code to report
          // a conversion failure, only whether it could even start - so
          // resolving here and checking for the output file below is the
          // real answer to "did this work", not err.
          resolve();
        }
      });
    });
    try {
      return await fs.readFile(path.join(dir, `input.${to}`));
    } catch {
      throw new ConversionError(
        `That file could not be converted - it may not really be a ${what.noun === 'document' ? 'Word or RTF document' : 'PowerPoint presentation'}, or it uses something LibreOffice cannot open.`,
      );
    }
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    giveBack();
  }
}

/**
 * Whether LibreOffice is here at all - asked once, so a page can offer "PDF"
 * and ".doc" only where they will work rather than failing after an upload.
 */
let found = null;
function hasLibreOffice() {
  if (found !== null) return found;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  found = dirs.some((dir) => {
    try { require('node:fs').accessSync(path.join(dir, 'soffice'), require('node:fs').constants.X_OK); return true; } catch { return false; }
  });
  return found;
}

module.exports = { CONVERTIBLE_EXTS, WORD_EXTS, ConversionError, TIMEOUT_MS, convertToPdf, convertToDocx, convertLoad, hasLibreOffice, looksLikeOffice };
