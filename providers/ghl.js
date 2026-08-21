/* GoHighLevel, via Private Integration Tokens.

   Not OAuth. A PIT is a long-lived scoped token generated in a sub-account's own
   UI. It behaves like a fixed access token: nothing renews it, and it only
   changes when rotated by hand. One token per sub-account, so a three-location
   agency is three rows.

   The consequence worth stating: when a token is rotated or revoked in GHL,
   calls simply start failing and the only fix is pasting a new one. So the first
   401 sets status='reauth' and surfaces it rather than retrying forever.

   ---------------------------------------------------------------------------
   THIS MODULE DOES NOT READ GHL DATA.

   Supabase is the source of truth for contacts, opportunities, conversations
   and messages; an external pipeline (a backfill script and n8n webhooks) fills
   it, and command-center reads it through lib/ghl-data.js. What remains here is
   the narrow set of calls that must reach GHL because GHL owns the side effect:

     - sending a message, because GHL owns delivery
     - verifying a token, because nothing else can prove it is valid and scoped
     - the two record writes the detail panel makes

   The paging, cursors and mirroring that used to live here are gone. If a screen
   needs data that is not in Supabase, that is a gap in the ingest pipeline to
   fix there, not a reason to add a read back into this file.
   --------------------------------------------------------------------------- */

const BASE = 'https://services.leadconnectorhq.com';

/* ---------------------------------------------------------------------------
   The Version header, per endpoint. Required — omitting it produces failures
   that look like auth problems and are not.

   GHL has two API generations live at once. Which a given endpoint accepts is
   not guessable, and getting it wrong is rarely an error: several endpoints
   answer 200 with an empty list instead, which is indistinguishable from "you
   have no data". That failure mode cost this integration three debugging rounds.

     Endpoint                        Version  Basis
     GET  /locations/{id}            v3       documented
     PUT  /contacts/{id}             v3       documented
     PUT  /opportunities/{id}        v3       documented
     POST /conversations/messages    v3       documented
   --------------------------------------------------------------------------- */

const V3 = 'v3';
const DEFAULT_VERSION = V3;

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
    return new GhlError('The token is valid but missing scopes. Sending needs conversations/message.write; the detail panel also needs contacts.write and opportunities.write.',
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
   Still read, and still respected, even though only sends remain — an outbound
   burst is exactly the thing that trips a 429. */
const readLimits = res => ({
  remaining: Number(res.headers.get('X-RateLimit-Remaining')),
  max: Number(res.headers.get('X-RateLimit-Max')),
  dailyRemaining: Number(res.headers.get('X-RateLimit-Daily-Remaining'))
});

let limitSink = null;
export const onLimits = fn => { limitSink = fn; };

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

/* Proves a token before a row is written. A 200 means it is valid *and* scoped
   to that location, which a token-shape check cannot tell you.

   This is a GET, and it is the one read that stays: it reads a token's own
   permissions, not GHL's business data. Without it a bad paste becomes a send
   that fails much later, against a customer. */
export async function verifyLocation(token, locationId, { signal } = {}){
  const { data } = await call(token, `/locations/${encodeURIComponent(locationId)}`, { signal });
  const loc = data?.location || data;
  if (!loc?.id) {
    throw new GhlError('GHL answered, but with no sub-account in the response.',
      { status: 200, kind: 'other' });
  }
  return { id: String(loc.id), name: loc.name || loc.businessName || locationId };
}

/* ---------------- channels ----------------
   The frontend's codes going out to GHL. Kept as one map so the composer and
   the send path cannot drift. */

export const CHANNEL_TO_GHL = {
  sms: 'SMS',
  email: 'Email',
  wa: 'WhatsApp',
  fb: 'FB',
  ig: 'IG'
};

/* Which channels carry a subject and a rich body rather than plain text. */
export const IS_EMAIL_CHANNEL = channel => String(channel).toLowerCase() === 'email';

/* ---------------- sending ----------------

   Field names verified against the live reference on 2026-08-21:
   https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message

   Two corrections that reference forced, both of the kind that fails silently:

   - conversationId is NOT a request field. It appears only in the response. The
     previous implementation sent it to continue a thread; GHL ignored it. GHL
     groups by contact on its own, so threading still works — but nothing here
     may claim to control it.

   - There is no From-name field. emailFrom sets the address; the display name
     comes from the sender GHL has verified. A fromName input would have been a
     box that changed nothing, which is worse than not offering it.

   status is required, not optional. Omitting it is rejected outright, and
   'pending' is the honest value for a message just handed over — GHL moves it to
   delivered or failed itself. */

const asArray = v => (Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []));

export async function sendMessage(token, {
  type, contactId, message, html, subject,
  emailFrom, emailTo, emailCc, emailBcc, emailReplyMode,
  attachments, fromNumber, replyMessageId, signal
} = {}){
  const body = { type, contactId, status: 'pending' };

  if (type === 'Email') {
    /* html is the email body. Putting HTML in `message` sends the markup as
       plain text, which is what "the email arrived full of tags" looks like. */
    if (html) body.html = html;
    if (message && !html) body.message = message;
    if (subject) body.subject = subject;
    if (emailFrom) body.emailFrom = emailFrom;
    if (emailTo) body.emailTo = emailTo;
    /* Arrays, not comma-separated strings. */
    if (asArray(emailCc).length) body.emailCc = asArray(emailCc);
    if (asArray(emailBcc).length) body.emailBcc = asArray(emailBcc);
    if (emailReplyMode) body.emailReplyMode = emailReplyMode;
  } else {
    body.message = message;
    /* Optional. Left unset, GHL sends from the sub-account's own configured
       number — picking one here would mean guessing at its telephony setup. */
    if (fromNumber) body.fromNumber = fromNumber;
  }

  /* URLs, not multipart. Anything local must be uploaded somewhere first. */
  if (asArray(attachments).length) body.attachments = asArray(attachments);
  if (replyMessageId) body.replyMessageId = replyMessageId;

  const { data } = await call(token, '/conversations/messages',
    { method: 'POST', body, signal, version: V3 });

  /* The send response carries ids and nothing else, so the caller composes the
     row it stores from what it already knows. */
  const id = data?.messageId || data?.msg?.id || data?.message?.id || data?.id;
  if (!id) {
    throw new GhlError('GHL accepted the send but returned no message id, so it cannot be recorded.',
      { status: 200, kind: 'other' });
  }
  return {
    messageId: String(id),
    /* Response-only, and the only place a conversation id may come from. */
    conversationId: data?.conversationId ? String(data.conversationId) : null
  };
}

/* ---------------- record writes ----------------

   The detail panel edits a contact and moves an opportunity. Both are writes to
   records GHL owns, so they go to GHL; the resulting change comes back through
   the webhook and the ingest pipeline. Neither reads anything. */

export async function updateOpportunity(token, opportunityId,
  { pipelineStageId, pipelineId, status, monetaryValue, name, signal } = {}){
  const body = {};
  if (pipelineStageId) body.pipelineStageId = pipelineStageId;
  if (pipelineId) body.pipelineId = pipelineId;
  if (status) body.status = status;
  if (monetaryValue !== undefined) body.monetaryValue = monetaryValue;
  if (name) body.name = name;
  if (!Object.keys(body).length) throw new Error('updateOpportunity called with no fields');

  const { data } = await call(token, `/opportunities/${encodeURIComponent(opportunityId)}`,
    { method: 'PUT', body, signal });
  const o = data?.opportunity || data;
  return o?.id ? { id: String(o.id) } : null;
}

export async function updateContact(token, contactId, fields = {}, { signal } = {}){
  const body = {};
  if (fields.firstName !== undefined) body.firstName = fields.firstName;
  if (fields.lastName !== undefined)  body.lastName = fields.lastName;
  if (fields.email !== undefined)     body.email = fields.email;
  if (fields.phone !== undefined)     body.phone = fields.phone;
  if (fields.tags !== undefined)      body.tags = fields.tags;
  if (!Object.keys(body).length) throw new Error('updateContact called with no fields');

  const { data } = await call(token, `/contacts/${encodeURIComponent(contactId)}`,
    { method: 'PUT', body, signal });
  const c = data?.contact || data;
  return c?.id ? { id: String(c.id) } : null;
}
