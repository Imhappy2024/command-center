/* GoHighLevel, via Private Integration Tokens.

   Not OAuth. A PIT is a long-lived scoped token generated in a sub-account's own
   UI. It behaves like a fixed access token: nothing renews it, and it only
   changes when rotated by hand. One token per sub-account, so a three-location
   agency is three rows.

   The consequence worth stating: when a token is rotated or revoked in GHL,
   calls simply start failing and the only fix is pasting a new one. So the first
   401 sets status='reauth' and surfaces it rather than retrying forever. */

const BASE = 'https://services.leadconnectorhq.com';

/* The Version header is required. Omitting it produces failures that look like
   auth problems and are not. */
/* 2021-07-28 is the version nearly every endpoint wants. /opportunities/search is
   the exception: it requires Version: v3, and sending the dated one there makes it
   answer as though nothing matched. Overridable per call for exactly that reason. */
const DEFAULT_VERSION = '2021-07-28';

const headers = (token, version = DEFAULT_VERSION) => ({
  Authorization: `Bearer ${token}`,
  Version: version,
  Accept: 'application/json'
});

export class GhlError extends Error {
  constructor(message, { status, kind }){
    super(message);
    this.status = status;
    this.kind = kind;           // 'auth' | 'scope' | 'notfound' | 'rate' | 'other'
  }
}

function classify(status, body){
  const detail = body?.message || body?.error || '';
  if (status === 401) {
    return new GhlError('That token was rejected. Check it was copied whole, and that it has not been rotated in GHL.',
      { status, kind: 'auth' });
  }
  if (status === 403) {
    return new GhlError('The token is valid but missing scopes. It needs locations.readonly, contacts, opportunities and conversations.',
      { status, kind: 'scope' });
  }
  if (status === 404) {
    return new GhlError('No sub-account with that Location ID, or this token does not cover it.',
      { status, kind: 'notfound' });
  }
  if (status === 429) {
    return new GhlError('GHL is rate limiting this location. Try again in a few seconds.',
      { status, kind: 'rate' });
  }
  return new GhlError(`GHL ${status}${detail ? ': ' + detail : ''}`, { status, kind: 'other' });
}

/* Rate limits are per location: 100 requests per 10 seconds and 200k per day.
   The headers are read so a caller can back off before being throttled rather
   than after. */
const readLimits = res => ({
  remaining: Number(res.headers.get('X-RateLimit-Remaining')),
  max: Number(res.headers.get('X-RateLimit-Max')),
  dailyRemaining: Number(res.headers.get('X-RateLimit-Daily-Remaining'))
});

/* The limiter needs to see the rate-limit headers, but the API functions below
   all return normalised data with the headers stripped. Rather than thread a
   reporter through nine signatures, call() publishes them here and
   lib/ghl-limiter.js subscribes once. */
let limitSink = null;
export const onLimits = fn => { limitSink = fn; };

/* Query string builder that drops absent values, so an optional cursor never
   arrives at GHL as the literal string "undefined". */
export function qs(params){
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    out.set(k, String(v));
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

export async function call(token, path, { method = 'GET', body, signal, version } = {}){
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...headers(token, version),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal
  });

  const limits = readLimits(res);
  if (limitSink) limitSink(limits);

  const json = await res.json().catch(() => null);
  if (!res.ok) throw classify(res.status, json);
  return { data: json, limits };
}

/* Proves a token before a row is written. A 200 means it is valid *and* scoped to
   that location, which a token-shape check cannot tell you. */
export async function verifyLocation(token, locationId, { signal } = {}){
  const { data } = await call(token, `/locations/${encodeURIComponent(locationId)}`, { signal });
  const loc = data?.location || data;
  return {
    id: loc?.id || locationId,
    name: loc?.name || loc?.businessName || locationId
  };
}

/* ---------------------------------------------------------------------------
   Normalisers.

   Everything below returns our own shapes, never a raw GHL payload. GHL is
   inconsistent about field names across endpoints and API versions — contactId
   against contact.id, monetaryValue against value, createdAt against dateAdded,
   camelCase query params on one route and snake_case on the next — so every one
   of those choices is absorbed here and nowhere else.
   --------------------------------------------------------------------------- */

/* GHL returns dates as ISO strings on some endpoints and epoch milliseconds on
   others. Both become an ISO string or null. */
function iso(value){
  if (value == null || value === '') return null;
  const d = typeof value === 'number' || /^\d+$/.test(String(value))
    ? new Date(Number(value))
    : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* customFields arrive as [{id, value}] or [{key, field_value}] depending on the
   endpoint. Flattened to an object so the mirror column is queryable. */
function customMap(fields){
  if (!Array.isArray(fields)) return {};
  const out = {};
  for (const f of fields) {
    const key = f?.key || f?.id;
    if (!key) continue;
    out[key] = f.value ?? f.field_value ?? f.fieldValue ?? null;
  }
  return out;
}

const asContact = c => ({
  contactId: String(c.id),
  name: c.contactName || c.name
    || [c.firstName, c.lastName].filter(Boolean).join(' ')
    || c.email || c.phone || '',
  firstName: c.firstName || null,
  lastName: c.lastName || null,
  phone: c.phone || null,
  email: c.email || null,
  source: c.source || c.attributionSource?.utmSource || null,
  owner: c.assignedTo || null,
  tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
  custom: customMap(c.customFields || c.customField),
  dateAdded: iso(c.dateAdded || c.createdAt)
});

const asPipeline = p => ({
  pipelineId: String(p.id),
  name: p.name || null,
  stages: (p.stages || []).map(s => ({
    id: String(s.id),
    name: s.name || '',
    position: Number(s.position ?? 0) || 0
  }))
});

const asOpportunity = o => ({
  opportunityId: String(o.id),
  contactId: o.contactId ? String(o.contactId) : (o.contact?.id ? String(o.contact.id) : null),
  pipelineId: o.pipelineId ? String(o.pipelineId) : null,
  stageId: o.pipelineStageId ? String(o.pipelineStageId)
         : (o.stageId ? String(o.stageId) : null),
  status: String(o.status || 'open').toLowerCase(),
  name: o.name || null,
  value: Number(o.monetaryValue ?? o.value ?? 0) || 0,
  owner: o.assignedTo || null,
  dateAdded: iso(o.createdAt || o.dateAdded),
  updatedAt: iso(o.updatedAt || o.dateUpdated)
});

const asConversation = c => ({
  conversationId: String(c.id),
  contactId: c.contactId ? String(c.contactId) : null,
  lastMessageAt: iso(c.lastMessageDate || c.dateUpdated || c.dateAdded)
});

/* ---------------- channels ----------------
   One map, used in both directions: the frontend's codes going out to GHL, and
   GHL's message types coming back in. Kept together so they cannot drift. */

export const CHANNEL_TO_GHL = {
  sms: 'SMS',
  email: 'Email',
  wa: 'WhatsApp',
  fb: 'FB',
  ig: 'IG'
};

const GHL_TO_CHANNEL = {
  SMS: 'sms',
  EMAIL: 'email',
  WHATSAPP: 'wa',
  FB: 'fb',
  FACEBOOK: 'fb',
  IG: 'ig',
  INSTAGRAM: 'ig',
  CALL: 'call',
  VOICEMAIL: 'call',
  GMB: 'other',
  LIVE_CHAT: 'other',
  REVIEW: 'other',
  ACTIVITY: 'other'
};

/* messageType looks like 'TYPE_SMS'. The numeric `type` field is undocumented
   and inconsistent, so it is deliberately not consulted — an unrecognised
   channel becomes 'other' rather than a guess. */
export function channelFromGhl(m){
  const raw = String(m?.messageType || m?.type || '').toUpperCase().replace(/^TYPE_/, '');
  return GHL_TO_CHANNEL[raw] || 'other';
}

const asMessage = m => ({
  messageId: String(m.id),
  conversationId: m.conversationId ? String(m.conversationId) : null,
  contactId: m.contactId ? String(m.contactId) : null,
  direction: String(m.direction || '').toLowerCase() === 'inbound' ? 'in' : 'out',
  channel: channelFromGhl(m),
  body: m.body ?? m.message ?? null,
  sentAt: iso(m.dateAdded || m.dateUpdated || m.createdAt)
});

/* ---------------------------------------------------------------------------
   Reads. The paged ones return { items, next }, where next is the cursor to
   hand back, or null once the last page has been reached.
   --------------------------------------------------------------------------- */

export async function listContacts(token, locationId, { startAfterId, startAfter, limit = 100, signal } = {}){
  const { data } = await call(token,
    `/contacts/${qs({ locationId, limit, startAfterId, startAfter })}`, { signal });
  const items = (data?.contacts || []).map(asContact);
  const meta = data?.meta || {};
  /* GHL returns a next cursor even on the final page, so a page short of `limit`
     is the only reliable end-of-list signal. */
  const more = items.length >= limit && (meta.startAfterId || meta.startAfter);
  return {
    items,
    next: more ? { startAfterId: meta.startAfterId, startAfter: meta.startAfter } : null
  };
}

export async function listPipelines(token, locationId, { signal } = {}){
  const { data } = await call(token, `/opportunities/pipelines${qs({ locationId })}`, { signal });
  return (data?.pipelines || []).map(asPipeline);
}

/* contactId is not in the brief's parameter list, but the webhook processor
   needs it: a Custom Webhook payload is contact-shaped, so when an opportunity
   event arrives carrying no opportunity id, asking for that contact's
   opportunities is the only way to find what changed. */
export async function searchOpportunities(token, locationId, { pipelineId, contactId, startAfter, startAfterId, page, limit = 100, signal } = {}){
  /* camelCase, and Version: v3. Both matter: this endpoint documents locationId
     as required, and given location_id instead it does not error — it answers
     with an empty list, which is indistinguishable from a sub-account that has no
     opportunities. That is exactly how a mirror ends up silently empty. */
  const { data } = await call(token, `/opportunities/search${qs({
    locationId,
    pipelineId,
    contactId,
    limit,
    page,
    startAfter,
    startAfterId
  })}`, { signal, version: 'v3' });

  const items = (data?.opportunities || []).map(asOpportunity);

  /* Two pagination schemes live on this endpoint depending on API version: a
     meta cursor, or page/limit with a top-level total. Cursor is preferred when
     offered; page counting is the fallback. A short page ends it either way. */
  const meta = data?.meta || {};
  if (items.length < limit) return { items, next: null };

  if (meta.startAfterId || meta.startAfter) {
    return { items, next: { startAfterId: meta.startAfterId, startAfter: meta.startAfter } };
  }

  const total = Number(data?.total ?? meta.total);
  const current = Number(page) || 1;
  if (Number.isFinite(total) && current * limit >= total) return { items, next: null };
  return { items, next: { page: current + 1 } };
}

export async function getOpportunity(token, opportunityId, { signal } = {}){
  const { data } = await call(token,
    `/opportunities/${encodeURIComponent(opportunityId)}`, { signal });
  const o = data?.opportunity || data;
  return o?.id ? asOpportunity(o) : null;
}

export async function searchConversations(token, locationId, { contactId, startAfterDate, limit = 100, signal } = {}){
  const { data } = await call(token, `/conversations/search${qs({
    locationId,
    contactId,
    startAfterDate,
    limit
  })}`, { signal });
  return (data?.conversations || []).map(asConversation);
}

export async function listMessages(token, conversationId, { lastMessageId, limit = 100, signal } = {}){
  const { data } = await call(token,
    `/conversations/${encodeURIComponent(conversationId)}/messages${qs({ lastMessageId, limit })}`,
    { signal });
  /* Nested on current API versions as { messages: { messages: [], lastMessageId } }
     and a bare array on older ones. */
  const inner = data?.messages;
  const rows = Array.isArray(inner) ? inner : (inner?.messages || []);
  return {
    items: rows.map(asMessage).filter(m => m.sentAt),
    next: inner?.nextPage && inner?.lastMessageId ? { lastMessageId: inner.lastMessageId } : null
  };
}

/* ---------------------------------------------------------------------------
   Writes.
   --------------------------------------------------------------------------- */

/* pipelineId is accepted alongside pipelineStageId because GHL rejects a stage
   change that does not name the pipeline the stage belongs to. */
export async function updateOpportunity(token, opportunityId, { pipelineStageId, pipelineId, status, monetaryValue, name, signal } = {}){
  const body = {};
  if (pipelineStageId !== undefined) body.pipelineStageId = pipelineStageId;
  if (pipelineId !== undefined)      body.pipelineId = pipelineId;
  if (status !== undefined)          body.status = status;
  if (monetaryValue !== undefined)   body.monetaryValue = Number(monetaryValue) || 0;
  if (name !== undefined)            body.name = name;
  if (!Object.keys(body).length) throw new Error('updateOpportunity called with no fields');

  const { data } = await call(token, `/opportunities/${encodeURIComponent(opportunityId)}`,
    { method: 'PUT', body, signal });
  const o = data?.opportunity || data;
  return o?.id ? asOpportunity(o) : null;
}

/* Takes our field names rather than GHL's, so the vocabulary translation stays
   inside this module in both directions. A contact has no single name field in
   GHL, so a display name is split on the first space. */
export async function updateContact(token, contactId, fields = {}, { signal } = {}){
  const body = {};
  if (fields.name !== undefined) {
    const parts = String(fields.name || '').trim().split(/\s+/).filter(Boolean);
    body.firstName = parts.shift() || '';
    body.lastName = parts.join(' ');
  }
  if (fields.phone !== undefined)  body.phone = fields.phone;
  if (fields.email !== undefined)  body.email = fields.email;
  if (fields.owner !== undefined)  body.assignedTo = fields.owner;
  if (fields.source !== undefined) body.source = fields.source;
  if (fields.tags !== undefined)   body.tags = fields.tags;
  if (!Object.keys(body).length) throw new Error('updateContact called with no fields');

  const { data } = await call(token, `/contacts/${encodeURIComponent(contactId)}`,
    { method: 'PUT', body, signal });
  const c = data?.contact || data;
  return c?.id ? asContact(c) : null;
}

export async function sendMessage(token, { type, contactId, message, conversationId, signal } = {}){
  const body = { type, contactId, message };
  if (conversationId) body.conversationId = conversationId;

  const { data } = await call(token, '/conversations/messages',
    { method: 'POST', body, signal });

  /* The send response is not a message object — it carries ids and nothing else
     — so the caller composes the mirror row from what it already knows. */
  const id = data?.messageId || data?.msg?.id || data?.message?.id || data?.id;
  if (!id) {
    throw new GhlError('GHL accepted the send but returned no message id, so it cannot be recorded.',
      { status: 200, kind: 'other' });
  }
  return {
    messageId: String(id),
    conversationId: data?.conversationId ? String(data.conversationId) : (conversationId || null)
  };
}
