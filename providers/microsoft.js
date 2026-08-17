/* Outlook mail and calendar over Microsoft Graph, one grant for both. */

import { message, event, parseAddress, toSnippet } from '../lib/normalise.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function call(token, url, { method = 'GET', body, headers = {} } = {}){
  const res = await fetch(`${GRAPH}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`Graph ${res.status}: ${j.error?.message || res.statusText}`);
  }
  // 202 and 204 come back empty from move, patch and sendMail.
  return res.status === 204 || res.status === 202 ? null : res.json().catch(() => null);
}

const FOLDER = {
  inbox:   'inbox',
  drafts:  'drafts',
  trash:   'deleteditems',
  spam:    'junkemail',
  archive: 'archive'
};

const SELECT = 'id,subject,from,toRecipients,bodyPreview,receivedDateTime,lastModifiedDateTime,isRead,flag';

/* A draft has no sender worth showing, so the row shows its recipient instead.
   The list's initials() already strips a leading "To: " when deriving an
   avatar, which is exactly this case. */
function sender(m, folder){
  if (folder === 'drafts') {
    const to = m.toRecipients?.[0]?.emailAddress;
    if (to) return { from: `To: ${to.name || to.address}`, addr: to.address || '' };
    return { from: 'To: (no recipient)', addr: '' };
  }
  const a = m.from?.emailAddress;
  return a ? parseAddress(a.name ? `${a.name} <${a.address}>` : a.address) : parseAddress('');
}

const shape = (m, acct, folder, body) => {
  const { from, addr } = sender(m, folder);
  return message({
    id: m.id,
    acct,
    folder,
    from,
    addr,
    subject: m.subject,
    snippet: toSnippet(m.bodyPreview),
    body,
    sortKey: Date.parse(m.receivedDateTime || m.lastModifiedDateTime || '') || 0,
    unread: m.isRead === false,
    star: m.flag?.flagStatus === 'flagged'
  });
};

export async function listMail({ token, acct, folder, limit }){
  const name = FOLDER[folder];
  if (!name) throw new Error(`Unknown folder ${folder}`);

  const params = new URLSearchParams({
    $top: String(limit),
    $select: SELECT,
    $orderby: 'receivedDateTime desc'
  });

  /* A mailbox with no Archive folder 404s rather than returning nothing, and
     one missing folder must not fail the whole fan-out. */
  try {
    const res = await call(token, `/me/mailFolders/${name}/messages?${params}`);
    return (res?.value || []).map(m => shape(m, acct, folder));
  } catch (err) {
    if (folder === 'archive' && /404/.test(err.message)) return [];
    throw err;
  }
}

/* Graph keeps a running count on the folder itself, so this is five small reads
   rather than five listings. A mailbox without an Archive folder reports null. */
export async function counts({ token }){
  const out = { inbox: 0, inboxUnread: 0, drafts: 0, trash: 0, spam: 0, archive: null };
  await Promise.all(Object.entries(FOLDER).map(async ([key, name]) => {
    try {
      const f = await call(token, `/me/mailFolders/${name}?$select=totalItemCount,unreadItemCount`);
      out[key] = f?.totalItemCount ?? 0;
      if (key === 'inbox') out.inboxUnread = f?.unreadItemCount ?? 0;
    } catch {
      out[key] = null;
    }
  }));
  return out;
}

export async function getMail({ token, acct, id, folder }){
  const m = await call(token, `/me/messages/${id}?$select=${SELECT},body`);
  const raw = m.body?.content || '';
  const text = m.body?.contentType === 'html'
    ? raw.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
         .replace(/<br\s*\/?>|<\/p>/gi, '\n')
         .replace(/<[^>]+>/g, '')
         .replace(/&nbsp;/g, ' ')
         .replace(/\n{3,}/g, '\n\n')
         .trim()
    : raw;
  return shape(m, acct, folder, text);
}

const patch = (token, id, body) => call(token, `/me/messages/${id}`, { method: 'PATCH', body });

export const setRead = ({ token, id, read }) => patch(token, id, { isRead: Boolean(read) });

export const setStar = ({ token, id, star }) =>
  patch(token, id, { flag: { flagStatus: star ? 'flagged' : 'notFlagged' } });

export const move = ({ token, id, folder }) => {
  const destinationId = FOLDER[folder];
  if (!destinationId) throw new Error(`Cannot move to ${folder}`);
  return call(token, `/me/messages/${id}/move`, { method: 'POST', body: { destinationId } });
};

export const hardDelete = ({ token, id }) =>
  call(token, `/me/messages/${id}`, { method: 'DELETE' });

export const send = ({ token, to, subject, body }) =>
  call(token, '/me/sendMail', {
    method: 'POST',
    body: {
      message: {
        subject: subject || '',
        body: { contentType: 'Text', content: body || '' },
        toRecipients: String(to || '')
          .split(/[,;]/)
          .map(a => a.trim())
          .filter(Boolean)
          .map(address => ({ emailAddress: { address } }))
      },
      saveToSentItems: true
    }
  });

export async function listEvents({ token, cal, from, to }){
  const params = new URLSearchParams({
    startDateTime: from,
    endDateTime: to,
    $select: 'id,subject,location,attendees,start,end,isAllDay',
    $orderby: 'start/dateTime',
    $top: '250'
  });

  /* calendarView, not /me/events: only this endpoint expands a recurring series
     into the instances that fall inside the window. /me/events returns the
     master with its recurrence rule and nothing to place on a grid.

     The timezone is pinned to UTC rather than the configured zone because Graph
     returns start.dateTime as a local wall-clock string with no offset. In any
     other zone that string is ambiguous and new Date() would misread it; in UTC
     it just needs a Z. */
  const res = await call(token, `/me/calendarView?${params}`, {
    headers: { Prefer: 'outlook.timezone="UTC"' }
  });

  return (res?.value || []).map(e => {
    const iso = v => {
      if (!v?.dateTime) return null;
      /* All-day events keep a date-only form so the grid can place them on the
         viewer's calendar day rather than shifting across midnight. */
      return e.isAllDay
        ? v.dateTime.slice(0, 10)
        : (v.dateTime.endsWith('Z') ? v.dateTime : `${v.dateTime}Z`);
    };
    return event({
      id: e.id,
      cal,
      title: e.subject,
      location: e.location?.displayName,
      attendees: (e.attendees || [])
        .map(a => a.emailAddress?.name || a.emailAddress?.address)
        .filter(Boolean),
      start: iso(e.start),
      end: iso(e.end),
      allDay: Boolean(e.isAllDay)
    });
  }).filter(e => e.start && e.end);
}
