// A minimal ZIP writer: STORED (uncompressed) entries only.
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
