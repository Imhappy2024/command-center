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
  systems:'<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M19.1 4.9l-2.8 2.8M7.7 16.3l-2.8 2.8"/>'
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
  ['systems','Systems','n8n']
];

const IDS = MENU.map(m => m[0]);
const $ = id => document.getElementById(id);

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
  const current = location.hash.slice(1);
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
  if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
  if (scroll !== false) window.scrollTo({ top: 0 });
}

/* ---------- overview hydration ---------- */

function renderConnections(list){
  if (!Array.isArray(list) || !list.length) return;
  $('conns').innerHTML = list.map(c =>
    '<div class="wire"><span class="dot ' + (['ok','warn','off'].includes(c.state) ? c.state : 'warn') + '"></span>'
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
  if (source === 'demo'){
    el.className = 'chip brass';
    el.textContent = 'Demo data · no live sources';
    return;
  }
  const t = generatedAt ? new Date(generatedAt) : null;
  el.className = 'chip jade';
  el.textContent = t && !isNaN(t)
    ? 'Synced ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'Synced';
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

/* ---------- boot ---------- */

async function hydrate(){
  let d;
  try {
    const res = await fetch('/api/data', { cache: 'no-store' });
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
  renderConnections(d.connections);
  renderSync(d.source, d.generatedAt);

  const ov = d.overview || {};
  renderGreeting(ov.greeting);
  renderHero(ov.hero);
  renderAttention(ov.attention);
  renderStats(ov.stats);
  renderToday(ov.today);
  renderTasks(ov.tasks);
}

document.addEventListener('click', e => {
  const item = e.target.closest('.navitem');
  if (item) { show(item.dataset.view); return; }
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

window.addEventListener('hashchange', () => show(location.hash.slice(1)));

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
