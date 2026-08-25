/* Live updates: Postgres NOTIFY -> this process -> the browser, over SSE.

   The triggers in db/notify-triggers.sql fire pg_notify('cc_changes', {tbl, op,
   ids}) on the portal tables. One dedicated connection here LISTENs and fans
   every payload out to the dashboards currently connected to GET /api/ghl/events.

   The payload is ids only. The browser decides what, if anything, to fetch —
   which is the whole point: a trigger tells the dashboard THAT something
   changed and WHICH row, and the dashboard fetches exactly that row rather than
   re-reading the database.

   SSE rather than WebSockets because the traffic is strictly one-way, the
   browser reconnects on its own (with Last-Event-ID, unused here since events
   are not replayable anyway), and it is plain HTTP — no upgrade dance through
   Railway's proxy. */

import { dedicatedClient } from '../db/index.js';

const CHANNEL = 'cc_changes';

/* Proxies kill quiet connections. A comment line every 25s is invisible to
   EventSource and keeps the stream alive through Railway's edge. */
const HEARTBEAT_MS = 25_000;

/* Reconnect backoff for the LISTEN connection. Postgres restarts are routine on
   managed hosting; the subscribers upstream never notice a gap because the
   browser re-fetches nothing on our reconnect — it only acts on future events. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export function startLive(){
  const subscribers = new Set();
  let client = null;
  let stopped = false;
  let attempt = 0;
  let eventId = 0;

  function broadcast(payloadText){
    /* Validated before fanout so one malformed NOTIFY (nothing stops a person
       running pg_notify by hand) cannot wedge every connected dashboard. */
    let parsed;
    try { parsed = JSON.parse(payloadText); }
    catch { console.error('[ghl:live] dropped a non-JSON NOTIFY payload'); return; }
    if (!parsed?.tbl || !parsed?.op) return;

    const frame = `id: ${++eventId}\ndata: ${JSON.stringify(parsed)}\n\n`;
    for (const res of subscribers) {
      try { res.write(frame); }
      catch { subscribers.delete(res); }
    }
  }

  async function connect(){
    if (stopped) return;
    try {
      client = dedicatedClient();

      /* Both paths lead to reconnect(): 'error' fires on network death, 'end'
         on a server-side close that never errored. Either way the old client is
         done — pg does not resurrect a broken connection. */
      client.on('error', err => {
        console.error('[ghl:live] listen connection lost:', err.message);
        reconnect();
      });
      client.on('end', () => reconnect());
      client.on('notification', msg => {
        if (msg.channel === CHANNEL) broadcast(msg.payload || '');
      });

      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      attempt = 0;
      console.log(`[ghl:live] listening on ${CHANNEL}`);
    } catch (err) {
      console.error('[ghl:live] could not start listening:', err.message);
      reconnect();
    }
  }

  let reconnectTimer = null;
  function reconnect(){
    if (stopped || reconnectTimer) return;
    try { client?.end().catch(() => {}); } catch { /* already gone */ }
    client = null;
    const wait = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
    reconnectTimer.unref?.();
  }

  const heartbeat = setInterval(() => {
    for (const res of subscribers) {
      try { res.write(':hb\n\n'); }
      catch { subscribers.delete(res); }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  connect();

  return {
    /* Express handler for GET /api/ghl/events. Auth is applied where it is
       mounted, same as every other route. */
    handler(req, res){
      res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        /* Compression buffers; an SSE stream must not be. The middleware
           respects this header and passes the response through untouched. */
        'Content-Encoding': 'identity'
      });
      res.flushHeaders?.();

      /* EventSource applies this on connection drops, so a redeploy is a 5s
         gap rather than a hammering retry loop. */
      res.write('retry: 5000\n\n');

      subscribers.add(res);
      req.on('close', () => subscribers.delete(res));
    },

    subscriberCount: () => subscribers.size,

    async stop(){
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(reconnectTimer);
      for (const res of subscribers) {
        try { res.end(); } catch { /* already closed */ }
      }
      subscribers.clear();
      await client?.end().catch(() => {});
    }
  };
}
