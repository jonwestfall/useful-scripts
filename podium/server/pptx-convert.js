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

// A very large, image-heavy deck is the case this has to be generous for;
// anything actually stuck this long is not going to finish on its own.
const TIMEOUT_MS = 120000;

class ConversionError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

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
async function convertToPdf(buffer, ext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'podium-pptx-'));
  try {
    const inputPath = path.join(dir, `input${ext}`);
    await fs.writeFile(inputPath, buffer, { mode: 0o600 });
    await new Promise((resolve, reject) => {
      execFile('soffice', [
        '--headless', '--norestore', `-env:UserInstallation=file://${path.join(dir, 'profile')}`,
        '--convert-to', 'pdf', '--outdir', dir, inputPath,
      ], { timeout: TIMEOUT_MS, killSignal: 'SIGKILL' }, (err) => {
        if (err?.killed) {
          reject(new ConversionError(
            'Converting that presentation took too long and was stopped. A smaller or simpler file is more likely to work.', 504,
          ));
        } else if (err?.code === 'ENOENT') {
          reject(new ConversionError(
            'This server cannot convert PowerPoint files: LibreOffice (the "soffice" command) is not installed. '
            + 'Ask an administrator to install it (see docs/vps.md), or export the slides as images or a PDF and upload those instead.',
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
      return await fs.readFile(path.join(dir, 'input.pdf'));
    } catch {
      throw new ConversionError(
        'That file could not be converted - it may not really be a PowerPoint presentation, or it uses something LibreOffice cannot open.',
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { CONVERTIBLE_EXTS, ConversionError, TIMEOUT_MS, convertToPdf };
