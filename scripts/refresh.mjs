/* Composes data/dashboard.json from whatever sources have credentials.
   Every source degrades independently: a missing or broken one is reported in the
   connection rail rather than faking a number. */

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { fetchClickUp } from './sources/clickup.mjs';
import { fetchGmail } from './sources/gmail.mjs';
import { fetchN8n } from './sources/n8n.mjs';
import { fetchMicrosoft } from './sources/microsoft.mjs';
import { tokensFor } from '../lib/providers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'data', 'dashboard.json');

const SOURCES = [
  ['clickup',   'ClickUp', fetchClickUp],
  ['gmail',     'Gmail',   fetchGmail],
  ['n8n',       'n8n',     fetchN8n],
  ['microsoft', 'Outlook', fetchMicrosoft]
];

async function collect(env, ctx){
  const settled = await Promise.all(SOURCES.map(async ([key, label, fn]) => {
    try {
      const r = await fn(env, ctx);
      return r.ok
        ? { key, label, status: 'ok', data: r }
        : { key, label, status: 'unconfigured', reason: r.reason };
    } catch (err) {
      return { key, label, status: 'error', reason: err.message };
    }
  }));
  return Object.fromEntries(settled.map(s => [s.key, s]));
}

/* Access tokens for every account connected through the UI. A failure here is
   not fatal: the source falls back to its environment-variable path. */
async function connectedAccounts(env, store){
  if (!store?.enabled) return {};
  const ctx = {};
  for (const name of ['google', 'microsoft']) {
    try {
      ctx[name] = await tokensFor(name, env, store);
    } catch (err) {
      console.error(`[refresh] ${name} token lookup failed:`, err.message);
      ctx[name] = [];
    }
  }
  return ctx;
}

function connections(s){
  const rows = Object.values(s).map(r => ({
    state: r.status === 'ok' ? 'ok' : r.status === 'error' ? 'off' : 'warn',
    label: r.status === 'ok'
      ? `${r.label} live`
      : r.status === 'error'
        ? `${r.label} failing`
        : `${r.label} not configured`,
    reason: r.reason || null
  }));
  // Graph consent is per-permission: calendar can succeed while mail is denied.
  const ms = s.microsoft.status === 'ok' && s.microsoft.data;
  if (ms?.mailError) rows.push({ state: 'warn', label: 'Outlook mail denied', reason: ms.mailError });
  if (ms?.contactsError) rows.push({ state: 'warn', label: 'Outlook contacts denied', reason: ms.contactsError });

  // An individual account whose refresh token died, while others still work.
  for (const r of Object.values(s)) {
    for (const w of (r.status === 'ok' && r.data?.warnings) || []) {
      rows.push({ state: 'off', label: w.split(':')[0] + ' needs reconnect', reason: w });
    }
  }
  rows.push({ state: 'warn', label: 'GHL · no connector' });
  return rows;
}

function attention(s, mail){
  const out = [];
  const cu = s.clickup.status === 'ok' && s.clickup.data;
  const n8 = s.n8n.status === 'ok' && s.n8n.data;
  const gm = mail;

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

function stats(s, mail){
  const cu = s.clickup.status === 'ok' && s.clickup.data;
  const n8 = s.n8n.status === 'ok' && s.n8n.data;
  const ms = s.microsoft.status === 'ok' && s.microsoft.data;

  return [
    mail
      ? { eyebrow: `Unread · ${mail.label}`, value: mail.counts.unreadThreads.toLocaleString(), meta: `of ${mail.counts.totalThreads.toLocaleString()} total`, tone: 'flat' }
      : { eyebrow: 'Unread', value: '—', meta: 'no mailbox connected', tone: 'flat' },
    cu
      ? { eyebrow: 'Due today', value: String(cu.counts.dueToday), meta: cu.counts.overdue ? `${cu.counts.overdue} overdue` : 'nothing overdue', tone: cu.counts.overdue ? 'down' : 'up' }
      : { eyebrow: 'Due today', value: '—', meta: 'ClickUp not connected', tone: 'flat' },
    ms
      ? { eyebrow: 'Meetings today', value: String(ms.calendar.today.length), meta: `${Math.round(ms.calendar.bookedMins / 60 * 10) / 10}h booked`, tone: 'flat' }
      : { eyebrow: 'Meetings today', value: '—', meta: 'Outlook not connected', tone: 'flat' },
    n8
      ? { eyebrow: 'Runs · 24h', value: n8.counts.runs24h.toLocaleString() + (n8.counts.capped ? '+' : ''), meta: `${n8.counts.failures24h} failed`, tone: n8.counts.failures24h ? 'down' : 'up' }
      : { eyebrow: 'Runs · 24h', value: '—', meta: 'n8n not connected', tone: 'flat' }
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

function todayRows(s){
  const ms = s.microsoft.status === 'ok' && s.microsoft.data;
  if (ms) {
    if (ms.calendar.today.length) return ms.calendar.today;
    return [{ time: '—', title: 'Nothing scheduled today', sub: 'The calendar is clear.', chip: { tone: 'jade', text: 'Free' } }];
  }
  if (s.microsoft.status === 'error') {
    return [{ time: '—', title: 'Outlook calendar failing', sub: s.microsoft.reason, chip: { tone: 'rust', text: 'Error' } }];
  }
  return [{
    time: '—',
    title: 'Calendar not connected',
    sub: 'Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MS_SERVICE_USER.',
    chip: { tone: 'brass', text: 'Todo' }
  }];
}

/* Every connected mailbox, from both providers, merged into one Inbox.
   MAIL_SOURCE=outlook|gmail narrows it to a single provider. */
function mailbox(s, env){
  const pin = (env.MAIL_SOURCE || 'all').toLowerCase();
  const parts = [];

  if (pin !== 'gmail' && s.microsoft.status === 'ok' && s.microsoft.data?.mail) {
    parts.push(s.microsoft.data.mail);
  }
  if (pin !== 'outlook' && s.gmail.status === 'ok' && s.gmail.data) {
    parts.push(s.gmail.data);
  }
  if (!parts.length) return null;

  const mailboxes = parts.flatMap(p => p.mailboxes || []);
  const counts = mailboxes.reduce((a, m) => ({
    unreadMessages: a.unreadMessages + (m.counts.unreadMessages || 0),
    unreadThreads: a.unreadThreads + (m.counts.unreadThreads || 0),
    totalThreads: a.totalThreads + (m.counts.totalThreads || 0)
  }), { unreadMessages: 0, unreadThreads: 0, totalThreads: 0 });

  const label = mailboxes.length === 1
    ? (mailboxes[0].account || mailboxes[0].label)
    : `${mailboxes.length} mailboxes`;

  return {
    label,
    mailboxes,
    counts,
    messages: parts.flatMap(p => p.messages || [])
      .sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0))
      .slice(0, 10)
  };
}

export async function runRefresh({ env = process.env, out = env.DATA_FILE || DEFAULT_OUT, store = null } = {}){
  const ctx = await connectedAccounts(env, store);
  const s = await collect(env, ctx);
  const ok = Object.values(s).filter(r => r.status === 'ok').length;
  const configured = Object.values(s).filter(r => r.status !== 'unconfigured').length;

  const cu = s.clickup.status === 'ok' && s.clickup.data;
  const n8 = s.n8n.status === 'ok' && s.n8n.data;
  const ms = s.microsoft.status === 'ok' && s.microsoft.data;
  const mail = mailbox(s, env);

  const payload = {
    source: ok === 0 ? 'unconfigured' : ok === SOURCES.length ? 'live' : 'partial',
    generatedAt: new Date().toISOString(),
    timezone: env.AGENT_TIMEZONE || env.TIMEZONE || 'UTC',
    sources: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { status: v.status, reason: v.reason || null }])),
    connections: connections(s),
    nav: {
      inbox: mail ? String(mail.counts.unreadThreads) : '',
      calendar: ms ? String(ms.calendar.today.length) : '',
      tasks: cu ? String(cu.counts.dueToday) : '',
      systems: n8 && n8.counts.failures24h ? String(n8.counts.failures24h) : ''
    },
    overview: {
      greeting: {
        name: env.OWNER_NAME || (cu ? cu.user : null),
        sub: `${ok} of ${SOURCES.length} sources live${configured < SOURCES.length ? `, ${SOURCES.length - configured} unconfigured` : ''}.`
      },
      hero: hero(s),
      attention: attention(s, mail),
      stats: stats(s, mail),
      today: todayRows(s),
      tasks: cu ? cu.rows : []
    },
    inbox: mail ? { label: mail.label, mailboxes: mail.mailboxes, counts: mail.counts, messages: mail.messages } : null,
    calendar: ms ? { ...ms.calendar, timezone: ms.timezone, user: ms.user } : null,
    contacts: ms?.contacts || null,
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
