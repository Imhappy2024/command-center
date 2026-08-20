/* GoHighLevel sub-accounts, leads and threads.

   Reads come from the Postgres mirror and never call GHL. Writes go to GHL and
   are mirrored from its response, so the dashboard is correct before the webhook
   lands. Nothing here writes to the mirror speculatively.

   A location whose first sync has not finished is reported as exactly that.
   "No leads" and "we have not looked yet" are different facts. */

import express from 'express';
import { accountsFor, upsertStaticToken, deleteAccount } from '../lib/accounts.js';
import {
  verifyLocation, GhlError, CHANNEL_TO_GHL,
  searchConversations, sendMessage, getOpportunity, updateContact, updateOpportunity
} from '../providers/ghl.js';
import { query } from '../db/index.js';
import { ipLimiter, rawLabels } from '../lib/ghl-webhook.js';
import {
  backfillDetached, everSynced, tokenFor,
  upsertContact, upsertOpportunity, upsertMessage,
  syncStatus, startBackfill, startAllBackfills
} from '../lib/ghl-sync.js';
import { toUiStage, toGhlStage, statusForUiStage, UI_STAGES } from '../lib/ghl-stages.js';
import { resume, run as limited } from '../lib/ghl-limiter.js';
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

/* A lead id is '<locationId>:<opportunityId>'. Split on the first colon only:
   GHL ids are alphanumeric, but the location half is what scopes every query and
   it must not be recoverable from a crafted second colon. */
function splitLeadId(raw){
  const s = String(raw || '');
  const at = s.indexOf(':');
  if (at < 1 || at === s.length - 1) return { locationId: null, opportunityId: null };
  return { locationId: s.slice(0, at), opportunityId: s.slice(at + 1) };
}

/* ---------------- display strings ----------------
   Computed server-side, in AGENT_TIMEZONE, because the Leads view does no date
   arithmetic — it renders the string it is handed. Same convention as
   lib/normalise.js uses for mail. */

const TZ = process.env.AGENT_TIMEZONE || undefined;

const dayKey = d => new Intl.DateTimeFormat('en-CA',
  { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const monthDay = d => new Intl.DateTimeFormat('en-US',
  { timeZone: TZ, month: 'short', day: 'numeric' }).format(d);
const clock = d => new Intl.DateTimeFormat('en-GB',
  { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const fullDate = d => new Intl.DateTimeFormat('en-US',
  { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' }).format(d);

const asDate = v => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/* 'now', '12m', '2h', 'Yesterday', 'Aug 4'. The calendar checks come after the
   sub-hour ones so something 20 hours old that crossed midnight reads
   'Yesterday' rather than '20h'. */
function relativeTime(value, now = Date.now()){
  const d = asDate(value);
  if (!d) return '';
  const ms = now - d.getTime();
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;

  const today = dayKey(new Date(now));
  const then = dayKey(d);
  if (then === today) return `${Math.max(1, Math.floor(ms / 3_600_000))}h`;
  if (then === dayKey(new Date(now - 86_400_000))) return 'Yesterday';
  return monthDay(d);
}

function dayLabel(value, now = Date.now()){
  const d = asDate(value);
  if (!d) return '';
  const then = dayKey(d);
  if (then === dayKey(new Date(now))) return 'Today';
  if (then === dayKey(new Date(now - 86_400_000))) return 'Yesterday';
  return monthDay(d);
}

const clockLabel = value => { const d = asDate(value); return d ? clock(d) : ''; };
const longDate = value => { const d = asDate(value); return d ? fullDate(d) : ''; };

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

  /* ---------------- sync status ----------------

     Backfill fires on a successful connect and, for env-seeded sub-accounts, at
     boot. That covers the happy path and leaves two holes: a run that fails
     halfway has no way back, and a seeded location never passes through the
     sheet where progress would be shown. These three routes are both fixes. */

  r.get('/api/ghl/sync', auth.require, guarded('api/ghl/sync', async (req, res) => {
    res.json({ locations: await syncStatus() });
  }));

  /* 202, not 200: a backfill is minutes. The response says it was accepted, and
     GET /api/ghl/sync is where the outcome shows up. */
  r.post('/api/ghl/sync/:locationId', auth.require,
    guarded('api/ghl/sync:one', async (req, res) => {
      const out = await startBackfill(req.params.locationId, {
        env,
        /* Discards the resume cursor. What you want after editing the stage map,
           since resuming would skip everything already paged. */
        full: req.query.full === '1'
      });
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.status(202).json({ ok: true });
    }));

  r.post('/api/ghl/sync', auth.require, guarded('api/ghl/sync:all', async (req, res) => {
    const out = await startAllBackfills({ env, full: req.query.full === '1' });
    res.status(202).json({ ok: true, started: out.started });
  }));

  /* ---------------- reads ----------------

     The mirror only. No GHL call happens in a read path — that is the entire
     point of holding a mirror, and it is what keeps the Leads view fast and
     independent of GHL's rate limits.

     A location that has never finished a sync is reported as exactly that. "No
     leads" and "we have not looked yet" are different facts and the dashboard
     must not render them identically. */

  /* Which locations this request covers, and what to warn about. */
  async function scope(which){
    const all = await locations();
    const chosen = (!which || which === 'all')
      ? all
      : all.filter(a => a.id === `ghl:${which}` || a.id === which);

    const warnings = [];
    for (const a of chosen) {
      const locationId = a.id.replace(/^ghl:/, '');
      if (a.status !== 'ok') {
        warnings.push({ account: a.id, label: a.label,
          error: a.lastError || 'The token was rejected. Rotate it and reconnect.' });
        continue;
      }
      if (!(await everSynced(locationId))) {
        warnings.push({ account: a.id, label: a.label,
          error: 'First sync has not finished yet, so this sub-account may be incomplete.' });
      }
    }
    return { ids: chosen.map(a => a.id.replace(/^ghl:/, '')), warnings };
  }

  /* Newest activity first. The stage filter is applied after mapping, because a
     UI stage is derived from a GHL stage name and cannot be expressed in SQL.
     The row cap is generous for a four-sub-account dashboard and is stated in the
     response rather than silently applied. */
  const LEAD_ROWS = 1000;

  r.get('/api/ghl/leads', auth.require, guarded('api/ghl/leads', async (req, res) => {
    const { ids, warnings } = await scope(req.query.location);
    if (!ids.length) return res.json({ leads: [], warnings });

    const { rows } = await query(
      `WITH msg AS (
         SELECT location_id, contact_id,
                MAX(sent_at) AS last_at,
                MAX(CASE WHEN direction = 'in'  THEN sent_at END) AS last_in,
                MAX(CASE WHEN direction = 'out' THEN sent_at END) AS last_out
           FROM ghl_messages
          WHERE location_id = ANY($1)
          GROUP BY location_id, contact_id
       )
       SELECT o.location_id, o.opportunity_id, o.contact_id, o.stage_name, o.status,
              o.value, o.name AS opp_name, o.owner AS opp_owner, o.date_added,
              o.updated_at,
              c.name AS contact_name, c.phone, c.email, c.source, c.tags,
              c.owner AS contact_owner,
              m.last_at, m.last_in, m.last_out
         FROM ghl_opportunities o
         LEFT JOIN ghl_contacts c
                ON c.location_id = o.location_id
               AND c.contact_id  = o.contact_id
               AND NOT c.deleted
         LEFT JOIN msg m
                ON m.location_id = o.location_id
               AND m.contact_id  = o.contact_id
        WHERE o.location_id = ANY($1) AND NOT o.deleted
        ORDER BY COALESCE(m.last_at, o.updated_at, o.date_added) DESC NULLS LAST
        LIMIT ${LEAD_ROWS}`,
      [ids]
    );

    if (rows.length === LEAD_ROWS) {
      warnings.push({ account: 'ghl', label: 'Leads',
        error: `Showing the ${LEAD_ROWS} most recently active leads; older ones are not listed.` });
    }

    const wantStage = String(req.query.stage || 'all');
    const leads = rows
      .map(row => {
        const activity = row.last_at || row.updated_at || row.date_added;
        const sortKey = activity ? Date.parse(activity) : 0;
        return {
          id: `${row.location_id}:${row.opportunity_id}`,
          loc: row.location_id,
          name: row.contact_name || row.opp_name || '(no name)',
          phone: row.phone || '',
          email: row.email || '',
          source: row.source || '',
          owner: row.contact_owner || row.opp_owner || '',
          stage: toUiStage(row.stage_name, row.status),
          /* NUMERIC arrives from pg as a string. */
          value: Number(row.value) || 0,
          tags: Array.isArray(row.tags) ? row.tags : [],
          last: relativeTime(sortKey),
          sortKey,
          /* An inbound message newer than the newest outbound one. */
          unread: Boolean(row.last_in) &&
            (!row.last_out || Date.parse(row.last_in) > Date.parse(row.last_out)),
          created: longDate(row.date_added),
          ghlId: row.opportunity_id
        };
      })
      .filter(l => wantStage === 'all' || l.stage === wantStage);

    res.json({ leads, warnings });
  }));

  r.get('/api/ghl/leads/:id/thread', auth.require, guarded('api/ghl/leads:thread', async (req, res) => {
    const { locationId, opportunityId } = splitLeadId(req.params.id);
    if (!locationId) return res.status(400).json({ error: 'malformed lead id' });

    const allowed = new Set((await locations()).map(a => a.id.replace(/^ghl:/, '')));
    if (!allowed.has(locationId)) return res.status(404).json({ error: 'no such sub-account' });

    const { rows: opp } = await query(
      `SELECT contact_id FROM ghl_opportunities
        WHERE location_id = $1 AND opportunity_id = $2 AND NOT deleted`,
      [locationId, opportunityId]);
    if (!opp.length) return res.status(404).json({ error: 'no such lead' });
    if (!opp[0].contact_id) return res.json({ thread: [] });

    const { rows } = await query(
      `SELECT direction, channel, body, sent_at
         FROM ghl_messages
        WHERE location_id = $1 AND contact_id = $2
        ORDER BY sent_at ASC
        LIMIT 500`,
      [locationId, opp[0].contact_id]);

    /* day and time are computed here because the UI does no date arithmetic on
       a thread — it groups on the string it is given. */
    res.json({
      thread: rows.map(m => ({
        dir: m.direction,
        channel: m.channel,
        body: m.body || '',
        day: dayLabel(m.sent_at),
        time: clockLabel(m.sent_at),
        sentAt: m.sent_at
      }))
    });
  }));

  /* ---------------- writes ----------------

     Every write goes to GHL first and is mirrored from its response, so the
     dashboard is correct before the webhook lands rather than waiting on it.
     Nothing here writes to the mirror speculatively: if GHL rejects the call,
     the mirror is untouched and the UI reverts. */

  /* The lead, from the mirror, with its location proved against the allow-list.
     Returns a string on failure so the caller can answer with the right status. */
  async function loadLead(rawId){
    const { locationId, opportunityId } = splitLeadId(rawId);
    if (!locationId) return { error: 'malformed lead id', status: 400 };

    const allowed = new Set((await locations()).map(a => a.id.replace(/^ghl:/, '')));
    if (!allowed.has(locationId)) return { error: 'no such sub-account', status: 404 };

    const { rows } = await query(
      `SELECT location_id, opportunity_id, contact_id, pipeline_id, stage_id,
              stage_name, status, value, name
         FROM ghl_opportunities
        WHERE location_id = $1 AND opportunity_id = $2 AND NOT deleted`,
      [locationId, opportunityId]);
    if (!rows.length) return { error: 'no such lead', status: 404 };

    return { locationId, opportunityId, row: rows[0] };
  }

  /* The stages of the pipeline this opportunity sits in, from the mirror. */
  async function stagesOf(locationId, pipelineId){
    if (!pipelineId) return [];
    const { rows } = await query(
      `SELECT stages FROM ghl_pipelines WHERE location_id = $1 AND pipeline_id = $2`,
      [locationId, pipelineId]);
    return Array.isArray(rows[0]?.stages) ? rows[0].stages : [];
  }

  /* What a GHL opportunity's stage means in the UI's six. Needs the pipeline to
     turn a stage id into the name the map keys on. */
  async function uiStageOf(locationId, opp){
    const stages = await stagesOf(locationId, opp.pipelineId);
    const name = stages.find(s => s.id === opp.stageId)?.name || null;
    return toUiStage(name, opp.status);
  }

  /* GhlError carries the actionable wording and a kind the UI can branch on.
     Anything else is reported as itself rather than dressed up as a GHL error. */
  const failWrite = (res, err) => {
    if (err instanceof GhlError) {
      return res.status(400).json({ error: err.message, kind: err.kind });
    }
    console.error('[api/ghl:write]', err.message);
    return res.status(400).json({ error: err.message });
  };

  r.post('/api/ghl/leads/:id/message', auth.require, express.json(),
    guarded('api/ghl/leads:message', async (req, res) => {
      const found = await loadLead(req.params.id);
      if (found.error) return res.status(found.status).json({ error: found.error });

      const { locationId, row } = found;
      if (!row.contact_id) {
        return res.status(400).json({ error: 'This lead has no contact in GHL, so there is nobody to message.' });
      }

      const channel = String(req.body?.channel || 'sms').toLowerCase();
      const text = String(req.body?.body ?? '').trim();
      const type = CHANNEL_TO_GHL[channel];

      if (!type) {
        return res.status(400).json({
          error: `channel must be one of ${Object.keys(CHANNEL_TO_GHL).join(', ')}`
        });
      }
      if (!text) return res.status(400).json({ error: 'Nothing to send.' });

      try {
        const token = await tokenFor(locationId);

        /* An existing thread is reused when there is one. GHL opens a new
           conversation on its own when conversationId is omitted, so there is no
           create call to make — and inventing one would risk a duplicate thread. */
        const convos = await limited(locationId,
          () => searchConversations(token, locationId, { contactId: row.contact_id, limit: 1 }));

        const sent = await limited(locationId, () => sendMessage(token, {
          type,
          contactId: row.contact_id,
          message: text,
          conversationId: convos[0]?.conversationId
        }));

        /* origin='dashboard' and GHL's own message id as the key. The
           OutboundMessage webhook that follows collides here and does nothing,
           which is the whole echo suppression. */
        const sentAt = new Date().toISOString();
        await upsertMessage(locationId, {
          messageId: sent.messageId,
          conversationId: sent.conversationId,
          contactId: row.contact_id,
          direction: 'out',
          channel,
          body: text,
          sentAt
        }, 'dashboard');

        /* Shaped like a thread row so the UI can swap its optimistic one out. */
        res.json({
          message: {
            dir: 'out',
            channel,
            body: text,
            day: dayLabel(sentAt),
            time: clockLabel(sentAt),
            sentAt
          }
        });
      } catch (err) {
        return failWrite(res, err);
      }
    }));

  r.patch('/api/ghl/leads/:id', auth.require, express.json(),
    guarded('api/ghl/leads:patch', async (req, res) => {
      const found = await loadLead(req.params.id);
      if (found.error) return res.status(found.status).json({ error: found.error });

      const { locationId, opportunityId, row } = found;
      const b = req.body || {};

      const contactFields = {};
      for (const f of ['name', 'phone', 'email', 'owner']) {
        if (b[f] !== undefined) contactFields[f] = String(b[f] ?? '').trim();
      }

      const wantStage = b.stage === undefined ? null : String(b.stage).toLowerCase();
      const wantValue = b.value === undefined ? null : Number(b.value);

      if (wantValue !== null && !Number.isFinite(wantValue)) {
        return res.status(400).json({ error: 'value must be a number' });
      }
      if (wantStage && !UI_STAGES.includes(wantStage)) {
        return res.status(400).json({ error: `stage must be one of ${UI_STAGES.join(', ')}` });
      }
      if (!Object.keys(contactFields).length && !wantStage && wantValue === null) {
        return res.status(400).json({ error: 'nothing to update' });
      }

      let token;
      try { token = await tokenFor(locationId); }
      catch (err) { return failWrite(res, err); }

      /* ---- the stage conflict guard ----
         A GHL workflow may have moved this lead while the dashboard held a stale
         value. Writing blind would revert the automation, so the current stage is
         re-read from GHL — not from the mirror, which the same webhook delay
         would have left equally stale. */
      let live = null;
      if (wantStage && b.expectedStage !== undefined) {
        try {
          live = await limited(locationId, () => getOpportunity(token, opportunityId));
        } catch (err) { return failWrite(res, err); }
        if (!live) return res.status(404).json({ error: 'This lead no longer exists in GHL.' });

        const actual = await uiStageOf(locationId, live);
        if (actual !== String(b.expectedStage).toLowerCase()) {
          /* Mirrored first: the dashboard should show GHL's truth immediately,
             not just be told about it. */
          await upsertOpportunity(locationId, live);
          return res.status(409).json({
            error: `GHL has already moved this lead to ${actual}.`,
            stage: actual
          });
        }
      }

      /* Contact first, then opportunity, so a failure part-way through is
         reported against a known order rather than an arbitrary one. */
      const applied = [];

      if (Object.keys(contactFields).length) {
        if (!row.contact_id) {
          return res.status(400).json({ error: 'This lead has no contact in GHL to edit.' });
        }
        try {
          const updated = await limited(locationId,
            () => updateContact(token, row.contact_id, contactFields));
          if (updated) await upsertContact(locationId, updated);
          applied.push(...Object.keys(contactFields));
        } catch (err) {
          return failWrite(res, err);
        }
      }

      if (wantStage || wantValue !== null) {
        const patch = {};

        if (wantStage) {
          const stages = await stagesOf(locationId, row.pipeline_id);
          if (!stages.length) {
            return res.status(400).json({
              error: 'This lead\'s pipeline has not been mirrored yet, so its stages are unknown. Try again after the next sync.',
              applied
            });
          }
          const target = toGhlStage(wantStage, stages, 'open');
          if (!target) {
            /* Reported rather than guessed. Moving the lead to an arbitrary
               stage because the names do not line up is worse than refusing. */
            return res.status(400).json({
              error: `No stage in this pipeline maps to "${wantStage}". Rename a GHL stage or edit lib/ghl-stages.js.`,
              applied
            });
          }
          patch.pipelineStageId = target.id;
          patch.pipelineId = row.pipeline_id;
          /* won and lost are status changes in GHL, not just moves. Writing the
             stage alone would leave the opportunity open in every GHL report. */
          patch.status = statusForUiStage(wantStage);
        }

        if (wantValue !== null) patch.monetaryValue = wantValue;

        try {
          const updated = await limited(locationId,
            () => updateOpportunity(token, opportunityId, patch));
          if (updated) await upsertOpportunity(locationId, updated);
          if (wantStage) applied.push('stage');
          if (wantValue !== null) applied.push('value');
        } catch (err) {
          /* Honest partial failure: the contact edits above did land, and saying
             otherwise would make the UI revert a change GHL has accepted. */
          if (applied.length) {
            const detail = err instanceof GhlError ? err.message : err.message;
            return res.status(400).json({
              error: `Saved ${applied.join(' and ')}, but the opportunity update failed: ${detail}`,
              applied
            });
          }
          return failWrite(res, err);
        }
      }

      res.json({ ok: true, applied });
    }));

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
