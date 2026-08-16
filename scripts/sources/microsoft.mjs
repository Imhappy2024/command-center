/* Microsoft Graph — Outlook calendar, mail and contacts, app-only.

   Client-credentials flow: the app authenticates as itself, then reads
   MS_SERVICE_USER's mailbox. That needs *Application* permissions with admin
   consent — Calendars.Read, Mail.Read, Contacts.Read — not delegated ones.

   Application-scope Mail.Read reaches every mailbox in the tenant. Narrow it
   with an ApplicationAccessPolicy if that is broader than you want. */

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
      hint = ' — check MS_SERVICE_USER is a real mailbox UPN in this tenant.';
    }
    throw new Error(`Graph ${pathname.split('?')[0]} -> ${res.status} ${code} ${msg}${hint}`);
  }
  return json;
}

const iso = d => d.toISOString().slice(0, 19);
const hhmm = s => String(s).slice(11, 16);

function mondayOf(d){
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

function duration(ev){
  const mins = Math.round((new Date(ev.end.dateTime) - new Date(ev.start.dateTime)) / 60000);
  if (mins <= 0) return null;
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

function subtitle(ev){
  const who = (ev.attendees || [])
    .map(a => a.emailAddress?.name)
    .filter(Boolean)
    .slice(0, 2);
  if (who.length) return who.join(', ') + ((ev.attendees.length > who.length) ? ` +${ev.attendees.length - who.length}` : '');
  return ev.location?.displayName || ev.organizer?.emailAddress?.name || '';
}

/* Gaps inside the working day that no event covers. */
function openBlocks(events, dayStart, dayEnd){
  const busy = events
    .filter(e => !e.isAllDay)
    .map(e => [new Date(e.start.dateTime), new Date(e.end.dateTime)])
    .sort((a, b) => a[0] - b[0]);

  const out = [];
  let cursor = dayStart;
  for (const [s, e] of busy) {
    if (s > cursor) out.push([cursor, s < dayEnd ? s : dayEnd]);
    if (e > cursor) cursor = e;
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) out.push([cursor, dayEnd]);

  return out
    .map(([s, e]) => ({ s, e, mins: Math.round((e - s) / 60000) }))
    .filter(b => b.mins >= 45);
}

export async function fetchMicrosoft(env, ctx = {}){
  // Delegated (connected via the UI) reads /me. App-only reads /users/{upn}.
  const connected = ctx.microsoft || null;
  const missing = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_SERVICE_USER']
    .filter(k => !env[k]);
  if (!connected && missing.length) {
    return { ok: false, reason: `not connected — use Connect on the Connections page, or set ${missing.join(', ')}` };
  }

  const tz = env.AGENT_TIMEZONE || env.TIMEZONE || 'UTC';
  const scope = connected ? 'me' : `users/${encodeURIComponent(env.MS_SERVICE_USER)}`;
  const tok = connected ? connected.token : await accessToken(env);

  const weekStart = mondayOf(new Date());
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7);

  const view = await graph(
    `/${scope}/calendarView?startDateTime=${iso(weekStart)}&endDateTime=${iso(weekEnd)}`
    + '&$orderby=start/dateTime&$top=200'
    + '&$select=subject,start,end,isAllDay,location,attendees,organizer,showAs',
    tok, tz
  );
  const events = view.value || [];

  const DAY_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const week = DAY_NAMES.map((dn, i) => {
    const d = new Date(weekStart); d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const count = events.filter(e => String(e.start.dateTime).slice(0, 10) === key).length;
    return {
      day: dn,
      date: d.getDate(),
      count,
      label: count ? `${count} event${count === 1 ? '' : 's'}` : 'clear',
      today: key === new Date().toISOString().slice(0, 10)
    };
  });

  const todayKey = new Date().toISOString().slice(0, 10);
  const todayEvents = events.filter(e => String(e.start.dateTime).slice(0, 10) === todayKey);

  const today = todayEvents.map(e => ({
    time: e.isAllDay ? 'All day' : hhmm(e.start.dateTime),
    title: e.subject || '(no subject)',
    sub: subtitle(e),
    chip: e.isAllDay ? { text: 'All day' } : { text: duration(e) || '' }
  }));

  const bookedMins = todayEvents
    .filter(e => !e.isAllDay)
    .reduce((n, e) => n + Math.round((new Date(e.end.dateTime) - new Date(e.start.dateTime)) / 60000), 0);

  // Open blocks across the rest of the working week, 08:00-18:00.
  const blocks = [];
  for (let i = 0; i < 7 && blocks.length < 5; i++) {
    const d = new Date(weekStart); d.setDate(d.getDate() + i);
    if (d.toISOString().slice(0, 10) < todayKey) continue;
    const key = d.toISOString().slice(0, 10);
    const dayEvents = events.filter(e => String(e.start.dateTime).slice(0, 10) === key);
    const start = new Date(`${key}T08:00:00`);
    const end = new Date(`${key}T18:00:00`);
    for (const b of openBlocks(dayEvents, start, end)) {
      if (blocks.length >= 5) break;
      const h = Math.floor(b.mins / 60), m = b.mins % 60;
      blocks.push({
        day: DAY_NAMES[i],
        range: `${hhmm(b.s.toISOString())} – ${hhmm(b.e.toISOString())}`,
        note: dayEvents.length ? 'Between meetings' : 'Nothing booked all day',
        chip: { tone: b.mins >= 180 ? 'jade' : '', text: m ? `${h}h${String(m).padStart(2,'0')}` : `${h}h` }
      });
    }
  }

  const out = {
    ok: true,
    via: connected ? 'oauth' : 'app-only',
    user: connected?.account || env.MS_SERVICE_USER,
    timezone: tz,
    calendar: { week, today, blocks, bookedMins, weekCount: events.length }
  };

  // Mail and contacts are optional: a tenant may consent to Calendars.Read only.
  try {
    const folder = await graph(`/${scope}/mailFolders/inbox?$select=totalItemCount,unreadItemCount`, tok, tz);
    const msgs = await graph(
      `/${scope}/mailFolders/inbox/messages?$filter=isRead%20eq%20false&$top=6`
      + '&$orderby=receivedDateTime desc&$select=subject,from,receivedDateTime,bodyPreview',
      tok, tz
    );
    out.mail = {
      counts: {
        unreadThreads: folder.unreadItemCount ?? 0,
        unreadMessages: folder.unreadItemCount ?? 0,
        totalThreads: folder.totalItemCount ?? 0,
        needsReply: folder.unreadItemCount ?? 0
      },
      messages: (msgs.value || []).map(m => ({
        from: m.from?.emailAddress?.name || m.from?.emailAddress?.address || 'Unknown',
        subject: m.subject || '(no subject)',
        snippet: (m.bodyPreview || '').replace(/\s+/g, ' ').trim(),
        at: hhmm(m.receivedDateTime) === '00:00'
          ? String(m.receivedDateTime).slice(0, 10)
          : (String(m.receivedDateTime).slice(0, 10) === todayKey
              ? hhmm(m.receivedDateTime)
              : String(m.receivedDateTime).slice(5, 10)),
        unread: true
      }))
    };
  } catch (err) {
    out.mailError = err.message;
  }

  try {
    const c = await graph(`/${scope}/contacts?$top=1&$count=true`, tok, tz);
    out.contacts = { total: c['@odata.count'] ?? (c.value || []).length };
  } catch (err) {
    out.contactsError = err.message;
  }

  return out;
}
