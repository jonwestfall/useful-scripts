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

const b64 = {
  encode: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
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
