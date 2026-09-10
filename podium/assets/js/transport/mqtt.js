// MQTT over secure WebSockets. Works against any broker, including the free
// public ones, because the payload is encrypted before it leaves the browser.

const CDN = 'https://cdn.jsdelivr.net/npm/mqtt@5.15.2/dist/mqtt.esm.js';

export const label = 'MQTT over WSS';

export async function connect({ cfg, onMessage, onStatus, clientId }) {
  const mqtt = (await import(/* @vite-ignore */ CDN)).default;
  const topic = `podium/${cfg.room}`;

  const client = mqtt.connect(cfg.mqttUrl, {
    clientId: `podium-${clientId}`,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 2000,
    connectTimeout: 8000,
    protocolVersion: 5,
  });

  let ready = false;
  client.on('connect', () => { client.subscribe(topic, { qos: 0 }); ready = true; onStatus('online'); });
  client.on('reconnect', () => { ready = false; onStatus('connecting'); });
  client.on('close', () => { ready = false; onStatus('offline'); });
  client.on('error', (err) => { ready = false; onStatus('error', err?.message); });
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
