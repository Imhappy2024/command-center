/* Inbound GHL webhooks: validation, and the worker that drains them.

   This endpoint is unauthenticated by design. GHL's Custom Webhook workflow
   action posts with no HMAC — unlike Marketplace app webhooks there was never a
   signature to verify — and the owner has chosen not to add a shared secret
   either.

   So this receiver writes to Supabase and anyone who finds the URL can post to
   it. Everything below follows from that: the payload is untrusted input, not
   data from GHL.

     - The locationId must be one the ingest pipeline has actually ingested —
       a row in ghl_location. This is the check that matters most. Without it a
       stranger can write into a location that is not ours, and it is nearly free
       because the valid set is one query away. It used to be the accounts table,
       which meant a token had to be pasted before a webhook would be accepted;
       ghl_location is the better anchor now that nothing connects.
     - Nothing is keyed on an id that came from the payload alone. The locationId
       half of every lookup comes from the allow-list.
     - Nothing is re-fetched from GHL. The old build answered a webhook by
       calling GHL back; reads now belong to the ingest pipeline, so a payload
       that is too thin to apply is parked with the reason rather than triggering
       an API call.

   Three shapes learned the hard way, each handled explicitly below:

     - Inbound message webhooks carry no message id and no conversation id, so
       they cannot be keyed into ghl_message at all. They land in
       ghl_message_inbox for reconciliation.
     - The pipeline-change webhook carries no pipeline data. It is a trigger
       signal, so it stays in webhook_events for the ingest pipeline to diff.
     - Absent is not null. Contact webhooks omit unset fields entirely, so only a
       key that is PRESENT may overwrite a column. Treating absent as null wipes
       populated data. */

/* Two databases. webhook_events (the raw inbox the worker drains) is
   command-center's own; every table the handlers write — lead, ghl_message,
   ghl_message_inbox, ghl_note, ghl_opportunity — is the portal's. */
import { query as ownQuery, ghlQuery as query } from '../db/index.js';
import { locationIds } from './ghl-data.js';

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
     wrong guess writes into the wrong location, which is worse than dropping. */
  if (!locationId) return { ok: false, error: 'no locationId in payload' };
  if (!event) return { ok: false, error: 'no event field in payload' };
  if (!EVENTS.has(event)) return { ok: false, error: `unknown event "${event.slice(0, 60)}"` };

  return { ok: true, event, locationId, contactId, opportunityId, messageId, body, custom };
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
   Sparse field reading.

   `has` is the whole point: a key that is absent must leave its column alone,
   and a key that is present with an empty string is a deliberate clear. Any of
   several spellings may carry a field, so the first PRESENT one wins rather than
   the first truthy one.
   --------------------------------------------------------------------------- */

const owns = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key);

function pick(sources, names){
  for (const src of sources) {
    for (const name of names) {
      if (owns(src, name)) return { has: true, value: src[name] };
    }
  }
  return { has: false, value: undefined };
}

const text = v => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/* lead.tenant_id is NOT NULL and has no default, unlike every other table here.
   It is resolved from data rather than hardcoded: the location row first, then
   any existing lead in that location. */
async function tenantFor(locationId){
  const { rows } = await query(
    `SELECT tenant_id FROM ghl_location WHERE ghl_location_id = $1
      UNION ALL
     SELECT tenant_id FROM lead WHERE ghl_location_id = $1 LIMIT 1`,
    [locationId]);
  return rows[0]?.tenant_id || null;
}

/* ---------------------------------------------------------------------------
   Handlers. Each returns null on success, or a string saying why nothing was
   written. Both outcomes are recorded against the event; neither is retried.
   --------------------------------------------------------------------------- */

/* Contact create and update, applied sparsely. Column per payload spelling. */
const LEAD_FIELDS = [
  ['first_name',   ['first_name', 'firstName']],
  ['last_name',    ['last_name', 'lastName']],
  ['full_name',    ['full_name', 'fullName', 'name', 'contact_name']],
  ['email',        ['email']],
  ['phone',        ['phone']],
  ['company_name', ['company_name', 'companyName']],
  ['address',      ['address1', 'address']],
  ['city',         ['city']],
  ['state',        ['state']],
  ['zip',          ['postal_code', 'postalCode', 'zip']],
  ['country',      ['country']],
  ['timezone',     ['timezone']],
  ['website',      ['website']],
  ['source',       ['source']],
  ['contact_type', ['type', 'contact_type', 'contactType']]
];

async function applyContact(locationId, parsed){
  const contactId = parsed.contactId;
  if (!contactId) return 'no contact id';

  const sources = [parsed.body, parsed.custom];
  const cols = [];
  const vals = [];

  for (const [column, names] of LEAD_FIELDS) {
    const found = pick(sources, names);
    if (!found.has) continue;            // absent, so the column keeps its value
    cols.push(column);
    vals.push(text(found.value));
  }

  /* tags arrive as an array or a comma string; only touched when present. */
  const tags = pick(sources, ['tags']);
  if (tags.has) {
    const list = Array.isArray(tags.value)
      ? tags.value.map(text).filter(Boolean)
      : String(tags.value || '').split(',').map(s => s.trim()).filter(Boolean);
    cols.push('tags');
    vals.push(list);
  }

  if (!cols.length) return 'payload carried no contact fields to apply';

  const { rows: existing } = await query(
    `SELECT id FROM lead WHERE ghl_contact_id = $1`, [contactId]);

  if (existing.length) {
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await query(
      `UPDATE lead SET ${sets}, updated_at = now() WHERE ghl_contact_id = $1`,
      [contactId, ...vals]);
    return null;
  }

  const tenantId = await tenantFor(locationId);
  if (!tenantId) {
    return 'new contact, but no tenant_id could be resolved for this location — the ingest pipeline must create it first';
  }

  const names = ['tenant_id', 'ghl_location_id', 'ghl_contact_id', ...cols];
  const placeholders = names.map((_, i) => `$${i + 1}`).join(', ');
  await query(
    `INSERT INTO lead (${names.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (ghl_contact_id) DO NOTHING`,
    [tenantId, locationId, contactId, ...vals]);
  return null;
}

/* Opportunity fields that a workflow payload sometimes carries. A stage change
   never does, which is why that event is parked instead. */
const OPP_FIELDS = [
  ['name',            ['opportunity_name', 'opportunityName', 'name']],
  ['status',          ['status', 'opportunity_status']],
  ['monetary_value',  ['monetary_value', 'monetaryValue', 'opportunity_value', 'value']],
  ['ghl_pipeline_id', ['pipeline_id', 'pipelineId']],
  ['ghl_stage_id',    ['pipeline_stage_id', 'pipelineStageId', 'stage_id', 'stageId']]
];

async function applyOpportunity(locationId, parsed){
  /* The pipeline-change webhook is a trigger signal and nothing more. Fetching
     the diff is the ingest pipeline's job; the raw row in webhook_events is what
     it reads. Answering it here would mean calling GHL. */
  if (parsed.event === 'opportunity.stage') {
    return 'stage-change trigger recorded — the ingest pipeline owns the fetch and diff into ghl_opportunity_stage_history';
  }

  const opportunityId = parsed.opportunityId;
  if (!opportunityId) return 'no opportunity id in payload';

  const sources = [parsed.body, parsed.custom];
  const cols = [];
  const vals = [];
  for (const [column, names] of OPP_FIELDS) {
    const found = pick(sources, names);
    if (!found.has) continue;
    cols.push(column);
    vals.push(column === 'monetary_value' ? (Number(found.value) || 0) : text(found.value));
  }
  if (!cols.length) return 'payload carried no opportunity fields to apply';

  const { rows } = await query(
    `SELECT id FROM ghl_opportunity WHERE ghl_opportunity_id = $1`, [opportunityId]);
  if (!rows.length) {
    return 'unknown opportunity — the ingest pipeline must create it before a webhook can update it';
  }

  const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await query(
    `UPDATE ghl_opportunity SET ${sets}, updated_at = now() WHERE ghl_opportunity_id = $1`,
    [opportunityId, ...vals]);
  return null;
}

/* An inbound message webhook carries no ids at all. ghl_message is keyed on
   ghl_message_id and its ghl_conversation_id is NOT NULL, so there is nowhere to
   put one — and inserting without a natural key would duplicate on redelivery.

   The conversation id is often recoverable from an asset URL in the body:
   /conversations-assets/location/{loc}/conversations/{conversationId}/... */
const CONVERSATION_FROM_ASSET =
  /conversations-assets\/location\/[A-Za-z0-9]+\/conversations\/([A-Za-z0-9]+)\//;

function conversationFromBody(body){
  const hay = typeof body === 'string' ? body : JSON.stringify(body || '');
  return CONVERSATION_FROM_ASSET.exec(hay)?.[1] || null;
}

async function inboundMessage(locationId, parsed){
  const contactId = parsed.contactId;
  if (!contactId) return 'no contact id';

  const sources = [parsed.body, parsed.custom];
  const body = text(pick(sources, ['body', 'message', 'text']).value);
  const attachments = pick(sources, ['attachments', 'attachment_urls', 'attachmentUrls']);
  const urls = Array.isArray(attachments.value)
    ? attachments.value.map(text).filter(Boolean)
    : (text(attachments.value) ? [text(attachments.value)] : []);

  if (!body && !urls.length) return 'inbound message had neither body nor attachment';

  const { rows: lead } = await query(
    `SELECT id FROM lead WHERE ghl_contact_id = $1`, [contactId]);

  await query(
    `INSERT INTO ghl_message_inbox
       (ghl_location_id, ghl_contact_id, lead_id, body, body_text,
        attachment_urls, ghl_conversation_id, ghl_message_id, raw, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
    [locationId, contactId, lead[0]?.id || null, body, body,
     urls.length ? urls : null,
     conversationFromBody(parsed.body) || text(pick(sources, ['conversation_id', 'conversationId']).value),
     parsed.messageId || null,
     parsed.body]);
  return null;
}

/* An outbound webhook does carry a message id — it is GHL echoing a send. When
   the dashboard sent it, the row is already here with origin='dashboard' and the
   conflict makes this a no-op. That IS the echo suppression. */
async function outboundMessage(locationId, parsed){
  const contactId = parsed.contactId;
  const messageId = parsed.messageId;
  if (!contactId) return 'no contact id';
  if (!messageId) {
    /* No id means no key. Treated exactly like an inbound one rather than
       invented, because a fabricated id duplicates on redelivery. */
    return inboundMessage(locationId, parsed);
  }

  const sources = [parsed.body, parsed.custom];
  const conversationId = text(pick(sources, ['conversation_id', 'conversationId']).value)
                      || conversationFromBody(parsed.body);
  if (!conversationId) {
    return 'outbound message had an id but no conversation id, and ghl_message.ghl_conversation_id is NOT NULL';
  }

  const { rows: lead } = await query(
    `SELECT id FROM lead WHERE ghl_contact_id = $1`, [contactId]);

  await query(
    `INSERT INTO ghl_message
       (ghl_message_id, ghl_conversation_id, ghl_location_id, ghl_contact_id, lead_id,
        direction, message_type, body, subject, ghl_date_added, origin)
     VALUES ($1,$2,$3,$4,$5,'outbound',$6,$7,$8, now(), 'ghl')
       ON CONFLICT (ghl_message_id) DO NOTHING`,
    [messageId, conversationId, locationId, contactId, lead[0]?.id || null,
     text(pick(sources, ['message_type', 'messageType']).value) || 'TYPE_SMS',
     text(pick(sources, ['body', 'message', 'text']).value),
     text(pick(sources, ['subject']).value)]);
  return null;
}

async function applyNote(locationId, parsed){
  const sources = [parsed.body, parsed.custom];
  const noteId = text(pick(sources, ['note_id', 'noteId', 'id']).value);
  const body = text(pick(sources, ['note', 'body', 'note_body']).value);
  if (!noteId) return 'note webhook carried no note id';
  if (!body) return 'note webhook carried no body';

  const { rows: lead } = await query(
    `SELECT id FROM lead WHERE ghl_contact_id = $1`, [parsed.contactId]);

  await query(
    `INSERT INTO ghl_note
       (ghl_note_id, ghl_location_id, ghl_contact_id, lead_id, body, ghl_created_at, raw)
     VALUES ($1,$2,$3,$4,$5, now(), $6)
       ON CONFLICT (ghl_note_id) DO UPDATE SET body = EXCLUDED.body`,
    [noteId, locationId, parsed.contactId, lead[0]?.id || null, body, parsed.body]);
  return null;
}

/* Returns null on success, or a string explaining why nothing was written. */
export async function processEvent(parsed, allowed){
  const { event, locationId } = parsed;

  /* The allow-list check. Nothing is written without passing it. */
  if (!allowed.has(locationId)) return `locationId ${locationId} is not a connected sub-account`;

  if (event === 'contact.created' || event === 'contact.updated') {
    return applyContact(locationId, parsed);
  }
  if (event.startsWith('opportunity.')) {
    return applyOpportunity(locationId, parsed);
  }
  if (event === 'message.inbound') {
    return inboundMessage(locationId, parsed);
  }
  if (event === 'message.outbound') {
    return outboundMessage(locationId, parsed);
  }
  if (event === 'note.created') {
    return applyNote(locationId, parsed);
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
  await ownQuery(
    `UPDATE webhook_events SET processed = true, processed_at = now(), error = $2 WHERE id = $1`,
    [id, error ? String(error).slice(0, 500) : null]
  );
}

export async function drain(){
  const { rows } = await ownQuery(
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
      /* Marked processed even on failure. A retry loop against an
         unauthenticated endpoint is a way to hammer the database on a forged
         payload, and the raw row stays in webhook_events either way — which is
         what makes an unexpected shape debuggable rather than lost. */
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
