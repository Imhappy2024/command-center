/* Composes data/dashboard.json from whatever sources have credentials.
   Every source degrades independently: a missing or broken one is reported in the
   connection rail rather than faking a number. */

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { fetchClickUp } from './sources/clickup.mjs';
import { fetchGmail } from './sources/gmail.mjs';
import { fetchN8n } from './sources/n8n.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'data', 'dashboard.json');

const SOURCES = [
  ['clickup', 'ClickUp', fetchClickUp],
  ['gmail',   'Gmail',   fetchGmail],
  ['n8n',     'n8n',     fetchN8n]
];

async function collect(env){
  const settled = await Promise.all(SOURCES.map(async ([key, label, fn]) => {
    try {
      const r = await fn(env);
      return r.ok
        ? { key, label, status: 'ok', data: r }
        : { key, label, status: 'unconfigured', reason: r.reason };
    } catch (err) {
      return { key, label, status: 'error', reason: err.message };
    }
  }));
  return Object.fromEntries(settled.map(s => [s.key, s]));
}

function connections(s){
  const rows = Object.values(s).map(r => ({
    state: r.status === 'ok' ? 'ok' : r.status === 'error' ? 'off' : 'warn',
    label: r.status === 'ok'
      ? `${r.label} live`
      : r.status === 'error'
        ? `${r.label} failing`
        : `${r.label} not configured`
  }));
  rows.push({ state: 'warn', label: 'Calendar · no connector' });
  rows.push({ state: 'warn', label: 'GHL · no connector' });
  return rows;
}

function attention(s){
  const out = [];
  const cu = s.clickup.status === 'ok' && s.clickup.data;
  const n8 = s.n8n.status === 'ok' && s.n8n.data;
  const gm = s.gmail.status === 'ok' && s.gmail.data;

  if (cu && cu.counts.overdue > 0) {
    out.push({
      title: `${cu.counts.overdue} task${cu.counts.overdue === 1 ? '' : 's'} overdue`,
      detail: cu.rows.find(r => r.chip.tone === 'rust')?.title || 'Assigned to you in ClickUp.'
    });
  }
  if (n8 && n8.counts.failures24h > 0) {
    out.push({
      title: `${n8.counts.failures24h} workflow failure${n8.counts.failures24h === 1 ? '' : 's'} in 24h`,
      detail: `${n8.rows.find(r => r.errors > 0)?.name || 'Check n8n executions'} · ${n8.counts.errorRate}% error rate.`
    });
  }
  if (gm && gm.counts.unreadThreads > 200) {
    out.push({
      title: `${gm.counts.unreadThreads.toLocaleString()} unread threads`,
      detail: 'The inbox is past the point where triage-by-hand works.'
    });
  }
  for (const r of Object.values(s)) {
    if (r.status === 'error') out.push({ title: `${r.label} is failing`, detail: r.reason });
  }

  const live = Object.values(s).filter(r => r.status === 'ok');
  if (!live.length) {
    const failing = Object.values(s).filter(r => r.status === 'error');
    return [
      {
        title: failing.length ? `No sources reachable · ${failing.length} failing` : 'No sources connected',
        detail: 'Nothing is being watched, so an empty dashboard means nothing.'
      },
      ...failing.map(r => ({ title: `${r.label} is failing`, detail: r.reason })),
      ...Object.values(s)
        .filter(r => r.status === 'unconfigured')
        .map(r => ({ title: `${r.label} not configured`, detail: r.reason }))
    ].slice(0, 4);
  }

  if (!out.length) {
    out.push({
      title: 'Nothing is on fire',
      detail: `No overdue work and no failing automations across ${live.map(r => r.label).join(', ')}.`
    });
  }
  return out.slice(0, 4);
}

function stats(s){
  const cu = s.clickup.status === 'ok' && s.clickup.data;
  const n8 = s.n8n.status === 'ok' && s.n8n.data;
  const gm = s.gmail.status === 'ok' && s.gmail.data;

  return [
    gm
      ? { eyebrow: 'Unread threads', value: gm.counts.unreadThreads.toLocaleString(), meta: `of ${gm.counts.totalThreads.toLocaleString()} total`, tone: 'flat' }
      : { eyebrow: 'Unread threads', value: '—', meta: 'Gmail not connected', tone: 'flat' },
    cu
      ? { eyebrow: 'Due today', value: String(cu.counts.dueToday), meta: cu.counts.overdue ? `${cu.counts.overdue} overdue` : 'nothing overdue', tone: cu.counts.overdue ? 'down' : 'up' }
      : { eyebrow: 'Due today', value: '—', meta: 'ClickUp not connected', tone: 'flat' },
    n8
      ? { eyebrow: 'Runs · 24h', value: n8.counts.runs24h.toLocaleString() + (n8.counts.capped ? '+' : ''), meta: `${n8.counts.failures24h} failed`, tone: n8.counts.failures24h ? 'down' : 'up' }
      : { eyebrow: 'Runs · 24h', value: '—', meta: 'n8n not connected', tone: 'flat' },
    n8
      ? { eyebrow: 'Active workflows', value: String(n8.counts.active), meta: `${n8.counts.inactive} inactive`, tone: 'flat' }
      : { eyebrow: 'Active workflows', value: '—', meta: 'n8n not connected', tone: 'flat' }
  ];
}

function hero(s){
  const cu = s.clickup.status === 'ok' && s.clickup.data;
  if (!cu) {
    return {
      eyebrow: 'Open work · assigned to you',
      value: '—',
      sub: 'ClickUp is not connected, so there is no count to show.',
      progressPct: 0,
      progressLabel: 'Set CLICKUP_TOKEN to populate this.'
    };
  }
  const { total, overdue, dueToday } = cu.counts;
  const onTime = total ? Math.round(((total - overdue) / total) * 100) : 100;
  return {
    eyebrow: 'Open work · assigned to you',
    value: String(total),
    sub: `${dueToday} due today · ${overdue} overdue · ${cu.groups.length} space${cu.groups.length === 1 ? '' : 's'}`,
    progressPct: onTime,
    progressLabel: `${onTime}% still inside their due date`
  };
}

function todayRows(){
  return [{
    time: '—',
    title: 'Calendar not connected',
    sub: 'Needs Google Calendar API credentials; no connector is wired yet.',
    chip: { tone: 'brass', text: 'Todo' }
  }];
}

export async function runRefresh({ env = process.env, out = env.DATA_FILE || DEFAULT_OUT } = {}){
  const s = await collect(env);
  const ok = Object.values(s).filter(r => r.status === 'ok').length;
  const configured = Object.values(s).filter(r => r.status !== 'unconfigured').length;

  const cu = s.clickup.status === 'ok' && s.clickup.data;
  const gm = s.gmail.status === 'ok' && s.gmail.data;
  const n8 = s.n8n.status === 'ok' && s.n8n.data;

  const payload = {
    source: ok === 0 ? 'unconfigured' : ok === SOURCES.length ? 'live' : 'partial',
    generatedAt: new Date().toISOString(),
    sources: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { status: v.status, reason: v.reason || null }])),
    connections: connections(s),
    nav: {
      inbox: gm ? String(gm.counts.unreadThreads) : '',
      tasks: cu ? String(cu.counts.dueToday) : '',
      systems: n8 && n8.counts.failures24h ? String(n8.counts.failures24h) : ''
    },
    overview: {
      greeting: {
        name: env.OWNER_NAME || (cu ? cu.user : null),
        sub: `${ok} of ${SOURCES.length} sources live${configured < SOURCES.length ? `, ${SOURCES.length - configured} unconfigured` : ''}.`
      },
      hero: hero(s),
      attention: attention(s),
      stats: stats(s),
      today: todayRows(),
      tasks: cu ? cu.rows : []
    },
    inbox: gm ? { counts: gm.counts, messages: gm.messages } : null,
    tasks: cu ? { counts: cu.counts, groups: cu.groups } : null,
    systems: n8 ? { counts: n8.counts, rows: n8.rows } : null
  };

  await mkdir(path.dirname(out), { recursive: true });
  const tmp = out + '.tmp';
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await rename(tmp, out);

  return { payload, out, summary: Object.entries(s).map(([k, v]) => `${k}=${v.status}`).join(' ') };
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runRefresh()
    .then(r => {
      console.log(`[refresh] ${r.summary}`);
      console.log(`[refresh] source=${r.payload.source} -> ${r.out}`);
      for (const [k, v] of Object.entries(r.payload.sources)) {
        if (v.reason) console.log(`[refresh]   ${k}: ${v.reason}`);
      }
    })
    .catch(err => { console.error('[refresh] failed:', err.message); process.exit(1); });
}
