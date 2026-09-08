/* Comments and messages: the mirror, and what can be done to it.

   The same rule as the metrics poller. Platform APIs are never called from a
   read request: the poller writes social_threads and social_items, and the
   views serve those. YouTube's 10,000 quota units a day cannot be bought, and
   Meta's limits are per app rather than per reader, so a list that refetched on
   every keystroke would take the whole dashboard down with it.

   Writes are the exception and they go straight through. A reply that is queued
   and sent later is a reply that might not have been sent, and the one thing a
   person needs to know after pressing Send is whether it went. So a send calls
   the platform, waits, and stores what came back -- or reports why not.

   ----------------------------------------------------------------------------
   What each platform actually allows, which is not symmetrical:

                       read      reply     new comment   like      send DM
     YouTube           yes       yes*      yes*          NO        n/a
     Facebook posts    yes**     yes***    yes***        yes***    n/a
     Instagram posts   yes****   yes****   yes****       NO        n/a
     Facebook DMs      yes*****  -         -             -         yes*****
     Instagram DMs     yes+      -         -             -         yes+

     *      youtube.force-ssl. The plain youtube scope covers videos and
            playlists and not comments.
     **     pages_read_engagement for the Page's own posts,
            pages_read_user_content for what other people wrote on them.
     ***    pages_manage_engagement.
     ****   instagram_manage_comments. instagram_basic reads comments_count but
            NOT the comment text, and the edge comes back empty rather than
            erroring -- which is indistinguishable from a post with no
            comments unless something says so.
     *****  pages_messaging.
     +      instagram_manage_messages AND the Instagram messaging capability on
            the app itself, which is App Review rather than a scope.

   Liking a comment is genuinely absent from two of the three: YouTube's Data
   API has no rate method for comments and Instagram's Graph API has no like
   endpoint for them. capabilities() reports that, and the UI hides the control
   rather than offering one that cannot work.
   --------------------------------------------------------------------------- */

import { query } from '../db/index.js';
import { accountsFor, getAccount, getAccessToken, markReauth } from './accounts.js';
import * as youtube from '../providers/youtube.js';
import * as meta from '../providers/meta.js';

/* Platforms with an inbox. X is not one: its API tier here reads post metrics
   and follower counts, and mentions or DMs are a different, paid product. */
export const INBOX_PLATFORMS = ['youtube', 'facebook', 'instagram'];

const SNIPPET = 180;
const snip = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET);

/* ---------------------------------------------------------------------------
   Capability, from the scopes actually granted rather than the ones requested.

   Meta's dialog lets a person deselect a permission and still succeed, and a
   YouTube connection made before force-ssl was asked for keeps working for
   reads. Both produce a grant that can list comments and not answer them, so
   what the UI offers is derived from the grant every time rather than from the
   platform name.
   --------------------------------------------------------------------------- */

const CAP_RULES = {
  youtube: {
    read:    () => true,
    reply:   sc => sc.has('https://www.googleapis.com/auth/youtube.force-ssl'),
    post:    sc => sc.has('https://www.googleapis.com/auth/youtube.force-ssl'),
    react:   () => false,
    messages: () => false
  },
  facebook: {
    read:    sc => sc.has('pages_read_engagement'),
    reply:   sc => sc.has('pages_manage_engagement'),
    post:    sc => sc.has('pages_manage_engagement'),
    react:   sc => sc.has('pages_manage_engagement'),
    messages: sc => sc.has('pages_messaging')
  },
  instagram: {
    read:    sc => sc.has('instagram_manage_comments'),
    reply:   sc => sc.has('instagram_manage_comments'),
    post:    sc => sc.has('instagram_manage_comments'),
    react:   () => false,
    messages: sc => sc.has('instagram_manage_messages')
  }
};

/* Why a capability is off, in the words of the thing to do about it. */
const CAP_WHY = {
  'youtube.reply': 'Reconnect YouTube. Replying needs the comment scope, and this '
    + 'connection was made before it was requested.',
  'youtube.post': 'Reconnect YouTube. Posting a comment needs the comment scope.',
  'youtube.react': 'YouTube has no API for liking a comment. Its Data API can reply, '
    + 'edit, delete and moderate, and there is no rate method for comments at all.',
  'youtube.messages': 'YouTube has no direct messages.',
  'facebook.read': 'Reconnect Meta. Reading a Page’s posts needs pages_read_engagement.',
  'facebook.reply': 'Reconnect Meta to grant pages_manage_engagement, which is what '
    + 'lets a Page reply to a comment.',
  'facebook.post': 'Reconnect Meta to grant pages_manage_engagement.',
  'facebook.react': 'Reconnect Meta to grant pages_manage_engagement.',
  'facebook.messages': 'Reconnect Meta to grant pages_messaging. Facebook gates Page '
    + 'inboxes behind it, and without it the conversations endpoint returns 403.',
  'instagram.read': 'Reconnect Meta to grant instagram_manage_comments. Without it '
    + 'Instagram returns how many comments a post has but not what they say.',
  'instagram.reply': 'Reconnect Meta to grant instagram_manage_comments.',
  'instagram.post': 'Reconnect Meta to grant instagram_manage_comments.',
  'instagram.react': 'Instagram has no API for liking a comment. It can be replied to, '
    + 'hidden or deleted, and liking only works in the Instagram app.',
  'instagram.messages': 'Instagram DMs need instagram_manage_messages and the '
    + 'Instagram messaging capability on the Meta app itself, which is App Review '
    + 'rather than a permission the consent screen can grant.'
};

export async function capabilities(){
  const all = await accountsFor('social');
  const accounts = all.filter(a => INBOX_PLATFORMS.includes(a.provider));

  /* Scope comes from the table, not from accountsFor().

     publicRow() strips it on purpose -- it is grant internals and the browser
     has no business with it -- so `a.scope` through that path is undefined for
     every row, and every scope test below silently answered false. Facebook
     read reported "needs pages_read_engagement" while pages_read_engagement was
     granted, which is the most misleading thing a capability panel can say.

     Facebook and Instagram rows are also DERIVED from the Meta grant: discovery
     writes one row per Page and one per Instagram account, each carrying a Page
     token and no scope of its own. The scope list lives on the provider='meta'
     row, and that row is the authority on what a Meta-derived row may do -- so
     its scopes count for both properties rather than standing in as a fallback. */
  const { rows: scopeRows } = await query(
    `SELECT provider, scope FROM accounts WHERE provider = ANY($1)`,
    [[...INBOX_PLATFORMS, 'meta']]);
  const scopesOf = provider => scopeRows
    .filter(r => r.provider === provider)
    .flatMap(r => String(r.scope || '').split(/[\s,]+/))
    .filter(Boolean);
  const metaScopes = scopesOf('meta');

  const out = {};
  for (const platform of INBOX_PLATFORMS) {
    const mine = accounts.filter(a => a.provider === platform);
    /* The union across accounts. Two YouTube channels connected at different
       times can carry different scopes, and a control that works for one is
       worth offering -- the per-account answer is on the account row. */
    const scopes = new Set(platform === 'youtube' ? [] : metaScopes);
    for (const s of scopesOf(platform)) scopes.add(s);
    const rules = CAP_RULES[platform];
    const can = {};
    const why = {};
    for (const verb of ['read', 'reply', 'post', 'react', 'messages']) {
      can[verb] = mine.length > 0 && Boolean(rules[verb](scopes));
      if (!can[verb]) {
        why[verb] = mine.length ? (CAP_WHY[`${platform}.${verb}`] || null)
          : `No ${platform} account is connected.`;
      }
    }
    out[platform] = {
      accounts: mine.map(a => ({
        id: a.id, label: a.label, status: a.status, color: a.color || null
      })),
      /* Scope is what the grant MAY do; live is whether anything can do it
         right now. The two fail independently, and a YouTube connection can
         carry every scope and still be a revoked token -- which is exactly the
         state this was written in. */
      live: mine.some(a => a.status === 'ok'),
      needsReconnect: mine.filter(a => a.status !== 'ok').map(a => a.label),
      can,
      why
    };
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Writing the mirror.
   --------------------------------------------------------------------------- */

const threadId = (accountId, kind, externalId) => `${accountId}:${kind}:${externalId}`;
const itemId = (accountId, externalId) => `${accountId}:${externalId}`;

/* One thread and its items, upserted together.

   item_count is the platform's count where the platform gives one, not the
   number of rows stored: a comment thread with forty replies arrives with five
   of them inline, and reporting five would tell the reader the thread is
   complete when it is not. */
export async function saveThread(account, kind, t){
  const id = threadId(account.id, kind, t.externalId);
  const items = (t.items || []).slice().sort((a, b) =>
    String(a.createdAt) < String(b.createdAt) ? -1 : 1);
  const last = items[items.length - 1] || null;
  const first = items[0] || null;

  /* Who the thread is with. On a DM the provider says; on a comment thread it
     is whoever opened it, which is not us. */
  const withId = t.withId ?? (first && !first.mine ? first.authorId : null);
  const withName = t.withName ?? (first && !first.mine ? first.authorName : null);
  const withAvatar = t.withAvatar ?? (first && !first.mine ? first.authorAvatar : null);

  await query(
    `INSERT INTO social_threads
       (id, account_id, platform, kind, external_id, parent_kind, parent_id,
        parent_title, parent_link, with_id, with_name, with_avatar, item_count,
        unread, last_at, last_from, last_snippet, can_reply, raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now())
     ON CONFLICT (id) DO UPDATE SET
       parent_kind  = EXCLUDED.parent_kind,
       parent_id    = EXCLUDED.parent_id,
       parent_title = COALESCE(EXCLUDED.parent_title, social_threads.parent_title),
       parent_link  = COALESCE(EXCLUDED.parent_link, social_threads.parent_link),
       with_id      = COALESCE(EXCLUDED.with_id, social_threads.with_id),
       with_name    = COALESCE(EXCLUDED.with_name, social_threads.with_name),
       with_avatar  = COALESCE(EXCLUDED.with_avatar, social_threads.with_avatar),
       item_count   = GREATEST(EXCLUDED.item_count, social_threads.item_count),
       /* Read stays read. The platform's unread flag is about the platform's own
          inbox, and it would put a badge back on a thread somebody answered
          here ten seconds ago. It can only ever be set by a NEWER message. */
       unread       = CASE WHEN EXCLUDED.last_at > social_threads.last_at
                           THEN EXCLUDED.unread ELSE social_threads.unread END,
       last_at      = GREATEST(EXCLUDED.last_at, social_threads.last_at),
       last_from    = EXCLUDED.last_from,
       last_snippet = EXCLUDED.last_snippet,
       can_reply    = EXCLUDED.can_reply,
       synced_at    = now()`,
    [id, account.id, account.provider, kind, String(t.externalId),
     t.parentKind || null, t.parentId || null, t.parentTitle || null, t.parentLink || null,
     withId, withName, withAvatar,
     Number(t.totalItems) || items.length,
     Boolean(t.unread ?? (last ? !last.mine : false)),
     last?.createdAt || null,
     last ? (last.mine ? 'us' : 'them') : null,
     snip(last?.body || (last?.attachments?.length ? '[attachment]' : '')),
     t.canReply !== false,
     JSON.stringify(t.raw || {})]
  );

  for (const it of items) await saveItem(account, kind, id, it);
  return id;
}

export async function saveItem(account, kind, tid, it){
  const id = itemId(account.id, it.externalId);
  await query(
    `INSERT INTO social_items
       (id, thread_id, account_id, platform, kind, external_id, reply_to,
        author_id, author_name, author_avatar, mine, body, likes, liked_by_us,
        reactions, attachments, created_at, pending, raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,false,$18, now())
     ON CONFLICT (id) DO UPDATE SET
       thread_id     = EXCLUDED.thread_id,
       reply_to      = EXCLUDED.reply_to,
       author_name   = EXCLUDED.author_name,
       author_avatar = COALESCE(EXCLUDED.author_avatar, social_items.author_avatar),
       body          = EXCLUDED.body,
       likes         = EXCLUDED.likes,
       liked_by_us   = EXCLUDED.liked_by_us,
       attachments   = EXCLUDED.attachments,
       created_at    = COALESCE(EXCLUDED.created_at, social_items.created_at),
       /* Coming back from the platform is what proves a locally posted item
          landed, so this is the one place pending is cleared. */
       pending       = false,
       synced_at     = now()`,
    [id, tid, account.id, account.provider, kind, String(it.externalId),
     it.replyTo || null, it.authorId || null, it.authorName || null, it.authorAvatar || null,
     Boolean(it.mine), it.body || '', Number(it.likes) || 0, Boolean(it.likedByUs),
     JSON.stringify(it.reactions || []), JSON.stringify(it.attachments || []),
     it.createdAt || null, JSON.stringify(it.raw || {})]
  );
  return id;
}

/* An item this app just created, before the platform has confirmed it in a
   list. pending is true, so a send that the platform later rejects does not sit
   in the thread looking delivered forever. */
async function savePending(account, kind, tid, it){
  const id = itemId(account.id, it.externalId || `local:${Date.now()}`);
  await query(
    `INSERT INTO social_items
       (id, thread_id, account_id, platform, kind, external_id, reply_to,
        author_id, author_name, author_avatar, mine, body, likes, liked_by_us,
        reactions, attachments, created_at, pending, raw, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,0,false,'[]'::jsonb,'[]'::jsonb,$12,true,'{}'::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, pending = true, synced_at = now()`,
    [id, tid, account.id, account.provider, kind, String(it.externalId || id),
     it.replyTo || null, it.authorId || null, it.authorName || 'You', it.authorAvatar || null,
     it.body || '', it.createdAt || new Date().toISOString()]
  );
  return id;
}

/* ---------------------------------------------------------------------------
   Syncing.
   --------------------------------------------------------------------------- */

async function ytChannelId(account, token){
  const row = await getAccount(account.id);
  if (row?.meta?.channelId) return row.meta.channelId;
  /* The account id is 'youtube:<channelId>' for every row discovery wrote, so
     this costs nothing in the normal case. */
  const fromId = String(account.id).replace(/^youtube:/, '');
  if (/^UC[\w-]{20,}$/.test(fromId)) return fromId;
  return (await youtube.channel(token)).channelId;
}

/* Titles for the videos a comment thread hangs under.

   One videos.list call for up to 50 ids and 1 quota unit, rather than one call
   per thread. Without it the list can say which video a comment is on only by
   id, and "dQw4w9WgXcQ" is not an answer to "where did this come from". */
async function ytVideoTitles(token, ids){
  const out = new Map();
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50);
    try {
      const j = await youtube.videosByIds(token, batch);
      for (const v of j) out.set(v.id, v);
    } catch {
      /* A missing title is a cosmetic loss; the comments still sync. */
    }
  }
  return out;
}

async function syncYouTube(account, token, { since }){
  const channelId = await ytChannelId(account, token);
  const threads = await youtube.comments(token, { channelId, since });
  const titles = await ytVideoTitles(token, threads.map(t => t.parentId));
  let items = 0;
  for (const t of threads) {
    const v = titles.get(t.parentId);
    await saveThread(account, 'comment', {
      ...t,
      parentTitle: v?.title || (t.parentId ? 'Video ' + t.parentId : null),
      parentLink: t.parentId ? `https://www.youtube.com/watch?v=${t.parentId}` : null
    });
    items += t.items.length;
  }
  return { threads: threads.length, items, notes: [] };
}

async function syncFacebook(account, token, { since, can }){
  const row = await getAccount(account.id);
  const pageId = row?.meta?.pageId || String(account.id).replace(/^facebook:/, '');
  const notes = [];
  let threads = 0, items = 0;

  try {
    const list = await meta.pageComments(token, pageId, { since });
    for (const t of list) { await saveThread(account, 'comment', t); items += t.items.length; }
    threads += list.length;
  } catch (err) {
    notes.push({ what: 'comments', error: err.message, needsScope: err.needsScope || null });
  }

  if (can?.messages) {
    try {
      const convs = await meta.conversations(token, { pageId, platform: 'facebook' });
      for (const c of convs) { await saveThread(account, 'message', c); items += c.items.length; }
      threads += convs.length;
    } catch (err) {
      notes.push({ what: 'messages', error: err.message, needsScope: err.needsScope || null });
    }
  } else {
    notes.push({ what: 'messages', error: CAP_WHY['facebook.messages'], needsScope: 'pages_messaging' });
  }
  return { threads, items, notes };
}

async function syncInstagram(account, token, { since, can }){
  const row = await getAccount(account.id);
  const igId = row?.meta?.igId || String(account.id).replace(/^instagram:/, '');
  const pageId = row?.meta?.parentPageId || null;
  const username = row?.meta?.username || null;
  const notes = [];
  let threads = 0, items = 0;

  try {
    const list = await meta.igComments(token, igId, { since, username });
    for (const t of list) { await saveThread(account, 'comment', t); items += t.items.length; }
    threads += list.length;
    /* The silent-partial case: Instagram said a post has comments and returned
       none of their text. Reported as a note rather than as an empty list. */
    if (list.missingText) {
      notes.push({
        what: 'comments',
        error: `Instagram reports ${list.missingText} comment`
          + (list.missingText === 1 ? '' : 's')
          + ' on recent posts and returned none of their text. '
          + CAP_WHY['instagram.read'],
        needsScope: 'instagram_manage_comments'
      });
    }
  } catch (err) {
    notes.push({ what: 'comments', error: err.message, needsScope: err.needsScope || null });
  }

  if (can?.messages && pageId) {
    try {
      const convs = await meta.conversations(token, { pageId, platform: 'instagram', igId });
      for (const c of convs) { await saveThread(account, 'message', c); items += c.items.length; }
      threads += convs.length;
    } catch (err) {
      notes.push({ what: 'messages', error: err.message, needsScope: err.needsScope || null });
    }
  } else {
    notes.push({
      what: 'messages',
      error: pageId ? CAP_WHY['instagram.messages']
        : 'This Instagram account has no parent Page recorded, and Instagram DMs are '
          + 'read through the Page. Reconnect Meta to record it.',
      needsScope: 'instagram_manage_messages'
    });
  }
  return { threads, items, notes };
}

const SYNCERS = { youtube: syncYouTube, facebook: syncFacebook, instagram: syncInstagram };

/* One pass over every account with an inbox.

   `since` per account, from sync_state, so a pass reads what has changed rather
   than the same three hundred comments every time. A first pass has no cursor
   and reads the recent window whole. */
export async function syncInbox({ only = null, full = false } = {}){
  const caps = await capabilities();
  let accounts = (await accountsFor('social'))
    .filter(a => INBOX_PLATFORMS.includes(a.provider));
  if (only) accounts = accounts.filter(a => only.has(a.provider) || only.has(a.id));

  const results = [];
  for (const account of accounts) {
    if (account.status !== 'ok') {
      results.push({ account: account.id, label: account.label, ok: false,
        error: `${account.label} needs reconnecting.`, reauth: true });
      continue;
    }
    const key = `inbox:${account.id}`;
    const state = full ? null : await inboxState(key);
    try {
      const token = await getAccessToken(account.id);
      const out = await SYNCERS[account.provider](account, token, {
        since: state?.cursor || null,
        can: caps[account.provider]?.can || {}
      });
      await setInboxState(key, {
        cursor: new Date().toISOString(),
        lastRun: new Date().toISOString(),
        lastError: null
      });
      results.push({ account: account.id, label: account.label, ok: true, ...out });
    } catch (err) {
      if (err.isAuth) await markReauth(account.id, err.message).catch(() => {});
      await setInboxState(key, { lastError: err.message }).catch(() => {});
      results.push({ account: account.id, label: account.label, ok: false, error: err.message });
    }
  }
  return { accounts: accounts.length, results };
}

async function inboxState(key){
  const { rows } = await query(`SELECT cursor, last_run, last_error FROM sync_state WHERE key = $1`, [key]);
  if (!rows[0]) return null;
  let cursor = null;
  try { cursor = JSON.parse(rows[0].cursor)?.at || null; } catch { cursor = null; }
  return { cursor, lastRun: rows[0].last_run, lastError: rows[0].last_error };
}

async function setInboxState(key, { cursor, lastRun, lastError } = {}){
  await query(
    `INSERT INTO sync_state (key, cursor, last_run, last_error, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (key) DO UPDATE SET
       cursor     = COALESCE(EXCLUDED.cursor, sync_state.cursor),
       last_run   = COALESCE(EXCLUDED.last_run, sync_state.last_run),
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [key, cursor == null ? null : JSON.stringify({ at: cursor }),
     lastRun || null, lastError ? String(lastError).slice(0, 500) : null]
  );
}

export async function inboxHealth(){
  const { rows } = await query(
    `SELECT key, last_run, last_error FROM sync_state WHERE key LIKE 'inbox:%'`);
  return rows.map(r => ({
    account: r.key.replace(/^inbox:/, ''),
    lastRun: r.last_run,
    lastError: r.last_error
  }));
}

/* ---------------------------------------------------------------------------
   Reading the mirror.
   --------------------------------------------------------------------------- */

const threadOut = r => ({
  id: r.id,
  account: r.account_id,
  platform: r.platform,
  kind: r.kind,
  externalId: r.external_id,
  /* Where the comment came from, which is the question the list has to answer
     before it is any use: the video or post it sits under, by name. */
  from: r.parent_id ? {
    kind: r.parent_kind, id: r.parent_id,
    title: r.parent_title || null, link: r.parent_link || null
  } : null,
  with: { id: r.with_id, name: r.with_name || 'Unknown', avatar: r.with_avatar },
  count: Number(r.item_count) || 0,
  held: Number(r.held) || 0,
  unread: r.unread,
  lastAt: r.last_at,
  lastFrom: r.last_from,
  snippet: r.last_snippet || '',
  canReply: r.can_reply,
  /* Local labels. Not on the platform, and the UI says so. */
  tags: r.tags || []
});

/* Tagging a thread.

   Local by necessity rather than by choice: none of the three platforms lets an
   app put a label on a comment or a conversation. So this is triage for whoever
   reads the dashboard next, and it never claims to be anything else.

   Normalised on the way in -- trimmed, lowercased, deduped, capped -- because
   "Follow up", "follow up" and "follow-up " as three separate tags is how a tag
   list stops being useful by the second week. */
export async function tagThread(id, tags){
  const clean = [...new Set((Array.isArray(tags) ? tags : [])
    .map(t => String(t).trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(t => t && t.length <= 32))].slice(0, 12);
  const { rows } = await query(
    `UPDATE social_threads SET tags = $2 WHERE id = $1 RETURNING tags`, [id, clean]);
  if (!rows.length) throw Object.assign(new Error('No such thread.'), { status: 404 });
  return { id, tags: rows[0].tags };
}

/* Every tag in use on this platform and kind, for the picker. Suggestions come
   from what has actually been used rather than from a fixed list nobody chose. */
export async function tagsInUse({ platform, kind }){
  const { rows } = await query(
    `SELECT DISTINCT unnest(tags) AS tag FROM social_threads
      WHERE platform = $1 AND kind = $2 ORDER BY 1`, [platform, kind]);
  return rows.map(r => r.tag);
}

export async function listThreads({ platform, kind, accountIds = null, q = null, unread = false,
  tag = null, limit = 50, offset = 0 } = {}){
  const params = [platform, kind];
  let where = `t.platform = $1 AND t.kind = $2`;
  if (accountIds?.length) { params.push(accountIds); where += ` AND t.account_id = ANY($${params.length})`; }
  if (unread) where += ` AND t.unread`;
  if (tag) { params.push(String(tag)); where += ` AND $${params.length} = ANY(t.tags)`; }
  if (q && String(q).trim().length >= 2) {
    params.push('%' + String(q).trim().replace(/[%_\\]/g, m => '\\' + m) + '%');
    const i = params.length;
    where += ` AND (t.with_name ILIKE $${i} ESCAPE '\\' OR t.last_snippet ILIKE $${i} ESCAPE '\\'`
      + ` OR t.parent_title ILIKE $${i} ESCAPE '\\')`;
  }
  params.push(Math.min(200, Math.max(1, Number(limit) || 50)));
  const lim = params.length;
  params.push(Math.max(0, Number(offset) || 0));
  const off = params.length;

  const { rows } = await query(
    `SELECT t.*, (SELECT COUNT(*) FROM social_items i WHERE i.thread_id = t.id) AS held
       FROM social_threads t
      WHERE ${where}
      ORDER BY t.last_at DESC NULLS LAST
      LIMIT $${lim} OFFSET $${off}`, params);

  const { rows: tot } = await query(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE unread)::int AS unread
       FROM social_threads t WHERE ${where}`, params.slice(0, lim - 1));

  return {
    threads: rows.map(threadOut),
    total: tot[0]?.n || 0,
    unreadCount: tot[0]?.unread || 0,
    offset: Math.max(0, Number(offset) || 0),
    hasMore: (Math.max(0, Number(offset) || 0) + rows.length) < (tot[0]?.n || 0)
  };
}

const itemOut = r => ({
  id: r.id,
  externalId: r.external_id,
  replyTo: r.reply_to,
  author: { id: r.author_id, name: r.author_name || 'Unknown', avatar: r.author_avatar },
  mine: r.mine,
  body: r.body || '',
  likes: Number(r.likes) || 0,
  likedByUs: r.liked_by_us,
  attachments: r.attachments || [],
  at: r.created_at,
  pending: r.pending
});

/* One thread, with its items in order.

   `fresh` re-reads the reply chain from the platform first, which is what makes
   "expand the comment history" show the whole of a long thread rather than the
   five replies that arrived inline with the list. It costs one quota unit and
   only happens when somebody opens a thread that is known to be truncated. */
export async function loadThread(id, { fresh = false } = {}){
  const { rows } = await query(`SELECT * FROM social_threads WHERE id = $1`, [id]);
  const t = rows[0];
  if (!t) return null;

  if (fresh && t.kind === 'comment' && t.platform === 'youtube') {
    const account = await getAccount(t.account_id);
    if (account && account.status === 'ok') {
      try {
        const token = await getAccessToken(t.account_id);
        const channelId = await ytChannelId({ id: t.account_id }, token);
        const replies = await youtube.commentReplies(token, t.external_id, { channelId });
        for (const it of replies) {
          await saveItem({ id: t.account_id, provider: t.platform }, 'comment', id, it);
        }
      } catch {
        /* The stored copy is still worth showing. */
      }
    }
  }

  const { rows: items } = await query(
    `SELECT * FROM social_items WHERE thread_id = $1
      ORDER BY created_at NULLS FIRST, id`, [id]);
  return { thread: threadOut({ ...t, held: items.length }), items: items.map(itemOut) };
}

export async function markThreadRead(id, read = true){
  await query(`UPDATE social_threads SET unread = $2 WHERE id = $1`, [id, !read]);
  return { id, unread: !read };
}

/* Who can be mentioned, for the @ picker.

   Everyone who has written in this thread, plus the connected accounts. It is
   deliberately not a directory search: none of these platforms exposes one to
   an app, and a mention only resolves for someone already in the conversation. */
export async function mentionable(threadIdArg){
  const { rows } = await query(
    `SELECT DISTINCT author_id, author_name, author_avatar, mine
       FROM social_items WHERE thread_id = $1 AND author_name IS NOT NULL`,
    [threadIdArg]);
  return rows
    .filter(r => !r.mine)
    .map(r => ({ id: r.author_id, name: r.author_name, avatar: r.author_avatar }));
}

/* ---------------------------------------------------------------------------
   Writing to the platform.
   --------------------------------------------------------------------------- */

async function accountFor(id){
  const a = await getAccount(id);
  if (!a) throw Object.assign(new Error('That account is not connected here.'), { status: 404 });
  if (a.status !== 'ok') {
    throw Object.assign(new Error(`${a.label} needs reconnecting before it can post.`),
      { status: 409 });
  }
  return a;
}

/* A reply into an existing thread. */
export async function reply(id, text){
  const { rows } = await query(`SELECT * FROM social_threads WHERE id = $1`, [id]);
  const t = rows[0];
  if (!t) throw Object.assign(new Error('No such thread.'), { status: 404 });
  const account = await accountFor(t.account_id);
  const token = await getAccessToken(account.id);

  if (t.kind === 'message') {
    if (!t.with_id) throw Object.assign(new Error('That conversation has no recipient recorded.'), { status: 409 });
    const pageId = account.meta?.parentPageId || account.meta?.pageId
      || String(account.id).replace(/^(facebook|instagram):/, '');
    const sent = await meta.sendMessage(token, {
      pageId, recipientId: t.with_id, text, platform: t.platform
    });
    const itemRowId = await savePending(account, 'message', id, {
      externalId: sent.externalId || `local:${Date.now()}`,
      authorId: pageId, authorName: account.label, body: text,
      createdAt: new Date().toISOString()
    });
    await query(
      `UPDATE social_threads SET last_at = now(), last_from = 'us', last_snippet = $2,
         unread = false, item_count = item_count + 1 WHERE id = $1`, [id, snip(text)]);
    return { itemId: itemRowId, pending: true };
  }

  let it;
  if (t.platform === 'youtube') {
    it = await youtube.replyToComment(token, {
      parentId: t.external_id, text,
      channelId: await ytChannelId(account, token)
    });
  } else {
    it = await meta.replyToComment(token, {
      platform: t.platform, commentId: t.external_id, text,
      pageId: account.meta?.pageId || null,
      igId: account.meta?.igId || null,
      username: account.meta?.username || null
    });
  }
  it.mine = true;
  const rowId = await saveItem(account, 'comment', id, it);
  await query(
    `UPDATE social_threads SET last_at = COALESCE($3, now()), last_from = 'us',
       last_snippet = $2, unread = false,
       item_count = GREATEST(item_count + 1, (SELECT COUNT(*) FROM social_items WHERE thread_id = $1))
     WHERE id = $1`, [id, snip(text), it.createdAt || null]);
  return { itemId: rowId, item: it };
}

/* A new top-level comment on one of the account's own posts. */
export async function postComment({ accountId, parentId, text }){
  const account = await accountFor(accountId);
  const token = await getAccessToken(account.id);
  let out;
  if (account.provider === 'youtube') {
    out = await youtube.postComment(token, {
      videoId: parentId, text, channelId: await ytChannelId(account, token)
    });
  } else {
    out = await meta.commentOnPost(token, {
      platform: account.provider, postId: parentId, text,
      pageId: account.meta?.pageId || null,
      igId: account.meta?.igId || null,
      username: account.meta?.username || null
    });
  }
  const id = await saveThread(account, 'comment', {
    ...out.thread,
    items: [{ ...out.item, mine: true }]
  });
  return { threadId: id, item: out.item };
}

/* A reaction. Only Facebook comments have one, and the other two throw with the
   reason rather than pretending. */
export async function react({ threadId: tid, itemId: iid, on = true }){
  const { rows } = await query(
    `SELECT i.*, t.platform AS tplatform FROM social_items i
       JOIN social_threads t ON t.id = i.thread_id
      WHERE i.id = $1 AND i.thread_id = $2`, [iid, tid]);
  const it = rows[0];
  if (!it) throw Object.assign(new Error('No such comment.'), { status: 404 });
  const account = await accountFor(it.account_id);
  const token = await getAccessToken(account.id);

  if (account.provider === 'youtube') {
    throw Object.assign(new Error(CAP_WHY['youtube.react']), { status: 501 });
  }
  if (account.provider === 'instagram') {
    throw Object.assign(new Error(CAP_WHY['instagram.react']), { status: 501 });
  }
  await meta.likeComment(token, { platform: 'facebook', commentId: it.external_id, on });
  await query(
    `UPDATE social_items SET liked_by_us = $2,
       likes = GREATEST(0, likes + CASE WHEN $2 THEN 1 ELSE -1 END)
     WHERE id = $1`, [iid, Boolean(on)]);
  return { itemId: iid, liked: Boolean(on) };
}

/* What a new comment can be posted under: the account's own recent posts, from
   social_posts, which the metrics poller already fills. No extra API call. */
export async function postTargets(accountIds){
  if (!accountIds?.length) return [];
  const { rows } = await query(
    `SELECT id, account_id, platform, external_id, title, permalink, published_at
       FROM social_posts
      WHERE account_id = ANY($1)
      ORDER BY published_at DESC NULLS LAST
      LIMIT 60`, [accountIds]);
  return rows.map(r => ({
    account: r.account_id,
    platform: r.platform,
    id: r.external_id,
    title: r.title || '(no title)',
    link: r.permalink,
    at: r.published_at
  }));
}
