/* Meta, Instagram and HeyReach webhooks.

   A webhook here is a TRIGGER, not a second way in.

   The tempting design is to parse the event payload and write the comment or
   the message straight into social_threads. It is also the wrong one: it means
   two parsers for the same data, in two shapes, that must agree forever — and
   the webhook shape is the one nobody looks at, so it is the one that drifts.
   The first time Meta adds a field, the poller learns about it and the webhook
   does not, and rows arrive subtly different depending on which path saw them.

   So an event says only WHICH account changed. This answers 200 immediately,
   then runs the same syncer the timer runs, for that account alone. One ingest
   path, one shape, and the fifteen-minute wait collapses to a couple of
   seconds.

   Debounced, because Meta delivers a burst: a single conversation can produce
   messages, message_reactions and messaging_seen within a second of each
   other, and each of those is not worth its own round trip to Instagram.
   --------------------------------------------------------------------------- */

import express from 'express';
import crypto from 'node:crypto';
import { query } from '../db/index.js';
import { accountsFor } from '../lib/accounts.js';
import { syncInbox, inboxPlatformOf } from '../lib/social-inbox.js';
import { pollOnce } from '../lib/social-sync.js';
import { senderAccounts } from '../lib/heyreach-seed.js';

/* Meta signs every delivery. Verifying it is what stops anybody who learns the
   URL from making this app hammer Instagram on command.

   Timing-safe, and false on any malformed input rather than throwing: a
   handler that 500s on a bad signature tells the sender its guess was
   interesting. */
function signed(raw, header, secret){
  if (!raw || !header || !secret) return false;
  const sent = String(header).replace(/^sha256=/, '');
  const mine = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(sent, 'utf8');
  const b = Buffer.from(mine, 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/* Which accounts an event touches.

   entry[].id is the Page id for a page event and the Instagram account id for
   an instagram one, so the account row is found by matching either against
   what discovery stored. Anything unrecognised syncs nothing -- an event for
   an asset this dashboard does not hold is not an error, it is somebody else's
   Page on the same app. */
async function accountsForEntry(object, entries){
  const all = await accountsFor('social');
  const wanted = new Set();

  for (const e of entries || []) {
    const id = String(e.id || '');
    if (!id) continue;
    for (const a of all) {
      const m = a.meta || {};
      const mine = [m.pageId, m.igId, m.parentPageId, String(a.id).split(':')[1]]
        .filter(Boolean).map(String);
      if (!mine.includes(id)) continue;
      /* A page event on a Page that has an Instagram account attached can be
         either one's DMs, and the cheap answer is to sync the row the event
         names rather than guess. */
      if (object === 'instagram' && inboxPlatformOf(a.provider) !== 'instagram') continue;
      wanted.add(a.id);
    }
  }
  return [...wanted];
}

/* Did this delivery say a POST appeared, as opposed to a comment on one?

   Meta puts both down the same `feed` field, and the difference is in the
   item: a comment is item="comment", a post is item="status", "photo",
   "video" or "share". Instagram has no feed field at all -- a new media
   object arrives as a mention or not at all -- so its posts still come from
   the poller, and saying that here is more honest than pretending the
   classifier covers it.

   It matters because the comment sync and the post poller are different
   passes over different tables: syncInbox fills social_threads, pollOnce
   fills social_posts. A new post that only ran syncInbox would show up on
   the board at the next scheduled poll, which is twice a day. */
const POST_ITEMS = new Set(['status', 'photo', 'video', 'share', 'link', 'reel']);
function mentionsAPost(entries){
  for (const e of entries || []) {
    for (const c of e.changes || []) {
      if (c.field !== 'feed') continue;
      const v = c.value || {};
      /* "remove" is a delete, which the next poll reconciles; only an added
         post is worth spending a poll on right now. */
      if (v.verb && v.verb !== 'add') continue;
      if (POST_ITEMS.has(String(v.item || ''))) return true;
    }
  }
  return false;
}

export function webhookRoutes({ env }){
  const r = express.Router();

  /* The raw body, kept for the signature check. express.json() parses and
     discards it otherwise, and re-serialising the parsed object does not
     reproduce the bytes Meta signed. */
  const raw = express.json({
    limit: '1mb',
    verify: (req, _res, buf) => { req.rawBody = buf; }
  });

  /* One pending sync per account, collapsed. */
  const pending = new Set();
  /* And separately, the accounts that need their POSTS re-read. Kept apart
     from `pending` because the two are different passes and most events
     want only the first -- a burst of ten comments must not run ten post
     polls, or even one. */
  const pendingPosts = new Set();
  let timer = null;
  const DEBOUNCE_MS = 2500;

  function schedule(ids, { posts = false } = {}){
    for (const id of ids) { pending.add(id); if (posts) pendingPosts.add(id); }
    if (timer || !pending.size) return;
    timer = setTimeout(async () => {
      timer = null;
      const batch = [...pending];
      const postBatch = [...pendingPosts];
      pending.clear();
      pendingPosts.clear();
      try {
        const out = await syncInbox({ only: new Set(batch) });
        const threads = (out.results || []).reduce((n, x) => n + (x.threads || 0), 0);
        if (threads) console.log(`[webhook] ${threads} thread(s) from ${batch.length} account(s)`);
        for (const x of (out.results || []).filter(y => !y.ok)) {
          console.error(`[webhook] ${x.label}: ${x.error}`);
        }
      } catch (err) {
        console.error('[webhook] sync failed:', err.message);
      }

      /* The post lane. Separate try, because a comment sync that worked
         should not be reported as a failure by a post poll that did not. */
      if (postBatch.length) {
        try {
          const out = await pollOnce({ env, only: new Set(postBatch) });
          console.log(`[webhook] polled posts for ${out.polled} account(s)`);
        } catch (err) {
          console.error('[webhook] post poll failed:', err.message);
        }
      }
    }, DEBOUNCE_MS);
    timer.unref?.();
  }

  /* The handshake. Meta GETs the URL once with a token it expects echoed back,
     and every failure mode here is a different thing to fix, so they are told
     apart rather than collapsed into one 403. */
  const verify = (req, res) => {
    const token = env.META_WEBHOOK_VERIFY_TOKEN;
    if (!token) {
      console.warn('[webhook] verification attempted with META_WEBHOOK_VERIFY_TOKEN unset');
      return res.status(503).type('text/plain')
        .send('META_WEBHOOK_VERIFY_TOKEN is not set on this server, so there is nothing '
          + 'to check the token against. Set it, redeploy, then verify.');
    }
    if (req.query['hub.mode'] !== 'subscribe') {
      return res.status(400).type('text/plain').send('expected hub.mode=subscribe');
    }
    if (req.query['hub.verify_token'] !== token) {
      console.warn('[webhook] verification failed: the token did not match');
      return res.status(403).type('text/plain')
        .send('that verify token does not match META_WEBHOOK_VERIFY_TOKEN on this server');
    }
    console.log('[webhook] verified');
    return res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
  };

  /* Answer first, work after.

     Meta times out at a few seconds and retries what it thinks failed, so
     anything slow inside the request turns one event into several. The sync is
     scheduled and the response goes out immediately. */
  const receive = (req, res) => {
    const sig = req.get('X-Hub-Signature-256');
    /* Either app's secret: a page event is signed with the Meta app secret and
       an Instagram-Login event with the Instagram one, and the same URL can
       receive both. */
    const ok = signed(req.rawBody, sig, env.META_APP_SECRET)
      || signed(req.rawBody, sig, env.INSTAGRAM_APP_SECRET);

    if (!ok) {
      console.warn('[webhook] rejected: signature did not verify');
      return res.sendStatus(403);
    }

    res.sendStatus(200);

    const body = req.body || {};
    accountsForEntry(body.object, body.entry)
      .then(ids => {
        if (!ids.length) {
          console.log(`[webhook] ${body.object} event for an asset this dashboard does not hold`);
          return;
        }
        schedule(ids, { posts: mentionsAPost(body.entry) });
      })
      .catch(err => console.error('[webhook] could not resolve the account:', err.message));
  };

  /* Two paths for one receiver. Meta's Page product and the Instagram product
     are configured separately in the App Dashboard and people paste whichever
     they are looking at, so both work and neither is a redirect. */
  for (const path of ['/webhooks/meta', '/webhooks/instagram']) {
    r.get(path, verify);
    r.post(path, raw, receive);
  }

  /* -------------------------------------------------------------------------
     HeyReach, which is LinkedIn.

     Same principle as above: the event says WHICH sender changed, and the
     syncer reads the conversation from the API. It matters more here than it
     does for Meta, because HeyReach's own guide says the webhook payload "is
     not formally documented or versioned" — so a parser that lifted message
     text straight out of it would be building the inbox on a shape nobody has
     promised to keep.

     HeyReach does not sign deliveries and sends nothing secret of its own, so
     the secret is in the URL. That is the whole authentication: anyone holding
     the URL can make this app call HeyReach, which is why the URL is not the
     bare path and why HEYREACH_WEBHOOK_SECRET has to be long enough that it
     cannot be guessed.
     ------------------------------------------------------------------------- */

  /* Timing-safe, and false on anything malformed rather than throwing. */
  const secretOk = given => {
    const want = String(env.HEYREACH_WEBHOOK_SECRET || '');
    const got = String(given || '');
    if (!want || !got) return false;
    const a = Buffer.from(want, 'utf8');
    const b = Buffer.from(got, 'utf8');
    if (a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(a, b); } catch { return false; }
  };

  const at = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

  /* Which sender an event is about.

     Every candidate spelling is tried, because the payload is unversioned. When
     none of them matches anything stored, every LinkedIn sender is synced
     rather than none: the alternative is an event that silently does nothing
     the day HeyReach renames a field, and the number of senders in a workspace
     is small enough that the whole set is an acceptable answer. */
  const SENDER_ID_PATHS = [
    'linkedInAccountId', 'linkedin_account_id', 'accountId', 'senderId',
    'linkedInAccount.id', 'sender.id', 'sender.linkedInAccountId',
    'linkedInSender.id', 'account.id'
  ];
  const SENDER_URL_PATHS = [
    'sender.profileUrl', 'sender.linkedInUrl', 'linkedInAccount.linkedInUrl',
    'senderProfileUrl', 'linkedInSender.profileUrl'
  ];
  const tidy = u => String(u).replace(/\/+$/, '').toLowerCase();

  async function heyreachAccounts(body){
    const senders = await senderAccounts();
    if (!senders.length) return [];

    const ids = new Set(SENDER_ID_PATHS.map(p => at(body, p))
      .filter(v => v !== undefined && v !== null && v !== '').map(String));
    const urls = new Set(SENDER_URL_PATHS.map(p => at(body, p)).filter(Boolean).map(tidy));

    const hit = senders.filter(s => ids.has(String(s.senderId))
      || (s.profileUrl && urls.has(tidy(s.profileUrl))));
    if (hit.length) return hit.map(s => s.id);

    console.log(`[webhook:heyreach] no sender matched the payload, syncing all `
      + `${senders.length} LinkedIn account(s)`);
    return senders.map(s => s.id);
  }

  /* Kept whether or not it moves the inbox. A connection request is not a
     message and syncing the inbox will not find one, but it IS the record that
     the request went out — and webhook_events is where this app already keeps
     the things a platform says once and never says again. */
  async function recordEvent(body){
    const type = String(at(body, 'eventType') || at(body, 'event') || 'unknown');
    const external = at(body, 'conversationId') || at(body, 'id')
      || at(body, 'lead.profileUrl') || null;
    await query(
      `INSERT INTO webhook_events (provider, event_type, external_id, payload, processed)
       VALUES ('heyreach', $1, $2, $3, true)`,
      [type.slice(0, 120), external ? String(external).slice(0, 200) : null, body]);
    return type;
  }

  /* Only two of the four events this dashboard subscribes to can put something
     new in the inbox. A connection request sent or accepted is recorded and
     acknowledged without spending a read on an inbox that has not changed. */
  const MOVES_THE_INBOX = /MESSAGE|INMAIL|REPLY/i;

  const heyreachReceive = (req, res) => {
    if (!env.HEYREACH_WEBHOOK_SECRET) {
      console.warn('[webhook:heyreach] delivery arrived with HEYREACH_WEBHOOK_SECRET unset');
      return res.status(503).type('text/plain')
        .send('HEYREACH_WEBHOOK_SECRET is not set on this server, so there is nothing to '
          + 'check this delivery against. Set it, redeploy, then re-save the webhook.');
    }
    if (!secretOk(req.params.secret || req.query.key || req.get('X-Webhook-Secret'))) {
      console.warn('[webhook:heyreach] rejected: the secret did not match');
      return res.sendStatus(403);
    }

    /* Answer first. HeyReach retries up to five times over 24 hours on a
       failure, so a slow handler turns one event into five. */
    res.sendStatus(200);

    const body = req.body || {};
    recordEvent(body)
      .then(async type => {
        if (!MOVES_THE_INBOX.test(type)) {
          console.log(`[webhook:heyreach] ${type} recorded`);
          return;
        }
        const ids = await heyreachAccounts(body);
        if (!ids.length) {
          console.log(`[webhook:heyreach] ${type} but no LinkedIn sender is connected`);
          return;
        }
        schedule(ids);
      })
      .catch(err => console.error('[webhook:heyreach]', err.message));
  };

  /* A GET, so the URL can be opened once to confirm it is the right one and the
     secret is right, before it is pasted into HeyReach. It says nothing to
     anyone who does not already hold the secret. */
  const heyreachPing = (req, res) => {
    if (!env.HEYREACH_WEBHOOK_SECRET) {
      return res.status(503).type('text/plain').send('HEYREACH_WEBHOOK_SECRET is not set');
    }
    if (!secretOk(req.params.secret || req.query.key)) return res.sendStatus(403);
    res.type('text/plain').send('ready — paste this same URL into HeyReach');
  };

  /* The secret in the path, because a URL is the only field HeyReach gives you.
     The query form is there for anyone who would rather keep it off the path. */
  for (const path of ['/webhooks/heyreach', '/webhooks/heyreach/:secret']) {
    r.get(path, heyreachPing);
    r.post(path, raw, heyreachReceive);
  }

  return r;
}
