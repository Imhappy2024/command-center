/* Gmail — unread counts and the newest unread threads.
   Auth: an OAuth refresh token. Run `npm run auth:google` once to mint one. */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function accessToken(env){
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google token exchange -> ${res.status} ${json.error_description || json.error || ''}`);
  return json.access_token;
}

async function api(pathname, tok){
  const res = await fetch(API + pathname, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) throw new Error(`Gmail ${pathname.split('?')[0]} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const header = (msg, name) =>
  msg.payload?.headers?.find(h => h.name.toLowerCase() === name)?.value || '';

function sender(from){
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<.+>\s*$/);
  return (m ? m[1].trim() : from.replace(/[<>]/g, '').trim()) || from;
}

function when(ms){
  const d = new Date(Number(ms));
  const today = new Date(); today.setHours(0,0,0,0);
  if (d.getTime() >= today.getTime()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const days = Math.round((today.getTime() - d.getTime()) / 86_400_000);
  if (days <= 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export async function fetchGmail(env){
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return { ok: false, reason: 'GOOGLE_CLIENT_ID / _SECRET / _REFRESH_TOKEN not set' };
  }

  const tok = await accessToken(env);
  const inbox = await api('/labels/INBOX', tok);

  const listed = await api('/messages?q=' + encodeURIComponent('is:unread in:inbox') + '&maxResults=6', tok);
  const ids = (listed.messages || []).map(m => m.id);

  const messages = await Promise.all(ids.map(async id => {
    const m = await api(`/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, tok);
    return {
      from: sender(header(m, 'from')),
      subject: header(m, 'subject') || '(no subject)',
      snippet: m.snippet || '',
      at: when(m.internalDate),
      unread: true
    };
  }));

  // "Needs a reply": unread and addressed to you directly, not a list blast.
  const direct = await api('/messages?q=' + encodeURIComponent('is:unread in:inbox -category:promotions -category:social') + '&maxResults=1', tok);

  return {
    ok: true,
    counts: {
      unreadMessages: inbox.messagesUnread ?? 0,
      unreadThreads: inbox.threadsUnread ?? 0,
      totalThreads: inbox.threadsTotal ?? 0,
      needsReply: direct.resultSizeEstimate ?? 0
    },
    messages
  };
}
