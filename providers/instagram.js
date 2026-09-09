/* Instagram, signed in as Instagram.

   This is a SECOND Instagram integration, not a replacement for the one inside
   providers/meta.js, and the two share nothing but the word Instagram:

     Instagram API with Facebook Login   providers/meta.js. A Page access token
                                         against graph.facebook.com, the
                                         instagram_manage_* permissions, and
                                         DMs read through the parent Page's
                                         /conversations edge.

     Instagram API with Instagram Login  this file. Its own sign-in at
                                         instagram.com, its own app id and
                                         secret, graph.instagram.com, and the
                                         instagram_business_* permissions. The
                                         Instagram account IS the account --
                                         there is no Page in the path.

   Why both exist here: the Page route returns 200 and an empty list for this
   account's DMs. Every other explanation was ruled out -- the same token
   returns Messenger threads, the permission is granted, the Page and the
   Instagram id are right, and every folder and API version answers the same.
   That leaves a switch inside the Instagram app, which only the account owner
   can reach. This route does not depend on that switch, because the person
   signing in IS the account owner and grants it directly.

   Neither API is deprecated. If the Page route starts working again, nothing
   here has to be removed: an account connected this way is simply a different
   row, and lib/social-inbox.js reads whichever is present.

   The credentials are NOT the Meta app's. Instagram Login uses the Instagram
   App ID and Secret from the App Dashboard's Instagram product, which are
   different numbers from META_APP_ID and META_APP_SECRET even inside the same
   app. Getting that wrong produces "Invalid platform app", which is the one
   error worth naming here because it looks like a code bug and is not. */

const V = 'v23.0';
const GRAPH = `https://graph.instagram.com`;

/* Everything this integration needs, and nothing it does not.
   content_publish is deliberately absent: this dashboard does not post. */
export const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages'
];

export function authorizeUrl(env, { redirect, state }){
  return 'https://www.instagram.com/oauth/authorize?' + new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: IG_SCOPES.join(','),
    state
  });
}

async function call(token, path, params = {}){
  const qs = new URLSearchParams({ access_token: token });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const res = await fetch(`${GRAPH}/${V}/${path}?${qs}`);
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) {
    const e = json?.error || {};
    const err = new Error(`Instagram ${res.status}: ${e.message || res.statusText}`);
    err.code = e.code;
    err.subcode = e.error_subcode;
    /* 190 is a dead token here as it is on the Facebook side. */
    err.isAuth = e.code === 190 || e.type === 'OAuthException';
    throw err;
  }
  return json;
}

async function post(token, path, body = {}){
  const res = await fetch(`${GRAPH}/${V}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) {
    const e = json?.error || {};
    const err = new Error(`Instagram ${res.status}: ${e.message || res.statusText}`);
    err.code = e.code;
    err.isAuth = e.code === 190;
    throw err;
  }
  return json;
}

/* ---------------------------------------------------------------------------
   The grant.
   --------------------------------------------------------------------------- */

/* The code exchange, which is a form POST to api.instagram.com -- a different
   host from every other call in this file, and the only one that is not
   graph.instagram.com. */
export async function exchange(env, { code, redirect }){
  const res = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.INSTAGRAM_APP_ID,
      client_secret: env.INSTAGRAM_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: redirect,
      code
    })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = json.error_message || json.error_description || json.error || res.statusText;
    if (/invalid platform app/i.test(String(detail))) {
      throw new Error('Instagram rejected the app id as "Invalid platform app". '
        + 'INSTAGRAM_APP_ID must be the Instagram App ID from the App Dashboard\'s '
        + 'Instagram product, not META_APP_ID — they are different numbers even '
        + 'inside the same app.');
    }
    throw new Error(`Instagram ${res.status}: ${detail}`);
  }
  return json;
}

/* Short-lived to 60 days. Same hook name the Meta provider uses, so
   exchangeCode() in lib/oauth.js treats both the same way. */
export async function exchangeLongLived(env, tok){
  const short = tok.access_token;
  if (!short) throw new Error('Instagram returned no access token from the code exchange');

  const qs = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: env.INSTAGRAM_APP_SECRET,
    access_token: short
  });
  const res = await fetch(`${GRAPH}/access_token?${qs}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Instagram long-lived exchange failed: `
      + (json.error?.message || json.error_message || res.statusText));
  }
  const seconds = Number(json.expires_in) || 60 * 86_400;
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + (seconds - 3600) * 1000,
    /* The exchange response lists what was actually granted; the authorize
       screen lets a person deselect. */
    grantedScopes: Array.isArray(tok.permissions) ? tok.permissions.join(' ')
      : (typeof tok.permissions === 'string' ? tok.permissions : IG_SCOPES.join(' '))
  };
}

/* Renewal. A long-lived token must be at least 24 hours old before Instagram
   will refresh it, and refreshing resets the 60 days. lib/accounts.js renews at
   seven days out, which is comfortably inside both bounds. */
export async function refresh(env, stored){
  const qs = new URLSearchParams({
    grant_type: 'ig_refresh_token',
    access_token: stored
  });
  const res = await fetch(`${GRAPH}/refresh_access_token?${qs}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Instagram token renewal failed: `
      + (json.error?.message || json.error_message || res.statusText));
  }
  const seconds = Number(json.expires_in) || 60 * 86_400;
  return {
    accessToken: json.access_token,
    refreshToken: json.access_token,
    expiresAt: Date.now() + (seconds - 3600) * 1000,
    scope: null
  };
}

export async function identify(accessToken){
  const me = await call(accessToken, 'me',
    { fields: 'user_id,username,name,profile_picture_url' });
  const uid = String(me.user_id || me.id || '');
  if (!uid) throw new Error('Instagram /me returned no id');
  return { uid, email: me.username ? '@' + me.username : `Instagram ${uid}` };
}

/* One account row, for the connect flow. There is no fan-out here: an
   Instagram Login grant covers exactly one Instagram account, which is the
   point of it. */
export async function discover(accessToken){
  const me = await call(accessToken, 'me',
    { fields: 'user_id,username,name,profile_picture_url' });
  const uid = String(me.user_id || me.id || '');
  return [{
    provider: 'instagram_login',
    uid,
    display: me.username ? '@' + me.username : `Instagram ${uid}`,
    token: accessToken,
    expiresAt: null,
    meta: {
      igId: uid,
      username: me.username || null,
      name: me.name || null,
      avatar: me.profile_picture_url || null,
      /* So every reader can tell which of the two Instagram routes this row
         speaks, without inferring it from the provider name. */
      route: 'instagram_login'
    }
  }];
}

/* ---------------------------------------------------------------------------
   Comments.
   --------------------------------------------------------------------------- */

function commentOut(c, { threadId, igId, username, faces = new Map() }){
  const who = c.from?.username || c.username || null;
  const p = c.from?.id ? faces.get(String(c.from.id)) : null;
  return {
    externalId: c.id,
    threadExternalId: threadId || c.id,
    replyTo: threadId && threadId !== c.id ? threadId : null,
    authorId: c.from?.id || null,
    authorName: nameOf(p, who) || 'Someone on Instagram',
    authorAvatar: p?.avatar || null,
    mine: Boolean(c.from?.id && igId && String(c.from.id) === String(igId))
      || Boolean(username && who && who.toLowerCase() === String(username).toLowerCase()),
    body: c.text || '',
    likes: Number(c.like_count) || 0,
    likedByUs: false,
    createdAt: c.timestamp || null,
    attachments: []
  };
}

export async function comments(token, { since = null, media = 25, username = null, igId = null } = {}){
  const feed = await call(token, 'me/media', {
    fields: 'id,caption,timestamp,permalink,media_type,media_product_type,'
      + 'media_url,thumbnail_url,like_count,comments_count,'
      + 'children{media_type,media_url,thumbnail_url},'
      + 'comments.limit(50){id,text,timestamp,like_count,username,from{id,username},'
      + 'replies.limit(25){id,text,timestamp,like_count,username,from{id,username}}}',
    limit: media
  });

  const cutoff = since ? Date.parse(since) : null;
  const threads = [];
  let counted = 0, read = 0;

  /* Names and faces for everyone who commented, resolved once for the whole
     feed before any thread is built. A comment carries a handle and an id and
     nothing else, so the display name and the picture are the same profile
     lookup the conversations use, sharing one cache across both directions of
     a person appearing as both a commenter and a sender.

     Not everyone resolves. Instagram hands over a profile for people it has a
     relationship to record, and commentOut falls back to the handle with no
     picture for the rest, which is exactly what was shown before. */
  const faces = new Map();
  const commenters = [];
  for (const m of feed?.data || []) {
    for (const c of m.comments?.data || []) {
      commenters.push(c.from?.id);
      for (const r of c.replies?.data || []) commenters.push(r.from?.id);
    }
  }
  if (commenters.filter(Boolean).length) {
    await profiles(token, commenters, faces).catch(() => faces);
  }

  for (const m of feed?.data || []) {
    counted += Number(m.comments_count) || 0;
    const title = String(m.caption || '').replace(/\s+/g, ' ').trim();
    const parentMedia = {
      kind: m.media_type === 'VIDEO' ? 'video'
        : m.media_type === 'CAROUSEL_ALBUM' ? 'album' : 'image',
      image: m.media_type === 'VIDEO' ? (m.thumbnail_url || null) : (m.media_url || null),
      video: m.media_type === 'VIDEO' ? (m.media_url || null) : null,
      album: (m.children?.data || []).slice(0, 10).map(ch => ({
        kind: ch.media_type === 'VIDEO' ? 'video' : 'image',
        image: ch.media_type === 'VIDEO' ? (ch.thumbnail_url || null) : (ch.media_url || null),
        video: ch.media_type === 'VIDEO' ? (ch.media_url || null) : null
      })),
      at: m.timestamp || null,
      likes: m.like_count ?? null,
      comments: m.comments_count ?? null
    };

    for (const c of m.comments?.data || []) {
      read++;
      const items = [commentOut(c, { threadId: c.id, igId, username, faces })];
      for (const r of c.replies?.data || []) {
        read++;
        items.push(commentOut(r, { threadId: c.id, igId, username, faces }));
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
        parentMedia,
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
  threads.missingText = counted > read ? counted - read : 0;
  threads.mediaSeen = (feed?.data || []).length;
  threads.counted = counted;
  threads.read = read;
  return threads;
}

export async function replyToComment(token, { commentId, text }){
  const body = String(text || '').trim();
  if (!body) throw new Error('A reply cannot be empty.');
  const j = await post(token, `${commentId}/replies`, { message: body });
  return { externalId: j.id || null, body };
}

export async function commentOnPost(token, { mediaId, text }){
  const body = String(text || '').trim();
  if (!body) throw new Error('A comment cannot be empty.');
  const j = await post(token, `${mediaId}/comments`, { message: body });
  return { externalId: j.id || null, body };
}

/* ---------------------------------------------------------------------------
   Messages.
   --------------------------------------------------------------------------- */

/* Everything a message can carry, and it is not just text.

   A conversation full of empty bubbles is what you get from asking for
   `message` alone: a story reply carries `story` and no text, a shared reel
   carries `shares`, and a photo carries `attachments`. Asking only for the
   text and rendering the silence as "(no content)" describes the request, not
   the conversation. */
/* Three field lists, widest first.

   Asking for a subfield Graph does not know on this account type fails the
   WHOLE request, and a failed request here is a blank bubble -- so the widest
   list is tried, and each failure steps down rather than giving up. The bare
   forms in the middle list return Graph defaults, which carry less than the
   expansion does but more than nothing. */
const MSG_FIELD_SETS = [
  'id,created_time,from,to,message,is_unsupported,'
    + 'attachments{id,name,mime_type,size,file_url,image_data,video_data},'
    + 'shares{id,name,link,description},story',
  'id,created_time,from,to,message,attachments,shares,story,is_unsupported',
  'id,created_time,from,to,message'
];

/* Which of them this account actually answers. Learned once and kept, because
   a sync reads hundreds of messages and paying three failed requests each is
   three hundred wasted calls against a rate limit that is per app.

   Only a complaint ABOUT THE FIELDS moves it. A message that fails because it
   was deleted says nothing about what this account supports, and demoting the
   field list on the strength of one dead message would quietly strip the
   attachments off every message after it. */
let msgFieldSet = 0;
const isFieldError = err =>
  err?.code === 100 || /nonexisting field|Unsupported get request|unknown field/i
    .test(String(err?.message || ''));

/* One message, with its content.

   The nested expansion on a conversation returns the ids and the timestamps
   and NOT the bodies -- which is the whole reason the first version rendered
   empty bubbles. Each message has to be fetched. */
async function messageDetail(token, id){
  for (let i = msgFieldSet; i < MSG_FIELD_SETS.length; i++) {
    try {
      return await call(token, id, { fields: MSG_FIELD_SETS[i] });
    } catch (err) {
      if (!isFieldError(err)) break;
      /* This account will not answer that list. Remember it, and step down. */
      msgFieldSet = i + 1;
    }
  }
  /* One unreadable message must not lose the thread around it. */
  return null;
}

function messageOut(m, { convId, igId, who = new Map() }){
  const atts = [];

  /* Photos, videos, audio and files. Instagram nests the real link a level
     deeper than Messenger does. */
  for (const a of m.attachments?.data || []) {
    const url = a.image_data?.url || a.video_data?.url || a.file_url || a.url
      || a.image_data?.preview_url || a.video_data?.preview_url || null;
    const kind = a.image_data ? 'image'
      : a.video_data ? 'video'
      : /audio/i.test(a.mime_type || '') ? 'audio' : 'file';
    atts.push({ kind, name: a.name || null, url });
  }

  /* A shared post or reel. The link is the post; the thumbnail is what makes
     it recognisable at a glance. */
  for (const sh of m.shares?.data || []) {
    atts.push({ kind: 'share', name: sh.name || null, url: sh.link || null });
  }

  /* A story reply or mention: the thing being replied to is a story, and
     without this the message reads as blank. */
  if (m.story) {
    atts.push({
      kind: 'story',
      name: m.story.mention ? 'mentioned you in a story' : 'replied to a story',
      url: m.story.link || null
    });
  }

  /* Said plainly rather than left blank. An empty bubble is the worst of the
     available answers: it looks like our bug in every case, including the two
     where it is not.

     is_unsupported is Instagram saying so itself -- voice notes and some
     effects. The other case is a message that came back with an id, a sender
     and a time and nothing else, which is what an unsent message and an
     expired story both look like from here. Which fields Instagram DID return
     is kept on the item, because that is the only thing that tells those two
     apart and it costs nothing to carry. */
  const body = m.message || '';
  const empty = !body && !atts.length;
  const note = !empty ? '' : (m.is_unsupported
    ? 'Instagram does not send this kind of message through its API'
    : 'Instagram returned no content for this message');

  return {
    externalId: m.id,
    threadExternalId: convId,
    replyTo: null,
    authorId: m.from?.id || null,
    /* The profile first, the handle second. Instagram shows a display name
       everywhere it shows a person, and so should this. */
    authorName: nameOf(who.get(String(m.from?.id)), m.from?.username)
      || m.from?.name || 'Unknown',
    authorAvatar: who.get(String(m.from?.id))?.avatar || null,
    mine: Boolean(m.from?.id && String(m.from.id) === String(igId)),
    body: body || note,
    likes: 0,
    likedByUs: false,
    createdAt: m.created_time || null,
    attachments: atts,
    /* Only when there was nothing to show, and only the field NAMES -- enough
       to say what Instagram sent, none of what it said. */
    raw: empty ? { emptyFields: Object.keys(m).sort().join(',') } : null
  };
}

/* Who somebody is, rather than what they are called in a URL.

   A conversation's participants come back as an id and a username, so the
   inbox showed @thekashanddashshow where Instagram itself shows "The Kash &
   Dash Show" with a face beside it. The display name and the picture are on
   the profile, which is a separate lookup per person.

   Cached for the life of the call, because a sync reads forty conversations
   and the same handful of people recur across them -- and because a display
   name is not worth a request twice in one pass. Failure is not fatal: a
   missing profile falls back to the handle, which is what was there before. */
async function profiles(token, ids, cache){
  const want = [...new Set(ids.filter(Boolean).map(String))]
    .filter(id => !cache.has(id));
  await Promise.all(want.map(async id => {
    /* Two attempts, narrowing. Graph refuses the WHOLE request for one
       unknown field, so if profile_pic is not available on this account type
       the name would be lost with it -- and the name is the part that
       matters. */
    for (const fields of ['id,name,username,profile_pic', 'id,name,username']) {
      try {
        const p = await call(token, id, { fields });
        cache.set(id, {
          name: p.name || null,
          username: p.username || null,
          avatar: p.profile_pic || null
        });
        return;
      } catch { /* try the narrower set */ }
    }
    /* Instagram will not hand over a profile for everyone -- a deleted
       account, or somebody who has never messaged this one. The handle is
       still true, and it is what the caller falls back to. */
    cache.set(id, null);
  }));
  return cache;
}

/* The best name available: what Instagram shows, then the handle, then
   nothing pretending to be a name. */
const nameOf = (p, username) =>
  (p && p.name) || (username ? '@' + username : null)
  || (p && p.username ? '@' + p.username : null);

/* Conversations, and the messages inside them.

   Three shapes of call, because the API needs all three: the conversation
   list, then each conversation's message ids, then each message. The last one
   is why `detail` exists -- fetching twenty messages for forty conversations
   is eight hundred requests, so a sync takes only enough to fill the list
   preview and opening a thread asks for the rest.

   Instagram caps a conversation at its 20 most recent messages. That cap is
   its own; it is passed through rather than papered over, and the thread view
   already says how many are held. */
export async function conversations(token, { igId, limit = 40, detail = 6 } = {}){
  const list = await call(token, 'me/conversations', {
    platform: 'instagram',
    fields: 'id,updated_time',
    limit
  });

  /* One profile cache for the whole pass. */
  const who = new Map();
  const out = [];

  for (const c of list?.data || []) {
    let ids = [];
    let people = [];
    try {
      const full = await call(token, c.id, {
        fields: 'participants,messages.limit(20){id,created_time}'
      });
      ids = (full?.messages?.data || []).map(m => m.id).filter(Boolean);
      people = full?.participants?.data || [];
    } catch {
      /* One unreadable thread must not lose the rest of the inbox. */
    }

    /* Newest first is how Instagram returns them, and the newest are the ones
       worth spending calls on. */
    const wanted = ids.slice(0, Math.max(1, detail));
    const full = await Promise.all(wanted.map(id => messageDetail(token, id)));
    const msgs = full.filter(Boolean);

    /* Names and faces for everybody who appears in this conversation, in one
       go, before the messages are shaped. */
    await profiles(token, [
      ...people.map(p => p.id),
      ...msgs.map(m => m.from?.id)
    ], who);

    const items = msgs
      .map(m => messageOut(m, { convId: c.id, igId, who }))
      .sort((a, b) => String(a.createdAt) < String(b.createdAt) ? -1 : 1);

    const them = people.find(p => String(p.id) !== String(igId)) || people[0] || {};
    const themProfile = who.get(String(them.id));
    out.push({
      externalId: c.id,
      parentKind: null, parentId: null, parentTitle: null, parentLink: null,
      withId: them.id || null,
      /* "The Kash & Dash Show", not @thekashanddashshow — Instagram shows the
         display name everywhere it shows a person, and the handle is only what
         is left when there is no profile to read. */
      withName: nameOf(themProfile, them.username) || them.name || 'Unknown',
      withAvatar: themProfile?.avatar || null,
      /* What the conversation HAS, against what was fetched. */
      totalItems: ids.length,
      unread: false,
      canReply: true,
      items
    });
  }
  return out;
}

/* Every message Instagram will give for one conversation, for when it is
   opened. Twenty is the platform's own ceiling. */
export async function conversationMessages(token, { convId, igId }){
  const full = await call(token, convId, { fields: 'messages.limit(20){id,created_time}' });
  const ids = (full?.messages?.data || []).map(m => m.id).filter(Boolean);
  const msgs = (await Promise.all(ids.map(id => messageDetail(token, id)))).filter(Boolean);
  const who = await profiles(token, msgs.map(m => m.from?.id), new Map());
  return msgs
    .map(m => messageOut(m, { convId, igId, who }))
    .sort((a, b) => String(a.createdAt) < String(b.createdAt) ? -1 : 1);
}

export async function sendMessage(token, { igId, recipientId, text }){
  const body = String(text || '').trim();
  if (!body) throw new Error('A message cannot be empty.');
  if (!recipientId) throw new Error('No recipient on that conversation.');
  const j = await post(token, `${igId}/messages`, {
    recipient: { id: recipientId },
    message: { text: body }
  });
  return { externalId: j.message_id || null, recipientId, body };
}

export async function sendAttachment(token, { igId, recipientId, kind, url }){
  if (!url) {
    throw new Error('Instagram fetches media from a public URL rather than taking an '
      + 'upload, and this dashboard has no public address to serve one from. '
      + 'Paste a link to the file instead.');
  }
  const j = await post(token, `${igId}/messages`, {
    recipient: { id: recipientId },
    message: { attachment: { type: kind, payload: { url } } }
  });
  return { externalId: j.message_id || null, kind, url };
}

/* Reactions. This API takes an arbitrary emoji rather than Meta's seven names,
   so the caller's name is translated on the way out and anything unrecognised
   is passed through as-is. */
const REACTION_EMOJI = {
  love: '❤️', haha: '😆', wow: '😮', sad: '😢',
  angry: '😠', like: '👍', dislike: '👎'
};

export async function reactToMessage(token, { igId, recipientId, messageId, reaction = null }){
  if (!messageId) throw new Error('Which message?');
  if (!recipientId) throw new Error('No recipient on that conversation.');
  const body = reaction
    ? {
        recipient: { id: recipientId },
        sender_action: 'react',
        payload: { message_id: messageId, reaction: REACTION_EMOJI[reaction] || reaction }
      }
    : {
        recipient: { id: recipientId },
        sender_action: 'unreact',
        payload: { message_id: messageId }
      };
  await post(token, `${igId}/messages`, body);
  return { messageId, reaction };
}
