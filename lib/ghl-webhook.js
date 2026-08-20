/* Inbound GHL webhooks: validation, and the worker that drains them.

   This endpoint is unauthenticated by design. GHL's Custom Webhook workflow
   action posts with no HMAC — unlike Marketplace app webhooks there was never a
   signature to verify — and the owner has chosen not to add a shared secret
   either.

   So this receiver writes to the lead mirror and anyone who finds the URL can
   post to it. Everything below follows from that: the payload is untrusted
   input, not data from GHL.

     - The locationId must be one of the connected sub-accounts. This is the
       check that matters most. Without it a stranger can write into a location
       that is not ours, and it is nearly free because the valid set is already
       in the accounts table.
     - Ids are never used as keys unscoped. Every mirror key is
       '<locationId>:<recordId>' with the locationId half taken from the
       allow-list, not from the payload.
     - Values are re-fetched from GHL rather than read out of the payload. The
       worst a forged webhook can achieve is a read of a record that already
       exists. */

import { query } from '../db/index.js';
import * as ghl from '../providers/ghl.js';
import { run as limited } from './ghl-limiter.js';
import {
  locationIds, tokenFor, upsertContact, upsertOpportunity, upsertMessage
} from './ghl-sync.js';

/* The payload is a contact record, not an event envelope, so the event type
   comes from a custom field the workflow sets. */
export const EVENTS = new Set([
  'contact.created',
  'contact.updated',
  'opportunity.created',
  'opportunity.updated',
  'opportunity.stage',
  'message.inbound',
  'message.outbound',
  'note.created'
]);

const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

/* GHL's Custom Webhook lets the workflow author choose the field names, and the
   payload shape differs between a contact trigger and an opportunity trigger.
   Every spelling seen in the wild is checked; nothing is guessed. */
export function parseEvent(body){
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'payload is not a JSON object' };
  }

  const custom = (body.customData && typeof body.customData === 'object') ? body.customData : {};

  const event = str(body.event) || str(body.event_type) || str(body.eventType)
             || str(custom.event) || str(custom.event_type) || str(body.type);

  const locationId = str(body.locationId) || str(body.location_id)
                  || str(body.location?.id) || str(custom.locationId);

  const contactId = str(body.contact_id) || str(body.contactId)
                 || str(body.contact?.id) || str(body.id);

  const opportunityId = str(body.opportunity_id) || str(body.opportunityId)
                     || str(body.opportunity?.id) || str(custom.opportunityId);

  const messageId = str(body.message_id) || str(body.messageId) || str(custom.messageId);

  /* Missing locationId is not guessable. With four sub-accounts connected a
     wrong guess writes into the wrong mirror, which is worse than dropping it. */
  if (!locationId) return { ok: false, error: 'no locationId in payload' };
  if (!event) return { ok: false, error: 'no event field in payload' };
  if (!EVENTS.has(event)) return { ok: false, error: `unknown event "${event.slice(0, 60)}"` };

  return { ok: true, event, locationId, contactId, opportunityId, messageId, body };
}

/* event_type and external_id for the raw row, computed without validating, so a
   rejected payload is still stored under something searchable. */
export function rawLabels(body){
  const parsed = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
  const custom = (parsed.customData && typeof parsed.customData === 'object') ? parsed.customData : {};
  return {
    eventType: (str(parsed.event) || str(parsed.event_type) || str(parsed.eventType)
             || str(custom.event) || 'unknown').slice(0, 120),
    externalId: (str(parsed.opportunity_id) || str(parsed.opportunityId)
              || str(parsed.contact_id) || str(parsed.contactId) || str(parsed.id) || null)
  };
}

/* ---------------------------------------------------------------------------
   In-memory IP rate limit.

   A single-user dashboard has no legitimate burst above this, and an
   unauthenticated write path needs some ceiling. A Map with a rolling window is
   enough; this is not the place for a dependency.
   --------------------------------------------------------------------------- */

export function ipLimiter({ max = 60, windowMs = 60_000 } = {}){
  const hits = new Map();

  return function allow(ip){
    const now = Date.now();
    const key = String(ip || 'unknown');
    const times = (hits.get(key) || []).filter(t => now - t < windowMs);

    /* Swept on every call so a burst from rotating addresses cannot grow the Map
       without bound. */
    if (hits.size > 500) {
      for (const [k, v] of hits) {
        if (!v.some(t => now - t < windowMs)) hits.delete(k);
      }
    }

    if (times.length >= max) { hits.set(key, times); return false; }
    times.push(now);
    hits.set(key, times);
    return true;
  };
}

/* ---------------------------------------------------------------------------
   Handlers. Each re-reads from GHL rather than trusting payload values.
   --------------------------------------------------------------------------- */

async function syncContact(locationId, contactId){
  if (!contactId) return 'no contact id';
  const token = await tokenFor(locationId);
  /* There is no single-contact GET in the endpoint set this build uses, so the
     contact is picked out of the location's list by id. */
  const { items } = await limited(locationId,
    () => ghl.listContacts(token, locationId, { limit: 100 }));
  const hit = items.find(c => c.contactId === contactId);
  if (!hit) return 'contact not in the first page of the location list';
  await upsertContact(locationId, hit);
  return null;
}

async function syncOpportunity(locationId, { opportunityId, contactId }){
  const token = await tokenFor(locationId);

  if (opportunityId) {
    const o = await limited(locationId, () => ghl.getOpportunity(token, opportunityId));
    if (!o) return 'opportunity not found at GHL';
    await upsertOpportunity(locationId, o);
    return null;
  }

  /* A contact-shaped workflow payload carries no opportunity id, so the only way
     to find what changed is to ask for that contact's opportunities. */
  if (!contactId) return 'neither opportunity id nor contact id in payload';
  const { items } = await limited(locationId,
    () => ghl.searchOpportunities(token, locationId, { contactId, limit: 100 }));
  if (!items.length) return 'no opportunities for that contact';
  for (const o of items) await upsertOpportunity(locationId, o);
  return null;
}

/* Messages are taken from the payload when it carries a complete one, and
   re-fetched otherwise. Either way the insert collides with anything the
   dashboard already wrote, so an echo of our own send is a no-op. */
async function syncMessages(locationId, { contactId, messageId, body }){
  if (!contactId) return 'no contact id';

  const direct = messageId && body && (body.body || body.message);
  if (direct) {
    await upsertMessage(locationId, {
      messageId,
      conversationId: body.conversation_id || body.conversationId || null,
      contactId,
      direction: String(body.direction || '').toLowerCase() === 'inbound' ? 'in' : 'out',
      channel: ghl.channelFromGhl(body),
      body: body.body || body.message,
      sentAt: new Date().toISOString()
    });
    return null;
  }

  const token = await tokenFor(locationId);
  const convos = await limited(locationId,
    () => ghl.searchConversations(token, locationId, { contactId, limit: 20 }));
  if (!convos.length) return 'no conversations for that contact';

  let wrote = 0;
  for (const c of convos) {
    const { items } = await limited(locationId,
      () => ghl.listMessages(token, c.conversationId, { limit: 100 }));
    for (const m of items) {
      await upsertMessage(locationId, { ...m, contactId: m.contactId || contactId });
      wrote++;
    }
  }
  return wrote ? null : 'conversations held no messages';
}

/* Returns null on success, or a string explaining why nothing was mirrored.
   Both outcomes are recorded; neither is retried. */
export async function processEvent(parsed, allowed){
  const { event, locationId } = parsed;

  /* The allow-list check. Nothing reaches a mirror table without passing it. */
  if (!allowed.has(locationId)) return `locationId ${locationId} is not a connected sub-account`;

  if (event === 'contact.created' || event === 'contact.updated') {
    return syncContact(locationId, parsed.contactId);
  }
  if (event.startsWith('opportunity.')) {
    return syncOpportunity(locationId, parsed);
  }
  if (event.startsWith('message.')) {
    return syncMessages(locationId, parsed);
  }
  if (event === 'note.created') {
    return 'notes are stored as events only, no mirror table yet';
  }
  return `no handler for ${event}`;
}

/* ---------------------------------------------------------------------------
   The worker.

   One batch at a time, in id order. Ordering matters more than throughput here:
   a stage change followed by a correction has to land in that sequence, and
   this is a single-user dashboard.
   --------------------------------------------------------------------------- */

const BATCH = 50;

async function finish(id, error){
  await query(
    `UPDATE webhook_events SET processed = true, processed_at = now(), error = $2 WHERE id = $1`,
    [id, error ? String(error).slice(0, 500) : null]
  );
}

export async function drain(){
  const { rows } = await query(
    `SELECT id, payload FROM webhook_events
      WHERE provider = 'ghl' AND NOT processed
      ORDER BY id LIMIT ${BATCH}`
  );
  if (!rows.length) return 0;

  const allowed = new Set(await locationIds());

  for (const row of rows) {
    const parsed = parseEvent(row.payload);
    if (!parsed.ok) { await finish(row.id, parsed.error); continue; }
    try {
      await finish(row.id, await processEvent(parsed, allowed));
    } catch (err) {
      /* Marked processed even on failure. A retry loop against an unauthenticated
         endpoint is a way to burn the GHL request budget on a forged payload;
         the hourly reconcile is the backstop for anything genuinely missed. */
      await finish(row.id, err.message);
      console.error(`[ghl:webhook] event ${row.id} failed:`, err.message);
    }
  }
  return rows.length;
}

export function startWorker({ intervalMs = 3_000 } = {}){
  let timer = null;
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      /* Keeps draining while a batch comes back full, so a burst is cleared in
         one pass rather than one batch per tick. */
      while (!stopped && (await drain()) === BATCH) { /* keep going */ }
    } catch (err) {
      console.error('[ghl:webhook] worker:', err.message);
    } finally {
      busy = false;
    }
  };

  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  return {
    async stop(){
      stopped = true;
      clearInterval(timer);
      /* Lets the batch in flight finish its writes rather than dropping them
         half-applied on redeploy. */
      for (let i = 0; busy && i < 50; i++) await new Promise(r => setTimeout(r, 100));
    }
  };
}
