// Diagrams in the deck editor (Issue #235, phase 2): starting one, bringing
// one in from mermaid.live, and taking one back out there.
//
// mermaid.live keeps a whole diagram in its address, after `#pako:` - the
// editor's state as JSON, zlib-deflated, in URL-safe base64 - so a link is the
// diagram, and reading it needs no network at all: the browser's own
// DecompressionStream undoes it. (`#base64:`, the older form, is the same
// JSON uncompressed.) mermaid.ink's picture links carry the same thing after
// /img/ or /svg/.
//
// Pure apart from (De)CompressionStream, so it runs in Node too.

import { parseDeck, mermaidFences, MERMAID_THEMES } from './deck-source.js';

const FENCE_OPEN = '```mermaid\n';
const FENCE_CLOSE = '```\n';

/** Diagrams to start from: the ◇ Diagram menu. Each is plain Mermaid, short enough to read at a glance. */
export const STARTERS = [
  {
    id: 'flowchart', label: 'Flowchart', text: [
      'flowchart LR',
      '  A[Start] --> B{A question?}',
      '  B -->|Yes| C[One way]',
      '  B -->|No| D[Another way]',
    ],
  },
  {
    id: 'sequence', label: 'Sequence', text: [
      'sequenceDiagram',
      '  participant S as Student',
      '  participant T as Teacher',
      '  S->>T: Asks a question',
      '  T-->>S: Answers it',
    ],
  },
  {
    id: 'class', label: 'Class', text: [
      'classDiagram',
      '  Animal <|-- Dog',
      '  Animal : +String name',
      '  Dog : +bark()',
    ],
  },
  {
    id: 'state', label: 'State', text: [
      'stateDiagram-v2',
      '  [*] --> Idea',
      '  Idea --> Draft',
      '  Draft --> Final',
      '  Final --> [*]',
    ],
  },
  {
    id: 'gantt', label: 'Timeline of work (Gantt)', text: [
      'gantt',
      '  title Term plan',
      '  dateFormat YYYY-MM-DD',
      '  section Reading',
      '    Chapters 1-3 :a1, 2026-01-12, 14d',
      '  section Writing',
      '    Essay draft  :after a1, 14d',
    ],
  },
  {
    id: 'pie', label: 'Pie chart', text: [
      'pie title How class time is spent',
      '  "Talk" : 40',
      '  "Discussion" : 35',
      '  "Activity" : 25',
    ],
  },
  {
    id: 'mindmap', label: 'Mind map', text: [
      'mindmap',
      '  root((Topic))',
      '    First idea',
      '    Second idea',
      '      A detail',
      '    Third idea',
    ],
  },
  {
    id: 'timeline', label: 'Timeline', text: [
      'timeline',
      '  title Key dates',
      '  1879 : First psychology lab',
      '  1913 : Behaviourism',
      '  1956 : The cognitive revolution',
    ],
  },
];

/** A whole ```mermaid block for a starter (or for diagram text). */
export function fenceFor(text) {
  const body = String(text).replace(/\s*$/, '\n');
  return `${FENCE_OPEN}${body}${FENCE_CLOSE}`;
}

export function starterFence(id) {
  const starter = STARTERS.find((s) => s.id === id);
  return starter ? fenceFor(starter.text.join('\n')) : null;
}

// --- mermaid.live links ------------------------------------------------------------

const LIVE_LINK = /^https?:\/\/(?:mermaid\.live\/(?:edit|view)\/?#|mermaid\.ink\/(?:img|svg|pdf)\/)((?:pako|base64):[A-Za-z0-9+/_=-]+)(?:[?#].*)?$/;

/** Whether this text is (just) a mermaid.live or mermaid.ink link to a diagram. */
export function isMermaidLiveLink(text) {
  return LIVE_LINK.test(String(text || '').trim());
}

function base64ToBytes(text) {
  let b64 = String(text).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  b64 += '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pipe(bytes, stream) {
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

/**
 * The diagram in a mermaid.live link: its code, and the theme it was set to
 * there (null for Mermaid's default, which a deck replaces with its own look).
 * Null if the link holds no diagram this can read.
 *
 * @returns {Promise<{code: string, theme: string|null}|null>}
 */
export async function readMermaidLiveLink(url) {
  const m = LIVE_LINK.exec(String(url || '').trim());
  if (!m) return null;
  const [kind, data] = [m[1].slice(0, m[1].indexOf(':')), m[1].slice(m[1].indexOf(':') + 1)];
  try {
    const bytes = base64ToBytes(data);
    const json = kind === 'pako'
      ? new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate')))
      : new TextDecoder().decode(bytes);
    const state = JSON.parse(json);
    if (typeof state?.code !== 'string' || !state.code.trim()) return null;
    let theme = null;
    try {
      const config = typeof state.mermaid === 'string' ? JSON.parse(state.mermaid) : state.mermaid;
      if (MERMAID_THEMES.includes(config?.theme) && config.theme !== 'default') theme = config.theme;
    } catch { /* a config that is not JSON says nothing about the theme */ }
    return { code: state.code.replace(/\r\n/g, '\n'), theme };
  } catch {
    return null;
  }
}

/** Whether diagram text already says its own theme, at its top. */
function setsOwnConfig(code) {
  const first = String(code).split('\n').find((l) => l.trim()) || '';
  return /^\s*%%\{\s*init/.test(first) || /^\s*---\s*$/.test(first);
}

/**
 * The ```mermaid block for a diagram read from a link. A theme chosen in
 * mermaid.live goes at the diagram's top, so it looks the same in the deck;
 * one left at Mermaid's default follows the deck like any other diagram.
 */
export function fenceFromLink({ code, theme }) {
  const lead = theme && !setsOwnConfig(code) ? `%%{init: {"theme": "${theme}"}}%%\n` : '';
  return fenceFor(`${lead}${code}`);
}

/**
 * A mermaid.live link that opens this diagram for editing there. The link
 * holds the diagram itself (after #, which is never sent to the site), so
 * this needs no network to make.
 */
export async function mermaidLiveLink(code, { theme = 'default' } = {}) {
  const state = {
    code: String(code).replace(/\s*$/, '\n'),
    mermaid: JSON.stringify({ theme: MERMAID_THEMES.includes(theme) ? theme : 'default' }, null, 2),
    autoSync: true,
    updateDiagram: true,
    rough: false,
    panZoom: true,
  };
  const bytes = await pipe(new TextEncoder().encode(JSON.stringify(state)), new CompressionStream('deflate'));
  return `https://mermaid.live/edit#pako:${bytesToBase64Url(bytes)}`;
}

/**
 * The ```mermaid block the cursor is in, anywhere from its opening line to
 * its closing one: its diagram text, and which diagram of the deck it is.
 */
export function fenceAt(md, pos) {
  const text = String(md ?? '');
  const deck = parseDeck(text);
  let index = 0;
  for (const slide of deck.slides) {
    for (const f of mermaidFences(slide.raw)) {
      const from = slide.start + f.start;
      const to = f.end === null ? slide.end : slide.start + f.end;
      if (pos >= from && pos <= to) return { from, to, body: f.body, slide: slide.index, index };
      index++;
    }
  }
  return null;
}

// --- colouring the diagram text in the code editor --------------------------------

const DIAGRAM_TYPES = /^(?:graph|flowchart|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|gantt|pie|mindmap|timeline|journey|gitGraph|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|kanban|[a-z]+-beta|zenuml)\b/;
const WORDS = /^(?:participant|actor|note|over|left of|right of|loop|alt|else|opt|par|and|critical|break|rect|end|subgraph|direction|class|classDef|style|linkStyle|click|title|section|dateFormat|axisFormat|excludes|state|as|activate|deactivate|autonumber|accTitle|accDescr|TB|TD|BT|LR|RL)\b/;
const ARROW = /^(?:<<?-->>?|<?--?>>?|<?-\.+->?|<?==+>|-->|---|-\)|--x|-x|--o|<\|--|\*--|o--|\.\.>|\.\.\||x--x|o--o|<-->|~~~|-->>|->>|->|--)/;

/**
 * A CodeMirror stream parser for Mermaid, for the editor to colour a
 * ```mermaid block's text: diagram types and keywords, arrows, strings,
 * comments and %%{init}%% lines. Plain colouring, not a grammar.
 */
export const mermaidStreamParser = {
  name: 'mermaid',
  startState: () => ({ lineStart: true }),
  token(stream, state) {
    if (stream.sol()) state.lineStart = true;
    if (stream.eatSpace()) return null;
    const first = state.lineStart;
    state.lineStart = false;
    if (stream.match(/^%%\{.*\}%%/)) return 'meta';
    if (stream.match(/^%%.*/)) return 'comment';
    if (first && stream.match(DIAGRAM_TYPES)) return 'keyword';
    if (stream.match(WORDS)) return 'keyword';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string';
    if (stream.match(ARROW)) return 'operator';
    if (stream.match(/^\|[^|]*\|/)) return 'string';
    if (stream.match(/^\d+(?:\.\d+)?%?/)) return 'number';
    if (stream.match(/^[[\](){}]+/)) return 'bracket';
    if (stream.match(/^[\w-]+/)) return 'variableName';
    stream.next();
    return null;
  },
};
