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

   page_impressions_unique is the *reach* metric, despite the name. The plain
   page_impressions variant is the one removed in November 2025, along with page
   likes growth and the by-language, by-city and by-country breakdowns. Only reach
   survives at page level.
   --------------------------------------------------------------------------- */

const dayString = d => d.toISOString().slice(0, 10);

export async function pageSeries(token, pageId, { since, until }){
  const { data } = await call(token, `/${pageId}/insights`, {
    metric: 'page_impressions_unique,page_post_engagements',
    period: 'day',
    since: dayString(since),
    until: dayString(until)
  });

  /* Graph returns one object per metric, each with its own values array. Folded
     into one row per day. */
  const byDay = new Map();
  for (const metric of data?.data || []) {
    for (const v of metric.values || []) {
      const day = String(v.end_time || '').slice(0, 10);
      if (!day) continue;
      const row = byDay.get(day) || { day, followers: null, reach: null, views: null, interactions: null, posts: null, raw: {} };
      if (metric.name === 'page_impressions_unique') row.reach = Number(v.value) || 0;
      if (metric.name === 'page_post_engagements') row.interactions = Number(v.value) || 0;
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

export async function igSeries(token, igId, { since, until }){
  const { data } = await call(token, `/${igId}/insights`, {
    metric: 'reach,views,accounts_engaged,total_interactions',
    period: 'day',
    since: dayString(since),
    until: dayString(until)
  });

  const byDay = new Map();
  for (const metric of data?.data || []) {
    for (const v of metric.values || []) {
      const day = String(v.end_time || '').slice(0, 10);
      if (!day) continue;
      const row = byDay.get(day) || { day, followers: null, reach: null, views: null, interactions: null, posts: null, raw: {} };
      const n = Number(v.value) || 0;
      if (metric.name === 'reach') row.reach = n;
      if (metric.name === 'views') row.views = n;
      if (metric.name === 'total_interactions') row.interactions = n;
      if (metric.name === 'accounts_engaged') row.raw.accountsEngaged = n;
      byDay.set(day, row);
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

export async function pagePosts(token, pageId, { limit = 25 } = {}){
  const { data } = await call(token, `/${pageId}/posts`, {
    fields: 'id,message,permalink_url,created_time,shares,'
      + 'insights.metric(post_impressions_unique){values}',
    limit
  });

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

export async function adsInsights(token, actId, { days = 28 } = {}){
  const preset = DATE_PRESET[days] || 'last_28d';

  const { data, usage } = await call(token, `/${actId}/insights`, {
    fields: 'campaign_id,campaign_name,objective,spend,reach,actions,account_currency',
    date_preset: preset,
    level: 'campaign',
    limit: 200
  });

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

  const campaigns = (data?.data || []).map(row => ({
    campaignId: String(row.campaign_id || ''),
    name: row.campaign_name || '(unnamed campaign)',
    objective: row.objective || '',
    spend: Number(row.spend) || 0,
    reach: Number(row.reach) || 0,
    results: resultsOf(row.actions),
    currency: row.account_currency || null
  }));

  return {
    campaigns,
    usagePercent: parseUsage(usage),
    /* Account-level roll-up summed from the campaign rows rather than fetched
       again. One request instead of two, and the numbers cannot disagree. */
    rollup: campaigns.reduce((acc, c) => ({
      spend: acc.spend + c.spend,
      reach: acc.reach + c.reach,
      results: acc.results + c.results,
      currency: c.currency || acc.currency
    }), { spend: 0, reach: 0, results: 0, currency: null })
  };
}

/* Ad accounts have a status; a disabled one is worth reporting rather than
   polling forever. 1 = active, 2 = disabled, 3 = unsettled. */
export const adAccountActive = status => status == null || Number(status) === 1;
