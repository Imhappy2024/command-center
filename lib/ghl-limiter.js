/* Per-location request pacing for GHL.

   Limits are per location: 100 requests per 10 seconds, 200,000 per day. That
   only matters during backfill — a large sub-account pages through thousands of
   contacts and would trip the burst limit within seconds if the requests went
   out unpaced.

   Two defences, deliberately layered:

     1. A local sliding window, capped below the real limit. This is the primary
        one because it does not depend on reading anything back.
     2. A pause when the provider's own X-RateLimit-Remaining runs low. Secondary,
        because attributing a header to a location is only exact while one
        location is in flight (see the note on `active` below).

   Everything for a given location is serialised. Nothing here runs two requests
   against the same sub-account at once. */

import { markReauth } from './accounts.js';
import { onLimits, GhlError } from '../providers/ghl.js';

const WINDOW_MS = 10_000;
const MAX_IN_WINDOW = 80;      // real cap is 100; the headroom absorbs clock skew
const LOW_WATER = 20;          // pause when the provider says this few are left
const LOW_WATER_PAUSE = 2_000;
const BACKOFF = [1_000, 2_000, 4_000];

const sleep = ms => new Promise(r => setTimeout(r, ms));

const lanes = new Map();

function lane(locationId){
  let l = lanes.get(locationId);
  if (!l) {
    l = { queue: [], running: false, stamps: [], remaining: null, stopped: null };
    lanes.set(locationId, l);
  }
  return l;
}

/* call() publishes rate-limit headers here. Credited to whichever location is
   currently executing, which is exact whenever locations run in series — and
   sync and backfill both do, by design. If two locations ever overlap, a header
   can be credited to the wrong lane; the sliding window above is what keeps
   that from mattering, since it never depends on the headers at all. */
let active = null;
onLimits(limits => {
  if (!active || !Number.isFinite(limits?.remaining)) return;
  lane(active).remaining = limits.remaining;
});

/* Waits until this location may issue another request. */
async function pace(l){
  for (;;) {
    const now = Date.now();
    l.stamps = l.stamps.filter(t => now - t < WINDOW_MS);

    if (l.stamps.length >= MAX_IN_WINDOW) {
      await sleep(WINDOW_MS - (now - l.stamps[0]) + 50);
      continue;
    }
    if (l.remaining !== null && l.remaining < LOW_WATER) {
      /* Cleared after waiting so this cannot spin: the next response refreshes
         it, and if none arrives we stop holding an old number against the lane. */
      l.remaining = null;
      await sleep(LOW_WATER_PAUSE);
      continue;
    }
    l.stamps.push(Date.now());
    return;
  }
}

async function attempt(locationId, l, fn){
  for (let tries = 0; ; tries++) {
    await pace(l);
    active = locationId;
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GhlError && err.kind === 'rate' && tries < BACKOFF.length) {
        console.warn(`[ghl:limiter] ${locationId} rate limited, backing off ${BACKOFF[tries]}ms`);
        await sleep(BACKOFF[tries]);
        continue;
      }
      /* A rejected token does not get retried. It will not start working, and
         hammering it just burns the daily budget. The lane stops, the account is
         flagged for reconnection, and every queued task for that location fails
         with the same message. */
      if (err instanceof GhlError && err.kind === 'auth') {
        l.stopped = err;
        await markReauth(`ghl:${locationId}`, err.message).catch(() => {});
        console.error(`[ghl:limiter] ${locationId} token rejected — work stopped for this location`);
      }
      throw err;
    } finally {
      active = null;
    }
  }
}

function pump(locationId){
  const l = lane(locationId);
  if (l.running) return;
  l.running = true;

  (async () => {
    while (l.queue.length) {
      const job = l.queue.shift();
      if (l.stopped) { job.reject(l.stopped); continue; }
      try { job.resolve(await attempt(locationId, l, job.fn)); }
      catch (err) { job.reject(err); }
    }
    l.running = false;
  })();
}

/* Queue one request against a location. Resolves with fn()'s value. */
export function run(locationId, fn){
  const l = lane(locationId);
  if (l.stopped) return Promise.reject(l.stopped);
  return new Promise((resolve, reject) => {
    l.queue.push({ fn, resolve, reject });
    pump(locationId);
  });
}

/* Called after a token is replaced — by the env seeder or the Connect sheet —
   so a location that was stopped on a 401 starts working again without a
   restart. */
export function resume(locationId){
  const l = lanes.get(locationId);
  if (l) l.stopped = null;
}

export const isStopped = locationId => Boolean(lanes.get(locationId)?.stopped);
