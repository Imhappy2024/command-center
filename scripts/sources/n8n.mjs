/* n8n — workflow inventory and 24h execution health.
   Auth: Settings -> n8n API -> create an API key. */

async function api(base, pathname, key){
  const res = await fetch(`${base.replace(/\/+$/, '')}/api/v1${pathname}`, {
    headers: { 'X-N8N-API-KEY': key, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`n8n ${pathname.split('?')[0]} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function page(base, pathname, key, cap = 250){
  const out = [];
  let cursor = '';
  while (out.length < cap) {
    const sep = pathname.includes('?') ? '&' : '?';
    const json = await api(base, `${pathname}${sep}limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, key);
    out.push(...(json.data || []));
    if (!json.nextCursor) break;
    cursor = json.nextCursor;
  }
  return out.slice(0, cap);
}

const spark = counts => {
  const max = Math.max(1, ...counts.map(c => c.total));
  return counts.map(c => ({
    height: Math.round((c.total / max) * 100) || 8,
    failed: c.errors > 0
  }));
};

export async function fetchN8n(env){
  const base = env.N8N_BASE_URL;
  const key = env.N8N_API_KEY;
  if (!base || !key) return { ok: false, reason: 'N8N_BASE_URL / N8N_API_KEY not set' };

  const workflows = await page(base, '/workflows', key, 300);
  const execs = await page(base, '/executions', key, 250);

  const dayAgo = Date.now() - 86_400_000;
  const recent = execs.filter(e => new Date(e.startedAt || e.createdAt).getTime() >= dayAgo);
  const failed = recent.filter(e => e.status === 'error' || e.status === 'crashed');

  const byWorkflow = new Map();
  for (const e of recent) {
    const id = String(e.workflowId);
    if (!byWorkflow.has(id)) byWorkflow.set(id, { total: 0, errors: 0, last: null });
    const s = byWorkflow.get(id);
    s.total++;
    if (e.status === 'error' || e.status === 'crashed') s.errors++;
    const at = new Date(e.startedAt || e.createdAt).getTime();
    if (!s.last || at > s.last) s.last = at;
  }

  const rows = workflows
    .map(w => {
      const s = byWorkflow.get(String(w.id)) || { total: 0, errors: 0, last: null };
      const state = !w.active ? 'warn' : s.errors > 0 ? 'off' : 'ok';
      const detail = !w.active
        ? 'Inactive · not scheduled'
        : s.total === 0
          ? 'Active · no runs in 24h'
          : `${s.total} run${s.total === 1 ? '' : 's'} in 24h`;
      return {
        name: w.name,
        detail,
        state,
        runs: s.total,
        errors: s.errors,
        chip: s.errors > 0
          ? { tone: 'rust', text: `${s.errors} fail${s.errors === 1 ? '' : 's'}` }
          : w.active ? { tone: 'jade', text: 'Healthy' } : { text: 'Inactive' },
        spark: spark([
          { total: Math.max(s.total, 1), errors: s.errors },
          { total: Math.max(s.total, 1), errors: s.errors },
          { total: Math.max(s.total, 1), errors: s.errors },
          { total: Math.max(s.total, 1), errors: s.errors },
          { total: Math.max(s.total, 1), errors: s.errors }
        ])
      };
    })
    .sort((a, b) => b.errors - a.errors || b.runs - a.runs)
    .slice(0, 10);

  const active = workflows.filter(w => w.active).length;
  const errorRate = recent.length ? (failed.length / recent.length) * 100 : 0;

  return {
    ok: true,
    counts: {
      total: workflows.length,
      active,
      inactive: workflows.length - active,
      runs24h: recent.length,
      failures24h: failed.length,
      errorRate: Number(errorRate.toFixed(1)),
      capped: execs.length >= 250
    },
    rows
  };
}
