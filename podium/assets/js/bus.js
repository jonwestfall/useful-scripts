// The message bus: encryption, identity, presence and reconnection, wrapped
// around whichever transport adapter is configured.

import { connectTransport } from './transport/index.js';
import { deriveKey, seal, open, fingerprint, hasWebCrypto } from './crypto.js';
import { uid } from './util.js';

const PING_MS = 3000;
const PEER_TTL_MS = 11000;

// One message's ceiling on the wire. The self-hosted relay closes any socket
// that sends more than 256 KB (MAX_MESSAGE in server/podium-server.js), and
// Supabase and the public MQTT brokers set caps of their own in the same
// range, so this sits under that with room for each transport's framing. An uploaded deck, a lecture plan's photo
// (up to 320 K characters, see planfile.js) or either of them relayed to Guest
// View can seal to more than that - and past it the relay simply hung up on
// the sender, which reconnected, was asked for the same deck again, and sent
// it again. So anything that seals larger goes as parts instead, whatever the
// transport and whoever is sending.
export const MAX_FRAME = 192 * 1024;
// Characters of a message's JSON per part. A character is at most three bytes
// of UTF-8 and base64 adds a third, so a part seals to under four times this -
// always inside MAX_FRAME.
export const PART_CHARS = 40 * 1024;
// What a receiver will put back together: enough for any real message (a
// photo is eight parts) and a bound on what anyone holding the key - every
// Guest View phone does - can make another device hold in memory.
export const MAX_PARTS = 32;
const MAX_ASSEMBLIES = 16;
const PART_TTL_MS = 20000;

/** A message's JSON in part-sized slices, or null when it is too big to send at all. */
export function splitMessage(text) {
  const count = Math.ceil(text.length / PART_CHARS);
  if (count > MAX_PARTS) return null;
  return Array.from({ length: count }, (_, i) => text.slice(i * PART_CHARS, (i + 1) * PART_CHARS));
}

/**
 * Puts parts back together. Returns the whole message once its last part is
 * in, and null until then - or for anything malformed, or a "whole" that
 * claims a different sender than the parts that carried it. A message that
 * lost a part on the way is dropped after PART_TTL_MS; the deck-need and
 * asset-need retries are what fetch it again.
 */
export function createAssembler({ now = Date.now } = {}) {
  const pending = new Map();
  return function assemble(part) {
    const { pid, i, n, s, from } = part;
    if (typeof pid !== 'string' || typeof s !== 'string' || s.length > PART_CHARS) return null;
    if (!Number.isInteger(n) || n < 2 || n > MAX_PARTS || !Number.isInteger(i) || i < 0 || i >= n) return null;
    const at = now();
    for (const [key, entry] of pending) if (at - entry.at > PART_TTL_MS) pending.delete(key);
    const key = `${from}|${pid}`;
    let entry = pending.get(key);
    if (!entry) {
      // Oldest out first: Map iterates in insertion order.
      while (pending.size >= MAX_ASSEMBLIES) pending.delete(pending.keys().next().value);
      entry = { n, got: 0, slices: new Array(n), at };
      pending.set(key, entry);
    }
    if (entry.n !== n) return null;
    if (entry.slices[i] === undefined) { entry.slices[i] = s; entry.got++; }
    if (entry.got < n) return null;
    pending.delete(key);
    let whole;
    try { whole = JSON.parse(entry.slices.join('')); } catch { return null; }
    if (!whole || typeof whole !== 'object' || whole.from !== from || whole.t === 'part') return null;
    return whole;
  };
}

export async function createBus({ cfg, role, onMessage, onStatus = () => {}, onPeers = () => {} }) {
  if (!hasWebCrypto()) {
    throw new Error('This page needs https:// (or localhost) — encryption is unavailable over plain http.');
  }

  const clientId = uid(8);
  const key = await deriveKey(cfg.passphrase, cfg.room);
  const fp = await fingerprint(cfg.passphrase, cfg.room);
  const peers = new Map();
  const assemble = createAssembler();

  let status = 'connecting';
  let undecryptable = 0;

  const setStatus = (next, detail) => {
    status = next;
    onStatus(next, detail);
  };

  const transport = await connectTransport(cfg.transport, {
    cfg,
    clientId,
    onStatus: setStatus,
    onMessage: async (envelope) => {
      let msg = await open(key, envelope);
      if (!msg) {
        // Wrong passphrase, or unrelated traffic on a shared public topic.
        // Re-assert periodically: a later reconnect would otherwise overwrite
        // the warning with a cheerful "online" and hide a real problem.
        undecryptable++;
        if (undecryptable === 3 || undecryptable % 25 === 0) {
          setStatus('mismatch', 'Messages are arriving that this passphrase cannot read.');
        }
        return;
      }
      if (msg.from === clientId) return;

      const known = peers.get(msg.from);
      peers.set(msg.from, { id: msg.from, role: msg.role, seen: Date.now(), rtt: known?.rtt });
      if (!known) onPeers(peerList());

      if (msg.t === 'part') {
        if (msg.to && msg.to !== clientId) return;
        msg = assemble(msg);
        if (!msg) return;
      }
      if (msg.t === 'ping') { bus.send({ t: 'pong', echo: msg.ts, to: msg.from }); return; }
      if (msg.t === 'pong') {
        if (msg.to && msg.to !== clientId) return;
        const peer = peers.get(msg.from);
        if (peer && msg.echo) { peer.rtt = Date.now() - msg.echo; onPeers(peerList()); }
        return;
      }
      if (msg.to && msg.to !== clientId) return;
      onMessage(msg);
    },
  });

  function peerList() {
    return Array.from(peers.values()).sort((a, b) => a.role.localeCompare(b.role));
  }

  const bus = {
    clientId,
    role,
    fingerprint: fp,
    get status() { return status; },
    peers: peerList,
    hasPeer(wantedRole) {
      return peerList().some((p) => p.role === wantedRole);
    },
    /**
     * Resolves true once the transport has taken the message (every part of
     * it, for a big one), false when it refused - not connected, or a message
     * past even MAX_PARTS. Every transport's own send() answers the same way.
     * Taken is not delivered: nothing here waits for the other end.
     */
    async send(msg) {
      const whole = { ...msg, from: clientId, role, ts: msg.ts ?? Date.now() };
      const envelope = await seal(key, whole);
      if (JSON.stringify(envelope).length <= MAX_FRAME) return (await transport.send(envelope)) === true;
      const slices = splitMessage(JSON.stringify(whole));
      if (!slices) {
        console.warn(`podium: a "${msg.t}" message is too big for the relay even in parts; not sent.`);
        return false;
      }
      const pid = uid(8);
      for (const [i, s] of slices.entries()) {
        const part = { t: 'part', pid, i, n: slices.length, s, from: clientId, role, ts: whole.ts, ...(msg.to ? { to: msg.to } : {}) };
        if ((await transport.send(await seal(key, part))) !== true) return false;
      }
      return true;
    },
    async close() {
      clearInterval(pinger);
      await transport.close();
    },
  };

  const pinger = setInterval(() => {
    bus.send({ t: 'ping' });
    const cutoff = Date.now() - PEER_TTL_MS;
    let dropped = false;
    for (const [id, peer] of peers) {
      if (peer.seen < cutoff) { peers.delete(id); dropped = true; }
    }
    if (dropped) onPeers(peerList());
  }, PING_MS);

  bus.send({ t: 'hello' });
  return bus;
}
