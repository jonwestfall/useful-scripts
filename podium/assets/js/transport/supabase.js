// Supabase Realtime "broadcast" channel.
//
// Broadcast is a pure fan-out relay: no tables, no rows, no RLS policy to write,
// and nothing is persisted. The publishable/anon key is safe in client code for
// this use because the channel carries only AES-GCM ciphertext.

const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm';

export const label = 'Supabase Realtime';

export async function connect({ cfg, onMessage, onStatus }) {
  let host;
  try {
    host = new URL(cfg.supabaseUrl).host;
  } catch {
    throw new Error(`"${cfg.supabaseUrl}" is not a URL. It should look like https://xxxx.supabase.co`);
  }

  // See the note in mqtt.js: an unwrapped CDN failure here reaches the page's
  // top-level await and aborts the module, which looks like a hang.
  let createClient;
  try {
    ({ createClient } = await import(/* @vite-ignore */ CDN));
  } catch (err) {
    throw new Error(`Could not load the Supabase client from ${new URL(CDN).host} — this network is probably blocking it. Self-hosted WebSocket needs no CDN. (${err?.message || err})`);
  }
  onStatus('connecting', `joining ${host}`);
  const client = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Default is 10/s, which the whiteboard would trip over.
    realtime: { params: { eventsPerSecond: 40 } },
  });

  const channel = client.channel(`podium-${cfg.room}`, {
    config: { broadcast: { self: false, ack: false } },
  });
  channel.on('broadcast', { event: 'm' }, ({ payload }) => onMessage(payload));

  let ready = false;
  await new Promise((resolve) => {
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') { ready = true; onStatus('online'); resolve(); }
      // A wrong key and a wrong project URL both land here, and the SDK's own
      // message is usually empty - so name the project being joined.
      else if (status === 'CHANNEL_ERROR') { ready = false; onStatus('error', `${host}: ${err?.message || 'channel error — check the project URL and the anon key'}`); resolve(); }
      else if (status === 'TIMED_OUT') { ready = false; onStatus('offline', `${host} timed out`); resolve(); }
      else if (status === 'CLOSED') { ready = false; onStatus('offline', `${host} closed the channel`); }
      else onStatus('connecting', `joining ${host}`);
    });
  });

  return {
    send(envelope) {
      if (!ready) return false;
      channel.send({ type: 'broadcast', event: 'm', payload: envelope });
      return true;
    },
    async close() {
      ready = false;
      try { await client.removeChannel(channel); } catch { /* already gone */ }
    },
  };
}
