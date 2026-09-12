// MQTT over secure WebSockets. Works against any broker, including the free
// public ones, because the payload is encrypted before it leaves the browser.

const CDN = 'https://cdn.jsdelivr.net/npm/mqtt@5.15.2/dist/mqtt.esm.js';

export const label = 'MQTT over WSS';

export async function connect({ cfg, onMessage, onStatus, clientId }) {
  let base;
  try {
    base = new URL(cfg.mqttUrl);
  } catch {
    throw new Error(`"${cfg.mqttUrl}" is not a URL. A broker URL looks like wss://broker.example:8084/mqtt`);
  }
  // In a browser MQTT can only ride a WebSocket, and the public brokers each
  // expose that on a different port and path - mqtt:// or a missing /mqtt is
  // the single most common way this ends up silently dead.
  if (base.protocol !== 'ws:' && base.protocol !== 'wss:') {
    throw new Error(`A browser can only speak MQTT over a WebSocket, so the broker URL must start with wss:// (or ws:// on localhost), not ${base.protocol}// — for example wss://broker.emqx.io:8084/mqtt`);
  }
  if (location.protocol === 'https:' && base.protocol === 'ws:') {
    throw new Error('This page is served over https://, so the browser blocks a plain ws:// broker. Use wss://.');
  }

  // The client library comes off a CDN, which is the first thing a locked-down
  // campus network blocks. Unwrapped, this rejection propagated all the way out
  // to the page's top-level await and killed the rest of the module.
  let mqtt;
  try {
    mqtt = (await import(/* @vite-ignore */ CDN)).default;
  } catch (err) {
    throw new Error(`Could not load the MQTT client from ${new URL(CDN).host} — this network is probably blocking it. Self-hosted WebSocket needs no CDN. (${err?.message || err})`);
  }
  const topic = `podium/${cfg.room}`;
  const where = `${base.protocol}//${base.host}${base.pathname}`;

  const client = mqtt.connect(cfg.mqttUrl, {
    clientId: `podium-${clientId}`,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 2000,
    connectTimeout: 8000,
    // 3.1.1, not 5. Nothing here uses an MQTT 5 feature, and a broker that
    // does not speak 5 refuses the connection outright rather than falling
    // back - which looks exactly like a silent configuration problem.
    protocolVersion: 4,
  });

  let ready = false;
  let everOpen = false;
  let lastError = '';
  onStatus('connecting', `dialling ${where}`);
  client.on('connect', () => {
    client.subscribe(topic, { qos: 0 });
    ready = true; everOpen = true; lastError = '';
    onStatus('online');
  });
  client.on('reconnect', () => { ready = false; onStatus('connecting', `retrying ${where}`); });
  // A public broker that is simply full, or a wrong port, produces an endless
  // error/close cycle. Distinguish "never got in" from "was in and dropped":
  // they send you to completely different places to look.
  client.on('close', () => {
    ready = false;
    onStatus(everOpen ? 'offline' : 'error', everOpen
      ? `dropped by ${where}${lastError ? ` — ${lastError}` : ''}`
      : `never connected to ${where}${lastError ? ` — ${lastError}` : ''} — check the port and path, or try another broker`);
  });
  client.on('error', (err) => {
    ready = false;
    lastError = err?.message || String(err);
    onStatus('error', `${where}: ${lastError}`);
  });
  client.on('message', (_topic, buf) => {
    try { onMessage(JSON.parse(new TextDecoder().decode(buf))); } catch { /* not ours */ }
  });

  await new Promise((resolve) => {
    const done = () => resolve();
    client.once('connect', done);
    setTimeout(done, 8000);
  });

  return {
    send(envelope) {
      if (!ready) return false;
      client.publish(topic, JSON.stringify(envelope), { qos: 0 });
      return true;
    },
    async close() { ready = false; try { client.end(true); } catch { /* noop */ } },
  };
}
