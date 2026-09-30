/* Social dashboard v2 (drop-in for #so-body).
   Reads the SAME endpoints the current view reads:
     GET  /api/social/platform/:key?range=180   (youtube, facebook, instagram: sliced locally)
     GET  /api/social/platform/meta_ads?range=N (N = 7|28|90: the server windows ads itself)
     POST /api/social/refresh {provider: 'youtube'|'meta'|'x'}
   Usage:
     const inst = SocialV2.mount(el, { api, post, connect, reconnect, initialTab, onTab, download })
       api(url) -> Promise<json>, post(url, body) -> Promise<json> (reject with err.status / err.body on failure),
       connect(grant) / reconnect(grant): open the existing sign-in flows ('youtube' | 'meta'),
       initialTab: 'youtube' | 'facebook' | 'instagram' | 'meta_ads', onTab(tab): called when the user switches tab,
       download(filename, text): optional CSV save hook (default: browser download).
     inst.setTab(tab), inst.reload(), inst.tab */
(function (global) {
'use strict';
const TABS = [
  { k: 'youtube', label: 'YouTube', color: 'var(--yt,#D2604F)', grant: 'youtube', family: 'youtube', unit: 'channel', units: 'channels', add: 'Add channel' },
  { k: 'facebook', label: 'Facebook', color: 'var(--fb,#6E8FD6)', grant: 'meta', family: 'meta', unit: 'Page', units: 'Pages', add: 'Add account' },
  { k: 'instagram', label: 'Instagram', color: 'var(--ig,#C07BC4)', grant: 'meta', family: 'meta', unit: 'account', units: 'accounts', add: 'Add account' },
  { k: 'meta_ads', label: 'Meta Ads', color: 'var(--fb,#6E8FD6)', grant: 'meta', family: 'meta', unit: 'ad account', units: 'ad accounts', add: 'Add account' },
];
const TAB = Object.fromEntries(TABS.map((t) => [t.k, t]));
const METRICS = {
  youtube: [['views', 'Views'], ['interactions', 'Interactions'], ['followers', 'Subscribers'], ['posts', 'Videos published']],
  facebook: [['views', 'Views'], ['interactions', 'Interactions'], ['followers', 'Followers'], ['posts', 'Posts published']],
  instagram: [['reach', 'Reach'], ['views', 'Views'], ['interactions', 'Interactions'], ['followers', 'Followers'], ['posts', 'Posts published']],
};
const ITEM = { youtube: ['video', 'videos', 'Top videos'], facebook: ['post', 'posts', 'Top posts'], instagram: ['post', 'posts', 'Top posts'] };
const BENCH = { ctr: 1.49, cpm: 14.19, frequency: 3.0 };   // Meta averages, shown for reference only

/* ---------- helpers ---------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (a, f) => a.reduce((t, x) => t + (f ? f(x) : x), 0);
const compact = (n) => { if (n == null) return '—'; const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return Math.round(n / 1e3) + 'K';
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n)); };
const dayKey = (v) => String(v).slice(0, 10);
const fmtDay = (d, long) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...(long ? { weekday: 'short' } : {}) });
const pctMove = (a, b) => (a == null || b == null || !b) ? null : ((a - b) / b) * 100;
const deltaHtml = (p, goodDown) => { if (p == null) return ''; const up = p > 0, flat = Math.abs(p) < 0.5;
  const cls = flat ? 'sv2-flat' : ((up !== !!goodDown) ? 'sv2-up' : 'sv2-down');
  return `<span class="${cls}">${flat ? '±0%' : (up ? '↑ ' : '↓ ') + Math.abs(p).toFixed(Math.abs(p) < 10 ? 1 : 0) + '%'}</span>`; };
const ago = (iso) => { if (!iso) return 'never'; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); if (h < 24) return h + ' h ago'; return Math.round(h / 24) + ' days ago'; };

/* ---------- windowing (same rule as today: the last N days present in the payload) ---------- */
function windowRows(rows, days, offset) {
  const all = [...new Set(rows.map((r) => dayKey(r.day)))].sort();
  const end = all.length - offset * days, start = Math.max(0, end - days);
  const keep = new Set(all.slice(start, Math.max(start, end)));
  return { rows: rows.filter((r) => keep.has(dayKey(r.day))), axis: [...keep].sort() };
}
/* Followers are a LEVEL: per account newest minus that account's own oldest reading, summed across accounts. */
function followerLevels(rows, accounts) {
  const per = accounts.map((a) => { const mine = rows.filter((r) => r.account === a.id && r.followers != null).sort((x, y) => (x.day < y.day ? -1 : 1));
    return mine.length ? { a, now: mine[mine.length - 1].followers, then: mine[0].followers } : null; }).filter(Boolean);
  return per.length ? { now: sum(per, (p) => p.now), then: sum(per, (p) => p.then), per } : null;
}

/* ---------- state ---------- */
function mount(root, opts) {
  const S = { tab: opts.initialTab || 'youtube', range: 28, acct: 'all', metric: {}, q: '', allTime: false, shown: 8,
    sort: { k: 'views', d: -1 }, adsMetric: 'spend', adsSort: { k: 'spend', d: -1 }, data: {}, loading: {}, fetching: false, msg: null };
  try { Object.assign(S, JSON.parse(localStorage.getItem('social-v2') || '{}'), { data: {}, loading: {}, fetching: false, msg: null }); } catch (e) {}
  if (opts.initialTab && TAB[opts.initialTab]) S.tab = opts.initialTab;   // the host's route wins over the remembered tab
  const save = () => { try { localStorage.setItem('social-v2', JSON.stringify({ tab: S.tab, range: S.range, metric: S.metric, adsMetric: S.adsMetric })); } catch (e) {} };
  const keyOf = (k) => k === 'meta_ads' ? 'meta_ads:' + S.range : k;

  async function load(k, force) {
    const key = keyOf(k);
    if (S.data[key] && !force) return;
    S.loading[key] = true; draw();
    try { S.data[key] = await opts.api('/api/social/platform/' + k + '?range=' + (k === 'meta_ads' ? S.range : 180)); }
    catch (e) { S.data[key] = { provider: k, error: (e && (e.body && e.body.detail || e.message)) || 'request failed' }; }
    S.loading[key] = false; draw();
  }
  async function fetchNow() {
    if (S.fetching) return; S.fetching = true; S.msg = null; draw();
    try { const out = await opts.post('/api/social/refresh', { provider: TAB[S.tab].family });
      S.msg = { ok: true, t: 'Fetched ' + (out && out.polled != null ? out.polled + ' account' + (out.polled === 1 ? '' : 's') : 'the latest figures') + (out && out.failed ? ', ' + out.failed + ' failed' : '') + '.' };
      for (const t of TABS) if (t.family === TAB[S.tab].family) Object.keys(S.data).filter((x) => x.startsWith(t.k)).forEach((x) => delete S.data[x]);
    } catch (e) { S.msg = { ok: false, t: e && e.status === 409 ? 'A fetch is already running. Try again in a minute.' : 'Fetch failed: ' + ((e && e.message) || 'unknown error') + '.' }; }
    S.fetching = false; await load(S.tab, true);
  }

  /* ---------- top bar ---------- */
  function topBar(d) {
    const t = TAB[S.tab];
    const accts = (d && d.accounts) || [];
    const live = accts.filter((a) => a.lastRun).map((a) => a.lastRun).sort().pop();
    const stale = accts.some((a) => a.status !== 'ok');
    const tabs = TABS.map((x) => { const dd = S.data[keyOf(x.k)]; const flag = dd && dd.accounts && dd.accounts.some((a) => a.status !== 'ok');
      return `<button class="sv2-tab" role="tab" data-tab="${x.k}" aria-selected="${x.k === S.tab}"><span class="sv2-dot" style="--pc:${x.color}"></span>${x.label}${flag ? '<span class="sv2-flag" title="An account needs reconnecting"></span>' : ''}</button>`; }).join('');
    const ranges = [7, 28, 90].map((n) => `<button data-range="${n}" aria-pressed="${n === S.range}">${n} days</button>`).join('');
    const acctSel = accts.length > 1 ? `<select class="sv2-select" data-acct aria-label="${t.unit}"><option value="all">All ${accts.length} ${t.units}</option>${accts.map((a) => `<option value="${esc(a.id)}"${S.acct === a.id ? ' selected' : ''}>${esc(a.label)}</option>`).join('')}</select>` : '';
    return `<div class="sv2-top">
      <div class="sv2-tabs" role="tablist" aria-label="Platform">${tabs}</div>
      <div class="sv2-ctrl">
        <div class="sv2-seg" role="group" aria-label="Period">${ranges}</div>${acctSel}
        ${d && d.connected ? `<span class="sv2-fresh${stale ? ' stale' : ''}"><i></i>${stale ? 'Needs reconnecting' : 'Updated ' + ago(live)}</span>
        <button class="sv2-btn" data-fetch${S.fetching ? ' disabled' : ''}>${S.fetching ? 'Fetching…' : 'Fetch now'}</button>` : ''}
        <button class="sv2-btn pri" data-connect>+ ${t.add}</button>
      </div></div>`;
  }

  /* ---------- organic dashboards ---------- */
  function organic(d, k) {
    const accounts = S.acct === 'all' ? d.accounts : d.accounts.filter((a) => a.id === S.acct);
    const ids = new Set(accounts.map((a) => a.id));
    const series = (d.series || []).filter((r) => ids.has(r.account));
    const cur = windowRows(series, S.range, 0), prev = windowRows(series, S.range, 1);
    const inAxis = new Set(cur.axis), first = cur.axis[0];
    const has = (m) => cur.rows.some((r) => r[m] != null);
    const total = (rows, m) => rows.some((r) => r[m] != null) ? sum(rows, (r) => r[m] || 0) : null;
    const posts = (d.posts || []).filter((p) => ids.has(p.account));
    const inWin = posts.filter((p) => p.publishedAt && dayKey(p.publishedAt) >= first && inAxis.size);
    const prevPosts = posts.filter((p) => p.publishedAt && prev.axis.length && dayKey(p.publishedAt) >= prev.axis[0] && dayKey(p.publishedAt) < first);
    const fl = followerLevels(cur.rows, accounts), flPrev = followerLevels(prev.rows, accounts);

    const available = METRICS[k].filter(([m]) => m === 'posts' || has(m));
    const missing = METRICS[k].filter(([m]) => m !== 'posts' && !has(m)).map(([, l]) => l.toLowerCase());
    const DEFAULT = { youtube: 'views', facebook: 'interactions', instagram: 'views' };
    let pick = S.metric[k] || DEFAULT[k]; if (!available.some(([m]) => m === pick) || pick === 'posts') pick = (available.find(([m]) => m !== 'posts') || [])[0];

    const tiles = available.map(([m, label]) => {
      let v, cap = '', dl = '';
      if (m === 'followers') { v = fl ? fl.now : null; const ch = fl ? fl.now - fl.then : null;
        dl = fl && fl.then ? deltaHtml(pctMove(fl.now, fl.then)) : ''; cap = ch == null ? '' : (ch >= 0 ? '+' : '') + compact(ch) + ' this period' + (accounts.length > 1 ? ', ' + accounts.length + ' ' + TAB[k].units : ''); }
      else if (m === 'posts') { v = inWin.length; cap = 'in this period' + (prevPosts.length ? ' (' + prevPosts.length + ' before)' : ''); }
      else { v = total(cur.rows, m); const pv = total(prev.rows, m); dl = deltaHtml(pctMove(v, pv));
        cap = pv != null && prev.axis.length ? 'vs ' + compact(pv) + ' in the previous ' + S.range + ' days' : 'no earlier period yet';
        if (m === 'interactions' && has('reach')) { const re = total(cur.rows, 'reach'); if (re) cap = ((v / re) * 100).toFixed(1) + '% of reach' + (pv != null ? ', vs ' + compact(pv) + ' before' : ''); } }
      return `<div class="sv2-kpi"><div class="k">${label}</div><div class="v">${compact(v)}${dl ? '<span class="dl">' + dl + '</span>' : ''}</div><div class="d">${esc(cap)}</div></div>`;
    }).join('');
    const note = missing.length ? `<div class="sv2-note"><span>${TAB[k].label} does not report ${missing.join(' or ')}, so ${missing.length > 1 ? 'those tiles are' : 'that tile is'} left out.</span></div>` : '';

    const label = (METRICS[k].find(([m]) => m === pick) || [])[1] || '';
    const multi = accounts.length > 1 && S.acct === 'all';
    const hl = highlights(k, cur, prev, pick, label, !multi);
    const insight = multi ? `<div class="sv2-pair">${hl}${accountsPanel(d, k, cur.rows, accounts)}</div>` : hl;
    return `${note}<div class="sv2-kpis" data-n="${available.length}" style="--n:${available.length}">${tiles}</div>${insight}
      ${contentTable(d, k, posts, inWin, cur.axis)}${footer(d)}`;
  }

  function highlights(k, cur, prev, pick, label, wide) {
    if (!pick || pick === 'followers') return '';
    const w = label.toLowerCase(), days = cur.axis;
    const v = days.map((dd) => sum(cur.rows.filter((r) => dayKey(r.day) === dd), (r) => r[pick] || 0));
    const mean = (a) => a.length ? sum(a) / a.length : 0, mv = mean(v), out = [];
    if (mv > 0) { let bi = 0; v.forEach((x, i) => { if (x > v[bi]) bi = i; });
      const x = v[bi] / mv; if (x >= 1.8) out.push(['up', `<b>${fmtDay(days[bi], true)}</b> was your best day: ${compact(v[bi])} ${w}, about ${Math.round(x)} times a normal day.`]); }
    if (v.length >= 6) { const h = Math.floor(v.length / 2), a = mean(v.slice(0, h)), b = mean(v.slice(h));
      if (a > 0) { const ch = (b - a) / a * 100; if (Math.abs(ch) >= 12) out.push([ch > 0 ? 'up' : 'down', `${label} ${/s$/.test(label) ? 'are' : 'is'} ${ch > 0 ? 'up' : 'down'} <b>${Math.abs(Math.round(ch))}%</b> in the second half of the period.`]); } }
    const tv = sum(v), pv = sum(prev.rows, (r) => r[pick] || 0);
    if (pv > 0 && prev.axis.length) { const ch = (tv - pv) / pv * 100; out.push([ch >= 0 ? 'up' : 'down', `<b>${compact(tv)}</b> ${w} this period against ${compact(pv)} the period before, ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch).toFixed(1)}%.`]); }
    const quiet = v.filter((x) => x === 0).length;
    if (quiet && quiet < v.length && out.length < 3) out.push(['i', `<b>${quiet}</b> day${quiet === 1 ? '' : 's'} recorded no ${w}.`]);
    if (!out.length) out.push(['i', 'Nothing stands out against this account’s own normal in this period.']);
    return `<div class="sv2-card"><h3>Highlights</h3><p class="sub">${esc(label)}, compared with your own normal</p><ul class="sv2-hl${wide ? ' wide' : ''}">${out.slice(0, 3).map(([s, t]) =>
      `<li><span class="m ${s === 'up' ? 'good' : s === 'down' ? 'bad' : ''}">${s === 'up' ? '↑' : s === 'down' ? '↓' : 'i'}</span><span>${t}</span></li>`).join('')}</ul></div>`;
  }
  function accountsPanel(d, k, rows, accounts) {
    const metric = rows.some((r) => r.views != null) ? 'views' : 'interactions';
    const per = accounts.map((a) => { const mine = rows.filter((r) => r.account === a.id);
      const f = mine.filter((r) => r.followers != null).sort((x, y) => (x.day < y.day ? -1 : 1));
      return { a, v: sum(mine, (r) => r[metric] || 0), now: f.length ? f[f.length - 1].followers : null, then: f.length ? f[0].followers : null }; });
    const tot = sum(per, (p) => p.v) || 1, fw = k === 'youtube' ? 'subscribers' : 'followers';
    return `<div class="sv2-card"><h3>${accounts.length > 1 ? cap(TAB[k].units) : cap(TAB[k].unit)}</h3><p class="sub">${cap(metric)} this period and ${fw} now</p><div class="sv2-acc">${per.map((p) => {
      const ch = p.now != null && p.then ? pctMove(p.now, p.then) : null;
      return `<div class="row"><span class="nm"><span class="sv2-dot" style="--pc:${esc(p.a.color || TAB[k].color)}"></span><span>${esc(p.a.label)}</span></span><span class="val">${compact(p.v)} ${metric}</span>
        <div class="bar" style="--pc:${esc(p.a.color || TAB[k].color)}"><i style="width:${Math.max(2, p.v / tot * 100)}%"></i></div>
        <span class="hd">${Math.round(p.v / tot * 100)}% of ${metric}${p.now != null ? ', ' + compact(p.now) + ' ' + fw : ''}${ch != null ? ' (' + (ch >= 0 ? 'up ' : 'down ') + Math.abs(ch).toFixed(1) + '%)' : ''}</span></div>`; }).join('')}</div></div>`;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function contentTable(d, k, all, inWin, axis) {
    const [one, many, title] = ITEM[k];
    const pool = S.allTime ? all : inWin;
    const q = S.q.toLowerCase();
    const list = pool.filter((p) => !q || String(p.title).toLowerCase().includes(q));
    const useViews = list.some((p) => p.views > 0), basis = useViews ? 'views' : 'interactions';
    const avg = list.length ? sum(list, (p) => p[basis] || 0) / list.length : 0;
    const rows = list.map((p) => Object.assign({}, p, { vs: avg ? (p[basis] || 0) / avg : null }));
    const showCol = { views: pool.some((p) => p.views > 0), interactions: pool.some((p) => p.interactions > 0), shares: pool.some((p) => p.shares > 0) };
    let { k: sk, d: sd } = S.sort;
    if (showCol[sk] === false) sk = ['views', 'interactions', 'shares'].find((c) => showCol[c]) || 'publishedAt';
    rows.sort((a, b) => (sk === 'publishedAt' ? String(a.publishedAt).localeCompare(String(b.publishedAt)) : ((a[sk] || 0) - (b[sk] || 0))) * sd);
    const acctName = Object.fromEntries(d.accounts.map((a) => [a.id, a.label]));
    const th = (key, lbl, r) => `<th class="s${r ? ' r' : ''}${sk === key ? ' on' : ''}" data-sort="${key}">${lbl}${sk === key ? (sd > 0 ? ' ↑' : ' ↓') : ''}</th>`;
    const pill = (x) => x == null ? '' : `<span class="sv2-pill ${x >= 1.5 ? 'good' : x < 0.9 ? 'bad' : ''}">${x.toFixed(1)}× avg</span>`;
    const body = rows.slice(0, S.shown).map((p) => `<tr><td>${p.permalink ? `<a class="t" href="${esc(p.permalink)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : `<span class="t">${esc(p.title)}</span>`}<span class="s2">${esc(acctName[p.account] || '')}</span></td>
      <td class="s2">${esc(p.when || '')}</td>${showCol.views ? `<td class="r" style="color:var(--c-ink);font-weight:600">${compact(p.views)}</td>` : ''}${showCol.interactions ? `<td class="r"${showCol.views ? '' : ' style="color:var(--c-ink);font-weight:600"'}>${compact(p.interactions)}</td>` : ''}${showCol.shares ? `<td class="r">${compact(p.shares)}</td>` : ''}${list.length > 1 ? `<td class="r">${pill(p.vs)}</td>` : ''}</tr>`).join('');
    return `<div class="sv2-card" id="sv2-content"><div class="sv2-ch"><div><h3>${title}</h3><p class="sub">${S.allTime ? all.length + ' ' + many + ' held' : inWin.length + ' published this period'}${list.length > 1 ? ', ranked against the average ' + basis.replace('interactions', 'interactions') : ''}</p></div>
      <div class="sv2-right"><div class="sv2-seg"><button data-alltime="0" aria-pressed="${!S.allTime}">This period</button><button data-alltime="1" aria-pressed="${S.allTime}">All time</button></div>
      <input class="sv2-search" type="search" data-q placeholder="Search ${many}" value="${esc(S.q)}" aria-label="Search ${many}"><button class="sv2-btn" data-csv="posts">Export CSV</button></div></div>
      ${rows.length ? `<div class="sv2-tw"><table><thead><tr><th>${cap(one)}</th>${th('publishedAt', 'Published')}${showCol.views ? th('views', 'Views', 1) : ''}${showCol.interactions ? th('interactions', 'Interactions', 1) : ''}${showCol.shares ? th('shares', 'Shares', 1) : ''}${list.length > 1 ? th('vs', 'vs average', 1) : ''}</tr></thead><tbody>${body}</tbody></table></div>
      ${rows.length > S.shown ? `<div class="sv2-more"><button class="sv2-btn" data-more>Show ${Math.min(rows.length - S.shown, 20)} more</button></div>` : ''}`
      : `<p class="sub" style="margin:8px 0 0">${S.q ? 'No ' + many + ' match “' + esc(S.q) + '”.' : 'No ' + many + ' published this period.' + (all.length ? ' Switch to All time to see earlier ones.' : '')}</p>`}</div>`;
  }
  function footer(d) {
    const t = TAB[S.tab];
    return `<div class="sv2-foot">${(d.accounts || []).map((a) => `<span class="a"><span class="sv2-dot" style="--pc:${a.status === 'ok' ? 'var(--c-good)' : 'var(--c-warn)'}"></span><span><b>${esc(a.label)}</b>${a.handle && a.handle !== a.label ? ' ' + esc(a.handle) : ''}, ${a.status === 'ok' ? 'pulled ' + ago(a.lastRun) : '<button class="sv2-link" data-reconnect>Reconnect</button>'}</span></span>`).join('')}
      <button class="sv2-link" style="margin-left:auto" data-connect>+ ${t.add}</button></div>`;
  }

  /* ---------- Meta Ads ---------- */
  function adsView(d) {
    const ads = d.ads;
    if (!ads || !(ads.campaigns || []).length) return `<div class="sv2-empty"><h3>No ad delivery in the last ${S.range} days</h3><p>The ad accounts are connected but nothing spent in this period. Try 90 days, or press Fetch now.</p></div>${footer(d)}`;
    const cur = ads.currency, mixed = (ads.currencies || []).length > 1;
    const money = (n, short) => { if (n == null) return '—'; if (!cur) return (short ? compact(n) : Math.round(n).toLocaleString());
      try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: short || n >= 1000 ? 0 : 2, notation: short && Math.abs(n) >= 1e4 ? 'compact' : 'standard' }).format(n); } catch (e) { return cur + ' ' + Math.round(n); } };
    const inScope = (r) => S.acct === 'all' || r.account === S.acct;
    const camps = ads.campaigns.filter(inScope), daily = ads.daily.filter(inScope);
    const T = { spend: sum(camps, (c) => c.spend), results: sum(camps, (c) => c.results), impressions: sum(camps, (c) => c.impressions), clicks: sum(camps, (c) => c.clicks) };
    const dead = camps.filter((c) => c.spend > 0 && !c.results), deadSpend = sum(dead, (c) => c.spend);
    const cpa = T.results ? T.spend / T.results : null, cpaLive = T.results ? (T.spend - deadSpend) / T.results : null;
    const ctr = T.impressions ? T.clicks / T.impressions * 100 : null, cpm = T.impressions ? T.spend / T.impressions * 1000 : null;
    const peak = Math.max(0, ...camps.map((c) => c.peakFrequency || 0)) || null;
    const P = S.acct === 'all' ? ads.previous : null;
    const pCpa = P && P.results ? P.spend / P.results : null, pCtr = P && P.impressions ? P.clicks / P.impressions * 100 : null;
    const vsPrev = P ? 'vs previous ' + S.range + ' days' : 'no earlier period yet';
    const tile = (m, label, v, dl, capt) => `<div class="sv2-kpi"><div class="k">${label}</div><div class="v">${v}${dl ? '<span class="dl">' + dl + '</span>' : ''}</div><div class="d">${esc(capt)}</div></div>`;
    const tiles = [
      tile('spend', 'Spend', money(T.spend, true), P ? deltaHtml(pctMove(T.spend, P.spend)) : '', vsPrev, S.adsMetric === 'spend'),
      tile('results', 'Results', compact(T.results), P ? deltaHtml(pctMove(T.results, P.results)) : '', vsPrev, S.adsMetric === 'results'),
      tile('cpa', 'Cost per result', money(cpa), P ? deltaHtml(pctMove(cpa, pCpa), true) : '', dead.length && cpaLive ? money(cpaLive) + ' without no-result spend' : vsPrev, S.adsMetric === 'cpa'),
      tile('ctr', 'Click-through rate', ctr == null ? '—' : ctr.toFixed(2) + '%', P ? deltaHtml(pctMove(ctr, pCtr)) : '', 'Meta average ' + BENCH.ctr + '%', S.adsMetric === 'ctr'),
      `<div class="sv2-kpi"><div class="k">Peak frequency</div><div class="v">${peak ? peak.toFixed(2) : '—'}</div><div class="d">${peak && peak >= BENCH.frequency ? '<span class="sv2-down">Fatigue risk. </span>' : ''}Highest day, fatigue from ${BENCH.frequency.toFixed(1)}</div></div>`,
    ].join('');
    const alert = dead.length ? `<div class="sv2-note bad"><span><b>${dead.length} campaign${dead.length > 1 ? 's' : ''} spent ${money(deadSpend)} with no results in this period.</b> ${dead.slice(0, 3).map((c) => esc(c.name) + ' ' + money(c.spend)).join(', ')}${dead.length > 3 ? ', and ' + (dead.length - 3) + ' more' : ''}. Either the objective is not what you count as a result, or these need pausing.</span><button class="sv2-link" data-goto="sv2-camps">Review campaigns</button></div>` : '';
    const mixedNote = mixed ? `<div class="sv2-note"><span>These ad accounts bill in different currencies (${ads.currencies.join(', ')}), so combined amounts are shown without a symbol. Pick one ad account to see its own currency.</span></div>` : '';
    // campaigns
    const { k: sk, d: sd } = S.adsSort;
    const rows = camps.map((c) => Object.assign({}, c, { cpa: c.results ? c.spend / c.results : null, ctr: c.impressions ? c.clicks / c.impressions * 100 : null, cpm: c.impressions ? c.spend / c.impressions * 1000 : null }));
    rows.sort((a, b) => (sk === 'name' ? a.name.localeCompare(b.name) : ((a[sk] == null ? -1 : a[sk]) - (b[sk] == null ? -1 : b[sk]))) * sd);
    const th = (key, lbl, r) => `<th class="s${r ? ' r' : ''}${sk === key ? ' on' : ''}" data-adsort="${key}">${lbl}${sk === key ? (sd > 0 ? ' ↑' : ' ↓') : ''}</th>`;
    const spark = (arr) => { const mx = Math.max(1, ...arr); const w = 90, h = 24, st = w / Math.max(1, arr.length - 1);
      return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${arr.map((v, i) => (i ? 'L' : 'M') + (i * st).toFixed(1) + ' ' + (h - 2 - (v / mx) * (h - 4)).toFixed(1)).join('')}"/></svg>`; };
    const objective = (o) => cap(String(o || '').replace(/^OUTCOME_/, '').toLowerCase());
    const table = `<div class="sv2-card" id="sv2-camps"><div class="sv2-ch"><div><h3>Campaigns</h3><p class="sub">${rows.length} with spend in the last ${S.range} days. Click a column to sort.</p></div><div class="sv2-right"><button class="sv2-btn" data-csv="campaigns">Export CSV</button></div></div>
      <div class="sv2-tw"><table><thead><tr>${th('name', 'Campaign')}<th>Spend trend</th>${th('spend', 'Spend', 1)}${th('results', 'Results', 1)}${th('cpa', 'Cost per result', 1)}${th('ctr', 'CTR', 1)}${th('cpm', 'CPM', 1)}${th('peakFrequency', 'Peak frequency', 1)}</tr></thead><tbody>
      ${rows.map((c) => `<tr><td><span class="t">${esc(c.name)}</span><span class="s2">${esc(objective(c.objective))}${c.status && c.status !== 'Active' ? ', ' + esc(c.status) : ''}</span></td><td>${spark(c.spark || [])}</td>
        <td class="r" style="color:var(--c-ink);font-weight:600">${money(c.spend)}</td><td class="r">${compact(c.results)}</td>
        <td class="r">${c.results ? `<span style="color:var(--c-ink);font-weight:600">${money(c.cpa)}</span>` : (c.spend > 0 ? '<span class="sv2-pill bad">No results</span>' : '—')}</td>
        <td class="r">${c.ctr == null ? '—' : c.ctr.toFixed(2) + '%'}</td><td class="r">${money(c.cpm)}</td><td class="r"${c.peakFrequency >= BENCH.frequency ? ' style="color:var(--c-bad)"' : ''}>${c.peakFrequency ? c.peakFrequency.toFixed(2) : '—'}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    S._csv = { campaigns: [['Campaign', 'Objective', 'Status', 'Spend', 'Results', 'Cost per result', 'CTR %', 'CPM', 'Peak frequency', 'Impressions', 'Clicks'],
      ...rows.map((c) => [c.name, c.objective, c.status, c.spend.toFixed(2), c.results, c.cpa == null ? '' : c.cpa.toFixed(2), c.ctr == null ? '' : c.ctr.toFixed(2), c.cpm == null ? '' : c.cpm.toFixed(2), c.peakFrequency ? c.peakFrequency.toFixed(2) : '', c.impressions, c.clicks])] };
    return `${alert}${mixedNote}<div class="sv2-kpis" data-n="5" style="--n:5">${tiles}</div>${table}${footer(d)}`;
  }

  /* ---------- page ---------- */
  function draw() {
    const k = S.tab, d = S.data[keyOf(k)], t = TAB[k];
    let body;
    if (!d || S.loading[keyOf(k)] && !d) body = '<div class="sv2-kpis" data-n="4" style="--n:4"><div class="sv2-skel"></div><div class="sv2-skel"></div><div class="sv2-skel"></div><div class="sv2-skel"></div></div><div class="sv2-skel" style="height:320px"></div>';
    else if (d.error) body = `<div class="sv2-empty"><h3>${t.label} could not load</h3><p>${esc(d.error)}</p><button class="sv2-btn" data-retry>Try again</button></div>`;
    else if (!d.connected) body = `<div class="sv2-empty"><h3>Connect ${t.label}</h3><p>${d.configured === false ? 'Meta sign-in is not configured on the server yet (META_APP_ID and META_APP_SECRET).' : d.grantConnected ? 'Your Meta sign-in is connected, but it found no ' + t.unit + ' for ' + t.label + '. Reconnect and tick the ' + t.units + ' you want.' : 'Sign in to start pulling ' + t.label + ' figures. They update on the schedule, or whenever you press Fetch now.'}</p><button class="sv2-btn pri" data-connect>${d.grantConnected ? 'Reconnect' : 'Connect ' + t.label}</button></div>`;
    else {
      if (S.acct !== 'all' && !d.accounts.some((a) => a.id === S.acct)) S.acct = 'all';
      const bad = d.accounts.filter((a) => a.status !== 'ok');
      const warn = bad.length ? `<div class="sv2-note"><span><b>${bad.length} ${bad.length > 1 ? t.units : t.unit} need${bad.length > 1 ? '' : 's'} reconnecting</b>: ${bad.map((a) => esc(a.label)).join(', ')}. Figures stop updating until then.</span><button class="sv2-link" data-reconnect>Reconnect</button></div>` : '';
      body = warn + (k === 'meta_ads' ? adsView(d) : organic(d, k));
    }
    const msg = S.msg ? `<div class="sv2-note${S.msg.ok ? '' : ' bad'}"><span>${esc(S.msg.t)}</span></div>` : '';
    root.innerHTML = `<div class="sv2">${topBar(d)}${msg}${body}</div>`;
    wire(d);
  }
  function wire(d) {
    const $$ = (s) => root.querySelectorAll(s);
    $$('[data-tab]').forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; S.acct = 'all'; S.q = ''; S.shown = 8; S.msg = null; save(); draw(); load(S.tab); if (opts.onTab) opts.onTab(S.tab); });
    $$('[data-range]').forEach((b) => b.onclick = () => { S.range = +b.dataset.range; S.shown = 8; save(); draw(); if (S.tab === 'meta_ads') load('meta_ads'); });
    $$('[data-acct]').forEach((s) => s.onchange = () => { S.acct = s.value; draw(); });
    $$('[data-alltime]').forEach((b) => b.onclick = () => { S.allTime = b.dataset.alltime === '1'; S.shown = 8; draw(); });
    $$('[data-sort]').forEach((b) => b.onclick = () => { const k = b.dataset.sort; S.sort = { k, d: S.sort.k === k ? -S.sort.d : -1 }; draw(); });
    $$('[data-adsort]').forEach((b) => b.onclick = () => { const k = b.dataset.adsort; S.adsSort = { k, d: S.adsSort.k === k ? -S.adsSort.d : (k === 'name' ? 1 : -1) }; draw(); });
    $$('[data-more]').forEach((b) => b.onclick = () => { S.shown += 20; draw(); });
    $$('[data-fetch]').forEach((b) => b.onclick = fetchNow);
    $$('[data-retry]').forEach((b) => b.onclick = () => load(S.tab, true));
    $$('[data-connect]').forEach((b) => b.onclick = () => opts.connect && opts.connect(TAB[S.tab].grant));
    $$('[data-reconnect]').forEach((b) => b.onclick = () => opts.reconnect && opts.reconnect(TAB[S.tab].grant));
    $$('[data-goto]').forEach((b) => b.onclick = () => { const el = root.querySelector('#' + b.dataset.goto); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    const qi = root.querySelector('[data-q]');
    if (qi) { let tm; qi.oninput = () => { clearTimeout(tm); tm = setTimeout(() => { S.q = qi.value; S.shown = 8; const pos = qi.selectionStart; draw(); const n = root.querySelector('[data-q]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 160); }; }
    $$('[data-csv]').forEach((b) => b.onclick = () => csv(b.dataset.csv, d));
    /* If the controls wrap under the tabs, left-align them instead of leaving a gap on the left. */
    fit();
    /* Width changes only: toggling .wrap changes the height, and reacting to that would loop. */
    if (!root._sv2ro && global.ResizeObserver) { let lastW = -1;
      root._sv2ro = new ResizeObserver((es) => { const w = Math.round(es[0].contentRect.width); if (w === lastW) return; lastW = w; requestAnimationFrame(fit); });
      root._sv2ro.observe(root); }
  }
  function fit() {
    const top = root.querySelector('.sv2-top'), tabs = root.querySelector('.sv2-tabs'), ctrl = root.querySelector('.sv2-ctrl');
    if (!top || !tabs || !ctrl) return; top.classList.remove('wrap'); if (ctrl.offsetTop > tabs.offsetTop + 4) top.classList.add('wrap');
  }
  function csv(kind, d) {
    let rows;
    if (kind === 'campaigns') rows = (S._csv && S._csv.campaigns) || [];
    else { const acct = Object.fromEntries(d.accounts.map((a) => [a.id, a.label]));
      rows = [['Title', 'Account', 'Published', 'Views', 'Interactions', 'Shares', 'Reach', 'Link'], ...(d.posts || []).filter((p) => S.acct === 'all' || p.account === S.acct).map((p) => [p.title, acct[p.account] || '', dayKey(p.publishedAt || ''), p.views, p.interactions, p.shares, p.reach, p.permalink || ''])]; }
    const text = '﻿' + rows.map((r) => r.map((v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
    const name = TAB[S.tab].label.replace(/\s+/g, '_') + '_' + kind + '_' + S.range + 'd.csv';
    if (opts.download) return opts.download(name, text);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  draw(); load(S.tab);
  return {
    reload: () => { S.data = {}; load(S.tab, true); },
    setTab: (k) => { if (TAB[k] && k !== S.tab) { S.tab = k; S.acct = 'all'; S.q = ''; S.shown = 8; save(); draw(); load(k); } },
    get tab() { return S.tab; },
  };
}
global.SocialV2 = { mount };
})(window);
