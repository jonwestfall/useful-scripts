// AES-GCM payload encryption.
//
// Every message crossing the transport is encrypted with a key derived from the
// room passphrase. On a shared public broker this is what stops a stranger who
// guesses the room name from reading or driving your projector; on Supabase or
// your own VPS it means the relay never sees lecture content in the clear.
//
// Requires a secure context (https:// or localhost) for crypto.subtle.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function hasWebCrypto() {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

export async function deriveKey(passphrase, room) {
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(`podium|v1|${room}`), iterations: 150000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// String.fromCharCode(...bytes) spreads every single byte as a function
// argument, and that overflows the call stack somewhere above 100 KB - 124 KB
// in one V8 build, less on a device with a smaller stack. seal() is on the path
// of every message the app sends, including the three big ones: an uploaded
// deck (120 KB), a lecture plan's photo (160 KB) and a surface's worth of ink.
// Past the limit it threw inside send(), so the message simply never went,
// with nothing on screen to say why. Chunked, it has no ceiling.
const CHARCODE_CHUNK = 0x8000;

const b64 = {
  encode: (buf) => {
    const bytes = new Uint8Array(buf);
    let out = '';
    for (let i = 0; i < bytes.length; i += CHARCODE_CHUNK) {
      out += String.fromCharCode(...bytes.subarray(i, i + CHARCODE_CHUNK));
    }
    return btoa(out);
  },
  decode: (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0)),
};

export async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, n: b64.encode(iv), c: b64.encode(ct) };
}

// Returns null for anything we cannot authenticate — a message from a different
// passphrase, or noise from another app sharing a public broker topic.
export async function open(key, envelope) {
  if (!envelope || envelope.v !== 1 || !envelope.n || !envelope.c) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64.decode(envelope.n) }, key, b64.decode(envelope.c),
    );
    return JSON.parse(dec.decode(pt));
  } catch {
    return null;
  }
}

// Short, human-readable fingerprint of the room+passphrase pair. Both ends show
// it, so "same four characters on both screens" means they can actually talk.
export async function fingerprint(passphrase, room) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`podium|fp|${room}|${passphrase}`));
  return Array.from(new Uint8Array(digest).slice(0, 2), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// --- signing, for Guest View (Issue #150) ------------------------------------
//
// The view channel is sealed under a key every viewer holds - which keeps it
// private from the relay and from strangers, but means any one viewer could
// also SEND on it, and show every other guest a slide the presenter never put
// up. So the display signs what it sends there with a key only it holds
// (ECDSA P-256), the public half travels in the viewer link, and a viewer acts
// on nothing that does not verify. Viewers still cannot reach the real room at
// all - that was never in question; this is about them fooling each other.

const SIGN_ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' };

/** A fresh keypair, as { privateJwk, publicKey } - the second is what goes in a link. */
export async function makeSigningKey() {
  const pair = await crypto.subtle.generateKey(SIGN_ALG, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = b64.encode(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateJwk, publicKey };
}

export const importSigningKey = (privateJwk) =>
  crypto.subtle.importKey('jwk', privateJwk, SIGN_ALG, false, ['sign']);

export async function importVerifyKey(publicKey) {
  try {
    return await crypto.subtle.importKey('raw', b64.decode(publicKey), SIGN_ALG, false, ['verify']);
  } catch {
    return null;
  }
}

export async function signText(key, text) {
  return b64.encode(await crypto.subtle.sign(SIGN_PARAMS, key, enc.encode(text)));
}

export async function verifyText(key, text, signature) {
  try {
    return await crypto.subtle.verify(SIGN_PARAMS, key, b64.decode(String(signature || '')), enc.encode(String(text)));
  } catch {
    return false;
  }
}
