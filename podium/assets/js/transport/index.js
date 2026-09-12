// Transport adapters are loaded on demand, so a blocked CDN for one of them
// never breaks the transport you actually use.

export const TRANSPORTS = {
  supabase: { label: 'Supabase Realtime', load: () => import('./supabase.js') },
  mqtt: { label: 'MQTT over WSS (public broker)', load: () => import('./mqtt.js') },
  ws: { label: 'Self-hosted WebSocket', load: () => import('./ws.js') },
};

export async function connectTransport(name, opts) {
  const entry = TRANSPORTS[name] || TRANSPORTS.supabase;
  let mod;
  try {
    mod = await entry.load();
  } catch (err) {
    // Only the self-hosted adapter is local; the other two pull a client
    // library off a CDN, which is the first thing a locked-down campus
    // network blocks. Naming the adapter beats a bare "import failed".
    throw new Error(`Could not load the ${entry.label} adapter: ${err?.message || err}`);
  }
  return mod.connect(opts);
}
