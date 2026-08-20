/* YouTube: Data API for the counts, Analytics API for the time series.

   They are two different products. The Data API knows the channel's current
   totals; only the Analytics API breaks anything down by day, and it needs the
   channel owner's own OAuth grant — which is why the scope list carries both
   youtube.readonly and yt-analytics.readonly.

   Quota is the constraint here and it cannot be bought: 10,000 units a day, with
   an audit as the only path to more and data-heavy cases routinely refused. A
   read costs 1 unit and a *search costs 100*, so search.list is never called —
   the uploads playlist gives the same video ids for 1 unit. videos.list takes 50
   ids per request, also for 1 unit, so it is batched.

   One poll costs 4 units: channels.list, playlistItems.list, videos.list, and one
   Analytics report. Hourly is roughly 100 units a day. */

const DATA = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2';

async function call(token, url){
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const detail = j.error?.message || res.statusText;
    /* quotaExceeded is worth naming as itself. It is not an auth failure and
       reconnecting will not fix it — it clears at midnight Pacific. */
    const reason = j.error?.errors?.[0]?.reason;
    throw new Error(`YouTube ${res.status}${reason ? ` (${reason})` : ''}: ${detail}`);
  }
  return res.json();
}

const dayString = d => d.toISOString().slice(0, 10);

/* Channel identity and current totals. 1 unit. */
export async function channel(token){
  const j = await call(token,
    `${DATA}/channels?part=snippet,statistics,contentDetails&mine=true`);
  const c = j.items?.[0];
  if (!c) throw new Error('This Google account has no YouTube channel.');
  return {
    channelId: c.id,
    title: c.snippet?.title || '',
    handle: c.snippet?.customUrl || (c.snippet?.title ? '@' + c.snippet.title : ''),
    followers: Number(c.statistics?.subscriberCount) || 0,
    totalViews: Number(c.statistics?.viewCount) || 0,
    videoCount: Number(c.statistics?.videoCount) || 0,
    uploadsPlaylist: c.contentDetails?.relatedPlaylists?.uploads || null
  };
}

/* Per-day series.

   `reach` is deliberately absent. YouTube exposes no unique-reach metric on
   channel reports at all, and substituting views for it would be exactly the
   relabelling this dashboard refuses to do elsewhere. It stays null.

   `followers` is only set on the most recent day, from the live subscriber total.
   Analytics reports subscribersGained and subscribersLost per day, so a history
   could be reconstructed by walking the total backwards — but that is arithmetic
   on top of arithmetic, and a follower count that is quietly derived is worse
   than one that is simply absent until the poller has been running. */
export async function series(token, { since, until }){
  const params = new URLSearchParams({
    ids: 'channel==MINE',
    startDate: dayString(since),
    endDate: dayString(until),
    metrics: 'views,likes,comments,shares',
    dimensions: 'day',
    sort: 'day'
  });

  const j = await call(token, `${ANALYTICS}/reports?${params}`);
  const cols = (j.columnHeaders || []).map(h => h.name);
  const at = name => cols.indexOf(name);
  const iDay = at('day'), iViews = at('views');
  const iLikes = at('likes'), iComments = at('comments'), iShares = at('shares');

  const rows = (j.rows || []).map(r => ({
    day: String(r[iDay]),
    followers: null,
    reach: null,
    views: Number(r[iViews]) || 0,
    interactions: (Number(r[iLikes]) || 0) + (Number(r[iComments]) || 0) + (Number(r[iShares]) || 0),
    posts: null,
    raw: { likes: r[iLikes], comments: r[iComments], shares: r[iShares] }
  }));

  /* Today's row carries the live totals, which is what makes a follower delta
     possible once a second day has been recorded. */
  const info = await channel(token);
  const today = dayString(until);
  const hit = rows.find(r => r.day === today);
  if (hit) {
    hit.followers = info.followers;
    hit.posts = info.videoCount;
  } else {
    rows.push({
      day: today,
      followers: info.followers,
      reach: null,
      views: 0,
      interactions: 0,
      posts: info.videoCount,
      raw: {}
    });
  }

  return { rows, info };
}

/* Recent uploads with their stats. 2 units: the uploads playlist, then one
   batched videos.list. Never search.list, which costs 100. */
export async function recentPosts(token, { uploadsPlaylist, limit = 50 } = {}){
  if (!uploadsPlaylist) return [];

  const list = await call(token,
    `${DATA}/playlistItems?part=contentDetails&maxResults=${Math.min(50, limit)}`
    + `&playlistId=${encodeURIComponent(uploadsPlaylist)}`);

  const ids = (list.items || [])
    .map(i => i.contentDetails?.videoId)
    .filter(Boolean);
  if (!ids.length) return [];

  const vids = await call(token,
    `${DATA}/videos?part=snippet,statistics&id=${ids.join(',')}`);

  return (vids.items || []).map(v => ({
    externalId: v.id,
    title: v.snippet?.title || '(untitled)',
    permalink: `https://www.youtube.com/watch?v=${v.id}`,
    publishedAt: v.snippet?.publishedAt || null,
    /* Same as the series: no per-video unique reach exists. */
    reach: null,
    views: Number(v.statistics?.viewCount) || 0,
    /* YouTube reports no share count per video on the Data API. Absent, not zero
       dressed up as a measurement. */
    shares: null,
    interactions: (Number(v.statistics?.likeCount) || 0)
                + (Number(v.statistics?.commentCount) || 0)
  }));
}
