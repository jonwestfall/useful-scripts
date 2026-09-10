// Transport adapters are loaded on demand, so a blocked CDN for one of them
// never breaks the transport you actually use.

export const TRANSPORTS = {
  supabase: { label: 'Supabase Realtime', load: () => import('./supabase.js') },
  mqtt: { label: 'MQTT over WSS (public broker)', load: () => import('./mqtt.js') },
  ws: { label: 'Self-hosted WebSocket', load: () => import('./ws.js') },
};

export async function connectTransport(name, opts) {
  const entry = TRANSPORTS[name] || TRANSPORTS.supabase;
  const mod = await entry.load();
  return mod.connect(opts);
}
