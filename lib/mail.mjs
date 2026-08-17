/* Reading and writing mail, one shape across Gmail and Graph.

   Every call takes { provider, accountId } and resolves its own access token
   from the store, so a request only ever touches the mailbox it names. */

import { tokensFor } from './providers.mjs';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';

async function tokenFor(provider, accountId, env, store){
  const all = await tokensFor(provider, env, store);
  const hit = all.find(a => a.accountId === accountId) || (all.length === 1 ? all[0] : null);
  if (!hit) throw new Error(`no connected ${provider} account matching "${accountId}"`);
  if (hit.error) throw new Error(hit.error);
  return hit.token;
}

async function call(url, tok, init = {}){
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${tok}`, ...(init.headers || {}) }
  });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.error?.message || json.error_description || json.error || res.statusText;
    // Tokens minted before send/modify scopes existed cannot be widened.
    const scopeHint = (res.status === 403 || res.status === 401)
      ? ' — if this account was connected before sending was added, disconnect and reconnect it to grant the new scopes'
      : '';
    throw new Error(`${res.status} ${typeof detail === 'string' ? detail.split('\n')[0] : 'request failed'}${scopeHint}`);
  }
  return json;
}

/* ---------------- RFC 822 for Gmail ---------------- */

const b64url = s => Buffer.from(s, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Non-ASCII headers must be encoded-word wrapped, or Gmail rejects the raw message.
const encodeHeader = value =>
  /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;

function rfc822({ to, cc, subject, body, inReplyTo, references }){
  const lines = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${encodeHeader(subject || '')}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    body || ''
  ].filter(v => v !== null);
  return b64url(lines.join('\r\n'));
}

/* ---------------- Gmail ---------------- */

const headerOf = (msg, name) =>
  msg.payload?.headers?.find(h => h.name.toLowerCase() === name)?.value || '';

/* Gmail nests parts arbitrarily deep; prefer text/plain, fall back to html. */
function extractBody(payload){
  const found = { text: '', html: '' };
  const walk = part => {
    if (!part) return;
    const data = part.body?.data;
    if (data) {
      const decoded = Buffer.from(data, 'base64').toString('utf8');
      if (part.mimeType === 'text/plain' && !found.text) found.text = decoded;
      if (part.mimeType === 'text/html' && !found.html) found.html = decoded;
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return found;
}

const google = {
  async get(id, tok){
    const m = await call(`${GMAIL}/messages/${id}?format=full`, tok);
    const body = extractBody(m.payload);
    return {
      id: m.id,
      threadId: m.threadId,
      from: headerOf(m, 'from'),
      to: headerOf(m, 'to'),
      cc: headerOf(m, 'cc'),
      subject: headerOf(m, 'subject') || '(no subject)',
      date: headerOf(m, 'date'),
      messageId: headerOf(m, 'message-id'),
      references: headerOf(m, 'references'),
      text: body.text,
      html: body.html,
      unread: (m.labelIds || []).includes('UNREAD')
    };
  },

  async send(msg, tok){
    const raw = rfc822(msg);
    const sent = await call(`${GMAIL}/messages/send`, tok, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.threadId ? { raw, threadId: msg.threadId } : { raw })
    });
    return { id: sent.id };
  },

  async draft(msg, tok){
    const d = await call(`${GMAIL}/drafts`, tok, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw: rfc822(msg) } })
    });
    return { id: d.id };
  },

  async act(id, action, tok){
    if (action === 'trash') return call(`${GMAIL}/messages/${id}/trash`, tok, { method: 'POST' });
    const patch = {
      read: { removeLabelIds: ['UNREAD'] },
      unread: { addLabelIds: ['UNREAD'] },
      archive: { removeLabelIds: ['INBOX'] }
    }[action];
    if (!patch) throw new Error(`unknown action "${action}"`);
    return call(`${GMAIL}/messages/${id}/modify`, tok, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
  }
};

/* ---------------- Microsoft Graph ---------------- */

const recipients = list => String(list || '')
  .split(/[;,]/).map(s => s.trim()).filter(Boolean)
  .map(address => ({ emailAddress: { address } }));

function graphMessage({ to, cc, subject, body }){
  return {
    subject: subject || '',
    body: { contentType: 'Text', content: body || '' },
    toRecipients: recipients(to),
    ccRecipients: recipients(cc)
  };
}

const microsoft = {
  async get(id, tok){
    const m = await call(
      `${GRAPH}/messages/${id}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead,conversationId`,
      tok
    );
    const addr = r => (r || []).map(x => x.emailAddress?.address).filter(Boolean).join(', ');
    const isHtml = m.body?.contentType?.toLowerCase() === 'html';
    return {
      id: m.id,
      threadId: m.conversationId,
      from: m.from?.emailAddress?.address || '',
      to: addr(m.toRecipients),
      cc: addr(m.ccRecipients),
      subject: m.subject || '(no subject)',
      date: m.receivedDateTime,
      text: isHtml ? '' : (m.body?.content || ''),
      html: isHtml ? (m.body?.content || '') : '',
      unread: m.isRead === false
    };
  },

  async send(msg, tok){
    // Reply keeps the conversation intact; a bare send starts a new one.
    if (msg.replyToId) {
      await call(`${GRAPH}/messages/${msg.replyToId}/reply`, tok, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: msg.body || '' })
      });
      return { id: msg.replyToId };
    }
    await call(`${GRAPH}/sendMail`, tok, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: graphMessage(msg), saveToSentItems: true })
    });
    return { id: null };
  },

  async draft(msg, tok){
    const d = await call(`${GRAPH}/messages`, tok, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(graphMessage(msg))
    });
    return { id: d.id };
  },

  async act(id, action, tok){
    if (action === 'read' || action === 'unread') {
      return call(`${GRAPH}/messages/${id}`, tok, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: action === 'read' })
      });
    }
    const folder = { archive: 'archive', trash: 'deleteditems' }[action];
    if (!folder) throw new Error(`unknown action "${action}"`);
    return call(`${GRAPH}/messages/${id}/move`, tok, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ destinationId: folder })
    });
  }
};

const IMPL = { google, microsoft };

function implFor(provider){
  const impl = IMPL[provider];
  if (!impl) throw new Error(`unknown provider "${provider}"`);
  return impl;
}

export async function getMessage({ provider, accountId, id }, env, store){
  const tok = await tokenFor(provider, accountId, env, store);
  return implFor(provider).get(id, tok);
}

export async function sendMessage(msg, env, store){
  if (!String(msg.to || '').trim()) throw new Error('a recipient is required');
  const tok = await tokenFor(msg.provider, msg.accountId, env, store);
  return implFor(msg.provider).send(msg, tok);
}

export async function saveDraft(msg, env, store){
  const tok = await tokenFor(msg.provider, msg.accountId, env, store);
  return implFor(msg.provider).draft(msg, tok);
}

export async function actOnMessage({ provider, accountId, id, action }, env, store){
  const tok = await tokenFor(provider, accountId, env, store);
  await implFor(provider).act(id, action, tok);
  return { ok: true, action };
}
