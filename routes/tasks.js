/* Tasks — ClickUp behind a cache.

   Walking the workspace takes about three minutes: 21 spaces, 212 lists, 4,842
   tasks, and no API call that returns them in one go. So nothing user-facing may
   ever wait for a walk. The rules that follow from that:

     - A cached payload is served immediately, however old it is, with its age
       attached so the UI can say "as of 14 minutes ago" rather than implying it
       is live.
     - Going stale triggers a refresh in the background; the request that noticed
       still gets the old data.
     - Only one walk runs at a time. Concurrent callers share it rather than
       starting a second three-minute crawl against the same rate limit.
     - A write invalidates nothing and blocks on nothing; it patches the cached
       copy so the change survives until the next walk.

   Writes are attributed to the token in the environment, which is a shared
   workspace token — so ClickUp will show "the dashboard changed it", not "Jay
   changed it". Worth knowing before wiring this to anything that matters. */

import express from 'express';
import { createClickUp, canonicalStatus, CANONICAL } from '../providers/clickup.js';

const STALE_MS = 10 * 60 * 1000;
/* Past this, a payload is too old to serve as though it were current; the UI is
   told so it can warn rather than show a number that looks live. */
const ANCIENT_MS = 6 * 60 * 60 * 1000;

export function taskRoutes({ env, auth }){
  const r = express.Router();

  const token = env.CLICKUP_TOKEN || env.CLICKUP_API_TOKEN || '';
  const teamId = env.CLICKUP_TEAM_ID || '';
  const configured = Boolean(token);
  const cu = configured ? createClickUp({ token, teamId }) : null;

  let cache = null;          // { payload, at }
  let inFlight = null;       // the shared walk
  let lastError = null;
  /* Where the current walk has got to, so a first load can show something
     moving instead of a spinner that looks identical to a hang. */
  let progress = null;

  function refresh(){
    if (inFlight) return inFlight;
    progress = { phase: 'teams', done: 0, total: 0, startedAt: Date.now() };
    inFlight = cu.workspace({ onProgress: p => { progress = { ...progress, ...p }; } })
      .then(payload => {
        cache = { payload, at: Date.now() };
        lastError = null;
        return payload;
      })
      .catch(err => {
        /* Keep whatever we had: a rate limit or a blip must not empty the view. */
        lastError = { message: err.message, at: new Date().toISOString() };
        throw err;
      })
      .finally(() => { inFlight = null; progress = null; });
    return inFlight;
  }

  const shape = () => ({
    ...cache.payload,
    cachedAt: new Date(cache.at).toISOString(),
    ageMs: Date.now() - cache.at,
    stale: Date.now() - cache.at > STALE_MS,
    ancient: Date.now() - cache.at > ANCIENT_MS,
    refreshing: Boolean(inFlight),
    progress,
    lastError
  });

  r.get('/api/tasks', auth.require, async (req, res) => {
    if (!configured) {
      return res.json({
        configured: false,
        reason: 'CLICKUP_TOKEN is not set. Add it to .env to connect the Tasks section.',
        tasks: [], spaces: [], lists: [], members: [], canonical: CANONICAL
      });
    }

    const force = req.query.force === '1';

    /* Nothing cached, so there is nothing to serve -- but this request still
       must not wait for it. The walk is three minutes; a browser fetch is not,
       and the old code's await turned a slow first load into a hung one and then
       a "could not reach ClickUp" that was not true. Start the walk, say so, and
       let the UI poll for progress. */
    if (!cache) {
      if (!inFlight) refresh().catch(() => { /* lastError already has it */ });
      return res.json({
        configured: true, canonical: CANONICAL, warming: true,
        progress, lastError,
        tasks: [], spaces: [], lists: [], members: []
      });
    }

    /* A forced refresh has the old payload to hand back while it runs. */
    if (force) {
      if (!inFlight) refresh().catch(() => {});
      return res.json({ configured: true, canonical: CANONICAL, ...shape() });
    }

    /* Stale-while-revalidate: answer now, refresh behind. */
    if (Date.now() - cache.at > STALE_MS && !inFlight) refresh().catch(() => {});
    res.json({ configured: true, canonical: CANONICAL, ...shape() });
  });

  r.get('/api/tasks/status', auth.require, (req, res) => {
    res.json({
      configured,
      teamId: teamId || null,
      cached: Boolean(cache),
      cachedAt: cache ? new Date(cache.at).toISOString() : null,
      ageMs: cache ? Date.now() - cache.at : null,
      counts: cache ? {
        tasks: cache.payload.tasks.length,
        lists: cache.payload.lists.length,
        spaces: cache.payload.spaces.length
      } : null,
      refreshing: Boolean(inFlight),
      progress,
      problems: cache ? (cache.payload.problems || []).length : null,
      lastError
    });
  });

  const needClickUp = (req, res, next) => {
    if (!configured) return res.status(400).json({ error: 'ClickUp is not configured' });
    next();
  };

  r.get('/api/tasks/list/:id/statuses', auth.require, needClickUp, async (req, res) => {
    try { res.json({ statuses: await cu.statuses(req.params.id) }); }
    catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  r.get('/api/tasks/list/:id/members', auth.require, needClickUp, async (req, res) => {
    try { res.json({ members: await cu.members(req.params.id) }); }
    catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  r.get('/api/tasks/:id/comments', auth.require, needClickUp, async (req, res) => {
    try { res.json({ comments: await cu.comments(req.params.id) }); }
    catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  r.post('/api/tasks/:id/comment', auth.require, needClickUp, express.json(), async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'a comment needs text' });
    try {
      await cu.addComment(req.params.id, text);
      res.json({ ok: true });
    } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
  });

  /* Named fields only. An endpoint that forwards arbitrary JSON to ClickUp lets
     a web page change anything about a task, including moving it between lists. */
  r.put('/api/tasks/:id', auth.require, needClickUp, express.json(), async (req, res) => {
    const b = req.body || {};
    const body = {};

    if (typeof b.status === 'string' && b.status.trim()) body.status = b.status.trim();
    if (typeof b.name === 'string' && b.name.trim()) body.name = b.name.trim();

    if (b.due !== undefined) {
      if (b.due === null) body.due_date = null;
      else if (Number.isFinite(Number(b.due))) { body.due_date = Number(b.due); body.due_date_time = false; }
      else return res.status(400).json({ error: 'due must be epoch milliseconds or null' });
    }

    if (b.priority !== undefined) {
      const map = { urgent: 1, high: 2, normal: 3, low: 4 };
      const key = String(b.priority).toLowerCase();
      if (b.priority === null) body.priority = null;
      else if (map[key]) body.priority = map[key];
      else return res.status(400).json({ error: 'priority must be urgent|high|normal|low or null' });
    }

    if (b.assignees && typeof b.assignees === 'object') {
      const ids = v => (Array.isArray(v) ? v.map(Number).filter(Number.isFinite) : []);
      const add = ids(b.assignees.add);
      const rem = ids(b.assignees.rem);
      if (add.length || rem.length) {
        body.assignees = { ...(add.length ? { add } : {}), ...(rem.length ? { rem } : {}) };
      }
    }

    if (b.archived === true) body.archived = true;

    if (!Object.keys(body).length) return res.status(400).json({ error: 'nothing to change' });

    try {
      await cu.updateTask(req.params.id, body);
      /* Patch the cached copy, so the change does not appear to revert on the
         next page load while the cache is still warm. */
      if (cache) {
        const t = cache.payload.tasks.find(x => x.id === req.params.id);
        if (t) {
          if (body.status) {
            t.status = body.status;
            /* Recompute the bucket, or the row keeps grouping under the old one
               until the next walk -- moving a task to Done and watching it stay
               in To Do is exactly the kind of thing that erodes trust in a view. */
            t.canonical = canonicalStatus(body.status, null);
          }
          if (body.name) t.name = body.name;
          if ('due_date' in body) t.due = body.due_date;
          if ('priority' in body) t.priority = b.priority === null ? null : String(b.priority).toLowerCase();
          if (body.archived) t.archived = true;
          t.updated = Date.now();
        }
      }
      res.json({ ok: true, applied: body });
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    }
  });

  return r;
}
