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
import { buildCalendar } from '../lib/calendar.mjs';

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

function stats(s, mail, cal){
  const cu = s.clickup.status === 'ok' && s.clickup.data;
  const n8 = s.n8n.status === 'ok' && s.n8n.data;

  return [
    mail
      ? { eyebrow: `Unread · ${mail.label}`, value: mail.counts.unreadThreads.toLocaleString(), meta: `of ${mail.counts.totalThreads.toLocaleString()} total`, tone: 'flat' }
      : { eyebrow: 'Unread', value: '—', meta: 'no mailbox connected', tone: 'flat' },
    cu
      ? { eyebrow: 'Due today', value: String(cu.counts.dueToday), meta: cu.counts.overdue ? `${cu.counts.overdue} overdue` : 'nothing overdue', tone: cu.counts.overdue ? 'down' : 'up' }
      : { eyebrow: 'Due today', value: '—', meta: 'ClickUp not connected', tone: 'flat' },
    cal
      ? { eyebrow: 'Meetings today', value: String(cal.today.length), meta: `${Math.round(cal.bookedMins / 60 * 10) / 10}h booked`, tone: 'flat' }
      : { eyebrow: 'Meetings today', value: '—', meta: 'no calendar connected', tone: 'flat' },
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

function todayRows(s, cal){
  if (cal) {
    if (cal.today.length) return cal.today;
    return [{ time: '—', title: 'Nothing scheduled today', sub: 'Every connected calendar is clear.', chip: { tone: 'jade', text: 'Free' } }];
  }
  if (s.microsoft.status === 'error') {
    return [{ time: '—', title: 'Outlook calendar failing', sub: s.microsoft.reason, chip: { tone: 'rust', text: 'Error' } }];
  }
  return [{
    time: '—',
    title: 'No calendar connected',
    sub: 'Connect Google or Microsoft on the Calendar page.',
    chip: { tone: 'brass', text: 'Todo' }
  }];
}

/* Round-robin across mailboxes, newest-first within each.
   A flat sort by timestamp lets one busy account fill the whole list and hide
   the others, which defeats the point of a merged inbox. */
function interleave(mailboxes, total){
  const queues = mailboxes.map(m => [...(m.messages || [])].sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0)));
  const out = [];
  for (let round = 0; out.length < total; round++) {
    let placed = false;
    for (const q of queues) {
      if (round >= q.length) continue;
      out.push(q[round]);
      placed = true;
      if (out.length >= total) break;
    }
    if (!placed) break;
  }
  return out;
}

/* Every connected mailbox, from both providers, merged into one Inbox.
   MAIL_SOURCE=outlook|gmail narrows it to a single provider. */
function mailbox(s, env){
  const pin = (env.MAIL_SOURCE || 'all').toLowerCase();
  const mailboxes = [];

  if (pin !== 'gmail' && s.microsoft.status === 'ok' && s.microsoft.data?.mail) {
    mailboxes.push(...s.microsoft.data.mail.mailboxes);
  }
  if (pin !== 'outlook' && s.gmail.status === 'ok' && s.gmail.data) {
    mailboxes.push(...(s.gmail.data.mailboxes || []));
  }
  if (!mailboxes.length) return null;

  const counts = mailboxes.reduce((a, m) => ({
    unreadMessages: a.unreadMessages + (m.counts.unreadMessages || 0),
    unreadThreads: a.unreadThreads + (m.counts.unreadThreads || 0),
    totalThreads: a.totalThreads + (m.counts.totalThreads || 0)
  }), { unreadMessages: 0, unreadThreads: 0, totalThreads: 0 });

  const total = Math.max(1, Number(env.INBOX_TOTAL) || 10);

  return {
    label: mailboxes.length === 1
      ? (mailboxes[0].account || mailboxes[0].label)
      : `${mailboxes.length} mailboxes`,
    mailboxes: mailboxes.map(m => ({ label: m.label, account: m.account, counts: m.counts })),
    counts,
    messages: interleave(mailboxes, total)
  };
}

/* One calendar from every connected account, both providers. */
function calendar(s, env){
  const events = [];
  const accounts = [];
  for (const key of ['microsoft', 'gmail']) {
    const d = s[key].status === 'ok' && s[key].data;
    if (!d?.events?.length) continue;
    events.push(...d.events);
    accounts.push(...(d.calendarAccounts || []));
  }
  if (!events.length) return null;
  return buildCalendar(events, {
    tz: env.AGENT_TIMEZONE || env.TIMEZONE || 'UTC',
    accounts: [...new Set(accounts.filter(Boolean))]
  });
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
  const cal = calendar(s, env);

  const payload = {
    source: ok === 0 ? 'unconfigured' : ok === SOURCES.length ? 'live' : 'partial',
    generatedAt: new Date().toISOString(),
    timezone: env.AGENT_TIMEZONE || env.TIMEZONE || 'UTC',
    sources: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { status: v.status, reason: v.reason || null }])),
    connections: connections(s),
    nav: {
      inbox: mail ? String(mail.counts.unreadThreads) : '',
      calendar: cal ? String(cal.today.length) : '',
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
      stats: stats(s, mail, cal),
      today: todayRows(s, cal),
      tasks: cu ? cu.rows : []
    },
    inbox: mail ? { label: mail.label, mailboxes: mail.mailboxes, counts: mail.counts, messages: mail.messages } : null,
    calendar: cal,
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
