/* Gmail and Google Calendar over one grant. */

import { message, event, parseAddress, toSnippet } from '../lib/normalise.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

async function call(token, url, { method = 'GET', body } = {}){
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`Gmail ${res.status}: ${j.error?.message || res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

/* Archive is "not in any of the other four", which is the only way Gmail can
   express it — there is no archive label, only the absence of INBOX. */
const QUERY = {
  inbox:   'in:inbox',
  drafts:  'in:drafts',
  trash:   'in:trash',
  spam:    'in:spam',
  archive: '-in:inbox -in:trash -in:spam -in:drafts'
};

const header = (headers, name) =>
  headers?.find(h => h.name.toLowerCase() === name)?.value || '';

/* A draft has no sender worth showing, so the row shows its recipient instead.
   The list's initials() already strips a leading "To: " when deriving an
   avatar, which is exactly this case. */
function sender(headers, folder){
  if (folder === 'drafts') {
    const to = header(headers, 'to');
    if (!to) return { from: 'To: (no recipient)', addr: '' };
    const parsed = parseAddress(to.split(',')[0]);
    return { from: `To: ${parsed.from}`, addr: parsed.addr };
  }
  return parseAddress(header(headers, 'from'));
}

/* Prefers text/plain. Walks the whole tree because multipart/alternative nests
   arbitrarily deep once forwards and attachments are involved. */
function extractBody(payload){
  const found = { plain: '', html: '' };

  (function walk(part){
    if (!part) return;
    const type = part.mimeType || '';
    const data = part.body?.data;
    if (data && type === 'text/plain' && !found.plain) {
      found.plain = Buffer.from(data, 'base64url').toString('utf8');
    } else if (data && type === 'text/html' && !found.html) {
      found.html = Buffer.from(data, 'base64url').toString('utf8');
    }
    (part.parts || []).forEach(walk);
  })(payload);

  if (found.plain) return found.plain;
  /* The reader escapes whatever it is given and renders it as text, so markup
     would show up as literal tags. Strip to something readable instead. */
  return found.html
    ? found.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
                .replace(/<br\s*\/?>|<\/p>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
      : '';
}

/* Gmail's list endpoint returns ids only, so each row costs a second request.
   format=metadata keeps those cheap: headers, snippet, labels and internalDate
   with no message bodies. Bodies arrive when a message is actually opened. */
async function hydrate(token, ids, acct, folder){
  const out = [];
  const queue = [...ids];

  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const m = await call(token, `${GMAIL}/messages/${id}?format=metadata`
        + '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date');
      const { from, addr } = sender(m.payload?.headers, folder);
      out.push(message({
        id: m.id,
        acct,
        folder,
        from,
        addr,
        subject: header(m.payload?.headers, 'subject'),
        snippet: toSnippet(m.snippet),
        sortKey: Number(m.internalDate) || Date.parse(header(m.payload?.headers, 'date')) || 0,
        unread: (m.labelIds || []).includes('UNREAD'),
        star: (m.labelIds || []).includes('STARRED')
      }));
    }
  };

  // Six at a time: enough to hide the round trips, far short of a rate limit.
  await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
  return out.sort((a, b) => b.sortKey - a.sortKey);
}

export async function listMail({ token, acct, folder, limit }){
  const q = QUERY[folder];
  if (!q) throw new Error(`Unknown folder ${folder}`);

  /* Without includeSpamTrash, messages.list filters spam and trash out before
     the query is applied, so in:trash and in:spam both come back empty. */
  const params = new URLSearchParams({
    q,
    maxResults: String(limit),
    includeSpamTrash: String(folder === 'trash' || folder === 'spam')
  });

  const list = await call(token, `${GMAIL}/messages?${params}`);
  const ids = (list.messages || []).map(m => m.id);
  return ids.length ? hydrate(token, ids, acct, folder) : [];
}

/* Counted from the label resource rather than by listing, which turns five
   paginated searches into four tiny reads. Archive has no label — it is defined
   by the absence of one — so it has no cheap count and reports null rather than
   a number nobody computed. */
const LABELS = { inbox: 'INBOX', drafts: 'DRAFT', trash: 'TRASH', spam: 'SPAM' };

export async function counts({ token }){
  const out = { inbox: 0, inboxUnread: 0, drafts: 0, trash: 0, spam: 0, archive: null };
  await Promise.all(Object.entries(LABELS).map(async ([key, id]) => {
    try {
      const l = await call(token, `${GMAIL}/labels/${id}`);
      out[key] = l.messagesTotal || 0;
      if (key === 'inbox') out.inboxUnread = l.messagesUnread || 0;
    } catch {
      out[key] = null;
    }
  }));
  return out;
}

export async function getMail({ token, acct, id, folder }){
  const m = await call(token, `${GMAIL}/messages/${id}?format=full`);
  const { from, addr } = sender(m.payload?.headers, folder);
  return message({
    id: m.id,
    acct,
    folder,
    from,
    addr,
    subject: header(m.payload?.headers, 'subject'),
    snippet: toSnippet(m.snippet),
    body: extractBody(m.payload),
    sortKey: Number(m.internalDate) || 0,
    unread: (m.labelIds || []).includes('UNREAD'),
    star: (m.labelIds || []).includes('STARRED')
  });
}

const modify = (token, id, body) =>
  call(token, `${GMAIL}/messages/${id}/modify`, { method: 'POST', body });

export const setRead = ({ token, id, read }) =>
  modify(token, id, read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] });

export const setStar = ({ token, id, star }) =>
  modify(token, id, star ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] });

export async function move({ token, id, folder }){
  if (folder === 'trash') {
    return call(token, `${GMAIL}/messages/${id}/trash`, { method: 'POST' });
  }
  /* Untrashing is its own endpoint — clearing the TRASH label with modify does
     not restore a trashed message. */
  if (folder === 'inbox') {
    await call(token, `${GMAIL}/messages/${id}/untrash`, { method: 'POST' }).catch(() => {});
    return modify(token, id, { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] });
  }
  if (folder === 'archive') return modify(token, id, { removeLabelIds: ['INBOX'] });
  if (folder === 'spam')    return modify(token, id, { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] });
  throw new Error(`Cannot move to ${folder}`);
}

/* users.messages.delete requires the full https://mail.google.com/ scope, which
   grants total mailbox access. Not worth it for a button, so the UI hides
   "Delete forever" on Google accounts rather than offering a failure. */
export function hardDelete(){
  throw new Error('Permanent delete needs Google\'s full-mailbox scope, which this app does not request. Move it to Trash instead — Gmail purges that after 30 days.');
}

/* RFC 2047 for the subject, because a raw non-ASCII header is not legal and
   arrives as mojibake in most clients. */
const encodeHeader = value =>
  /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

export async function send({ token, to, subject, body, replyTo }){
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject || '')}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit'
  ];
  if (replyTo) {
    lines.push(`In-Reply-To: ${replyTo}`, `References: ${replyTo}`);
  }
  const raw = Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body || ''}`, 'utf8').toString('base64url');
  return call(token, `${GMAIL}/messages/send`, { method: 'POST', body: { raw } });
}

export async function listEvents({ token, cal, from, to }){
  const params = new URLSearchParams({
    timeMin: from,
    timeMax: to,
    /* Without singleEvents the API returns recurrence rules rather than the
       instances they generate, so a weekly meeting appears once, on the day the
       series was created, and never again in the grid. */
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250'
  });

  const res = await call(token, `${CAL}?${params}`);
  return (res.items || [])
    .filter(e => e.status !== 'cancelled')
    .map(e => event({
      id: e.id,
      cal,
      title: e.summary,
      location: e.location,
      attendees: (e.attendees || []).map(a => a.displayName || a.email).filter(Boolean),
      // All-day events carry start.date; timed ones carry start.dateTime.
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      allDay: !e.start?.dateTime
    }))
    .filter(e => e.start && e.end);
}
