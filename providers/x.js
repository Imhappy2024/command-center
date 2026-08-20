/* X, formerly Twitter.

   The thing to keep in mind here is cost, not quota. There has been no free tier
   since February 2026 and reads bill at $0.005 each. Every call in this file
   spends money, which drives three rules:

     - Nothing is ever called from a request handler. The read routes serve
       social_metrics and social_posts; this module runs only from the poller.
     - Responses are cached for at least CACHE_MS, so a poller misconfigured to
       run every minute cannot quietly run up a bill.
     - Every call is counted into sync_state, so the spend is visible in the
       dashboard's own tables rather than arriving as a surprise on the invoice.

   Two API mechanics differ from every other provider here: PKCE is mandatory
   rather than belt-and-braces, and the token endpoint wants HTTP Basic auth with
   the client id and secret rather than credentials in the body. X also rotates
   the refresh token on every renewal, the same way Microsoft does — which the
   shared refreshTokens() already handles by persisting whatever comes back. */

const API = 'https://api.twitter.com/2';

/* Fifteen minutes is the floor named in the brief. Kept in-process: it exists to
   stop repeated polls inside one window from billing twice, not to be a durable
   cache — the durable copy is social_metrics. */
const CACHE_MS = 15 * 60_000;
const cache = new Map();

/* Counted per call so cost is observable. The poller flushes this into
   sync_state; see lib/social-sync.js. */
let billedCalls = 0;
export const billed = () => billedCalls;
export const resetBilled = () => { billedCalls = 0; };

const COST_PER_READ_USD = 0.005;
export const estimatedSpend = calls => calls * COST_PER_READ_USD;

async function call(token, path, params = {}){
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const url = `${API}${path}${qs.toString() ? '?' + qs : ''}`;

  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  billedCalls++;

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = json?.detail || json?.title || res.statusText;
    const err = new Error(`X ${res.status}: ${detail}`);
    err.isAuth = res.status === 401;
    /* 429 here is a rate limit, not a spend cap; the poller backs off rather than
       flagging the account. */
    err.isRateLimit = res.status === 429;
    throw err;
  }

  cache.set(url, { at: Date.now(), value: json });
  return json;
}

/* The token endpoint needs Basic auth rather than client credentials in the body,
   which is why this cannot use the shared postForm(). */
function basicAuth(env){
  return 'Basic ' + Buffer
    .from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`, 'utf8')
    .toString('base64');
}

export async function exchange(env, { code, redirect, verifier }){
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(env),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirect,
      code_verifier: verifier,
      client_id: env.X_CLIENT_ID
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`X ${res.status}: ${json.error_description || json.error || res.statusText}`);
  return json;
}

export async function refresh(env, refreshToken){
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(env),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      client_id: env.X_CLIENT_ID
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`X ${res.status}: ${json.error_description || json.error || res.statusText}`);
  return {
    accessToken: json.access_token,
    /* X rotates this on every renewal and invalidates the previous one, so the
       new value has to be persisted or the next refresh fails. */
    refreshToken: json.refresh_token || refreshToken,
    expiresAt: Date.now() + ((Number(json.expires_in) || 7200) - 60) * 1000,
    scope: json.scope || null
  };
}

export async function identify(accessToken){
  const j = await call(accessToken, '/users/me',
    { 'user.fields': 'public_metrics,username' });
  const u = j?.data;
  if (!u?.id) throw new Error('X /users/me returned no id');
  return { uid: String(u.id), email: u.username ? '@' + u.username : String(u.id) };
}

/* ---------------------------------------------------------------------------
   Metrics.

   X publishes no historical series for followers on this tier, so there is one
   row: today. Reach does not exist in its API at all — impression_count is a
   per-post figure and is not a unique-account measure, so it is not folded in
   under a reach label.
   --------------------------------------------------------------------------- */

export async function series(token, { until }){
  const j = await call(token, '/users/me',
    { 'user.fields': 'public_metrics,username' });
  const m = j?.data?.public_metrics || {};

  return {
    rows: [{
      day: until.toISOString().slice(0, 10),
      followers: Number(m.followers_count) || 0,
      reach: null,
      views: null,
      interactions: null,
      posts: Number(m.tweet_count) || 0,
      raw: { following: m.following_count ?? null, listed: m.listed_count ?? null }
    }],
    info: {
      handle: j?.data?.username ? '@' + j.data.username : String(j?.data?.id || ''),
      followers: Number(m.followers_count) || 0,
      userId: String(j?.data?.id || '')
    }
  };
}

export async function recentPosts(token, { userId, limit = 20 } = {}){
  if (!userId) return [];
  const j = await call(token, `/users/${encodeURIComponent(userId)}/tweets`, {
    max_results: Math.max(5, Math.min(100, limit)),
    'tweet.fields': 'public_metrics,created_at'
  });

  return (j?.data || []).map(t => {
    const m = t.public_metrics || {};
    return {
      externalId: String(t.id),
      title: String(t.text || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(no text)',
      permalink: `https://x.com/i/status/${t.id}`,
      publishedAt: t.created_at || null,
      /* impression_count is not unique accounts, so it is reported as views and
         reach is left absent rather than relabelled. */
      reach: null,
      views: Number(m.impression_count) || null,
      shares: Number(m.retweet_count) || 0,
      interactions: (Number(m.like_count) || 0)
                  + (Number(m.reply_count) || 0)
                  + (Number(m.quote_count) || 0)
    };
  });
}
