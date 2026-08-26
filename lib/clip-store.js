/* Clip projects, their clips, and anything scheduled from them.

   All three tables are command-center's own. The uploaded source files are NOT
   in the database — they sit on disk and only their public token is stored,
   because a 30 GB ceiling and a bytea column do not belong in the same
   sentence. */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { query } from '../db/index.js';

export const newId = (p = 'cp') => p + '_' + randomBytes(9).toString('base64url');

/* ---------------------------------------------------------------------------
   Where uploads land.

   A Railway volume when one is mounted, the OS temp directory otherwise. The
   difference matters and is reported rather than hidden: without a volume the
   file is gone on the next deploy, which is survivable only because OpusClip
   fetches the URL within minutes of the project being created. */
export function mediaDir(env = process.env){
  const base = env.RAILWAY_VOLUME_MOUNT_PATH || env.MEDIA_DIR || path.join(os.tmpdir(), 'cc-media');
  const dir = path.join(base, 'clip-uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function mediaIsDurable(env = process.env){
  return Boolean(env.RAILWAY_VOLUME_MOUNT_PATH || env.MEDIA_DIR);
}

/* The filename on disk IS the token, so a token cannot be walked into another
   path: it is generated here, validated on the way back in, and never taken
   from user input. */
export const newToken = () => randomBytes(24).toString('hex');
export const validToken = t => /^[a-f0-9]{48}$/.test(String(t || ''));

export function mediaPath(token, env = process.env){
  if (!validToken(token)) return null;
  return path.join(mediaDir(env), token);
}

/* Uploads older than a day are gone: OpusClip has long since fetched them, and
   an unbounded pile of raw video on a volume is a bill nobody chose. */
export function sweepMedia(env = process.env, maxAgeMs = 24 * 3600_000){
  let removed = 0;
  try {
    const dir = mediaDir(env);
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) { fs.unlinkSync(p); removed++; }
      } catch { /* someone else got there first */ }
    }
  } catch { /* no directory yet */ }
  return removed;
}

/* ---------------------------------------------------------------------------
   Projects.
   --------------------------------------------------------------------------- */

export async function createProjectRow({ id, title, sourceKind, sourceUrl, mediaToken, prefs }){
  await query(
    `INSERT INTO clip_projects (id, title, source_kind, source_url, media_token, prefs, status)
     VALUES ($1,$2,$3,$4,$5,$6,'draft')`,
    [id, title || null, sourceKind, sourceUrl || null, mediaToken || null, JSON.stringify(prefs || {})]);
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
  mediaToken: r.media_token,
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

export async function upsertClips(projectId, clips){
  let n = 0;
  for (const c of clips || []) {
    if (!c.opusClipId) continue;
    await query(
      `INSERT INTO clips
         (id, project_id, opus_clip_id, title, score, start_sec, end_sec, duration_sec,
          video_url, thumb_url, transcript, status, raw, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (project_id, opus_clip_id) DO UPDATE SET
         title = EXCLUDED.title, score = EXCLUDED.score,
         start_sec = EXCLUDED.start_sec, end_sec = EXCLUDED.end_sec,
         duration_sec = EXCLUDED.duration_sec, video_url = EXCLUDED.video_url,
         thumb_url = EXCLUDED.thumb_url, transcript = EXCLUDED.transcript,
         status = EXCLUDED.status, raw = EXCLUDED.raw, updated_at = now()`,
      [newId('cl'), projectId, String(c.opusClipId), c.title, c.score,
       c.startSec, c.endSec, c.durationSec, c.videoUrl, c.thumbUrl,
       c.transcript, c.status, JSON.stringify(c.raw ?? null)]);
    n++;
  }
  return n;
}

export async function listClips(projectId){
  const { rows } = await query(
    `SELECT * FROM clips WHERE project_id = $1
      ORDER BY score DESC NULLS LAST, start_sec ASC NULLS LAST`, [projectId]);
  return rows.map(shapeClip);
}

export async function getClip(id){
  const { rows } = await query(`SELECT * FROM clips WHERE id = $1`, [id]);
  return rows[0] ? shapeClip(rows[0]) : null;
}

const shapeClip = r => ({
  id: r.id,
  projectId: r.project_id,
  opusClipId: r.opus_clip_id,
  title: r.title,
  score: r.score == null ? null : Number(r.score),
  startSec: r.start_sec == null ? null : Number(r.start_sec),
  endSec: r.end_sec == null ? null : Number(r.end_sec),
  durationSec: r.duration_sec == null ? null : Number(r.duration_sec),
  videoUrl: r.video_url,
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
