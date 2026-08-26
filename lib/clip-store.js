/* Clip projects, their clips, and anything scheduled from them.

   All three tables are command-center's own. Nothing here stores video: local
   files are streamed straight into OpusClip's own upload session, so this
   process never holds the bytes and there is no media directory to sweep. The
   disk-backed hosting this file used to do is gone — the service refuses a URL
   it does not recognise, so hosting one was never going to work. */

import { randomBytes } from 'node:crypto';
import { query } from '../db/index.js';

export const newId = (p = 'cp') => p + '_' + randomBytes(9).toString('base64url');

/* ---------------------------------------------------------------------------
   Projects.
   --------------------------------------------------------------------------- */

export async function createProjectRow({ id, title, sourceKind, sourceUrl, prefs }){
  await query(
    `INSERT INTO clip_projects (id, title, source_kind, source_url, prefs, status)
     VALUES ($1,$2,$3,$4,$5,'draft')`,
    [id, title || null, sourceKind, sourceUrl || null, JSON.stringify(prefs || {})]);
  return getProject(id);
}

export async function setProjectSubmitted(id, { opusProjectId, status, raw }){
  await query(
    `UPDATE clip_projects
        SET opus_project_id = $2, status = $3, last_error = NULL,
            submitted_at = now(), raw = $4, updated_at = now()
      WHERE id = $1`,
    [id, opusProjectId || null, status || 'processing', JSON.stringify(raw ?? null)]);
  return getProject(id);
}

export async function setProjectStatus(id, status, error){
  await query(
    `UPDATE clip_projects SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
    [id, status, error ? String(error).slice(0, 500) : null]);
  return getProject(id);
}

export async function getProject(id){
  const { rows } = await query(`SELECT * FROM clip_projects WHERE id = $1`, [id]);
  return rows[0] ? shapeProject(rows[0]) : null;
}

export async function getProjectByOpusId(opusId){
  const { rows } = await query(`SELECT * FROM clip_projects WHERE opus_project_id = $1`, [opusId]);
  return rows[0] ? shapeProject(rows[0]) : null;
}

export async function listProjects(limit = 40){
  const { rows } = await query(
    `SELECT p.*, (SELECT COUNT(*) FROM clips c WHERE c.project_id = p.id) AS clip_count
       FROM clip_projects p ORDER BY p.created_at DESC LIMIT $1`, [limit]);
  return rows.map(shapeProject);
}

export async function deleteProject(id){
  await query(`DELETE FROM clip_projects WHERE id = $1`, [id]);
}

const shapeProject = r => ({
  id: r.id,
  opusProjectId: r.opus_project_id,
  title: r.title,
  sourceKind: r.source_kind,
  sourceUrl: r.source_url,
  status: r.status,
  prefs: safeJson(r.prefs) || {},
  lastError: r.last_error,
  clipCount: r.clip_count == null ? undefined : Number(r.clip_count),
  createdAt: r.created_at,
  submittedAt: r.submitted_at,
  updatedAt: r.updated_at
});

const safeJson = v => {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
};

/* ---------------------------------------------------------------------------
   Clips.
   --------------------------------------------------------------------------- */

/* The preview URI goes in video_url and the export URI beside it: they are
   different artifacts. Preview is the low-res watchable file that exists as
   soon as the clip renders; export is the HD download, and on some plans it
   never appears at all. Storing one in the other's column would make a missing
   HD render look like a broken clip. */
export async function upsertClips(projectId, clips){
  let n = 0;
  for (const c of clips || []) {
    if (!c.opusClipId) continue;
    await query(
      `INSERT INTO clips
         (id, project_id, opus_clip_id, full_id, title, description, hashtags, score, rank,
          hook_note, start_sec, end_sec, duration_sec, video_url, export_url, thumb_url,
          transcript, status, raw, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
       ON CONFLICT (project_id, opus_clip_id) DO UPDATE SET
         full_id = EXCLUDED.full_id, title = EXCLUDED.title,
         description = EXCLUDED.description, hashtags = EXCLUDED.hashtags,
         score = EXCLUDED.score, rank = EXCLUDED.rank, hook_note = EXCLUDED.hook_note,
         start_sec = EXCLUDED.start_sec, end_sec = EXCLUDED.end_sec,
         duration_sec = EXCLUDED.duration_sec, video_url = EXCLUDED.video_url,
         export_url = EXCLUDED.export_url, thumb_url = EXCLUDED.thumb_url,
         transcript = EXCLUDED.transcript, status = EXCLUDED.status,
         raw = EXCLUDED.raw, updated_at = now()`,
      [newId('cl'), projectId, String(c.opusClipId), c.fullId, c.title, c.description,
       c.hashtags, c.score, c.rank, c.hookComment,
       c.startSec, c.endSec, c.durationSec, c.previewUrl, c.exportUrl, c.thumbUrl,
       c.transcript, c.status || 'ready', JSON.stringify(c.raw ?? null)]);
    n++;
  }
  return n;
}

export async function listClips(projectId){
  const { rows } = await query(
    `SELECT * FROM clips WHERE project_id = $1
      ORDER BY rank ASC NULLS LAST, score DESC NULLS LAST, start_sec ASC NULLS LAST`, [projectId]);
  return rows.map(shapeClip);
}

export async function deleteClip(id){
  await query(`DELETE FROM clips WHERE id = $1`, [id]);
}

export async function getClip(id){
  const { rows } = await query(`SELECT * FROM clips WHERE id = $1`, [id]);
  return rows[0] ? shapeClip(rows[0]) : null;
}

const shapeClip = r => ({
  id: r.id,
  projectId: r.project_id,
  opusClipId: r.opus_clip_id,
  fullId: r.full_id,
  title: r.title,
  description: r.description,
  hashtags: r.hashtags,
  score: r.score == null ? null : Number(r.score),
  rank: r.rank == null ? null : Number(r.rank),
  hookNote: r.hook_note,
  startSec: r.start_sec == null ? null : Number(r.start_sec),
  endSec: r.end_sec == null ? null : Number(r.end_sec),
  durationSec: r.duration_sec == null ? null : Number(r.duration_sec),
  videoUrl: r.video_url,
  exportUrl: r.export_url,
  thumbUrl: r.thumb_url,
  transcript: r.transcript,
  status: r.status,
  updatedAt: r.updated_at
});

/* ---------------------------------------------------------------------------
   Schedules.
   --------------------------------------------------------------------------- */

export async function addSchedule({ id, clipId, target, caption, scheduledAt, opusScheduleId, status, error }){
  await query(
    `INSERT INTO clip_schedules
       (id, clip_id, target, caption, scheduled_at, opus_schedule_id, status, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, clipId, target || null, caption || null, scheduledAt || null,
     opusScheduleId || null, status || 'scheduled', error || null]);
}

export async function listSchedules(clipIds){
  if (!clipIds?.length) return [];
  const { rows } = await query(
    `SELECT * FROM clip_schedules WHERE clip_id = ANY($1) ORDER BY scheduled_at ASC NULLS LAST`,
    [clipIds]);
  return rows.map(r => ({
    id: r.id, clipId: r.clip_id, target: r.target, caption: r.caption,
    scheduledAt: r.scheduled_at, opusScheduleId: r.opus_schedule_id,
    status: r.status, lastError: r.last_error
  }));
}

export async function setScheduleStatus(id, status, error){
  await query(
    `UPDATE clip_schedules SET status = $2, last_error = $3 WHERE id = $1`,
    [id, status, error ? String(error).slice(0, 400) : null]);
}
