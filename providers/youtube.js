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

/* ---------------------------------------------------------------------------
   Comments.

   Quota decides the shape of everything below. commentThreads.list costs 1 unit
   and returns up to 100 threads with their first few replies inline, so one
   call covers a channel's recent comment activity. comments.list for the rest
   of a long reply chain is another unit, and it is spent only when somebody
   opens that thread.

   allThreadsRelatedToChannelId is what makes a channel-wide inbox possible at
   all. Without it the only way to find comments is to walk every video and ask
   per video, which is one unit per video per poll.

   What is NOT here, because YouTube does not offer it: liking a comment. The
   Data API can insert, update, delete, mark as spam and set a moderation
   status, and it has no rate or like method on comments -- videos.rate exists,
   its comment equivalent does not. So a heart on a YouTube comment cannot be
   done from here, and the UI says so rather than offering a button that
   quietly does nothing.
   --------------------------------------------------------------------------- */

/* One item as the rest of the app wants it, from either shape Google returns: a
   commentThread's topLevelComment, or a plain comment resource. */
function commentOut(c, { threadId, channelId } = {}){
  const s = c.snippet || {};
  const authorId = s.authorChannelId?.value || null;
  return {
    externalId: c.id,
    threadExternalId: threadId || s.parentId || c.id,
    replyTo: s.parentId || null,
    authorId,
    authorName: s.authorDisplayName || '',
    authorAvatar: s.authorProfileImageUrl || null,
    /* The channel's own replies come back with the channel as author, which is
       how a reply is told apart from a viewer's comment. By id, not by name:
       two channels can share a display name. */
    mine: Boolean(channelId && authorId && authorId === channelId),
    body: s.textOriginal ?? s.textDisplay ?? '',
    likes: Number(s.likeCount) || 0,
    createdAt: s.publishedAt || null,
    videoId: s.videoId || null
  };
}

/* Every recent comment thread on the channel, newest activity first.

   `since` is applied here rather than sent to Google: commentThreads.list has no
   publishedAfter parameter, only an ordering, so the walk stops at the first
   thread older than the cursor. Paging past it would spend quota re-reading
   comments already stored. */
export async function comments(token, { channelId, since = null, max = 200 } = {}){
  if (!channelId) throw new Error('comments() needs the channel id');
  const cutoff = since ? Date.parse(since) : null;
  const threads = [];
  let pageToken = null;

  for (let calls = 0; threads.length < max && calls < 10; calls++) {
    const qs = new URLSearchParams({
      part: 'snippet,replies',
      allThreadsRelatedToChannelId: channelId,
      order: 'time',
      maxResults: '100',
      textFormat: 'plainText'
    });
    if (pageToken) qs.set('pageToken', pageToken);
    const j = await call(token, `${DATA}/commentThreads?${qs}`);

    let reachedCutoff = false;
    for (const t of j.items || []) {
      const top = t.snippet?.topLevelComment;
      if (!top) continue;
      const stamp = Date.parse(top.snippet?.updatedAt || top.snippet?.publishedAt || 0);
      if (cutoff && isFinite(stamp) && stamp <= cutoff) { reachedCutoff = true; break; }

      const items = [commentOut(top, { threadId: t.id, channelId })];
      for (const r of t.replies?.comments || []) {
        items.push(commentOut(r, { threadId: t.id, channelId }));
      }
      items.sort((a, b) => String(a.createdAt) < String(b.createdAt) ? -1 : 1);

      threads.push({
        externalId: t.id,
        parentKind: 'video',
        parentId: t.snippet?.videoId || null,
        /* totalReplyCount counts every reply; replies.comments carries at most
           five of them. The difference is how the UI knows to offer the rest
           rather than implying the thread is complete. */
        totalItems: 1 + (Number(t.snippet?.totalReplyCount) || 0),
        canReply: t.snippet?.canReply !== false,
        items
      });
    }
    if (reachedCutoff) break;
    pageToken = j.nextPageToken || null;
    if (!pageToken) break;
  }
  return threads;
}

/* The whole of one reply chain, for a thread whose inline replies were
   truncated. 1 unit. */
export async function commentReplies(token, parentId, { channelId = null } = {}){
  const out = [];
  let pageToken = null;
  for (let i = 0; i < 10; i++) {
    const qs = new URLSearchParams({
      part: 'snippet', parentId, maxResults: '100', textFormat: 'plainText'
    });
    if (pageToken) qs.set('pageToken', pageToken);
    const j = await call(token, `${DATA}/comments?${qs}`);
    for (const c of j.items || []) out.push(commentOut(c, { threadId: parentId, channelId }));
    pageToken = j.nextPageToken || null;
    if (!pageToken) break;
  }
  out.sort((a, b) => String(a.createdAt) < String(b.createdAt) ? -1 : 1);
  return out;
}

/* One write against the Data API, with the 403 everybody hits first translated
   into the thing to do about it.

   force-ssl is the scope that carries comment writes. youtube.readonly cannot
   write, and the plain youtube scope covers videos and playlists but not
   comments -- so a connection made before force-ssl was requested reads
   comments perfectly well and fails on the first reply. */
async function commentWrite(token, path, body, method = 'POST'){
  const res = await fetch(`${DATA}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const reason = j.error?.errors?.[0]?.reason;
    if (res.status === 401 || res.status === 403) {
      if (/commentsDisabled|processingFailure/i.test(reason || '')) {
        throw new Error('Comments are turned off on that video, so nothing can be posted to it.');
      }
      const err = new Error('This YouTube connection cannot write comments. '
        + 'Reconnect YouTube in Connections: the comment scope is granted on the '
        + 'consent screen, and a connection made before it was requested can '
        + 'read comments but not reply to them.');
      err.needsScope = 'https://www.googleapis.com/auth/youtube.force-ssl';
      throw err;
    }
    throw new Error(`YouTube ${res.status}${reason ? ` (${reason})` : ''}: `
      + (j.error?.message || res.statusText));
  }
  return res.json();
}

/* A reply inside an existing thread. 50 units. */
export async function replyToComment(token, { parentId, text, channelId = null }){
  const body = String(text || '').trim();
  if (!body) throw new Error('A reply cannot be empty.');
  const j = await commentWrite(token, '/comments?part=snippet', {
    snippet: { parentId, textOriginal: body }
  });
  return commentOut(j, { threadId: parentId, channelId });
}

/* A new top-level comment on one of the channel's videos. 50 units. */
export async function postComment(token, { videoId, text, channelId = null }){
  const body = String(text || '').trim();
  if (!body) throw new Error('A comment cannot be empty.');
  if (!videoId) throw new Error('A new comment needs the video it goes under.');
  const j = await commentWrite(token, '/commentThreads?part=snippet', {
    snippet: { videoId, topLevelComment: { snippet: { textOriginal: body } } }
  });
  const top = j.snippet?.topLevelComment;
  return {
    thread: {
      externalId: j.id, parentKind: 'video', parentId: videoId,
      totalItems: 1, canReply: true
    },
    item: commentOut(top || j, { threadId: j.id, channelId })
  };
}

/* Editing one's own comment. 50 units. */
export async function editComment(token, { id, text, channelId = null }){
  const body = String(text || '').trim();
  if (!body) throw new Error('A comment cannot be empty.');
  const j = await commentWrite(token, '/comments?part=snippet',
    { id, snippet: { textOriginal: body } }, 'PUT');
  return commentOut(j, { channelId });
}

/* Deleting one's own comment. 50 units. A 204 is success and carries no body. */
export async function deleteComment(token, id){
  const res = await fetch(`${DATA}/comments?id=${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok && res.status !== 204) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`YouTube ${res.status}: ${j.error?.message || res.statusText}`);
  }
  return { deleted: id };
}

/* Titles for a batch of video ids. One call per 50 ids, 1 quota unit each.

   The comment inbox needs this: a comment thread carries the video id and
   nothing else, and "dQw4w9WgXcQ" is not an answer to "which video is this
   comment on". */
export async function videosByIds(token, ids){
  const list = [...new Set((ids || []).filter(Boolean))].slice(0, 50);
  if (!list.length) return [];
  const j = await call(token,
    `${DATA}/videos?part=snippet&id=${encodeURIComponent(list.join(","))}`);
  return (j.items || []).map(v => ({
    id: v.id,
    title: v.snippet?.title || "",
    publishedAt: v.snippet?.publishedAt || null,
    permalink: `https://www.youtube.com/watch?v=${v.id}`
  }));
}
