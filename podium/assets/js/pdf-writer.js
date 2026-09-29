// podium/assets/js/pdf-writer.js
// Standalone, dependency-free client-side PDF document compiler and session exporter.

/**
 * Escape a text string for PDF literal strings in parentheses.
 */
function escapePdfText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * Format date for PDF metadata (D:YYYYMMDDHHmmSS).
 */
function formatPdfDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const yr = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const hr = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const se = pad(d.getUTCSeconds());
  return `D:${yr}${mo}${da}${hr}${mi}${se}Z`;
}

/**
 * Concatenate multiple Uint8Array chunks into a single Uint8Array.
 */
function concatUint8Arrays(...arrays) {
  const totalLength = arrays.reduce((acc, curr) => acc + curr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Compile a multi-page PDF document from an array of JPEG page images.
 * @param {Array<{ width: number, height: number, data: Uint8Array }>} pages
 * @param {Object} [meta]
 * @returns {Blob} application/pdf Blob
 */
export function createPdf(pages, meta = {}) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [0]; // offsets[objId] = byte offset

  let currentOffset = 0;
  function writeChunk(chunk) {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    chunks.push(bytes);
    currentOffset += bytes.length;
  }

  // 1. PDF Header
  writeChunk('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const pageCount = pages.length;
  const pageObjectIds = [];
  // Object IDs:
  // 1: Catalog
  // 2: Pages
  // For page i (0 to pageCount - 1):
  //   pageObjId = 3 + i * 3
  //   contentObjId = 3 + i * 3 + 1
  //   imgObjId = 3 + i * 3 + 2
  // infoObjId = 3 + pageCount * 3

  for (let i = 0; i < pageCount; i++) {
    pageObjectIds.push(3 + i * 3);
  }
  const infoObjId = 3 + pageCount * 3;

  // 2. Catalog (Obj 1)
  offsets[1] = currentOffset;
  writeChunk('1 0 obj\n<<\n  /Type /Catalog\n  /Pages 2 0 R\n>>\nendobj\n');

  // 3. Pages Root (Obj 2)
  offsets[2] = currentOffset;
  const kidsStr = pageObjectIds.map((id) => `${id} 0 R`).join(' ');
  writeChunk(`2 0 obj\n<<\n  /Type /Pages\n  /Kids [${kidsStr}]\n  /Count ${pageCount}\n>>\nendobj\n`);

  // 4. Page Objects, Content Streams, and Image XObjects
  for (let i = 0; i < pageCount; i++) {
    const page = pages[i];
    const pageObjId = 3 + i * 3;
    const contentObjId = pageObjId + 1;
    const imgObjId = pageObjId + 2;

    const aspect = page.height ? page.width / page.height : 16 / 9;
    const widthPt = 792; // 11 inches at 72 dpi (Letter width)
    const heightPt = Math.round(widthPt / aspect);

    // Page Object
    offsets[pageObjId] = currentOffset;
    writeChunk(
      `${pageObjId} 0 obj\n` +
      `<<\n` +
      `  /Type /Page\n` +
      `  /Parent 2 0 R\n` +
      `  /MediaBox [0 0 ${widthPt} ${heightPt}]\n` +
      `  /Contents ${contentObjId} 0 R\n` +
      `  /Resources <<\n` +
      `    /XObject << /Im1 ${imgObjId} 0 R >>\n` +
      `    /ProcSet [/PDF /ImageC]\n` +
      `  >>\n` +
      `>>\n` +
      `endobj\n`
    );

    // Content Stream
    const streamContent = `q\n${widthPt} 0 0 ${heightPt} 0 0 cm\n/Im1 Do\nQ\n`;
    const streamBytes = encoder.encode(streamContent);
    offsets[contentObjId] = currentOffset;
    writeChunk(
      `${contentObjId} 0 obj\n` +
      `<<\n` +
      `  /Length ${streamBytes.length}\n` +
      `>>\n` +
      `stream\n`
    );
    writeChunk(streamBytes);
    writeChunk('\nendstream\nendobj\n');

    // Image XObject (JPEG via DCTDecode)
    const imgBytes = page.data instanceof Uint8Array ? page.data : new Uint8Array(page.data);
    offsets[imgObjId] = currentOffset;
    writeChunk(
      `${imgObjId} 0 obj\n` +
      `<<\n` +
      `  /Type /XObject\n` +
      `  /Subtype /Image\n` +
      `  /Width ${page.width}\n` +
      `  /Height ${page.height}\n` +
      `  /ColorSpace /DeviceRGB\n` +
      `  /BitsPerComponent 8\n` +
      `  /Filter /DCTDecode\n` +
      `  /Length ${imgBytes.length}\n` +
      `>>\n` +
      `stream\n`
    );
    writeChunk(imgBytes);
    writeChunk('\nendstream\nendobj\n');
  }

  // 5. Info Dictionary
  offsets[infoObjId] = currentOffset;
  const title = escapePdfText(meta.title || 'Podium Lecture Notes');
  const creationDate = formatPdfDate(meta.date || new Date());
  writeChunk(
    `${infoObjId} 0 obj\n` +
    `<<\n` +
    `  /Title (${title})\n` +
    `  /Author (Podium)\n` +
    `  /Producer (Podium PDF Exporter)\n` +
    `  /CreationDate (${creationDate})\n` +
    `>>\n` +
    `endobj\n`
  );

  // 6. Cross-Reference Table
  const startXref = currentOffset;
  const totalObjects = infoObjId; // obj 0 to infoObjId
  writeChunk(`xref\n0 ${totalObjects + 1}\n`);
  writeChunk('0000000000 65535 f \n');
  for (let id = 1; id <= totalObjects; id++) {
    const offsetStr = String(offsets[id] || 0).padStart(10, '0');
    writeChunk(`${offsetStr} 00000 n \n`);
  }

  // 7. Trailer
  writeChunk(
    `trailer\n` +
    `<<\n` +
    `  /Size ${totalObjects + 1}\n` +
    `  /Root 1 0 R\n` +
    `  /Info ${infoObjId} 0 R\n` +
    `>>\n` +
    `startxref\n` +
    `${startXref}\n` +
    `%%EOF\n`
  );

  const fullPdf = concatUint8Arrays(...chunks);
  return new Blob([fullPdf], { type: 'application/pdf' });
}

/**
 * Render a visual page with header metadata and centered image onto canvas, returning JPEG bytes.
 * @param {HTMLImageElement|ImageBitmap|HTMLCanvasElement} img
 * @param {Object} meta { title, course, room, date, itemTitle, itemType, itemNote }
 * @param {number} pageNum
 * @param {number} totalPages
 * @returns {Promise<{ width: number, height: number, data: Uint8Array }>}
 */
export async function renderSessionPageToJpeg(img, meta, pageNum, totalPages) {
  const width = 1920;
  const height = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0f172a'; // Slate 900
  ctx.fillRect(0, 0, width, height);

  // Header Banner
  ctx.fillStyle = '#1e293b'; // Slate 800
  ctx.fillRect(0, 0, width, 110);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 110);
  ctx.lineTo(width, 110);
  ctx.stroke();

  // Header Text - Left
  ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#f8fafc';
  const mainTitle = meta.title || meta.room || 'Podium Session';
  ctx.fillText(mainTitle, 40, 48);

  ctx.font = '18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#94a3b8';
  const metaBits = [
    meta.course ? meta.course.toUpperCase() : '',
    meta.room ? `Room: ${meta.room}` : '',
    meta.date ? (typeof meta.date === 'string' || typeof meta.date === 'number' ? new Date(meta.date).toLocaleString() : meta.date.toLocaleString()) : '',
  ].filter(Boolean);
  ctx.fillText(metaBits.join('  ·  '), 40, 86);

  // Header Text - Right
  ctx.textAlign = 'right';
  ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#38bdf8'; // Sky 400
  const rightTitle = meta.itemTitle || meta.itemType || 'Slide';
  ctx.fillText(rightTitle, width - 40, 48);

  if (meta.itemNote) {
    ctx.font = '17px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(meta.itemNote, width - 40, 86);
  }
  ctx.textAlign = 'left';

  // Main Content Area (40, 130, 1840, 880)
  const areaX = 40;
  const areaY = 130;
  const areaW = 1840;
  const areaH = 880;

  const imgW = img.width || img.naturalWidth || areaW;
  const imgH = img.height || img.naturalHeight || areaH;
  const scale = Math.min(areaW / imgW, areaH / imgH);
  const drawW = Math.round(imgW * scale);
  const drawH = Math.round(imgH * scale);
  const drawX = Math.round(areaX + (areaW - drawW) / 2);
  const drawY = Math.round(areaY + (areaH - drawH) / 2);

  // Frame background
  ctx.fillStyle = '#000000';
  ctx.fillRect(drawX, drawY, drawW, drawH);
  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  // Frame border
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(drawX, drawY, drawW, drawH);

  // Footer Bar
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 1030);
  ctx.lineTo(width, 1030);
  ctx.stroke();

  ctx.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Podium  ·  Lecture Notes', 40, 1058);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`Page ${pageNum} of ${totalPages}`, width - 40, 1058);
  ctx.textAlign = 'left';

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.90));
  const data = new Uint8Array(await blob.arrayBuffer());
  return { width, height, data };
}

/**
 * Render a poll results summary page onto canvas, returning JPEG bytes.
 * @param {Object} poll
 * @param {Object} meta
 * @param {number} pageNum
 * @param {number} totalPages
 * @returns {Promise<{ width: number, height: number, data: Uint8Array }>}
 */
export async function renderPollPageToJpeg(poll, meta, pageNum, totalPages) {
  const width = 1920;
  const height = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  // Header Banner
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, width, 110);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, 110);
  ctx.lineTo(width, 110);
  ctx.stroke();

  // Header Text - Left
  ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(meta.title || meta.room || 'Podium Session', 40, 48);

  ctx.font = '18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#94a3b8';
  const metaBits = [
    meta.course ? meta.course.toUpperCase() : '',
    meta.room ? `Room: ${meta.room}` : '',
    meta.date ? (typeof meta.date === 'string' || typeof meta.date === 'number' ? new Date(meta.date).toLocaleString() : meta.date.toLocaleString()) : '',
  ].filter(Boolean);
  ctx.fillText(metaBits.join('  ·  '), 40, 86);

  // Header Text - Right
  ctx.textAlign = 'right';
  ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#a855f7'; // Purple 500
  ctx.fillText('Live Poll Results', width - 40, 48);

  ctx.font = '17px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#94a3b8';
  const voterCount = poll.voters != null ? `${poll.voters} voter${poll.voters === 1 ? '' : 's'}` : '';
  ctx.fillText(voterCount, width - 40, 86);
  ctx.textAlign = 'left';

  // Question Title
  ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(poll.question || 'Poll', 80, 190);

  // Render Multiple Choice Options or Free Text
  const options = poll.options || [];
  const counts = poll.counts || [];
  const totalVotes = counts.reduce((sum, v) => sum + (v || 0), 0) || (poll.voters || 1);

  if (poll.kind === 'text' || (!options.length && poll.answers)) {
    // Open text answers
    const answers = poll.answers || [];
    const startY = 240;
    const cardWidth = 560;
    const cardHeight = 90;
    const cols = 3;
    const gap = 20;

    answers.slice(0, 18).forEach((ans, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = 80 + col * (cardWidth + gap);
      const y = startY + row * (cardHeight + gap);

      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.roundRect(x, y, cardWidth, cardHeight, 10);
      ctx.fill();
      ctx.strokeStyle = '#334155';
      ctx.stroke();

      const respName = poll.responses?.[i]?.name;
      if (respName) {
        ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#38bdf8';
        ctx.fillText(respName, x + 20, y + 36);

        ctx.font = '18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#f1f5f9';
        ctx.fillText(String(ans).slice(0, 50), x + 20, y + 66);
      } else {
        ctx.font = '20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = '#f1f5f9';
        ctx.fillText(String(ans).slice(0, 60), x + 20, y + 52);
      }
    });
  } else {
    // Bar chart options
    const startY = 240;
    const maxBarW = 1760;
    const barHeight = 80;
    const spacing = 28;

    options.forEach((opt, i) => {
      const y = startY + i * (barHeight + spacing);
      if (y + barHeight > 1000) return;

      const count = counts[i] || 0;
      const pct = Math.round((count / (totalVotes || 1)) * 100);

      // Card Background
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.roundRect(80, y, maxBarW, barHeight, 12);
      ctx.fill();

      // Filled progress bar
      if (pct > 0) {
        ctx.fillStyle = '#38bdf8';
        const fillW = Math.max(16, Math.round((maxBarW * pct) / 100));
        ctx.beginPath();
        ctx.roundRect(80, y, fillW, barHeight, 12);
        ctx.fill();
      }

      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Text inside / beside bar
      ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(opt, 110, y + 48);

      ctx.textAlign = 'right';
      ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(`${count} (${pct}%)`, 80 + maxBarW - 30, y + 48);
      ctx.textAlign = 'left';
    });
  }

  // Footer Bar
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 1030);
  ctx.lineTo(width, 1030);
  ctx.stroke();

  ctx.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Podium  ·  Lecture Notes', 40, 1058);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`Page ${pageNum} of ${totalPages}`, width - 40, 1058);
  ctx.textAlign = 'left';

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.90));
  const data = new Uint8Array(await blob.arrayBuffer());
  return { width, height, data };
}

/**
 * Load an image from a data URL, Blob, or URL into an HTMLImageElement.
 */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image for PDF export'));
    if (src instanceof Blob) {
      const url = URL.createObjectURL(src);
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.src = url;
    } else {
      img.src = src;
    }
  });
}

// --- the lecture recap (Issue #158) ------------------------------------------
//
// The same 1920x1080 page, header and footer as the two renderers above, with
// one new kind of page: text - the timeline's entries in order, each followed
// by the caption lines said while it was up. Pictures and polls reuse
// renderSessionPageToJpeg and renderPollPageToJpeg exactly as they are.
//
// Laid out in two passes, because every page's footer says "Page n of N":
// planRecapPages decides what goes on which page (measuring text with
// whatever `measure` it is handed, so it can be tested without a canvas), and
// renderRecapPages draws them once the total is known.

const RECAP_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
export const RECAP_STYLE = {
  top: 140, bottom: 1010, left: 80, right: 1840,
  heading: { font: `bold 30px ${RECAP_FONT}`, size: 30, height: 46 },
  note: { font: `20px ${RECAP_FONT}`, size: 20, height: 30 },
  caption: { font: `24px ${RECAP_FONT}`, size: 24, height: 34, indent: 110 },
  gap: 18,
};

/**
 * Split text into lines no wider than maxWidth. A single word wider than the
 * line (a URL, say) is broken by characters rather than left to run off the
 * page.
 * @param {(text: string) => number} measure
 */
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  let line = '';
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    const tryLine = line ? `${line} ${word}` : word;
    if (measure(tryLine) <= maxWidth) { line = tryLine; continue; }
    if (line) lines.push(line);
    if (measure(word) <= maxWidth) { line = word; continue; }
    let piece = '';
    for (const ch of word) {
      if (measure(piece + ch) > maxWidth && piece) { lines.push(piece); piece = ''; }
      piece += ch;
    }
    line = piece;
  }
  if (line) lines.push(line);
  return lines;
}

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * Decide every page of a recap, in order, without drawing anything.
 * @param {{ blocks: object[], extras: object[] }} recap - from buildRecap (recap.js)
 * @param {(text: string, font: string) => number} measure
 * @param {{ summary?: string }} [options]
 * @returns {Array<{ kind: 'text', rows: object[] } | { kind: 'picture', file: object, title: string, note: string } | { kind: 'poll', poll: object }>}
 */
export function planRecapPages(recap, measure, { summary = '' } = {}) {
  const S = RECAP_STYLE;
  const pages = [];
  let rows = [];
  let y = S.top;
  // The heading the rows being added belong to, so a block that runs over a
  // page break can say whose captions the next page carries on with.
  let heading = null;

  const flush = () => {
    if (rows.length) pages.push({ kind: 'text', rows });
    rows = [];
    y = S.top;
  };
  const add = (row, height) => {
    if (y + height > S.bottom && rows.length) {
      flush();
      if (heading && row.style === 'caption') {
        rows.push({ style: 'continued', text: `${heading} (continued)`, y });
        y += S.note.height;
      }
    }
    rows.push({ ...row, y });
    y += height;
  };
  const addWrapped = (style, text, extra, indent = 0) => {
    const width = S.right - S.left - indent;
    for (const [i, line] of wrapText(text, width, (t) => measure(t, style.font)).entries()) {
      add({ ...extra, text: line, first: i === 0 }, style.height);
    }
  };
  const addCaptions = (captions) => {
    for (const caption of captions) {
      addWrapped(S.caption, caption.text, { style: 'caption', at: caption.at }, S.caption.indent);
    }
  };

  if (summary) { addWrapped(S.note, summary, { style: 'summary' }); y += S.gap; }

  for (const block of recap.blocks) {
    if (block.type === 'poll') {
      flush();
      pages.push({ kind: 'poll', poll: block.poll });
      if (block.captions.length) {
        heading = `Poll: ${block.poll.question || 'Poll'}`;
        addWrapped(S.heading, heading, { style: 'poll', at: block.at });
        addCaptions(block.captions);
        y += S.gap;
      }
      continue;
    }
    // Never strand a heading alone at the foot of a page with its first
    // caption over the leaf: start a new page if both do not fit.
    const needed = S.heading.height + (block.note ? S.note.height : 0) + (block.captions.length ? S.caption.height : 0);
    if (y + needed > S.bottom && rows.length) flush();
    heading = block.title;
    addWrapped(S.heading, block.title, { style: block.type === 'opening' ? 'opening' : 'heading', at: block.at });
    if (block.note) addWrapped(S.note, block.note, { style: 'note' });
    addCaptions(block.captions);
    y += S.gap;
    if (block.images?.length) {
      flush();
      for (const file of block.images) pages.push({ kind: 'picture', file, title: block.title, note: block.note });
    }
  }
  flush();
  for (const file of recap.extras || []) pages.push({ kind: 'picture', file, title: '', note: '' });
  return pages;
}

function drawRecapFrame(ctx, meta, pageNum, totalPages, rightTitle) {
  const width = 1920;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, 1080);
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, width, 110);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, 110); ctx.lineTo(width, 110); ctx.stroke();

  ctx.font = `bold 28px ${RECAP_FONT}`;
  ctx.fillStyle = '#f8fafc';
  ctx.fillText(meta.title || meta.room || 'Podium Session', 40, 48);
  ctx.font = `18px ${RECAP_FONT}`;
  ctx.fillStyle = '#94a3b8';
  const metaBits = [
    meta.course ? meta.course.toUpperCase() : '',
    meta.room ? `Room: ${meta.room}` : '',
    meta.date ? new Date(meta.date).toLocaleString() : '',
  ].filter(Boolean);
  ctx.fillText(metaBits.join('  ·  '), 40, 86);

  ctx.textAlign = 'right';
  ctx.font = `bold 22px ${RECAP_FONT}`;
  ctx.fillStyle = '#38bdf8';
  ctx.fillText(rightTitle, width - 40, 48);
  ctx.textAlign = 'left';

  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, 1030); ctx.lineTo(width, 1030); ctx.stroke();
  ctx.font = `16px ${RECAP_FONT}`;
  // #94a3b8, as on the other two pages: the #64748b they used to use is
  // 3.75:1 on this background, under WCAG AA for text this size (Issue #156).
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Podium  ·  Lecture Recap', 40, 1058);
  ctx.textAlign = 'right';
  ctx.fillText(`Page ${pageNum} of ${totalPages}`, width - 40, 1058);
  ctx.textAlign = 'left';
}

async function renderRecapTextPage(page, meta, pageNum, totalPages) {
  const S = RECAP_STYLE;
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext('2d');
  drawRecapFrame(ctx, meta, pageNum, totalPages, 'Lecture recap');
  ctx.textBaseline = 'top';
  for (const row of page.rows) {
    if (row.style === 'heading' || row.style === 'opening' || row.style === 'poll') {
      ctx.font = S.heading.font;
      ctx.fillStyle = row.style === 'poll' ? '#c084fc' : row.style === 'opening' ? '#cbd5e1' : '#f8fafc';
      ctx.fillText(row.text, S.left, row.y + 6);
      if (row.first && row.at) {
        ctx.textAlign = 'right';
        ctx.font = S.note.font;
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(hhmm(row.at), S.right, row.y + 12);
        ctx.textAlign = 'left';
      }
    } else if (row.style === 'note' || row.style === 'summary' || row.style === 'continued') {
      ctx.font = S.note.font;
      ctx.fillStyle = row.style === 'note' ? '#94a3b8' : '#cbd5e1';
      ctx.fillText(row.text, S.left, row.y + 4);
    } else if (row.style === 'caption') {
      if (row.first && row.at) {
        ctx.font = S.note.font;
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(hhmm(row.at), S.left + 20, row.y + 6);
      }
      ctx.font = S.caption.font;
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(row.text, S.left + S.caption.indent, row.y + 4);
    }
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return { width: 1920, height: 1080, data: new Uint8Array(await blob.arrayBuffer()) };
}

/**
 * Draw a planned recap into JPEG pages for createPdf.
 * @param {object[]} plan - from planRecapPages
 * @param {object} meta - { title, course, room, date }
 * @param {object} io
 * @param {(file: object) => Promise<HTMLImageElement|null>} io.loadPicture - null skips that page
 * @param {(done: number, total: number) => void} [io.onProgress]
 */
export async function renderRecapPages(plan, meta, { loadPicture, onProgress = () => {} }) {
  // Pictures are fetched first so a file that will not load is dropped before
  // anything is numbered - otherwise the footers would count a page that is
  // not there.
  const pictures = new Map();
  for (const page of plan) {
    if (page.kind !== 'picture') continue;
    const img = await loadPicture(page.file).catch(() => null);
    if (img) pictures.set(page, img);
  }
  const kept = plan.filter((page) => page.kind !== 'picture' || pictures.has(page));
  const out = [];
  for (const [i, page] of kept.entries()) {
    onProgress(i + 1, kept.length);
    if (page.kind === 'text') out.push(await renderRecapTextPage(page, meta, i + 1, kept.length));
    else if (page.kind === 'poll') out.push(await renderPollPageToJpeg(page.poll, meta, i + 1, kept.length));
    else {
      const label = page.file.name.startsWith('photos/') ? 'Photo'
        : page.file.name.startsWith('boards/') ? 'Board' : 'Annotated slide';
      out.push(await renderSessionPageToJpeg(pictures.get(page),
        { ...meta, itemTitle: page.title || label, itemType: label, itemNote: page.note || page.file.name },
        i + 1, kept.length));
    }
  }
  return out;
}
