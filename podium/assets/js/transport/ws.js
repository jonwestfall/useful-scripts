// Plain WebSocket relay — pairs with server/podium-server.js on your own VPS.
// No third party in the path at all; reconnects with backoff on Wi-Fi drops.

export const label = 'Self-hosted WebSocket';

// A WebSocket that never opens tells you almost nothing: the browser refuses,
// by design, to say whether it was DNS, a closed port, a proxy, or a TLS
// certificate it does not trust - every one of them arrives as close code
// 1006 with an empty reason. So say what the possibilities ARE, with the URL
// actually dialled, rather than "socket error", which sends you looking at
// the app when the answer is on the network.
function whyItWouldNotOpen(u) {
  const overHttps = u.protocol === 'wss:';
  const asPage = `${overHttps ? 'https' : 'http'}://${u.host}/`;
  return [
    `could not open ${u.protocol}//${u.host}${u.pathname}`,
    'the relay may not be running, the port may be closed to this network',
    overHttps
      ? `or its certificate may not be trusted here (open ${asPage} in a tab once and accept it)`
      : 'or the browser blocked it',
  ].join(' — ');
}

export async function connect({ cfg, onMessage, onStatus, clientId }) {
  let base;
  try {
    base = new URL(cfg.wsUrl);
  } catch {
    throw new Error(`"${cfg.wsUrl}" is not a URL. It should look like wss://your-vps.example/podium`);
  }
  if (base.protocol !== 'ws:' && base.protocol !== 'wss:') {
    throw new Error(`The relay URL must start with wss:// (or ws:// on localhost), not ${base.protocol}//`);
  }
  // Worth catching before the socket, because the browser blocks this one
  // silently at a layer the page cannot see into.
  if (location.protocol === 'https:' && base.protocol === 'ws:') {
    throw new Error('This page is served over https://, so the browser blocks a plain ws:// relay. Use wss://.');
  }

  let socket = null;
  let ready = false;
  let closed = false;
  let attempt = 0;
  let everOpen = false;
  let retryTimer = null;

  const url = () => {
    const u = new URL(cfg.wsUrl);
    u.searchParams.set('room', cfg.room);
    u.searchParams.set('id', clientId);
    return u.toString();
  };

  function openSocket() {
    if (closed) return;
    onStatus('connecting', `dialling ${base.protocol}//${base.host}${base.pathname}`);
    socket = new WebSocket(url());
    socket.addEventListener('open', () => {
      ready = true; everOpen = true; attempt = 0;
      onStatus('online');
    });
    socket.addEventListener('message', (ev) => {
      try { onMessage(JSON.parse(ev.data)); } catch { /* not ours */ }
    });
    // 'error' carries no detail anywhere; the close event that follows it does
    // at least carry a code, so let that one do the talking.
    socket.addEventListener('close', (ev) => {
      ready = false;
      if (closed) return;
      const code = ev.code ? ` (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})` : '';
      const tries = attempt ? `, attempt ${attempt + 1}` : '';
      onStatus(everOpen ? 'offline' : 'error', everOpen
        ? `dropped${code}${tries}`
        : `${whyItWouldNotOpen(base)}${code}${tries}`);
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
