/* GHL data, read from Supabase.

   Supabase is the source of truth. Something else owns the GHL -> Supabase
   pipeline (a backfill script and n8n webhooks); command-center only reads it.
   Nothing in this file calls the GHL API. The single exception in the whole
   codebase is sending a message, which lives in routes/ghl.js.

   Every table read here belongs to the portal schema, not to command-center.
   This module SELECTs and never issues DDL. */

/* Every query in this file is a portal table, so all of them go to the GHL
   database. The one thing here that is NOT — the accounts table behind
   accountsFor/getStaticToken — is reached through lib/accounts.js, which uses
   the own-tables pool. */
import { ghlQuery as query } from '../db/index.js';
import { accountsFor, getStaticToken } from './accounts.js';

/* Activity records are system events GHL files alongside real messages —
   opportunity moves, appointment bookings. They are not human replies, and
   mixing them into a thread makes a conversation read as noise. 16 of one
   contact's 52 rows are activity. */
export const ACTIVITY_PREFIX = 'TYPE_ACTIVITY';
const NOT_ACTIVITY = "COALESCE(message_type,'') NOT LIKE 'TYPE_ACTIVITY%'";

export const isActivity = type =>
  String(type || '').toUpperCase().startsWith(ACTIVITY_PREFIX);

/* Supabase stores GHL's own words. The dashboard has always used in/out. */
export const dirOf = value => (String(value).toLowerCase() === 'inbound' ? 'in' : 'out');

const CHANNEL_BY_TYPE = {
  TYPE_SMS: 'sms',
  TYPE_EMAIL: 'email',
  TYPE_WHATSAPP: 'wa',
  TYPE_FACEBOOK: 'fb',
  TYPE_INSTAGRAM: 'ig',
  TYPE_CALL: 'call',
  TYPE_VOICEMAIL: 'call',
  TYPE_LIVE_CHAT: 'chat'
};
export const channelOf = type => CHANNEL_BY_TYPE[String(type || '').toUpperCase()] || 'other';

const ACTIVITY_LABELS = {
  TYPE_ACTIVITY_OPPORTUNITY: 'Opportunity updated',
  TYPE_ACTIVITY_APPOINTMENT: 'Appointment',
  TYPE_ACTIVITY_CONTACT: 'Contact updated',
  TYPE_ACTIVITY: 'Activity'
};

/* Human label for an activity row, so the timeline reads as English. */
export const activityLabel = type =>
  ACTIVITY_LABELS[String(type || '').toUpperCase()]
  || String(type || '').replace(/^TYPE_ACTIVITY_?/i, '').toLowerCase()
  || 'activity';

/* ---------------- sub-accounts ----------------

   Which locations this dashboard may look at comes from command-center's own
   accounts table, not from Supabase. It is the allow-list that stops a webhook
   writing into a location nobody connected, and it holds the send token. */

/* Sub-accounts come from the mirror, not from a connection this dashboard holds.

   There is no connect step any more: a location exists here because the ingest
   pipeline put it there. That also makes ghl_location the allow-list the
   unauthenticated webhook is checked against — a payload naming a location the
   pipeline has never ingested writes nothing.

   Only one location is populated today. Whatever rows exist are rendered; the
   list grows on its own as the ingest token's scope widens, with nothing here to
   change. */

/* Deterministic, so a sub-account keeps its colour without a stored preference —
   there is no longer any UI in which to choose one. */
const PALETTE = ['#D9A441', '#4E9E7E', '#5B8DEF', '#C2553F',
                 '#B07FD4', '#4FB8A8', '#E0784A', '#8E9BA8'];
function colourFor(id){
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return PALETTE[h % PALETTE.length];
}

/* ghl_location.company_id is the one column in this file that could not be
   re-verified against the live database, and a missing column is a hard error
   rather than an empty string. Probed once so the brand join is only attempted
   when it can succeed, and the sidebar degrades to no brand instead of 500ing. */
let brandJoin = null;
async function canJoinBrand(){
  if (brandJoin !== null) return brandJoin;
  try {
    const { rows } = await query(
      `SELECT
         (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'ghl_location'
             AND column_name = 'company_id') AS has_col,
         (SELECT COUNT(*) FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'company') AS has_tbl`);
    brandJoin = Number(rows[0]?.has_col) > 0 && Number(rows[0]?.has_tbl) > 0;
  } catch {
    brandJoin = false;
  }
  if (!brandJoin) console.warn('[ghl] ghl_location.company_id or company is absent — sub-accounts render without a brand');
  return brandJoin;
}

export async function subAccounts(onlyId = null){
  const brand = await canJoinBrand();
  const { rows } = await query(
    `SELECT gl.ghl_location_id AS id,
            COALESCE(NULLIF(TRIM(gl.name), ''), gl.ghl_location_id) AS name,
            ${brand ? 'c.name' : 'NULL::text'} AS brand,
            (SELECT COUNT(*) FROM lead l
              WHERE l.ghl_location_id = gl.ghl_location_id)::int AS lead_count,
            (SELECT COUNT(*) FROM ghl_opportunity o
              WHERE o.ghl_location_id = gl.ghl_location_id)::int AS opportunity_count
       FROM ghl_location gl
       ${brand ? 'LEFT JOIN company c ON c.id = gl.company_id' : ''}
      WHERE $1::text IS NULL OR gl.ghl_location_id = $1
      ORDER BY 2`,
    [onlyId]);

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    short: String(r.name).split(/\s+/)[0],
    brand: r.brand || null,
    leads: r.lead_count,
    opportunities: r.opportunity_count,
    color: colourFor(r.id)
  }));
}

/* Ids only. subAccounts() counts every lead and opportunity per location, which
   is right for the sidebar and wasteful on the paths that only need to know
   whether a location is legitimate — thread, detail, send and patch all do, on
   every request. */
export async function allowedLocationIds(){
  const { rows } = await query(`SELECT ghl_location_id FROM ghl_location`);
  return new Set(rows.map(r => r.ghl_location_id));
}

export async function locationIds(){
  return [...(await allowedLocationIds())];
}

/* Sending is the only thing that still needs a GHL credential, and those live in
   command-center's own accounts table. A location with no row here is readable
   and simply cannot be sent from. */
export async function sendableLocationIds(){
  const rows = await accountsFor('leads');
  return new Set(rows.map(a => a.id.replace(/^ghl:/, '')));
}

/* The Private Integration Token for one location. Sending is the only thing
   that needs it; no read path may take it. accountsFor deliberately withholds
   the secret, so this goes through getStaticToken to decrypt. */
export async function tokenFor(locationId){
  const { token } = await getStaticToken(`ghl:${locationId}`);
  return token;
}

/* ---------------- leads ----------------

   Contact-first: a lead is a person. Most have no opportunity at all, and a
   stage belongs to an opportunity rather than to a human being. The second
   branch keeps opportunities whose contact never landed, which a plain join
   would silently drop. */

export async function leadRows(ids, limit){
  const { rows } = await query(
    `WITH msg AS (
       SELECT ghl_location_id AS location_id, ghl_contact_id AS contact_id,
              MAX(ghl_date_added) AS last_at,
              MAX(CASE WHEN direction = 'inbound'  THEN ghl_date_added END) AS last_in,
              MAX(CASE WHEN direction = 'outbound' THEN ghl_date_added END) AS last_out
         FROM ghl_message
        WHERE ghl_location_id = ANY($1) AND ${NOT_ACTIVITY}
        GROUP BY 1, 2
     ),
     opp AS (
       SELECT DISTINCT ON (o.ghl_location_id, o.ghl_contact_id)
              o.ghl_location_id AS location_id,
              o.ghl_contact_id  AS contact_id,
              o.ghl_opportunity_id AS opportunity_id,
              o.ghl_pipeline_id AS pipeline_id,
              o.ghl_stage_id    AS stage_id,
              s.name            AS stage_name,
              o.status,
              o.monetary_value  AS value,
              o.name            AS opp_name,
              COALESCE(ost.full_name, ou.name) AS opp_owner,
              COALESCE(o.ghl_updated_at, o.updated_at) AS updated_at,
              o.ghl_created_at  AS opp_created
         FROM ghl_opportunity o
         LEFT JOIN ghl_pipeline_stage s ON s.ghl_stage_id = o.ghl_stage_id
         LEFT JOIN ghl_user  ou  ON ou.ghl_user_id = o.ghl_assigned_user_id
         LEFT JOIN staff     ost ON ost.id = o.staff_id
        WHERE o.ghl_location_id = ANY($1) AND o.ghl_contact_id IS NOT NULL
        ORDER BY o.ghl_location_id, o.ghl_contact_id,
                 COALESCE(o.ghl_updated_at, o.updated_at) DESC NULLS LAST
     )
     SELECT * FROM (
       SELECT l.ghl_location_id AS location_id,
              l.ghl_contact_id  AS contact_id,
              COALESCE(NULLIF(TRIM(l.full_name), ''),
                       NULLIF(TRIM(CONCAT_WS(' ', l.first_name, l.last_name)), '')) AS contact_name,
              l.phone, l.email, l.source,
              l.tags,
              COALESCE(lst.full_name, lu.name) AS contact_owner,
              l.ghl_date_added AS date_added,
              o.opportunity_id, o.pipeline_id, o.stage_id, o.stage_name,
              o.status, o.value, o.opp_name, o.opp_owner, o.updated_at,
              m.last_at, m.last_in, m.last_out,
              COALESCE(m.last_at, o.updated_at, l.ghl_date_added) AS activity
         FROM lead l
         LEFT JOIN opp      o   ON o.location_id = l.ghl_location_id
                                AND o.contact_id  = l.ghl_contact_id
         LEFT JOIN msg      m   ON m.location_id = l.ghl_location_id
                                AND m.contact_id  = l.ghl_contact_id
         LEFT JOIN staff    lst ON lst.id = l.assigned_staff_id
         LEFT JOIN ghl_user lu  ON lu.ghl_user_id = l.ghl_assigned_user_id
        WHERE l.ghl_location_id = ANY($1)

       UNION ALL

       SELECT o.location_id, o.contact_id,
              NULL AS contact_name, NULL AS phone, NULL AS email, NULL AS source,
              '{}'::text[] AS tags, NULL AS contact_owner,
              o.opp_created AS date_added,
              o.opportunity_id, o.pipeline_id, o.stage_id, o.stage_name,
              o.status, o.value, o.opp_name, o.opp_owner, o.updated_at,
              NULL::timestamptz AS last_at,
              NULL::timestamptz AS last_in,
              NULL::timestamptz AS last_out,
              COALESCE(o.updated_at, o.opp_created) AS activity
         FROM opp o
        WHERE NOT EXISTS (
                SELECT 1 FROM lead l
                 WHERE l.ghl_location_id = o.location_id
                   AND l.ghl_contact_id  = o.contact_id)
     ) leads
      ORDER BY activity DESC NULLS LAST
      LIMIT $2`,
    [ids, limit]);
  return rows;
}

export async function leadTotal(ids){
  const { rows } = await query(
    `SELECT COUNT(*)::int AS contacts FROM lead WHERE ghl_location_id = ANY($1)`, [ids]);
  return Number(rows[0]?.contacts || 0);
}

/* One lead, already proved to be inside an allowed location. Returns the live
   opportunity too, because every write needs its id. */
export async function loadLead(locationId, { contactId, opportunityId }){
  if (contactId) {
    const { rows } = await query(
      `SELECT ghl_contact_id, full_name, first_name, last_name, email, phone
         FROM lead
        WHERE ghl_location_id = $1 AND ghl_contact_id = $2`,
      [locationId, contactId]);
    if (!rows.length) return null;

    /* Same choice the list makes, so a stage write lands on the opportunity the
       row is showing. */
    const { rows: opp } = await query(
      `SELECT o.ghl_opportunity_id, o.ghl_pipeline_id, o.ghl_stage_id,
              s.name AS stage_name, o.status, o.monetary_value, o.name
         FROM ghl_opportunity o
         LEFT JOIN ghl_pipeline_stage s ON s.ghl_stage_id = o.ghl_stage_id
        WHERE o.ghl_location_id = $1 AND o.ghl_contact_id = $2
        ORDER BY COALESCE(o.ghl_updated_at, o.updated_at) DESC NULLS LAST
        LIMIT 1`,
      [locationId, contactId]);

    const c = rows[0];
    return {
      locationId,
      contactId,
      email: c.email || null,
      phone: c.phone || null,
      name: c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
      opportunity: opp[0] ? shapeOpp(opp[0]) : null
    };
  }

  const { rows } = await query(
    `SELECT o.ghl_opportunity_id, o.ghl_contact_id, o.ghl_pipeline_id, o.ghl_stage_id,
            s.name AS stage_name, o.status, o.monetary_value, o.name
       FROM ghl_opportunity o
       LEFT JOIN ghl_pipeline_stage s ON s.ghl_stage_id = o.ghl_stage_id
      WHERE o.ghl_location_id = $1 AND o.ghl_opportunity_id = $2`,
    [locationId, opportunityId]);
  if (!rows.length) return null;

  return {
    locationId,
    contactId: rows[0].ghl_contact_id || null,
    email: null,
    phone: null,
    name: rows[0].name || null,
    opportunity: shapeOpp(rows[0])
  };
}

const shapeOpp = row => ({
  id: row.ghl_opportunity_id,
  pipelineId: row.ghl_pipeline_id,
  stageId: row.ghl_stage_id,
  stageName: row.stage_name,
  status: row.status,
  value: Number(row.monetary_value) || 0,
  name: row.name
});

/* ---------------- conversation ----------------

   Full history. Ordered oldest first, because that is how a thread is read.
   Activity rows come back too; the caller separates them. */

export async function threadFor(locationId, contactId, limit = 1000){
  const { rows } = await query(
    `SELECT m.ghl_message_id, m.ghl_conversation_id, m.direction, m.message_type,
            m.content_type, m.status, m.body, m.subject, m.attachments,
            m.ghl_date_added, m.origin,
            COALESCE(st.full_name, u.name) AS actor
       FROM ghl_message m
       LEFT JOIN ghl_user u  ON u.ghl_user_id = m.ghl_user_id
       LEFT JOIN staff    st ON st.id = m.staff_id
      WHERE m.ghl_location_id = $1 AND m.ghl_contact_id = $2
      ORDER BY m.ghl_date_added ASC NULLS LAST
      LIMIT $3`,
    [locationId, contactId, limit]);
  return rows;
}

/* Inbound webhooks arrive with no message id and no conversation id, so they
   cannot be keyed into ghl_message. They land in ghl_message_inbox and are
   reconciled later; until then they are real messages the thread must show. */
export async function pendingInbound(locationId, contactId){
  const { rows } = await query(
    `SELECT id, body, body_text, received_at, attachment_urls, ghl_conversation_id
       FROM ghl_message_inbox
      WHERE ghl_location_id = $1 AND ghl_contact_id = $2
        AND NOT COALESCE(reconciled, false)
      ORDER BY received_at ASC`,
    [locationId, contactId]);
  return rows;
}

export async function conversationsFor(locationId, contactId){
  const { rows } = await query(
    `SELECT ghl_conversation_id, type, unread_count, starred, last_message_date
       FROM ghl_conversation
      WHERE ghl_location_id = $1 AND ghl_contact_id = $2
        AND NOT COALESCE(deleted, false)
      ORDER BY last_message_date DESC NULLS LAST`,
    [locationId, contactId]);
  return rows;
}

/* ---------------- pipeline ---------------- */

/* Stages are rows with a position, not a JSON blob hanging off the pipeline.

   Scoped through ghl_pipeline rather than by the stage's own ghl_location_id,
   because that column is NULL on every stage row in the mirror today — the
   pipeline carries the location, its stages do not. Filtering on it returned
   zero stages, which the write path reads as "this pipeline has no stages" and
   refuses a stage change over. Going stage -> pipeline -> location is also the
   stronger check: it proves the stage belongs to a pipeline in this location
   rather than trusting a denormalised copy. */
export async function stagesFor(locationId, pipelineId){
  if (!pipelineId) return [];
  const { rows } = await query(
    `SELECT s.ghl_stage_id AS id, s.name, s.position
       FROM ghl_pipeline_stage s
       JOIN ghl_pipeline p ON p.ghl_pipeline_id = s.ghl_pipeline_id
      WHERE s.ghl_pipeline_id = $2 AND p.ghl_location_id = $1
      ORDER BY s.position ASC NULLS LAST`,
    [locationId, pipelineId]);
  return rows;
}

/* The stage cards. Real stages with real counts, in pipeline order.

   Not a fixed six. Folio's are Qualified, Demo Scheduled, Demo Complete,
   Proposal Sent, Long Term Follow Up, Closed Won, Onboard Initiated — and the
   next location's will differ. Hardcoding them showed seven cards of zero while
   three distinct GHL stages collapsed into one label.

   Scoped through ghl_pipeline, for the same reason stagesFor is: every
   ghl_pipeline_stage row has a NULL ghl_location_id, so filtering the stage
   table on it returns nothing at all.

   With no location chosen, stages are folded by name and position: two pipelines
   both having "Proposal Sent" is one card, not two. Which is also why the leads
   filter keys on the stage NAME rather than the id — a folded card has no single
   id to offer, and the name is what the operator is actually pointing at. */
export async function stageCounts(locationId){
  const scoped = Boolean(locationId);
  const { rows } = await query(
    `SELECT ${scoped ? 'MIN(s.ghl_stage_id) AS id' : 'NULL::text AS id'},
            s.name,
            MIN(s.position) AS position,
            COUNT(o.id)::int AS opportunities,
            COALESCE(SUM(o.monetary_value), 0) AS value
       FROM ghl_pipeline_stage s
       JOIN ghl_pipeline p ON p.ghl_pipeline_id = s.ghl_pipeline_id
       LEFT JOIN ghl_opportunity o ON o.ghl_stage_id = s.ghl_stage_id
      WHERE ($1::text IS NULL OR p.ghl_location_id = $1)
      GROUP BY s.name${scoped ? ', s.ghl_stage_id' : ''}
      ORDER BY 3 ASC NULLS LAST, s.name`,
    [locationId || null]);

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    position: Number(r.position) || 0,
    count: r.opportunities,
    value: Number(r.value) || 0
  }));
}

/* ---------------- extras the detail panel shows ---------------- */

/* Custom values as rows with their field name, rather than parsing the JSON
   blob on lead. The field definition is what turns a key into a label. */
export async function customValuesFor(contactId){
  const { rows } = await query(
    `SELECT COALESCE(NULLIF(v.field_name, ''), f.name, v.field_key) AS name,
            v.value, v.value_json, f.data_type, f.position
       FROM ghl_contact_custom_value v
       LEFT JOIN ghl_custom_field f ON f.ghl_custom_field_id = v.ghl_custom_field_id
      WHERE v.ghl_contact_id = $1
        AND (COALESCE(v.value, '') <> '' OR v.value_json IS NOT NULL)
      ORDER BY f.position ASC NULLS LAST, 1 ASC`,
    [contactId]);
  return rows;
}

/* Two rows per contact: first touch and last touch. Collapsing them into one
   loses the only interesting thing about attribution. */
export async function attributionFor(contactId){
  const { rows } = await query(
    `SELECT is_first, is_last, utm_source, utm_medium, utm_campaign, utm_content,
            session_source, utm_session_source, page_url, referrer, referrer_url,
            campaign, ad_name, gclid, fbclid, created_at
       FROM ghl_attribution
      WHERE ghl_contact_id = $1
      ORDER BY is_first DESC, created_at ASC`,
    [contactId]);
  return rows;
}

export async function notesFor(contactId){
  const { rows } = await query(
    `SELECT n.ghl_note_id, n.body, n.ghl_created_at,
            COALESCE(st.full_name, u.name) AS author
       FROM ghl_note n
       LEFT JOIN ghl_user u  ON u.ghl_user_id = n.ghl_user_id
       LEFT JOIN staff    st ON st.id = n.staff_id
      WHERE n.ghl_contact_id = $1
      ORDER BY n.ghl_created_at DESC NULLS LAST`,
    [contactId]);
  return rows;
}

export async function tasksFor(contactId){
  const { rows } = await query(
    `SELECT t.ghl_task_id, t.title, t.body, t.due_date, t.completed,
            COALESCE(st.full_name, u.name) AS assignee
       FROM ghl_task t
       LEFT JOIN ghl_user u  ON u.ghl_user_id = t.ghl_assigned_user_id
       LEFT JOIN staff    st ON st.id = t.staff_id
      WHERE t.ghl_contact_id = $1
      ORDER BY t.completed ASC, t.due_date ASC NULLS LAST`,
    [contactId]);
  return rows;
}

/* A calendar has an owner: appointment -> ghl_calendar -> ghl_user -> staff. */
export async function appointmentsFor(contactId){
  const { rows } = await query(
    `SELECT a.ghl_appointment_id, a.title, a.start_time, a.end_time,
            COALESCE(a.appointment_status, a.status) AS status,
            COALESCE(NULLIF(a.calendar_name, ''), c.name) AS calendar,
            COALESCE(cst.full_name, cu.name, ast.full_name, au.name) AS owner
       FROM appointment a
       LEFT JOIN ghl_calendar c   ON c.ghl_calendar_id = a.ghl_calendar_id
       LEFT JOIN ghl_user     cu  ON cu.ghl_user_id = c.ghl_user_id
       LEFT JOIN staff        cst ON cst.id = c.staff_id
       LEFT JOIN ghl_user     au  ON au.ghl_user_id = a.ghl_assigned_user_id
       LEFT JOIN staff        ast ON ast.id = a.staff_id
      WHERE a.ghl_contact_id = $1
      ORDER BY a.start_time DESC NULLS LAST`,
    [contactId]);
  return rows;
}

/* ---------------- ingest health ----------------

   command-center no longer runs the sync, so an honest status panel reports
   what the pipeline that does run has managed. */

export async function ingestStatus(){
  const { rows } = await query(
    `SELECT DISTINCT ON (entity)
            entity, status, started_at, finished_at,
            records_fetched, records_upserted, records_failed, error
       FROM ghl_sync_log
      ORDER BY entity, started_at DESC`);

  let lastRun = null;
  for (const r of rows) {
    const at = r.finished_at || r.started_at;
    if (at && (!lastRun || at > lastRun)) lastRun = at;
  }

  return {
    lastRun,
    entities: rows.map(r => ({
      entity: r.entity,
      status: r.status,
      at: r.finished_at || r.started_at,
      upserted: Number(r.records_upserted) || 0,
      failed: Number(r.records_failed) || 0,
      error: r.error ? String(r.error).slice(0, 300) : null
    })),
    done: rows.filter(r => r.status === 'done').length,
    failing: rows.filter(r => r.status === 'error').length,
    pending: rows.filter(r => r.status === 'pending').length
  };
}

/* The location profile, for the composer's From options and the rail. */
export async function locationProfile(locationId){
  const { rows } = await query(
    `SELECT ghl_location_id, name, email, phone, business_email, business_phone,
            business_name, timezone
       FROM ghl_location WHERE ghl_location_id = $1`,
    [locationId]);
  return rows[0] || null;
}
