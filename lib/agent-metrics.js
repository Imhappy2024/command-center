/* Shaping a metrics payload for an analyst agent, in one place.

   Two callers need exactly the same shape and they run in different processes:
   tools/agent-mcp.mjs, when the agent asks for numbers mid-conversation, and
   routes/claude.js, when the Analyze button pulls them before the turn starts.
   Two copies of this would drift, and the drift would show up as an agent whose
   opening analysis and follow-up answers disagree about the same window.

   Three jobs:
     compact()   - trim a platform payload to what an analysis needs, and say
                   what was dropped rather than truncating in the middle of an
                   array.
     summarise() - the handful of headline counts worth storing per pull, so the
                   NEXT pull can be compared against this one.
     compare()   - that comparison, as plain rows rather than prose. */

const n = v => (v == null ? null : Number(v));
const sum = (xs, f) => xs.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const pct = (now, then) => (then ? ((now - then) / Math.abs(then)) * 100 : null);

/* A metrics payload is far too big to hand a model whole -- 90 days of rows per
   campaign per account. This keeps the parts an analysis needs and says what it
   dropped. */
export function compact(platform, j){
  if (!j || j.connected === false) {
    return { platform, connected: false,
      reason: j?.grantConnected === false
        ? 'No account of this kind is connected in the dashboard.'
        : 'Connected, but no account rows were found.' };
  }
  const out = {
    platform, range: j.range,
    accounts: (j.accounts || []).map(a => ({ id: a.id, label: a.label, status: a.status }))
  };

  if (j.ads) {
    const a = j.ads;
    out.currency = a.currency;
    out.totals = a.totals;
    out.previousWindow = a.previous;
    out.campaigns = (a.campaigns || []).map(c => ({
      name: c.name, account: c.account, objective: c.objective, status: c.status,
      spend: c.spend, impressions: c.impressions, clicks: c.clicks, results: c.results,
      ctr: c.ctr, cpc: c.cpc, cpm: c.cpm, costPerResult: c.cpa,
      peakDailyFrequency: c.peakFrequency
    }));
    out.daily = (a.daily || []).map(d => ({
      day: d.day, spend: d.spend, impressions: d.impressions, clicks: d.clicks,
      results: d.results, reach: d.reach
    }));
    /* Stated rather than left for the model to work out, because getting it
       wrong is the single most common error in reading this data. */
    out.readMe = [
      'reach is per-day only and counts unique people -- do NOT sum it across days.',
      'Window-level frequency cannot be derived from summed reach; peakDailyFrequency is the real fatigue signal.',
      'Every ratio here was derived from summed counts. Do not average the ratios again.'
    ];
  }

  if (j.series) {
    /* The account id rides along. A channel set with two accounts in it produces
       two rows per day, and without the id a 28-day window looks like 56 days of
       data with the follower count jumping between two unrelated numbers. */
    out.daily = j.series.map(s => ({
      account: s.account, day: s.day, followers: s.followers, reach: s.reach,
      views: s.views, interactions: s.interactions, posts: s.posts
    }));
    if (out.accounts.length > 1) {
      (out.readMe ||= []).push(
        'There is more than one account here, so the daily series has one row per '
        + 'account per day. Group by account before reading a follower count, and sum '
        + 'across accounts before reading a total.');
    }
  }
  if (j.posts) {
    out.postCount = j.posts.length;
    out.posts = j.posts.slice(0, 60).map(p => ({
      title: p.title, url: p.permalink, published: p.publishedAt,
      views: p.views, reach: p.reach, interactions: p.interactions, shares: p.shares
    }));
    if (j.posts.length > 60) out.postsTruncated = j.posts.length - 60;
  }
  return out;
}

/* What is worth keeping about a pull once the conversation is over.

   Small on purpose. This is written to a row per pull and read back on the next
   one, so it has to survive being stored a hundred times and still be cheap to
   hand a model. Counts only, never ratios: a ratio stored today and compared
   against a ratio stored a month ago hides a change in the denominator, which
   is usually the interesting half. */
export function summarise(platform, c){
  if (!c || c.connected === false) return { platform, connected: false };
  const daily = c.daily || [];

  if (platform === 'meta_ads') {
    const t = c.totals || {};
    return {
      platform, connected: true, range: c.range, currency: c.currency || null,
      days: daily.length,
      spend: n(t.spend), results: n(t.results),
      impressions: n(t.impressions), clicks: n(t.clicks),
      campaigns: (c.campaigns || []).length,
      /* Named so the next pull can ask "is the one that was leaking still
         leaking", which is the question the comparison exists for. */
      topSpend: (c.campaigns || []).slice(0, 5)
        .map(x => ({ name: x.name, spend: n(x.spend), results: n(x.results) }))
    };
  }

  const posts = c.posts || [];

  /* Followers is the one number here that is a level rather than a count, so it
     is the latest value per account added up -- not the last row in the series.
     With two channels in the set the last row is whichever account happened to
     sort last, which on the real data read 3 subscribers for a channel with 374.
     Views and interactions are counts and do sum straight through. */
  const latest = new Map();
  for (const d of daily) {
    if (d.followers == null) continue;
    const k = d.account || '_';
    const prev = latest.get(k);
    if (!prev || String(d.day) >= String(prev.day)) latest.set(k, d);
  }
  const followers = latest.size
    ? [...latest.values()].reduce((a, d) => a + (Number(d.followers) || 0), 0) : null;

  return {
    platform, connected: true, range: c.range,
    days: new Set(daily.map(d => d.day)).size,
    accounts: (c.accounts || []).length,
    views: sum(daily, d => d.views),
    interactions: sum(daily, d => d.interactions),
    followers,
    postCount: c.postCount || posts.length,
    /* By views, which is the only per-post number every organic platform here
       reports. Five is enough to notice a new outlier without storing the feed. */
    topPosts: [...posts].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 5)
      .map(p => ({ title: p.title, url: p.url, views: n(p.views),
        interactions: n(p.interactions), published: p.published }))
  };
}

const ROWS = {
  meta_ads: [['spend', 'Spend'], ['results', 'Results'],
    ['impressions', 'Impressions'], ['clicks', 'Clicks']],
  organic: [['views', 'Views'], ['interactions', 'Interactions'],
    ['followers', 'Followers'], ['postCount', 'Posts published']]
};

/* The change since the last pull, as rows rather than a sentence.

   Only comparable when both pulls covered the same window length -- 28 days
   against 7 is not a trend, it is a different question -- so a mismatch is
   reported as such instead of quietly producing a meaningless percentage. */
export function compare(prev, now){
  if (!prev || !now || prev.connected === false || now.connected === false) return null;
  if (prev.platform !== now.platform) return null;
  if (prev.range !== now.range) {
    return { comparable: false,
      why: 'The last pull covered ' + prev.range + ' days and this one covers '
        + now.range + '. Different windows are not a trend.' };
  }
  const spec = ROWS[now.platform] || ROWS.organic;
  const rows = spec.map(([key, label]) => {
    const a = n(prev[key]), b = n(now[key]);
    if (a == null || b == null) return { metric: label, then: a, now: b, change: null, pctChange: null };
    return { metric: label, then: a, now: b, change: b - a, pctChange: pct(b, a) };
  }).filter(r => r.then != null || r.now != null);

  return { comparable: true, rows,
    note: 'These two windows overlap if the pulls were less than ' + now.range
      + ' days apart. Say so rather than reading an overlap as growth.' };
}

/* How long ago, in words, because a timestamp alone makes a model do date
   arithmetic it gets wrong often enough to matter. */
export function agoLabel(then, now = Date.now()){
  const ms = now - new Date(then).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time ago';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return mins <= 1 ? 'just now' : mins + ' minutes ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return hrs === 1 ? 'an hour ago' : hrs + ' hours ago';
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : days + ' days ago';
}
