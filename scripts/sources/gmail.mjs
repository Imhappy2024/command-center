/* Gmail — unread counts and the newest unread threads.

   Two auth paths, service account first:
     1. GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_IMPERSONATE_USER
        Needs Google Workspace domain-wide delegation. A service account has no
        mailbox, so it must impersonate a real user via the JWT `sub` claim.
     2. GOOGLE_CLIENT_ID / _SECRET / _REFRESH_TOKEN
        Plain OAuth. Works on consumer Gmail. `npm run auth:google` mints it. */

import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function parseServiceAccount(raw){
  let text = String(raw).trim();
  // Accept the raw JSON or a base64 wrapper, since some hosts mangle newlines.
  if (!text.startsWith('{')) {
    try { text = Buffer.from(text, 'base64').toString('utf8').trim(); }
    catch { /* fall through to the JSON error below */ }
  }
  let sa;
  try { sa = JSON.parse(text); }
  catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (or base64-encoded JSON)'); }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
  }
  return sa;
}

async function serviceAccountToken(env){
  const sa = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const subject = env.GOOGLE_IMPERSONATE_USER;
  if (!subject) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON is set but GOOGLE_IMPERSONATE_USER is not. ' +
      'A service account owns no mailbox; set it to the address to read, e.g. you@yourdomain.com'
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    sub: subject,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));

  let assertion;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(`${head}.${claims}`);
    assertion = `${head}.${claims}.${b64url(signer.sign(sa.private_key.replace(/\\n/g, '\n')))}`;
  } catch (err) {
    throw new Error(
      `could not sign with the service account private_key (${err.message}). ` +
      'This usually means the newlines were flattened when the JSON was pasted into an ' +
      'environment variable — base64-encode the whole JSON and set that instead.'
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const json = await res.json();

  if (!res.ok) {
    let hint = '';
    if (json.error === 'unauthorized_client') {
      hint = ` — client ${sa.client_id || sa.client_email} is not authorised for ${SCOPE}. `
        + 'Admin Console -> Security -> Access and data control -> API controls -> '
        + 'Domain-wide delegation -> Add new, using that client id and that exact scope.';
    } else if (/invalid_grant/.test(json.error || '')) {
      hint = ` — ${subject} could not be impersonated. Confirm the address exists in the Workspace `
        + 'domain the service account belongs to. Domain-wide delegation does not work on consumer Gmail.';
    }
    throw new Error(`Google JWT grant -> ${res.status} ${json.error_description || json.error || ''}${hint}`);
  }
  return json.access_token;
}

async function refreshTokenGrant(env){
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

const accessToken = env => env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? serviceAccountToken(env)
  : refreshTokenGrant(env);

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
  const hasServiceAccount = Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const hasOAuth = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
  if (!hasServiceAccount && !hasOAuth) {
    return { ok: false, reason: 'set GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_IMPERSONATE_USER, or GOOGLE_CLIENT_ID / _SECRET / _REFRESH_TOKEN' };
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
