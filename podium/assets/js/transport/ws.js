// Plain WebSocket relay — pairs with server/podium-server.js on your own VPS.
// No third party in the path at all; reconnects with backoff on Wi-Fi drops.

export const label = 'Self-hosted WebSocket';

export async function connect({ cfg, onMessage, onStatus, clientId }) {
  let socket = null;
  let ready = false;
  let closed = false;
  let attempt = 0;
  let retryTimer = null;

  const url = () => {
    const u = new URL(cfg.wsUrl);
    u.searchParams.set('room', cfg.room);
    u.searchParams.set('id', clientId);
    return u.toString();
  };

  function openSocket() {
    if (closed) return;
    onStatus('connecting');
    socket = new WebSocket(url());
    socket.addEventListener('open', () => { ready = true; attempt = 0; onStatus('online'); });
    socket.addEventListener('message', (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch { /* not ours */ }
    });
    socket.addEventListener('error', () => onStatus('error', 'socket error'));
    socket.addEventListener('close', () => {
      ready = false;
      if (closed) return;
      onStatus('offline');
      const delay = Math.min(15000, 500 * 2 ** attempt++);
      retryTimer = setTimeout(openSocket, delay);
    });
  }

  openSocket();
  await new Promise((resolve) => {
    const done = () => resolve();
    socket.addEventListener('open', done, { once: true });
    setTimeout(done, 8000);
  });

  return {
    send(envelope) {
      if (!ready || socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(envelope));
      return true;
    },
    async close() {
      closed = true; ready = false;
      clearTimeout(retryTimer);
      try { socket?.close(); } catch { /* noop */ }
    },
  };
}
