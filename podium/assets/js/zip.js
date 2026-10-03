// A minimal ZIP writer (STORED, uncompressed, entries only), and a reader.
//
// Exporting marked-up slides is a once-per-lecture action producing a dozen
// PNGs that are already compressed as images, so the space deflate would save
// is negligible - not worth vendoring a compression library for. This file is
// standalone and dependency-free.

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// MS-DOS date/time packed into 16+16 bits, as the ZIP format requires. Any
// timestamp is legal here; the value has no effect on how the archive opens.
function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980 & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

const u16 = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const concat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
};

/**
 * Build a ZIP file from a list of { name, data } entries. `data` is anything
 * `new Blob([data])` accepts (Uint8Array, ArrayBuffer, Blob, string).
 * Returns a Blob with the archive.
 */
export async function createZip(files) {
  const enc = new TextEncoder();
  const { time, day } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = new Uint8Array(await new Blob([file.data]).arrayBuffer());
    const crc = crc32(data);

    const localHeader = concat(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
    );
    localParts.push(localHeader, nameBytes, data);

    const centralHeader = concat(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset),
    );
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const central = concat(...centralParts);
  const end = concat(
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(central.length), u32(centralStart), u16(0),
  );

  return new Blob([...localParts, central, end], { type: 'application/zip' });
}

// --- reading -------------------------------------------------------------------
//
// The deck editor opens a deck's .zip (Issue #226): its markdown and the
// pictures beside it. Stored and deflated entries - what every zip tool
// writes - the second through the browser's own DecompressionStream, so this
// file still vendors no compression library.

const MAX_ENTRIES = 2000;

/**
 * The files in a ZIP, each with a `read()` for its bytes. Folders are left
 * out. Throws for something that is not a ZIP.
 *
 * @param {Blob} blob
 * @returns {Promise<{name: string, size: number, read: () => Promise<Uint8Array>}[]>}
 */
export async function readZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('that is not a .zip file');
  const count = view.getUint16(end + 10, true);
  if (count > MAX_ENTRIES) throw new Error(`that .zip holds more than ${MAX_ENTRIES} files`);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || view.getUint32(at, true) !== 0x02014b50) throw new Error('that .zip is damaged');
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(buf.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (local + 30 > buf.length || view.getUint32(local, true) !== 0x04034b50) throw new Error('that .zip is damaged');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + packed);
    files.push({
      name,
      size,
      async read() {
        if (method === 0) return raw.slice();
        if (method === 8 && typeof DecompressionStream === 'function') {
          const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          return new Uint8Array(await new Response(stream).arrayBuffer());
        }
        throw new Error(`${name} is packed in a way this browser cannot open`);
      },
    });
  }
  return files;
}
