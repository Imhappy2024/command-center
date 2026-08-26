/* ClickUp, for the Tasks section.

   The shape of this is dictated by what ClickUp's API will and will not tell
   you. There is no "give me every task in the workspace" call, so the whole
   workspace has to be walked: team → spaces → folders → lists → tasks, paged.
   And a task's own payload does not reliably carry the names of the space and
   folder it lives in, so those are stamped on during the walk — after the fact
   there is nothing to join on.

   One request per list, five lists at a time. A hundred-list workspace is a
   hundred requests, which is why the result is cached rather than fetched per
   page view.

   Read-only. Writes (status, assignee, due date) go through routes/tasks.js so
   they can be authorised separately. */

const API = 'https://api.clickup.com/api/v2';

/* ClickUp's own statuses are per-list and arbitrary — one list says "in
   progress", another "🔨 Building", a third "WIP". Grouping them is the only way
   a cross-workspace view means anything. `type` is authoritative when present
   ('open'/'closed'/'custom'); the patterns are for everything in between. */
const CANONICAL = ['To Do', 'In Progress', 'In Review', 'Blocked', 'Long Term', 'Completed'];

const STATUS_PATTERNS = [
  [/^(complete|completed|done|closed|shipped|live|approved|paid|won)$/i, 'Completed'],
  [/(review|qa|approval|awaiting|pending review|sign.?off)/i, 'In Review'],
  [/(block|stuck|waiting on|on hold|hold|paused|impediment)/i, 'Blocked'],
  [/(long.?term|someday|backlog|icebox|parking|future|later)/i, 'Long Term'],
  [/(progress|doing|active|working|wip|started|in.?flight|building)/i, 'In Progress'],
  [/(to.?do|todo|new|open|planned|not started|queue|triage|idea)/i, 'To Do']
];

export function canonicalStatus(raw, type){
  const name = String(raw || '').trim();
  for (const [re, bucket] of STATUS_PATTERNS) if (re.test(name)) return bucket;
  /* Only after the patterns: a list can call a closed status "Archived" and an
     open one "Blocked", and the name is the better signal when it matches. */
  if (type === 'closed') return 'Completed';
  if (type === 'open') return 'To Do';
  return 'To Do';
}

export const PRIORITY_BY_ID = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };

export function priorityOf(task){
  const p = task.priority;
  if (!p) return null;
  const named = String(p.priority || '').toLowerCase();
  if (named) return named;
  return PRIORITY_BY_ID[String(p.id)] || null;
}

class ClickUpError extends Error {
  constructor(message, status){ super(message); this.status = status; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeClient(token){
  if (!token) throw new ClickUpError('CLICKUP_TOKEN is not set', 400);

  /* A workspace walk is a hundred requests and ClickUp rate-limits per token,
     so 429 is an expected part of the flow rather than an error. It tells you
     when to come back -- Retry-After in seconds, or X-RateLimit-Reset as an
     epoch -- and honouring that is far better than guessing a delay. */
  return async function call(path, { method = 'GET', body = null, timeoutMs = 30_000, attempt = 0 } = {}){
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: token,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });

    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      let waitMs = Math.min(30_000, 1000 * Math.pow(2, attempt));
      const retryAfter = Number(res.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.min(60_000, retryAfter * 1000);
      else {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        if (Number.isFinite(reset) && reset > 0) {
          /* Sometimes seconds-from-now, sometimes an epoch. Both are usable. */
          const asEpoch = reset > 1e9 ? reset * 1000 - Date.now() : reset * 1000;
          if (asEpoch > 0) waitMs = Math.min(60_000, asEpoch + 500);
        }
      }
      await res.text().catch(() => {});
      await sleep(waitMs);
      return call(path, { method, body, timeoutMs, attempt: attempt + 1 });
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* ClickUp sometimes returns HTML on 5xx */ }
    if (!res.ok) {
      const detail = json?.err || json?.error || text.slice(0, 200) || res.statusText;
      throw new ClickUpError('ClickUp ' + res.status + ': ' + detail, res.status);
    }
    return json || {};
  };
}

/* Bounded concurrency. ClickUp rate-limits per token (100/min on the free tier),
   and a workspace walk fired all at once gets a wall of 429s. */
async function mapLimit(items, limit, fn){
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* Every list in the workspace, with the space and folder it belongs to. */
async function discoverLists(call, teamId){
  const spacesRes = await call(`/team/${teamId}/space?archived=false`);
  const spaces = spacesRes.spaces || [];
  const lists = [];

  await mapLimit(spaces, 3, async space => {
    const meta = { id: space.id, name: space.name };

    /* Folderless lists hang directly off the space. */
    const direct = await call(`/space/${space.id}/list?archived=false`).catch(() => ({ lists: [] }));
    for (const l of direct.lists || []) lists.push({ id: l.id, name: l.name, space: meta, folder: null });

    const folders = await call(`/space/${space.id}/folder?archived=false`).catch(() => ({ folders: [] }));
    await mapLimit(folders.folders || [], 3, async f => {
      const fmeta = { id: f.id, name: f.name };
      /* The folder payload usually embeds its lists; fall back to asking. */
      const inner = f.lists?.length
        ? { lists: f.lists }
        : await call(`/folder/${f.id}/list?archived=false`).catch(() => ({ lists: [] }));
      for (const l of inner.lists || []) lists.push({ id: l.id, name: l.name, space: meta, folder: fmeta });
    });
  });

  return { lists, spaces: spaces.map(s => ({ id: s.id, name: s.name })) };
}

/* Every page of one list. `include_closed` matters: without it a board looks
   permanently half-empty and "Completed (30d)" is always zero. */
async function listTasks(call, listId, { archived = false, maxPages = 40 } = {}){
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const q = `?page=${page}&include_closed=true&subtasks=true&order_by=due_date`
      + (archived ? '&archived=true' : '&archived=false');
    const res = await call(`/list/${listId}/task${q}`).catch(err => {
      /* One bad list must not lose the whole walk. */
      if (err.status === 404 || err.status === 401) return { tasks: [], last_page: true };
      throw err;
    });
    const tasks = res.tasks || [];
    out.push(...tasks);
    if (res.last_page || tasks.length === 0) break;
  }
  return out;
}

export function createClickUp({ token, teamId }){
  const call = makeClient(token);

  return {
    /* Who the token belongs to, and which workspaces it can see. */
    async teams(){
      const res = await call('/team');
      return (res.teams || []).map(t => ({
        id: t.id,
        name: t.name,
        members: (t.members || []).map(m => ({
          id: String(m.user?.id),
          username: m.user?.username || m.user?.email || String(m.user?.id),
          email: m.user?.email || null,
          color: m.user?.color || null,
          initials: m.user?.initials || null
        }))
      }));
    },

    /* The whole workspace. Slow by nature; cache the result. */
    async workspace(){
      const teams = await this.teams();
      const team = teams.find(t => String(t.id) === String(teamId)) || teams[0];
      if (!team) throw new ClickUpError('That token can see no ClickUp workspaces', 403);

      const { lists, spaces } = await discoverLists(call, team.id);

      /* Three, not five: the rate limit is per token, and the walk finishing
         two minutes later beats it failing halfway. */
      const perList = await mapLimit(lists, 3, async l => {
        const tasks = await listTasks(call, l.id);
        /* Stamp the walk metadata on: the task payload does not carry names. */
        return tasks.map(t => ({ ...t, space: l.space, folder: l.folder, list: { id: l.id, name: l.name } }));
      });

      const byId = new Map();
      for (const group of perList) for (const t of group) byId.set(t.id, t);

      const tasks = [...byId.values()].map(shapeTask);

      return {
        teamId: team.id,
        teamName: team.name,
        members: team.members,
        spaces,
        lists: lists.map(l => ({ id: l.id, name: l.name, spaceId: l.space.id, folderId: l.folder?.id || null })),
        tasks,
        fetchedAt: new Date().toISOString()
      };
    },

    async statuses(listId){
      const res = await call(`/list/${listId}`);
      return (res.statuses || []).map(s => ({
        status: s.status, type: s.type, color: s.color,
        orderindex: s.orderindex, canonical: canonicalStatus(s.status, s.type)
      }));
    },

    async members(listId){
      const res = await call(`/list/${listId}/member`);
      return (res.members || []).map(m => ({
        id: String(m.id), username: m.username || m.email || String(m.id),
        email: m.email || null, color: m.color || null
      }));
    },

    async comments(taskId){
      const res = await call(`/task/${taskId}/comment`);
      return (res.comments || []).map(c => ({
        id: c.id,
        text: c.comment_text || (c.comment || []).map(p => p.text || '').join(''),
        user: c.user?.username || c.user?.email || 'someone',
        at: c.date ? new Date(Number(c.date)).toISOString() : null
      }));
    },

    updateTask(taskId, body){ return call(`/task/${taskId}`, { method: 'PUT', body }); },
    addComment(taskId, text){
      return call(`/task/${taskId}/comment`, { method: 'POST', body: { comment_text: text, notify_all: false } });
    }
  };
}

/* One task, trimmed to what the views read. ClickUp returns ~40 fields per task
   and a 3,000-task workspace ships megabytes of them; this keeps the payload to
   what Overview and All Tasks actually use. */
function shapeTask(t){
  const num = v => (v == null || v === '' ? null : Number(v));
  return {
    id: t.id,
    name: t.name || '(untitled)',
    url: t.url || null,
    status: t.status?.status || null,
    statusType: t.status?.type || null,
    statusColor: t.status?.color || null,
    canonical: canonicalStatus(t.status?.status, t.status?.type),
    priority: priorityOf(t),
    assignees: (t.assignees || []).map(a => ({
      id: String(a.id), username: a.username || a.email || String(a.id),
      email: a.email || null, color: a.color || null
    })),
    tags: (t.tags || []).map(x => x.name).filter(Boolean),
    parent: t.parent || null,
    created: num(t.date_created),
    updated: num(t.date_updated),
    closed: num(t.date_closed),
    due: num(t.due_date),
    start: num(t.start_date),
    timeEstimate: num(t.time_estimate),
    space: t.space || null,
    folder: t.folder || null,
    list: t.list || null,
    archived: Boolean(t.archived)
  };
}

export { CANONICAL, ClickUpError };
