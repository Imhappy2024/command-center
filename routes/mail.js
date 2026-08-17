/* Mail: one merged list across every connected mailbox, plus the actions. */

import express from 'express';
import { accountsFor, getAccount } from '../lib/accounts.js';
import { PROVIDERS } from '../lib/oauth.js';
import * as provider from '../providers/index.js';

const FOLDERS = ['inbox', 'drafts', 'trash', 'spam', 'archive'];

async function resolve(which){
  const all = await accountsFor('mail');
  if (!which || which === 'all') return all;
  const one = all.find(a => a.id === which);
  return one ? [one] : [];
}

/* A mailbox that fails must not take the others down with it. Each account's
   failure becomes a line the UI can show next to the ones that worked. */
const warn = (account, err) => ({
  account: account.id,
  label: account.label,
  email: account.email,
  error: err?.message || String(err)
});

export function mailRoutes({ env, auth }){
  const r = express.Router();
  const limitOf = q => {
    const n = Number(q);
    return Number.isInteger(n) && n > 0 && n <= 100 ? n : (Number(env.MAIL_FETCH_LIMIT) || 25);
  };

  /* Loads the account named in the path, or answers 404. Every action route
     starts here, so an unknown id never reaches a provider. */
  const withAccount = handler => [auth.require, express.json(), async (req, res) => {
    const account = await getAccount(req.params.accountId);
    if (!account) return res.status(404).json({ error: 'no such account' });
    try {
      res.json((await handler(req, account)) ?? { ok: true });
    } catch (err) {
      console.error(`[mail:${req.path}]`, err.message);
      res.status(400).json({ error: err.message });
    }
  }];

  r.get('/api/mail', auth.require, async (req, res) => {
    const folder = String(req.query.folder || 'inbox');
    if (!FOLDERS.includes(folder)) {
      return res.status(400).json({ error: `folder must be one of ${FOLDERS.join(', ')}` });
    }

    const accounts = await resolve(req.query.account);
    if (!accounts.length) return res.json({ messages: [], counts: null, warnings: [] });

    const limit = limitOf(req.query.limit);

    /* Fetched per account rather than as one capped pull, so a mailbox with a
       thousand unread cannot crowd the others out of the merged list. The merged
       result is not truncated afterwards: trimming it back to `limit` would
       reintroduce exactly that crowding, since the busiest mailbox would supply
       every surviving row. */
    const [lists, tallies] = await Promise.all([
      Promise.allSettled(accounts.map(a => provider.listMail(a, folder, limit))),
      Promise.allSettled(accounts.map(a => provider.counts(a)))
    ]);

    const messages = [];
    const warnings = [];
    lists.forEach((out, i) => {
      if (out.status === 'fulfilled') messages.push(...out.value);
      else warnings.push(warn(accounts[i], out.reason));
    });

    const counts = { inbox: 0, inboxUnread: 0, drafts: 0, trash: 0, spam: 0, archive: null };
    for (const t of tallies) {
      if (t.status !== 'fulfilled') continue;
      for (const key of Object.keys(counts)) {
        if (t.value[key] == null) continue;
        counts[key] = (counts[key] ?? 0) + t.value[key];
      }
    }

    res.json({
      messages: messages.sort((a, b) => b.sortKey - a.sortKey),
      counts,
      warnings
    });
  });

  r.get('/api/mail/:accountId/:messageId', ...withAccount(async (req, account) => ({
    message: await provider.getMail(
      account,
      req.params.messageId,
      FOLDERS.includes(String(req.query.folder)) ? String(req.query.folder) : 'inbox'
    )
  })));

  r.post('/api/mail/:accountId/:messageId/read', ...withAccount((req, account) =>
    provider.setRead(account, req.params.messageId, Boolean(req.body?.read))
      .then(() => ({ ok: true }))));

  r.post('/api/mail/:accountId/:messageId/star', ...withAccount((req, account) =>
    provider.setStar(account, req.params.messageId, Boolean(req.body?.star))
      .then(() => ({ ok: true }))));

  r.post('/api/mail/:accountId/:messageId/move', ...withAccount((req, account) => {
    const folder = String(req.body?.folder || '');
    if (!['inbox', 'archive', 'trash', 'spam'].includes(folder)) {
      throw new Error('folder must be inbox, archive, trash or spam');
    }
    return provider.move(account, req.params.messageId, folder).then(() => ({ ok: true }));
  }));

  /* Permanent delete. Available on Microsoft and IMAP; Google would need the
     full mail.google.com scope, so it answers with what to do instead. */
  r.delete('/api/mail/:accountId/:messageId', ...withAccount((req, account) =>
    provider.hardDelete(account, req.params.messageId).then(() => ({ ok: true }))));

  r.post('/api/mail/:accountId/send', ...withAccount((req, account) => {
    const { to, subject, body, replyTo } = req.body || {};
    if (!String(to || '').trim()) throw new Error('a recipient is required');
    return provider.send(account, { to, subject, body, replyTo }).then(() => ({ ok: true }));
  }));

  /* Which controls the UI may offer, so it can hide "Delete forever" on Google
     rather than showing a button that always fails. */
  r.get('/api/mail/capabilities', auth.require, async (req, res) => {
    const accounts = await accountsFor('mail');
    res.json({
      capabilities: Object.fromEntries(accounts.map(a => [a.id, {
        hardDelete: provider.canHardDelete(a.provider),
        feeds: PROVIDERS[a.provider]?.feeds || ['mail']
      }]))
    });
  });

  return r;
}
