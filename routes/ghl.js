/* GoHighLevel sub-accounts.

   Connecting is built and verified end to end. Reading leads, threads and
   messaging is not, and says so rather than returning an empty pipeline that
   looks like "no leads". */

import express from 'express';
import { accountsFor, upsertStaticToken, deleteAccount } from '../lib/accounts.js';
import { verifyLocation, GhlError } from '../providers/ghl.js';
import { query } from '../db/index.js';
import { ipLimiter, rawLabels } from '../lib/ghl-webhook.js';
import { backfillDetached } from '../lib/ghl-sync.js';
import { resume } from '../lib/ghl-limiter.js';
import { guarded } from './guard.js';

const safeLabel = v => String(v || '').trim().slice(0, 24);
const safeColor = v => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : '#8E9BA8');

/* Shape the Leads view expects for its sub-account submenu. */
const asLocation = a => ({
  id: a.id.replace(/^ghl:/, ''),
  name: a.label,
  short: a.label.split(' ')[0],
  color: a.color,
  status: a.status
});

const NOT_BUILT =
  'Connecting a sub-account works, but reading leads from GHL is not built yet.';

export function ghlRoutes({ env, auth }){
  const r = express.Router();

  const locations = () => accountsFor('leads');

  r.get('/api/ghl/locations', auth.require, guarded('api/ghl/locations', async (req, res) => {
    res.json({ locations: (await locations()).map(asLocation) });
  }));

  r.post('/api/ghl/locations', auth.require, express.json(),
    guarded('api/ghl/locations:create', async (req, res) => {
      if (!env.ENCRYPTION_KEY) {
        return res.status(403).json({ error: 'ENCRYPTION_KEY is not set, so there is nowhere safe to store a token.' });
      }

      const b = req.body || {};
      const locationId = String(b.locationId || '').trim();
      const token = String(b.token || '').trim();
      const label = safeLabel(b.label);

      if (!/^[A-Za-z0-9]{15,30}$/.test(locationId)) {
        return res.status(400).json({ error: 'Location ID looks wrong. It is the string after /location/ in the sub-account URL.' });
      }
      if (token.length < 20) {
        return res.status(400).json({ error: 'That does not look like a Private Integration Token.' });
      }
      if (!label) return res.status(400).json({ error: 'Give the sub-account a label.' });

      /* Verified against GHL before it is stored, so a bad token or a missing
         scope is a specific message in the sheet rather than a pipeline that
         silently never fills. */
      let found;
      try {
        found = await verifyLocation(token, locationId);
      } catch (err) {
        if (err instanceof GhlError) return res.status(400).json({ error: err.message, kind: err.kind });
        return res.status(400).json({ error: `Could not reach GHL: ${err.message}` });
      }

      const id = await upsertStaticToken({
        provider: 'ghl',
        uid: locationId,
        display: found.name,
        label,
        color: safeColor(b.color),
        token,
        meta: { locationName: found.name },
        /* The owner typed this label, so no later env seed may overwrite it. */
        labelSource: 'user'
      });

      /* A replaced token clears the limiter's stop from the old one's 401s. */
      resume(locationId);

      /* Not awaited: a first sync pages through thousands of records and the
         sheet has to close now. Progress lands in sync_state, and the read
         routes say "first sync has not finished" until it does. */
      backfillDetached(locationId, env);

      res.json({ ok: true, id, location: { id: locationId, name: found.name } });
    }));

  r.delete('/api/ghl/locations/:id', auth.require,
    guarded('api/ghl/locations:delete', async (req, res) => {
      const id = req.params.id.startsWith('ghl:') ? req.params.id : `ghl:${req.params.id}`;
      const gone = await deleteAccount(id);
      if (!gone) return res.status(404).json({ error: 'no such sub-account' });
      res.json({ ok: true });
    }));

  /* Honest placeholders. Empty with no warning when nothing is connected — that
     is simply an empty state. Once a sub-account exists, silence would imply the
     pipeline is empty, so it says what is actually missing instead. */
  const unbuilt = key => guarded(`api/ghl/${key}`, async (req, res) => {
    const connected = await locations();
    res.json({
      [key]: key === 'thread' ? [] : [],
      warnings: connected.length
        ? connected.slice(0, 1).map(l => ({ account: l.id, label: l.label, error: NOT_BUILT }))
        : []
    });
  });

  r.get('/api/ghl/leads', auth.require, unbuilt('leads'));
  r.get('/api/ghl/leads/:id/thread', auth.require, unbuilt('thread'));

  for (const [method, path] of [['post', '/api/ghl/leads/:id/message'], ['patch', '/api/ghl/leads/:id']]) {
    r[method](path, auth.require, express.json(), (req, res) =>
      res.status(501).json({ error: NOT_BUILT }));
  }

  /* ---------------- inbound webhooks ----------------

     Unauthenticated, deliberately. GHL's Custom Webhook workflow action posts
     with no HMAC, so there was never a signature to verify, and the owner has
     chosen to skip a shared secret as well.

     What that forces is in lib/ghl-webhook.js: the payload is treated as hostile
     input, and no mirror write happens until its locationId has been matched
     against the connected sub-accounts. This route does three things only —
     bound the body, bound the request rate, and store the payload. Validation
     and dispatch belong to the worker, because a slow handler here makes GHL
     retry into duplicates. */

  const allowIp = ipLimiter({ max: 60, windowMs: 60_000 });

  /* 256KB rather than 1MB: an unauthenticated endpoint is a memory-pressure
     target, and a lead payload is a few KB. Malformed JSON is answered quietly
     rather than falling through to Express's HTML error page. */
  const webhookBody = express.json({ limit: '256kb' });
  const readBody = (req, res, next) =>
    webhookBody(req, res, err => err
      ? res.status(400).json({ ok: false })
      : next());

  r.post('/webhooks/ghl', readBody, async (req, res) => {
    if (!allowIp(req.ip)) return res.status(429).json({ ok: false });

    const { eventType, externalId } = rawLabels(req.body);

    try {
      await query(
        `INSERT INTO webhook_events (provider, event_type, external_id, payload)
         VALUES ('ghl', $1, $2, $3)`,
        [eventType, externalId, req.body ?? {}]
      );
    } catch (err) {
      console.error('[webhooks/ghl] could not store event:', err.message);
      /* 500 here is correct: the event was genuinely not accepted, and GHL
         retrying is what we want. Contrast with a rejected payload below, which
         is stored and answered 200 because retrying will not help it. */
      return res.status(500).json({ ok: false });
    }

    /* 200 immediately, and nothing about the payload is reflected back. A prober
       learns the same thing from a valid locationId as from an invalid one. */
    res.status(200).json({ ok: true });
  });

  return r;
}
