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

/* ---------------------------------------------------------------------------
   Comments and messages.

   Four different things behind one Graph API, and they need four different
   permissions, which is why every function here reports WHICH permission it
   was refused for rather than a bare 403:

     Facebook comments   pages_read_engagement to read the Page's own posts,
                         pages_read_user_content to read what other people
                         wrote on them, pages_manage_engagement to reply or
                         like.
     Instagram comments  instagram_manage_comments. instagram_basic reads the
                         media and the comments_count but NOT the comment text
                         -- the count comes back and the comments edge comes
                         back empty, which looks exactly like a post with no
                         comments and is the most misleading failure in here.
     Facebook messages   pages_messaging.
     Instagram messages  instagram_manage_messages, and the app itself needs
                         the Instagram messaging capability -- a scope alone is
                         not enough, and the refusal is "Application does not
                         have the capability to make this API call" rather than
                         a permission error.

   Reactions: a Facebook comment can be liked (POST /{comment-id}/likes) and an
   Instagram comment cannot -- Instagram's Graph API has no like endpoint for
   comments at all. Message reactions are not writable either. Rather than
   guess, capability is declared in lib/social-inbox.js and the UI hides what
   the platform does not offer.
   --------------------------------------------------------------------------- */

/* A permission failure worth translating. Meta's code 200 covers every "you
   need a permission for that", and its message names the permission when the
   caller has a Page role and does not when it is an app-level capability. */
function inboxError(err, { need, what }){
  const msg = String(err.message || '');
  if (err.code === 200 || err.code === 3 || /Requires .*permission|capability/i.test(msg)) {
    const out = new Error(`${what} needs the ${need} permission, which this Meta `
      + `connection does not carry. Reconnect Meta in Connections to grant it.`);
    out.needsScope = need;
    out.original = msg;
    return out;
  }
  return err;
}

/* One POST to Graph. Writes take their parameters as a form body rather than a
   query string: a comment can be longer than a URL. */
async function post(token, path, params = {}){
  const body = new URLSearchParams({ access_token: token });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    body.set(k, String(v));
  }
  const res = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) {
    const e = json?.error || {};
    const err = new Error(`Meta ${res.status}: ${e.message || res.statusText}`);
    err.code = e.code;
    err.subcode = e.error_subcode;
    err.isAuth = e.code === 190;
    throw err;
  }
  return json;
}

const COMMENT_FIELDS = 'id,message,created_time,like_count,user_likes,parent{id},'
  + 'from{id,name,picture{url}},attachment';

function fbCommentOut(c, { threadId, pageId }){
  const from = c.from || {};
  return {
    externalId: c.id,
    threadExternalId: threadId || c.parent?.id || c.id,
    replyTo: c.parent?.id || null,
    authorId: from.id || null,
    authorName: from.name || 'Someone on Facebook',
    authorAvatar: from.picture?.data?.url || null,
    /* The Page replying to a comment appears as the Page. By id, because a Page
       and a person can share a name. */
    mine: Boolean(pageId && from.id && String(from.id) === String(pageId)),
    body: c.message || '',
    likes: Number(c.like_count) || 0,
    likedByUs: Boolean(c.user_likes),
    createdAt: c.created_time || null,
    attachments: c.attachment ? [{
      kind: c.attachment.type || 'file',
      url: c.attachment.url || c.attachment.media?.image?.src || null
    }] : []
  };
}

/* Comment threads on a Page's own posts.

   One comment thread per top-level comment, which is how Facebook models it and
   how the reader thinks about it: the post is the place, the top-level comment
   starts a conversation, and replies hang off that.

   filter=stream would flatten replies into the top-level list; toplevel keeps
   the shape. */
export async function pageComments(token, pageId, { since = null, posts = 25 } = {}){
  let feed;
  try {
    ({ data: feed } = await call(token, `/${pageId}/posts`, {
      fields: `id,message,story,created_time,permalink_url,`
        + `comments.filter(toplevel).order(reverse_chronological).limit(50)`
        + `{${COMMENT_FIELDS},comments.limit(25){${COMMENT_FIELDS}}}`,
      limit: posts
    }));
  } catch (err) {
    throw inboxError(err, { need: 'pages_read_user_content', what: 'Reading Facebook comments' });
  }

  const cutoff = since ? Date.parse(since) : null;
  const threads = [];
  for (const p of feed?.data || []) {
    const title = (p.message || p.story || '').replace(/\s+/g, ' ').trim();
    for (const c of p.comments?.data || []) {
      const items = [fbCommentOut(c, { threadId: c.id, pageId })];
      for (const r of c.comments?.data || []) {
        items.push(fbCommentOut(r, { threadId: c.id, pageId }));
      }
      items.sort((a, b) => String(a.createdAt) < String(b.createdAt) ? -1 : 1);
      const last = Date.parse(items[items.length - 1].createdAt || 0);
      if (cutoff && isFinite(last) && last <= cutoff) continue;

      threads.push({
        externalId: c.id,
        parentKind: 'post',
        parentId: p.id,
        parentTitle: title || 'A post with no caption',
        parentLink: p.permalink_url || null,
        totalItems: items.length,
        canReply: true,
        items
      });
    }
  }
  threads.sort((a, b) => {
    const la = a.items[a.items.length - 1].createdAt || '';
    const lb = b.items[b.items.length - 1].createdAt || '';
    return la < lb ? 1 : la > lb ? -1 : 0;
  });
  /* How many posts were looked at, so the caller can tell "no comments" apart
     from "no posts to have comments on". */
  threads.postsSeen = (feed?.data || []).length;
  return threads;
}

function igCommentOut(c, { threadId, igId, username }){
  const who = c.from?.username || c.username || null;
  return {
    externalId: c.id,
    threadExternalId: threadId || c.id,
    replyTo: threadId && threadId !== c.id ? threadId : null,
    authorId: c.from?.id || null,
    authorName: who ? '@' + who : 'Someone on Instagram',
    authorAvatar: null,
    /* Instagram gives the commenter's username but not always an id, so this is
       the one place a name comparison is the only option available -- and it is
       comparing against the connected account's own handle, which is unique on
       Instagram in a way a display name is not. */
    mine: Boolean(c.from?.id && igId && String(c.from.id) === String(igId))
      || Boolean(username && who && who.toLowerCase() === String(username).toLowerCase()),
    body: c.text || '',
    likes: Number(c.like_count) || 0,
    likedByUs: false,
    createdAt: c.timestamp || null,
    attachments: []
  };
}

/* Comment threads on an Instagram account's own media.

   comments_count is readable with instagram_basic and the comment TEXT is not,
   so a grant without instagram_manage_comments returns media with a count of 4
   and an empty comments edge. That is not an error and does not throw, which
   would leave the reader looking at "no comments" on a post that has four --
   so the count is carried through as `missingText` and the caller says why. */
export async function igComments(token, igId, { since = null, media = 25, username = null } = {}){
  let feed;
  try {
    ({ data: feed } = await call(token, `/${igId}/media`, {
      fields: 'id,caption,timestamp,permalink,media_type,comments_count,'
        + 'comments.limit(50){id,text,timestamp,like_count,username,from{id,username},'
        + 'replies.limit(25){id,text,timestamp,like_count,username,from{id,username}}}',
      limit: media
    }));
  } catch (err) {
    throw inboxError(err, { need: 'instagram_manage_comments', what: 'Reading Instagram comments' });
  }

  const cutoff = since ? Date.parse(since) : null;
  const threads = [];
  let counted = 0, read = 0;

  for (const m of feed?.data || []) {
    counted += Number(m.comments_count) || 0;
    const title = String(m.caption || '').replace(/\s+/g, ' ').trim();
    for (const c of m.comments?.data || []) {
      read++;
      const items = [igCommentOut(c, { threadId: c.id, igId, username })];
      for (const r of c.replies?.data || []) {
        read++;
        items.push(igCommentOut(r, { threadId: c.id, igId, username }));
      }
      items.sort((a, b) => String(a.createdAt) < String(b.createdAt) ? -1 : 1);
      const last = Date.parse(items[items.length - 1].createdAt || 0);
      if (cutoff && isFinite(last) && last <= cutoff) continue;

      threads.push({
        externalId: c.id,
        parentKind: 'media',
        parentId: m.id,
        parentTitle: title || (m.media_type === 'VIDEO' ? 'A reel with no caption' : 'A post with no caption'),
        parentLink: m.permalink || null,
        totalItems: items.length,
        canReply: true,
        items
      });
    }
  }
  threads.sort((a, b) => {
    const la = a.items[a.items.length - 1].createdAt || '';
    const lb = b.items[b.items.length - 1].createdAt || '';
    return la < lb ? 1 : la > lb ? -1 : 0;
  });
  /* Non-throwing evidence that the read was silently partial, plus what was
     looked at -- the caller needs to tell "no comments" apart from "comments
     exist and Instagram would not hand them over". */
  threads.missingText = counted > read ? counted - read : 0;
  threads.mediaSeen = (feed?.data || []).length;
  threads.counted = counted;
  threads.read = read;
  return threads;
}

/* A reply to a comment. Facebook and Instagram take different edges: a
   Facebook comment has its own comments edge, an Instagram comment has replies.
   Both accept a message field. */
export async function replyToComment(token, { platform, commentId, text, pageId = null, igId = null, username = null }){
  const body = String(text || '').trim();
  if (!body) throw new Error('A reply cannot be empty.');
  const edge = platform === 'instagram' ? 'replies' : 'comments';
  const need = platform === 'instagram' ? 'instagram_manage_comments' : 'pages_manage_engagement';
  let j;
  try {
    j = await post(token, `/${commentId}/${edge}`, { message: body });
  } catch (err) {
    throw inboxError(err, { need, what: 'Replying to a comment' });
  }
  /* Graph returns only the new id. Re-reading it costs one call and is what
     makes the posted reply appear with the right author and timestamp instead
     of a locally invented one. */
  return readComment(token, j.id, { platform, pageId, igId, username })
    .catch(() => ({
      externalId: j.id,
      threadExternalId: commentId,
      replyTo: commentId,
      authorId: platform === 'instagram' ? igId : pageId,
      authorName: 'You',
      mine: true,
      body,
      likes: 0,
      likedByUs: false,
      createdAt: new Date().toISOString(),
      attachments: []
    }));
}

/* A new top-level comment on one of the account's own posts. */
export async function commentOnPost(token, { platform, postId, text, pageId = null, igId = null, username = null }){
  const body = String(text || '').trim();
  if (!body) throw new Error('A comment cannot be empty.');
  const need = platform === 'instagram' ? 'instagram_manage_comments' : 'pages_manage_engagement';
  let j;
  try {
    j = await post(token, `/${postId}/comments`, { message: body });
  } catch (err) {
    throw inboxError(err, { need, what: 'Posting a comment' });
  }
  const item = await readComment(token, j.id, { platform, pageId, igId, username }).catch(() => null);
  return {
    thread: { externalId: j.id, parentKind: platform === 'instagram' ? 'media' : 'post',
      parentId: postId, totalItems: 1, canReply: true },
    item: item || {
      externalId: j.id, threadExternalId: j.id, replyTo: null,
      authorId: platform === 'instagram' ? igId : pageId, authorName: 'You',
      mine: true, body, likes: 0, likedByUs: false,
      createdAt: new Date().toISOString(), attachments: []
    }
  };
}

export async function readComment(token, commentId, { platform, pageId = null, igId = null, username = null }){
  if (platform === 'instagram') {
    const { data } = await call(token, `/${commentId}`, {
      fields: 'id,text,timestamp,like_count,username,from{id,username}'
    });
    return igCommentOut(data, { threadId: null, igId, username });
  }
  const { data } = await call(token, `/${commentId}`, { fields: COMMENT_FIELDS });
  return fbCommentOut(data, { threadId: null, pageId });
}

/* Liking a comment, which exists on Facebook and does not exist on Instagram.

   Instagram's Graph API has no like endpoint for comments -- not an undocumented
   one, not a different edge, none. Called for Instagram this refuses locally
   rather than sending a request that returns a confusing 400. */
export async function likeComment(token, { platform, commentId, on = true }){
  if (platform === 'instagram') {
    throw new Error('Instagram has no API for liking a comment. It can be replied to, '
      + 'hidden or deleted, and liking is only possible in the Instagram app itself.');
  }
  try {
    if (on) await post(token, `/${commentId}/likes`, {});
    else {
      const res = await fetch(`${GRAPH}/${commentId}/likes?access_token=${encodeURIComponent(token)}`,
        { method: 'DELETE' });
      const j = await res.json().catch(() => null);
      if (!res.ok || j?.error) {
        const e = j?.error || {};
        const err = new Error(`Meta ${res.status}: ${e.message || res.statusText}`);
        err.code = e.code;
        throw err;
      }
    }
  } catch (err) {
    throw inboxError(err, { need: 'pages_manage_engagement', what: 'Liking a comment' });
  }
  return { commentId, liked: on };
}

export async function hideComment(token, { commentId, hidden = true }){
  try {
    await post(token, `/${commentId}`, { is_hidden: hidden ? 'true' : 'false' });
  } catch (err) {
    throw inboxError(err, { need: 'pages_manage_engagement', what: 'Hiding a comment' });
  }
  return { commentId, hidden };
}

export async function deleteComment(token, commentId){
  const res = await fetch(`${GRAPH}/${commentId}?access_token=${encodeURIComponent(token)}`,
    { method: 'DELETE' });
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.error) {
    const e = j?.error || {};
    const err = new Error(`Meta ${res.status}: ${e.message || res.statusText}`);
    err.code = e.code;
    throw inboxError(err, { need: 'pages_manage_engagement', what: 'Deleting a comment' });
  }
  return { deleted: commentId };
}

/* ---------------------------------------------------------------------------
   Messages.
   --------------------------------------------------------------------------- */

const MSG_FIELDS = 'id,message,created_time,from{id,name,email},to{data{id,name}},'
  + 'attachments{name,mime_type,image_data,file_url},sticker';

function msgOut(m, { threadId, selfIds }){
  const from = m.from || {};
  const atts = (m.attachments?.data || []).map(a => ({
    kind: a.mime_type && /^image\//.test(a.mime_type) ? 'image' : (a.mime_type || 'file'),
    name: a.name || null,
    url: a.image_data?.url || a.file_url || null
  }));
  if (m.sticker) atts.push({ kind: 'sticker', url: m.sticker, name: null });
  return {
    externalId: m.id,
    threadExternalId: threadId,
    replyTo: null,
    authorId: from.id || null,
    authorName: from.name || 'Unknown',
    authorAvatar: null,
    mine: Boolean(from.id && selfIds.has(String(from.id))),
    body: m.message || '',
    likes: 0,
    likedByUs: false,
    createdAt: m.created_time || null,
    attachments: atts
  };
}

/* Conversations for a Page, or for an Instagram account under that Page.

   One request per property, with the messages inline: a second call per thread
   would be one request per conversation and Meta's rate limits are per app, not
   per thread.

   `platform=instagram` on the same edge is how Instagram DMs are read -- there
   is no separate Instagram conversations endpoint, and the id in the path is
   still the PAGE, not the Instagram account. Getting that wrong returns an
   empty list rather than an error, which reads as "no messages". */
export async function conversations(token, { pageId, platform = 'facebook', igId = null, limit = 40, messages = 25 } = {}){
  const need = platform === 'instagram' ? 'instagram_manage_messages' : 'pages_messaging';
  let data;
  try {
    ({ data } = await call(token, `/${pageId}/conversations`, {
      platform: platform === 'instagram' ? 'instagram' : undefined,
      fields: `id,updated_time,message_count,unread_count,`
        + `participants{id,name,username,email},`
        + `messages.limit(${messages}){${MSG_FIELDS}}`,
      limit
    }));
  } catch (err) {
    throw inboxError(err, {
      need,
      what: platform === 'instagram' ? 'Reading Instagram messages' : 'Reading Facebook messages'
    });
  }

  /* Which participant is us. Both ids are checked because a Page conversation
     lists the Page and an Instagram conversation lists the Instagram account,
     and a thread can list either depending on the edge. */
  const selfIds = new Set([String(pageId), igId ? String(igId) : null].filter(Boolean));

  return (data?.data || []).map(c => {
    const people = c.participants?.data || [];
    const them = people.find(p => !selfIds.has(String(p.id))) || people[0] || {};
    const items = (c.messages?.data || [])
      .map(m => msgOut(m, { threadId: c.id, selfIds }))
      .sort((a, b) => String(a.createdAt) < String(b.createdAt) ? -1 : 1);
    return {
      externalId: c.id,
      parentKind: null,
      parentId: null,
      parentTitle: null,
      parentLink: null,
      withId: them.id || null,
      withName: them.name || (them.username ? '@' + them.username : 'Unknown'),
      totalItems: Number(c.message_count) || items.length,
      unread: Number(c.unread_count) > 0,
      canReply: true,
      items
    };
  });
}

/* Sending. The recipient is the person's scoped id, which comes off the
   conversation's participants rather than from anywhere the user types.

   The 24-hour rule is Meta's, not this app's: outside the window since the
   person's last message a plain reply is refused, and only a message tagged as
   HUMAN_AGENT (itself a reviewed feature) or one of the other tags gets
   through. That refusal is translated, because "This message is sent outside of
   allowed window" is otherwise read as a bug here. */
export async function sendMessage(token, {
  pageId, recipientId, text, platform = 'facebook', replyTo = null
}){
  const body = String(text || '').trim();
  if (!body) throw new Error('A message cannot be empty.');
  if (!recipientId) throw new Error('No recipient on that conversation.');
  const need = platform === 'instagram' ? 'instagram_manage_messages' : 'pages_messaging';
  try {
    /* reply_to quotes a specific earlier message, which is what makes a reply
       in a long thread land against the thing it answers rather than at the
       bottom. Both platforms take it; the id is the platform's own mid. */
    const message = { text: body };
    if (replyTo) message.reply_to = { mid: String(replyTo) };

    const j = await post(token, `/${pageId}/messages`, {
      recipient: JSON.stringify({ id: recipientId }),
      messaging_type: 'RESPONSE',
      message: JSON.stringify(message)
    });
    return { externalId: j.message_id || null, recipientId, body };
  } catch (err) {
    if (/outside of allowed window|outside the allowed window/i.test(String(err.message))) {
      throw new Error('Meta will not deliver this: more than 24 hours have passed since '
        + 'their last message, and outside that window a Page can only send with an '
        + 'approved message tag. Reply from the Meta inbox for this one.');
    }
    throw inboxError(err, { need, what: 'Sending a message' });
  }
}

/* Reacting to a message.

   Both platforms take this, on the same edge as a message: sender_action
   "react" with the message id and a reaction, and "unreact" with the id alone
   to take it back. The named set below is the one Messenger itself shows;
   Instagram additionally accepts an arbitrary emoji, which is not used here
   because a reaction that only works on one of the two platforms is a control
   that fails half the time.

   Note this is the message equivalent of likeComment() above, and they are NOT
   the same call: a comment like is an edge on the comment, a message reaction
   is a sender_action on the conversation. */
export const MESSAGE_REACTIONS = ['love', 'haha', 'wow', 'sad', 'angry', 'like', 'dislike'];

export async function reactToMessage(token, {
  pageId, recipientId, messageId, reaction = null, platform = 'facebook'
}){
  if (!messageId) throw new Error('Which message?');
  if (!recipientId) throw new Error('No recipient on that conversation.');
  if (reaction && !MESSAGE_REACTIONS.includes(reaction)) {
    throw new Error(`${reaction} is not a reaction Meta accepts on both platforms. `
      + `It takes ${MESSAGE_REACTIONS.join(', ')}.`);
  }
  const need = platform === 'instagram' ? 'instagram_manage_messages' : 'pages_messaging';
  try {
    await post(token, `/${pageId}/messages`, {
      recipient: JSON.stringify({ id: recipientId }),
      sender_action: reaction ? 'react' : 'unreact',
      payload: JSON.stringify(reaction
        ? { message_id: messageId, reaction }
        : { message_id: messageId })
    });
    return { messageId, reaction };
  } catch (err) {
    if (/outside of allowed window|outside the allowed window/i.test(String(err.message))) {
      throw new Error('Meta will not take this: their last message was more than 24 hours '
        + 'ago, and a Page can only act inside that window without an approved tag.');
    }
    throw inboxError(err, { need, what: 'Reacting to a message' });
  }
}

/* Marking a conversation read. sender_action is the same edge as a message and
   is what the Messenger platform offers instead of a read flag on the thread. */
export async function markConversationRead(token, { pageId, recipientId }){
  try {
    await post(token, `/${pageId}/messages`, {
      recipient: JSON.stringify({ id: recipientId }),
      sender_action: 'mark_seen'
    });
    return { ok: true };
  } catch (err) {
    /* Not worth failing a read for. */
    return { ok: false, error: err.message };
  }
}

/* Sending a file: a photo, a voice note, a video, anything.

   Two different mechanisms, because the two platforms genuinely differ.

     Facebook  multipart/form-data straight to the Send API. The bytes go up
               with the request and Meta hosts them. No public URL needed,
               which matters because this dashboard has nowhere to put one.
     Instagram URL only. Instagram's messaging API will not take an upload; it
               fetches the media from a URL you give it, so a file picked off
               somebody's desktop cannot be sent unless this app is reachable
               from the internet and serves it. That refusal is explicit rather
               than a confusing 400 from Graph.

   Node's own FormData and Blob are used rather than a multipart library: the
   whole job is one field with a filename, and a dependency for that is a
   dependency to keep updated forever. */
const SEND_KINDS = new Set(['image', 'audio', 'video', 'file']);

export async function sendAttachment(token, {
  pageId, recipientId, kind, filename, mime, bytes, url = null, platform = 'facebook'
}){
  if (!SEND_KINDS.has(kind)) throw new Error(`${kind} is not a kind of attachment Meta accepts.`);
  if (!recipientId) throw new Error('No recipient on that conversation.');

  /* By URL, when there is one. Documented for image, audio, video and file, and
     it is the only route Instagram offers -- so a pasted GIF link works on both
     platforms with the same call. */
  if (url) {
    const j = await post(token, `/${pageId}/messages`, {
      recipient: JSON.stringify({ id: recipientId }),
      message: JSON.stringify({ attachment: { type: kind, payload: { url } } })
    });
    return { externalId: j.message_id || null, kind, url };
  }

  if (platform === 'instagram') {
    throw new Error('Instagram will not accept an uploaded file: its messaging API fetches '
      + 'media from a public URL instead, and this dashboard has no public address to '
      + 'serve one from. Paste a link to the file, or send it from the Instagram app.');
  }

  const form = new FormData();
  form.set('recipient', JSON.stringify({ id: recipientId }));
  form.set('message', JSON.stringify({
    attachment: { type: kind, payload: { is_reusable: false } }
  }));
  form.set('filedata', new Blob([bytes], { type: mime || 'application/octet-stream' }),
    filename || 'upload');
  form.set('access_token', token);

  const res = await fetch(`${GRAPH}/${pageId}/messages`, { method: 'POST', body: form });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) {
    const e = json?.error || {};
    if (/outside of allowed window|outside the allowed window/i.test(e.message || '')) {
      throw new Error('Meta will not deliver this: more than 24 hours have passed since their '
        + 'last message, and outside that window a Page can only send with an approved '
        + 'message tag.');
    }
    const err = new Error(`Meta ${res.status}: ${e.message || res.statusText}`);
    err.code = e.code;
    throw inboxError(err, {
      need: platform === 'instagram' ? 'instagram_manage_messages' : 'pages_messaging',
      what: 'Sending an attachment'
    });
  }
  return { externalId: json.message_id || null, attachmentId: json.attachment_id || null, kind };
}
