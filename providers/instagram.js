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

function commentOut(c, { threadId, igId, username }){
  const who = c.from?.username || c.username || null;
  return {
    externalId: c.id,
    threadExternalId: threadId || c.id,
    replyTo: threadId && threadId !== c.id ? threadId : null,
    authorId: c.from?.id || null,
    authorName: who ? '@' + who : 'Someone on Instagram',
    authorAvatar: null,
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
      const items = [commentOut(c, { threadId: c.id, igId, username })];
      for (const r of c.replies?.data || []) {
        read++;
        items.push(commentOut(r, { threadId: c.id, igId, username }));
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

const MSG_FIELDS = 'id,created_time,from,to,message';

/* Conversations, and the messages inside them.

   Two calls per thread rather than one for everything, because this API caps a
   conversation at its 20 most recent messages and will not return them from
   the list edge. The cap is Instagram's; it is passed through rather than
   papered over, and the UI already knows how to say "N on the platform, M held
   here". */
export async function conversations(token, { igId, limit = 40 } = {}){
  const list = await call(token, 'me/conversations', {
    platform: 'instagram',
    fields: 'id,updated_time',
    limit
  });

  const out = [];
  for (const c of list?.data || []) {
    let msgs = [];
    let people = [];
    try {
      const full = await call(token, c.id, {
        fields: `participants,messages.limit(20){${MSG_FIELDS}}`
      });
      msgs = full?.messages?.data || [];
      people = full?.participants?.data || [];
    } catch {
      /* One unreadable thread must not lose the rest of the inbox. */
    }

    const them = people.find(p => String(p.id) !== String(igId)) || people[0] || {};
    const items = msgs.map(m => ({
      externalId: m.id,
      threadExternalId: c.id,
      replyTo: null,
      authorId: m.from?.id || null,
      authorName: m.from?.username ? '@' + m.from.username : (m.from?.name || 'Unknown'),
      authorAvatar: null,
      mine: Boolean(m.from?.id && String(m.from.id) === String(igId)),
      body: m.message || '',
      likes: 0,
      likedByUs: false,
      createdAt: m.created_time || null,
      attachments: []
    })).sort((a, b) => String(a.createdAt) < String(b.createdAt) ? -1 : 1);

    out.push({
      externalId: c.id,
      parentKind: null, parentId: null, parentTitle: null, parentLink: null,
      withId: them.id || null,
      withName: them.username ? '@' + them.username : (them.name || 'Unknown'),
      /* The platform gives no total, so what is held is what is known. */
      totalItems: items.length,
      unread: false,
      canReply: true,
      items
    });
  }
  return out;
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
