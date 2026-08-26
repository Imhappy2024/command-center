/* Systems: automations that are run by hand.

   Six are listed. One — Create a Clip — is built; the other five say so rather
   than presenting a button that does nothing.

   Create a Clip wraps OpusClip. The one structural constraint worth knowing:
   OpusClip fetches a URL, it does not accept an upload. So a raw file dropped
   here is streamed to disk and served back at an unguessable public URL, and
   that URL is what the service is given. */

import express from 'express';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import * as opus from '../providers/opus.js';
import * as store from '../lib/clip-store.js';
import { guarded } from './guard.js';

/* Six entries. `built` is the honest half — a card that cannot do anything yet
   says so on its face instead of looking identical to one that works. */
export const AUTOMATIONS = [
  { id:'clip',      name:'Create a Clip',            built:true,
    blurb:'Turn a long video into short vertical clips with OpusClip, preview them, then schedule.' },
  { id:'metrics',   name:'Pull and Analyze Metrics', built:false,
    blurb:'Force a pull from every connected platform and summarise what moved.' },
  { id:'today',     name:'Plan Today',               built:false,
    blurb:'Calendar, unread mail and open leads folded into one running order.' },
  { id:'tomorrow',  name:'Plan Tomorrow',            built:false,
    blurb:'The same, built the evening before.' },
  { id:'inbox',     name:'Inbox brief',              built:false,
    blurb:'What arrived, what needs a reply, and what can wait.' },
  { id:'weekly',    name:'Weekly Review',            built:false,
    blurb:'Seven days of leads, spend and publishing in one page.' }
];

/* Ten hours, thirty gigabytes — the service's own ceiling. Rejecting a file it
   would refuse anyway saves the upload. */
const MAX_UPLOAD = 30 * 1024 * 1024 * 1024;

export function systemRoutes({ env, auth }){
  const r = express.Router();
  const cfg = () => opus.configured(env);

  /* ---------------- the public media URL ----------------

     Mounted BEFORE auth on purpose: OpusClip fetches this and has no session.
     What contains it is the token — 24 random bytes, generated server-side,
     used as the filename, and pattern-checked on the way back in so it can
     never be walked into another path. Files are swept after a day. */
  r.get('/media/:token', (req, res) => {
    const p = store.mediaPath(req.params.token);
    if (!p || !fs.existsSync(p)) return res.status(404).end();
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    /* Range support, because a fetcher pulling a multi-gigabyte file will ask
       for it in pieces. */
    const size = fs.statSync(p).size;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) return res.status(416).set('Content-Range', `bytes */${size}`).end();
      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1
      });
      return fs.createReadStream(p, { start, end }).pipe(res);
    }
    res.set({ 'Accept-Ranges': 'bytes', 'Content-Length': size });
    fs.createReadStream(p).pipe(res);
  });

  /* ---------------- listing ---------------- */

  r.get('/api/systems', auth.require, guarded('api/systems', async (req, res) => {
    const projects = await store.listProjects(12).catch(() => []);
    res.json({
      automations: AUTOMATIONS,
      clip: {
        configured: cfg(),
        setupHint: 'Set OPUS_API_KEY from clip.opus.pro/dashboard. OPUS_ORG_ID is optional.',
        durableStorage: store.mediaIsDurable(env),
        recent: projects
      }
    });
  }));

  /* ---------------- upload ----------------

     Streamed straight to disk. Never buffered: express.raw() on a 30 GB
     ceiling would be an out-of-memory crash rather than an upload. The browser
     sends the file as the raw body, so there is no multipart parser and no
     dependency for one. */
  r.post('/api/systems/clip/upload', auth.require, async (req, res) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD) {
      return res.status(413).json({ error: 'That file is over OpusClip\'s 30 GB ceiling.' });
    }
    const token = store.newToken();
    const dest = store.mediaPath(token, env);
    let written = 0;
    req.on('data', c => { written += c.length; });
    try {
      await pipeline(req, fs.createWriteStream(dest));
    } catch (err) {
      fs.promises.unlink(dest).catch(() => {});
      return res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
    if (!written) {
      fs.promises.unlink(dest).catch(() => {});
      return res.status(400).json({ error: 'Empty upload.' });
    }
    const base = (env.PUBLIC_URL || '').replace(/\/+$/, '');
    res.json({
      token,
      bytes: written,
      url: base + '/media/' + token,
      durable: store.mediaIsDurable(env),
      note: store.mediaIsDurable(env) ? null
        : 'No volume is mounted, so this file lives on ephemeral disk and is lost on the next deploy. '
          + 'OpusClip fetches it within minutes of submitting, so this is usually fine — but submit now rather than later.'
    });
  });

  /* ---------------- create ---------------- */

  r.post('/api/systems/clip/projects', auth.require, express.json({ limit: '1mb' }),
    guarded('api/systems/clip:create', async (req, res) => {
      const b = req.body || {};
      const sourceKind = b.mediaToken ? 'upload' : 'url';

      let sourceUrl = String(b.videoUrl || '').trim();
      if (sourceKind === 'upload') {
        if (!store.validToken(b.mediaToken)) return res.status(400).json({ error: 'Bad upload token.' });
        const base = (env.PUBLIC_URL || '').replace(/\/+$/, '');
        if (!base) return res.status(500).json({ error: 'PUBLIC_URL is not set, so OpusClip has no address to fetch the upload from.' });
        sourceUrl = base + '/media/' + b.mediaToken;
      } else {
        if (!/^https?:\/\//i.test(sourceUrl)) {
          return res.status(400).json({ error: 'Paste a full http(s) video URL, or upload a file.' });
        }
      }

      /* Preferences are passed through as the UI built them — see the note in
         providers/opus.js on why this layer does not re-shape them. */
      const prefs = {
        curationPref: b.curationPref || undefined,
        importPref: b.importPref || undefined,
        renderPref: b.renderPref || undefined,
        brandTemplateId: b.brandTemplateId || undefined
      };

      const id = store.newId();
      await store.createProjectRow({
        id, title: b.title || null, sourceKind, sourceUrl,
        mediaToken: b.mediaToken || null, prefs
      });

      if (!cfg()) {
        await store.setProjectStatus(id, 'failed', 'OPUS_API_KEY is not set.');
        return res.status(400).json({ error: 'OpusClip is not configured. Set OPUS_API_KEY.', projectId: id });
      }

      try {
        const out = await opus.createProject(env, { videoUrl: sourceUrl, ...prefs });
        if (!out.opusProjectId) {
          /* Accepted, but no id we recognise. The raw payload is kept and
             surfaced rather than the project being marked done on a guess. */
          await store.setProjectStatus(id, 'failed',
            'OpusClip accepted the request but returned no project id this build recognises. See /api/systems/clip/diag.');
          return res.status(502).json({
            error: 'No project id in the response. The raw payload is in the project row.',
            projectId: id, raw: out.raw
          });
        }
        const saved = await store.setProjectSubmitted(id, out);
        res.json({ project: saved });
      } catch (err) {
        await store.setProjectStatus(id, 'failed', err.message);
        res.status(err.status === 401 ? 401 : 502).json({ error: err.message, projectId: id });
      }
    }));

  /* ---------------- read + poll ---------------- */

  r.get('/api/systems/clip/projects', auth.require, guarded('api/systems/clip:list', async (req, res) => {
    res.json({ projects: await store.listProjects(40) });
  }));

  r.get('/api/systems/clip/projects/:id', auth.require, guarded('api/systems/clip:one', async (req, res) => {
    const project = await store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'No such project.' });
    const clips = await store.listClips(project.id);
    const schedules = await store.listSchedules(clips.map(c => c.id));
    res.json({ project, clips, schedules });
  }));

  /* Ask OpusClip what it has. Polling rather than waiting on the webhook,
     because a webhook that has not been configured leaves a project stuck at
     "processing" forever with no way to find out otherwise. */
  r.post('/api/systems/clip/projects/:id/refresh', auth.require,
    guarded('api/systems/clip:refresh', async (req, res) => {
      const project = await store.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'No such project.' });
      if (!project.opusProjectId) return res.status(400).json({ error: 'This project was never accepted by OpusClip.' });
      if (!cfg()) return res.status(400).json({ error: 'OpusClip is not configured.' });

      try {
        const out = await opus.getClips(env, project.opusProjectId);
        const n = await store.upsertClips(project.id, out.clips);
        if (n) await store.setProjectStatus(project.id, 'ready', null);
        const clips = await store.listClips(project.id);
        res.json({
          project: await store.getProject(project.id),
          clips,
          found: n,
          via: out.via,
          note: n ? null : (out.note || 'No clips yet. Rendering usually takes a few minutes per hour of source.')
        });
      } catch (err) {
        await store.setProjectStatus(project.id, project.status, err.message);
        res.status(502).json({ error: err.message });
      }
    }));

  r.delete('/api/systems/clip/projects/:id', auth.require,
    guarded('api/systems/clip:delete', async (req, res) => {
      const project = await store.getProject(req.params.id);
      if (project?.mediaToken) {
        const p = store.mediaPath(project.mediaToken, env);
        if (p) fs.promises.unlink(p).catch(() => {});
      }
      await store.deleteProject(req.params.id);
      res.json({ ok: true });
    }));

  /* ---------------- brand templates + destinations ---------------- */

  r.get('/api/systems/clip/templates', auth.require, guarded('api/systems/clip:templates', async (req, res) => {
    if (!cfg()) return res.json({ templates: [], configured: false });
    try { res.json({ templates: await opus.brandTemplates(env), configured: true }); }
    catch (err) { res.json({ templates: [], configured: true, error: err.message }); }
  }));

  r.get('/api/systems/clip/destinations', auth.require, guarded('api/systems/clip:dest', async (req, res) => {
    if (!cfg()) return res.json({ accounts: [], configured: false });
    try { res.json({ accounts: await opus.socialAccounts(env), configured: true }); }
    catch (err) { res.json({ accounts: [], configured: true, error: err.message }); }
  }));

  /* ---------------- publish / schedule ---------------- */

  r.post('/api/systems/clip/clips/:id/schedule', auth.require, express.json(),
    guarded('api/systems/clip:schedule', async (req, res) => {
      const clip = await store.getClip(req.params.id);
      if (!clip) return res.status(404).json({ error: 'No such clip.' });
      if (!cfg()) return res.status(400).json({ error: 'OpusClip is not configured.' });

      const accounts = Array.isArray(req.body?.socialAccountIds) ? req.body.socialAccountIds : [];
      if (!accounts.length) return res.status(400).json({ error: 'Pick at least one account to post to.' });

      const when = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null;
      if (req.body?.scheduledAt && isNaN(when?.getTime())) {
        return res.status(400).json({ error: 'That is not a valid date and time.' });
      }
      /* A time in the past would either post immediately or be rejected by the
         service; either way it is not what was meant. */
      if (when && when.getTime() < Date.now() - 60_000) {
        return res.status(400).json({ error: 'That time has already passed.' });
      }

      const caption = String(req.body?.caption || '').slice(0, 2200);
      const id = store.newId('sch');
      try {
        const out = when
          ? await opus.schedulePost(env, { clipId: clip.opusClipId, socialAccountIds: accounts, caption, scheduledAt: when.toISOString() })
          : await opus.postNow(env, { clipId: clip.opusClipId, socialAccountIds: accounts, caption });
        const opusId = out?.id || out?.scheduleId || out?.data?.id || null;
        await store.addSchedule({
          id, clipId: clip.id, target: accounts.join(','), caption,
          scheduledAt: when ? when.toISOString() : null,
          opusScheduleId: opusId, status: when ? 'scheduled' : 'published'
        });
        res.json({ ok: true, scheduleId: id, opus: out });
      } catch (err) {
        /* Recorded as failed rather than dropped: a publish that silently did
           not happen is worse than one that says so. */
        await store.addSchedule({
          id, clipId: clip.id, target: accounts.join(','), caption,
          scheduledAt: when ? when.toISOString() : null, status: 'failed', error: err.message
        });
        res.status(502).json({ error: err.message });
      }
    }));

  /* ---------------- webhook ---------------- */

  r.post('/webhooks/opus', express.json({ limit: '2mb' }), async (req, res) => {
    /* Answered immediately: a webhook that waits on our database is a webhook
       the sender retries. */
    res.json({ ok: true });
    try {
      const b = req.body || {};
      const opusId = b.projectId || b.project?.id || b.data?.projectId || b.data?.project?.id;
      if (!opusId) return;
      const project = await store.getProjectByOpusId(String(opusId));
      if (!project) return;
      const out = await opus.getClips(env, project.opusProjectId);
      const n = await store.upsertClips(project.id, out.clips);
      if (n) await store.setProjectStatus(project.id, 'ready', null);
      console.log(`[opus:webhook] ${project.id}: ${n} clip(s)`);
    } catch (err) {
      console.error('[opus:webhook]', err.message);
    }
  });

  /* ---------------- diagnostics ----------------

     The response shapes are inferred from documentation that does not publish
     them. This returns what the service actually sends, so the readers in
     providers/opus.js can be corrected against a real payload rather than
     against more docs. */
  r.get('/api/systems/clip/diag', auth.require, guarded('api/systems/clip:diag', async (req, res) => {
    const out = { configured: cfg(), base: 'https://api.opus.pro/api', durableStorage: store.mediaIsDurable(env) };
    if (!cfg()) { out.hint = 'Set OPUS_API_KEY.'; return res.json(out); }
    const probe = async (name, path) => {
      try { out[name] = { ok: true, body: await opus.raw(env, path) }; }
      catch (err) { out[name] = { ok: false, status: err.status, error: err.message }; }
    };
    await probe('brandTemplates', '/brand-templates');
    await probe('socialAccounts', '/social-accounts');
    if (req.query.projectId) {
      await probe('exportableClips', `/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(req.query.projectId)}`);
      await probe('clips', `/clips?projectId=${encodeURIComponent(req.query.projectId)}`);
    }
    res.json(out);
  }));

  return r;
}
