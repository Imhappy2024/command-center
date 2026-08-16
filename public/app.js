/* Command Center — shell + data hydration.
   Static markup in index.html is the fallback; /api/data overrides it when reachable. */

const ICON = {
  overview:'<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z"/>',
  inbox:'<path d="M4 4h16v10h-5l-1.5 3h-3L9 14H4z"/><path d="M4 14v6h16v-6"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  tasks:'<path d="M4 6l2 2 4-4"/><path d="M4 14l2 2 4-4"/><path d="M13 7h7M13 15h7"/>',
  notes:'<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h7M9 16h5"/>',
  leads:'<path d="M9 11a3 3 0 100-6 3 3 0 000 6z"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M17 8h5M19.5 5.5v5"/>',
  properties:'<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  financial:'<path d="M4 19V9M9 19V5M14 19v-7M19 19V3"/>',
  social:'<circle cx="6" cy="12" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.6 10.6l6.8-3.2M8.6 13.4l6.8 3.2"/>',
  systems:'<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M19.1 4.9l-2.8 2.8M7.7 16.3l-2.8 2.8"/>',
  connections:'<path d="M9.5 14.5l5-5"/><path d="M13 7l1.5-1.5a3.5 3.5 0 015 5L18 12"/><path d="M11 17l-1.5 1.5a3.5 3.5 0 01-5-5L6 12"/>'
};

const MENU = [
  ['overview','Overview','All'],
  ['inbox','Inbox','Gmail'],
  ['calendar','Calendar','GCal'],
  ['tasks','Tasks','ClickUp'],
  ['notes','Notes','Vault'],
  ['leads','Leads','GHL'],
  ['properties','Properties','Postgres'],
  ['financial','Financial','Ledger'],
  ['social','Social','Channels'],
  ['systems','Systems','n8n'],
  ['connections','Connections','Setup']
];

const IDS = MENU.map(m => m[0]);
const $ = id => document.getElementById(id);

/* The OAuth callback returns to "#connections?connected=Google", so the view
   name is only the part before the query. */
const hashView = () => location.hash.slice(1).split('?')[0];

const ESCAPES = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESCAPES[c]);

const TONES = new Set(['brass','jade','rust']);
const tone = t => (TONES.has(t) ? ' ' + t : '');

function chip(c){
  if (!c || !c.text) return '';
  return '<span class="chip' + tone(c.tone) + '">' + esc(c.text) + '</span>';
}

/* ---------- nav + view switching ---------- */

function renderNav(badges){
  badges = badges || {};
  const current = hashView();
  const active = IDS.includes(current) ? current : IDS[0];

  $('nav').innerHTML = MENU.map(([id, label, src]) => {
    const on = id === active;
    const badge = badges[id];
    return '<button class="navitem' + (on ? ' on' : '') + '" role="tab" id="tab-' + id + '"'
      + ' data-view="' + id + '" aria-selected="' + on + '" aria-controls="v-' + id + '">'
      + '<span class="glyph"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[id] + '</svg></span>'
      + '<span class="label">' + esc(label) + '</span>'
      + (badge ? '<span class="badge">' + esc(badge) + '</span>' : '<span class="src">' + esc(src) + '</span>')
      + '</button>';
  }).join('');

  show(active, false);
}

function show(id, scroll){
  if (!IDS.includes(id)) return;
  document.querySelectorAll('.navitem').forEach(b => {
    const on = b.dataset.view === id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + id));
  if (hashView() !== id) history.replaceState(null, '', '#' + id);
  if (scroll !== false) window.scrollTo({ top: 0 });
  if (id === 'connections') renderConnections();
}

/* ---------- overview hydration ---------- */

function renderRail(list){
  if (!Array.isArray(list) || !list.length) return;
  $('conns').innerHTML = list.map(c =>
    '<div class="wire"' + (c.reason ? ' title="' + esc(c.reason) + '"' : '') + '>'
    + '<span class="dot ' + (['ok','warn','off'].includes(c.state) ? c.state : 'warn') + '"></span>'
    + '<span class="mono" style="color:var(--dim)">' + esc(c.label) + '</span></div>'
  ).join('');
}

function salutation(){
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function renderGreeting(g){
  if (!g) return;
  $('greet').textContent = g.name ? salutation() + ', ' + g.name : (g.title || 'Overview');
  $('greet-sub').textContent = g.sub || '';
}

function renderSync(source, generatedAt){
  const el = $('sync');
  if (source === 'unconfigured' || source === 'demo'){
    el.className = 'chip brass';
    el.textContent = source === 'demo' ? 'Demo data · no live sources' : 'No sources connected';
    return;
  }
  const t = generatedAt ? new Date(generatedAt) : null;
  const stamp = t && !isNaN(t)
    ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  el.className = source === 'partial' ? 'chip brass' : 'chip jade';
  el.textContent = (source === 'partial' ? 'Partial sync' : 'Synced')
    + (stamp ? ' · ' + stamp : '');
}

function renderHero(h){
  if (!h) return;
  $('hero-eyebrow').textContent = h.eyebrow || '';
  $('hero-value').textContent = h.value || '—';
  $('hero-sub').textContent = h.sub || '';
  const pct = Math.max(0, Math.min(100, Number(h.progressPct) || 0));
  $('hero-bar').style.width = pct + '%';
  $('hero-progress').textContent = h.progressLabel || '';
}

function renderAttention(items){
  $('attention').innerHTML = (items || []).map(a =>
    '<div><b style="color:var(--cream);font-size:13.5px">' + esc(a.title) + '</b>'
    + '<div style="font-size:12px;color:var(--dimmer);margin-top:3px">' + esc(a.detail) + '</div></div>'
  ).join('') || '<div style="font-size:12px;color:var(--dimmer)">Nothing urgent.</div>';
}

function renderStats(stats){
  $('ov-stats').innerHTML = (stats || []).map(s => {
    const cls = ['up','down','flat'].includes(s.tone) ? s.tone : 'flat';
    return '<div class="stat"><div class="eyebrow">' + esc(s.eyebrow) + '</div>'
      + '<div class="v num">' + esc(s.value) + '</div>'
      + '<div class="m"><span class="' + cls + '">' + esc(s.meta) + '</span></div></div>';
  }).join('');
}

function renderToday(events){
  $('ov-today').innerHTML = (events || []).map(e =>
    '<div class="row"><span class="time">' + esc(e.time) + '</span>'
    + '<span class="main"><b>' + esc(e.title) + '</b><small>' + esc(e.sub) + '</small></span>'
    + chip(e.chip) + '</div>'
  ).join('') || '<div class="row"><span class="main"><small>Nothing scheduled.</small></span></div>';
}

function renderTasks(tasks){
  $('ov-tasks').innerHTML = (tasks || []).map(t =>
    '<div class="row"><span class="check' + (t.done ? ' done' : '') + '" data-check></span>'
    + '<span class="main"><b>' + esc(t.title) + '</b><small>' + esc(t.sub) + '</small></span>'
    + chip(t.chip) + '</div>'
  ).join('') || '<div class="row"><span class="main"><small>Inbox zero on tasks.</small></span></div>';
}

/* ---------- inbox / tasks / systems views ---------- */

function statTile(s){
  const cls = ['up','down','flat'].includes(s.tone) ? s.tone : 'flat';
  return '<div class="stat"><div class="eyebrow">' + esc(s.eyebrow) + '</div>'
    + '<div class="v num">' + esc(s.value) + '</div>'
    + '<div class="m"><span class="' + cls + '">' + esc(s.meta) + '</span></div></div>';
}

function unavailable(el, msg){
  el.innerHTML = '<div class="row"><span class="main"><small>' + esc(msg) + '</small></span></div>';
}

const SOURCE_LABEL = { clickup: 'ClickUp', gmail: 'Gmail', n8n: 'n8n', microsoft: 'Outlook' };

/* A view whose source is set-but-erroring must not claim it is unconfigured —
   those need opposite fixes, and the error text is the only useful thing to show. */
function diagnose(sources, keys){
  const rows = keys.map(k => ({ key: k, label: SOURCE_LABEL[k] || k, ...(sources?.[k] || { status: 'unconfigured' }) }));
  return { failing: rows.filter(r => r.status === 'error'), rows };
}

function renderProblem(els, keys, sources, hint){
  const { failing } = diagnose(sources, keys);
  const bad = failing.length > 0;

  els.sub.textContent = bad
    ? 'Credentials are set, but the call failed.'
    : hint.sub;
  els.chip.className = bad ? 'chip rust' : 'chip brass';
  els.chip.textContent = bad ? 'Failing' : 'Not configured';
  if (els.stats) els.stats.innerHTML = '';

  els.body.innerHTML = bad
    ? failing.map(f =>
        '<div class="row"><span class="main"><b>' + esc(f.label) + ' is failing</b>'
        + '<small>' + esc(f.reason || 'no detail returned') + '</small></span>'
        + '<span class="chip rust">Error</span></div>'
      ).join('')
    : '<div class="row"><span class="main"><small>' + esc(hint.body) + '</small></span></div>';
  return bad;
}

function renderInbox(d, sources){
  if (!d) {
    renderProblem(
      { sub: $('inbox-sub'), chip: $('inbox-chip'), stats: $('inbox-stats'), body: $('inbox-rows') },
      ['microsoft', 'gmail'], sources,
      { sub: 'No mailbox is connected.', body: 'Set the MS_* variables for Outlook, or the GOOGLE_* variables for Gmail.' }
    );
    $('inbox-count').textContent = '—';
    return;
  }
  const c = d.counts;
  const src = d.label || 'Mail';
  $('inbox-sub').textContent = c.unreadThreads.toLocaleString() + ' unread out of '
    + c.totalThreads.toLocaleString() + ' in the ' + src + ' inbox.';
  $('inbox-chip').className = 'chip jade';
  $('inbox-chip').textContent = src + ' live';
  $('inbox-stats').innerHTML = [
    { eyebrow: 'Unread', value: c.unreadThreads.toLocaleString(), meta: 'in inbox', tone: 'flat' },
    { eyebrow: 'Unread messages', value: c.unreadMessages.toLocaleString(), meta: 'individual mails', tone: 'flat' },
    { eyebrow: 'Inbox total', value: c.totalThreads.toLocaleString(), meta: 'all items', tone: 'flat' },
    { eyebrow: 'Read', value: Math.max(0, c.totalThreads - c.unreadThreads).toLocaleString(), meta: 'cleared', tone: 'up' }
  ].map(statTile).join('');
  $('inbox-count').textContent = d.messages.length + ' shown';
  $('inbox-rows').innerHTML = d.messages.map(m =>
    '<div class="row unread"><span class="main"><b>' + esc(m.from) + ' · ' + esc(m.subject) + '</b>'
    + '<small>' + esc(m.snippet.slice(0, 110)) + '</small></span>'
    + '<span class="right">' + esc(m.at) + '</span></div>'
  ).join('') || '<div class="row"><span class="main"><small>Inbox zero.</small></span></div>';
}

function renderTasksView(d, sources){
  if (!d) {
    $('tasks-groups').innerHTML = '<div class="card flush"><div class="cardbody" id="tasks-problem"></div></div>';
    renderProblem(
      { sub: $('tasks-sub'), chip: $('tasks-chip'), stats: $('tasks-stats'), body: $('tasks-problem') },
      ['clickup'], sources,
      { sub: 'ClickUp is not connected.', body: 'Set CLICKUP_TOKEN.' }
    );
    return;
  }
  const c = d.counts;
  $('tasks-sub').textContent = c.total + ' open tasks assigned to you, due today or earlier.';
  $('tasks-chip').className = 'chip jade';
  $('tasks-chip').textContent = 'ClickUp live';
  $('tasks-stats').innerHTML = [
    { eyebrow: 'Due today', value: String(c.dueToday), meta: 'not yet late', tone: c.dueToday ? 'flat' : 'up' },
    { eyebrow: 'Overdue', value: String(c.overdue), meta: c.overdue ? 'past due date' : 'all clear', tone: c.overdue ? 'down' : 'up' },
    { eyebrow: 'Total open', value: String(c.total), meta: 'assigned to you', tone: 'flat' },
    { eyebrow: 'Spaces', value: String(d.groups.length), meta: 'carrying work', tone: 'flat' }
  ].map(statTile).join('');
  $('tasks-groups').innerHTML = d.groups.map(g =>
    '<div class="card flush"><div class="cardhead"><h3>' + esc(g.name) + '</h3>'
    + '<span class="eyebrow">' + g.count + ' open</span></div><div class="cardbody">'
    + g.tasks.map(t =>
        '<div class="row"><span class="check" data-check></span>'
        + '<span class="main"><b>' + esc(t.title) + '</b><small>' + esc(t.sub) + '</small></span></div>'
      ).join('')
    + '</div></div>'
  ).join('') || '<div class="card"><small style="color:var(--dimmer)">Nothing open.</small></div>';
}

function renderCalendar(d, sources){
  if (!d) {
    const bad = renderProblem(
      { sub: $('cal-sub'), chip: $('cal-chip'), body: $('cal-today') },
      ['microsoft'], sources,
      { sub: 'Outlook is not connected.', body: 'Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MS_SERVICE_USER.' }
    );
    $('cal-week').innerHTML = '';
    $('cal-today-meta').textContent = '—';
    unavailable($('cal-blocks'), bad ? 'Free/busy is unavailable while the calendar call is failing.' : 'Free/busy needs the calendar connected.');
    return;
  }

  $('cal-sub').textContent = d.weekCount + ' event' + (d.weekCount === 1 ? '' : 's')
    + ' this week · times in ' + d.timezone;
  $('cal-chip').className = 'chip jade';
  $('cal-chip').textContent = 'Outlook live';

  $('cal-week').innerHTML = d.week.map(w =>
    '<div class="day' + (w.today ? ' today' : '') + '">'
    + '<div class="dn">' + esc(w.day) + '</div>'
    + '<div class="dd num">' + w.date + '</div>'
    + '<div class="ct">' + esc(w.label) + '</div></div>'
  ).join('');

  const h = Math.floor(d.bookedMins / 60), m = d.bookedMins % 60;
  const today = d.week.find(w => w.today);
  $('cal-today-title').textContent = today ? today.day + ' ' + today.date : 'Today';
  $('cal-today-meta').textContent = d.today.length + ' event' + (d.today.length === 1 ? '' : 's')
    + (d.bookedMins ? ` · ${h}h${m ? String(m).padStart(2,'0') : ''} booked` : ' · nothing booked');

  $('cal-today').innerHTML = d.today.map(e =>
    '<div class="row"><span class="time">' + esc(e.time) + '</span>'
    + '<span class="main"><b>' + esc(e.title) + '</b><small>' + esc(e.sub) + '</small></span>'
    + chip(e.chip) + '</div>'
  ).join('') || '<div class="row"><span class="main"><small>Nothing scheduled today.</small></span></div>';

  $('cal-blocks').innerHTML = d.blocks.map(b =>
    '<div class="row"><span class="time">' + esc(b.day) + '</span>'
    + '<span class="main"><b>' + esc(b.range) + '</b><small>' + esc(b.note) + '</small></span>'
    + chip(b.chip) + '</div>'
  ).join('') || '<div class="row"><span class="main"><small>No open blocks left this week.</small></span></div>';
}

function renderSystems(d, sources){
  if (!d) {
    renderProblem(
      { sub: $('sys-sub'), chip: $('sys-chip'), stats: $('sys-stats'), body: $('sys-rows') },
      ['n8n'], sources,
      { sub: 'n8n is not connected.', body: 'Set N8N_BASE_URL and N8N_API_KEY.' }
    );
    return;
  }
  const c = d.counts;
  $('sys-sub').textContent = c.active + ' of ' + c.total + ' workflows active · '
    + c.runs24h + (c.capped ? '+' : '') + ' runs in the last 24h.';
  $('sys-chip').className = 'chip jade';
  $('sys-chip').textContent = 'n8n live';
  $('sys-stats').innerHTML = [
    { eyebrow: 'Active workflows', value: String(c.active), meta: c.inactive + ' inactive', tone: 'flat' },
    { eyebrow: 'Runs · 24h', value: c.runs24h.toLocaleString() + (c.capped ? '+' : ''), meta: c.capped ? 'sample capped at 250' : 'complete', tone: 'flat' },
    { eyebrow: 'Failures · 24h', value: String(c.failures24h), meta: c.errorRate + '% error rate', tone: c.failures24h ? 'down' : 'up' },
    { eyebrow: 'Total workflows', value: String(c.total), meta: 'in this instance', tone: 'flat' }
  ].map(statTile).join('');
  $('sys-rows').innerHTML = d.rows.map(r =>
    '<div class="sys"><span class="dot ' + (['ok','warn','off'].includes(r.state) ? r.state : 'warn') + '"></span>'
    + '<span class="name"><b>' + esc(r.name) + '</b><small>' + esc(r.detail) + '</small></span>'
    + '<span class="spark">' + (r.spark || []).map(b =>
        '<i class="' + (b.failed ? 'f' : '') + '" style="height:' + Math.max(4, Math.min(100, b.height)) + '%"></i>'
      ).join('') + '</span>'
    + chip(r.chip) + '</div>'
  ).join('') || '<div class="row"><span class="main"><small>No workflows.</small></span></div>';
}

/* ---------- connections ---------- */

function connBanner(){
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if (q.get('connected')) return { cls: 'ok', text: q.get('connected') + ' connected. The views it feeds will fill in on the next refresh.' };
  if (q.get('error')) return { cls: 'bad', text: q.get('error') };
  return null;
}

async function renderConnections(){
  const list = $('conn-list');
  const banner = $('conn-banner');

  const note = connBanner();
  banner.innerHTML = note ? '<div class="banner ' + note.cls + '">' + esc(note.text) + '</div>' : '';
  if (note) history.replaceState(null, '', '#connections');

  let d;
  try {
    const res = await fetch('/api/connections', { cache: 'no-store' });
    if (res.status === 401) { location.href = '/login'; return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    d = await res.json();
  } catch (err) {
    unavailable(list, 'Could not load connection state: ' + err.message);
    return;
  }

  if (!d.loginRequired) {
    banner.innerHTML += '<div class="banner bad">Connecting is disabled because this dashboard has no password. '
      + 'Anyone with the URL could connect an account, or read the mail of one already connected. '
      + 'Set APP_PASSWORD in Railway and redeploy.</div>';
  } else if (!d.persistent) {
    banner.innerHTML += '<div class="banner warn">DATA_DIR is not set, so connections live on the container filesystem '
      + 'and are lost on redeploy. Attach a Railway volume and point DATA_DIR at it to keep them.</div>';
  }

  list.innerHTML = d.providers.map(p => {
    let action, status;
    if (!p.configured) {
      action = '<span class="btn" aria-disabled="true">Unavailable</span>';
      status = '<small>' + esc(p.setupHint) + '</small>';
    } else if (p.connected) {
      action = '<button class="btn quiet" data-disconnect="' + esc(p.name) + '">Disconnect</button>';
      status = '<small>Connected' + (p.account ? ' as ' + esc(p.account) : '') + ' · feeds ' + esc(p.feeds.join(', ')) + '</small>';
    } else {
      action = '<a class="btn primary" href="/connect/' + esc(p.name) + '">Connect</a>';
      status = '<small>' + esc(p.detail) + '</small>';
    }
    return '<div class="conn">'
      + '<span class="dot ' + (p.connected ? 'ok' : p.configured ? 'warn' : 'off') + '"></span>'
      + '<span class="who"><b>' + esc(p.label) + '</b>' + status
      + (p.configured && !p.connected ? '<small style="margin-top:6px">Redirect URI: <code>' + esc(p.redirectUri) + '</code></small>' : '')
      + '</span>'
      + (d.canConnect ? action : '<span class="btn" aria-disabled="true">Locked</span>')
      + '</div>';
  }).join('');
}

async function disconnect(name){
  const res = await fetch('/api/disconnect/' + encodeURIComponent(name), { method: 'POST' });
  if (res.status === 401) { location.href = '/login'; return; }
  await renderConnections();
  hydrate();
}

/* ---------- boot ---------- */

async function hydrate(){
  let d;
  try {
    const res = await fetch('/api/data', { cache: 'no-store' });
    if (res.status === 401) { location.href = '/login'; return; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    d = await res.json();
  } catch (err) {
    console.warn('[command-center] /api/data unavailable, keeping static markup:', err.message);
    const el = $('sync');
    el.className = 'chip rust';
    el.textContent = 'Data source unreachable';
    renderNav({});
    return;
  }

  renderNav(d.nav);
  renderRail(d.connections);
  renderSync(d.source, d.generatedAt);

  const ov = d.overview || {};
  renderGreeting(ov.greeting);
  renderHero(ov.hero);
  renderAttention(ov.attention);
  renderStats(ov.stats);
  renderToday(ov.today);
  renderTasks(ov.tasks);

  const st = d.sources || {};
  $('today-src').textContent = st.microsoft?.status === 'ok' ? 'Outlook · live' : 'Calendar · not connected';
  $('tasks-src').textContent = st.clickup?.status === 'ok' ? 'ClickUp · live' : 'ClickUp · not connected';

  renderInbox(d.inbox, st);
  renderCalendar(d.calendar, st);
  renderTasksView(d.tasks, st);
  renderSystems(d.systems, st);
}

document.addEventListener('click', e => {
  const item = e.target.closest('.navitem');
  if (item) { show(item.dataset.view); return; }
  const off = e.target.closest('[data-disconnect]');
  if (off) { e.preventDefault(); disconnect(off.dataset.disconnect); return; }
  const box = e.target.closest('[data-check]');
  if (box) box.classList.toggle('done');
});

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k'){
    e.preventDefault();
    $('cmd').focus();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...document.querySelectorAll('.navitem')];
  const i = items.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
  next.focus();
  show(next.dataset.view);
});

window.addEventListener('hashchange', () => show(hashView()));

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function tick(){
  const d = new Date();
  $('clk').textContent = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  $('dte').textContent = DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONS[d.getMonth()] + ' ' + d.getFullYear();
}
tick();
setInterval(tick, 15000);

renderNav({});
hydrate();
setInterval(hydrate, 5 * 60 * 1000);
