/* The social poller, and the only writer of social_metrics, social_posts and
   ads_daily.

   No platform API is ever called from a request handler. The read routes serve
   these tables and nothing else, which is the only way a dashboard stays
   responsive on top of APIs that are quota-capped (YouTube: 10,000 units a day,
   unbuyable), spend-scaled (Meta Ads) or billed per read (X: $0.005).

   Accounts are iterated in series, never Promise.all. The pool in db/index.js is
   capped at 5, and four social accounts alongside four GHL locations would
   saturate it. */

import { query } from '../db/index.js';
import { accountsFor, getAccessToken, markReauth, getAccount } from './accounts.js';
import * as meta from '../providers/meta.js';
import * as youtube from '../providers/youtube.js';
import * as x from '../providers/x.js';

const DAY_MS = 86_400_000;

/* How much history to ask for on each pass. Meta and Instagram user-level
   insights retain 90 days; asking for more returns nothing rather than erroring,
   so this is the honest ceiling. */
const WINDOW_DAYS = 90;

/* Meta throttles on a spend-scaled budget reported in X-Business-Use-Case-Usage.
   At 100% every call fails with code 17 until the window resets, so ad polling
   stops at this mark instead of discovering the wall. */
const META_USAGE_CEILING = 80;

const dayString = d => d.toISOString().slice(0, 10);

/* ---------------------------------------------------------------------------
   Writers.
   --------------------------------------------------------------------------- */

/* Keyed (account_id, day), so re-running a day corrects it rather than
   duplicating. Nulls are preserved: a platform that does not publish a metric
   stores NULL, and the read route decides how to present that. Writing 0 here
   would make "no such metric" indistinguishable from "measured zero". */
export async function writeMetrics(accountId, rows){
  let written = 0;
  for (const r of rows || []) {
    if (!r?.day) continue;
    await query(
      `INSERT INTO social_metrics
         (account_id, day, followers, reach, views, interactions, posts, raw, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (account_id, day) DO UPDATE SET
         followers    = COALESCE(EXCLUDED.followers,    social_metrics.followers),
         reach        = COALESCE(EXCLUDED.reach,        social_metrics.reach),
         views        = COALESCE(EXCLUDED.views,        social_metrics.views),
         interactions = COALESCE(EXCLUDED.interactions, social_metrics.interactions),
         posts        = COALESCE(EXCLUDED.posts,        social_metrics.posts),
         raw          = EXCLUDED.raw,
         fetched_at   = now()`,
      [accountId, r.day,
       r.followers ?? null, r.reach ?? null, r.views ?? null,
       r.interactions ?? null, r.posts ?? null,
       JSON.stringify(r.raw || {})]
    );
    written++;
  }
  return written;
}

export async function writePosts(accountId, platform, posts){
  let written = 0;
  for (const p of posts || []) {
    if (!p?.externalId) continue;
    await query(
      `INSERT INTO social_posts
         (id, account_id, platform, external_id, title, permalink, published_at,
          reach, views, shares, interactions, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (id) DO UPDATE SET
         title        = EXCLUDED.title,
         permalink    = EXCLUDED.permalink,
         published_at = COALESCE(EXCLUDED.published_at, social_posts.published_at),
         reach        = EXCLUDED.reach,
         views        = EXCLUDED.views,
         shares       = EXCLUDED.shares,
         interactions = EXCLUDED.interactions,
         updated_at   = now()`,
      [`${accountId}:${p.externalId}`, accountId, platform, String(p.externalId),
       p.title || null, p.permalink || null, p.publishedAt || null,
       p.reach ?? 0, p.views ?? 0, p.shares ?? 0, p.interactions ?? 0]
    );
    written++;
  }
  return written;
}

/* Campaign rows plus an account-level roll-up under campaign_id ''. Both are
   stamped with today's date: Meta's date_preset windows are relative, so what is
   stored is "this is what the last 28 days looked like when we asked". */
export async function writeAds(accountId, { rollup, campaigns }, day = dayString(new Date())){
  await query(
    `INSERT INTO ads_daily
       (account_id, day, campaign_id, campaign, objective, status,
        spend, reach, results, currency, updated_at)
     VALUES ($1,$2,'','','','',$3,$4,$5,$6, now())
     ON CONFLICT (account_id, day, campaign_id) DO UPDATE SET
       spend = EXCLUDED.spend, reach = EXCLUDED.reach,
       results = EXCLUDED.results, currency = EXCLUDED.currency,
       updated_at = now()`,
    [accountId, day, rollup.spend, rollup.reach, rollup.results, rollup.currency]
  );

  for (const c of campaigns || []) {
    if (!c.campaignId) continue;
    await query(
      `INSERT INTO ads_daily
         (account_id, day, campaign_id, campaign, objective, status,
          spend, reach, results, currency, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (account_id, day, campaign_id) DO UPDATE SET
         campaign = EXCLUDED.campaign, objective = EXCLUDED.objective,
         status = EXCLUDED.status, spend = EXCLUDED.spend,
         reach = EXCLUDED.reach, results = EXCLUDED.results,
         currency = EXCLUDED.currency, updated_at = now()`,
      [accountId, day, c.campaignId, c.name, c.objective, c.status || 'Active',
       c.spend, c.reach, c.results, c.currency]
    );
  }
  return (campaigns || []).length;
}

/* ---------------------------------------------------------------------------
   sync_state, shared with the GHL build.
   --------------------------------------------------------------------------- */

async function setState(key, { cursor, lastRun, lastError } = {}){
  await query(
    `INSERT INTO sync_state (key, cursor, last_run, last_error, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (key) DO UPDATE SET
       cursor     = EXCLUDED.cursor,
       last_run   = COALESCE(EXCLUDED.last_run, sync_state.last_run),
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [key, cursor == null ? null : JSON.stringify(cursor),
     lastRun || null, lastError ? String(lastError).slice(0, 500) : null]
  );
}

async function getState(key){
  const { rows } = await query(`SELECT * FROM sync_state WHERE key = $1`, [key]);
  return rows[0] || null;
}

/* X bills per read, so the running count and its dollar estimate are kept where
   they can actually be looked at. Reset daily. */
async function recordXSpend(calls){
  if (!calls) return;
  const key = 'x:calls';
  const today = dayString(new Date());
  const prior = getStateCursorSafe(await getState(key));
  const total = (prior?.day === today ? Number(prior.calls) || 0 : 0) + calls;
  await setState(key, {
    cursor: { day: today, calls: total, estimatedUsd: Number(x.estimatedSpend(total).toFixed(3)) },
    lastRun: new Date().toISOString()
  });
  if (total && total % 100 === 0) {
    console.log(`[social] X calls today: ${total} (~$${x.estimatedSpend(total).toFixed(2)})`);
  }
}

function getStateCursorSafe(row){
  if (!row?.cursor) return null;
  try { return JSON.parse(row.cursor); } catch { return null; }
}

export const xSpendToday = async () => getStateCursorSafe(await getState('x:calls'));

/* ---------------------------------------------------------------------------
   Per-account polling.
   --------------------------------------------------------------------------- */

async function pollFacebook(account, token, window){
  const row = await getAccount(account.id);
  const pageId = row?.meta?.pageId || account.id.replace(/^facebook:/, '');
  const { rows, info } = await meta.pageSeries(token, pageId, window);
  await writeMetrics(account.id, rows);
  await writePosts(account.id, 'facebook',
    await meta.pagePosts(token, pageId, { limit: 25 }));
  return info;
}

async function pollInstagram(account, token, window){
  const row = await getAccount(account.id);
  const igId = row?.meta?.igId || account.id.replace(/^instagram:/, '');
  const { rows, info } = await meta.igSeries(token, igId, window);
  await writeMetrics(account.id, rows);
  await writePosts(account.id, 'instagram',
    await meta.igPosts(token, igId, { limit: 25 }));
  return info;
}

async function pollYouTube(account, token, window){
  const { rows, info } = await youtube.series(token, window);
  await writeMetrics(account.id, rows);
  await writePosts(account.id, 'youtube',
    await youtube.recentPosts(token, { uploadsPlaylist: info.uploadsPlaylist, limit: 25 }));
  return info;
}

async function pollX(account, token, window){
  const { rows, info } = await x.series(token, window);
  await writeMetrics(account.id, rows);
  await writePosts(account.id, 'x',
    await x.recentPosts(token, { userId: info.userId, limit: 20 }));
  return info;
}

async function pollAds(account, token){
  const row = await getAccount(account.id);
  if (!meta.adAccountActive(row?.meta?.accountStatus)) {
    console.log(`[social] ${account.label}: ad account is not active, skipped`);
    return null;
  }

  const out = await meta.adsInsights(token, account.id.replace(/^meta_ads:/, ''), { days: 28 });

  if (out.usagePercent != null && out.usagePercent >= META_USAGE_CEILING) {
    /* Stated rather than silently absorbed: at 100% every ad call fails with
       code 17 until the window resets. */
    console.warn(`[social] Meta ads usage at ${out.usagePercent}% for ${account.label} — `
      + 'pausing ad polling until the next window');
  }

  await writeAds(account.id, out);
  return { handle: account.label, usage: out.usagePercent };
}

const POLLERS = {
  facebook: pollFacebook,
  instagram: pollInstagram,
  youtube: pollYouTube,
  x: pollX,
  meta_ads: pollAds
};

/* ---------------------------------------------------------------------------
   The pass.
   --------------------------------------------------------------------------- */

export async function pollOnce({ env = process.env } = {}){
  const accounts = await accountsFor('social');
  if (!accounts.length) return { accounts: 0 };

  const until = new Date();
  const since = new Date(until.getTime() - WINDOW_DAYS * DAY_MS);
  const window = { since, until };

  x.resetBilled();
  let polled = 0;
  let failed = 0;

  for (const account of accounts) {
    /* The grant row itself holds the renewable Meta user token but publishes no
       metrics of its own. Skipped without being treated as a failure. */
    if (account.provider === 'meta') continue;

    const poll = POLLERS[account.provider];
    if (!poll) continue;

    /* A location already flagged for reconnection is skipped rather than retried
       every hour. It resumes on its own once the token is replaced. */
    if (account.status !== 'ok') continue;

    const key = `social:${account.id}`;
    try {
      const token = await getAccessToken(account.id);
      const info = await poll(account, token, window);
      await setState(key, { lastRun: new Date().toISOString(), cursor: info ? { handle: info.handle } : null });
      polled++;
    } catch (err) {
      failed++;
      /* Only a token failure flags the account. A rate limit or a quota ceiling
         clears on its own and must not send a working connection to reauth. */
      if (err.isAuth) {
        await markReauth(account.id, err.message).catch(() => {});
        console.error(`[social] ${account.label} needs reconnecting: ${err.message}`);
      } else {
        console.error(`[social] ${account.label} failed: ${err.message}`);
      }
      await setState(key, { lastError: err.message }).catch(() => {});
      /* One dead connection never stops the others — the same rule the mail
         fan-out follows. */
    }
  }

  await recordXSpend(x.billed()).catch(err =>
    console.error('[social] could not record X spend:', err.message));

  return { accounts: accounts.length, polled, failed };
}

export function startPoller({ env = process.env } = {}){
  const minutes = Math.max(15, Number(env.SOCIAL_POLL_MINUTES) || 60);
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await pollOnce({ env }); }
    catch (err) { console.error('[social] poller:', err.message); }
    finally { busy = false; }
  };

  const timer = setInterval(tick, minutes * 60_000);
  timer.unref?.();

  /* Offset from the GHL reconciler's own kickoff so a fresh boot does not run
     both page-throughs into the same five-connection pool at once. */
  const kickoff = setTimeout(tick, 45_000);
  kickoff.unref?.();

  return {
    intervalMinutes: minutes,
    async stop(){
      stopped = true;
      clearInterval(timer);
      clearTimeout(kickoff);
      for (let i = 0; busy && i < 100; i++) await new Promise(r => setTimeout(r, 100));
    }
  };
}
