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

/* ---------------------------------------------------------------------------
   App-only access to one mailbox.

   The delegated flow above is a person signing in and granting this app their
   own mailbox. That is the right model for the owner's account and the wrong
   one for somebody else's calendar: it needs Chris sitting at a browser, and
   the grant dies with his refresh token.

   Client credentials instead. The app authenticates as itself against the
   tenant and reads a named mailbox, which needs Calendars.ReadWrite as an
   APPLICATION permission with admin consent — not the delegated one of the
   same name. Nobody signs in and nothing expires but the hour-long token.

   Two things reliably go wrong and are worth naming rather than debugging:

     - MS_TENANT_ID must be the real tenant id. 'common' is a multi-tenant
       placeholder that only means anything for an interactive sign-in, and
       client credentials against it fail with an unhelpful 400.
     - Every path is /users/<upn>. There is no /me when nobody is signed in,
       and Graph answers /me with a 400 that says the token is missing a
       user context.
   --------------------------------------------------------------------------- */

export function appConfigured(env){
  return Boolean(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET
    && env.MS_TENANT_ID && env.MS_SERVICE_USER);
}

export async function appToken(env){
  const tenant = String(env.MS_TENANT_ID || '').trim();
  if (!tenant || tenant === 'common' || tenant === 'organizations') {
    throw new Error('MS_TENANT_ID must be the tenant id (a GUID or a domain) for app-only '
      + `access. "${tenant || 'unset'}" is a sign-in placeholder and has no tenant to `
      + 'authenticate against.');
  }
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}`
    + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default'
    })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    /* Azure's description is the actionable half — it names the missing
       consent or the wrong secret outright. */
    throw new Error('Microsoft refused the app credentials: '
      + (j.error_description?.split(/[\r\n]/)[0] || j.error || res.statusText));
  }
  return {
    accessToken: j.access_token,
    /* There is no refresh token in this flow; the credential IS the client
       secret, and a new access token is one request away. The stored value
       keeps the accounts row's shape. */
    refreshToken: 'client_credentials',
    expiresAt: Date.now() + (Number(j.expires_in || 3600) - 120) * 1000,
    scope: 'https://graph.microsoft.com/.default'
  };
}

/* /users/<upn> for an app-only token, /me for a delegated one. */
const box = mailbox => (mailbox ? `/users/${encodeURIComponent(mailbox)}` : '/me');

export async function listEvents({ token, cal, from, to, mailbox = null }){
  const params = new URLSearchParams({
    startDateTime: from,
    endDateTime: to,
    $select: 'id,subject,location,attendees,start,end,isAllDay,'
      + 'onlineMeeting,onlineMeetingUrl,isOnlineMeeting,bodyPreview',
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
  const res = await call(token, `${box(mailbox)}/calendarView?${params}`, {
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
      /* Teams fills onlineMeeting.joinUrl. onlineMeetingUrl is the older
         field and is still what some tenants populate, so both are read.
         Anything else -- a Zoom link pasted into the invite -- comes out of
         the body preview, which is why it is selected at all. */
      join: e.onlineMeeting?.joinUrl || e.onlineMeetingUrl || null,
      notes: e.bodyPreview,
      attendees: (e.attendees || [])
        .map(a => a.emailAddress?.name || a.emailAddress?.address)
        .filter(Boolean),
      start: iso(e.start),
      end: iso(e.end),
      allDay: Boolean(e.isAllDay)
    });
  }).filter(e => e.start && e.end);
}

/* ---------------------------------------------------------------------------
   Writing events.

   Where a meeting happens is two choices and not a free-text box, because a
   free-text box is how "location" became a field nobody can act on: half the
   events in this calendar carry a street address, a room name or nothing, and
   the dashboard's Join button has to guess a link out of prose.

     teams   Graph makes the meeting. isOnlineMeeting with the provider named,
             and it returns a real joinUrl on the created event.
     zoom    There is no Zoom provider in Graph, and there is not going to be
             one. The standing room URL goes in as the location and again in
             the body, which is where listEvents already looks for a link that
             is not a Teams one.

   Times are sent with an explicit timeZone rather than as UTC instants. Graph
   stores the wall clock and the zone, so an event created for 2pm Central
   stays 2pm Central through a daylight-saving change; converting to UTC here
   would freeze the offset and move the meeting an hour in November.
   --------------------------------------------------------------------------- */

const asGraphTime = (local, tz) => ({ dateTime: local, timeZone: tz });

function bodyFor({ notes, place, zoomUrl }){
  const lines = [];
  if (notes) lines.push(String(notes));
  if (place === 'zoom' && zoomUrl) {
    if (notes) lines.push('');
    lines.push(`Join Zoom: ${zoomUrl}`);
  }
  return lines.join('\n');
}

/* The shared half of create and update. `place` is 'teams' | 'zoom' | null. */
function eventBody({ title, startLocal, endLocal, tz, notes, place, zoomUrl, attendees, allDay }){
  const b = {
    subject: title,
    body: { contentType: 'text', content: bodyFor({ notes, place, zoomUrl }) },
    start: asGraphTime(startLocal, tz),
    end: asGraphTime(endLocal, tz),
    isAllDay: Boolean(allDay)
  };
  if (Array.isArray(attendees) && attendees.length) {
    b.attendees = attendees.map(a => ({
      emailAddress: { address: String(a).trim() }, type: 'required'
    }));
  }
  if (place === 'teams') {
    b.isOnlineMeeting = true;
    b.onlineMeetingProvider = 'teamsForBusiness';
    b.location = { displayName: 'Microsoft Teams' };
  } else if (place === 'zoom') {
    /* Explicitly off: without this, a tenant configured to add Teams to every
       meeting would attach one alongside the Zoom link and the event would
       carry two conflicting ways in. */
    b.isOnlineMeeting = false;
    b.location = { displayName: zoomUrl ? `Zoom — ${zoomUrl}` : 'Zoom' };
  }
  return b;
}

export async function createEvent({ token, mailbox, ...rest }){
  const made = await call(token, `${box(mailbox)}/events`, {
    method: 'POST', body: eventBody(rest)
  });
  return { id: made?.id || null, join: made?.onlineMeeting?.joinUrl || null };
}

export async function updateEvent({ token, mailbox, id, ...rest }){
  const saved = await call(token, `${box(mailbox)}/events/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: eventBody(rest)
  });
  return { id: saved?.id || id, join: saved?.onlineMeeting?.joinUrl || null };
}

export async function deleteEvent({ token, mailbox, id }){
  await call(token, `${box(mailbox)}/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { id, deleted: true };
}
