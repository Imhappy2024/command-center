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

/* The OAuth callback returns to "#inbox?connected=you@example.com", so the view
   name is only the part before the query. Read the result once at load, before
   routing strips it off the URL. */
const hashView = () => location.hash.slice(1).split('?')[0];
const FLASH = new URLSearchParams(location.hash.split('?')[1] || '');

/* Connection state, shared by the Connections view and the inline buttons. */
let CONN = null;
let ENVCHK = null;

async function loadConnections(){
  try {
    const res = await fetch('/api/connections', { cache: 'no-store' });
    if (res.status === 401) { location.href = '/login'; return null; }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    CONN = await res.json();
  } catch (err) {
    console.warn('[command-center] /api/connections unavailable:', err.message);
    CONN = null;
  }

  // Only worth asking when something is stopping us connecting.
  if (CONN && !CONN.canConnect && !ENVCHK) {
    try {
      const r = await fetch('/api/env-check', { cache: 'no-store' });
      if (r.ok) ENVCHK = await r.json();
    } catch { /* diagnostic only */ }
  }
  return CONN;
}

/* Turns "but I added it" into a fact about what the process received. */
function envReport(names){
  if (!ENVCHK) return '';
  const rows = names.map(n => {
    const v = ENVCHK.vars[n] || {};
    const state = v.set ? 'ok' : v.present ? 'warn' : 'off';
    const note = v.set ? 'received' : v.present ? 'defined but empty' : 'not received';
    return '<div class="wire" style="font-size:12px;margin-top:4px">'
      + '<span class="dot ' + state + '"></span>'
      + '<span class="mono">' + esc(n) + '</span>'
      + '<span style="color:var(--dimmer)">' + note + '</span></div>';
  }).join('');

  const near = (ENVCHK.lookalikes || []).length
    ? '<div style="margin-top:8px;font-size:12px;color:var(--dimmer)">Other variables this service received: '
      + '<span class="mono">' + esc(ENVCHK.lookalikes.join(', ')) + '</span></div>'
    : '';

  return '<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--edge2)">'
    + '<div class="eyebrow" style="margin-bottom:4px">What this server process actually received</div>'
    + rows + near + '</div>';
}

function renderFlash(){
  const el = $('flash');
  if (!el) return;
  if (FLASH.get('connected')) {
    el.innerHTML = '<div class="banner ok">Connected as ' + esc(FLASH.get('connected'))
      + '. Pulling the first data now — this panel fills in within a few seconds.</div>';
  } else if (FLASH.get('error')) {
    el.innerHTML = '<div class="banner bad">' + esc(FLASH.get('error')) + '</div>';
  }
}

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

/* ---------- mail: read, compose, act ---------- */

let MAILBOXES = [];      // connected mailboxes, for the From picker and strip
let MESSAGES = [];       // merged list from the last payload
let OPEN_MSG = null;     // message loaded in the reader
let OPEN_REF = null;     // which row that was
const ARCHIVED = new Set();   // archived this session, so the filter has something to show

const MAIL_VIEW = { account: 'all', filter: 'all', search: '' };

const sheet = (id, on) => $(id).classList.toggle('on', on);
const key = m => `${m.provider}:${m.accountId}:${m.id}`;

/* Stable per-account colour, so a mailbox keeps its stripe between renders. */
function accountColour(id){
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 52% 62%)`;
}

const initials = value => String(value || '?')
  .replace(/[<>"]/g, '').trim().split(/[\s.@_-]+/).filter(Boolean)
  .slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';

/* Heuristic, not a provider signal: unread and not obviously automated. */
const NO_REPLY = /no-?reply|do-?not-?reply|notification|newsletter|mailer-daemon|postmaster|automated|noreply/i;
const needsReply = m => m.unread && !NO_REPLY.test(`${m.fromAddress || ''} ${m.from || ''}`);

async function api(path, init){
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) }
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('signed out'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function readerEmpty(title, note){
  $('ib-reader').innerHTML = '<div class="empty"><b>' + esc(title) + '</b>'
    + (note ? '<small>' + esc(note) + '</small>' : '') + '</div>';
}

/* Remote HTML goes in a sandboxed iframe rather than being injected: mail is
   hostile input, and a srcdoc frame without allow-scripts cannot run any of it. */
function bodyHtml(msg){
  if (!msg.html) return '<div class="rbody">' + esc(msg.text || '(no body)') + '</div>';
  return '<div class="rbody html"><iframe sandbox="" referrerpolicy="no-referrer" '
    + 'srcdoc="' + esc(msg.html) + '"></iframe></div>';
}

function paintReader(msg, ref){
  const colour = accountColour(ref.accountId);
  $('ib-reader').innerHTML =
    '<div class="rhead"><h2>' + esc(msg.subject) + '</h2>'
    + '<div class="rmeta">'
    + '<span class="msg" style="display:inline-flex;padding:0;border:0;background:none;grid-template-columns:none">'
    + '<span class="av" style="--c:' + colour + '">' + esc(initials(msg.from)) + '</span></span>'
    + '<span><b style="color:var(--text)">' + esc(msg.from) + '</b>'
    + (msg.date ? ' · ' + esc(String(msg.date).slice(0, 25)) : '') + '</span>'
    + '<span class="chip" style="--c:' + colour + '">' + esc(ref.accountId) + '</span>'
    + '</div>'
    + '<div class="rmeta" style="margin-top:6px"><span>To ' + esc(msg.to || '—') + '</span>'
    + (msg.cc ? '<span>Cc ' + esc(msg.cc) + '</span>' : '') + '</div></div>'
    + '<div class="ractions">'
    + '<button class="btn primary" id="read-reply">Reply</button>'
    + '<button class="btn" data-msg-action="unread">Mark unread</button>'
    + '<button class="btn" data-msg-action="' + (msg.starred ? 'unstar' : 'star') + '">'
    + (msg.starred ? 'Unstar' : 'Star') + '</button>'
    + '<button class="btn" data-msg-action="archive">Archive</button>'
    + '<button class="btn" data-msg-action="trash">Trash</button>'
    + '</div>'
    + bodyHtml(msg);
}

async function openMessage(ref){
  OPEN_MSG = null;
  OPEN_REF = ref;
  readerEmpty('Loading…');
  document.querySelectorAll('.msg').forEach(el =>
    el.classList.toggle('on', el.dataset.key === `${ref.provider}:${ref.accountId}:${ref.id}`));

  try {
    const msg = await api(`/api/message/${encodeURIComponent(ref.provider)}/`
      + `${encodeURIComponent(ref.accountId)}/${encodeURIComponent(ref.id)}`);
    OPEN_MSG = { ...msg, provider: ref.provider, accountId: ref.accountId };
    paintReader(OPEN_MSG, ref);

    // Opening it is reading it — reflect that locally without a full refetch.
    if (msg.unread) {
      messageAction('read', true).catch(() => {});
      const local = MESSAGES.find(m => key(m) === key(ref));
      if (local) local.unread = false;
      document.querySelector(`.msg[data-key="${CSS.escape(key(ref))}"]`)?.classList.remove('unread');
      renderAccountStrip();
    }
  } catch (err) {
    readerEmpty('Could not open message', err.message);
  }
}

async function messageAction(action, quiet){
  if (!OPEN_MSG) return;
  const { provider, accountId, id } = OPEN_MSG;
  try {
    await api('/api/mail/action', {
      method: 'POST',
      body: JSON.stringify({ provider, accountId, id, action })
    });
    if (quiet) return;

    if (action === 'star' || action === 'unstar') {
      OPEN_MSG.starred = action === 'star';
      const local = MESSAGES.find(m => key(m) === key(OPEN_MSG));
      if (local) local.starred = OPEN_MSG.starred;
      paintReader(OPEN_MSG, OPEN_REF);
      renderMailList();
      return;
    }
    if (action === 'archive' || action === 'trash') ARCHIVED.add(key(OPEN_MSG));
    readerEmpty(action === 'trash' ? 'Moved to trash' : action === 'archive' ? 'Archived' : 'Marked unread');
    hydrate();
  } catch (err) {
    readerEmpty('Action failed', err.message);
  }
}

function fromOptions(preferId){
  const sel = $('compose-from');
  sel.innerHTML = MAILBOXES.map(m =>
    '<option value="' + esc(m.provider + '|' + m.accountId) + '"'
    + (m.accountId === preferId ? ' selected' : '') + '>'
    + esc(m.account || m.label) + ' · ' + esc(m.label) + '</option>'
  ).join('');
  return MAILBOXES.length > 0;
}

function openComposer(prefill = {}){
  if (!fromOptions(prefill.accountId)) return;
  $('compose-title').textContent = prefill.title || 'New message';
  $('compose-to').value = prefill.to || '';
  $('compose-cc').value = '';
  $('compose-subject').value = prefill.subject || '';
  $('compose-body').value = prefill.body || '';
  $('compose-status').textContent = '';
  sheet('composer', true);
  $((prefill.to ? 'compose-body' : 'compose-to')).focus();
}

function replyToOpen(){
  if (!OPEN_MSG) return;
  const m = OPEN_MSG;
  const quoted = (m.text || '').split('\n').map(l => '> ' + l).join('\n');
  sheet('reader', false);
  openComposer({
    title: 'Reply',
    accountId: m.accountId,
    to: m.from,
    subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject,
    body: '\n\n' + (m.date ? `On ${m.date}, ${m.from} wrote:\n` : '') + quoted,
    replyToId: m.id
  });
  COMPOSE_REPLY = { replyToId: m.id, threadId: m.threadId, messageId: m.messageId, references: m.references };
}

let COMPOSE_REPLY = null;

async function submitCompose(kind){
  const [provider, accountId] = String($('compose-from').value || '').split('|');
  const status = $('compose-status');
  status.textContent = kind === 'send' ? 'Sending…' : 'Saving…';

  const payload = {
    provider,
    accountId,
    to: $('compose-to').value.trim(),
    cc: $('compose-cc').value.trim(),
    subject: $('compose-subject').value.trim(),
    body: $('compose-body').value,
    ...(COMPOSE_REPLY && kind === 'send' ? {
      replyToId: COMPOSE_REPLY.replyToId,
      threadId: COMPOSE_REPLY.threadId,
      inReplyTo: COMPOSE_REPLY.messageId,
      references: [COMPOSE_REPLY.references, COMPOSE_REPLY.messageId].filter(Boolean).join(' ')
    } : {})
  };

  try {
    await api(kind === 'send' ? '/api/mail/send' : '/api/mail/draft', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    status.textContent = kind === 'send' ? 'Sent.' : 'Saved to drafts.';
    COMPOSE_REPLY = null;
    setTimeout(() => { sheet('composer', false); hydrate(); }, 700);
  } catch (err) {
    status.textContent = err.message;
  }
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

/* Connect buttons rendered inline, so the fix sits where the gap shows up
   rather than only on the Connections page. */
function connectStrip(providerNames, from){
  if (!CONN) return '';

  const wanted = CONN.providers.filter(p => providerNames.includes(p.name) && !p.connected);
  if (!wanted.length) return '';

  if (!CONN.canConnect) {
    return '<div style="padding:16px 18px"><div class="banner bad">'
      + '<b style="display:block;margin-bottom:6px;font-size:14px">Cannot store credentials</b>'
      + 'The token store has no encryption key, so a connection could not be saved. This normally '
      + 'resolves itself — a key is generated under <span class="mono">DATA_DIR</span> on boot.'
      + envReport(['DATA_DIR', 'ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
      + '</div></div>';
  }

  return wanted.map(p =>
    '<div class="conn"><span class="dot ' + (p.configured ? 'warn' : 'off') + '"></span>'
    + '<span class="who"><b>' + esc(p.label) + '</b><small>'
    + esc(p.configured ? p.detail : p.setupHint) + '</small></span>'
    + (p.configured
        ? '<a class="btn primary" href="/connect/' + esc(p.name) + '?return=' + esc(from) + '">Connect ' + esc(p.label) + '</a>'
        : '<span class="btn" aria-disabled="true">Unavailable</span>')
    + '</div>'
  ).join('');
}

/* Header action, so adding a second account never means scrolling past a
   screenful of email to find it. */
function headerConnect(el, from, verb){
  if (!el) return;
  const open = CONN?.canConnect ? CONN.providers.filter(p => p.configured) : [];
  el.innerHTML = open.map(p =>
    '<a class="btn primary" href="/connect/' + esc(p.name) + '?return=' + esc(from) + '">'
    + esc(verb) + ' ' + esc(p.label) + '</a>'
  ).join('');
}

function renderProblem(els, keys, sources, hint){
  const { failing } = diagnose(sources, keys);
  const bad = failing.length > 0;
  const strip = hint.connect ? connectStrip(hint.connect, hint.from) : '';

  els.sub.textContent = bad ? 'Credentials are set, but the call failed.' : hint.sub;
  els.chip.className = bad ? 'chip rust' : 'chip brass';
  els.chip.textContent = bad ? 'Failing' : 'Not connected';
  if (els.stats) els.stats.innerHTML = '';

  const detail = bad
    ? failing.map(f =>
        '<div class="row"><span class="main"><b>' + esc(f.label) + ' is failing</b>'
        + '<small>' + esc(f.reason || 'no detail returned') + '</small></span>'
        + '<span class="chip rust">Error</span></div>'
      ).join('')
    : '';

  els.body.innerHTML = strip
    ? strip + detail
    : detail || '<div class="row"><span class="main"><small>' + esc(hint.body) + '</small></span></div>';
  return bad;
}

function renderAccountStrip(){
  const strip = $('ib-accts');
  const total = MESSAGES.filter(m => m.unread).length;

  const tile = (id, label, sub, count, colour, on, dead) =>
    '<button class="acct' + (on ? ' on' : '') + (dead ? ' dead' : '') + '" data-acct="' + esc(id) + '">'
    + '<span class="swatch" style="--c:' + colour + '"></span>'
    + '<span class="who"><b>' + esc(label) + '</b><small>' + esc(sub) + '</small></span>'
    + '<span class="n">' + (count || '') + '</span></button>';

  strip.innerHTML =
    tile('all', 'All inboxes', MAILBOXES.length + ' connected', total, 'var(--cream)', MAIL_VIEW.account === 'all')
    + MAILBOXES.map(m => tile(
        m.accountId,
        m.account || m.label,
        m.label,
        m.counts?.unreadThreads || 0,
        accountColour(m.accountId),
        MAIL_VIEW.account === m.accountId
      )).join('')
    + '<button class="acct addbtn" id="ib-addacct"><span class="who"><b>+ Add</b>'
    + '<small>another mailbox</small></span></button>';
}

function visibleMessages(){
  const q = MAIL_VIEW.search.trim().toLowerCase();
  return MESSAGES.filter(m => {
    if (MAIL_VIEW.account !== 'all' && m.accountId !== MAIL_VIEW.account) return false;

    const archived = ARCHIVED.has(key(m));
    if (MAIL_VIEW.filter === 'archived') { if (!archived) return false; }
    else if (archived) return false;

    if (MAIL_VIEW.filter === 'unread' && !m.unread) return false;
    if (MAIL_VIEW.filter === 'starred' && !m.starred) return false;
    if (MAIL_VIEW.filter === 'reply' && !needsReply(m)) return false;

    if (q && !`${m.from} ${m.fromAddress || ''} ${m.subject} ${m.snippet}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

const FILTER_EMPTY = {
  all: ['Nothing here', 'This mailbox has no messages in the current pull.'],
  unread: ['No unread mail', 'Everything in the current pull has been read.'],
  reply: ['Nothing waiting on you', 'Unread mail from a real person, excluding no-reply and notification senders.'],
  starred: ['Nothing starred', 'Star a message from the reader and it shows up here.'],
  archived: ['Nothing archived yet', 'Messages you archive in this session appear here. A full archive view needs a separate fetch, which is not built.']
};

function renderMailList(){
  const list = visibleMessages();
  const acct = MAIL_VIEW.account === 'all'
    ? 'All inboxes'
    : (MAILBOXES.find(m => m.accountId === MAIL_VIEW.account)?.account || MAIL_VIEW.account);

  $('ib-listtitle').textContent = acct;
  $('ib-listcount').textContent = list.length
    ? `${list.length} of ${MESSAGES.length}`
    : 'none';

  if (!list.length) {
    const [title, note] = FILTER_EMPTY[MAIL_VIEW.filter] || FILTER_EMPTY.all;
    $('ib-list').innerHTML = '<div class="empty"><b>' + esc(MAIL_VIEW.search ? 'No matches' : title) + '</b>'
      + '<small>' + esc(MAIL_VIEW.search ? 'Nothing in the current pull matches that search.' : note) + '</small></div>';
    return;
  }

  $('ib-list').innerHTML = list.map(m => {
    const colour = accountColour(m.accountId);
    const k = key(m);
    return '<div class="msg' + (m.unread ? ' unread' : '') + (ARCHIVED.has(k) ? ' archived' : '')
      + (OPEN_REF && key(OPEN_REF) === k ? ' on' : '') + '" data-key="' + esc(k) + '"'
      + ' data-provider="' + esc(m.provider) + '" data-account="' + esc(m.accountId) + '"'
      + ' data-id="' + esc(m.id) + '" tabindex="0" role="button">'
      + '<span class="stripe" style="--c:' + colour + '"></span>'
      + '<span class="av" style="--c:' + colour + '">' + esc(initials(m.from)) + '</span>'
      + '<span class="txt"><b>' + esc(m.from) + '</b>'
      + '<span class="subj">' + esc(m.subject) + '</span>'
      + '<span class="snip">' + esc(m.snippet.slice(0, 120)) + '</span></span>'
      + '<span class="meta"><span class="tm">' + esc(m.at) + '</span>'
      + '<button class="star' + (m.starred ? ' on' : '') + '" data-star="' + esc(k) + '"'
      + ' aria-label="' + (m.starred ? 'Unstar' : 'Star') + '">' + (m.starred ? '★' : '☆') + '</button>'
      + '</span></div>';
  }).join('');
}

function renderConnectSheet(){
  const provs = CONN?.providers || [];
  $('ib-provs').innerHTML = provs.map(p => {
    const icon = p.name === 'google' ? 'G' : 'M';
    const tint = p.name === 'google' ? '#D9A441' : '#5B8DEF';
    const ready = p.configured && CONN.canConnect;
    return '<button class="prov" data-prov="' + esc(p.name) + '"'
      + (ready ? '' : ' aria-disabled="true"') + '>'
      + '<span class="pv-ic" style="--pv:' + tint + '">' + icon + '</span>'
      + '<span class="pv-t"><b>' + esc(p.label) + '</b><small>'
      + esc(ready ? p.detail : p.setupHint) + '</small></span>'
      + '<span class="chip">' + (ready ? 'OAuth' : 'Setup') + '</span></button>';
  }).join('')
  + '<button class="prov" aria-disabled="true"><span class="pv-ic" style="--pv:#4E9E7E">@</span>'
  + '<span class="pv-t"><b>Other (IMAP)</b><small>Not built — no IMAP client in this app yet</small></span>'
  + '<span class="chip">N/A</span></button>';

  $('ib-note').textContent = CONN?.publicUrlWarning
    ? 'This dashboard has no password, so anyone with the URL can read the mailboxes you connect. Set APP_PASSWORD to add a login.'
    : 'Connecting opens the provider’s own sign-in. Tokens are encrypted and stored server-side.';
}

function renderInbox(d, sources){
  MAILBOXES = (d?.mailboxes || []).filter(m => m.provider && m.accountId);
  MESSAGES = d?.messages || [];
  $('compose-btn').hidden = MAILBOXES.length === 0;

  if (MAIL_VIEW.account !== 'all' && !MAILBOXES.some(m => m.accountId === MAIL_VIEW.account)) {
    MAIL_VIEW.account = 'all';
  }

  if (!d) {
    const { failing } = diagnose(sources, ['microsoft', 'gmail']);
    $('inbox-sub').textContent = failing.length
      ? 'Credentials are set, but the call failed.'
      : 'No mailbox connected yet.';
    $('inbox-chip').className = failing.length ? 'chip rust' : 'chip brass';
    $('inbox-chip').textContent = failing.length ? 'Failing' : 'Not connected';
    $('ib-accts').innerHTML = '<button class="acct addbtn" id="ib-addacct">'
      + '<span class="who"><b>+ Connect a mailbox</b><small>Google or Microsoft</small></span></button>';
    $('ib-listtitle').textContent = 'No mailboxes';
    $('ib-listcount').textContent = '—';
    $('ib-list').innerHTML = '<div class="empty"><b>Nothing connected</b>'
      + '<small>Use Connect new email above. You sign in on the provider’s page.</small></div>'
      + (failing.length ? failing.map(f =>
          '<div class="row"><span class="main"><b>' + esc(f.label) + ' is failing</b><small>'
          + esc(f.reason || '') + '</small></span><span class="chip rust">Error</span></div>').join('') : '');
    readerEmpty('No message selected', 'Connect a mailbox to start reading.');
    return;
  }
  const c = d.counts;
  const many = MAILBOXES.length > 1;

  $('inbox-sub').textContent = c.unreadThreads.toLocaleString() + ' unread of '
    + c.totalThreads.toLocaleString()
    + (many ? ` across ${MAILBOXES.length} mailboxes` : ' in ' + (d.label || 'the inbox'))
    + ` · showing the newest ${MESSAGES.length}`;
  $('inbox-chip').className = 'chip jade';
  $('inbox-chip').textContent = many ? MAILBOXES.length + ' mailboxes live' : (d.label || 'Mail') + ' live';

  renderAccountStrip();
  renderMailList();
  if (!OPEN_MSG) readerEmpty('No message selected', 'Pick anything on the left to read it here.');
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
  headerConnect($('cal-connect'), 'calendar', d ? 'Add' : 'Connect');
  if (!d) {
    const bad = renderProblem(
      { sub: $('cal-sub'), chip: $('cal-chip'), body: $('cal-today') },
      ['microsoft'], sources,
      {
        sub: 'No calendar connected yet.',
        body: 'Set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MS_SERVICE_USER.',
        connect: ['microsoft'],
        from: 'calendar'
      }
    );
    $('cal-week').innerHTML = '';
    $('cal-today-meta').textContent = '—';
    unavailable($('cal-blocks'), bad ? 'Free/busy is unavailable while the calendar call is failing.' : 'Free/busy needs the calendar connected.');
    return;
  }

  const cals = (d.accounts || []).filter(Boolean);
  $('cal-sub').textContent = d.weekCount + ' event' + (d.weekCount === 1 ? '' : 's')
    + ' this week · times in ' + d.timezone
    + (cals.length > 1 ? ' · merged from ' + cals.join(', ') : '');
  $('cal-chip').className = 'chip jade';
  $('cal-chip').textContent = cals.length > 1 ? cals.length + ' calendars live' : 'Outlook live';

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

async function renderConnections(){
  const list = $('conn-list');
  const banner = $('conn-banner');
  banner.innerHTML = '';

  const d = await loadConnections();
  if (!d) {
    unavailable(list, 'Could not load connection state.');
    return;
  }

  if (d.publicUrlWarning) {
    banner.innerHTML += '<div class="banner warn">'
      + 'This dashboard has no password, so anyone with the URL can read the mailboxes connected here. '
      + 'Set <span class="mono">APP_PASSWORD</span> in Railway if you want a login. Connecting works either way.'
      + '</div>';
  }
  if (d.loginRequired && !d.persistent) {
    banner.innerHTML += '<div class="banner warn">DATA_DIR is not set, so connections live on the container filesystem '
      + 'and are lost on redeploy. Attach a Railway volume and point DATA_DIR at it to keep them.</div>';
  }

  const locked = '<span class="btn" aria-disabled="true">Locked</span>';

  list.innerHTML = d.providers.map(p => {
    // One row per connected account, then a row to add another.
    const accountRows = p.accounts.map(a =>
      '<div class="conn"><span class="dot ok"></span>'
      + '<span class="who"><b>' + esc(a.account) + '</b>'
      + '<small>' + esc(p.label) + ' · feeds ' + esc(p.feeds.join(', '))
      + (a.connectedAt ? ' · since ' + esc(a.connectedAt.slice(0, 10)) : '') + '</small></span>'
      + (d.canConnect
          ? '<button class="btn quiet" data-disconnect="' + esc(p.name) + '" data-account="' + esc(a.accountId) + '">Disconnect</button>'
          : locked)
      + '</div>'
    ).join('');

    let addRow;
    if (!p.configured) {
      addRow = '<div class="conn"><span class="dot off"></span>'
        + '<span class="who"><b>' + esc(p.label) + '</b><small>' + esc(p.setupHint) + '</small></span>'
        + '<span class="btn" aria-disabled="true">Unavailable</span></div>';
    } else {
      addRow = '<div class="conn"><span class="dot ' + (p.accounts.length ? 'ok' : 'warn') + '"></span>'
        + '<span class="who"><b>' + esc(p.label)
        + (p.accounts.length ? ' — add another' : '') + '</b>'
        + '<small>' + esc(p.detail) + '</small>'
        + '<small style="margin-top:6px">Redirect URI: <code>' + esc(p.redirectUri) + '</code></small></span>'
        + (d.canConnect
            ? '<a class="btn primary" href="/connect/' + esc(p.name) + '?return=connections">'
              + (p.accounts.length ? 'Add account' : 'Connect') + '</a>'
            : locked)
        + '</div>';
    }
    return accountRows + addRow;
  }).join('');
}

async function disconnect(provider, accountId){
  const res = await fetch('/api/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, accountId })
  });
  if (res.status === 401) { location.href = '/login'; return; }
  await renderConnections();
  hydrate();
}

/* ---------- boot ---------- */

async function hydrate(){
  let d;
  try {
    // Connection state first: the empty-state Connect buttons depend on it.
    const [res] = await Promise.all([
      fetch('/api/data', { cache: 'no-store' }),
      loadConnections()
    ]);
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
  if (off) { e.preventDefault(); disconnect(off.dataset.disconnect, off.dataset.account); return; }

  const close = e.target.closest('[data-close-sheet]');
  if (close) { sheet(close.dataset.closeSheet, false); return; }

  // Backdrop click closes; clicks inside the panel must not.
  if (e.target.classList?.contains('sheet')) { e.target.classList.remove('on'); return; }

  if (e.target.closest('#compose-btn')) { openComposer(); return; }
  if (e.target.closest('#compose-send')) { submitCompose('send'); return; }
  if (e.target.closest('#compose-draft')) { submitCompose('draft'); return; }
  if (e.target.closest('#read-reply')) { replyToOpen(); return; }
  if (e.target.closest('#ib-refresh')) { hydrate(); return; }

  // connect sheet
  if (e.target.closest('#ib-connect') || e.target.closest('#ib-addacct')) {
    renderConnectSheet();
    $('ib-modal').hidden = false;
    return;
  }
  if (e.target.closest('#ib-close') || e.target.id === 'ib-modal') { $('ib-modal').hidden = true; return; }
  const prov = e.target.closest('[data-prov]');
  if (prov) {
    if (prov.getAttribute('aria-disabled') === 'true') return;
    location.href = '/connect/' + encodeURIComponent(prov.dataset.prov) + '?return=inbox';
    return;
  }

  // account strip + filters + star
  const tile = e.target.closest('[data-acct]');
  if (tile) { MAIL_VIEW.account = tile.dataset.acct; renderAccountStrip(); renderMailList(); return; }

  const fchip = e.target.closest('[data-filter]');
  if (fchip) {
    MAIL_VIEW.filter = fchip.dataset.filter;
    document.querySelectorAll('#ib-filters .fchip').forEach(b => b.classList.toggle('on', b === fchip));
    renderMailList();
    return;
  }

  const starBtn = e.target.closest('[data-star]');
  if (starBtn) {
    e.stopPropagation();
    const m = MESSAGES.find(x => key(x) === starBtn.dataset.star);
    if (!m) return;
    const next = !m.starred;
    m.starred = next;                       // optimistic; reverted if the call fails
    starBtn.classList.toggle('on', next);
    starBtn.textContent = next ? '★' : '☆';
    api('/api/mail/action', {
      method: 'POST',
      body: JSON.stringify({ provider: m.provider, accountId: m.accountId, id: m.id, action: next ? 'star' : 'unstar' })
    }).catch(() => {
      m.starred = !next;
      starBtn.classList.toggle('on', !next);
      starBtn.textContent = !next ? '★' : '☆';
    });
    return;
  }

  const openRow = e.target.closest('.msg[data-id]');
  if (openRow) {
    openMessage({
      provider: openRow.dataset.provider,
      accountId: openRow.dataset.account,
      id: openRow.dataset.id
    });
    return;
  }
  const box = e.target.closest('[data-check]');
  if (box) box.classList.toggle('done');
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('ib-modal').hidden) { $('ib-modal').hidden = true; return; }
    const open = document.querySelector('.sheet.on');
    if (open) { open.classList.remove('on'); return; }
  }
  // Enter/Space on a focused message row opens it.
  if (e.key === 'Enter' || e.key === ' ') {
    const row = e.target.closest?.('.msg[data-id]');
    if (row) {
      e.preventDefault();
      openMessage({ provider: row.dataset.provider, accountId: row.dataset.account, id: row.dataset.id });
      return;
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && $('composer').classList.contains('on')) {
    e.preventDefault();
    submitCompose('send');
    return;
  }
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

let searchTimer = null;
document.addEventListener('input', e => {
  if (e.target.id !== 'ib-search') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    MAIL_VIEW.search = e.target.value;
    renderMailList();
  }, 140);
});

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function tick(){
  const d = new Date();
  $('clk').textContent = String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  $('dte').textContent = DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONS[d.getMonth()] + ' ' + d.getFullYear();
}
tick();
setInterval(tick, 15000);

renderFlash();
renderNav({});
hydrate();
setInterval(hydrate, 5 * 60 * 1000);

/* The server kicks off a refresh the moment a provider connects; give it a
   beat, then pull the result in so the panel fills without a manual reload. */
if (FLASH.get('connected')) {
  setTimeout(hydrate, 4000);
  setTimeout(hydrate, 12000);
}
