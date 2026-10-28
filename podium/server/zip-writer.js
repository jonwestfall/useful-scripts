// A ZIP written straight onto a response, a file at a time.
//
// A backup of a course, or of the whole server, can be many gigabytes: far
// more than is sensible to build in memory first (the browser's own zip.js
// does exactly that, which is fine for a dozen exported slides). So this
// writes each entry as it goes, waiting for the network when it is slower
// than the disk, and keeps only the central directory - a few dozen bytes an
// entry - until the end.
//
// Every entry's CRC and sizes are in its local header, never in a trailing
// data descriptor. Working out the CRC first means reading a file twice (the
// second read almost always comes from the page cache), and buys an archive
// every unzip tool opens, including the ones that read a ZIP front to back
// and choke on a stored entry whose size they were not told.
//
// ZIP64 where it is needed: an archive past 4 GB, an entry past 4 GB (a long
// screen recording), or more than 65,535 entries. Nowhere else, so a small
// backup is a plain ZIP. Names are UTF-8 and say so.

'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

const LIMIT = 0xffffffff;
const COUNT_LIMIT = 0xffff;

let crcTable = null;
function crc32(buf, crc = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      crcTable[n] = c >>> 0;
    }
  }
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A file's CRC-32 and size, read through once. */
async function fileCrc(file) {
  let crc = 0;
  let size = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    crc = crc32(chunk, crc);
    size += chunk.length;
  }
  return { crc, size };
}

// MS-DOS date and time, as every ZIP header carries them (local time, two-
// second steps, nothing before 1980).
function dosTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// One part of a path inside the archive: no slashes, nothing Windows refuses
// in a file name, no leading dots (a hidden file, or a climb out), and short
// enough that a deep path still fits Windows' 260 characters.
function safePart(raw, fallback = 'file') {
  const clean = String(raw ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!clean) return fallback;
  if (clean.length <= 100) return clean;
  const ext = /\.[a-z0-9]{1,8}$/i.exec(clean)?.[0] || '';
  return `${clean.slice(0, 100 - ext.length).trim()}${ext}`;
}

// Text is worth compressing, and only when that makes it smaller.
function packBuffer(buf, deflate = true) {
  const packed = deflate && buf.length > 64 ? zlib.deflateRawSync(buf) : null;
  return packed && packed.length < buf.length ? { body: packed, method: 8 } : { body: buf, method: 0 };
}

/**
 * The exact size of the archive these entries make, before any of it is
 * written - so a download can say how big it is, and the browser can show
 * how far along it is. Mirrors header() and finish() byte for byte;
 * test/zip-writer.test.mjs holds the two to the same answer.
 *
 * @param {{name: string, data?: Buffer, bytes?: number, deflate?: boolean}[]} list
 */
function predictSize(list, { zip64At = LIMIT } = {}) {
  let offset = 0;
  let central = 0;
  for (const e of list) {
    const nameLen = Buffer.byteLength(e.name, 'utf8');
    const size = e.data ? e.data.length : e.bytes;
    const stored = e.data ? packBuffer(e.data, e.deflate !== false).body.length : size;
    const big = size >= zip64At || stored >= zip64At;
    const at = offset;
    offset += 30 + nameLen + (big ? 20 : 0) + stored;
    const fields = (size >= zip64At) + (stored >= zip64At) + (at >= zip64At);
    central += 46 + nameLen + (fields ? 4 + fields * 8 : 0);
  }
  const start = offset;
  const big = list.length >= COUNT_LIMIT || central >= zip64At || start >= zip64At;
  return start + central + (big ? 76 : 0) + 22;
}

class ZipWriter {
  /**
   * @param {import('node:stream').Writable} out - where the archive goes (a response)
   * @param {object} [opts]
   * @param {number} [opts.zip64At] - the size at which ZIP64 takes over; tests lower it
   */
  constructor(out, { zip64At = LIMIT } = {}) {
    this.out = out;
    this.zip64At = zip64At;
    this.offset = 0;
    this.entries = [];
    this.names = new Set();
    this.closed = false;
    out.on('close', () => { this.closed = true; });
  }

  /** How many bytes have been written so far. */
  get written() { return this.offset; }

  /**
   * A path not already in the archive: "notes.pdf", then "notes (2).pdf".
   * Compared without case, because the folder it is unzipped into may be.
   */
  uniqueName(path) {
    const key = (p) => p.toLowerCase();
    if (!this.names.has(key(path))) { this.names.add(key(path)); return path; }
    const m = /^(.*?)(\.[^./]{1,8})?$/.exec(path);
    for (let n = 2; ; n++) {
      const next = `${m[1]} (${n})${m[2] || ''}`;
      if (!this.names.has(key(next))) { this.names.add(key(next)); return next; }
    }
  }

  async write(chunk) {
    if (this.closed) throw Object.assign(new Error('the download was stopped'), { aborted: true });
    this.offset += chunk.length;
    if (!this.out.write(chunk)) {
      await new Promise((resolve, reject) => {
        const done = () => { this.out.off('drain', done); this.out.off('close', gone); resolve(); };
        const gone = () => { this.out.off('drain', done); reject(Object.assign(new Error('the download was stopped'), { aborted: true })); };
        this.out.once('drain', done);
        this.out.once('close', gone);
      });
    }
  }

  async header(name, { crc, size, stored, method, mtime }) {
    const nameBuf = Buffer.from(name, 'utf8');
    const big = size >= this.zip64At || stored >= this.zip64At;
    const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
    if (big) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(stored), 12);
    }
    const { time, day } = dosTime(mtime);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(big ? 45 : 20, 4);
    head.writeUInt16LE(0x0800, 6);                 // names are UTF-8
    head.writeUInt16LE(method, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(day, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(big ? LIMIT : stored, 18);
    head.writeUInt32LE(big ? LIMIT : size, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(extra.length, 28);
    const at = this.offset;
    await this.write(Buffer.concat([head, nameBuf, extra]));
    this.entries.push({ nameBuf, crc, size, stored, method, time, day, at });
  }

  /**
   * An entry from memory: a plan file, the manifest, a deck's markdown.
   * Text is worth compressing; `deflate: false` for what already is.
   */
  async addBuffer(name, data, { mtime, deflate = true } = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const { body, method } = packBuffer(buf, deflate);
    await this.header(name, { crc: crc32(buf), size: buf.length, stored: body.length, method, mtime });
    await this.write(body);
  }

  /**
   * An entry from disk, stored as it is (pictures, video, PDFs: already
   * compressed, and the bulk of any backup). The file is read once for its
   * CRC and again to send it; one that changed size in between is refused
   * rather than written wrong.
   */
  async addFile(name, file, { mtime } = {}) {
    const { crc, size } = await fileCrc(file);
    await this.header(name, { crc, size, stored: size, method: 0, mtime });
    let sent = 0;
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
      sent += chunk.length;
      if (sent > size) break;
      await this.write(chunk);
    }
    if (sent !== size) throw new Error(`${name} changed while it was being written`);
  }

  /** The central directory and the end records. The archive is complete after this. */
  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const fields = [];
      if (e.size >= this.zip64At) fields.push(e.size);
      if (e.stored >= this.zip64At) fields.push(e.stored);
      if (e.at >= this.zip64At) fields.push(e.at);
      const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
      if (fields.length) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(fields.length * 8, 2);
        fields.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + i * 8));
      }
      const big = fields.length > 0;
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(0x02014b50, 0);
      rec.writeUInt16LE((3 << 8) | 45, 4);         // made by: Unix, ZIP 4.5
      rec.writeUInt16LE(big ? 45 : 20, 6);
      rec.writeUInt16LE(0x0800, 8);
      rec.writeUInt16LE(e.method, 10);
      rec.writeUInt16LE(e.time, 12);
      rec.writeUInt16LE(e.day, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(e.stored >= this.zip64At ? LIMIT : e.stored, 20);
      rec.writeUInt32LE(e.size >= this.zip64At ? LIMIT : e.size, 24);
      rec.writeUInt16LE(e.nameBuf.length, 28);
      rec.writeUInt16LE(extra.length, 30);
      rec.writeUInt16LE(0, 32);                    // no comment
      rec.writeUInt16LE(0, 34);
      rec.writeUInt16LE(0, 36);
      rec.writeUInt32LE((0o100644 << 16) >>> 0, 38); // an ordinary file, rw-r--r--
      rec.writeUInt32LE(e.at >= this.zip64At ? LIMIT : e.at, 42);
      await this.write(Buffer.concat([rec, e.nameBuf, extra]));
    }
    const size = this.offset - start;
    const count = this.entries.length;
    const big = count >= COUNT_LIMIT || size >= this.zip64At || start >= this.zip64At;
    if (big) {
      const at = this.offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0);
      rec.writeBigUInt64LE(44n, 4);
      rec.writeUInt16LE((3 << 8) | 45, 12);
      rec.writeUInt16LE(45, 14);
      rec.writeUInt32LE(0, 16);
      rec.writeUInt32LE(0, 20);
      rec.writeBigUInt64LE(BigInt(count), 24);
      rec.writeBigUInt64LE(BigInt(count), 32);
      rec.writeBigUInt64LE(BigInt(size), 40);
      rec.writeBigUInt64LE(BigInt(start), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(at), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([rec, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(big ? COUNT_LIMIT : count, 8);
    end.writeUInt16LE(big ? COUNT_LIMIT : count, 10);
    end.writeUInt32LE(big ? LIMIT : size, 12);
    end.writeUInt32LE(big ? LIMIT : start, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
  }
}

module.exports = { ZipWriter, crc32, fileCrc, safePart, predictSize };
