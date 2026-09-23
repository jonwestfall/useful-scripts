// Bringing a whole folder in at once: inspect a ZIP and say what is in it
// (Issue #106).
//
// This module only LOOKS. It reads the archive's central directory - names and
// declared sizes - and never extracts a byte, so inspecting a hostile archive
// costs nothing but the directory. What it returns is a proposal for the
// review screen: every file is either part of an item, waiting on a decision,
// skipped with a reason, or quietly ignored as junk.
//
// What counts as importable is not decided here. Each destination already has
// its own rules - the admin content tree in content.js, the course library in
// library.js - and they are read from there, so a ZIP can never let in a file
// the matching single-file upload would have refused.

'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const yauzl = require('yauzl');

const content = require('./content.js');
const library = require('./library.js');

const MB = 1024 * 1024;

// The upload limit is an admin setting (max_zip_upload_mb). The rest guard
// against an archive that is small on the wire and enormous, or absurdly
// deep, once unpacked. The unpacked allowance grows with the upload limit so
// raising it for a ZIP of videos - which barely compress - still works.
const DEFAULT_UPLOAD_MB = 200;
const MAX_UPLOAD_MB = 4096;
const MAX_FILES = 2000;
const MAX_DEPTH = 8;
const MIN_UNPACKED_BYTES = 1024 * MB;

function limitsFor(uploadMb = DEFAULT_UPLOAD_MB) {
  const maxUploadBytes = uploadMb * MB;
  return {
    maxUploadBytes,
    maxUnpackedBytes: Math.max(MIN_UNPACKED_BYTES, 5 * maxUploadBytes),
    maxFiles: MAX_FILES,
    maxDepth: MAX_DEPTH,
  };
}

// A stored setting outside 1..MAX_UPLOAD_MB is treated as unset, not trusted.
function uploadMbSetting(db, store) {
  const raw = db ? Number(store.getSystemSetting(db, 'max_zip_upload_mb', String(DEFAULT_UPLOAD_MB))) : DEFAULT_UPLOAD_MB;
  return Number.isInteger(raw) && raw >= 1 && raw <= MAX_UPLOAD_MB ? raw : DEFAULT_UPLOAD_MB;
}

class ZipLimitError extends Error {
  constructor(message) {
    super(message);
    this.status = 413;
  }
}

// --- what each file is ---------------------------------------------------------

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const HTML_EXTS = new Set(['.html', '.htm']);
const POWERPOINT_EXTS = new Set(['.ppt', '.pptx', '.pps', '.ppsx', '.key', '.odp']);

// Files that are never content, anywhere: OS droppings and Office lock files.
const isJunk = (p) => {
  const parts = p.split('/');
  const base = parts[parts.length - 1];
  return parts.some((s) => s === '__MACOSX' || (s.startsWith('.') && s.length > 1))
    || /^(thumbs\.db|desktop\.ini)$/i.test(base)
    || base.startsWith('~$');
};

// Which bucket a file goes in on a given destination: the admin content tree's
// category, or the planner library's kind. Null when that destination does
// not take this type at all.
function destinationFor(surface, ext) {
  if (surface === 'admin') {
    for (const [category, spec] of Object.entries(content.CATEGORIES)) {
      if (spec.extensions.includes(ext)) return { category, maxBytes: spec.maxBytes };
    }
    return null;
  }
  const kind = library.UPLOADABLE.get(ext);
  return kind ? { category: kind.kind, maxBytes: library.MAX_UPLOAD_BYTES } : null;
}

const KIND_BY_CATEGORY = {
  decks: 'deck', audio: 'audio', slides: 'slides', video: 'video', photos: 'photo', pdfs: 'pdf',
  deck: 'deck', pdf: 'pdf', image: 'photo',
};

const titleFrom = (name) => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || name;
const fmtMb = (bytes) => `${Math.round(bytes / MB)} MB`;

// "Slide12.PNG", "Deck.004.jpg", "image-3.webp" -> prefix + number. PowerPoint's
// own export is SlideN; Keynote writes Name.NNN; anything else numbered the
// same way groups the same way.
function sequenceKey(base) {
  const m = base.match(/^(.*?)[\s._-]*(\d+)\.[a-z0-9]+$/i);
  return m ? { prefix: m[1].toLowerCase(), n: Number(m[2]) } : null;
}

/**
 * Sort an archive's files into items for one destination.
 *
 * @param {{path: string, size: number, encrypted?: boolean}[]} files
 * @param {{surface: 'admin'|'planner', archiveName?: string}} options
 */
function classifyEntries(files, { surface, archiveName = 'Import' } = {}) {
  if (surface !== 'admin' && surface !== 'planner') throw new Error('surface must be admin or planner');
  const items = [];
  const needsInput = [];
  const skipped = [];
  let ignored = 0;
  let nextId = 1;
  const id = () => `z${nextId++}`;

  const real = [];
  for (const f of files) {
    if (f.path.endsWith('/')) continue;
    if (isJunk(f.path)) ignored++;
    else real.push(f);
  }

  // An exported web deck: a folder with an index.html is one item with every
  // file under it - stylesheets, scripts and fonts included, which on their own
  // would be nothing (admin only: the planner never takes HTML).
  const claimed = new Set();
  if (surface === 'admin') {
    const deckDirs = real
      .filter((f) => path.posix.basename(f.path).toLowerCase() === 'index.html')
      .map((f) => path.posix.dirname(f.path))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    for (const dir of deckDirs) {
      const members = real.filter((f) => !claimed.has(f.path) && (dir === '.' || f.path.startsWith(`${dir}/`)));
      if (!members.length) continue;
      for (const m of members) claimed.add(m.path);
      items.push({
        id: id(), kind: 'webdeck', title: dir === '.' ? titleFrom(archiveName) : path.posix.basename(dir),
        files: members.map((m) => m.path).sort(), size: members.reduce((s, m) => s + m.size, 0),
      });
    }
  }

  const candidates = [];
  for (const f of real) {
    if (claimed.has(f.path)) continue;
    const ext = path.posix.extname(f.path).toLowerCase();
    if (f.encrypted) { skipped.push({ path: f.path, reason: 'It is password-protected, so it cannot be read.' }); continue; }
    if (ext === '.zip') { skipped.push({ path: f.path, reason: 'ZIPs inside a ZIP are not opened - upload that one on its own.' }); continue; }
    if (POWERPOINT_EXTS.has(ext)) {
      needsInput.push({ id: id(), paths: [f.path], reason: 'Presentation files are not converted yet. Export the slides as images or a PDF and upload those instead.' });
      continue;
    }
    if (HTML_EXTS.has(ext) && surface === 'planner') {
      needsInput.push({ id: id(), paths: [f.path], reason: 'HTML slide exports cannot be added from the planner, because a web page served by Podium could act as whoever opens it. Ask an administrator to add it, or export the slides as images or a PDF.' });
      continue;
    }
    const dest = destinationFor(surface, ext);
    if (!dest) {
      // An image type this destination refuses (SVG, for the planner) is worth
      // saying out loud; an unknown extension is not.
      if (IMAGE_EXTS.has(ext)) skipped.push({ path: f.path, reason: `${ext} images cannot be added here.` });
      else ignored++;
      continue;
    }
    if (f.size > dest.maxBytes) {
      skipped.push({ path: f.path, reason: `It is ${fmtMb(f.size)}; the most one file of this kind can be is ${fmtMb(dest.maxBytes)}.` });
      continue;
    }
    candidates.push({ ...f, ext, dest });
  }

  // Picture decks: two or more images in one folder sharing a name prefix and
  // a number, in numeric order (Slide2 before Slide10).
  const groups = new Map();
  for (const c of candidates) {
    if (c.claimed || !IMAGE_EXTS.has(c.ext)) continue;
    const key = sequenceKey(path.posix.basename(c.path));
    if (!key) continue;
    const gk = `${path.posix.dirname(c.path)}\0${key.prefix}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push({ c, n: key.n });
  }
  const prefixesPerDir = new Map();
  for (const gk of groups.keys()) {
    if (groups.get(gk).length < 2) continue;
    const dir = gk.split('\0')[0];
    prefixesPerDir.set(dir, (prefixesPerDir.get(dir) || 0) + 1);
  }
  for (const [gk, members] of groups) {
    if (members.length < 2) continue;
    const [dir, prefix] = gk.split('\0');
    for (const m of members) m.c.claimed = true;
    members.sort((a, b) => a.n - b.n || a.c.path.localeCompare(b.c.path));
    const numbers = members.map((m) => m.n);
    const folderTitle = dir === '.' ? titleFrom(archiveName) : path.posix.basename(dir);
    const title = prefixesPerDir.get(dir) > 1 ? `${folderTitle} - ${prefix || 'images'}` : folderTitle;
    const files = members.map((m) => m.c.path);
    if (new Set(numbers).size !== numbers.length) {
      // Slide3.png and Slide3.jpg: which one is slide 3 is not a guess to make.
      needsInput.push({ id: id(), paths: files, suggestedKind: 'imagedeck', title, reason: 'Some slide numbers appear more than once, so the order is not clear. Pick the files that belong, or import them as separate photos.' });
      continue;
    }
    items.push({ id: id(), kind: 'imagedeck', title, files, size: members.reduce((s, m) => s + m.c.size, 0) });
  }

  for (const c of candidates) {
    if (c.claimed) continue;
    items.push({
      id: id(), kind: KIND_BY_CATEGORY[c.dest.category] || c.dest.category,
      title: titleFrom(path.posix.basename(c.path)), files: [c.path], size: c.size,
    });
  }

  return { surface, items, needsInput, skipped, ignored };
}

// --- reading the archive ---------------------------------------------------------

const openZip = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
});

/**
 * Read a ZIP's directory and enforce the limits, without extracting anything.
 * Resolves to the entries; rejects with a ZipLimitError (status 413) when the
 * archive is too big, too many files or too deep, and with a plain Error when
 * it is not a readable ZIP.
 */
async function readEntries(file, limits = limitsFor()) {
  const { size } = await fsp.stat(file);
  if (size > limits.maxUploadBytes) {
    throw new ZipLimitError(`This ZIP is ${fmtMb(size)}; the most this server takes is ${fmtMb(limits.maxUploadBytes)}.`);
  }
  let zip;
  try {
    zip = await openZip(file);
  } catch (err) {
    throw Object.assign(new Error(`That is not a ZIP this server can read (${err.message}).`), { status: 400 });
  }
  // Directory entries are cheap but still work to walk; bound them too.
  if (zip.entryCount > limits.maxFiles * 2) {
    zip.close();
    throw new ZipLimitError(`This ZIP holds ${zip.entryCount} entries; the most one import takes is ${limits.maxFiles} files.`);
  }
  return new Promise((resolve, reject) => {
    const entries = [];
    let files = 0;
    let unpacked = 0;
    const fail = (err) => { zip.close(); reject(err); };
    zip.on('error', (err) => {
      // yauzl refuses absolute paths and ".." segments on its own.
      reject(Object.assign(new Error(`This ZIP could not be read safely (${err.message}).`), { status: 400 }));
    });
    zip.on('entry', (entry) => {
      const name = entry.fileName;
      if (!name.endsWith('/')) {
        files++;
        unpacked += entry.uncompressedSize;
        const depth = name.split('/').length - 1;
        if (files > limits.maxFiles) return fail(new ZipLimitError(`This ZIP holds more than ${limits.maxFiles} files, the most one import takes.`));
        if (depth > limits.maxDepth) return fail(new ZipLimitError(`This ZIP nests folders more than ${limits.maxDepth} deep ("${name}").`));
        if (unpacked > limits.maxUnpackedBytes) return fail(new ZipLimitError(`This ZIP unpacks to more than ${fmtMb(limits.maxUnpackedBytes)}, the most one import takes.`));
        // Bit 0 of the general purpose flag: the entry is encrypted.
        entries.push({ path: name, size: entry.uncompressedSize, encrypted: (entry.generalPurposeBitFlag & 1) === 1 });
      }
      return zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.readEntry();
  });
}

async function inspectZip(file, { surface, archiveName, limits } = {}) {
  const entries = await readEntries(file, limits);
  return classifyEntries(entries, { surface, archiveName: archiveName || path.basename(file) });
}

module.exports = {
  DEFAULT_UPLOAD_MB, MAX_UPLOAD_MB, MAX_FILES, MAX_DEPTH,
  ZipLimitError, limitsFor, uploadMbSetting, classifyEntries, readEntries, inspectZip,
};
