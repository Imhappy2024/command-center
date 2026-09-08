/* Comments and messages.

   Reads serve the mirror in social_threads and social_items; writes go straight
   to the platform and wait. That split is the same one the metrics routes make
   and for the same reason -- YouTube's quota cannot be bought and Meta throttles
   per app -- with one difference: a reply is not worth mirroring if nobody
   knows whether it was delivered, so the send path blocks on the platform and
   reports what it said.

   Every failure here names the permission it needed. "403" on its own sends the
   reader to the wrong place, and half of these routes are one consent screen
   away from working. */

import express from 'express';
import { guarded } from './guard.js';
import { accountsFor } from '../lib/accounts.js';
import {
  INBOX_PLATFORMS, capabilities, listThreads, loadThread, loadParent, markThreadRead,
  mentionable, reply, postComment, react, postTargets, syncInbox, inboxHealth,
  sendAttachment,
  tagThread, tagsInUse
} from '../lib/social-inbox.js';

/* A platform name from a query string, or nothing. Validated against the list
   rather than interpolated: platform reaches a SQL parameter, and a name that is
   not one of these is a caller bug worth refusing loudly. */
const platformOf = v => INBOX_PLATFORMS.includes(String(v)) ? String(v) : null;
const kindOf = v => (String(v) === 'message' ? 'message' : 'comment');

export function inboxRoutes({ auth }){
  const r = express.Router();
  const json = express.json({ limit: '256kb' });

  /* What is connected and what it can do. The UI draws itself from this: a
     Reply box appears because the grant carries the scope for it, not because
     the platform theoretically supports one. */
  r.get('/api/social/inbox/capabilities', auth.require,
    guarded('api/social/inbox/capabilities', async (_req, res) => {
      res.json({ capabilities: await capabilities(), health: await inboxHealth() });
    }));

  /* The list, for one platform and one kind. Paged the same way the leads list
     is -- offset plus a total, so the footer can say 40 of 312. */
  r.get('/api/social/inbox', auth.require, guarded('api/social/inbox', async (req, res) => {
    const platform = platformOf(req.query.platform);
    if (!platform) {
      return res.status(400).json({ error: 'platform must be one of ' + INBOX_PLATFORMS.join(', ') });
    }
    const kind = kindOf(req.query.kind);

    const mine = (await accountsFor('social')).filter(a => a.provider === platform);
    if (!mine.length) {
      return res.json({
        threads: [], total: 0, unreadCount: 0, offset: 0, hasMore: false,
        accounts: [], notice: `No ${platform} account is connected.`
      });
    }
    /* ?account= narrows to one; otherwise every account of this platform. */
    const wanted = String(req.query.account || 'all');
    const ids = wanted === 'all' ? mine.map(a => a.id)
      : mine.filter(a => a.id === wanted).map(a => a.id);
    if (!ids.length) return res.status(400).json({ error: 'no such account on this platform' });

    const out = await listThreads({
      platform, kind, accountIds: ids,
      q: req.query.q || null,
      tag: req.query.tag || null,
      unread: String(req.query.unread || '') === '1',
      limit: req.query.limit,
      offset: req.query.offset
    });
    res.json({
      ...out,
      accounts: mine.map(a => ({ id: a.id, label: a.label, status: a.status, color: a.color })),
      caps: (await capabilities())[platform] || null
    });
  }));

  /* One thread and its items.

     ?fresh=1 re-reads the reply chain from the platform first. That is what
     makes opening a thread show all forty replies rather than the five that
     came inline with the list, and it is a request the reader made rather than
     one the poller guessed at, which is why it is allowed to spend quota. */
  r.get('/api/social/inbox/thread/:id', auth.require,
    guarded('api/social/inbox/thread', async (req, res) => {
      const out = await loadThread(req.params.id, { fresh: String(req.query.fresh || '') === '1' });
      if (!out) return res.status(404).json({ error: 'no such thread' });
      res.json({ ...out, mentionable: await mentionable(req.params.id) });
    }));

  /* A whole comment section: every thread held under one video or post, which
     is what the reader is opening when they click a comment. */
  r.get('/api/social/inbox/parent', auth.require,
    guarded('api/social/inbox/parent', async (req, res) => {
      const platform = platformOf(req.query.platform);
      const parentId = String(req.query.parent || '');
      if (!platform || !parentId) {
        return res.status(400).json({ error: 'platform and parent are both required' });
      }
      const ids = (await accountsFor('social'))
        .filter(a => a.provider === platform).map(a => a.id);
      const out = await loadParent({ platform, parentId, accountIds: ids });
      if (!out) return res.status(404).json({ error: 'nothing held under that post' });
      res.json({ ...out, caps: (await capabilities())[platform] || null });
    }));

  r.post('/api/social/inbox/thread/:id/read', auth.require, json,
    guarded('api/social/inbox/read', async (req, res) => {
      res.json(await markThreadRead(req.params.id, req.body?.read !== false));
    }));

  /* A reply, into a comment thread or a DM conversation. */
  r.post('/api/social/inbox/thread/:id/reply', auth.require, json,
    guarded('api/social/inbox/reply', async (req, res) => {
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'A reply cannot be empty.' });
      try {
        res.json({ ok: true, ...await reply(req.params.id, text) });
      } catch (err) {
        res.status(err.status || 502).json({
          error: err.message, needsScope: err.needsScope || null
        });
      }
    }));

  /* A file into a conversation.

     Base64 in a JSON body rather than multipart, because parsing multipart
     means a dependency and this is one field with a filename. The 12mb limit
     is on this route alone -- the rest of the API stays at 256kb, and a body
     cap that generous everywhere is a way to be knocked over.

     8MB of file, which is Meta's own photo limit and comfortably more than a
     voice note. Base64 inflates by a third, hence 12mb of JSON. */
  r.post('/api/social/inbox/thread/:id/attach', auth.require,
    express.json({ limit: '12mb' }),
    guarded('api/social/inbox/attach', async (req, res) => {
      const { kind, filename, mime, data, url } = req.body || {};
      if (!kind) return res.status(400).json({ error: 'What kind of attachment?' });
      if (!data && !url) return res.status(400).json({ error: 'Nothing to send.' });

      let bytes = null;
      if (data) {
        try {
          bytes = Buffer.from(String(data).replace(/^data:[^;]*;base64,/, ''), 'base64');
        } catch {
          return res.status(400).json({ error: 'That file did not decode.' });
        }
        if (bytes.length > 8 * 1024 * 1024) {
          return res.status(413).json({
            error: `That file is ${(bytes.length / 1048576).toFixed(1)}MB. Meta's limit is 8MB.`
          });
        }
      }

      try {
        res.json({ ok: true, ...await sendAttachment(req.params.id, {
          kind, filename, mime, bytes, url: url || null
        }) });
      } catch (err) {
        res.status(err.status || 502).json({
          error: err.message, needsScope: err.needsScope || null
        });
      }
    }));

  /* A new top-level comment, on one of the account's own posts. */
  r.post('/api/social/inbox/comment', auth.require, json,
    guarded('api/social/inbox/comment', async (req, res) => {
      const text = String(req.body?.text || '').trim();
      const accountId = String(req.body?.account || '');
      const parentId = String(req.body?.parent || '');
      if (!text) return res.status(400).json({ error: 'A comment cannot be empty.' });
      if (!accountId || !parentId) {
        return res.status(400).json({ error: 'A new comment needs an account and the post it goes under.' });
      }
      try {
        res.json({ ok: true, ...await postComment({ accountId, parentId, text }) });
      } catch (err) {
        res.status(err.status || 502).json({
          error: err.message, needsScope: err.needsScope || null
        });
      }
    }));

  /* What a new comment can go under. From social_posts, which the metrics
     poller already fills, so this costs no platform call. */
  r.get('/api/social/inbox/targets', auth.require,
    guarded('api/social/inbox/targets', async (req, res) => {
      const platform = platformOf(req.query.platform);
      if (!platform) return res.status(400).json({ error: 'platform is required' });
      const ids = (await accountsFor('social'))
        .filter(a => a.provider === platform).map(a => a.id);
      res.json({ targets: await postTargets(ids) });
    }));

  /* A reaction. 501 where the platform has no such API, with the reason: two of
     the three genuinely do not offer one, and a 501 that explains itself is
     more use than a button that fails silently. */
  r.post('/api/social/inbox/thread/:id/react', auth.require, json,
    guarded('api/social/inbox/react', async (req, res) => {
      const item = String(req.body?.item || '');
      if (!item) return res.status(400).json({ error: 'Which comment?' });
      try {
        res.json({ ok: true, ...await react({
          threadId: req.params.id, itemId: item, on: req.body?.on !== false
        }) });
      } catch (err) {
        res.status(err.status || 502).json({
          error: err.message, needsScope: err.needsScope || null
        });
      }
    }));

  /* Tags. Local labels, and the response says so rather than leaving the caller
     to assume they reached the platform -- none of the three lets an app label a
     comment or a conversation. */
  r.post('/api/social/inbox/thread/:id/tags', auth.require, json,
    guarded('api/social/inbox/tags', async (req, res) => {
      try {
        res.json({
          ok: true,
          local: true,
          ...await tagThread(req.params.id, req.body?.tags)
        });
      } catch (err) {
        res.status(err.status || 400).json({ error: err.message });
      }
    }));

  r.get('/api/social/inbox/tags', auth.require, guarded('api/social/inbox/tags:list', async (req, res) => {
    const platform = platformOf(req.query.platform);
    if (!platform) return res.status(400).json({ error: 'platform is required' });
    res.json({ tags: await tagsInUse({ platform, kind: kindOf(req.query.kind) }) });
  }));

  /* Sync now. One platform at a time by default, so a YouTube click cannot
     spend Meta's rate budget. */
  r.post('/api/social/inbox/sync', auth.require, json,
    guarded('api/social/inbox/sync', async (req, res) => {
      const platform = platformOf(req.body?.platform);
      const out = await syncInbox({
        only: platform ? new Set([platform]) : null,
        full: req.body?.full === true
      });
      res.json({ ok: true, ...out });
    }));

  return r;
}
