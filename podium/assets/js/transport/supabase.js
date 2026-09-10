// Supabase Realtime "broadcast" channel.
//
// Broadcast is a pure fan-out relay: no tables, no rows, no RLS policy to write,
// and nothing is persisted. The publishable/anon key is safe in client code for
// this use because the channel carries only AES-GCM ciphertext.

const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm';

export const label = 'Supabase Realtime';

export async function connect({ cfg, onMessage, onStatus }) {
  const { createClient } = await import(/* @vite-ignore */ CDN);
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
      else if (status === 'CHANNEL_ERROR') { ready = false; onStatus('error', err?.message || 'channel error'); resolve(); }
      else if (status === 'TIMED_OUT') { ready = false; onStatus('offline', 'timed out'); resolve(); }
      else if (status === 'CLOSED') { ready = false; onStatus('offline'); }
      else onStatus('connecting');
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
