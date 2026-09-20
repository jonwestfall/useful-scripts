// Run with:  node podium/test/content.test.mjs
// Content, Marp theme, Manifest, and Music management tests (Issue #54)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const store = require('../server/store.js');
const accounts = require('../server/accounts.js');
const api = require('../server/api.js');

import {
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
} from '../server/content.js';

import { itemForStage, itemLabel, newItem, PLAN_TYPES } from '../assets/js/planfile.js';

let ok = true;
const chk = (label, cond) => {
  if (!cond) {
    ok = false;
    console.log('FAIL', label);
  } else {
    console.log('ok  ', label);
  }
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'podium-content-test-'));
const staticDir = path.join(tmpDir, 'static');
const contentDir = path.join(staticDir, 'content');
const themesDir = path.join(staticDir, 'marp-themes');

fs.mkdirSync(contentDir, { recursive: true });
fs.mkdirSync(themesDir, { recursive: true });

const testCtx = { staticDir };
let apiDb = null;

try {
  console.log('-- path traversal safety --');
  const safeRes = safePath(themesDir, 'theme.css');
  chk('safe filename accepted', safeRes.filename === 'theme.css');

  chk('reject empty filename', (() => {
    try { safePath(themesDir, ''); return false; } catch (e) { return e.status === 400; }
  })());

  chk('reject parent traversal ../..', (() => {
    try { safePath(themesDir, '../../etc/passwd'); return false; } catch (e) { return e.status === 400 || e.status === 403; }
  })());

  chk('reject directory path traversal', (() => {
    try { safePath(themesDir, 'subdir/foo.css'); return false; } catch (e) { return true; }
  })());

  console.log('-- marp themes management --');
  chk('initial themes list is empty', listThemes(testCtx).themes.length === 0);

  const saveRes = saveTheme(testCtx, 'ocean.css', '/* @theme ocean */\nsection { background: blue; }');
  chk('saving theme succeeds', saveRes.ok && saveRes.filename === 'ocean.css');

  const themesManifest = JSON.parse(fs.readFileSync(path.join(themesDir, 'themes.json'), 'utf8'));
  chk('theme registered in themes.json', Array.isArray(themesManifest.themes) && themesManifest.themes.includes('ocean.css'));

  const listed = listThemes(testCtx).themes;
  chk('theme appears in listThemes', listed.some((t) => t.filename === 'ocean.css' && t.inManifest));

  const fetched = getTheme(testCtx, 'ocean.css');
  chk('getTheme returns css content', fetched.css.includes('/* @theme ocean */'));

  chk('reject non-css theme file', (() => {
    try { saveTheme(testCtx, 'ocean.txt', 'body{}'); return false; } catch (e) { return e.status === 400; }
  })());

  chk('deleteTheme removes file and unregisters from themes.json', (() => {
    deleteTheme(testCtx, 'ocean.css');
    const updatedManifest = JSON.parse(fs.readFileSync(path.join(themesDir, 'themes.json'), 'utf8'));
    return !fs.existsSync(path.join(themesDir, 'ocean.css')) && !updatedManifest.themes.includes('ocean.css');
  })());

  console.log('-- pre-load content files management --');
  chk('support all 5 categories',
    ['decks', 'audio', 'slides', 'video', 'photos'].every((c) => !!CATEGORIES[c]));

  // 1. Deck file (.md)
  const savedDeck = saveContentFile(testCtx, 'decks', 'lecture1.md', '# Lecture 1\nWelcome');
  chk('save deck text file', savedDeck.ok && savedDeck.filename === 'lecture1.md');
  const readDeck = getContentFile(testCtx, 'decks', 'lecture1.md');
  chk('read deck file as text', readDeck.isText && readDeck.text.includes('# Lecture 1'));

  // 2. Audio file (.mp3 / .wav)
  const audioBuf = Buffer.from([0xFF, 0xFB, 0x90, 0x44]);
  const savedAudio = saveContentFile(testCtx, 'audio', 'bell.mp3', audioBuf);
  chk('save audio buffer', savedAudio.ok && savedAudio.filename === 'bell.mp3');
  const readAudio = getContentFile(testCtx, 'audio', 'bell.mp3');
  chk('read audio as binary path', !readAudio.isText && fs.existsSync(readAudio.path));

  // 3. Photo file (.png)
  const photoBuf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const savedPhoto = saveContentFile(testCtx, 'photos', 'diagram.png', photoBuf);
  chk('save photo buffer', savedPhoto.ok && savedPhoto.url === 'content/photos/diagram.png');

  // 4. Video file (.mp4)
  const videoBuf = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
  const savedVideo = saveContentFile(testCtx, 'video', 'clip.mp4', videoBuf);
  chk('save video buffer', savedVideo.ok && savedVideo.filename === 'clip.mp4');

  // 5. Slides file (.html)
  const savedSlides = saveContentFile(testCtx, 'slides', 'intro.html', '<div>Slide 1</div>');
  chk('save slides html', savedSlides.ok && savedSlides.isText);

  // Category filtering
  const allFiles = listFiles(testCtx).files;
  chk('listFiles returns all items across categories', allFiles.length === 5);
  const onlyPhotos = listFiles(testCtx, 'photos').files;
  chk('listFiles filters by category', onlyPhotos.length === 1 && onlyPhotos[0].filename === 'diagram.png');

  // Extension validation
  chk('reject invalid extension for category', (() => {
    try { saveContentFile(testCtx, 'photos', 'bad.exe', Buffer.from('abc')); return false; } catch (e) { return e.status === 400; }
  })());

  // Size limit validation
  chk('reject payload exceeding maxBytes', (() => {
    try {
      const hugeBuf = Buffer.alloc(CATEGORIES.photos.maxBytes + 1024);
      saveContentFile(testCtx, 'photos', 'huge.png', hugeBuf);
      return false;
    } catch (e) {
      return e.status === 413;
    }
  })());

  // Delete content file
  chk('delete content file', (() => {
    deleteContentFile(testCtx, 'photos', 'diagram.png');
    return listFiles(testCtx, 'photos').files.length === 0;
  })());

  console.log('-- manifest.json management --');
  const initialManifest = getManifest(testCtx);
  chk('default manifest settings', initialManifest.examplesEnabled === true && initialManifest.builtIns.black === true);

  const manifestPayload = {
    examplesEnabled: false,
    builtIns: {
      black: true,
      whiteboard: false,
      chalkboard: false,
      camera: true,
      timer: true,
      trackend: false,
    },
    items: [
      { type: 'deck', title: 'Course Intro', src: 'content/decks/lecture1.md', enabled: true },
      { type: 'image', title: 'Lab Diagram', src: 'content/photos/lab.png', enabled: false },
    ],
  };
  saveManifest(testCtx, manifestPayload);

  const reloadedManifest = getManifest(testCtx);
  chk('manifest saved and reloaded',
    reloadedManifest.examplesEnabled === false &&
    reloadedManifest.builtIns.whiteboard === false &&
    reloadedManifest.items.length === 2 &&
    reloadedManifest.items[1].enabled === false);

  chk('reject invalid manifest structure', (() => {
    try { saveManifest(testCtx, { items: [{ notype: true }] }); return false; } catch (e) { return e.status === 400; }
  })());

  console.log('-- music.json management --');
  const initialMusic = getMusic(testCtx);
  chk('initial music playlists empty', Array.isArray(initialMusic.playlists));

  const musicPayload = {
    playlists: [
      {
        name: 'Pre-class Ambient',
        shuffle: true,
        loop: true,
        tracks: [
          { title: 'Morning Light', artist: 'Sky', src: 'content/audio/morning.mp3' },
          { title: 'Coffee Breeze', artist: 'Sky', src: 'content/audio/coffee.mp3' },
        ],
      },
    ],
  };
  saveMusic(testCtx, musicPayload);

  const reloadedMusic = getMusic(testCtx);
  chk('music playlists saved and reloaded',
    reloadedMusic.playlists.length === 1 &&
    reloadedMusic.playlists[0].name === 'Pre-class Ambient' &&
    reloadedMusic.playlists[0].tracks.length === 2);

  chk('reject invalid music playlist structure', (() => {
    try { saveMusic(testCtx, { playlists: [{ missing_name: true }] }); return false; } catch (e) { return e.status === 400; }
  })());

  console.log('-- planfile photo path integration --');
  chk('image item has path field in PLAN_TYPES', PLAN_TYPES.image.fields.some((f) => f.key === 'path'));

  const stagedWithSrc = itemForStage({ type: 'image', src: 'data:image/png;base64,123', path: 'content/photos/pic.png' });
  chk('itemForStage keeps existing src if present', stagedWithSrc.src === 'data:image/png;base64,123');

  const stagedWithPathOnly = itemForStage({ type: 'image', path: 'content/photos/diagram.png' });
  chk('itemForStage populates src from path when src is empty', stagedWithPathOnly.src === 'content/photos/diagram.png');

  chk('itemLabel formats path for photo item',
    itemLabel({ type: 'image', path: 'content/photos/diagram.png' }) === 'diagram.png');

  console.log('-- api.handleApi content routes --');
  function mockReqRes(method, urlPath, { token, body, headers = {} } = {}) {
    const url = new URL(urlPath, 'http://localhost');
    const reqStream = new Readable({
      read() {
        if (body) {
          if (typeof body === 'string') this.push(body);
          else if (Buffer.isBuffer(body)) this.push(body);
          else this.push(JSON.stringify(body));
        }
        this.push(null);
      }
    });
    reqStream.method = method;
    reqStream.headers = {
      host: 'localhost',
      origin: 'http://localhost',
      ...headers,
    };
    if (token) reqStream.headers.cookie = `podium_session=${token}`;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      reqStream.headers['content-type'] = 'application/json';
    }

    let statusCode = 200;
    let resHeaders = {};
    let resChunks = [];

    const res = {
      writeHead(code, h) { statusCode = code; Object.assign(resHeaders, h); },
      setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
      write(chunk) { if (chunk) resChunks.push(Buffer.from(chunk)); },
      end(chunk) { if (chunk) resChunks.push(Buffer.from(chunk)); },
    };

    return {
      req: reqStream,
      res,
      url,
      result: () => ({
        status: statusCode,
        headers: resHeaders,
        body: (() => {
          const raw = Buffer.concat(resChunks).toString('utf8');
          try { return JSON.parse(raw); } catch { return raw; }
        })(),
      }),
    };
  }

  apiDb = store.open(path.join(tmpDir, 'db'));
  await accounts.createUser(apiDb, { username: 'regular_user', password: 'password123', displayName: 'Regular', isAdmin: false });
  await accounts.createUser(apiDb, { username: 'admin_user', password: 'password123', displayName: 'Admin', isAdmin: true });

  const regLogin = await accounts.login(apiDb, 'regular_user', 'password123');
  const admLogin = await accounts.login(apiDb, 'admin_user', 'password123');

  const apiCtx = {
    db: apiDb,
    staticDir,
    hasAccounts: () => true,
    openPaths: new Set(),
  };

  // 1. Non-admin is rejected
  {
    const { req, res, url, result } = mockReqRes('GET', '/api/content/manifest', { token: regLogin.token });
    await api.handleApi(req, res, url, apiCtx);
    const out = result();
    chk('non-admin GET /api/content/manifest rejected with 403', out.status === 403);
  }

  // 2. Admin can GET manifest
  {
    const { req, res, url, result } = mockReqRes('GET', '/api/content/manifest', { token: admLogin.token });
    await api.handleApi(req, res, url, apiCtx);
    const out = result();
    chk('admin GET /api/content/manifest returns 200', out.status === 200 && Array.isArray(out.body.manifest.items));
  }

  // 3. Admin can list and save themes
  {
    const { req, res, url, result } = mockReqRes('POST', '/api/content/themes?filename=api-test.css', {
      token: admLogin.token,
      body: '/* @theme api-test */\nsection { color: red; }',
      headers: { 'content-type': 'text/css' },
    });
    await api.handleApi(req, res, url, apiCtx);
    const out = result();
    chk('admin POST /api/content/themes saves theme', out.status === 200 && out.body.saved.filename === 'api-test.css');
  }
  {
    const { req, res, url, result } = mockReqRes('GET', '/api/content/themes', { token: admLogin.token });
    await api.handleApi(req, res, url, apiCtx);
    const out = result();
    chk('admin GET /api/content/themes lists themes', out.status === 200 && out.body.themes.some((t) => t.filename === 'api-test.css'));
  }

  // 4. Admin can upload, list, and delete files
  {
    const { req, res, url, result } = mockReqRes('POST', '/api/content/files/decks?filename=api-deck.md', {
      token: admLogin.token,
      body: '# API Deck',
      headers: { 'content-type': 'text/markdown' },
    });
    await api.handleApi(req, res, url, apiCtx);
    const out = result();
    chk('admin POST /api/content/files/decks uploads file', out.status === 200 && out.body.saved.filename === 'api-deck.md');
  }
  {
    const { req, res, url, result } = mockReqRes('GET', '/api/content/files?category=decks', { token: admLogin.token });
    await api.handleApi(req, res, url, apiCtx);
    const out = result();
    chk('admin GET /api/content/files lists uploaded deck', out.status === 200 && out.body.files.some((f) => f.filename === 'api-deck.md'));
  }

  // 5. Admin path traversal attempt over API rejected
  {
    const { req, res, url, result } = mockReqRes('GET', '/api/content/files/decks/..%2F..%2Fetc%2Fpasswd', { token: admLogin.token });
    await api.handleApi(req, res, url, apiCtx);
    const out = result();
    chk('path traversal attempt over API rejected with 400 or 403', out.status === 400 || out.status === 403);
  }

  // 6. Admin can GET music
  {
    const { req, res, url, result } = mockReqRes('GET', '/api/content/music', { token: admLogin.token });
    await api.handleApi(req, res, url, apiCtx);
    const out = result();
    chk('admin GET /api/content/music returns 200', out.status === 200 && Array.isArray(out.body.music.playlists));
  }

} finally {
  try { apiDb?.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

if (!ok) {
  console.log('\nSOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\nALL PASS');
}
