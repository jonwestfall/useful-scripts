// A poll's link, made before class (planner or controller), so it can go in a
// handout, a chat message or a slide ahead of the poll itself.
//
// An ordinary poll's code is four random characters the relay picks the
// moment the poll starts - nothing to hand out in advance. A poll planned with
// a link carries a secret KEY instead (made here, kept in the plan), and its
// code is worked out from that key:
//
//   code = the first 10 characters of SHA-256("podium-poll-link\n" + key),
//          written in the relay's own alphabet (no O/0, no I/1)
//
// Starting the poll sends the key; the relay works out the same code and
// opens the poll under it (server/podium-server.js, POST /poll). So the
// relay needs to remember nothing in advance - a relay-only server, or one
// restarted since the handout went out, takes the link all the same - and
// someone who only knows the link (everyone with the handout) cannot start a
// poll under it first: that would take a key whose hash starts with those 50
// bits, which is out of reach. A phone that opens the link early is told the
// poll has not started yet and picks it up by itself when it does (join.js).
//
// No DOM, and no crypto.subtle: the planner may be on plain http on a LAN,
// where browsers withhold it, so SHA-256 is done here. The tests check it
// against node's own.

export const POLL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LINK_CODE_LENGTH = 10;
const KEY_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Whether `key` is shaped like a poll link's key. */
export const isPollKey = (key) => typeof key === 'string' && KEY_RE.test(key);

/** Whether `code` is a link code (as opposed to a four-character one). */
export const isLinkCode = (code) => typeof code === 'string'
  && code.length === LINK_CODE_LENGTH && [...code].every((c) => POLL_ALPHABET.includes(c));

/** A fresh key: 24 random bytes, base64url. */
export function newPollKey() {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The poll code a key opens under, or '' for something that is not a key. */
export function pollCodeForKey(key) {
  if (!isPollKey(key)) return '';
  const digest = sha256(new TextEncoder().encode(`podium-poll-link\n${key}`));
  let code = '';
  let acc = 0;
  let bits = 0;
  for (const byte of digest) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && code.length < LINK_CODE_LENGTH) {
      bits -= 5;
      code += POLL_ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
    if (code.length === LINK_CODE_LENGTH) break;
  }
  return code;
}

/** "ABCDEFGHJK" as "ABCDE-FGHJK", easier to read off a screen or a page. */
export const formatPollCode = (code) => (isLinkCode(code) ? `${code.slice(0, 5)}-${code.slice(5)}` : String(code || ''));

/** The link a key's poll is joined at, given the relay's base URL (pollBaseUrl). */
export function pollLinkUrl(base, key) {
  const code = pollCodeForKey(key);
  return base && code ? `${base}join.html?c=${code}` : '';
}

// --- SHA-256 (FIPS 180-4) ----------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/** SHA-256 of `bytes` (a Uint8Array), as a Uint8Array of 32. */
export function sha256(bytes) {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}
