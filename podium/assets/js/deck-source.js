// A Marp deck's markdown as slides you can work with (Issue #226).
//
// The deck editor (deck.html) edits the markdown directly - this is not a
// second format, and the file it saves is the same plain .md any Marp tool
// opens. What this module adds is knowing where each slide starts and ends,
// which comments are directives and which are presenter notes, and doing the
// structural edits (move, duplicate, delete, insert, set a directive, set the
// notes) on that model instead of by regex over the whole file.
//
// Two promises, both tested against the real Marp engine (see
// test/deck-source.test.mjs):
//
//   - serializeDeck(parseDeck(md)) === md, byte for byte, for any input. A
//     deck opened and saved without changes comes back identical.
//   - parseDeck finds the same slides Marp does. That is less obvious than
//     "split on ---": a `---` straight under a line of text is a heading
//     underline, not a new slide; one inside a code fence, an indented code
//     block, a multi-line comment or an HTML block is just text; and `***` or
//     `___` separate slides as well.
//
// Pure: no DOM, no Marp, so it runs in Node and in the browser alike.

// Every directive Marp (and Marpit) understands. A comment made only of these
// is a directive; any other comment is a presenter note - the same split
// Marp itself makes when it renders.
export const GLOBAL_DIRECTIVES = [
  'marp', 'theme', 'style', 'headingDivider', 'size', 'math', 'lang', 'title', 'description',
  'author', 'image', 'keywords', 'url',
];
export const LOCAL_DIRECTIVES = [
  'paginate', 'header', 'footer', 'class', 'backgroundColor', 'backgroundImage',
  'backgroundPosition', 'backgroundRepeat', 'backgroundSize', 'color',
];
// Podium's own (Issue #226): a video slide. Marp is told about them too (see
// createMarp in deck.js) so a comment holding them is a directive there as
// well, never a presenter note. Only the one-slide form (`_video`) means
// anything: a video belongs to the slide it is on.
//
//   <!-- _video: /media/<sha>/clip.mp4 -->
//   <!-- _videoStart: 1:05 -->
export const PODIUM_DIRECTIVES = ['video', 'videoStart'];
const KNOWN = new Set([...GLOBAL_DIRECTIVES, ...LOCAL_DIRECTIVES, ...PODIUM_DIRECTIVES]);

/** `1:05`, `1:02:03`, `65` or `65.5` as seconds; anything else is 0. */
export function parseTimecode(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(text)) return 0;
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** Seconds as `m:ss` (or `h:mm:ss`), whole seconds - what _videoStart is written as. */
export function formatTimecode(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const LIST = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const QUOTE = /^ {0,3}>/;
const HTML_START = /^ {0,3}<(?!!--)[A-Za-z/!?]/;
const COMMENT_START = /^ {0,3}<!--/;
const BLANK = /^[ \t]*$/;

/** Split into lines, each keeping its own line ending, so the pieces rejoin exactly. */
function linesOf(text) {
  const out = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const end = nl === -1 ? text.length : nl + 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

const bare = (line) => line.replace(/\r?\n$/, '');

/**
 * The front matter, if the deck opens with one: `---` on the first line and
 * a closing `---` (or `...`) further down. Returns its raw text, or ''.
 */
function frontMatterOf(lines) {
  if (!lines.length || bare(lines[0]) !== '---') return { raw: '', count: 0 };
  for (let i = 1; i < lines.length; i++) {
    const line = bare(lines[i]);
    if (line === '---' || line === '...') {
      return { raw: lines.slice(0, i + 1).join(''), count: i + 1 };
    }
  }
  return { raw: '', count: 0 };
}

/** `key: value` lines of a YAML block, top level only - all Marp ever puts there. */
function yamlFields(text) {
  const fields = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (m) fields[m[1]] = unquote(m[2]);
  }
  return fields;
}

function unquote(value) {
  const v = String(value);
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) return v.slice(1, -1);
  return v;
}

/**
 * Every HTML comment in a slide, with where it is and whether it is a
 * directive. A comment is a directive when every non-blank line in it is a
 * `key: value` naming a known directive (with or without the `_` that makes
 * it apply to one slide only). Comments inside code fences are text, not
 * comments, and are skipped.
 */
export function commentsIn(raw) {
  const out = [];
  const masked = maskCode(raw);
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(masked))) {
    const body = raw.slice(m.index + 4, m.index + m[0].length - 3);
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const pairs = lines.map((l) => /^(_?)([A-Za-z][\w]*)\s*:\s*(.*)$/.exec(l));
    const directive = lines.length > 0 && pairs.every((p) => p && KNOWN.has(p[2]));
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      text: body,
      directive,
      directives: directive ? pairs.map((p) => ({ key: p[2], value: unquote(p[3].trim()), spot: p[1] === '_' })) : [],
    });
  }
  return out;
}

/** The slide's text with fenced and indented code blanked out (same length), so nothing in code looks like markup. */
function maskCode(raw) {
  let out = '';
  let fence = null;
  for (const line of linesOf(raw)) {
    const text = bare(line);
    if (fence) {
      out += line.replace(/[^\n]/g, ' ');
      const close = FENCE.exec(text);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && /^\s*$/.test(text.slice(close[0].length))) fence = null;
      continue;
    }
    const open = FENCE.exec(text);
    if (open) { fence = open[1]; out += line.replace(/[^\n]/g, ' '); continue; }
    out += line;
  }
  return out;
}

/**
 * Parse a deck. Each slide carries its exact raw text and, for every slide
 * after the first, the exact separator line that came before it - which is
 * what lets serializeDeck give back the input unchanged.
 */
export function parseDeck(md) {
  const text = String(md ?? '');
  const lines = linesOf(text);
  const fm = frontMatterOf(lines);
  const slides = [];
  let current = { raw: '', sep: '', start: fm.raw.length };
  let offset = fm.raw.length;

  // What the previous line left open, which decides what a `---` line means.
  let fence = null;          // inside ``` or ~~~
  let comment = false;       // inside a multi-line <!-- -->
  let html = false;          // inside an HTML block (ends at a blank line)
  let paragraph = false;     // the previous line was paragraph text
  let table = false;         // inside a GFM table

  for (let i = fm.count; i < lines.length; i++) {
    const line = lines[i];
    const t = bare(line);

    if (fence) {
      const close = FENCE.exec(t);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && /^\s*$/.test(t.slice(close[0].length))) fence = null;
      current.raw += line; offset += line.length;
      continue;
    }
    if (comment) {
      if (t.includes('-->')) { comment = false; paragraph = false; }
      current.raw += line; offset += line.length;
      continue;
    }
    if (BLANK.test(t)) {
      html = false; paragraph = false; table = false;
      current.raw += line; offset += line.length;
      continue;
    }
    if (html) { current.raw += line; offset += line.length; continue; }

    // A `---` under paragraph text is a heading underline, not a new slide.
    // `***` and `___` can never be one, so they always separate.
    const isBreak = BREAK.test(t) && !(paragraph && SETEXT.test(t));
    if (isBreak) {
      slides.push({ ...current, end: offset });
      current = { raw: '', sep: line, start: offset + line.length };
      offset += line.length;
      paragraph = false; table = false;
      continue;
    }

    current.raw += line; offset += line.length;

    if (paragraph && SETEXT.test(t)) { paragraph = false; continue; }   // setext heading underline
    const open = FENCE.exec(t);
    if (open) { fence = open[1]; paragraph = false; continue; }
    if (COMMENT_START.test(t)) {
      if (!t.slice(t.indexOf('<!--') + 4).includes('-->')) comment = true;
      paragraph = false;
      continue;
    }
    if (!paragraph && /^ {4,}|^\t/.test(line)) continue;                 // indented code
    if (HTML_START.test(t) && !paragraph) { html = true; continue; }
    if (ATX.test(t) || LIST.test(t) || QUOTE.test(t)) { paragraph = false; table = false; continue; }
    if (t.includes('|')) {
      const next = bare(lines[i + 1] || '');
      if (table || (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(next) && next.includes('-'))) {
        table = true; paragraph = false; continue;
      }
    }
    if (table) { paragraph = false; continue; }
    paragraph = true;
  }
  slides.push({ ...current, end: offset });

  const fmBody = fm.raw ? fm.raw.slice(fm.raw.indexOf('\n') + 1).replace(/(?:^|\n)(?:---|\.\.\.)\s*$/, '') : '';
  const frontMatter = { raw: fm.raw, fields: yamlFields(fmBody) };
  return describe({ frontMatter, slides: slides.map((s) => ({ raw: s.raw, sep: s.sep, start: s.start, end: s.end })) });
}

/** Fill in what each slide says about itself: title, directives, classes, notes, build. */
function describe(deck) {
  let inheritedClass = deck.frontMatter.fields.class || '';
  let inheritedPaginate = deck.frontMatter.fields.paginate;
  for (const [index, slide] of deck.slides.entries()) {
    const comments = commentsIn(slide.raw);
    const local = {};
    const spot = {};
    for (const c of comments) {
      for (const d of c.directives) {
        if (d.spot) spot[d.key] = d.value;
        else if (LOCAL_DIRECTIVES.includes(d.key)) local[d.key] = d.value;
      }
    }
    if (local.class !== undefined) inheritedClass = local.class;
    if (local.paginate !== undefined) inheritedPaginate = local.paginate;
    const className = spot.class !== undefined ? spot.class : inheritedClass;
    const masked = maskCode(slide.raw);
    const heading = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(masked.replace(/<!--[\s\S]*?-->/g, ''));
    slide.index = index;
    slide.directives = { ...local, ...spot };
    slide.spot = spot;
    slide.classes = String(className || '').split(/\s+/).filter(Boolean);
    slide.paginate = spot.paginate !== undefined ? spot.paginate : inheritedPaginate;
    slide.notes = comments.filter((c) => !c.directive).map((c) => c.text.trim()).filter(Boolean).join('\n\n');
    slide.title = heading ? heading[1].replace(/[*_`]/g, '').trim() : '';
    slide.hasBuild = slide.classes.includes('build') || /\bclass\s*=\s*["'][^"']*\bbuild\b|\bdata-build\b/.test(masked);
    slide.media = mediaIn(slide.raw);
    slide.video = spot.video ? { src: spot.video, start: parseTimecode(spot.videoStart) } : null;
  }
  deck.headingDivider = deck.frontMatter.fields.headingDivider !== undefined
    || deck.slides.some((s) => commentsIn(s.raw).some((c) => c.directives.some((d) => d.key === 'headingDivider')));
  return deck;
}

/**
 * The `asset:<id>` pictures a deck points at (Issue #226): pictures kept
 * inside a lecture plan rather than in a library, for a deck that lives in a
 * plan on a setup with no server. Whatever shows the deck swaps each for the
 * picture's bytes before Marp sees it.
 */
export const ASSET_REF = /asset:([\w-]{1,64})/g;
export function assetRefsIn(md) {
  return [...new Set(Array.from(String(md ?? '').matchAll(ASSET_REF), (m) => m[1]))];
}

/** Images (markdown and <img>) a slide uses, with where each one is. */
export function mediaIn(raw) {
  const masked = maskCode(raw).replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const out = [];
  const md = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m;
  while ((m = md.exec(masked))) {
    const words = m[1].trim().split(/\s+/).filter(Boolean);
    const options = words.filter(isImageOption);
    out.push({
      kind: 'markdown', start: m.index, end: m.index + m[0].length, src: m[2],
      alt: words.filter((w) => !isImageOption(w)).join(' '),
      background: options.includes('bg'), options,
    });
  }
  const tag = /<img\b[^>]*>/gi;
  while ((m = tag.exec(masked))) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[0]);
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(m[0]);
    if (src) out.push({ kind: 'html', start: m.index, end: m.index + m[0].length, src: src[1], alt: alt ? alt[1] : null, background: false, options: [] });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Marp's image keywords: bg, fit/cover/contain, left/right[:N%], w:/h:,
// filters, vertical, and bare sizes like 50% after bg.
function isImageOption(word) {
  return /^(bg|fit|cover|contain|auto|left|right|vertical|horizontal)(:[\w.%]+)?$/i.test(word)
    || /^(w|h|width|height):\S+$/i.test(word)
    || /^(blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|opacity|saturate|sepia|sepia)(:\S+)?$/i.test(word)
    || /^\d+(\.\d+)?%$/.test(word);
}

/** Back to markdown. Unchanged slides give back exactly what was parsed. */
export function serializeDeck(deck) {
  return deck.frontMatter.raw + deck.slides.map((s, i) => (i ? s.sep : '') + s.raw).join('');
}

// --- edits ---------------------------------------------------------------------
//
// Each returns a NEW markdown string, built from the parsed slides, so the
// editor can apply it as one change (one undo step). Slides that were not
// touched keep their exact text.

const DEFAULT_SEP = '---\n';

/**
 * Rejoin slides after a structural change. Every slide but the last must end
 * with a blank line, or its separator could turn into a heading underline
 * under its last line of text - which is exactly what moving the old last
 * slide (often ending without one) into the middle would otherwise do.
 */
function rejoin(deck, slides) {
  const out = slides.map((s, i) => {
    let raw = s.raw;
    if (i < slides.length - 1) {
      if (!raw.endsWith('\n')) raw += '\n';
      if (!/\n[ \t]*\n$/.test(raw) && raw.trim()) raw += '\n';
    }
    return { ...s, raw, sep: i === 0 ? '' : (s.sep || DEFAULT_SEP) };
  });
  // The first slide needs no separator, but whatever was first before may
  // have started straight after the front matter with no blank line; nothing
  // to fix there - Marp does not care.
  return deck.frontMatter.raw + out.map((s, i) => (i ? s.sep : '') + s.raw).join('');
}

export function moveSlide(md, from, to) {
  const deck = parseDeck(md);
  const slides = deck.slides.slice();
  if (from < 0 || from >= slides.length || to < 0 || to >= slides.length || from === to) return String(md);
  const [moved] = slides.splice(from, 1);
  slides.splice(to, 0, moved);
  return rejoin(deck, slides);
}

export function duplicateSlide(md, index) {
  const deck = parseDeck(md);
  const slides = deck.slides.slice();
  if (!slides[index]) return String(md);
  slides.splice(index + 1, 0, { ...slides[index], sep: DEFAULT_SEP });
  return rejoin(deck, slides);
}

export function deleteSlide(md, index) {
  const deck = parseDeck(md);
  const slides = deck.slides.slice();
  if (!slides[index] || slides.length < 2) return String(md);
  slides.splice(index, 1);
  return rejoin(deck, slides);
}

/** Insert `raw` (one slide's markdown) as a new slide at `index`. */
export function insertSlide(md, index, raw = '\n# New slide\n\n') {
  const deck = parseDeck(md);
  const slides = deck.slides.slice();
  const at = Math.max(0, Math.min(slides.length, index));
  let body = String(raw);
  if (!body.startsWith('\n')) body = `\n${body}`;
  if (!body.endsWith('\n')) body += '\n';
  // An empty deck (or one that is only front matter) has one empty slide:
  // fill it rather than leaving a blank slide in front of the new one.
  if (slides.length === 1 && !slides[0].raw.trim()) {
    slides[0] = { ...slides[0], raw: body };
    return rejoin(deck, slides);
  }
  slides.splice(at, 0, { raw: body, sep: DEFAULT_SEP });
  return rejoin(deck, slides);
}

/**
 * Set (or with null/'' remove) a one-slide directive - `<!-- _key: value -->`
 * - on slide `index`. An existing one is edited where it is, including inside
 * a multi-line directive comment; a new one goes at the top of the slide.
 */
export function setSlideDirective(md, index, key, value) {
  const deck = parseDeck(md);
  const slide = deck.slides[index];
  if (!slide) return String(md);
  let raw = slide.raw;
  const remove = value === null || value === undefined || value === '';
  const comments = commentsIn(raw);
  for (const c of comments.slice().reverse()) {
    if (!c.directive || !c.directives.some((d) => d.spot && d.key === key)) continue;
    const lines = c.text.split(/(\r?\n)/);
    const keep = [];
    for (let i = 0; i < lines.length; i += 2) {
      const line = lines[i];
      const nl = lines[i + 1] || '';
      const m = new RegExp(`^(\\s*)_${key}\\s*:.*$`).exec(line);
      if (!m) { keep.push(line + nl); continue; }
      if (!remove) keep.push(`${m[1]}_${key}: ${yamlValue(value)}${nl}`);
    }
    const body = keep.join('');
    const replacement = body.trim() ? `<!--${body}-->` : '';
    let start = c.start;
    let end = c.end;
    // Removing a comment that sat alone on its line takes the line with it.
    if (!replacement) {
      const before = raw.lastIndexOf('\n', start - 1) + 1;
      const after = raw.indexOf('\n', end);
      if (!raw.slice(before, start).trim() && !raw.slice(end, after === -1 ? raw.length : after).trim()) {
        start = before;
        end = after === -1 ? raw.length : after + 1;
      }
    }
    raw = raw.slice(0, start) + replacement + raw.slice(end);
    return replaceSlide(deck, index, raw);
  }
  if (remove) return String(md);
  const lead = /^\s*/.exec(raw)[0];
  const at = lead.lastIndexOf('\n') + 1;
  raw = `${raw.slice(0, at)}<!-- _${key}: ${yamlValue(value)} -->\n${raw.slice(at)}`;
  if (!raw.startsWith('\n') && index > 0) raw = `\n${raw}`;
  return replaceSlide(deck, index, raw);
}

function yamlValue(value) {
  const v = String(value);
  return /^[\w#.%/ -]*$/.test(v) && v.trim() === v ? v : JSON.stringify(v);
}

/**
 * Make slide `index` a video slide (Issue #226), or with no `src` stop it
 * being one. The video plays over the slide in class; the poster, a
 * background picture of its first frame, is what the slide shows until then
 * (and is what thumbnails, exports and a slide's photo are made from).
 *
 * @param {string} md
 * @param {number} index
 * @param {{src?: string, start?: number, poster?: string}} video
 */
export function setSlideVideo(md, index, { src = '', start = 0, poster = '' } = {}) {
  // videoStart first: a new directive goes at the top of the slide, so this
  // order leaves _video above it, where it reads first.
  let out = setSlideDirective(md, index, 'videoStart', src && start > 0 ? formatTimecode(start) : null);
  out = setSlideDirective(out, index, 'video', src || null);
  if (!src || !poster) return out;
  const deck = parseDeck(out);
  const slide = deck.slides[index];
  if (!slide || slide.media.some((m) => m.background && m.src === poster)) return out;
  // Straight after the directives, so the poster sits with the video it is for.
  let raw = slide.raw;
  const last = commentsIn(raw).filter((c) => c.directive && c.directives.some((d) => d.key === 'video' || d.key === 'videoStart')).at(-1);
  const at = last ? (raw.indexOf('\n', last.end) === -1 ? raw.length : raw.indexOf('\n', last.end) + 1) : 0;
  const tag = `![bg contain](${poster})\n${/^[ \t]*\S/.test(raw.slice(at)) ? '\n' : ''}`;
  raw = `${raw.slice(0, at)}${at && raw.slice(0, at).endsWith('\n') ? '' : '\n'}${tag}${raw.slice(at)}`;
  return replaceSlide(deck, index, raw);
}

/** Toggle Podium's build class on a slide, keeping any other classes it has. */
export function setSlideBuild(md, index, on) {
  const deck = parseDeck(md);
  const slide = deck.slides[index];
  if (!slide) return String(md);
  const own = slide.spot.class !== undefined ? slide.spot.class.split(/\s+/).filter(Boolean) : null;
  const base = own ?? slide.classes;
  const next = on ? [...new Set([...base, 'build'])] : base.filter((c) => c !== 'build');
  // Leave the slide inheriting when that already gives the right answer.
  const inherited = own === null;
  if (inherited && next.join(' ') === slide.classes.join(' ')) return String(md);
  return setSlideDirective(md, index, 'class', next.join(' '));
}

/** Replace a slide's presenter notes (all of them) with `text`. */
export function setSlideNotes(md, index, text) {
  const deck = parseDeck(md);
  const slide = deck.slides[index];
  if (!slide) return String(md);
  let raw = slide.raw;
  for (const c of commentsIn(raw).reverse()) {
    if (c.directive) continue;
    let start = c.start;
    let end = c.end;
    const before = raw.lastIndexOf('\n', start - 1) + 1;
    const after = raw.indexOf('\n', end);
    if (!raw.slice(before, start).trim() && !raw.slice(end, after === -1 ? raw.length : after).trim()) {
      start = before;
      end = after === -1 ? raw.length : after + 1;
    }
    raw = raw.slice(0, start) + raw.slice(end);
  }
  const notes = String(text || '').trim();
  if (notes) {
    // `-->` inside a note would end the comment early; nothing else can.
    const safe = notes.replace(/--+>/g, (m) => m.replace(/>$/, ' >'));
    const trail = /\s*$/.exec(raw)[0];
    const body = raw.slice(0, raw.length - trail.length);
    raw = `${body}\n\n<!--\n${safe}\n-->\n${trail.includes('\n\n') ? '\n' : ''}`;
  }
  return replaceSlide(deck, index, raw);
}

function replaceSlide(deck, index, raw) {
  const slides = deck.slides.map((s, i) => (i === index ? { ...s, raw } : s));
  return deck.frontMatter.raw + slides.map((s, i) => (i ? s.sep : '') + s.raw).join('');
}

/**
 * Set (or with null/'' remove) a front matter field. A deck with no front
 * matter gets one, starting with `marp: true` so other Marp tools recognise it.
 */
export function setFrontMatter(md, key, value) {
  const text = String(md ?? '');
  const deck = parseDeck(text);
  const remove = value === null || value === undefined || value === '';
  const line = `${key}: ${yamlValue(value)}`;
  if (!deck.frontMatter.raw) {
    if (remove) return text;
    return `---\nmarp: true\n${line}\n---\n\n${text.replace(/^\n+/, '')}`;
  }
  const fm = deck.frontMatter.raw;
  const nl = fm.includes('\r\n') ? '\r\n' : '\n';
  const lines = fm.split(/\r?\n/);
  const at = lines.findIndex((l, i) => i > 0 && new RegExp(`^${key}\\s*:`).test(l));
  if (at !== -1) {
    if (remove) lines.splice(at, 1);
    else lines[at] = line;
  } else if (!remove) {
    // Before the closing fence, which is the last non-empty line.
    let close = lines.length - 1;
    while (close > 0 && !/^(---|\.\.\.)\s*$/.test(lines[close])) close--;
    lines.splice(close, 0, line);
  }
  return lines.join(nl) + text.slice(fm.length);
}

/** Which slide a character offset in the markdown falls in (for editor ↔ preview sync). */
export function slideAt(deck, offset) {
  let index = 0;
  for (const s of deck.slides) {
    if (offset >= s.start - (s.sep?.length || 0)) index = s.index;
  }
  return index;
}

// --- checks ---------------------------------------------------------------------

export const RELAY_DECK_BYTES = 120 * 1024;   // MAX_DECK_BYTES in control.js

/**
 * What could go wrong in class, found from the markdown alone. The editor adds
 * what only rendering can tell it (theme, fit, builds - see deck-editor.js).
 *
 * @param {string} md
 * @param {object} [opts]
 * @param {'library'|'content'|'file'|'plan'} [opts.destination] - where it will be saved
 * @param {string} [opts.pageProtocol] - 'https:' to flag http: media
 * @returns {{slide: number, offset: number, severity: 'warning'|'info', message: string}[]}
 */
export function checkDeck(md, { destination = 'file', pageProtocol = '' } = {}) {
  const text = String(md ?? '');
  const deck = parseDeck(text);
  const out = [];
  const add = (slide, offset, severity, message) => out.push({ slide, offset, severity, message });

  for (const slide of deck.slides) {
    const base = slide.start;
    for (const m of slide.media) {
      const at = base + m.start;
      const src = m.src;
      if (/^data:/i.test(src)) {
        add(slide.index, at, 'warning', 'A picture pasted into the deck itself makes it too big to send to the projector. Add it from the library instead.');
      } else if (/^asset:/i.test(src) && (destination === 'library' || destination === 'content')) {
        add(slide.index, at, 'warning', 'This picture is kept inside a lecture plan, where a deck saved here cannot reach it. Add it again from the library.');
      } else if (!/^(https?:|\/|asset:|#)/i.test(src)) {
        if (destination === 'library') add(slide.index, at, 'warning', `"${src}" is a relative path, which does not resolve for a deck in the library. Use the picture's full address.`);
      }
      if (pageProtocol === 'https:' && /^http:/i.test(src)) {
        add(slide.index, at, 'warning', `"${src}" is http:, which an https: page will not load.`);
      }
      if (!m.background && !(m.alt || '').trim()) {
        add(slide.index, at, 'info', 'This picture has no description (alt text) for screen readers and Guest View.');
      }
    }
    if (slide.video) {
      const at = base + Math.max(0, slide.raw.indexOf(slide.video.src));
      const src = slide.video.src;
      if (!/^(https?:|\/)/i.test(src)) {
        add(slide.index, at, 'warning', `The video "${src}" is not a full address, so the projector cannot find it. Add it from the library instead.`);
      } else if (pageProtocol === 'https:' && /^http:/i.test(src)) {
        add(slide.index, at, 'warning', `The video "${src}" is http:, which an https: page will not load.`);
      }
      if (!slide.media.some((m) => m.background)) {
        add(slide.index, at, 'warning', 'This video slide has no poster (a background picture), so its thumbnail, its slide photo and what shows before Play are all blank.');
      }
    }
    const fences = (maskCodeFenceCount(slide.raw));
    if (fences % 2) add(slide.index, base, 'warning', 'A code block on this slide is never closed (```), so the rest of the deck is swallowed into it.');
  }
  const bytes = new TextEncoder().encode(text).length;
  // A file may be sent from a controller, and a deck inside a plan always
  // crosses the relay to reach the projector; library and content decks are
  // fetched from the server and have no such limit.
  if ((destination === 'file' || destination === 'plan') && bytes > RELAY_DECK_BYTES) {
    add(0, 0, 'info', `This deck is ${Math.round(bytes / 1024)} KB. Sent from a controller it must be under ${RELAY_DECK_BYTES / 1024} KB; from the library or the server it can be any size.`);
  }
  if (deck.headingDivider) {
    add(0, 0, 'info', 'This deck splits slides on headings (headingDivider), so moving and inserting slides is turned off here. Edit the text directly.');
  }
  return out;
}

function maskCodeFenceCount(raw) {
  let n = 0;
  let fence = null;
  for (const line of linesOf(raw)) {
    const t = bare(line);
    const f = FENCE.exec(t);
    if (!f) continue;
    if (!fence) { fence = f[1]; n++; } else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^\s*$/.test(t.slice(f[0].length))) { fence = null; n++; }
  }
  return n;
}
