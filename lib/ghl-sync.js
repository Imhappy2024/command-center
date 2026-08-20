/* The GHL mirror: the only place that writes ghl_contacts, ghl_pipelines,
   ghl_opportunities and ghl_messages.

   GHL is the source of truth and these tables are a read mirror, so there are
   exactly two callers of everything below — the webhook processor and the sync
   job. No request handler writes here. That is the whole reason this file
   contains no merge logic: there are never two writable copies of a lead. */

import { query } from '../db/index.js';
import { accountsFor, getStaticToken } from './accounts.js';

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

export async function setState(locationId, resource, { cursor, lastRun, lastError } = {}){
  await query(
    `INSERT INTO sync_state (key, cursor, last_run, last_error, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (key) DO UPDATE SET
       cursor     = EXCLUDED.cursor,
       last_run   = COALESCE(EXCLUDED.last_run, sync_state.last_run),
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [stateKey(locationId, resource),
     cursor === undefined ? null : (cursor === null ? null : JSON.stringify(cursor)),
     lastRun || null,
     lastError ? String(lastError).slice(0, 500) : null]
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
