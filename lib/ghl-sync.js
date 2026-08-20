/* The GHL mirror: the only place that writes ghl_contacts, ghl_pipelines,
   ghl_opportunities and ghl_messages.

   GHL is the source of truth and these tables are a read mirror, so there are
   exactly two callers of everything below — the webhook processor and the sync
   job. No request handler writes here. That is the whole reason this file
   contains no merge logic: there are never two writable copies of a lead. */

import { query } from '../db/index.js';
import * as ghl from '../providers/ghl.js';
import { accountsFor, getStaticToken } from './accounts.js';
import { run as limited } from './ghl-limiter.js';

export const mirrorId = (locationId, recordId) => `${locationId}:${recordId}`;

/* ---------------------------------------------------------------------------
   Connected locations and their tokens.
   --------------------------------------------------------------------------- */

/* The allow-list. Every mirror write is keyed on a locationId that came from
   here, never straight from a webhook payload. */
export async function locations(){
  const rows = await accountsFor('leads');
  return rows.map(a => ({
    accountId: a.id,
    locationId: a.id.replace(/^ghl:/, ''),
    label: a.label,
    status: a.status
  }));
}

export async function locationIds(){
  return (await locations()).map(l => l.locationId);
}

export async function tokenFor(locationId){
  const { token } = await getStaticToken(`ghl:${locationId}`);
  return token;
}

/* ---------------------------------------------------------------------------
   sync_state — one row per resource per location, so an interrupted backfill
   resumes from its cursor rather than starting over.
   --------------------------------------------------------------------------- */

const stateKey = (locationId, resource) => `ghl:${locationId}:${resource}`;

export async function getState(locationId, resource){
  const { rows } = await query(`SELECT * FROM sync_state WHERE key = $1`,
    [stateKey(locationId, resource)]);
  return rows[0] || null;
}

export async function setState(locationId, resource, { cursor, lastRun, lastError, status, startedAt, finishedAt } = {}){
  await query(
    `INSERT INTO sync_state
       (key, cursor, last_run, last_error, status, started_at, finished_at, updated_at)
     VALUES ($1,$2,$3,$4, COALESCE($5,'idle'), $6, $7, now())
     ON CONFLICT (key) DO UPDATE SET
       cursor      = EXCLUDED.cursor,
       last_run    = COALESCE(EXCLUDED.last_run, sync_state.last_run),
       last_error  = EXCLUDED.last_error,
       /* Only moved when a caller says so, so a pagination write mid-run does not
          knock the row out of 'running'. */
       status      = COALESCE($5, sync_state.status),
       started_at  = COALESCE(EXCLUDED.started_at, sync_state.started_at),
       finished_at = COALESCE(EXCLUDED.finished_at, sync_state.finished_at),
       updated_at  = now()`,
    [stateKey(locationId, resource),
     cursor === undefined ? null : (cursor === null ? null : JSON.stringify(cursor)),
     lastRun || null,
     lastError ? String(lastError).slice(0, 500) : null,
     status || null,
     startedAt || null,
     finishedAt || null]
  );
}

export function readCursor(row){
  if (!row?.cursor) return null;
  try { return JSON.parse(row.cursor); } catch { return null; }
}

/* Has this location ever completed a pass? The read routes need to tell "no
   leads" apart from "sync has not run", and answering the two the same way is
   how a dashboard ends up quietly lying. */
export async function everSynced(locationId){
  const { rows } = await query(
    `SELECT 1 FROM sync_state WHERE key LIKE $1 AND last_run IS NOT NULL LIMIT 1`,
    [`ghl:${locationId}:%`]);
  return rows.length > 0;
}

/* ---------------------------------------------------------------------------
   Mirror writers.
   --------------------------------------------------------------------------- */

export async function upsertContact(locationId, c){
  if (!c?.contactId) return null;
  const id = mirrorId(locationId, c.contactId);
  await query(
    `INSERT INTO ghl_contacts
       (id, location_id, contact_id, name, first_name, last_name, phone, email,
        source, owner, tags, custom, date_added, updated_at, seen_at, deleted)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now(), false)
     ON CONFLICT (location_id, contact_id) DO UPDATE SET
       name       = EXCLUDED.name,
       first_name = EXCLUDED.first_name,
       last_name  = EXCLUDED.last_name,
       phone      = EXCLUDED.phone,
       email      = EXCLUDED.email,
       source     = EXCLUDED.source,
       owner      = EXCLUDED.owner,
       tags       = EXCLUDED.tags,
       custom     = EXCLUDED.custom,
       date_added = COALESCE(EXCLUDED.date_added, ghl_contacts.date_added),
       updated_at = now(),
       seen_at    = now(),
       deleted    = false`,
    [id, locationId, c.contactId, c.name || null, c.firstName, c.lastName,
     c.phone, c.email, c.source, c.owner,
     JSON.stringify(c.tags || []), JSON.stringify(c.custom || {}), c.dateAdded]
  );
  return id;
}

export async function upsertPipelines(locationId, pipelines){
  for (const p of pipelines || []) {
    await query(
      `INSERT INTO ghl_pipelines (id, location_id, pipeline_id, name, stages, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (location_id, pipeline_id) DO UPDATE SET
         name = EXCLUDED.name, stages = EXCLUDED.stages, updated_at = now()`,
      [mirrorId(locationId, p.pipelineId), locationId, p.pipelineId,
       p.name, JSON.stringify(p.stages || [])]
    );
  }
  return (pipelines || []).length;
}

/* stage_name is resolved from the mirrored pipeline rather than stored by the
   caller, because an opportunity payload carries only the stage id. Backfill
   therefore does pipelines first; when it has not, this lands NULL and
   toUiStage() falls back rather than inventing a stage. resolveStageNames()
   below repairs those rows once the pipelines arrive. */
export async function upsertOpportunity(locationId, o){
  if (!o?.opportunityId) return null;
  const id = mirrorId(locationId, o.opportunityId);
  await query(
    `INSERT INTO ghl_opportunities
       (id, location_id, opportunity_id, contact_id, pipeline_id, stage_id, stage_name,
        status, name, value, owner, date_added, updated_at, seen_at, deleted)
     VALUES ($1,$2,$3,$4,$5,$6,
             (SELECT s->>'name' FROM ghl_pipelines p, jsonb_array_elements(p.stages) s
               WHERE p.location_id = $2 AND p.pipeline_id = $5 AND s->>'id' = $6 LIMIT 1),
             $7,$8,$9,$10,$11, now(), now(), false)
     ON CONFLICT (location_id, opportunity_id) DO UPDATE SET
       contact_id  = EXCLUDED.contact_id,
       pipeline_id = EXCLUDED.pipeline_id,
       stage_id    = EXCLUDED.stage_id,
       stage_name  = COALESCE(EXCLUDED.stage_name, ghl_opportunities.stage_name),
       status      = EXCLUDED.status,
       name        = EXCLUDED.name,
       value       = EXCLUDED.value,
       owner       = EXCLUDED.owner,
       date_added  = COALESCE(EXCLUDED.date_added, ghl_opportunities.date_added),
       updated_at  = now(),
       seen_at     = now(),
       deleted     = false`,
    [id, locationId, o.opportunityId, o.contactId, o.pipelineId, o.stageId,
     o.status, o.name, o.value ?? 0, o.owner, o.dateAdded]
  );
  return id;
}

/* Fills in stage names that were missing when an opportunity was written, and
   corrects every row after a stage is renamed in GHL. */
export async function resolveStageNames(locationId){
  const { rowCount } = await query(
    `UPDATE ghl_opportunities o
        SET stage_name = r.name
       FROM (SELECT p.location_id, p.pipeline_id,
                    s->>'id' AS stage_id, s->>'name' AS name
               FROM ghl_pipelines p, jsonb_array_elements(p.stages) s
              WHERE p.location_id = $1) r
      WHERE o.location_id = r.location_id
        AND o.pipeline_id = r.pipeline_id
        AND o.stage_id    = r.stage_id
        AND o.stage_name IS DISTINCT FROM r.name`,
    [locationId]
  );
  return rowCount;
}

/* The primary key is GHL's own message id, and ON CONFLICT DO NOTHING is the
   echo suppression: a message this dashboard sent is already here with
   origin='dashboard' by the time GHL's OutboundMessage webhook arrives, so the
   webhook write is a no-op and the UI never shows it twice. */
export async function upsertMessage(locationId, m, origin = 'ghl'){
  if (!m?.messageId || !m?.contactId || !m?.sentAt) return null;
  const id = mirrorId(locationId, m.messageId);
  await query(
    `INSERT INTO ghl_messages
       (id, location_id, conversation_id, contact_id, direction, channel, body, sent_at, origin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO NOTHING`,
    [id, locationId, m.conversationId, m.contactId,
     m.direction === 'in' ? 'in' : 'out', m.channel || 'other',
     m.body, m.sentAt, origin]
  );
  return id;
}

/* ---------------------------------------------------------------------------
   Backfill and reconciliation.

   Locations run in series, never Promise.all. Rate limits are per location so
   parallelism would not trip those — the problem is the connection pool, which
   db/index.js caps at 5. Four concurrent page-throughs saturate it and the
   dashboard stops answering during first sync.
   --------------------------------------------------------------------------- */

/* Page caps. Every one of these logs when it truncates: a silent cap reads as
   "everything is mirrored" when it is not. */
const PAGE = 100;
const MAX_PAGES_FULL = 100;          // 10k records per resource per location
const MAX_PAGES_INCREMENTAL = 5;     // an hour of new records, comfortably
const MAX_CONVERSATIONS = 200;

const DAY_MS = 86_400_000;

const inFlight = new Set();

const backfillDays = env => Math.max(1, Number(env?.GHL_BACKFILL_DAYS) || 90);

/* ---------------- pipelines ---------------- */

async function syncPipelines(locationId, token){
  const pipelines = await limited(locationId, () => ghl.listPipelines(token, locationId));
  await upsertPipelines(locationId, pipelines);
  /* Opportunities mirrored before their pipeline arrived have a null stage_name.
     This is what repairs them, and what corrects every row after a stage rename
     in GHL. */
  await resolveStageNames(locationId);
  await setState(locationId, 'pipelines', { lastRun: new Date().toISOString(), cursor: null });
  return pipelines;
}

/* ---------------- contacts ---------------- */

/* `since` turns this into an incremental pass: page newest-first and stop once
   the page predates it.

   The honest limitation: GHL's contact list is ordered by dateAdded, not
   dateUpdated, and the endpoint set this build uses has no updatedAfter filter.
   So an incremental pass reliably catches *new* contacts, while an edit to an
   old one arrives by webhook (contact.updated) and, failing that, on the daily
   full pass. Both backstops are real; neither is silent. */
async function syncContacts(locationId, token, { since = null, onPage } = {}){
  const resource = 'contacts';
  const maxPages = since ? MAX_PAGES_INCREMENTAL : MAX_PAGES_FULL;
  const resumed = since ? null : readCursor(await getState(locationId, resource));

  let cursor = resumed;
  let pages = 0;
  let seen = 0;
  let complete = true;

  for (;;) {
    if (pages >= maxPages) {
      console.warn(`[ghl:sync] ${locationId} contacts stopped at the ${maxPages}-page cap `
        + `(${seen} mirrored); the rest waits for the next pass`);
      complete = false;
      break;
    }

    const { items, next } = await limited(locationId,
      () => ghl.listContacts(token, locationId, { ...(cursor || {}), limit: PAGE }));

    for (const c of items) { await upsertContact(locationId, c); seen++; }
    pages++;
    await onPage?.(seen, pages);

    if (since && items.length) {
      const oldest = items.reduce((min, c) =>
        Math.min(min, Date.parse(c.dateAdded || 0) || 0), Infinity);
      if (oldest && oldest < Date.parse(since)) break;
    }

    if (!next) break;
    cursor = next;
    /* Cursor persisted per page so an interrupted backfill resumes where it
       stopped rather than starting the location over. */
    if (!since) await setState(locationId, resource, { cursor });
  }

  await setState(locationId, resource, {
    cursor: null,
    lastRun: complete ? new Date().toISOString() : null
  });
  return { seen, complete };
}

/* ---------------- opportunities ---------------- */

async function syncOpportunities(locationId, token, { since = null, onPage } = {}){
  const resource = 'opportunities';
  const maxPages = since ? MAX_PAGES_INCREMENTAL : MAX_PAGES_FULL;
  const resumed = since ? null : readCursor(await getState(locationId, resource));

  let cursor = resumed;
  let pages = 0;
  let seen = 0;
  let complete = true;

  for (;;) {
    if (pages >= maxPages) {
      console.warn(`[ghl:sync] ${locationId} opportunities stopped at the ${maxPages}-page cap `
        + `(${seen} mirrored); the rest waits for the next pass`);
      complete = false;
      break;
    }

    const { items, next } = await limited(locationId,
      () => ghl.searchOpportunities(token, locationId, { ...(cursor || {}), limit: PAGE }));

    for (const o of items) { await upsertOpportunity(locationId, o); seen++; }
    pages++;
    await onPage?.(seen, pages);

    if (since && items.length) {
      const oldest = items.reduce((min, o) =>
        Math.min(min, Date.parse(o.updatedAt || o.dateAdded || 0) || 0), Infinity);
      if (oldest && oldest < Date.parse(since)) break;
    }

    if (!next) break;
    cursor = next;
    if (!since) await setState(locationId, resource, { cursor });
  }

  await setState(locationId, resource, {
    cursor: null,
    lastRun: complete ? new Date().toISOString() : null
  });
  return { seen, complete };
}

/* ---------------- conversations ---------------- */

/* Only threads with activity inside the window. A full message history on a
   large sub-account is not worth the request budget, and the Leads view shows a
   recent thread rather than an archive. */
async function syncConversations(locationId, token, { days, onPage }){
  const cutoff = Date.now() - days * DAY_MS;
  let startAfterDate;
  let convos = 0;
  let messages = 0;
  let truncated = false;

  outer:
  for (let page = 0; page < 20; page++) {
    const batch = await limited(locationId,
      () => ghl.searchConversations(token, locationId, { startAfterDate, limit: PAGE }));
    if (!batch.length) break;

    for (const c of batch) {
      const at = Date.parse(c.lastMessageAt || 0) || 0;
      if (at && at < cutoff) break outer;
      if (convos >= MAX_CONVERSATIONS) { truncated = true; break outer; }

      const { items } = await limited(locationId,
        () => ghl.listMessages(token, c.conversationId, { limit: PAGE }));
      for (const m of items) {
        if (await upsertMessage(locationId, { ...m, contactId: m.contactId || c.contactId })) {
          messages++;
        }
      }
      convos++;
      await onPage?.(messages, convos);
    }

    const last = batch[batch.length - 1];
    const next = Date.parse(last.lastMessageAt || 0) || 0;
    if (!next || next === startAfterDate) break;
    startAfterDate = next;
  }

  if (truncated) {
    console.warn(`[ghl:sync] ${locationId} conversations stopped at the `
      + `${MAX_CONVERSATIONS}-thread cap; older threads are not mirrored`);
  }

  await setState(locationId, 'conversations', { lastRun: new Date().toISOString(), cursor: null });
  return { convos, messages };
}

/* ---------------------------------------------------------------------------
   Backfill on connect.
   --------------------------------------------------------------------------- */

/* Order is not arbitrary: opportunities carry stage ids that mean nothing until
   the pipelines are mirrored, and messages hang off contacts. */
export async function backfill(locationId, env = process.env, { full = false } = {}){
  if (inFlight.has(locationId)) return { skipped: 'already running' };
  inFlight.add(locationId);

  const started = Date.now();
  const startedAt = new Date().toISOString();
  const counts = { contacts: 0, opportunities: 0, messages: 0, page: 0 };

  /* Written straight through rather than batched. A progress number that lags
     the work is worse than none — the sheet polls this every three seconds and
     a stalled count reads as a stalled sync. */
  const publish = async () => {
    await setState(locationId, 'backfill', { cursor: counts }).catch(() => {});
  };

  try {
    /* full discards the resumable cursors, which is what you want after editing
       the stage mapping: the resume path would otherwise skip everything already
       paged and never re-evaluate it. */
    if (full) {
      for (const resource of ['contacts', 'opportunities']) {
        await setState(locationId, resource, { cursor: null });
      }
    }

    await setState(locationId, 'backfill', {
      status: 'running', startedAt, lastRun: startedAt, lastError: null, cursor: counts
    });

    const token = await tokenFor(locationId);

    const pipelines = await syncPipelines(locationId, token);
    const contacts = await syncContacts(locationId, token, {
      onPage: async (seen, page) => { counts.contacts = seen; counts.page = page; await publish(); }
    });
    const opportunities = await syncOpportunities(locationId, token, {
      onPage: async (seen, page) => { counts.opportunities = seen; counts.page = page; await publish(); }
    });
    await resolveStageNames(locationId);
    const conversations = await syncConversations(locationId, token, {
      days: backfillDays(env),
      onPage: async written => { counts.messages = written; await publish(); }
    });

    counts.contacts = contacts.seen;
    counts.opportunities = opportunities.seen;
    counts.messages = conversations.messages;

    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`[ghl:sync] ${locationId} backfilled in ${secs}s — `
      + `${pipelines.length} pipelines, ${contacts.seen} contacts, `
      + `${opportunities.seen} opportunities, ${conversations.messages} messages`);

    /* Contacts arriving while opportunities stay at zero is the signature of a
       rejected query rather than an empty pipeline: /opportunities/search answers
       200 with an empty list when a required parameter is wrong, so it cannot be
       told apart from "no opportunities" by status code alone. Said out loud
       because the Leads view is built on opportunities, so this reads to the user
       as the whole integration being broken. */
    if (contacts.seen > 0 && opportunities.seen === 0) {
      console.warn(`[ghl:sync] ${locationId} mirrored ${contacts.seen} contacts but no `
        + 'opportunities. If this sub-account does have opportunities in GHL, check that '
        + 'the token carries opportunities.readonly and that its pipelines are visible.');
    }
    if (!pipelines.length) {
      console.warn(`[ghl:sync] ${locationId} returned no pipelines. Opportunities will `
        + 'mirror without a stage name and fall back to "contacted".');
    }

    await setState(locationId, 'backfill', {
      status: 'done',
      cursor: counts,
      lastRun: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      lastError: null
    });
    return { contacts: contacts.seen, opportunities: opportunities.seen };
  } catch (err) {
    console.error(`[ghl:sync] ${locationId} backfill failed:`, err.message);
    /* Counts are kept on failure. They are how far it got, which is the first
       thing anyone retrying wants to know. */
    await setState(locationId, 'backfill', {
      status: 'failed',
      cursor: counts,
      lastError: err.message,
      finishedAt: new Date().toISOString()
    }).catch(() => {});
    throw err;
  } finally {
    inFlight.delete(locationId);
  }
}

/* Fire and forget, for the paths that must not wait: the connect sheet closing,
   and the first reconcile tick after a deploy. */
export function backfillDetached(locationId, env, opts){
  backfill(locationId, env, opts).catch(() => {});
}

export const isBackfilling = locationId => inFlight.has(locationId);

/* ---------------------------------------------------------------------------
   Status, and re-running by hand.
   --------------------------------------------------------------------------- */

/* One row per connected location, whether or not it has ever synced. A location
   with no backfill row reports 'idle' rather than being omitted — the Leads view
   has to be able to tell "never synced" from "no leads", and a missing entry
   would collapse the two. */
export async function syncStatus(){
  const locs = await locations();
  if (!locs.length) return [];

  /* What is actually in the mirror, which is a different question from what the
     last run pulled. A location can report 3,600 contacts pulled and still have
     no opportunities, and telling those apart is the difference between "still
     working" and "this sub-account does not use pipelines". */
  const { rows: tally } = await query(
    `SELECT l.location_id,
            (SELECT COUNT(*) FROM ghl_contacts c
              WHERE c.location_id = l.location_id AND NOT c.deleted)      AS contacts,
            (SELECT COUNT(*) FROM ghl_opportunities o
              WHERE o.location_id = l.location_id AND NOT o.deleted)      AS opportunities,
            (SELECT COUNT(*) FROM ghl_pipelines p
              WHERE p.location_id = l.location_id)                        AS pipelines,
            (SELECT COUNT(*) FROM ghl_messages m
              WHERE m.location_id = l.location_id)                        AS messages
       FROM (SELECT unnest($1::text[]) AS location_id) l`,
    [locs.map(l => l.locationId)]);

  const mirroredBy = new Map(tally.map(t => [t.location_id, {
    contacts: Number(t.contacts) || 0,
    opportunities: Number(t.opportunities) || 0,
    pipelines: Number(t.pipelines) || 0,
    messages: Number(t.messages) || 0
  }]));

  const { rows } = await query(
    `SELECT key, cursor, status, started_at, finished_at, last_error
       FROM sync_state WHERE key LIKE 'ghl:%:backfill'`);

  const byLocation = new Map(
    rows.map(r => [r.key.replace(/^ghl:/, '').replace(/:backfill$/, ''), r]));

  return locs.map(l => {
    const row = byLocation.get(l.locationId);
    let counts = { contacts: 0, opportunities: 0, messages: 0 };
    if (row?.cursor) {
      try {
        const c = JSON.parse(row.cursor);
        counts = {
          contacts: Number(c.contacts) || 0,
          opportunities: Number(c.opportunities) || 0,
          messages: Number(c.messages) || 0
        };
      } catch { /* a malformed cursor is not worth failing a status read over */ }
    }

    /* The in-process set is the authority while this container is up. A row left
       'running' by a crash or a redeploy would otherwise block a restart
       forever, so it is reported as failed instead. */
    const live = inFlight.has(l.locationId);
    const stored = row?.status || 'idle';
    const status = live ? 'running'
      : stored === 'running' ? 'failed'
      : stored;

    const mirrored = mirroredBy.get(l.locationId)
      || { contacts: 0, opportunities: 0, pipelines: 0, messages: 0 };

    return {
      id: l.locationId,
      label: l.label,
      status,
      startedAt: row?.started_at || null,
      finishedAt: row?.finished_at || null,
      counts,
      /* Row counts from the mirror itself. `counts` is what the last run pulled;
         this is what is there now, and only this can answer "does this
         sub-account use pipelines at all". */
      mirrored,
      /* The specific, common case worth naming: a location with contacts, no
         pipelines and no opportunities is not mid-sync and not broken — it simply
         does not use GHL Opportunities, and the Leads view is built on those. */
      usesPipelines: mirrored.pipelines > 0,
      error: status === 'failed'
        ? (row?.last_error || 'The sync stopped without finishing, probably a restart mid-run.')
        : null
    };
  });
}

/* Starts or restarts one location. Returns a reason string when it will not
   start, so the route can answer 409 rather than pretending it did. */
export async function startBackfill(locationId, { env = process.env, full = false } = {}){
  const known = new Set(await locationIds());
  if (!known.has(locationId)) return { error: 'no such sub-account', status: 404 };
  if (inFlight.has(locationId)) return { error: 'a sync is already running for this sub-account', status: 409 };

  backfillDetached(locationId, env, { full });
  return { started: true };
}

/* Every location that is not already running. Sequential is guaranteed by the
   backfill queue itself rather than by this function: each call returns
   immediately and the limiter serialises per location, while the pool cap is
   respected because runAll awaits each one in turn. */
export async function startAllBackfills({ env = process.env, full = false } = {}){
  const rows = await syncStatus();
  const wanted = rows.filter(r => r.status !== 'running' && (full || r.status !== 'done'));
  if (!wanted.length) return { started: [] };

  /* Chained rather than fanned out. Four concurrent page-throughs would saturate
     a five-connection pool and make the dashboard unresponsive during first
     sync — the same reason reconcile iterates in series. */
  (async () => {
    for (const r of wanted) {
      if (inFlight.has(r.id)) continue;
      try { await backfill(r.id, env, { full }); }
      catch { /* recorded on the row; the next location still runs */ }
    }
  })();

  return { started: wanted.map(r => r.id) };
}

/* Called after the env seeder. A location with no backfill row has never run
   one; a failed row is worth retrying on a fresh boot. A 'done' location is left
   alone — restarting it every deploy would re-page the whole history. */
export async function backfillPending({ env = process.env } = {}){
  const rows = await syncStatus();
  const wanted = rows.filter(r => r.status === 'idle' || r.status === 'failed');
  if (!wanted.length) return { started: [] };

  console.log(`[ghl:sync] ${wanted.length} sub-account(s) need a first backfill: `
    + wanted.map(r => r.label).join(', '));

  (async () => {
    for (const r of wanted) {
      try { await backfill(r.id, env); }
      catch { /* recorded on the row */ }
    }
  })();

  return { started: wanted.map(r => r.id) };
}

/* ---------------------------------------------------------------------------
   Reconciliation.
   --------------------------------------------------------------------------- */

/* Webhook delete events are unreliable across most CRMs, so deletion is decided
   here instead. After a pass that covered everything, a row not touched by that
   pass is gone from GHL.

   Guarded on the pass having completed cleanly. A pass that hit a page cap or
   threw covers only part of the location, and sweeping on that would mark live
   leads deleted. */
async function sweepDeleted(locationId, passStart){
  const contacts = await query(
    `UPDATE ghl_contacts SET deleted = true
      WHERE location_id = $1 AND seen_at < $2 AND NOT deleted`,
    [locationId, passStart]);
  const opps = await query(
    `UPDATE ghl_opportunities SET deleted = true
      WHERE location_id = $1 AND seen_at < $2 AND NOT deleted`,
    [locationId, passStart]);

  const total = contacts.rowCount + opps.rowCount;
  if (total) {
    console.log(`[ghl:sync] ${locationId} marked ${contacts.rowCount} contacts and `
      + `${opps.rowCount} opportunities deleted`);
  }
  return total;
}

/* Nothing is ever hard-deleted. The read routes filter on NOT deleted, so a row
   that comes back in GHL is simply un-deleted by the next upsert. */
export async function reconcileLocation(locationId, { env = process.env, full = false } = {}){
  const passStart = new Date().toISOString();

  if (!(await everSynced(locationId))) {
    /* Never synced. An incremental pass against an empty mirror is not a
       reconcile, it is a backfill, so run the real thing. */
    await backfill(locationId, env);
    return { backfilled: true };
  }

  const token = await tokenFor(locationId);
  await syncPipelines(locationId, token);

  const since = full ? null : (await getState(locationId, 'reconcile'))?.last_run || null;
  const contacts = await syncContacts(locationId, token, { since });
  const opportunities = await syncOpportunities(locationId, token, { since });
  await resolveStageNames(locationId);

  let swept = 0;
  if (full && contacts.complete && opportunities.complete) {
    swept = await sweepDeleted(locationId, passStart);
  } else if (full) {
    console.warn(`[ghl:sync] ${locationId} full pass was truncated, skipping the delete sweep`);
  }

  await setState(locationId, 'reconcile', { lastRun: passStart, cursor: null });
  if (full) await setState(locationId, 'full', { lastRun: passStart, cursor: null });

  return { contacts: contacts.seen, opportunities: opportunities.seen, swept };
}

/* An unauthenticated endpoint grows this table without bound otherwise. */
export async function pruneWebhookEvents(days = 30){
  const { rowCount } = await query(
    `DELETE FROM webhook_events WHERE received_at < now() - ($1 || ' days')::interval`,
    [String(days)]);
  if (rowCount) console.log(`[ghl:sync] pruned ${rowCount} webhook events older than ${days}d`);
  return rowCount;
}

async function dueForFull(locationId){
  const row = await getState(locationId, 'full');
  if (!row?.last_run) return true;
  return Date.now() - Date.parse(row.last_run) >= DAY_MS;
}

/* One pass over every connected location, in series. */
export async function reconcile({ env = process.env } = {}){
  const locs = await locations();
  if (!locs.length) return { locations: 0 };

  for (const l of locs) {
    if (l.status !== 'ok') {
      /* A location whose token was rejected is skipped rather than retried every
         hour. It comes back on its own once the token is replaced, because both
         the seeder and the Connect sheet clear the status. */
      continue;
    }
    try {
      await reconcileLocation(l.locationId, { env, full: await dueForFull(l.locationId) });
    } catch (err) {
      console.error(`[ghl:sync] ${l.locationId} reconcile failed:`, err.message);
      await setState(l.locationId, 'reconcile', { lastError: err.message }).catch(() => {});
    }
  }

  await pruneWebhookEvents().catch(err =>
    console.error('[ghl:sync] prune failed:', err.message));

  return { locations: locs.length };
}

export function startReconciler({ env = process.env } = {}){
  const minutes = Math.max(5, Number(env.GHL_RECONCILE_MINUTES) || 60);
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await reconcile({ env }); }
    catch (err) { console.error('[ghl:sync] reconciler:', err.message); }
    finally { busy = false; }
  };

  const timer = setInterval(tick, minutes * 60_000);
  timer.unref?.();

  /* First pass shortly after boot rather than immediately: it lets the health
     check answer and the seeder finish before any page-through starts. */
  const kickoff = setTimeout(tick, 20_000);
  kickoff.unref?.();

  return {
    intervalMinutes: minutes,
    async stop(){
      stopped = true;
      clearInterval(timer);
      clearTimeout(kickoff);
      for (let i = 0; busy && i < 100; i++) await new Promise(r => setTimeout(r, 100));
    }
  };
}
