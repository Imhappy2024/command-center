/* GoHighLevel sub-accounts.

   Connecting is built and verified end to end. Reading leads, threads and
   messaging is not, and says so rather than returning an empty pipeline that
   looks like "no leads". */

import express from 'express';
import { accountsFor, upsertStaticToken, deleteAccount, markReauth } from '../lib/accounts.js';
import { verifyLocation, GhlError } from '../providers/ghl.js';
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
        meta: { locationName: found.name }
      });

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

  /* The receiver has to exist before the write path or the dashboard shows stale
     state confidently. Not built yet, and returning 501 rather than 200 means GHL
     will not think a subscription is healthy when it is not. */
  r.post('/webhooks/ghl', express.json({ limit: '1mb' }), (req, res) =>
    res.status(501).json({ error: 'Webhook receiver not built yet.' }));

  return r;
}

export { markReauth };
