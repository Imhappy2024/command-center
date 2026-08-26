/* OpusClip.

   Written against the published REST reference and checked against real
   responses from this account — not inferred. The first version guessed field
   names from prose documentation and got three of them wrong: it sent
   `importPref` (the field is `importPreference`), sent clip durations as
   strings like "<30s" (they are [[min,max]] second pairs), and read clip media
   from `videoUrl`/`thumbnailUrl` (they are `uriForPreview`/`uriForThumbnail`).
   Uploads failed too, because `videoUrl` only accepts links from a platform
   whitelist — a self-hosted URL is rejected with a 422 preflight error. Local
   files go through /upload-links instead.

   Base: https://api.opus.pro/api · Bearer auth · 30 req/min. */

const BASE = 'https://api.opus.pro/api';

export const configured = env => Boolean(env.OPUS_API_KEY);

let lastCall = 0;
const MIN_GAP_MS = 2100;   // 30/min, with room to spare

function authHeaders(env, extra = {}){
  const h = { Authorization: `Bearer ${env.OPUS_API_KEY}`, Accept: 'application/json', ...extra };
  if (env.OPUS_ORG_ID) h['x-opus-org-id'] = env.OPUS_ORG_ID;
  return h;
}

async function call(env, path, { method = 'GET', body = null, timeout = 60_000 } = {}){
  if (!env.OPUS_API_KEY) {
    const err = new Error('OpusClip is not configured. Set OPUS_API_KEY.');
    err.unconfigured = true;
    throw err;
  }
  const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();

  const headers = authHeaders(env, body ? { 'Content-Type': 'application/json' } : {});
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let res, text;
  try {
    res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
    text = await res.text();
  } catch (err) {
    clearTimeout(t);
    throw new Error(err.name === 'AbortError' ? `OpusClip timed out after ${timeout / 1000}s` : err.message);
  }
  clearTimeout(t);

  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }

  if (!res.ok) {
    /* The service puts the human-readable reason in errorMessage — a 422
       preflight failure names the unsupported source, which is exactly what a
       user needs to see. */
    const msg = json?.errorMessage || json?.message || json?.error || (text || '').slice(0, 300) || res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    err.name2 = json?.errorName || null;
    err.isAuth = res.status === 401 || res.status === 403;
    err.isRateLimit = res.status === 429;
    throw err;
  }
  return json ?? {};
}

const list = j => Array.isArray(j?.data) ? j.data
  : Array.isArray(j?.data?.list) ? j.data.list
  : Array.isArray(j) ? j : [];

/* ---------------------------------------------------------------------------
   Projects.
   --------------------------------------------------------------------------- */

/* Sources OpusClip will fetch. Anything else is refused at preflight, so it is
   worth saying so before spending the round trip. */
export const SOURCE_HOSTS = [
  'youtube.com', 'youtu.be', 'vimeo.com', 'drive.google.com', 'zoom.us',
  'rumble.com', 'twitch.tv', 'facebook.com', 'fb.watch', 'linkedin.com',
  'x.com', 'twitter.com', 'dropbox.com', 'riverside.fm', 'loom.com',
  'frame.io', 'streamyard.com'
];

export function sourceLooksSupported(url){
  try {
    const h = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (SOURCE_HOSTS.some(d => h === d || h.endsWith('.' + d))) return true;
    /* A direct MP4 on S3 is also accepted. */
    return /\.mp4($|\?)/i.test(url);
  } catch { return false; }
}

/* prefs is what the UI collected; this maps it onto the documented body. Only
   fields with a value are sent — an empty string is a value to an API, and
   usually an invalid one. */
export function buildProjectBody({ videoUrl, title, prefs = {}, webhookUrl }){
  const p = prefs;
  const curationPref = {};
  if (p.model) curationPref.model = p.model;                       // ClipBasic | ClipAnything
  if (Array.isArray(p.clipDurations) && p.clipDurations.length) curationPref.clipDurations = p.clipDurations;
  if (p.genre && p.genre !== 'Auto') curationPref.genre = p.genre;
  /* topicKeywords is ClipBasic only and customPrompt is ClipAnything only —
     sending the wrong one for the model is a rejected request. */
  if (p.model === 'ClipAnything' && p.customPrompt) curationPref.customPrompt = p.customPrompt;
  if (p.model !== 'ClipAnything' && Array.isArray(p.topicKeywords) && p.topicKeywords.length) {
    curationPref.topicKeywords = p.topicKeywords;
  }
  if (p.rangeStart != null || p.rangeEnd != null) {
    curationPref.range = {};
    if (p.rangeStart != null) curationPref.range.startSec = p.rangeStart;
    if (p.rangeEnd != null) curationPref.range.endSec = p.rangeEnd;
  }
  if (p.skipCurate) curationPref.skipCurate = true;

  const renderPref = {};
  if (p.aspect) renderPref.layoutAspectRatio = p.aspect;           // portrait | landscape | square
  if (p.removeFillerWords) renderPref.quickstartConfig = { enableRemoveFillerWords: true };

  const body = { videoUrl };
  if (title) body.uploadedVideoAttr = { title };
  if (Object.keys(curationPref).length) body.curationPref = curationPref;
  if (Object.keys(renderPref).length) body.renderPref = renderPref;
  if (p.sourceLang && p.sourceLang !== 'auto') body.importPreference = { sourceLang: p.sourceLang };
  if (webhookUrl) body.conclusionActions = [{ type: 'WEBHOOK', url: webhookUrl, notifyFailure: true }];
  return body;
}

export async function createProject(env, args){
  const body = buildProjectBody(args);
  const j = await call(env, '/clip-projects', { method: 'POST', body });
  const d = j?.data ?? j;
  return { opusProjectId: d?.projectId || d?.id || null, status: d?.status || 'processing', raw: j, sent: body };
}

/* ---------------------------------------------------------------------------
   Clips.
   --------------------------------------------------------------------------- */

const n = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);

export function normaliseClip(c){
  /* timeRanges is [[startMs, endMs]] — the in/out points of the cut. */
  const r = Array.isArray(c.timeRanges) && Array.isArray(c.timeRanges[0]) ? c.timeRanges[0] : null;
  return {
    fullId: c.id,                       // "{projectId}.{curationId}"
    opusClipId: c.curationId || (typeof c.id === 'string' ? c.id.split('.').pop() : null),
    projectId: c.projectId || null,
    title: c.title || null,
    description: c.description || null,
    hashtags: c.hashtags || null,
    /* `score` is the curved score the product shows; judgeResult.score is the
       raw one. The card shows what the product shows. */
    score: n(c.score),
    rank: n(c.rank),
    hookComment: c.judgeResult?.hookComment || null,
    startSec: r ? r[0] / 1000 : null,
    endSec: r ? r[1] / 1000 : null,
    durationSec: c.durationMs != null ? c.durationMs / 1000 : null,
    previewUrl: c.uriForPreview || null,
    exportUrl: c.uriForExport || null,
    thumbUrl: c.uriForThumbnail || null,
    transcript: c.text || null,
    genre: c.genre || null,
    raw: c
  };
}

export async function getClips(env, projectId){
  const j = await call(env, `/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}`);
  return list(j).map(normaliseClip);
}

/* ---------------------------------------------------------------------------
   Upload: four steps, streamed.
   --------------------------------------------------------------------------- */

/* 1. ask for an upload link, 2. open a resumable session on it. The caller then
   streams bytes to `location` and creates the project with `uploadId` as the
   videoUrl. Nothing is written to our disk at any point. */
export async function beginUpload(env){
  const j = await call(env, '/upload-links', { method: 'POST', body: { video: { usecase: 'LocalUpload' } } });
  const d = j?.data ?? j;
  const url = d?.url, uploadId = d?.uploadId;
  if (!url || !uploadId) throw new Error('OpusClip returned no upload link.');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-resumable': 'start', 'Content-Length': '0' }
  });
  if (!res.ok) throw new Error(`Could not open the upload session (${res.status}).`);
  const location = res.headers.get('location');
  if (!location) throw new Error('The upload session returned no location.');
  return { uploadId, location };
}

/* ---------------------------------------------------------------------------
   Brand templates, accounts, posting, usage.
   --------------------------------------------------------------------------- */

export async function brandTemplates(env){
  const j = await call(env, '/brand-templates?q=mine');
  return list(j).map(t => ({
    id: t.brandTemplateId || t.id,
    name: t.name || t.templateName || 'Untitled template'
  })).filter(t => t.id);
}

export const PLATFORM_LABEL = {
  YOUTUBE: 'YouTube', TIKTOK_BUSINESS: 'TikTok', FACEBOOK_PAGE: 'Facebook',
  INSTAGRAM_BUSINESS: 'Instagram', LINKEDIN: 'LinkedIn', TWITTER: 'X'
};

export async function socialAccounts(env){
  const j = await call(env, '/social-accounts?q=mine');
  return list(j).map(a => ({
    postAccountId: a.postAccountId,
    subAccountId: a.subAccountId || null,
    platform: a.platform,
    platformLabel: PLATFORM_LABEL[a.platform] || a.platform,
    name: a.extUserName || a.extUserId || 'Account',
    avatar: a.extUserPictureLink || null,
    profile: a.extUserProfileLink || null
  })).filter(a => a.postAccountId);
}

/* postDetail is shared by publish-now and schedule. */
const postDetail = ({ title, description, privacy }) => {
  const d = { title: title || '' };
  const custom = {};
  if (description) custom.description = description;
  if (privacy) custom.privacy = privacy;          // public | private | unlisted
  if (Object.keys(custom).length) d.custom = custom;
  return d;
};

export async function publishNow(env, { projectId, clipId, postAccountId, subAccountId, title, description, privacy }){
  const body = { projectId, clipId, postAccountId, postDetail: postDetail({ title, description, privacy }) };
  if (subAccountId) body.subAccountId = subAccountId;
  return call(env, '/post-tasks', { method: 'POST', body });
}

export async function schedulePost(env, { projectId, clipId, postAccountId, subAccountId, publishAt, title, description, privacy }){
  const body = { projectId, clipId, postAccountId, publishAt, postDetail: postDetail({ title, description, privacy }) };
  if (subAccountId) body.subAccountId = subAccountId;
  const j = await call(env, '/publish-schedules', { method: 'POST', body });
  return { scheduleId: j?.data?.scheduleId || j?.scheduleId || null, raw: j };
}

export async function cancelSchedule(env, scheduleId){
  return call(env, `/publish-schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
}

/* AI post copy for a clip. Two calls: submit, then poll. */
export async function createCopyJob(env, { projectId, clipId, postAccountId, subAccountId, prompt }){
  const body = { projectId, clipId, postAccountId };
  if (subAccountId) body.subAccountId = subAccountId;
  if (prompt) body.prompt = prompt;
  const j = await call(env, '/social-copy-jobs', { method: 'POST', body });
  return j?.data?.jobId || j?.jobId || null;
}
export async function getCopyJob(env, jobId){
  return call(env, `/social-copy-jobs/${encodeURIComponent(jobId)}`);
}

export async function usage(env){
  return call(env, '/api-usage?q=mine');
}

export async function raw(env, path){
  return call(env, path.startsWith('/') ? path : '/' + path);
}
