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
      /* The path and ClickUp's own ECODE go in the message.

         "ClickUp 404: Not found" on a screen is unactionable: a workspace walk
         touches /team, /space, /folder and a list endpoint per list, and the one
         that failed is the entire diagnosis. ECODE separates the cases that read
         identically -- a deleted list, a token that lost access to a space, and a
         team id that is not this token's. */
      const where = method + ' ' + String(path).split('?')[0];
      const code = json?.ECODE ? ' [' + json.ECODE + ']' : '';
      throw new ClickUpError('ClickUp ' + res.status + ' on ' + where + ': ' + detail + code, res.status);
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

/* Enough of a hash to tell two status sets apart. Not a checksum and not
   security -- the only requirement is that identical sets collide and different
   ones usually do not, and a collision would at worst show one list the wrong
   five statuses. */
function hash(str){
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/* Every list in the workspace, with the space and folder it belongs to.

   Nothing below the top-level space call is allowed to be fatal. A workspace
   this size is a few hundred requests against a token someone else is also
   using, and a single space that has been archived out from under the walk, or
   one 429 that outlasts its retries, used to throw all 4,800 tasks away and put
   "ClickUp 404: Not found" on the screen with no way to tell which of those
   hundreds of calls it was. Skipping the piece that failed and saying so is
   worth far more than the missing rows cost. */
async function discoverLists(call, teamId){
  const problems = [];
  const note = (where, err) => problems.push({ where, status: err.status || 0, message: err.message });

  /* Every distinct set of statuses in the workspace, keyed by its own shape.

     Twenty-one spaces and 213 lists, but only a handful of genuinely different
     status sets between them -- almost every list inherits its space's. Storing
     the set once and having lists point at it keeps this off a payload that is
     already carrying nearly five thousand tasks. */
  const statusSets = {};
  const keyFor = raw => {
    const clean = (raw || []).filter(s => s && s.status).map(s => ({
      status: s.status, type: s.type || null, color: s.color || null,
      orderindex: s.orderindex, canonical: canonicalStatus(s.status, s.type)
    }));
    if (!clean.length) return null;
    /* The key is the content, so two lists with the same statuses share one
       entry however they came by them. */
    const key = 's' + hash(clean.map(s => s.status + '\u0001' + s.type).join('\u0002'));
    if (!statusSets[key]) statusSets[key] = clean;
    return key;
  };

  const spacesRes = await call(`/team/${teamId}/space?archived=false`);
  const spaces = spacesRes.spaces || [];
  const lists = [];

  await mapLimit(spaces, 3, async space => {
    const meta = { id: space.id, name: space.name };
    /* The space's own set, which is what a list uses unless it says otherwise. */
    const spaceKey = keyFor(space.statuses);

    /* A list carries its statuses when it has them; otherwise, unless it has
       overridden them, it is using the ones above it. Only a list that both
       overrides and declines to say what with needs asking, and there are
       sixteen of those in the whole workspace. */
    const resolve = (l, inheritKey) => keyFor(l.statuses)
      || (l.override_statuses ? null : (inheritKey || spaceKey));

    /* Folderless lists hang directly off the space. */
    const direct = await call(`/space/${space.id}/list?archived=false`)
      .catch(err => { note('lists in space "' + space.name + '"', err); return { lists: [] }; });
    for (const l of direct.lists || []) {
      lists.push({ id: l.id, name: l.name, space: meta, folder: null, statusKey: resolve(l, null) });
    }

    const folders = await call(`/space/${space.id}/folder?archived=false`)
      .catch(err => { note('folders in space "' + space.name + '"', err); return { folders: [] }; });
    await mapLimit(folders.folders || [], 3, async f => {
      const fmeta = { id: f.id, name: f.name };
      const folderKey = keyFor(f.statuses) || (f.override_statuses ? null : spaceKey);
      /* The folder payload usually embeds its lists; fall back to asking. */
      const inner = f.lists?.length
        ? { lists: f.lists }
        : await call(`/folder/${f.id}/list?archived=false`)
            .catch(err => { note('lists in folder "' + f.name + '"', err); return { lists: [] }; });
      for (const l of inner.lists || []) {
        lists.push({ id: l.id, name: l.name, space: meta, folder: fmeta, statusKey: resolve(l, folderKey) });
      }
    });
  });

  /* Whatever is left over. A list that overrides its statuses without saying
     what with has to be asked directly. Sixteen of 213 -- but between them they
     hold 484 tasks, which is why leaving them to be fetched on click puts the
     old wait back exactly where it is most likely to be felt: 92% of lists
     resolve for free, but only 68% of tasks.

     Handed back rather than run, so the caller can start it and get on with the
     task walk instead of making the first row wait behind it. It mutates lists
     and statusSets in place; both are already in the caller's hands.

     Three at a time, like the rest of the walk, and never fatal: a list whose
     statuses cannot be read still shows up with all its tasks, and its picker
     falls back to asking the way it always did. */
  const resolveStragglers = async () => {
    const left = lists.filter(l => !l.statusKey);
    if (!left.length) return;
    await mapLimit(left, 3, async l => {
      const one = await call(`/list/${l.id}`)
        .catch(err => { note('statuses for list "' + l.name + '"', err); return null; });
      if (one) l.statusKey = keyFor(one.statuses);
    });
  };

  return {
    lists,
    resolveStragglers,
    /* Members come with the space and are the set that can actually be assigned
       there. The workspace has 36 people; a space has nine. Showing nine
       instantly beats showing thirty-six after a second. */
    spaces: spaces.map(s => ({
      id: s.id, name: s.name,
      members: (s.members || []).map(m => ({
        id: String(m.user?.id ?? m.id),
        username: m.user?.username || m.user?.email || String(m.user?.id ?? m.id),
        email: m.user?.email || null,
        color: m.user?.color || null,
        initials: m.user?.initials || null
      }))
    })),
    statusSets,
    problems
  };
}

/* Every page of one list. `include_closed` matters: without it a board looks
   permanently half-empty and "Completed (30d)" is always zero. */
async function listTasks(call, listId, { archived = false, maxPages = 40 } = {}){
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const q = `?page=${page}&include_closed=true&subtasks=true&order_by=due_date`
      + (archived ? '&archived=true' : '&archived=false');
    let res;
    try {
      res = await call(`/list/${listId}/task${q}`);
    } catch (err) {
      /* One bad list must not lose the whole walk -- and that has to mean ANY
         failure, not just the two statuses that were easy to predict. Whatever
         pages already came back are kept; the caller is told what was lost. */
      return { tasks: out, error: err.message, status: err.status || 0 };
    }
    const tasks = res.tasks || [];
    out.push(...tasks);
    if (res.last_page || tasks.length === 0) break;
  }
  return { tasks: out, error: null };
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

    /* The whole workspace. Slow by nature; cache the result.

       Roughly three hundred requests against a token limited to a hundred a
       minute, so this takes minutes and no amount of concurrency changes that --
       it is rate-bound, not connection-bound. What does change is whether the
       wait is legible, which is why it reports progress. */
    async workspace({ onProgress } = {}){
      /* The walk is three minutes long, so it hands back what it has as it goes
         rather than only at the end. Waiting for all 212 lists to show any of
         them is three minutes of a progress bar when the first list was ready
         in two seconds. */
      const tick = (phase, done, total, payload) => {
        if (typeof onProgress === 'function') {
          try { onProgress({ phase, done, total, ...payload }); } catch { /* never break the walk */ }
        }
      };
      tick('teams', 0, 0);
      const teams = await this.teams();
      const team = teams.find(t => String(t.id) === String(teamId)) || teams[0];
      if (!team) throw new ClickUpError('That token can see no ClickUp workspaces', 403);

      tick('lists', 0, 0);
      const { lists, spaces, statusSets, resolveStragglers, problems } = await discoverLists(call, team.id);
      /* What the editors need, shaped once and used in the progress ticks and
         in the finished payload. statusKey points into statusSets. */
      const listOut = l => ({ id: l.id, name: l.name, spaceId: l.space.id,
        folderId: l.folder?.id || null, statusKey: l.statusKey || null });
      /* Spaces, lists and members are known now and the filters need them, so
         they go out before a single task has been read. The status sets go with
         them, which is what lets the status picker open with its options
         already in it rather than asking ClickUp on every click. */
      tick('tasks', 0, lists.length, {
        teamId: team.id, teamName: team.name, members: team.members, spaces, statusSets,
        lists: lists.map(listOut)
      });

      /* Three, not five: the rate limit is per token, and the walk finishing
         two minutes later beats it failing halfway. */
      let walked = 0;

      /* Deliberately started rather than awaited: it shares the rate limit with
         the task walk below and finishes inside its first few seconds, so
         putting it in front would only make the first row wait.

         The catch-up tick is the point of doing it this way. statusSets is
         mutated in place and the caller is holding the same object, but the
         lists were projected into new objects a moment ago with no key on the
         sixteen, so those have to be sent again -- otherwise the pickers for
         them fall back to asking for the whole of the first walk, which on a
         cold start is the three minutes somebody is most likely to be
         clicking. */
      const stragglers = resolveStragglers()
        .then(() => tick('tasks', walked, lists.length, { statusSets, lists: lists.map(listOut) }))
        .catch(err => {
          /* Never fatal, and never an unhandled rejection in the window before
             it is awaited. Those lists simply keep asking, as they always did. */
          problems.push({ where: 'statuses for overriding lists',
            status: err.status || 0, message: err.message });
        });
      const perList = await mapLimit(lists, 3, async l => {
        const { tasks, error, status } = await listTasks(call, l.id);
        if (error) problems.push({ where: 'tasks in list "' + l.name + '"', status, message: error });
        /* Stamp the walk metadata on: the task payload does not carry names. */
        const stamped = tasks.map(t => ({ ...t, space: l.space, folder: l.folder, list: { id: l.id, name: l.name } }));
        /* Shaped here as well as at the end. Shaping twice costs a map over one
           list's tasks; not shaping means the caller cannot show them. */
        tick('tasks', ++walked, lists.length, { batch: stamped.map(shapeTask) });
        return stamped;
      });

      /* Long since finished; this is where its failures surface as problems. */
      await stragglers;

      const byId = new Map();
      for (const group of perList) for (const t of group) byId.set(t.id, t);

      const tasks = [...byId.values()].map(shapeTask);

      /* Every list failing is not a partial result, it is a broken token or a
         dead API, and serving an empty board as though it were the truth is the
         one outcome worse than an error. */
      if (lists.length && !tasks.length && problems.length >= lists.length) {
        throw new ClickUpError('Every list failed to read. First: ' + problems[0].message,
          problems[0].status || 502);
      }

      return {
        teamId: team.id,
        teamName: team.name,
        members: team.members,
        spaces,
        statusSets,
        lists: lists.map(listOut),
        tasks,
        /* What the walk could not read. Empty because there was nothing, or
           empty because a call broke? The UI cannot tell on its own. */
        problems,
        listCount: lists.length,
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
