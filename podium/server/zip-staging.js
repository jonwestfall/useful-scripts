// A ZIP import from upload to commit (Issue #106).
//
// zip-import.js decides what is in an archive; this is everything around that
// decision. The upload is kept, unextracted, in a staging folder under
// DATA_DIR while somebody looks at the review screen, and nothing reaches its
// real destination until they press Import. Then only the entries they kept
// are read out of it - straight into the content tree (admin) or the
// content-addressed media store (planner) - and the staged copy is deleted.
//
// A staged upload also goes away when it is cancelled, when the same person
// starts a fourth one, and when it is older than STAGING_TTL_MS, so a review
// screen left open in a forgotten tab cannot leak disk space.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const yauzl = require('yauzl');

const { Readable } = require('node:stream');

const content = require('./content.js');
const library = require('./library.js');
const pptxConvert = require('./pptx-convert.js');
const zipImport = require('./zip-import.js');

const STAGING_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_JOBS_PER_USER = 3;
const ID_RE = /^[0-9a-f]{32}$/;

const stagingDir = (dataDir) => path.join(dataDir, 'zip-staging');
const httpError = (status, message) => Object.assign(new Error(message), { status });

// Whose commit is running right now, so a double-clicked Import cannot read
// the same archive into the library twice.
const committing = new Set();

// Only these are ever shown back as thumbnails: raster images, never SVG,
// which is a document a browser will run script in.
const PREVIEW_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

// What a review-screen kind is called in the library (planner) and in
// content/manifest.json (admin).
const LIBRARY_KIND = { deck: 'deck', pdf: 'pdf', photo: 'image', video: 'video', audio: 'audio', imagedeck: 'imagedeck' };
const MANIFEST_TYPE = { ...LIBRARY_KIND, slides: 'slides', webdeck: 'slides' };

const baseTitle = (file) => path.posix.basename(file).replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || path.posix.basename(file);
const cleanTitle = (value, fallback) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return text || fallback;
};

// --- receiving the upload ------------------------------------------------------

function receiveToFile(stream, file, limit) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { mode: 0o600 });
    let bytes = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(err);
    };
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        fail(new zipImport.ZipLimitError(`This ZIP is larger than ${Math.round(limit / 1024 / 1024)} MB, the most this server takes.`));
        stream.destroy();
      }
    });
    stream.on('error', fail);
    out.on('error', fail);
    out.on('close', () => {
      if (settled) return;
      settled = true;
      if (!bytes) reject(httpError(400, 'That file is empty.'));
      else resolve(bytes);
    });
    stream.pipe(out);
  });
}

// --- reading entries out of a staged archive -----------------------------------

const openZip = (file) => new Promise((resolve, reject) => {
  // validateEntrySizes (the default) makes a stream fail if an entry turns out
  // bigger than its header claimed - the header is what the limits checked.
  yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)));
});

/**
 * Read each wanted entry in archive order, one at a time. handler(name, stream)
 * must consume the stream; its promise decides when the next entry is read.
 */
async function eachEntry(file, wanted, handler) {
  const zip = await openZip(file);
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        if (!wanted.has(entry.fileName)) { zip.readEntry(); return; }
        zip.openReadStream(entry, (err, stream) => {
          if (err) { reject(err); return; }
          Promise.resolve(handler(entry.fileName, stream)).then(() => zip.readEntry(), reject);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

function hashStream(stream) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function bufferStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// --- where admin imports land ----------------------------------------------------

const safeSegment = (name) => name.replace(/[^\w .()-]+/g, '-').replace(/^[.\s-]+/, '').trim().slice(0, 120);

function categoryFor(file) {
  const ext = path.posix.extname(file).toLowerCase();
  const found = Object.entries(content.CATEGORIES).find(([, spec]) => spec.extensions.includes(ext));
  return found ? found[0] : null;
}

/**
 * Pick names in the content tree that nothing is using yet - on disk, or
 * earlier in the same import. A clash gets "-2", "-3"... before the extension.
 */
function nameReserver(contentDir) {
  const taken = new Set();
  return (dir, name) => {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length) || 'file';
    for (let n = 1; ; n++) {
      const candidate = n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`;
      const key = `${dir}/${candidate}`.toLowerCase();
      if (taken.has(key) || fs.existsSync(path.join(contentDir, dir, candidate))) continue;
      taken.add(key);
      return candidate;
    }
  };
}

/**
 * Where each file of one import item goes, relative to the content folder:
 * [{ from: 'path/in/zip', to: 'photos/cat.jpg' }], plus the manifest entry
 * that makes it show in the Library.
 */
function adminPlacement(item, reserve) {
  if (item.kind === 'imagedeck' || item.kind === 'webdeck') {
    const folder = reserve('slides', safeSegment(item.title) || 'deck');
    const root = item.kind === 'webdeck' ? item.root : null;
    const used = new Set();
    const files = item.files.map((from) => {
      let rel;
      if (root !== null && root !== undefined) {
        // Names kept exactly: index.html links to them by relative path.
        // yauzl has already refused absolute paths and ".." segments; the
        // write itself checks the result stays inside the content folder.
        rel = (root === '.' ? from : from.slice(root.length + 1))
          .split('/').filter((seg) => seg && seg !== '.' && seg !== '..' && !seg.includes('\\')).join('/');
      } else {
        // A picture deck's slides all came from one folder, so their names
        // are already unique; safeSegment could still fold two together.
        const ext = path.posix.extname(from);
        let base = safeSegment(path.posix.basename(from)) || `slide${ext}`;
        for (let n = 2; used.has(base.toLowerCase()); n++) base = `${safeSegment(path.posix.basename(from, ext))}-${n}${ext}`;
        used.add(base.toLowerCase());
        rel = base;
      }
      return { from, to: `slides/${folder}/${rel}` };
    });
    const entry = item.kind === 'imagedeck'
      ? { type: 'imagedeck', title: item.title, images: files.map((f) => `content/${f.to}`), fit: 'contain' }
      : { type: 'slides', title: item.title, src: `content/slides/${folder}/index.html` };
    return { files, target: `content/slides/${folder}/`, entry };
  }
  const from = item.files[0];
  const ext = path.posix.extname(from).toLowerCase();
  // A PowerPoint file becomes a PDF (Issue #107): the reserved name already
  // says so, so the review screen shows the real target rather than a
  // filename that is about to stop matching its own bytes.
  const converts = pptxConvert.CONVERTIBLE_EXTS.has(ext);
  const category = converts ? 'pdfs' : categoryFor(from);
  const dir = content.CATEGORIES[category].dir;
  const baseName = converts ? `${path.posix.basename(from, ext)}.pdf` : path.posix.basename(from);
  const name = reserve(dir, safeSegment(baseName) || `file${converts ? '.pdf' : ext}`);
  const to = `${dir}/${name}`;
  return {
    files: [{ from, to }],
    target: `content/${to}`,
    // Only a real clash gets flagged, never the expected .pptx -> .pdf swap.
    renamed: name !== baseName,
    entry: { type: MANIFEST_TYPE[item.kind] || item.kind, title: item.title, src: `content/${to}` },
  };
}

// --- the job file -------------------------------------------------------------------

const jobPath = (dataDir, id) => {
  if (!ID_RE.test(String(id))) throw httpError(404, 'No such import.');
  return path.join(stagingDir(dataDir), id);
};

async function readJob(dataDir, id) {
  try {
    return JSON.parse(await fsp.readFile(path.join(jobPath(dataDir, id), 'job.json'), 'utf8'));
  } catch (err) {
    if (err.status) throw err;
    return null;
  }
}

const removeJob = (dataDir, id) => fsp.rm(jobPath(dataDir, id), { recursive: true, force: true });

async function loadJob(dataDir, user, id, now = Date.now()) {
  const job = await readJob(dataDir, id);
  // Somebody else's staged upload is answered exactly like a missing one.
  if (!job || job.userId !== user.id) throw httpError(404, 'No such import - it may have been imported or cancelled already.');
  if (now - job.createdAt > STAGING_TTL_MS) {
    await removeJob(dataDir, id);
    throw httpError(410, 'This import waited too long and was cleared away. Upload the ZIP again.');
  }
  return job;
}

/** What the review screen is sent: the proposal, never where the job lives. */
function publicJob(job) {
  const { manifest } = job;
  return {
    id: job.id,
    surface: job.surface,
    archiveName: job.archiveName,
    expiresAt: job.createdAt + STAGING_TTL_MS,
    items: manifest.items.map(({ root, ...item }) => item),
    needsInput: manifest.needsInput,
    skipped: manifest.skipped,
    ignored: manifest.ignored,
  };
}

/**
 * Remove staged uploads past their time, and - for one person - all but their
 * newest few. Called on every new upload and from the server's own timer.
 */
async function sweep(dataDir, { now = Date.now(), userId = null, keep = MAX_JOBS_PER_USER } = {}) {
  let names;
  try { names = await fsp.readdir(stagingDir(dataDir)); } catch { return 0; }
  let removed = 0;
  const mine = [];
  for (const name of names) {
    const dir = path.join(stagingDir(dataDir), name);
    if (!ID_RE.test(name)) {
      // Nothing else belongs here; a stray entry is left for a person to look at.
      continue;
    }
    let job = null;
    try { job = JSON.parse(await fsp.readFile(path.join(dir, 'job.json'), 'utf8')); } catch { /* half-made */ }
    let createdAt = job?.createdAt;
    if (!createdAt) {
      // An upload still arriving has no job.json yet; the folder's age is
      // the best there is, and a crash mid-upload is exactly what this is for.
      try { createdAt = (await fsp.stat(dir)).mtimeMs; } catch { continue; }
    }
    if (now - createdAt > STAGING_TTL_MS) {
      await fsp.rm(dir, { recursive: true, force: true });
      removed++;
    } else if (job && userId !== null && job.userId === userId) {
      mine.push({ dir, createdAt });
    }
  }
  mine.sort((a, b) => b.createdAt - a.createdAt);
  for (const old of mine.slice(Math.max(0, keep))) {
    await fsp.rm(old.dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

// --- stage ----------------------------------------------------------------------------

/**
 * Take an upload, inspect it, and keep it for review. Resolves to what the
 * review screen shows.
 */
async function stage({ db, dataDir, user, surface, archiveName, stream, uploadMb, contentDir }) {
  if (surface !== 'admin' && surface !== 'planner') throw httpError(400, 'surface must be admin or planner');
  const limits = zipImport.limitsFor(uploadMb);
  // Room for this one: at most MAX_JOBS_PER_USER - 1 older ones survive.
  await sweep(dataDir, { userId: user.id, keep: MAX_JOBS_PER_USER - 1 });

  const id = crypto.randomBytes(16).toString('hex');
  const dir = jobPath(dataDir, id);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const archive = path.join(dir, 'archive.zip');
  try {
    await receiveToFile(stream, archive, limits.maxUploadBytes);
    const name = cleanTitle(String(archiveName || '').split(/[\\/]/).pop(), 'Import.zip');
    const manifest = await zipImport.inspectZip(archive, { surface, archiveName: name.replace(/\.zip$/i, ''), limits });

    for (const item of manifest.items) {
      item.options = item.kind === 'imagedeck' ? ['imagedeck', 'photo'] : [item.kind];
    }
    for (const entry of manifest.needsInput) {
      entry.options = entry.suggestedKind === 'imagedeck' ? ['imagedeck', 'photo'] : [];
    }

    if (surface === 'planner') {
      // Hash what could be imported, so the review screen can say which of it
      // is already in the library before anyone presses Import. A PowerPoint
      // file is excluded: it is not the bytes that will actually be stored
      // (see commitPlanner) - hashing it here would only ever compare a
      // pptx's hash against a library of PDFs, never matching, and
      // converting a second time just to throw the hash away is not worth
      // it for what "already in library" is - a courtesy, not a guarantee
      // (storeUpload's own content addressing still collapses the bytes
      // either way, so nothing is duplicated on disk, only in the list).
      const hashable = manifest.items.filter((item) => !item.files.some(
        (f) => pptxConvert.CONVERTIBLE_EXTS.has(path.posix.extname(f).toLowerCase()),
      ));
      const wanted = new Set(hashable.flatMap((i) => i.files));
      const hashes = {};
      await eachEntry(archive, wanted, async (entryName, entryStream) => { hashes[entryName] = await hashStream(entryStream); });
      for (const item of hashable) {
        const found = library.findDuplicate(db, user, { kind: LIBRARY_KIND[item.kind], sha256s: item.files.map((f) => hashes[f]) });
        if (found) item.duplicate = { id: found.id, title: found.title };
      }
    } else {
      // Where each item will land, so a renamed file is visible up front.
      const reserve = nameReserver(contentDir);
      for (const item of manifest.items) {
        const placed = adminPlacement(item, reserve);
        item.target = placed.target;
        if (placed.renamed) item.renamed = true;
      }
    }

    const job = { id, userId: user.id, surface, archiveName: name, createdAt: Date.now(), manifest };
    await fsp.writeFile(path.join(dir, 'job.json'), JSON.stringify(job), { mode: 0o600 });
    return publicJob(job);
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function getJob(dataDir, user, id, now = Date.now()) {
  return publicJob(await loadJob(dataDir, user, id, now));
}

async function cancel(dataDir, user, id) {
  await loadJob(dataDir, user, id);
  await removeJob(dataDir, id);
  return { cancelled: id };
}

/** One image from a staged archive, for the review screen's thumbnails. */
async function preview(dataDir, user, id, entryName) {
  const job = await loadJob(dataDir, user, id);
  const listed = new Set([...job.manifest.items, ...job.manifest.needsInput].flatMap((i) => i.files || i.paths));
  const type = PREVIEW_TYPES[path.posix.extname(String(entryName)).toLowerCase()];
  if (!listed.has(entryName) || !type) throw httpError(404, 'No such picture in this import.');
  const chunks = [];
  await eachEntry(path.join(jobPath(dataDir, id), 'archive.zip'), new Set([entryName]), (name, stream) => new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', resolve);
    stream.on('error', reject);
  }));
  return { type, body: Buffer.concat(chunks) };
}

// --- commit -----------------------------------------------------------------------------

/**
 * Turn the review screen's answers into the list of things to import:
 * [{ title, kind, files }]. Kinds and titles come from the person; which
 * files, and what a kind may be changed to, only ever from the job.
 */
function resolveChoices(job, choices = {}) {
  const planned = [];
  const skipped = [];
  const byId = (list) => (list && typeof list === 'object' ? list : {});
  const itemChoices = byId(choices.items);
  const inputChoices = byId(choices.needsInput);

  const add = (source, kind, title) => {
    if (kind === 'photo' && source.files.length > 1) {
      for (const file of source.files) planned.push({ kind: 'photo', title: baseTitle(file), files: [file] });
    } else {
      planned.push({ kind, title, files: source.files, root: source.root });
    }
  };

  for (const item of job.manifest.items) {
    const choice = itemChoices[item.id] || {};
    const title = cleanTitle(choice.title, item.title);
    if (choice.include === false) { skipped.push({ title, reason: 'Left out on the review screen.' }); continue; }
    const kind = item.options.includes(choice.kind) ? choice.kind : item.kind;
    add(item, kind, title);
  }
  let unresolved = 0;
  for (const entry of job.manifest.needsInput) {
    const choice = inputChoices[entry.id] || {};
    const title = cleanTitle(choice.title, entry.title || baseTitle(entry.paths[0]));
    if (!entry.options.includes(choice.kind)) {
      unresolved++;
      skipped.push({ title, reason: choice.kind === 'skip' ? 'Skipped on the review screen.' : entry.reason });
      continue;
    }
    add({ files: entry.paths }, choice.kind, title);
  }
  return { planned, skipped, unresolved };
}

async function commitPlanner({ db, dataDir, user, archive, planned, course, group }) {
  const imported = [];
  const skipped = [];
  const failed = [];
  const stored = new Map();
  const wanted = new Set(planned.flatMap((p) => p.files));
  await eachEntry(archive, wanted, async (entryName, stream) => {
    try {
      const ext = path.posix.extname(entryName).toLowerCase();
      // A PowerPoint file becomes a PDF here (Issue #107), the one place in
      // this loop that needs the whole file before it can store anything -
      // everything else streams straight into storeUpload.
      const converts = pptxConvert.CONVERTIBLE_EXTS.has(ext);
      const contentType = converts ? 'application/pdf' : library.uploadKindFor(entryName).type;
      const uploadStream = converts ? Readable.from(await pptxConvert.convertToPdf(await bufferStream(stream), ext)) : stream;
      const filename = converts ? `${path.posix.basename(entryName, ext)}.pdf` : path.posix.basename(entryName);
      const { sha256, bytes } = await library.storeUpload(dataDir, uploadStream, { limit: library.MAX_UPLOAD_BYTES });
      const mediaId = library.rememberMedia(db, user, { sha256, bytes, contentType });
      stored.set(entryName, { sha256, mediaId, filename });
    } catch (err) {
      stream.resume();
      stored.set(entryName, { error: err.message });
    }
  });

  for (const p of planned) {
    const files = p.files.map((f) => stored.get(f));
    const broken = files.find((f) => !f || f.error);
    if (broken) { failed.push({ title: p.title, reason: broken?.error || 'It could not be read from the ZIP.' }); continue; }
    const kind = LIBRARY_KIND[p.kind];
    const duplicate = library.findDuplicate(db, user, { kind, sha256s: files.map((f) => f.sha256) });
    if (duplicate) { skipped.push({ title: p.title, reason: `Already in the library as “${duplicate.title}”.`, item: duplicate }); continue; }
    try {
      let item;
      if (p.kind === 'imagedeck') {
        const images = p.files.map((f, i) => `/media/${files[i].sha256}/${encodeURIComponent(path.posix.basename(f))}`);
        item = library.addItem(db, user, { courseCode: course, kind, title: p.title, group, props: { images, fit: 'contain' } });
        library.setItemFiles(db, item.id, files.map((f) => f.mediaId));
      } else {
        item = library.addItem(db, user, {
          courseCode: course, kind, title: p.title, group,
          filename: files[0].filename.slice(0, 200), mediaId: files[0].mediaId,
        });
      }
      imported.push({ title: p.title, kind: p.kind, item });
    } catch (err) {
      failed.push({ title: p.title, reason: err.message });
    }
  }
  // Bytes stored for something that was then skipped or failed, and that
  // nothing else points at, are removed again.
  for (const f of stored.values()) if (f.sha256) library.forgetMediaIfUnused(db, dataDir, f.sha256);
  return { imported, skipped, failed };
}

async function commitAdmin({ ctx, archive, planned, addToLibrary, group }) {
  const { contentDir } = content.resolveRoots(ctx);
  const reserve = nameReserver(contentDir);
  const imported = [];
  const failed = [];
  const destinations = new Map();
  const placements = planned.map((p) => {
    const placed = adminPlacement(p, reserve);
    for (const f of placed.files) destinations.set(f.from, f.to);
    return placed;
  });

  const written = new Map();
  await eachEntry(archive, new Set(destinations.keys()), async (entryName, stream) => {
    const to = destinations.get(entryName);
    const full = path.resolve(contentDir, to);
    try {
      if (!full.startsWith(path.resolve(contentDir) + path.sep)) throw new Error('That path is outside the content folder.');
      await fsp.mkdir(path.dirname(full), { recursive: true });
      const ext = path.posix.extname(entryName).toLowerCase();
      if (pptxConvert.CONVERTIBLE_EXTS.has(ext)) {
        // Needs the whole file before it can even start (Issue #107) -
        // unlike everything else here, which streams straight through.
        const pdf = await pptxConvert.convertToPdf(await bufferStream(stream), ext);
        await fsp.writeFile(full, pdf, { flag: 'wx' });
      } else {
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(full, { flags: 'wx' });
          stream.on('error', reject);
          out.on('error', reject);
          out.on('close', resolve);
          stream.pipe(out);
        });
      }
      written.set(entryName, true);
    } catch (err) {
      stream.resume();
      written.set(entryName, err.message);
    }
  });

  const entries = [];
  planned.forEach((p, i) => {
    const placed = placements[i];
    const problem = placed.files.map((f) => written.get(f.from)).find((w) => w !== true);
    if (problem !== undefined) {
      failed.push({ title: p.title, reason: typeof problem === 'string' ? problem : 'It could not be read from the ZIP.' });
      return;
    }
    imported.push({ title: p.title, kind: p.kind, target: placed.target, renamed: !!placed.renamed });
    entries.push({ ...placed.entry, ...(group ? { group } : {}) });
  });

  if (addToLibrary && entries.length) {
    const manifest = content.getManifest(ctx);
    manifest.items.push(...entries);
    content.saveManifest(ctx, manifest);
  }
  return { imported, skipped: [], failed };
}

/**
 * Import what the review screen kept. The staged upload is removed afterwards
 * whatever happened: a half-finished import retried would duplicate the half
 * that did finish.
 */
async function commit(ctx, user, id, choices = {}) {
  const { dataDir, db } = ctx;
  const job = await loadJob(dataDir, user, id);
  if (committing.has(id)) throw httpError(409, 'This import is already running.');
  const course = typeof choices.course === 'string' ? choices.course : '';
  // Checked before anything is read, same as a single upload - and before the
  // staged copy is spent, so picking a course you cannot file under can be
  // corrected and retried.
  if (job.surface === 'planner') library.courseIdFor(db, user, course);
  committing.add(id);
  try {
    const { planned, skipped, unresolved } = resolveChoices(job, choices);
    const group = cleanTitle(choices.group, job.archiveName.replace(/\.zip$/i, '')).slice(0, 80);
    const archive = path.join(jobPath(dataDir, id), 'archive.zip');
    const result = job.surface === 'planner'
      ? await commitPlanner({ db, dataDir, user, archive, planned, course, group })
      : await commitAdmin({ ctx, archive, planned, addToLibrary: choices.addToLibrary !== false, group });
    return {
      surface: job.surface,
      imported: result.imported,
      skipped: [...skipped, ...result.skipped],
      failed: result.failed,
      unresolved,
    };
  } finally {
    await removeJob(dataDir, id);
    committing.delete(id);
  }
}

module.exports = {
  STAGING_TTL_MS, MAX_JOBS_PER_USER,
  stage, getJob, cancel, preview, commit, sweep, stagingDir,
};
