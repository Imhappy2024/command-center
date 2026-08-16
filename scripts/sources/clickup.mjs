/* ClickUp — tasks due today and overdue, for the assigned user.
   Auth: a personal API token (Settings -> Apps -> API Token), sent raw in Authorization. */

const BASE = 'https://api.clickup.com/api/v2';

async function api(pathname, token){
  const res = await fetch(BASE + pathname, {
    headers: { Authorization: token, 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`ClickUp ${pathname} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); };
const endOfToday   = () => { const d = new Date(); d.setHours(23,59,59,999); return d.getTime(); };

function dueLabel(ms, now){
  const days = Math.round((ms - now) / 86_400_000);
  if (days < -1) return `${Math.abs(days)} days late`;
  if (days === -1) return 'yesterday';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

export async function fetchClickUp(env){
  const token = env.CLICKUP_TOKEN;
  if (!token) return { ok: false, reason: 'CLICKUP_TOKEN not set' };

  const teamId = env.CLICKUP_TEAM_ID || (await api('/team', token)).teams?.[0]?.id;
  if (!teamId) throw new Error('no ClickUp team available');

  const me = await api('/user', token);
  const userId = env.CLICKUP_USER_ID || me.user?.id;

  const q = new URLSearchParams({
    include_closed: 'false',
    subtasks: 'true',
    order_by: 'due_date',
    page: '0',
    due_date_lt: String(endOfToday())
  });
  if (userId) q.append('assignees[]', String(userId));

  const { tasks = [] } = await api(`/team/${teamId}/task?${q}`, token);

  const dayStart = startOfToday();
  const now = Date.now();
  const dated = tasks
    .filter(t => t.due_date)
    .map(t => ({ ...t, due: Number(t.due_date) }))
    .sort((a, b) => a.due - b.due);

  const overdue = dated.filter(t => t.due < dayStart);
  const dueToday = dated.filter(t => t.due >= dayStart);

  const rows = dated.slice(0, 6).map(t => {
    const late = t.due < dayStart;
    return {
      title: t.name,
      sub: `${t.list?.name || 'No list'} · ${dueLabel(t.due, now)}`,
      chip: late ? { tone: 'rust', text: 'Overdue' } : { tone: 'brass', text: 'Today' }
    };
  });

  // Tasks view: three columns, grouped by the spaces carrying the most work.
  const bySpace = new Map();
  for (const t of dated) {
    const key = t.space?.name || t.folder?.name || t.list?.name || 'Other';
    if (!bySpace.has(key)) bySpace.set(key, []);
    bySpace.get(key).push(t);
  }
  const groups = [...bySpace.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .map(([name, items]) => ({
      name,
      count: items.length,
      tasks: items.slice(0, 6).map(t => ({
        title: t.name,
        sub: `${t.list?.name || '—'} · ${dueLabel(t.due, now)}`
      }))
    }));

  return {
    ok: true,
    teamId,
    user: me.user?.username || me.user?.email || null,
    counts: { dueToday: dueToday.length, overdue: overdue.length, total: dated.length },
    rows,
    groups
  };
}
