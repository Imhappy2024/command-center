/* OpusClip.

   Base URL and auth are verified against the live service: GET and POST to
   /clip-projects, /brand-templates and /social-accounts all answer 401
   Unauthorized without a key, which confirms the paths exist and that the
   mechanism is a bearer token.

   The response SHAPES are not verified. The public documentation names the
   endpoints and the request fields but does not publish the response bodies,
   so every reader below accepts several plausible field names and keeps the
   untouched payload in `raw`. That is deliberate: guessing a single field name
   and shipping it is how the Meta integration failed twice. `GET
   /api/systems/clip/diag` returns raw responses so the mapping can be corrected
   against reality on the first real call rather than by reading more docs. */

const BASE = 'https://api.opus.pro/api';

export const configured = env => Boolean(env.OPUS_API_KEY);

/* 30 requests a minute per key. A small client-side spacer keeps a burst of
   polls from spending the budget faster than the service will grant it. */
let lastCall = 0;
const MIN_GAP_MS = 2100;

async function call(env, path, { method = 'GET', body = null, timeout = 30_000 } = {}){
  if (!env.OPUS_API_KEY) {
    const err = new Error('OpusClip is not configured. Set OPUS_API_KEY.');
    err.unconfigured = true;
    throw err;
  }

  const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();

  const headers = {
    Authorization: `Bearer ${env.OPUS_API_KEY}`,
    Accept: 'application/json'
  };
  if (env.OPUS_ORG_ID) headers['x-opus-org-id'] = env.OPUS_ORG_ID;
  if (body) headers['Content-Type'] = 'application/json';

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let res, text;
  try {
    res = await fetch(BASE + path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    text = await res.text();
  } catch (err) {
    clearTimeout(t);
    throw new Error(err.name === 'AbortError' ? `OpusClip timed out after ${timeout / 1000}s` : err.message);
  }
  clearTimeout(t);

  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep the text */ }

  if (!res.ok) {
    /* The service answers a bad key with a bare "Unauthorized" body, so the
       status has to carry the message when the payload has none. */
    const msg = json?.message || json?.error || (text || '').slice(0, 200) || res.statusText;
    const err = new Error(`OpusClip ${res.status}: ${msg}`);
    err.status = res.status;
    err.isAuth = res.status === 401 || res.status === 403;
    err.isRateLimit = res.status === 429;
    err.body = json ?? text;
    throw err;
  }
  return json ?? {};
}

/* ---------------------------------------------------------------------------
   Readers. Each tries the field names the shape could plausibly use and falls
   through to null rather than inventing a value.
   --------------------------------------------------------------------------- */

const pick = (obj, ...names) => {
  for (const n of names) {
    const v = n.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
};

/* A payload may be the object, or wrapped in data/result/items. */
const unwrap = j => j?.data ?? j?.result ?? j;
const listOf = j => {
  const u = unwrap(j);
  if (Array.isArray(u)) return u;
  for (const k of ['items', 'clips', 'results', 'records', 'list', 'data']) {
    if (Array.isArray(u?.[k])) return u[k];
  }
  return [];
};

export function normaliseProject(j){
  const u = unwrap(j) || {};
  return {
    opusProjectId: pick(u, 'id', 'projectId', 'project.id', 'clipProjectId'),
    status: pick(u, 'status', 'state', 'project.status'),
    raw: j
  };
}

const num = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);

export function normaliseClip(c){
  return {
    opusClipId: pick(c, 'id', 'clipId', 'exportableClipId'),
    title:      pick(c, 'title', 'name', 'headline', 'caption'),
    /* Opus calls its ranking "virality score" in the product; the field could
       arrive under any of these, and null is honest when it does not. */
    score:      num(pick(c, 'score', 'viralityScore', 'virality', 'rating')),
    startSec:   num(pick(c, 'startSec', 'startTime', 'start', 'startSeconds')),
    endSec:     num(pick(c, 'endSec', 'endTime', 'end', 'endSeconds')),
    durationSec:num(pick(c, 'durationSec', 'duration', 'lengthSec')),
    videoUrl:   pick(c, 'videoUrl', 'url', 'downloadUrl', 'mp4Url', 'exportUrl', 'media.url'),
    thumbUrl:   pick(c, 'thumbnailUrl', 'thumbUrl', 'coverUrl', 'previewUrl', 'thumbnail'),
    transcript: pick(c, 'transcript', 'text', 'subtitle'),
    status:     pick(c, 'status', 'state'),
    raw: c
  };
}

/* ---------------------------------------------------------------------------
   Endpoints.
   --------------------------------------------------------------------------- */

/* curationPref / importPref / renderPref are passed through exactly as the
   caller built them. The documentation names the objects but not every field,
   so this layer does not re-shape them — what the UI collects is what the
   service receives, and a rejected field surfaces as the service's own error
   rather than being silently dropped here. */
export async function createProject(env, { videoUrl, curationPref, importPref, renderPref, brandTemplateId, conclusionActions }){
  const body = { videoUrl };
  if (curationPref)     body.curationPref = curationPref;
  if (importPref)       body.importPref = importPref;
  if (renderPref)       body.renderPref = renderPref;
  if (brandTemplateId)  body.brandTemplateId = brandTemplateId;
  if (conclusionActions) body.conclusionActions = conclusionActions;
  return normaliseProject(await call(env, '/clip-projects', { method: 'POST', body, timeout: 60_000 }));
}

export async function getProject(env, id){
  return normaliseProject(await call(env, `/clip-projects/${encodeURIComponent(id)}`));
}

/* Two clip endpoints exist. `exportable-clips` is the one documented with a
   project filter, so it is tried first; `clips` is the fallback. Whichever
   answers with rows wins, and the caller is told which. */
export async function getClips(env, projectId){
  const attempts = [
    { path: `/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}`, via: 'exportable-clips' },
    { path: `/clips?projectId=${encodeURIComponent(projectId)}`, via: 'clips' }
  ];
  const errors = [];
  for (const a of attempts) {
    try {
      const j = await call(env, a.path);
      const rows = listOf(j);
      if (rows.length) return { clips: rows.map(normaliseClip), via: a.via, raw: j };
      errors.push(`${a.via}: no rows`);
    } catch (err) {
      if (err.isAuth) throw err;
      errors.push(`${a.via}: ${err.message}`);
    }
  }
  return { clips: [], via: null, note: errors.join(' · ') };
}

export async function brandTemplates(env){
  const j = await call(env, '/brand-templates');
  return listOf(j).map(t => ({
    id: pick(t, 'id', 'templateId', 'brandTemplateId'),
    name: pick(t, 'name', 'title', 'label') || 'Untitled template',
    raw: t
  })).filter(t => t.id);
}

export async function socialAccounts(env){
  const j = await call(env, '/social-accounts');
  return listOf(j).map(a => ({
    id: pick(a, 'id', 'accountId', 'socialAccountId'),
    platform: pick(a, 'platform', 'provider', 'network', 'type'),
    handle: pick(a, 'handle', 'username', 'name', 'displayName'),
    raw: a
  })).filter(a => a.id);
}

/* Publish now. */
export async function postNow(env, { clipId, socialAccountIds, caption }){
  return call(env, '/post-tasks', {
    method: 'POST',
    body: { clipId, socialAccountIds, caption }
  });
}

/* Publish later. `scheduledAt` is sent as an ISO instant. */
export async function schedulePost(env, { clipId, socialAccountIds, caption, scheduledAt }){
  return call(env, '/publish-schedules', {
    method: 'POST',
    body: { clipId, socialAccountIds, caption, scheduledAt }
  });
}

export async function cancelSchedule(env, scheduleId){
  return call(env, `/publish-schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
}

/* The diagnostic path: returns whatever the service actually sends, untouched,
   so the readers above can be corrected against a real payload. */
export async function raw(env, path){
  return call(env, path.startsWith('/') ? path : '/' + path);
}
