/* Microsoft Graph — Outlook calendar, mail and contacts.

   Two auth paths:
     - Delegated: accounts connected in the UI. Reads /me. No admin consent.
     - App-only: MS_* client credentials. Reads /users/{upn}. Needs Application
       permissions granted by an admin.

   Application-scope Mail.Read reaches every mailbox in the tenant. Narrow it
   with an ApplicationAccessPolicy if that is broader than you want. */

import { weekWindow, dateKey, hhmm } from '../../lib/calendar.mjs';

const LOGIN = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

async function accessToken(env){
  const res = await fetch(`${LOGIN}/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Microsoft token -> ${res.status} ${json.error_description?.split('\n')[0] || json.error || ''}`);
  }
  return json.access_token;
}

async function graph(pathname, tok, tz){
  const res = await fetch(GRAPH + pathname, {
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: 'application/json',
      Prefer: `outlook.timezone="${tz}"`
    }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = json.error?.code || res.statusText;
    const msg = json.error?.message?.split('\n')[0] || '';
    let hint = '';
    if (res.status === 403 || code === 'Authorization_RequestDenied') {
      hint = ' — grant the Application permission (Calendars.Read / Mail.Read / Contacts.Read) '
        + 'in Entra ID -> App registrations -> API permissions, then click Grant admin consent.';
    } else if (res.status === 404) {
      hint = ' — check the mailbox exists in this tenant.';
    }
    throw new Error(`Graph ${pathname.split('?')[0]} -> ${res.status} ${code} ${msg}${hint}`);
  }
  return json;
}

function subtitle(ev){
  const who = (ev.attendees || []).map(a => a.emailAddress?.name).filter(Boolean).slice(0, 2);
  if (who.length) {
    const extra = (ev.attendees || []).length - who.length;
    return who.join(', ') + (extra > 0 ? ` +${extra}` : '');
  }
  return ev.location?.displayName || ev.organizer?.emailAddress?.name || '';
}

async function eventsFor(seat, tz){
  const { start, end } = weekWindow(tz);
  const view = await graph(
    `/${seat.scope}/calendarView?startDateTime=${start}&endDateTime=${end}`
    + '&$orderby=start/dateTime&$top=200'
    + '&$select=subject,start,end,isAllDay,location,attendees,organizer,showAs',
    seat.tok, tz
  );
  return (view.value || []).map(e => ({
    allDay: Boolean(e.isAllDay),
    start: String(e.start.dateTime).slice(0, 19),
    end: String(e.end.dateTime).slice(0, 19),
    title: e.subject || '(no subject)',
    sub: subtitle(e),
    account: seat.account,
    source: 'Outlook'
  }));
}

async function mailFor(seat, tz, today, perMailbox){
  const folder = await graph(`/${seat.scope}/mailFolders/inbox?$select=totalItemCount,unreadItemCount`, seat.tok, tz);
  const msgs = await graph(
    `/${seat.scope}/mailFolders/inbox/messages?$filter=isRead%20eq%20false&$top=${perMailbox}`
    + '&$orderby=receivedDateTime desc&$select=subject,from,receivedDateTime,bodyPreview',
    seat.tok, tz
  );
  return {
    label: 'Outlook',
    account: seat.account,
    counts: {
      unreadThreads: folder.unreadItemCount ?? 0,
      unreadMessages: folder.unreadItemCount ?? 0,
      totalThreads: folder.totalItemCount ?? 0
    },
    messages: (msgs.value || []).map(m => ({
      from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Unknown',
      subject: m.subject || '(no subject)',
      snippet: (m.bodyPreview || '').replace(/\s+/g, ' ').trim(),
      at: dateKey(m.receivedDateTime) === today ? hhmm(m.receivedDateTime) : String(m.receivedDateTime).slice(5, 10),
      sortKey: new Date(m.receivedDateTime).getTime() || 0,
      account: seat.account,
      unread: true
    }))
  };
}

export async function fetchMicrosoft(env, ctx = {}){
  const accounts = ctx.microsoft || [];
  const usable = accounts.filter(a => a.token);
  const broken = accounts.filter(a => a.error);
  const missing = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_SERVICE_USER']
    .filter(k => !env[k]);

  if (!usable.length && missing.length) {
    return {
      ok: false,
      reason: broken.length
        ? `token refresh failed for ${broken.map(b => b.account).join(', ')}`
        : `not connected — use Connect on the Inbox or Calendar page, or set ${missing.join(', ')}`
    };
  }

  const tz = env.AGENT_TIMEZONE || env.TIMEZONE || 'UTC';
  const perMailbox = Math.max(1, Number(env.INBOX_PER_MAILBOX) || 6);
  const warnings = broken.map(b => `Outlook ${b.account}: ${b.error}`);

  const seats = usable.length
    ? usable.map(a => ({ scope: 'me', tok: a.token, account: a.account }))
    : [{
        scope: `users/${encodeURIComponent(env.MS_SERVICE_USER)}`,
        tok: await accessToken(env),
        account: env.MS_SERVICE_USER
      }];

  const events = (await Promise.all(seats.map(s => eventsFor(s, tz)))).flat();

  const out = {
    ok: true,
    via: usable.length ? 'oauth' : 'app-only',
    user: seats.map(s => s.account).filter(Boolean).join(', '),
    accounts: seats.map(s => s.account),
    timezone: tz,
    events,
    calendarAccounts: seats.map(s => s.account),
    warnings
  };

  // Graph consent is per-permission: calendar can succeed while mail is denied.
  const today = dateKey(new Date().toISOString());
  const mailboxes = [];
  for (const seat of seats) {
    try {
      mailboxes.push(await mailFor(seat, tz, today, perMailbox));
    } catch (err) {
      out.mailError = err.message;
    }
  }

  if (mailboxes.length) {
    out.mail = {
      mailboxes,
      counts: mailboxes.reduce((a, m) => ({
        unreadMessages: a.unreadMessages + m.counts.unreadMessages,
        unreadThreads: a.unreadThreads + m.counts.unreadThreads,
        totalThreads: a.totalThreads + m.counts.totalThreads
      }), { unreadMessages: 0, unreadThreads: 0, totalThreads: 0 })
    };
  }

  let contacts = 0;
  for (const seat of seats) {
    try {
      const c = await graph(`/${seat.scope}/contacts?$top=1&$count=true`, seat.tok, tz);
      contacts += c['@odata.count'] ?? (c.value || []).length;
      out.contacts = { total: contacts };
    } catch (err) {
      out.contactsError = err.message;
    }
  }

  return out;
}
