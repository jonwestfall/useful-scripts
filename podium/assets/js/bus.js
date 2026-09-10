// The message bus: encryption, identity, presence and reconnection, wrapped
// around whichever transport adapter is configured.

import { connectTransport } from './transport/index.js';
import { deriveKey, seal, open, fingerprint, hasWebCrypto } from './crypto.js';
import { uid } from './util.js';

const PING_MS = 3000;
const PEER_TTL_MS = 11000;

export async function createBus({ cfg, role, onMessage, onStatus = () => {}, onPeers = () => {} }) {
  if (!hasWebCrypto()) {
    throw new Error('This page needs https:// (or localhost) — encryption is unavailable over plain http.');
  }

  const clientId = uid(8);
  const key = await deriveKey(cfg.passphrase, cfg.room);
  const fp = await fingerprint(cfg.passphrase, cfg.room);
  const peers = new Map();

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
      const msg = await open(key, envelope);
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
    async send(msg) {
      const envelope = await seal(key, { ...msg, from: clientId, role, ts: msg.ts ?? Date.now() });
      return transport.send(envelope);
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
