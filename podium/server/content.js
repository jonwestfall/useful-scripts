// Content and Marp theme management for administrators (Issue #54)
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CATEGORIES = {
  decks: {
    dir: 'decks',
    extensions: ['.md', '.markdown'],
    maxBytes: 10 * 1024 * 1024,
    isText: true,
  },
  audio: {
    dir: 'audio',
    extensions: ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.aac'],
    maxBytes: 50 * 1024 * 1024,
    isText: false,
  },
  slides: {
    dir: 'slides',
    extensions: ['.html', '.htm', '.zip'],
    maxBytes: 25 * 1024 * 1024,
    isText: true,
  },
  video: {
    dir: 'video',
    extensions: ['.mp4', '.webm', '.mov', '.mkv'],
    maxBytes: 100 * 1024 * 1024,
    isText: false,
  },
  photos: {
    dir: 'photos',
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
    maxBytes: 20 * 1024 * 1024,
    isText: false,
  },
  pdfs: {
    dir: 'pdfs',
    extensions: ['.pdf'],
    maxBytes: 25 * 1024 * 1024,
    isText: false,
  },
};

function resolveRoots(ctx) {
  const staticRoot = ctx?.staticDir || process.env.STATIC
    ? path.resolve(__dirname, ctx?.staticDir || process.env.STATIC)
    : path.resolve(__dirname, '..');

  const contentDir = process.env.CONTENT_DIR
    ? path.resolve(process.env.CONTENT_DIR)
    : path.join(staticRoot, 'content');

  const themesDir = process.env.THEMES_DIR
    ? path.resolve(process.env.THEMES_DIR)
    : path.join(staticRoot, 'marp-themes');

  return { staticRoot, contentDir, themesDir };
}

function safePath(baseDir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw Object.assign(new Error('filename required'), { status: 400 });
  }
  if (relativePath.includes('..') || relativePath.includes('/') || relativePath.includes('\\')) {
    throw Object.assign(new Error('path traversal forbidden'), { status: 403 });
  }
  const clean = path.basename(relativePath.trim());
  if (!clean || clean === '.' || clean === '..') {
    throw Object.assign(new Error('invalid filename'), { status: 400 });
  }
  const full = path.join(baseDir, clean);
  const resolvedBase = path.resolve(baseDir);
  const resolvedFull = path.resolve(full);
  if (!resolvedFull.startsWith(resolvedBase + path.sep) && resolvedFull !== resolvedBase) {
    throw Object.assign(new Error('path traversal forbidden'), { status: 403 });
  }
  return { full: resolvedFull, filename: clean };
}

// --- Marp Themes -------------------------------------------------------------
//
// Two layers:
//
//   shipped  marp-themes/ in the release - the themes that come with Podium,
//            listed in its themes.json. Read-only: an update replaces the
//            release, and a deployed release is not writable anyway.
//   custom   what administrators make: THEMES_DIR if set, else DATA_DIR/themes
//            on a server with a data directory, so it survives updates. With
//            neither (a checkout run by hand), the two are the same folder, as
//            they always were.
//
// A custom file with a shipped file's name overrides it - that is how a
// shipped theme is edited, and removing the override restores the original.
// A shipped theme cannot be deleted, only hidden (listed in the custom
// layer's themes.json under "hidden"). Marp's own three (default, gaia,
// uncover) live inside Marp and are not files at all; "customizing" one makes
// a new theme that imports it.
//
// What decks see is servedThemes(): marp-themes/themes.json and each file,
// merged from both layers (see serveTheme, used by podium-server.js).

const MARP_BUILT_IN = ['default', 'gaia', 'uncover'];
const THEME_NAME_RE = /@theme\s+([A-Za-z0-9_-]+)/;

function themeLayers(ctx) {
  const { staticRoot, themesDir } = resolveRoots(ctx);
  const shipped = path.join(staticRoot, 'marp-themes');
  let custom = shipped;
  if (process.env.THEMES_DIR) custom = themesDir;
  else if (ctx?.dataDir) custom = path.join(ctx.dataDir, 'themes');
  return { shipped, custom, layered: path.resolve(custom) !== path.resolve(shipped) };
}

function getThemesManifestPath(themesDir) {
  return path.join(themesDir, 'themes.json');
}

function readThemesManifest(themesDir) {
  const p = getThemesManifestPath(themesDir);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { themes: [] };
  } catch {
    return { themes: [] };
  }
}

function writeThemesManifest(themesDir, data) {
  fs.mkdirSync(themesDir, { recursive: true });
  const p = getThemesManifestPath(themesDir);
  const jsonStr = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(p, jsonStr, 'utf8');
}

const listOf = (manifest, key = 'themes') => (Array.isArray(manifest?.[key]) ? manifest[key].filter((f) => typeof f === 'string') : []);
const themeNameOf = (css) => THEME_NAME_RE.exec(String(css || ''))?.[1] || '';

function readCss(dir, filename) {
  try { return fs.readFileSync(path.join(dir, filename), 'utf8'); } catch { return null; }
}

function cssFilename(filename) {
  if (typeof filename !== 'string' || !filename.endsWith('.css')) {
    throw Object.assign(new Error('theme file must have .css extension'), { status: 400 });
  }
  return filename;
}

/** Every theme: Marp's own, the shipped ones (overridden or hidden or not), and custom ones. */
function listThemes(ctx) {
  const { shipped, custom, layered } = themeLayers(ctx);
  const shippedManifest = readThemesManifest(shipped);
  const customManifest = layered ? readThemesManifest(custom) : shippedManifest;
  const shippedFiles = layered ? listOf(shippedManifest) : [];
  const hidden = new Set(listOf(customManifest, 'hidden'));
  const list = MARP_BUILT_IN.map((name) => ({ filename: null, name, source: 'marp', editable: false }));
  const seen = new Set();

  const entry = (dir, filename, extra) => {
    let st = null;
    try { st = fs.statSync(path.join(dir, filename)); } catch { /* missing */ }
    return {
      filename,
      name: themeNameOf(readCss(dir, filename)) || filename.replace(/\.css$/, ''),
      size: st?.size || 0,
      mtime: st?.mtimeMs || 0,
      missing: !st,
      inManifest: true,
      editable: true,
      ...extra,
    };
  };

  for (const filename of shippedFiles) {
    seen.add(filename);
    const overridden = fs.existsSync(path.join(custom, filename));
    list.push(entry(overridden ? custom : shipped, filename, { source: 'shipped', overridden, hidden: hidden.has(filename) }));
  }
  fs.mkdirSync(custom, { recursive: true });
  const registered = new Set(listOf(customManifest));
  const onDisk = fs.readdirSync(custom, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.css')).map((e) => e.name);
  for (const filename of [...new Set([...registered, ...onDisk])].sort((a, b) => a.localeCompare(b))) {
    if (seen.has(filename)) continue;
    list.push(entry(custom, filename, { source: 'custom', inManifest: registered.has(filename) }));
  }
  return { themes: list, layered };
}

/** A theme's CSS as decks get it (an override if there is one), or the shipped original. */
function getTheme(ctx, filename, { original = false } = {}) {
  cssFilename(filename);
  const { shipped, custom, layered } = themeLayers(ctx);
  safePath(custom, filename);
  let css = original ? null : readCss(custom, filename);
  if (css === null && layered) css = readCss(shipped, filename);
  if (css === null) {
    throw Object.assign(new Error(`theme ${filename} not found`), { status: 404 });
  }
  return { filename: path.basename(filename), css };
}

function saveTheme(ctx, filename, css) {
  cssFilename(filename);
  if (typeof css !== 'string') {
    throw Object.assign(new Error('css content required'), { status: 400 });
  }
  const { custom } = themeLayers(ctx);
  const { full, filename: cleanName } = safePath(custom, filename);
  // A theme is known to Marp by its @theme name, not its file name: one that
  // takes a name already in use would silently replace that theme in every deck.
  const name = themeNameOf(css);
  if (!name) throw Object.assign(new Error('a theme needs a name: start it with /* @theme your-name */'), { status: 400 });
  if (MARP_BUILT_IN.includes(name)) {
    throw Object.assign(new Error(`"${name}" is one of Marp's own themes; give this one a name of its own (to change ${name}, make a customized copy)`), { status: 400 });
  }
  const clash = listThemes(ctx).themes.find((t) => t.filename && t.filename !== cleanName && t.name === name);
  if (clash) throw Object.assign(new Error(`the name "${name}" is already used by ${clash.filename}`), { status: 409 });

  fs.mkdirSync(custom, { recursive: true });
  fs.writeFileSync(full, css, 'utf8');
  const manifest = readThemesManifest(custom);
  if (!Array.isArray(manifest.themes)) manifest.themes = [];
  if (!manifest.themes.includes(cleanName) && !isShipped(ctx, cleanName)) {
    manifest.themes.push(cleanName);
    writeThemesManifest(custom, manifest);
  }
  const st = fs.statSync(full);
  return { ok: true, filename: cleanName, name, size: st.size, mtime: st.mtimeMs };
}

function isShipped(ctx, filename) {
  const { shipped, layered } = themeLayers(ctx);
  return layered && listOf(readThemesManifest(shipped)).includes(filename);
}

/**
 * Remove a theme: a custom one is deleted; a shipped one's override is
 * dropped, putting the original back. A shipped original stays - hide it.
 */
function deleteTheme(ctx, filename) {
  const { custom } = themeLayers(ctx);
  const { full, filename: cleanName } = safePath(custom, filename);
  const shipped = isShipped(ctx, cleanName);
  if (shipped && !fs.existsSync(full)) {
    throw Object.assign(new Error(`${cleanName} comes with Podium and cannot be deleted; hide it instead`), { status: 400 });
  }
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const manifest = readThemesManifest(custom);
  if (Array.isArray(manifest.themes) && !shipped) {
    manifest.themes = manifest.themes.filter((t) => t !== cleanName);
    writeThemesManifest(custom, manifest);
  }
  return { ok: true, removed: cleanName, restored: shipped };
}

/** Hide a shipped theme from decks, or show it again. */
function setThemeHidden(ctx, filename, hide) {
  if (!isShipped(ctx, filename)) {
    throw Object.assign(new Error('only a theme that comes with Podium can be hidden; delete a theme you added instead'), { status: 400 });
  }
  const { custom } = themeLayers(ctx);
  const manifest = readThemesManifest(custom);
  const hidden = new Set(listOf(manifest, 'hidden'));
  if (hide) hidden.add(filename); else hidden.delete(filename);
  manifest.themes = listOf(manifest);
  manifest.hidden = [...hidden].sort();
  writeThemesManifest(custom, manifest);
  return { ok: true, filename, hidden: !!hide };
}

/**
 * A new theme built on one of Marp's own (or any other theme by name): it
 * imports the original, so it starts out looking the same, ready to change.
 */
function customizeTheme(ctx, base) {
  const known = listThemes(ctx).themes;
  const from = known.find((t) => t.name === base);
  if (!from) throw Object.assign(new Error(`no theme called ${base}`), { status: 404 });
  const taken = new Set(known.map((t) => t.name));
  let name = `${base}-custom`;
  for (let i = 2; taken.has(name); i++) name = `${base}-custom-${i}`;
  const css = `/* @theme ${name} */
/* A customized copy of ${base}: everything not changed below comes from it. */
@import '${base}';

section {
  /* background-color: #ffffff; */
  /* color: #222222; */
}

h1, h2 {
  /* color: #0b3954; */
}
`;
  return saveTheme(ctx, `${name}.css`, css);
}

/** marp-themes/themes.json as decks read it: both layers, less the hidden. */
function servedThemesManifest(ctx) {
  const { themes } = listThemes(ctx);
  return { themes: themes.filter((t) => t.filename && !t.hidden && !t.missing && t.inManifest).map((t) => t.filename) };
}

/**
 * Answer a GET for something under /marp-themes/ - the merged manifest, or a
 * theme's CSS from whichever layer has it. Returns false for anything else,
 * so the static file server carries on.
 */
function serveTheme(ctx, pathname, res) {
  const rest = pathname.replace(/^\/marp-themes\//, '');
  if (!rest || rest.includes('/')) return false;
  const send = (status, type, body) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(body);
    return true;
  };
  if (rest === 'themes.json') return send(200, 'application/json; charset=utf-8', JSON.stringify(servedThemesManifest(ctx)));
  if (!rest.endsWith('.css')) return false;
  try {
    return send(200, 'text/css; charset=utf-8', getTheme(ctx, decodeURIComponent(rest)).css);
  } catch {
    return send(404, 'text/plain; charset=utf-8', 'not found');
  }
}

// --- Content Pre-load Files --------------------------------------------------

function getCategoryDir(contentDir, category) {
  const spec = CATEGORIES[category];
  if (!spec) {
    throw Object.assign(new Error(`invalid category "${category}". Allowed: ${Object.keys(CATEGORIES).join(', ')}`), { status: 400 });
  }
  return path.join(contentDir, spec.dir);
}

function listFiles(ctx, category = null) {
  const { contentDir } = resolveRoots(ctx);
  const cats = category ? [category] : Object.keys(CATEGORIES);
  const items = [];

  for (const cat of cats) {
    const spec = CATEGORIES[cat];
    if (!spec) continue;
    const catDir = path.join(contentDir, spec.dir);
    if (!fs.existsSync(catDir)) continue;

    const entries = fs.readdirSync(catDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.') || entry.name === 'README.md') continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!spec.extensions.includes(ext)) continue;
      try {
        const full = path.join(catDir, entry.name);
        const st = fs.statSync(full);
        items.push({
          category: cat,
          filename: entry.name,
          size: st.size,
          mtime: st.mtimeMs,
          url: `content/${spec.dir}/${entry.name}`,
          isText: spec.isText,
        });
      } catch { /* file removed mid-scan */ }
    }
  }

  items.sort((a, b) => b.mtime - a.mtime || a.filename.localeCompare(b.filename));
  return { files: items, categories: Object.keys(CATEGORIES) };
}

function getContentFile(ctx, category, filename) {
  const { contentDir } = resolveRoots(ctx);
  const spec = CATEGORIES[category];
  const catDir = getCategoryDir(contentDir, category);
  const { full, filename: cleanName } = safePath(catDir, filename);

  if (!fs.existsSync(full)) {
    throw Object.assign(new Error(`file ${cleanName} not found in ${category}`), { status: 404 });
  }

  const st = fs.statSync(full);
  if (spec.isText) {
    const text = fs.readFileSync(full, 'utf8');
    return { category, filename: cleanName, text, size: st.size, mtime: st.mtimeMs, isText: true };
  }

  return { category, filename: cleanName, path: full, size: st.size, mtime: st.mtimeMs, isText: false };
}

function saveContentFile(ctx, category, filename, data) {
  const { contentDir } = resolveRoots(ctx);
  const spec = CATEGORIES[category];
  const catDir = getCategoryDir(contentDir, category);
  fs.mkdirSync(catDir, { recursive: true });

  const ext = path.extname(filename).toLowerCase();
  if (!spec.extensions.includes(ext)) {
    throw Object.assign(new Error(`extension ${ext} not allowed for ${category}. Allowed: ${spec.extensions.join(', ')}`), { status: 400 });
  }

  const { full, filename: cleanName } = safePath(catDir, filename);

  if (Buffer.isBuffer(data)) {
    if (data.length > spec.maxBytes) {
      throw Object.assign(new Error(`file exceeds maximum size of ${Math.round(spec.maxBytes / (1024 * 1024))} MB`), { status: 413 });
    }
    fs.writeFileSync(full, data);
  } else if (typeof data === 'string') {
    if (Buffer.byteLength(data, 'utf8') > spec.maxBytes) {
      throw Object.assign(new Error(`file exceeds maximum size of ${Math.round(spec.maxBytes / (1024 * 1024))} MB`), { status: 413 });
    }
    fs.writeFileSync(full, data, 'utf8');
  } else {
    throw Object.assign(new Error('file data required'), { status: 400 });
  }

  const st = fs.statSync(full);
  return {
    ok: true,
    category,
    filename: cleanName,
    size: st.size,
    mtime: st.mtimeMs,
    url: `content/${spec.dir}/${cleanName}`,
    isText: spec.isText,
  };
}

function deleteContentFile(ctx, category, filename) {
  const { contentDir } = resolveRoots(ctx);
  const catDir = getCategoryDir(contentDir, category);
  const { full, filename: cleanName } = safePath(catDir, filename);

  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  return { ok: true, removed: cleanName, category };
}

// --- Manifest JSON -----------------------------------------------------------

function getManifestPath(contentDir) {
  return path.join(contentDir, 'manifest.json');
}

function getManifest(ctx) {
  const { contentDir } = resolveRoots(ctx);
  const p = getManifestPath(contentDir);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : []);
    const examplesEnabled = typeof parsed.examplesEnabled === 'boolean' ? parsed.examplesEnabled : true;
    const builtIns = parsed.builtIns && typeof parsed.builtIns === 'object' ? parsed.builtIns : {
      black: true,
      whiteboard: true,
      chalkboard: true,
      camera: true,
      timer: true,
      trackend: true,
    };

    return {
      _comment: parsed._comment || '',
      examplesEnabled,
      builtIns,
      items,
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        _comment: '',
        examplesEnabled: true,
        builtIns: {
          black: true,
          whiteboard: true,
          chalkboard: true,
          camera: true,
          timer: true,
          trackend: true,
        },
        items: [],
      };
    }
    throw Object.assign(new Error(`could not read manifest.json: ${err.message}`), { status: 500 });
  }
}

function saveManifest(ctx, data) {
  const { contentDir } = resolveRoots(ctx);
  fs.mkdirSync(contentDir, { recursive: true });
  const p = getManifestPath(contentDir);

  if (!data || typeof data !== 'object') {
    throw Object.assign(new Error('manifest data must be an object'), { status: 400 });
  }

  const items = Array.isArray(data.items) ? data.items : [];
  for (const item of items) {
    if (!item || typeof item !== 'object') throw Object.assign(new Error('manifest item must be an object'), { status: 400 });
    if (!item.type || typeof item.type !== 'string') throw Object.assign(new Error('manifest item requires a type'), { status: 400 });
    if (!item.title || typeof item.title !== 'string') throw Object.assign(new Error('manifest item requires a title'), { status: 400 });
  }

  const payload = {
    _comment: data._comment || 'Your lecture library. Configured via Podium Content Management in Admin.',
    examplesEnabled: data.examplesEnabled !== false,
    builtIns: data.builtIns && typeof data.builtIns === 'object' ? data.builtIns : {
      black: true,
      whiteboard: true,
      chalkboard: true,
      camera: true,
      timer: true,
      trackend: true,
    },
    items,
  };

  fs.writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { ok: true, count: items.length };
}

// --- Music JSON --------------------------------------------------------------

function getMusicPath(contentDir) {
  return path.join(contentDir, 'music.json');
}

function getMusic(ctx) {
  const { contentDir } = resolveRoots(ctx);
  const p = getMusicPath(contentDir);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    const playlists = Array.isArray(parsed.playlists) ? parsed.playlists : [];
    return {
      _comment: parsed._comment || '',
      playlists,
    };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { _comment: '', playlists: [] };
    }
    throw Object.assign(new Error(`could not read music.json: ${err.message}`), { status: 500 });
  }
}

function saveMusic(ctx, data) {
  const { contentDir } = resolveRoots(ctx);
  fs.mkdirSync(contentDir, { recursive: true });
  const p = getMusicPath(contentDir);

  if (!data || typeof data !== 'object') {
    throw Object.assign(new Error('music data must be an object'), { status: 400 });
  }

  const playlists = Array.isArray(data.playlists) ? data.playlists : [];
  for (const pl of playlists) {
    if (!pl || typeof pl !== 'object') throw Object.assign(new Error('playlist must be an object'), { status: 400 });
    if (!pl.name || typeof pl.name !== 'string') throw Object.assign(new Error('playlist requires a name'), { status: 400 });
    if (!Array.isArray(pl.tracks)) pl.tracks = [];
    for (const tr of pl.tracks) {
      if (!tr || typeof tr !== 'object') throw Object.assign(new Error('track must be an object'), { status: 400 });
      if (!tr.src || typeof tr.src !== 'string') throw Object.assign(new Error('track requires a src'), { status: 400 });
    }
  }

  const payload = {
    _comment: data._comment || 'Background music for the controller\'s Music tab. Configured via Podium Content Management in Admin.',
    playlists,
  };

  fs.writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { ok: true, count: playlists.length };
}

module.exports = {
  CATEGORIES,
  resolveRoots,
  safePath,
  listThemes,
  getTheme,
  saveTheme,
  deleteTheme,
  setThemeHidden,
  customizeTheme,
  servedThemesManifest,
  serveTheme,
  MARP_BUILT_IN,
  listFiles,
  getContentFile,
  saveContentFile,
  deleteContentFile,
  getManifest,
  saveManifest,
  getMusic,
  saveMusic,
};
