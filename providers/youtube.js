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

/* ---------------------------------------------------------------------------
   Writing a video back.

   videos.update is a REPLACE, not a patch: part=snippet swaps the whole snippet
   object, title and categoryId are required, and anything you leave out is
   cleared. Sending {title: 'new'} alone wipes the description, the tags and the
   category in one call. So this is always read-modify-write, and the read is not
   optional even when the caller thinks it knows the current values.

   1 unit to read, 50 to write. The write is the expensive call on this API and
   the daily quota is 10,000, so this is roughly 200 title changes a day -- far
   more than anyone will do by hand and worth knowing before a loop is written
   around it. */

/* The current snippet, plus what the caller needs to show a diff. */
export async function video(token, id){
  const j = await call(token,
    `${DATA}/videos?part=snippet,status,statistics&id=${encodeURIComponent(id)}`);
  const v = j.items?.[0];
  if (!v) throw new Error(`No video ${id} on this channel, or it is not yours to read.`);
  return {
    id: v.id,
    title: v.snippet?.title || '',
    description: v.snippet?.description || '',
    tags: v.snippet?.tags || [],
    categoryId: v.snippet?.categoryId || null,
    defaultLanguage: v.snippet?.defaultLanguage || null,
    publishedAt: v.snippet?.publishedAt || null,
    privacyStatus: v.status?.privacyStatus || null,
    views: Number(v.statistics?.viewCount) || 0,
    permalink: `https://www.youtube.com/watch?v=${v.id}`
  };
}

/* Change some of a video's packaging and leave the rest exactly as it was.

   Returns before and after, because the point of a title test is being able to
   put it back, and "what was it before" is the one thing YouTube's own UI will
   not tell you an hour later. */
export async function updateVideo(token, id, changes = {}){
  const before = await video(token, id);

  const snippet = {
    title: changes.title == null ? before.title : String(changes.title),
    categoryId: before.categoryId,
    description: changes.description == null ? before.description : String(changes.description),
    tags: changes.tags == null ? before.tags : changes.tags
  };
  if (before.defaultLanguage) snippet.defaultLanguage = before.defaultLanguage;

  /* YouTube's own limits, checked here so the failure names the field rather
     than coming back as a 400 with a generic invalidVideoMetadata. */
  if (!snippet.title.trim()) throw new Error('A video title cannot be empty.');
  if (snippet.title.length > 100) {
    throw new Error(`That title is ${snippet.title.length} characters; YouTube's limit is 100.`);
  }
  if (snippet.description.length > 5000) {
    throw new Error(`That description is ${snippet.description.length} characters; the limit is 5000.`);
  }
  if (!snippet.categoryId) {
    throw new Error('This video has no category set, and videos.update requires one. '
      + 'Set a category on the video once in YouTube Studio and it will work after that.');
  }

  const res = await fetch(`${DATA}/videos?part=snippet`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, snippet })
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const reason = j.error?.errors?.[0]?.reason;
    /* The one failure worth translating. A read-only grant is the expected state
       for anyone who connected YouTube before editing existed, and "insufficient
       permissions" sends people looking for the wrong thing. */
    if (res.status === 403 && /insufficient|forbidden/i.test(reason || '')) {
      throw new Error('This YouTube connection was granted read-only access. '
        + 'Reconnect YouTube in Connections to grant editing, then try again.');
    }
    throw new Error(`YouTube ${res.status}${reason ? ` (${reason})` : ''}: `
      + (j.error?.message || res.statusText));
  }

  const after = await video(token, id);
  return {
    id,
    permalink: after.permalink,
    changed: ['title', 'description', 'tags'].filter(k =>
      JSON.stringify(before[k]) !== JSON.stringify(after[k])),
    before: { title: before.title, description: before.description, tags: before.tags },
    after: { title: after.title, description: after.description, tags: after.tags }
  };
}
