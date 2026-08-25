/* Meta: one sign-in, several accounts.

   A Meta grant is not one connection. It covers every Facebook Page the user
   chose to grant, every Instagram business account linked to one of those Pages,
   and every ad account they administer. discover() turns that grant into one
   accounts row each, which is why lib/oauth.js needed a discover hook at all.

   Token model, which is the part that does not resemble Google or Microsoft:

     - The code exchange returns a *short-lived* user token, about an hour, and no
       refresh token. There is nothing to renew with.
     - That token is immediately swapped for a long-lived one, roughly 60 days,
       via grant_type=fb_exchange_token. This is the durable credential.
     - Repeating the same swap with a long-lived token returns a fresh 60 days,
       which is what refresh() does.
     - Page access tokens derived from a long-lived user token do not expire at
       all, so Page and Instagram rows are refreshKind 'none'.

   Deliberately not requested: pages_messaging and instagram_manage_messages.
   Both are Advanced Access, both fail review without a messaging feature to
   demonstrate, and asking for an unapproved permission degrades the whole grant.
   When DMs land they belong in the Inbox as accounts, not here. */

const V = 'v23.0';
const GRAPH = `https://graph.facebook.com/${V}`;

async function call(token, path, params = {}){
  const qs = new URLSearchParams({ access_token: token });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const res = await fetch(`${GRAPH}${path}?${qs}`);
  const json = await res.json().catch(() => null);

  if (!res.ok || json?.error) {
    const e = json?.error || {};
    /* Code 190 is an invalid or expired token — the only case that should send a
       row to reauth. Code 17 is the ad-account rate limit and clears on its own,
       so it must not be mistaken for an auth failure. */
    const err = new Error(`Meta ${res.status}: ${e.message || res.statusText}`);
    err.code = e.code;
    err.subcode = e.error_subcode;
    err.isAuth = e.code === 190 || e.type === 'OAuthException' && e.code === 102;
    err.isRateLimit = e.code === 17 || e.code === 4 || e.code === 80004;
    err.usage = res.headers.get('X-Business-Use-Case-Usage');
    throw err;
  }
  return { data: json, usage: res.headers.get('X-Business-Use-Case-Usage') };
}

/* ---------------------------------------------------------------------------
   Token lifecycle.
   --------------------------------------------------------------------------- */

/* Called by exchangeCode() through the exchangeLongLived hook. Turns the
   short-lived token from the code exchange into the 60-day credential that is
   actually stored. */
export async function exchangeLongLived(env, tok){
  const short = tok.access_token;
  if (!short) throw new Error('Meta returned no access token from the code exchange');

  const { data } = await call(short, '/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: short
  });
  if (!data?.access_token) throw new Error('Meta returned no long-lived token');

  /* Meta omits expires_in when a token does not expire. 60 days is the documented
     life of a long-lived user token and the safe assumption when it is absent. */
  const seconds = Number(data.expires_in) || 60 * 86_400;

  /* What the user actually granted, which is not necessarily what was asked for:
     Facebook's dialog lets them deselect permissions and still succeed. */
  const granted = await grantedScopes(data.access_token).catch(() => null);

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + (seconds - 3600) * 1000,
    grantedScopes: granted ? granted.join(' ') : (tok.scope || null)
  };
}

/* The same exchange again. lib/accounts.js renews at seven days out, because once
   a long-lived token lapses there is no refresh token to fall back on. */
export async function refresh(env, stored){
  const { data } = await call(stored, '/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: env.META_APP_ID,
    client_secret: env.META_APP_SECRET,
    fb_exchange_token: stored
  });
  if (!data?.access_token) throw new Error('Meta returned no long-lived token on renewal');
  const seconds = Number(data.expires_in) || 60 * 86_400;
  return {
    accessToken: data.access_token,
    refreshToken: data.access_token,
    expiresAt: Date.now() + (seconds - 3600) * 1000,
    scope: null
  };
}

export async function grantedScopes(token){
  const { data } = await call(token, '/me/permissions');
  return (data?.data || [])
    .filter(p => p.status === 'granted')
    .map(p => p.permission);
}

export async function identify(accessToken){
  const { data } = await call(accessToken, '/me', { fields: 'id,name' });
  if (!data?.id) throw new Error('Meta /me returned no id');
  return { uid: String(data.id), email: data.name || `Meta ${data.id}` };
}

/* ---------------------------------------------------------------------------
   Asset discovery.
   --------------------------------------------------------------------------- */

/* One row per Page, per linked Instagram account, and per ad account.

   A short list is not an error. Facebook's dialog lets the user pick which Pages
   to grant, so one Page returned when four exist is the correct outcome and must
   not be reported as a failure. */
export async function discover(accessToken, env, record){
  const assets = [];
  const granted = new Set(String(record?.grantedScopes || '').split(/\s+/).filter(Boolean));

  const { data: pages } = await call(accessToken, '/me/accounts', {
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    limit: 100
  });

  for (const page of pages?.data || []) {
    if (!page.access_token) {
      /* Without a Page token there is nothing to read insights with. Skipped
         loudly rather than stored as a row that can never fetch. */
      console.warn(`[meta:discover] Page ${page.name || page.id} returned no access token — skipped`);
      continue;
    }

    assets.push({
      provider: 'facebook',
      uid: String(page.id),
      display: page.name || `Page ${page.id}`,
      /* Derived from a long-lived user token, so this does not expire. */
      token: page.access_token,
      expiresAt: null,
      meta: { pageId: String(page.id), pageName: page.name || null }
    });

    const ig = page.instagram_business_account;
    if (ig?.id) {
      assets.push({
        provider: 'instagram',
        uid: String(ig.id),
        display: ig.username ? '@' + ig.username : `IG ${ig.id}`,
        /* Instagram business accounts are read with the parent Page's token.
           There is no separate Instagram credential. */
        token: page.access_token,
        expiresAt: null,
        meta: { igId: String(ig.id), parentPageId: String(page.id), username: ig.username || null }
      });
    }
  }

  /* Only when ads_read was actually granted. Checked rather than assumed: the
     user can deselect it in the dialog and the grant still succeeds, and asking
     for ad accounts without it returns a confusing permissions error. */
  if (granted.has('ads_read')) {
    try {
      const { data: ads } = await call(accessToken, '/me/adaccounts', {
        fields: 'id,name,account_status,currency',
        limit: 100
      });
      for (const acct of ads?.data || []) {
        assets.push({
          provider: 'meta_ads',
          /* Already prefixed act_ by Graph. Normalised in case it is not. */
          uid: String(acct.id).startsWith('act_') ? String(acct.id) : `act_${acct.id}`,
          display: acct.name || String(acct.id),
          /* The long-lived *user* token, not a Page token: ad insights are read
             as the user, so this row is the one that needs renewing. */
          token: accessToken,
          expiresAt: null,
          meta: {
            currency: acct.currency || null,
            accountStatus: acct.account_status ?? null
          }
        });
      }
    } catch (err) {
      /* Business Verification gates ad data, and failing it must not lose the
         Pages that did discover successfully. */
      console.warn('[meta:discover] ad accounts unavailable:', err.message);
    }
  } else {
    console.log('[meta:discover] ads_read not granted — no ad accounts connected');
  }

  return assets;
}

/* ---------------------------------------------------------------------------
   Facebook Page insights.

   This comment used to say the opposite: that page_impressions was removed and
   only page_impressions_unique survived. It is the other way round.
   page_impressions_unique — reach, despite the name — is deprecated above v25,
   and page_impressions is what still answers. Getting this backwards is what
   made every Page pull fail with "(#100) The value must be a valid insights
   metric", so it is worth stating plainly rather than leaving the old wording
   to mislead the next reader.

   Also gone, in November 2025: page likes growth, and the by-language, by-city
   and by-country breakdowns. None are requested here.
   --------------------------------------------------------------------------- */

const dayString = d => d.toISOString().slice(0, 10);

/* Page metrics Meta still accepts with period=day.

   page_impressions_unique — the Page's unique-reach metric — is deprecated above
   v25, and asking for it is what failed every Page pull with
   "(#100) The value must be a valid insights metric". Nothing replaces it:
   page_impressions_paid_unique and page_impressions_viral_unique cover only paid
   and virally-amplified reach, and presenting either as "reach" would be exactly
   the relabelling this file refuses everywhere else. Page reach is therefore
   null, and the dashboard renders it as absent rather than as a measured zero.

   page_impressions is total appearances including repeats, which is the
   definition of views the Social view already states, so it fills views. */
const PAGE_METRICS = ['page_impressions', 'page_post_engagements', 'page_views_total'];

const isBadMetric = err =>
  Number(err?.code) === 100 && /valid insights metric/i.test(err?.message || '');

/* Meta retires Page metrics on a rolling calendar — another tranche landed in
   June 2026 — and the error names no metric, so a single dead entry takes the
   whole request down with it. The set is therefore probed, not trusted: ask for
   all of them, and only if Meta objects, ask for each alone and keep what
   survives. Memoised for the life of the process, so the probe costs one pass
   after a deprecation rather than one per poll. */
let pageMetricMemo = null;

async function pageInsights(token, pageId, since, until){
  const ask = metrics => call(token, `/${pageId}/insights`, {
    metric: metrics.join(','), period: 'day',
    since: dayString(since), until: dayString(until)
  });

  if (pageMetricMemo) {
    if (!pageMetricMemo.length) return [];
    return (await ask(pageMetricMemo)).data?.data || [];
  }

  try {
    const { data } = await ask(PAGE_METRICS);
    pageMetricMemo = PAGE_METRICS;
    return data?.data || [];
  } catch (err) {
    if (!isBadMetric(err)) throw err;
  }

  const good = [];
  const out = [];
  for (const m of PAGE_METRICS) {
    try {
      const { data } = await ask([m]);
      good.push(m);
      out.push(...(data?.data || []));
    } catch (err) {
      if (!isBadMetric(err)) throw err;
      console.warn(`[meta] page metric no longer accepted, dropped: ${m}`);
    }
  }
  pageMetricMemo = good;
  if (!good.length) {
    console.warn('[meta] no page insight metric is still accepted; only followers will be recorded');
  }
  return out;
}

export async function pageSeries(token, pageId, { since, until }){
  const series = await pageInsights(token, pageId, since, until);

  /* Graph returns one object per metric, each with its own values array. Folded
     into one row per day. */
  const byDay = new Map();
  for (const metric of series) {
    for (const v of metric.values || []) {
      const day = String(v.end_time || '').slice(0, 10);
      if (!day) continue;
      const row = byDay.get(day) || { day, followers: null, reach: null, views: null, interactions: null, posts: null, raw: {} };
      if (metric.name === 'page_impressions') row.views = Number(v.value) || 0;
      if (metric.name === 'page_post_engagements') row.interactions = Number(v.value) || 0;
      if (metric.name === 'page_views_total') row.raw.pageViews = Number(v.value) || 0;
      byDay.set(day, row);
    }
  }

  const { data: info } = await call(token, `/${pageId}`, { fields: 'followers_count,name' });
  const followers = Number(info?.followers_count) || 0;
  const today = dayString(until);
  const hit = byDay.get(today);
  if (hit) hit.followers = followers;
  else {
    byDay.set(today, { day: today, followers, reach: null, views: null,
      interactions: null, posts: null, raw: {} });
  }

  return {
    rows: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    info: { handle: info?.name || `Page ${pageId}`, followers }
  };
}

/* ---------------------------------------------------------------------------
   Instagram insights.

   views replaced impressions in v22.0, effective across all versions from
   21 April 2025; requests for impressions on media created after 2 July 2024
   error outright. profile_views, website_clicks, email_contacts,
   phone_call_clicks and get_directions_clicks were deprecated in the same
   version. None of them are requested here.

   Demographics need at least 100 followers before they return anything, which is
   why none are read at all in this pass.
   --------------------------------------------------------------------------- */

/* views, accounts_engaged and total_interactions accept ONLY
   metric_type=total_value, which returns one aggregate for the whole range and
   no per-day breakdown. reach is the single account metric that still supports
   time_series. Asking for all four together is what failed the pull with
   "(#100) The following metrics ... should be specified with parameter
   metric_type=total_value".

   So: reach comes back as a series in one call, and the other three are read a
   day at a time. Capped at the most recent 30 days, which covers the 7- and
   28-day ranges completely; on the 90-day range the older days carry reach but
   no views, and the chart draws those as gaps rather than as zeroes. */
const IG_TOTAL_METRICS = 'views,accounts_engaged,total_interactions';
const IG_TOTAL_DAYS = 30;

/* Instagram refuses any insights request spanning more than 30 days:
   "There cannot be more than 30 days (2592000 s) between since and until."
   The poller asks for 90, so the reach series is read in chunks. */
const IG_MAX_SPAN_DAYS = 30;

const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

export async function igSeries(token, igId, { since, until }){
  const byDay = new Map();
  const rowFor = day => {
    if (!byDay.has(day)) {
      byDay.set(day, { day, followers: null, reach: null, views: null, interactions: null, posts: null, raw: {} });
    }
    return byDay.get(day);
  };

  for (let start = since; start < until; start = addDays(start, IG_MAX_SPAN_DAYS)) {
    const stopMs = Math.min(addDays(start, IG_MAX_SPAN_DAYS).getTime(), until.getTime());
    const { data } = await call(token, `/${igId}/insights`, {
      metric: 'reach',
      metric_type: 'time_series',
      period: 'day',
      since: dayString(start),
      until: dayString(new Date(stopMs))
    });

    for (const metric of data?.data || []) {
      for (const v of metric.values || []) {
        const day = String(v.end_time || '').slice(0, 10);
        if (!day) continue;
        if (metric.name === 'reach') rowFor(day).reach = Number(v.value) || 0;
      }
    }
  }

  /* Newest first, so a rate limit part-way through leaves the most recent days
     filled rather than the oldest. */
  const floor = dayString(since);
  for (let i = 0; i < IG_TOTAL_DAYS; i++) {
    const day = addDays(until, -i);
    const key = dayString(day);
    if (key < floor) break;
    try {
      const { data: t } = await call(token, `/${igId}/insights`, {
        metric: IG_TOTAL_METRICS,
        metric_type: 'total_value',
        period: 'day',
        since: key,
        until: dayString(addDays(day, 1))
      });
      const row = rowFor(key);
      for (const metric of t?.data || []) {
        const n = Number(metric.total_value?.value) || 0;
        if (metric.name === 'views') row.views = n;
        if (metric.name === 'total_interactions') row.interactions = n;
        if (metric.name === 'accounts_engaged') row.raw.accountsEngaged = n;
      }
    } catch (err) {
      /* A rate limit stops the backfill and keeps what is already collected;
         the next pass resumes. Anything else is a real fault and propagates. */
      if (err.isRateLimit) {
        console.warn(`[meta] IG daily totals stopped at ${key}: ${err.message}`);
        break;
      }
      throw err;
    }
  }

  const { data: info } = await call(token, `/${igId}`,
    { fields: 'followers_count,media_count,username' });
  const followers = Number(info?.followers_count) || 0;
  const today = dayString(until);
  const hit = byDay.get(today);
  if (hit) { hit.followers = followers; hit.posts = Number(info?.media_count) || 0; }
  else {
    byDay.set(today, { day: today, followers, reach: null, views: null,
      interactions: null, posts: Number(info?.media_count) || 0, raw: {} });
  }

  return {
    rows: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    info: {
      handle: info?.username ? '@' + info.username : `IG ${igId}`,
      followers
    }
  };
}

export async function igPosts(token, igId, { limit = 25 } = {}){
  const { data } = await call(token, `/${igId}/media`, {
    fields: 'id,caption,permalink,timestamp,media_type',
    limit
  });

  const out = [];
  for (const m of data?.data || []) {
    let stats = {};
    try {
      const { data: ins } = await call(token, `/${m.id}/insights`,
        { metric: 'views,reach,shares,total_interactions' });
      for (const metric of ins?.data || []) {
        stats[metric.name] = Number(metric.values?.[0]?.value) || 0;
      }
    } catch (err) {
      /* Insights are unavailable on some media types and on anything older than
         the retention window. The post is still worth listing. */
      if (err.isAuth) throw err;
    }

    out.push({
      externalId: String(m.id),
      title: (m.caption || '(no caption)').replace(/\s+/g, ' ').trim().slice(0, 120),
      permalink: m.permalink || null,
      publishedAt: m.timestamp || null,
      reach: stats.reach ?? null,
      views: stats.views ?? null,
      shares: stats.shares ?? null,
      interactions: stats.total_interactions ?? null
    });
  }
  return out;
}

/* Post reach, expanded inline on the posts request.

   Inlining is worth one round trip instead of one per post, but it couples the
   two: a metric Meta has retired fails the WHOLE posts request, not just the
   stats, which is how a dead post_impressions_unique took the Page's post list
   down with it. So the expansion is attempted, and if Meta rejects the metric
   the same request is repeated without it — posts listed, reach null. Two calls
   in the worst case rather than twenty-six. */
const POST_FIELDS = 'id,message,permalink_url,created_time,shares';
const POST_INSIGHT = 'insights.metric(post_impressions_unique){values}';

export async function pagePosts(token, pageId, { limit = 25 } = {}){
  let data;
  try {
    ({ data } = await call(token, `/${pageId}/posts`, {
      fields: `${POST_FIELDS},${POST_INSIGHT}`,
      limit
    }));
  } catch (err) {
    if (!isBadMetric(err)) throw err;
    console.warn('[meta] post insight metric no longer accepted; listing posts without reach');
    ({ data } = await call(token, `/${pageId}/posts`, { fields: POST_FIELDS, limit }));
  }

  return (data?.data || []).map(p => {
    const reachMetric = (p.insights?.data || [])
      .find(m => m.name === 'post_impressions_unique');
    return {
      externalId: String(p.id),
      title: (p.message || '(no text)').replace(/\s+/g, ' ').trim().slice(0, 120),
      permalink: p.permalink_url || null,
      publishedAt: p.created_time || null,
      reach: Number(reachMetric?.values?.[0]?.value) || null,
      /* Page-level views are not exposed per post; only reach survived the
         November 2025 removals. */
      views: null,
      shares: Number(p.shares?.count) || 0,
      interactions: null
    };
  });
}

/* ---------------------------------------------------------------------------
   Ads.

   Rate limits scale with the ad account's monthly spend and arrive in
   X-Business-Use-Case-Usage. At 100% every call fails with code 17 until the
   window resets, so the header is parsed and the caller throttles at 80%.
   --------------------------------------------------------------------------- */

/* Highest utilisation across the header's accounts, as a percentage, or null when
   the header is absent. */
export function parseUsage(header){
  if (!header) return null;
  let parsed;
  try { parsed = JSON.parse(header); } catch { return null; }
  let worst = 0;
  for (const entries of Object.values(parsed || {})) {
    for (const e of entries || []) {
      worst = Math.max(worst,
        Number(e.call_count) || 0,
        Number(e.total_cputime) || 0,
        Number(e.total_time) || 0);
    }
  }
  return worst;
}

const DATE_PRESET = { 7: 'last_7d', 28: 'last_28d', 90: 'last_90d' };

/* Ads insights are NOT the organic deprecations.

   The note on ads_daily used to say impressions were "deliberately absent,
   deprecated". That is true of PAGE and INSTAGRAM impressions and false of ads:
   the Marketing API still returns impressions, clicks, ctr, cpc, cpm and
   frequency, and those are most of what a person buying ads actually reads.
   Conflating the two cost this dashboard every efficiency metric it has.

   RICH is what we want; CORE is what an ads account is guaranteed to answer.
   Probed the same way page metrics are, so a field Meta retires costs one pass
   rather than the whole pull. */
const ADS_CORE = 'campaign_id,campaign_name,objective,spend,reach,actions,account_currency';
const ADS_RICH = ADS_CORE + ',impressions,clicks,ctr,cpc,cpm,frequency,inline_link_clicks';

const isBadField = err =>
  Number(err?.code) === 100 && /(valid|unknown|nonexisting) field|does not exist/i.test(err?.message || '');

let adsFieldMemo = null;

export async function adsInsights(token, actId, { days = 90 } = {}){
  const preset = DATE_PRESET[days] || 'last_90d';

  /* time_increment=1 is the whole point of this rewrite. Without it Meta returns
     ONE aggregate row per campaign for the range, which is why every pull wrote
     a single row stamped with the pull date and the chart drew one bar covering
     28 days of activity. With it, one row per campaign PER DAY, stamped with the
     day the delivery actually happened. */
  const ask = fields => call(token, `/${actId}/insights`, {
    fields,
    date_preset: preset,
    level: 'campaign',
    time_increment: 1,
    limit: 500
  });

  let data, usage;
  if (adsFieldMemo) {
    ({ data, usage } = await ask(adsFieldMemo));
  } else {
    try {
      ({ data, usage } = await ask(ADS_RICH));
      adsFieldMemo = ADS_RICH;
    } catch (err) {
      if (!isBadField(err)) throw err;
      console.warn('[meta] ads: a rich insight field was rejected, falling back to core fields');
      ({ data, usage } = await ask(ADS_CORE));
      adsFieldMemo = ADS_CORE;
    }
  }

  /* "Results" is whatever the campaign optimises for, so it is read from the
     actions breakdown rather than assumed to be one action type. Lead-shaped
     actions first, falling back to the total. */
  const LEADISH = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead',
                   'onsite_web_lead', 'leadgen_grouped'];

  const resultsOf = actions => {
    if (!Array.isArray(actions)) return 0;
    const lead = actions
      .filter(a => LEADISH.includes(a.action_type))
      .reduce((n, a) => n + (Number(a.value) || 0), 0);
    if (lead) return lead;
    const conv = actions.find(a => a.action_type === 'offsite_conversion');
    return Number(conv?.value) || 0;
  };

  const n = v => Number(v) || 0;

  /* One row per campaign per day. date_start is the delivery day, which is the
     column the chart plots — not the day we happened to ask. */
  const rows = (data?.data || []).map(row => ({
    day: String(row.date_start || '').slice(0, 10),
    campaignId: String(row.campaign_id || ''),
    name: row.campaign_name || '(unnamed campaign)',
    objective: row.objective || '',
    spend: n(row.spend),
    reach: n(row.reach),
    impressions: n(row.impressions),
    clicks: n(row.clicks),
    linkClicks: n(row.inline_link_clicks),
    /* ctr, cpc, cpm and frequency are returned per row, but they are ratios and
       cannot be summed across days or campaigns. They are recomputed from the
       totals wherever an aggregate is shown; these are kept only so a single
       day's row is complete. */
    ctr: n(row.ctr),
    cpc: n(row.cpc),
    cpm: n(row.cpm),
    frequency: n(row.frequency),
    results: resultsOf(row.actions),
    currency: row.account_currency || null
  })).filter(r => r.day);

  return {
    rows,
    usagePercent: parseUsage(usage),
    currency: rows.find(r => r.currency)?.currency || null
  };
}

/* Ad accounts have a status; a disabled one is worth reporting rather than
   polling forever. 1 = active, 2 = disabled, 3 = unsettled. */
export const adAccountActive = status => status == null || Number(status) === 1;
