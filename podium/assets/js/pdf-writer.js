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
  ctx.fillStyle = '#64748b';
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

      ctx.font = '20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = '#f1f5f9';
      ctx.fillText(String(ans).slice(0, 60), x + 20, y + 52);
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
  ctx.fillStyle = '#64748b';
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
    img.onerror = (err) => reject(new Error('Failed to load image for PDF export'));
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
