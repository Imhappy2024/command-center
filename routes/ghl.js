/* GoHighLevel sub-accounts, leads and threads.

   Reads come from Supabase and never touch GHL. An external pipeline (a backfill
   script and n8n webhooks) owns GHL -> Supabase; command-center is a reader of
   that mirror and a writer of exactly two things:

     - outbound messages, because GHL owns delivery
     - the contact and stage edits the detail panel makes

   Nothing here pages GHL, and nothing here creates, alters or drops a ghl_*,
   lead or appointment table. If a screen wants data that is not in Supabase,
   that is a gap in the ingest pipeline, and this file says so rather than
   reaching for the API. */

import express from 'express';
import {
  GhlError, CHANNEL_TO_GHL,
  sendMessage, updateContact, updateOpportunity
} from '../providers/ghl.js';
/* Portal-table queries (send path, stage mirror, diag counts) use the GHL
   pool; the webhook receiver's INSERT into webhook_events uses ours. */
import { query as ownQuery, ghlQuery as query, describeDb, ownDbUrl, ghlDbUrl } from '../db/index.js';
import { ipLimiter, rawLabels } from '../lib/ghl-webhook.js';
import {
  subAccounts, allowedLocationIds, sendableLocationIds, tokenFor,
  leadRows, leadTotal, loadLead as loadLeadRow,
  threadFor, pendingInbound, conversationsFor, stagesFor, stageCounts,
  customValuesFor, attributionFor, notesFor, tasksFor, appointmentsFor,
  ingestStatus, locationProfile,
  isActivity, activityLabel, channelOf, dirOf
} from '../lib/ghl-data.js';
import { run as limited } from '../lib/ghl-limiter.js';
import { guarded } from './guard.js';

/* A lead id is '<locationId>:<contactId>', or '<locationId>:o_<opportunityId>'
   for the rare opportunity with no mirrored contact. Split on the first colon
   only: GHL ids are alphanumeric, but the location half is what scopes every
   query and it must not be recoverable from a crafted second colon. */
function splitLeadId(raw){
  const s = String(raw || '');
  const at = s.indexOf(':');
  if (at < 1 || at === s.length - 1) return { locationId: null };
  const locationId = s.slice(0, at);
  const rest = s.slice(at + 1);
  return rest.startsWith('o_')
    ? { locationId, contactId: null, opportunityId: rest.slice(2) }
    : { locationId, contactId: rest, opportunityId: null };
}

/* ---------------- display strings ----------------
   Computed server-side, in AGENT_TIMEZONE, because the Leads view does no date
   arithmetic — it renders the string it is handed. */

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

/* GHL email bodies are HTML. A thread bubble wants text, and rendering sender
   HTML inside the dashboard would be handing a stranger the page. */
function flatten(html){
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function ghlRoutes({ env, auth, live = null }){
  const r = express.Router();

  /* Sub-accounts, straight from ghl_location.

     There is no connect endpoint. command-center holds no GHL connection to
     make: a location is in the sidebar because the ingest pipeline ingested it,
     and it leaves the same way. What used to be POST and DELETE here were the
     two halves of a connection model that no longer exists.

     `senders` used to be mirrored by a GHL phone-number read. That read is gone,
     so addresses come from the location profile and the number list is empty
     rather than faked — GHL's sending numbers are not in the mirror, which is a
     gap in the ingest pipeline and not something to paper over here.

     `sendable` is separate from being listed. Reading needs nothing; sending
     needs a token in command-center's own accounts table. */
  async function shapeLocations(rows){
    const sendable = await sendableLocationIds();
    return Promise.all(rows.map(async a => {
      const profile = await locationProfile(a.id);
      const emails = profile
        ? [...new Set([profile.business_email, profile.email].filter(Boolean))]
        : [];
      return {
        ...a,
        sendable: sendable.has(a.id),
        senders: {
          numbers: [],
          /* Stated, not implied. Without this the composer cannot tell "this
             sub-account has no number" from "we do not know", and it disabled
             Send for the second case — which would block every SMS. */
          numbersUnavailable: true,
          emails,
          email: emails[0] || null
        }
      };
    }));
  }

  r.get('/api/ghl/locations', auth.require, guarded('api/ghl/locations', async (req, res) => {
    res.json({ locations: await shapeLocations(await subAccounts()) });
  }));

  /* One location, same shape as a list row. This is what the live path fetches
     when a ghl_location INSERT is announced: the new row and nothing else, so an
     added sub-account never triggers a re-read of the ones already on screen. */
  r.get('/api/ghl/locations/:id', auth.require, guarded('api/ghl/locations:one', async (req, res) => {
    const rows = await subAccounts(String(req.params.id));
    if (!rows.length) return res.status(404).json({ error: 'no such sub-account' });
    res.json({ location: (await shapeLocations(rows))[0] });
  }));

  /* Server-sent events: NOTIFY payloads from the triggers in
     db/notify-triggers.sql, fanned out as they arrive. Ids only — the browser
     fetches the row it cares about through the routes above.

     Guarded on the handler, not on the object: with background:false the app
     passes a stop-only stub (truthy, no handler), and mounting undefined is an
     Express throw at assembly time — the test that promises no database
     connection is exactly the one that would have crashed. */
  if (live?.handler) r.get('/api/ghl/events', auth.require, live.handler);

  /* The stage cards. Real stages, real counts, pipeline order — never a fixed
     six, because they differ per location and change. */
  r.get('/api/ghl/stages', auth.require, guarded('api/ghl/stages', async (req, res) => {
    const which = String(req.query.location || 'all');
    const allowed = await allowedLocationIds();
    if (which !== 'all' && !allowed.has(which)) {
      return res.status(404).json({ error: 'no such sub-account' });
    }
    res.json({ stages: await stageCounts(which === 'all' ? null : which) });
  }));

  /* ---------------- ingest status ----------------

     command-center no longer runs the sync, so this reports what the pipeline
     that does run has managed, straight out of ghl_sync_log. An entity stuck on
     'pending' has never completed, and that is worth seeing. */

  r.get('/api/ghl/sync', auth.require, guarded('api/ghl/sync', async (req, res) => {
    res.json({ ingest: await ingestStatus() });
  }));

  /* One URL that answers "why is the sidebar empty". Which database this
     process is actually connected to, whether the portal tables are reachable
     and how many rows they hold, and whether the live trigger exists. Every
     check reports its own failure instead of taking the endpoint down. */
  r.get('/api/ghl/diag', auth.require, async (req, res) => {
    const own = describeDb(ownDbUrl());
    const ghl = describeDb(ghlDbUrl());
    const out = {
      /* What the GHL screens read from. This is the one that has to say
         supabase for the sidebar to fill. */
      ghlDb: { ...ghl, via: process.env.SUPABASE_DB_URL ? 'SUPABASE_DB_URL' : 'DATABASE_URL (fallback)' },
      /* Where accounts and webhook_events live. Railway is fine here. */
      ownDb: { ...own, via: 'DATABASE_URL' },
      counts: {},
      liveTrigger: null,
      errors: []
    };
    if (ghl.warning) out.errors.push('SUPABASE_DB_URL: ' + ghl.warning);

    /* Literals, never interpolated input. */
    for (const tbl of ['ghl_location', 'lead', 'ghl_message', 'ghl_opportunity']) {
      try {
        const { rows } = await query(`SELECT COUNT(*)::int AS n FROM ${tbl}`);
        out.counts[tbl] = rows[0].n;
      } catch (err) {
        out.counts[tbl] = null;
        out.errors.push(`${tbl}: ${err.message}`);
      }
    }

    try {
      const { rows } = await query(
        `SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname = 'cc_notify_location'`);
      out.liveTrigger = rows[0].n > 0;
    } catch (err) {
      out.errors.push('trigger check: ' + err.message);
    }

    res.json(out);
  });

  /* Kept mounted rather than deleted so anything still calling them is told why
     rather than getting a 404 that reads as a bug. The Re-sync button they
     existed for is gone from the UI. */
  const notOurs = (req, res) => res.status(501).json({
    error: 'command-center no longer runs the GHL sync. The backfill script and the n8n '
      + 'webhooks own GHL -> Supabase; this dashboard only reads the result. '
      + 'Trigger a run where that pipeline lives.',
    kind: 'validation'
  });
  r.post('/api/ghl/sync/:locationId', auth.require, notOurs);
  r.post('/api/ghl/sync', auth.require, notOurs);

  /* ---------------- reads ---------------- */

  /* Which locations this request covers, and what to warn about. */
  async function scope(which){
    const all = await subAccounts();
    const chosen = (!which || which === 'all')
      ? all
      : all.filter(a => a.id === which);

    const warnings = [];

    /* One warning for the pipeline as a whole, because a stalled ingest is the
       reason a lead would look out of date and there is no per-location signal
       for it. */
    try {
      const ing = await ingestStatus();
      if (ing.failing) {
        const first = ing.entities.find(e => e.status === 'error');
        warnings.push({ account: 'ghl:ingest', label: 'GHL ingest',
          error: `${ing.failing} sync ${ing.failing === 1 ? 'entity is' : 'entities are'} failing`
            + (first?.error ? ` — ${first.entity}: ${first.error}` : '') });
      }
    } catch { /* the panel is a nicety; never fail a read over it */ }

    return { ids: chosen.map(a => a.id), warnings };
  }

  /* Newest activity first. The stage filter is applied after mapping, because a
     UI stage is derived from a GHL stage name and cannot be expressed in SQL.
     The row cap is stated in the response rather than silently applied. */
  const LEAD_ROWS = 1000;

  /* One lead row, shaped for the list. Shared by the list, the delta and the
     single-lead refetch so a live update can never produce a row that differs
     in shape from the one it replaces. */
  function shapeLead(row){
        const sortKey = row.activity ? Date.parse(row.activity) : 0;
        const hasOpportunity = Boolean(row.opportunity_id);
        return {
          id: `${row.location_id}:${row.contact_id || 'o_' + row.opportunity_id}`,
          loc: row.location_id,
          name: row.contact_name || row.opp_name || '(no name)',
          phone: row.phone || '',
          email: row.email || '',
          source: row.source || '',
          /* A name, never an id. Resolved in SQL through staff and ghl_user. */
          owner: row.contact_owner || row.opp_owner || '',
          /* GHL's own stage, not a six-way approximation of it. A contact with
             no opportunity has no stage at all — stage belongs to an
             opportunity, not to a person — and that is now said with null
             rather than asserted as "new" about 3,000 people. */
          stageId: row.stage_id || null,
          stageName: row.stage_name || null,
          /* open | won | lost | abandoned, from GHL. This, not the stage name,
             is what decides whether a lead is still live: "Closed Won" as a
             stage name and a status of open do disagree in this data. */
          status: row.status || null,
          /* NUMERIC arrives from pg as a string. */
          value: Number(row.value) || 0,
          tags: Array.isArray(row.tags) ? row.tags : [],
          last: relativeTime(sortKey),
          sortKey,
          unread: Boolean(row.last_in) &&
            (!row.last_out || Date.parse(row.last_in) > Date.parse(row.last_out)),
          created: longDate(row.date_added),
          ghlId: row.opportunity_id || null,
          contactId: row.contact_id || null,
          hasOpportunity,
          /* The delta cursor. The browser keeps the max it has seen and asks
             for rows changed after it — server clock, never the browser's. */
          changedAt: row.changed_at || null
        };
  }

  r.get('/api/ghl/leads', auth.require, guarded('api/ghl/leads', async (req, res) => {
    const { ids, warnings } = await scope(req.query.location);
    if (!ids.length) return res.json({ leads: [], warnings, delta: false });

    /* ?since=<iso> returns only rows changed after that instant. Malformed
       values are refused rather than silently treated as "everything", because
       the browser would then merge a full list believing it was a delta. */
    let since = null;
    if (req.query.since) {
      const t = Date.parse(String(req.query.since));
      if (Number.isNaN(t)) return res.status(400).json({ error: 'since must be an ISO timestamp' });
      since = new Date(t).toISOString();
    }

    const rows = await leadRows(ids, LEAD_ROWS, { since });

    if (!since && rows.length === LEAD_ROWS) {
      const total = await leadTotal(ids);
      warnings.push({ account: 'ghl', label: 'Leads',
        error: `Showing the ${LEAD_ROWS} most recently active of ${total.toLocaleString()} leads. `
          + 'Filter by sub-account or stage to narrow it.' });
    }

    /* The stage NAME, because that is what the cards show and because a card
       folded across pipelines has no single stage id to match on. */
    const wantStage = String(req.query.stage || 'all');
    const leads = rows.map(shapeLead)
      .filter(l => wantStage === 'all' || l.stageName === wantStage);

    res.json({ leads, warnings, delta: Boolean(since), serverTime: new Date().toISOString() });
  }));

  /* One lead, shaped exactly like a list row. The live path fetches this when a
     lead, opportunity or message event names a contact: that row and nothing
     else, so a change to one lead never re-reads the other 3,000. */
  r.get('/api/ghl/leads/:id', auth.require, guarded('api/ghl/leads:one', async (req, res) => {
    const found = await loadLead(req.params.id);
    if (found.error) return res.status(found.status).json({ error: found.error });
    if (!found.contactId) return res.status(404).json({ error: 'no such lead' });

    const rows = await leadRows([found.locationId], 1, { contactId: found.contactId });
    if (!rows.length) return res.status(404).json({ error: 'no such lead' });
    res.json({ lead: shapeLead(rows[0]) });
  }));

  /* Resolves a lead id against the allow-list, then against Supabase. Returns a
     string on failure so the caller can answer with the right status. */
  async function loadLead(rawId){
    const parts = splitLeadId(rawId);
    if (!parts.locationId) return { error: 'malformed lead id', status: 400 };

    const allowed = await allowedLocationIds();
    if (!allowed.has(parts.locationId)) return { error: 'no such sub-account', status: 404 };

    const found = await loadLeadRow(parts.locationId, parts);
    if (!found) return { error: 'no such lead', status: 404 };
    return found;
  }

  /* The full conversation.

     Messages and activity are returned apart. TYPE_ACTIVITY_* rows are system
     events GHL files in the same table — opportunity moves, appointment
     bookings — and folding them into the bubbles makes a thread read as noise.
     One contact here has 34 real messages and 18 activity records.

     `thread` keeps the shape the view already renders, so activity and pending
     are additive. */
  r.get('/api/ghl/leads/:id/thread', auth.require, guarded('api/ghl/leads:thread', async (req, res) => {
    const found = await loadLead(req.params.id);
    if (found.error) return res.status(found.status).json({ error: found.error });
    if (!found.contactId) return res.json({ thread: [], activity: [], pending: [] });

    const rows = await threadFor(found.locationId, found.contactId);

    const thread = [];
    const activity = [];

    for (const m of rows) {
      const at = m.ghl_date_added;
      const common = { day: dayLabel(at), time: clockLabel(at), sentAt: at };

      if (isActivity(m.message_type)) {
        activity.push({ ...common, kind: activityLabel(m.message_type), body: flatten(m.body) });
        continue;
      }

      thread.push({
        ...common,
        dir: dirOf(m.direction),
        channel: channelOf(m.message_type),
        subject: m.subject || null,
        /* Flattened, not raw HTML: sender markup is never injected into the page. */
        body: m.content_type === 'text/html' ? flatten(m.body) : (m.body || ''),
        attachments: Array.isArray(m.attachments) ? m.attachments.length : 0,
        actor: m.actor || null,
        status: m.status || null,
        /* Distinguishes a message this dashboard sent from one GHL reported. */
        origin: m.origin || 'ghl'
      });
    }

    /* Inbound webhooks arrive with no ids, so they cannot be keyed into
       ghl_message. They are real messages the thread must still show, marked so
       nobody mistakes them for reconciled history. */
    const pending = (await pendingInbound(found.locationId, found.contactId)).map(p => ({
      dir: 'in',
      channel: 'other',
      body: p.body_text || flatten(p.body),
      day: dayLabel(p.received_at),
      time: clockLabel(p.received_at),
      sentAt: p.received_at,
      unreconciled: true,
      attachments: Array.isArray(p.attachment_urls) ? p.attachment_urls.length : 0
    }));

    res.json({ thread, activity, pending });
  }));

  /* Everything the detail panel shows that is not the conversation. One request
     rather than five, because they are always wanted together. */
  r.get('/api/ghl/leads/:id/detail', auth.require, guarded('api/ghl/leads:detail', async (req, res) => {
    const found = await loadLead(req.params.id);
    if (found.error) return res.status(found.status).json({ error: found.error });
    if (!found.contactId) {
      return res.json({ fields: [], attribution: [], notes: [], tasks: [], appointments: [], conversations: [] });
    }

    const [fields, attribution, notes, tasks, appointments, conversations] = await Promise.all([
      customValuesFor(found.contactId),
      attributionFor(found.contactId),
      notesFor(found.contactId),
      tasksFor(found.contactId),
      appointmentsFor(found.contactId),
      conversationsFor(found.locationId, found.contactId)
    ]);

    res.json({
      /* Field name from the definition, not the raw JSON blob on lead. */
      fields: fields.map(f => ({
        name: f.name,
        value: f.value ?? (f.value_json === null ? '' : JSON.stringify(f.value_json)),
        type: f.data_type || null
      })),
      /* Two rows per contact: first touch and last touch, kept separate because
         collapsing them loses the only interesting thing about attribution. */
      attribution: attribution.map(a => ({
        which: a.is_first ? 'first' : (a.is_last ? 'last' : 'other'),
        source: a.utm_source || a.session_source || a.utm_session_source || null,
        medium: a.utm_medium || null,
        campaign: a.utm_campaign || a.campaign || null,
        ad: a.ad_name || null,
        url: a.page_url || null,
        referrer: a.referrer || a.referrer_url || null,
        at: longDate(a.created_at)
      })),
      notes: notes.map(n => ({
        body: n.body || '',
        author: n.author || null,
        at: longDate(n.ghl_created_at)
      })),
      tasks: tasks.map(t => ({
        title: t.title || '(untitled)',
        body: t.body || '',
        due: longDate(t.due_date),
        done: Boolean(t.completed),
        assignee: t.assignee || null
      })),
      /* A calendar has an owner: appointment -> ghl_calendar -> ghl_user -> staff. */
      appointments: appointments.map(a => ({
        title: a.title || '(untitled)',
        calendar: a.calendar || null,
        owner: a.owner || null,
        status: a.status || null,
        day: dayLabel(a.start_time),
        time: clockLabel(a.start_time),
        at: longDate(a.start_time)
      })),
      conversations: conversations.map(c => ({
        id: c.ghl_conversation_id,
        unread: Number(c.unread_count) || 0,
        starred: Boolean(c.starred),
        last: relativeTime(c.last_message_date)
      }))
    });
  }));

  /* ---------------- writes ----------------

     GhlError carries the actionable wording and a kind the UI can branch on.
     Anything else is reported as itself rather than dressed up as a GHL error. */
  const failWrite = (res, err) => {
    if (err instanceof GhlError) {
      return res.status(400).json({ error: err.message, kind: err.kind });
    }
    console.error('[api/ghl:write]', err.message);
    return res.status(400).json({ error: err.message });
  };

  /* Sending is the one place command-center still calls GHL, because GHL owns
     delivery. It never writes an outbound message straight into Supabase and
     calls it sent — it asks GHL to send, and the record arrives back through the
     webhook. The optimistic row below exists only to make that echo a no-op. */
  r.post('/api/ghl/leads/:id/message', auth.require, express.json({ limit: '1mb' }),
    guarded('api/ghl/leads:message', async (req, res) => {
      const found = await loadLead(req.params.id);
      if (found.error) return res.status(found.status).json({ error: found.error });

      const { locationId, contactId } = found;
      if (!contactId) {
        return res.status(400).json({ error: 'This lead has no contact in GHL, so there is nobody to message.' });
      }

      const b = req.body || {};
      const channel = String(b.channel || 'sms').toLowerCase();
      const type = CHANNEL_TO_GHL[channel];
      if (!type) {
        return res.status(400).json({
          error: `channel must be one of ${Object.keys(CHANNEL_TO_GHL).join(', ')}`
        });
      }

      const isEmail = channel === 'email';
      const text = String(b.body ?? '').trim();
      const html = String(b.html ?? '').trim();
      const subject = String(b.subject ?? '').trim();

      if (!text && !html) return res.status(400).json({ error: 'Nothing to send.' });

      /* Required for email, and blocked here with a reason rather than sent
         without one and quietly filed by GHL as '(no subject)'. */
      if (isEmail && !subject) {
        return res.status(400).json({
          error: 'A subject is required for email.',
          kind: 'validation',
          field: 'subject'
        });
      }
      if (!isEmail && subject) {
        /* Not an error worth blocking, but it is not sent either. */
        console.warn('[api/ghl:message] subject ignored on a %s send', channel);
      }

      /* The From address must be one GHL has verified for this sub-account.
         Anything else is rejected at GHL, after the optimistic UI has already
         shown the message as sent — so it is checked here first. */
      let emailFrom;
      if (isEmail) {
        const asked = String(b.from || '').trim();
        if (asked) {
          const profile = await locationProfile(locationId);
          const known = [profile?.business_email, profile?.email].filter(Boolean);
          if (known.length && !known.includes(asked)) {
            return res.status(400).json({
              error: `${asked} is not a known sending address on this sub-account. `
                + `Known: ${known.join(', ')}.`,
              kind: 'validation',
              field: 'from'
            });
          }
          emailFrom = asked;
        }
        /* Left unset otherwise, and GHL uses its verified default. Guessing an
           address is how a send fails after being shown as sent. */
      }

      /* SMS sending numbers are not in the mirror, so no number is named and GHL
         uses the sub-account's default. Naming one would mean guessing. */
      const fromNumber = undefined;

      /* Being listed and being sendable are different things now. A location is
         readable because the pipeline ingested it; sending needs a GHL token,
         which lives in command-center's own accounts table and arrives through
         GHL_TOKEN_* seeding. Said before the attempt, because the alternative is
         an "Unknown connection ghl:..." thrown from the token lookup. */
      if (!(await sendableLocationIds()).has(locationId)) {
        return res.status(400).json({
          error: 'No GHL send token for this sub-account. Reading works without one, but sending '
            + `needs GHL_TOKEN_<NAME> with GHL_LOCATION_<NAME>=${locationId} and the `
            + 'conversations/message.write scope.',
          kind: 'validation'
        });
      }

      let sent;
      try {
        const token = await tokenFor(locationId);
        sent = await limited(locationId, () => sendMessage(token, {
          type,
          contactId,
          message: isEmail ? undefined : text,
          html: isEmail ? (html || text) : undefined,
          subject: isEmail ? subject : undefined,
          emailFrom,
          emailTo: isEmail ? (String(b.to || '').trim() || undefined) : undefined,
          emailCc: isEmail ? b.cc : undefined,
          emailBcc: isEmail ? b.bcc : undefined,
          attachments: b.attachments,
          fromNumber
        }));
      } catch (err) {
        /* Surfaced, never swallowed. A silent failure on an outbound message is
           worse than an error, because the operator believes it went. */
        console.error('[api/ghl:send] failed for %s/%s (%s): %s',
          locationId, contactId, channel, err.message);
        return failWrite(res, err);
      }

      /* Every send is logged: an outbound message is an action taken on a
         customer's behalf and needs a trail independent of GHL. */
      console.log('[api/ghl:send] ok location=%s contact=%s type=%s message=%s',
        locationId, contactId, type, sent.messageId);

      const sentAt = new Date().toISOString();

      /* Echo suppression. GHL's own id is the key, and origin='dashboard' marks
         it as ours; the OutboundMessage webhook that follows carries the same id
         and ON CONFLICT DO NOTHING makes it a no-op.

         ghl_message.ghl_conversation_id is NOT NULL, and conversationId is a
         response-only field — so when GHL does not return one there is nowhere
         to put the row. Skipped rather than invented: the webhook will insert it
         once, which is correct, just slower. A fabricated id would duplicate. */
      const conversationId = sent.conversationId
        || (await conversationsFor(locationId, contactId))[0]?.ghl_conversation_id
        || null;

      if (conversationId) {
        try {
          const { rows: lead } = await query(
            `SELECT id FROM lead WHERE ghl_contact_id = $1`, [contactId]);
          await query(
            `INSERT INTO ghl_message
               (ghl_message_id, ghl_conversation_id, ghl_location_id, ghl_contact_id,
                lead_id, direction, message_type, body, subject, ghl_date_added, origin)
             VALUES ($1, $2, $3, $4, $5, 'outbound', $6, $7, $8, $9, 'dashboard')
               ON CONFLICT (ghl_message_id) DO NOTHING`,
            [sent.messageId, conversationId, locationId, contactId, lead[0]?.id || null,
             isEmail ? 'TYPE_EMAIL' : `TYPE_${type.toUpperCase()}`,
             isEmail ? (html || text) : text,
             isEmail ? subject : null,
             sentAt]);
        } catch (err) {
          /* The send succeeded. Failing the request now would tell the operator
             it did not, and they would send again. */
          console.error('[api/ghl:send] sent but not recorded locally:', err.message);
        }
      } else {
        console.warn('[api/ghl:send] no conversation id returned; leaving the row to the webhook');
      }

      /* Shaped like a thread row so the UI can swap its optimistic one out. */
      res.json({
        message: {
          dir: 'out',
          channel,
          subject: isEmail ? subject : null,
          body: isEmail ? flatten(html || text) : text,
          day: dayLabel(sentAt),
          time: clockLabel(sentAt),
          sentAt,
          origin: 'dashboard',
          messageId: sent.messageId
        }
      });
    }));

  r.patch('/api/ghl/leads/:id', auth.require, express.json(),
    guarded('api/ghl/leads:patch', async (req, res) => {
      const found = await loadLead(req.params.id);
      if (found.error) return res.status(found.status).json({ error: found.error });

      const { locationId, contactId, opportunity } = found;
      const b = req.body || {};

      const contactFields = {};
      for (const f of ['name', 'phone', 'email', 'owner']) {
        if (b[f] !== undefined) contactFields[f] = String(b[f] ?? '').trim();
      }

      /* A real ghl_stage_id, validated against this location's pipeline below.
         It used to be one of six invented keys mapped onto GHL's stage names by
         pattern, which silently merged Qualified, Demo Scheduled and Demo
         Complete into one and could not express the other four at all. */
      const wantStage = b.stageId === undefined ? null : String(b.stageId).trim();
      const wantValue = b.value === undefined ? null : Number(b.value);

      if (wantValue !== null && !Number.isFinite(wantValue)) {
        return res.status(400).json({ error: 'value must be a number' });
      }
      if (!Object.keys(contactFields).length && !wantStage && wantValue === null) {
        return res.status(400).json({ error: 'nothing to update' });
      }

      /* A stage belongs to an opportunity, not to a person. Refused rather than
         quietly creating one, which would put a lead into a pipeline nobody
         asked for. */
      if ((wantStage || wantValue !== null) && !opportunity) {
        return res.status(400).json({
          error: 'This lead has no opportunity in GHL, so it has no stage or value to change. '
            + 'Create an opportunity for it in GHL first.',
          kind: 'validation'
        });
      }

      let token;
      try { token = await tokenFor(locationId); }
      catch (err) { return failWrite(res, err); }

      /* ---- the stage conflict guard ----
         A GHL workflow may have moved this lead while the dashboard held a stale
         value, and writing blind would revert the automation.

         This used to re-read the opportunity from GHL. Reads are no longer this
         dashboard's to make, so the check is against Supabase — which means it
         is only as fresh as the ingest pipeline. A move GHL made in the last few
         minutes can still be reverted by a write from here. Narrowing that
         window is the pipeline's job, not a reason to call GHL. */
      if (wantStage && b.expectedStageId !== undefined
          && String(b.expectedStageId) !== String(opportunity.stageId || '')) {
        return res.status(409).json({
          error: `GHL has already moved this lead to ${opportunity.stageName || 'another stage'}.`,
          stageId: opportunity.stageId,
          stageName: opportunity.stageName
        });
      }

      /* Contact first, then opportunity, so a failure part-way through is
         reported against a known order rather than an arbitrary one. */
      const applied = [];

      if (Object.keys(contactFields).length) {
        if (!contactId) {
          return res.status(400).json({ error: 'This lead has no contact in GHL to edit.' });
        }
        const patch = {};
        if (contactFields.name !== undefined) {
          const [first, ...rest] = contactFields.name.split(/\s+/);
          patch.firstName = first || '';
          patch.lastName = rest.join(' ');
        }
        if (contactFields.phone !== undefined) patch.phone = contactFields.phone;
        if (contactFields.email !== undefined) patch.email = contactFields.email;

        try {
          await limited(locationId, () => updateContact(token, contactId, patch));
          applied.push(...Object.keys(contactFields));
        } catch (err) {
          return failWrite(res, err);
        }
      }

      if (wantStage || wantValue !== null) {
        /* Both restated on every call, because GHL requires them even when only
           the value is changing. */
        const patch = { pipelineId: opportunity.pipelineId, pipelineStageId: opportunity.stageId };

        if (!opportunity.pipelineId || !opportunity.stageId) {
          return res.status(400).json({
            error: 'This opportunity has no pipeline or stage in Supabase yet, so it cannot be '
              + 'updated. It will be usable once the ingest pipeline has filled it in.',
            kind: 'validation',
            applied
          });
        }

        if (wantStage) {
          const stages = await stagesFor(locationId, opportunity.pipelineId);
          if (!stages.length) {
            return res.status(400).json({
              error: 'This pipeline has no stages in Supabase yet, so the target stage is unknown.',
              applied
            });
          }
          /* The id has to belong to THIS opportunity's pipeline. Passing a stage
             id from another pipeline is the one way this endpoint could move a
             lead somewhere nobody could see it. */
          const target = stages.find(s => s.id === wantStage);
          if (!target) {
            return res.status(400).json({
              error: 'That stage is not in this opportunity\'s pipeline.',
              kind: 'validation',
              applied
            });
          }
          patch.pipelineStageId = target.id;
          /* Status is left alone. GHL tracks open/won/lost separately from the
             stage, and this data has a "Closed Won" stage sitting at status
             open — so inferring one from the other would overwrite a fact with
             a guess. Change status explicitly when that is what is wanted. */
        }
        if (wantValue !== null) patch.monetaryValue = wantValue;

        try {
          await limited(locationId, () => updateOpportunity(token, opportunity.id, patch));
          if (wantStage) applied.push('stage');
          if (wantValue !== null) applied.push('value');
        } catch (err) {
          return failWrite(res, err);
        }

        /* Mirroring a write command-center just made, so the row reflects it
           before the webhook lands. This is not a read of GHL. */
        try {
          await query(
            `UPDATE ghl_opportunity
                SET ghl_stage_id   = COALESCE($2, ghl_stage_id),
                    monetary_value = COALESCE($3, monetary_value),
                    updated_at     = now()
              WHERE ghl_opportunity_id = $1`,
            [opportunity.id,
             wantStage ? patch.pipelineStageId : null,
             wantValue !== null ? wantValue : null]);
        } catch (err) {
          console.error('[api/ghl:patch] wrote to GHL but not to Supabase:', err.message);
        }
      }

      res.json({ ok: true, applied });
    }));

  /* ---------------- webhooks ----------------

     Unauthenticated by design, and the live path that keeps the dashboard from
     going stale. This handler only stores; validation and dispatch belong to the
     worker, because a slow handler here makes GHL retry into duplicates. */

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
      await ownQuery(
        `INSERT INTO webhook_events (provider, event_type, external_id, payload)
         VALUES ('ghl', $1, $2, $3)`,
        [eventType, externalId, req.body ?? {}]
      );
    } catch (err) {
      console.error('[webhooks/ghl] could not store event:', err.message);
      /* 500 here is correct: the event was genuinely not accepted, and GHL
         retrying is what we want. Contrast with a rejected payload, which is
         stored and answered 200 because retrying will not help it. */
      return res.status(500).json({ ok: false });
    }

    /* 200 immediately, and nothing about the payload is reflected back. A prober
       learns the same thing from a valid locationId as from an invalid one. */
    res.status(200).json({ ok: true });
  });

  return r;
}
