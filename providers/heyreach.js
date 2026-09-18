/* LinkedIn, by way of HeyReach.

   There is no LinkedIn connection in this dashboard and there is not going to
   be one. LinkedIn's own API does not sell what this view needs: reading a
   member's inbox is not a product you can apply for, and the Marketing and
   Community Management APIs cover Pages and ads rather than the one-to-one
   conversations an outreach campaign produces. HeyReach already drives those
   conversations, holds them, and exposes them on a documented key -- so
   HeyReach is the LinkedIn provider here, the same way Meta is the Facebook one.

   What that means for the rest of the app:

     - The credential is an API key, not a grant. Nothing to sign in to, no
       refresh, no reauth loop. One key covers the whole workspace.
     - An ACCOUNT here is a HeyReach sender -- one LinkedIn profile that sends
       on your behalf. A workspace with three senders is three rows, three
       toggles in the inbox, exactly like three Facebook Pages.
     - There are no comments. HeyReach automates outreach: connection requests,
       messages, InMails, follows, likes and profile views. It does not read the
       comments under a LinkedIn post, and neither does anything else available
       here, so the comments tab says so rather than sitting empty forever.

   Rate limit is 300 requests a minute across the whole key, which is generous
   for a sync that runs on a webhook, and shared with every other consumer of
   the same key -- so the pacer below is deliberately conservative.
   --------------------------------------------------------------------------- */

const BASE = 'https://api.heyreach.io/api/public';

export class HeyReachError extends Error {
  constructor(message, { status = 0, isAuth = false, retryAfter = null } = {}){
    super(message);
    this.name = 'HeyReachError';
    this.status = status;
    this.isAuth = isAuth;
    this.retryAfter = retryAfter;
  }
}

/* 300 a minute is the documented ceiling for the KEY, not for this process, so
   a second consumer of the same key spends from the same budget. Five a second
   leaves most of it alone and is still far quicker than the fifteen-minute
   timer this replaces. */
const MIN_GAP_MS = 200;
let lastCall = 0;
async function pace(){
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

async function call(key, path, { method = 'POST', body, signal } = {}){
  if (!key) throw new HeyReachError('No HeyReach API key.', { isAuth: true });
  await pace();

  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        'X-API-KEY': key,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });
  } catch (err) {
    throw new HeyReachError(`HeyReach is unreachable: ${err.message}`);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* some endpoints answer empty */ }

  if (res.ok) return json;

  /* 401 is the key; 403 is the key lacking something. Both are fixed by an
     operator and neither is worth retrying, so both mark the row for attention
     rather than being reported as a transient failure. */
  if (res.status === 401 || res.status === 403) {
    throw new HeyReachError(
      'HeyReach rejected the API key. Regenerate it under Settings, Integrations, '
      + 'and set HEYREACH_API_KEY to the new value.',
      { status: res.status, isAuth: true });
  }
  if (res.status === 429) {
    throw new HeyReachError('HeyReach rate limit reached (300 requests a minute for the key).',
      { status: 429, retryAfter: Number(res.headers.get('retry-after')) || null });
  }
  const detail = json?.message || json?.error || json?.title || text.slice(0, 200) || res.statusText;
  throw new HeyReachError(`HeyReach ${path} failed: ${res.status} ${detail}`, { status: res.status });
}

/* ---------------------------------------------------------------------------
   Reading a value that may be spelled several ways.

   HeyReach's own webhook guide says the payload "is not formally documented or
   versioned", and the public Postman collection does not cover the inbox at
   all -- it stops at campaigns, lead lists and accounts. So the spellings below
   are ordered most-likely first and every one of them is tried, rather than one
   being asserted as correct. A rename on their side turns into a column of
   nulls with nothing saying why, which is the failure this is written against.

   Where a name HAS been seen on the wire it is listed first; `first` returns
   the first path that holds something, so the extra candidates cost nothing.
   --------------------------------------------------------------------------- */
const at = (obj, path) => path.split('.')
  .reduce((o, k) => (o == null ? undefined : o[k]), obj);

const first = (obj, paths) => {
  for (const p of paths) {
    const v = at(obj, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

const str = v => (v == null ? null : String(v));

/* HeyReach timestamps come back ISO. Anything unparseable becomes null rather
   than an Invalid Date that Postgres would refuse. */
const when = v => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/* Paging. Every list endpoint takes offset/limit and answers
   { totalCount, items }, and a page that comes back short is the last one. */
async function all(key, path, body, { pageSize = 100, cap = 1000 } = {}){
  const out = [];
  for (let offset = 0; out.length < cap; offset += pageSize) {
    const page = await call(key, path, { body: { ...body, offset, limit: pageSize } });
    const items = page?.items || [];
    out.push(...items);
    if (items.length < pageSize) break;
    if (page?.totalCount != null && out.length >= Number(page.totalCount)) break;
  }
  return out;
}

/* ---------------------------------------------------------------------------
   The API.
   --------------------------------------------------------------------------- */

/* Whether the key works at all. Used at boot before anything is seeded, so a
   bad key is one line in the log rather than four failing syncs. */
export async function checkKey(key){
  await call(key, '/auth/CheckApiKey', { method: 'GET' });
  return true;
}

/* The LinkedIn profiles HeyReach sends as. One becomes one account row. */
export async function senders(key){
  const items = await all(key, '/li_account/GetAll', {}, { pageSize: 100, cap: 300 });
  return items.map(a => ({
    id: str(first(a, ['id', 'linkedInAccountId', 'accountId'])),
    name: str(first(a, ['emailAddress', 'name', 'fullName', 'firstName'])) || 'LinkedIn',
    /* Shown in the sidebar, so the person's name beats their login. */
    label: str(first(a, ['name', 'fullName', 'firstName', 'emailAddress'])) || 'LinkedIn',
    profileUrl: str(first(a, ['linkedInUrl', 'profileUrl', 'linkedInProfileUrl'])),
    avatar: str(first(a, ['profilePictureUrl', 'profilePicture', 'avatarUrl', 'imageUrl'])),
    /* HeyReach reports a sender that has fallen out of session. That is their
       problem to fix in HeyReach, but it explains an inbox that stops moving. */
    status: str(first(a, ['status', 'accountStatus', 'state'])),
    raw: a
  })).filter(a => a.id);
}

/* One sender's conversations, newest first.

   `since` is applied here rather than sent: the inbox filter does not take a
   time bound, and asking for everything and stopping early costs one page more
   than a bounded query would have. A full pass ignores it. */
export async function conversations(key, { senderId, since = null, cap = 200 } = {}){
  const filters = senderId ? { linkedInAccountIds: [Number(senderId) || senderId] } : {};
  const PAGE = 50;
  const out = [];

  for (let offset = 0; out.length < cap; offset += PAGE) {
    const page = await call(key, '/inbox/GetConversationsV2',
      { body: { filters, offset, limit: PAGE } });
    const items = page?.items || [];
    if (!items.length) break;

    let olderSeen = 0;
    for (const c of items) {
      const t = conversationOut(c, { senderId });
      if (!t) continue;
      /* An incremental pass wants what has moved. Filtered rather than
         short-circuited on the first old one, because nothing promises the
         list is ordered by activity and a wrong guess there would silently
         truncate the sync. */
      if (since && t.lastAt && t.lastAt < since) { olderSeen++; continue; }
      out.push(t);
    }

    if (items.length < PAGE) break;
    /* A whole page with nothing new in it. Ordered or not, paging further for
       a cursor-bounded sync is spending requests on conversations that were
       already stored — and a webhook fires this per message. */
    if (since && olderSeen === items.length) break;
  }
  return out;
}

/* A conversation in the shape saveThread() stores.

   kind is always 'message'. LinkedIn comments do not come through here -- see
   the header. */
function conversationOut(c, { senderId } = {}){
  const externalId = str(first(c, [
    'id', 'conversationId', 'chatroomId', 'conversation_id', 'threadId'
  ]));
  if (!externalId) return null;

  /* The lead, which is who the thread is WITH. HeyReach nests this under a
     correspondent or a lead depending on the endpoint. */
  const peer = first(c, ['correspondentProfile', 'correspondent', 'lead', 'profile']) || {};
  const peerName = [
    str(first(peer, ['firstName', 'first_name'])),
    str(first(peer, ['lastName', 'last_name']))
  ].filter(Boolean).join(' ')
    || str(first(peer, ['fullName', 'name', 'headline']))
    || null;

  /* The peer goes down into each message. A LinkedIn conversation has exactly
     two participants, so an inbound message is from this person by definition
     and there is no need for the message object to name them -- which is just
     as well, because across 180 real messages not one of them did. Reading it
     off the conversation is not a guess, it is the only thing it can be. */
  const peerOut = {
    name: peerName,
    avatar: str(first(peer, ['profilePictureUrl', 'profilePicture', 'imageUrl', 'avatarUrl'])),
    id: str(first(peer, ['profileUrl', 'linkedInId', 'memberId', 'id', 'publicIdentifier']))
  };

  const items = (first(c, ['messages', 'chatMessages', 'items']) || [])
    .map(m => messageOut(m, { senderId, peer: peerOut, conversationId: externalId }))
    .filter(Boolean);

  const lastAt = when(first(c, [
    'lastMessageAt', 'lastMessageDate', 'lastActivityAt', 'updatedAt'
  ])) || items[items.length - 1]?.createdAt || null;

  /* HeyReach's own seen flag. saveThread only ever lets a NEWER message set
     unread, so a thread answered here does not light up again on the next pass. */
  const seen = first(c, ['read', 'seen', 'isRead']);

  return {
    externalId,
    /* The campaign the conversation came out of. It is the LinkedIn equivalent
       of the post a comment sits under: the thing that explains why this
       person is in the inbox at all. */
    parentKind: 'campaign',
    parentId: str(first(c, ['campaignId', 'campaign.id'])),
    parentTitle: str(first(c, ['campaignName', 'campaign.name'])),
    parentLink: null,
    parentMedia: {},
    withId: str(first(peer, ['profileUrl', 'linkedInId', 'memberId', 'id', 'publicIdentifier'])),
    withName: peerName,
    withAvatar: str(first(peer, ['profilePictureUrl', 'profilePicture', 'imageUrl', 'avatarUrl'])),
    totalItems: Number(first(c, ['totalMessages', 'messageCount'])) || items.length,
    unread: seen == null ? undefined : !seen,
    lastAt,
    /* A HeyReach conversation can always be answered through HeyReach, as long
       as the sender is still in session. */
    canReply: true,
    items,
    raw: {
      campaignId: str(first(c, ['campaignId', 'campaign.id'])),
      linkedInAccountId: str(first(c, ['linkedInAccountId', 'linkedInAccount.id', 'senderId']))
        || str(senderId)
    }
  };
}

/* One message.

   `mine` decides which side of the thread the bubble lands on, and getting it
   wrong is the most visible possible bug, so it is read from an explicit sender
   flag and never inferred from whether a name is missing. */
function messageOut(m, { senderId, peer = {}, conversationId = '' } = {}){
  const body = str(first(m, ['body', 'text', 'message', 'content'])) || '';
  const createdAt = when(first(m, ['createdAt', 'sentAt', 'timestamp', 'date']));

  /* HeyReach does not put an id on a message. Not "sometimes" -- across 180
     real messages every one of these came back empty, so the fallback is the
     normal path rather than the exception, and it has to be a good key.

     Conversation plus timestamp, NOT the body. Hashing the body looked fine
     until you ask what happens when the same message comes back a character
     different -- trimmed, re-encoded, an emoji normalised -- and the answer is
     a second row in the thread saying the same thing twice. The time a message
     was sent does not change, and two messages in one conversation do not
     share a millisecond. */
  const externalId = str(first(m, [
    'id', 'messageId', 'message_id', 'chatMessageId', 'entityUrn', 'urn', 'externalId'
  ])) || (createdAt ? 'hr:' + hash(conversationId + '|' + createdAt) : null);
  if (!externalId) return null;

  const senderish = first(m, [
    'sender', 'from', 'senderType', 'direction', 'isSender', 'sentByUser'
  ]);
  const mine = isOutbound(senderish, m, senderId);
  return {
    externalId,
    replyTo: null,
    authorId: str(first(m, ['senderId', 'sender.id', 'fromId']))
      || (mine ? str(senderId) : peer.id),
    /* Ours or theirs, and theirs is the person the conversation is with. Left
       to the message object this was 'Unknown' on every row. Our own name is
       filled in by the caller, which knows the account label. */
    authorName: str(first(m, ['senderName', 'sender.name', 'from.name']))
      || (mine ? null : peer.name),
    authorAvatar: str(first(m, ['senderPictureUrl', 'sender.profilePictureUrl']))
      || (mine ? null : peer.avatar),
    mine,
    body,
    likes: 0,
    likedByUs: false,
    reactions: [],
    /* HeyReach returns InMail and message alike as text. An attachment, where
       one exists, arrives as a URL rather than bytes. */
    attachments: attachmentsOut(m),
    createdAt,
    raw: {}
  };
}

/* Whose message it is.

   Several spellings, checked in order of how unambiguous they are. A string
   direction wins over a boolean, a boolean over an id comparison, and an id
   comparison over nothing -- and when nothing says, it is treated as theirs,
   because an inbound message shown on the wrong side is a smaller lie than an
   outbound one that looks like the lead wrote it. */
function isOutbound(senderish, m, senderId){
  const s = typeof senderish === 'string' ? senderish.toUpperCase() : null;
  if (s) {
    if (['SENDER', 'ME', 'US', 'OUTBOUND', 'OUTGOING', 'USER'].includes(s)) return true;
    if (['CORRESPONDENT', 'LEAD', 'THEM', 'INBOUND', 'INCOMING'].includes(s)) return false;
  }
  for (const k of ['isSender', 'sentByUser', 'isOutbound', 'fromMe']) {
    if (typeof m?.[k] === 'boolean') return m[k];
  }
  const from = str(first(m, ['senderId', 'sender.id', 'linkedInAccountId']));
  if (from && senderId) return String(from) === String(senderId);
  return false;
}

function attachmentsOut(m){
  const list = first(m, ['attachments', 'files', 'media']);
  if (!Array.isArray(list)) return [];
  return list.map(a => ({
    kind: str(first(a, ['type', 'kind'])) || 'file',
    url: str(first(a, ['url', 'downloadUrl', 'link'])),
    name: str(first(a, ['name', 'fileName', 'filename']))
  })).filter(a => a.url);
}

/* A stable id for a message HeyReach did not give one to, so the same message
   does not arrive as a new row on every sync. */
function hash(s){
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* Replying. HeyReach sends as the LinkedIn profile that owns the conversation,
   so nothing here chooses a sender -- the conversation already did. */
export async function sendMessage(key, { conversationId, senderId, profileUrl, text }){
  const body = {
    conversationId,
    linkedInAccountId: Number(senderId) || senderId,
    profileUrl,
    message: text
  };
  const res = await call(key, '/inbox/SendMessage', { body });
  return {
    externalId: str(first(res || {}, ['id', 'messageId', 'conversationId'])) || null,
    raw: res || {}
  };
}

export const heyreachBase = BASE;
