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

function listThemes(ctx) {
  const { themesDir } = resolveRoots(ctx);
  fs.mkdirSync(themesDir, { recursive: true });
  const manifest = readThemesManifest(themesDir);
  const manifestSet = new Set(Array.isArray(manifest.themes) ? manifest.themes : []);

  const filesOnDisk = fs.readdirSync(themesDir, { withFileTypes: true });
  const list = [];
  const seen = new Set();

  for (const entry of filesOnDisk) {
    if (!entry.isFile() || !entry.name.endsWith('.css')) continue;
    seen.add(entry.name);
    try {
      const st = fs.statSync(path.join(themesDir, entry.name));
      list.push({
        filename: entry.name,
        inManifest: manifestSet.has(entry.name),
        size: st.size,
        mtime: st.mtimeMs,
      });
    } catch { /* file removed mid-scan */ }
  }

  // Include any listed in manifest that might be missing on disk
  for (const name of manifestSet) {
    if (!seen.has(name)) {
      list.push({
        filename: name,
        inManifest: true,
        size: 0,
        mtime: 0,
        missing: true,
      });
    }
  }

  list.sort((a, b) => a.filename.localeCompare(b.filename));
  return { themes: list };
}

function getTheme(ctx, filename) {
  const { themesDir } = resolveRoots(ctx);
  if (!filename.endsWith('.css')) {
    throw Object.assign(new Error('only .css theme files are supported'), { status: 400 });
  }
  const { full, filename: cleanName } = safePath(themesDir, filename);
  try {
    const css = fs.readFileSync(full, 'utf8');
    return { filename: cleanName, css };
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw Object.assign(new Error(`theme ${cleanName} not found`), { status: 404 });
    }
    throw err;
  }
}

function saveTheme(ctx, filename, css) {
  const { themesDir } = resolveRoots(ctx);
  if (!filename.endsWith('.css')) {
    throw Object.assign(new Error('theme file must have .css extension'), { status: 400 });
  }
  if (typeof css !== 'string') {
    throw Object.assign(new Error('css content required'), { status: 400 });
  }
  fs.mkdirSync(themesDir, { recursive: true });
  const { full, filename: cleanName } = safePath(themesDir, filename);
  fs.writeFileSync(full, css, 'utf8');

  // Ensure it is registered in themes.json
  const manifest = readThemesManifest(themesDir);
  if (!Array.isArray(manifest.themes)) manifest.themes = [];
  if (!manifest.themes.includes(cleanName)) {
    manifest.themes.push(cleanName);
    writeThemesManifest(themesDir, manifest);
  }

  const st = fs.statSync(full);
  return { ok: true, filename: cleanName, size: st.size, mtime: st.mtimeMs };
}

function deleteTheme(ctx, filename) {
  const { themesDir } = resolveRoots(ctx);
  const { full, filename: cleanName } = safePath(themesDir, filename);
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // Remove from themes.json
  const manifest = readThemesManifest(themesDir);
  if (Array.isArray(manifest.themes)) {
    manifest.themes = manifest.themes.filter((t) => t !== cleanName);
    writeThemesManifest(themesDir, manifest);
  }

  return { ok: true, removed: cleanName };
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
  listFiles,
  getContentFile,
  saveContentFile,
  deleteContentFile,
  getManifest,
  saveManifest,
  getMusic,
  saveMusic,
};
