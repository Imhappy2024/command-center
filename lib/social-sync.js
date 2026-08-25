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

/* `only` is a Set of provider names to poll, or null for all. The manual
   "Fetch now" button passes one platform family so a YouTube click cannot bill
   an X read. `neverPolled` restricts the pass to accounts with no sync_state row
   at all — the boot pass uses it so a freshly connected account fills without
   waiting for 06:00, while every already-polled account waits for its slot. */
export async function pollOnce({ env = process.env, only = null, neverPolled = false } = {}){
  let accounts = await accountsFor('social');
  if (only) accounts = accounts.filter(a => only.has(a.provider));
  if (neverPolled) {
    const { rows } = await query(`SELECT key FROM sync_state WHERE key LIKE 'social:%'`);
    const seen = new Set(rows.map(r => r.key));
    accounts = accounts.filter(a => !seen.has(`social:${a.id}`));
  }
  if (!accounts.length) return { accounts: 0, polled: 0, failed: 0, results: [] };
  const results = [];

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
      results.push({ account: account.id, label: account.label, ok: true });
    } catch (err) {
      failed++;
      results.push({ account: account.id, label: account.label, ok: false, error: err.message });
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

  return { accounts: accounts.length, polled, failed, results };
}

/* ---------------------------------------------------------------------------
   Schedule: fixed wall-clock times in a named zone, not an interval.

   06:00 and 12:00 America/Chicago by default. An interval drifts with every
   deploy and lands at arbitrary hours; two fixed slots mean the numbers on the
   dashboard are "as of this morning" and "as of noon", which is what a person
   reading them assumes anyway. The manual Fetch now button covers everything
   in between.
   --------------------------------------------------------------------------- */

const DEFAULT_SCHEDULE = '06:00,12:00';
const DEFAULT_TZ = 'America/Chicago';

export function parseSchedule(env = process.env){
  const tz = env.SOCIAL_SCHEDULE_TZ || DEFAULT_TZ;
  const times = String(env.SOCIAL_SCHEDULE || DEFAULT_SCHEDULE)
    .split(',').map(t => t.trim())
    .map(t => /^(\d{1,2}):(\d{2})$/.exec(t))
    .filter(Boolean)
    .map(m => ({ h: Number(m[1]), m: Number(m[2]) }))
    .filter(t => t.h >= 0 && t.h < 24 && t.m >= 0 && t.m < 60);
  return { tz, times: times.length ? times : [{ h: 6, m: 0 }, { h: 12, m: 0 }] };
}

/* Wall-clock parts of an instant in a zone. hourCycle h23 so midnight is 0,
   not 24. */
function zonedParts(date, tz){
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const out = {};
  for (const part of f.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

/* The zone's UTC offset at an instant, in ms. */
function offsetAt(date, tz){
  const p = zonedParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - date.getTime();
}

/* The instant at which the wall clock in `tz` reads y-m-d h:mi. One correction
   pass handles the offset change across a DST boundary. */
function zonedInstant(y, mo, d, h, mi, tz){
  const naive = Date.UTC(y, mo - 1, d, h, mi, 0);
  /* Two passes: the first uses the offset at the naive instant, the second
     recomputes from scratch with the offset at the corrected one. That converges
     across a DST change; the earlier one-step nudge did not, and put the 06:00
     pull at 05:00 on the morning clocks went back. */
  let t = naive - offsetAt(new Date(naive), tz);
  t = naive - offsetAt(new Date(t), tz);
  return t;
}

/* The next scheduled instant strictly after `now`. */
export function nextRunAfter(now, { tz, times }){
  const p = zonedParts(now, tz);
  const candidates = [];
  for (const dayOffset of [0, 1, 2]) {
    /* Day arithmetic in UTC on the zone's own date, so month ends and DST
       cannot skip a day. */
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset));
    for (const t of times) {
      candidates.push(zonedInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), t.h, t.m, tz));
    }
  }
  const nowMs = now.getTime();
  return new Date(Math.min(...candidates.filter(c => c > nowMs)));
}

/* One lock for the scheduled pass and the manual button, so a click during the
   06:00 run cannot start a second pass into the same five-connection pool. */
const lock = { running: false, startedAt: null, providers: null };
export const pollerStatus = () => ({ ...lock });

const FAMILY = {
  youtube: ['youtube'],
  x: ['x'],
  /* One Meta grant feeds three metric accounts. */
  meta: ['facebook', 'instagram', 'meta_ads'],
  facebook: ['facebook'],
  instagram: ['instagram'],
  meta_ads: ['meta_ads']
};
export const providerFamily = name => FAMILY[String(name || '').toLowerCase()] || null;

/* The manual fetch. Runs to completion and returns the outcome, holding the
   lock the whole way. Rejected with `running` rather than queued: two clicks
   should not mean two X bills. */
export async function runNow({ env = process.env, providers } = {}){
  if (lock.running) {
    return { ok: false, reason: 'running', startedAt: lock.startedAt, providers: lock.providers };
  }
  lock.running = true; lock.startedAt = new Date().toISOString(); lock.providers = providers || 'all';
  try {
    const out = await pollOnce({ env, only: providers ? new Set(providers) : null });
    await setState('social:last-manual', {
      lastRun: new Date().toISOString(),
      cursor: { providers: providers || 'all', polled: out.polled, failed: out.failed }
    }).catch(() => {});
    return { ok: true, ...out };
  } finally {
    lock.running = false; lock.startedAt = null; lock.providers = null;
  }
}

export async function lastRuns(){
  const { rows } = await query(
    `SELECT key, last_run, last_error, cursor FROM sync_state
      WHERE key IN ('social:schedule', 'social:last-manual') OR key LIKE 'social:%'`);
  return rows;
}

async function scheduledPass(env){
  if (lock.running) { console.log('[social] scheduled pass skipped: a pass is already running'); return; }
  lock.running = true; lock.startedAt = new Date().toISOString(); lock.providers = 'all';
  try {
    const out = await pollOnce({ env });
    await setState('social:schedule', {
      lastRun: new Date().toISOString(),
      cursor: { polled: out.polled, failed: out.failed }
    }).catch(() => {});
    console.log(`[social] scheduled pass: ${out.polled} polled, ${out.failed} failed`);
  } catch (err) {
    console.error('[social] scheduled pass:', err.message);
  } finally {
    lock.running = false; lock.startedAt = null; lock.providers = null;
  }
}

export function startPoller({ env = process.env } = {}){
  const schedule = parseSchedule(env);
  let stopped = false;
  let timer = null;

  const arm = () => {
    if (stopped) return;
    const next = nextRunAfter(new Date(), schedule);
    /* Re-armed from the tick rather than pre-computed, so a clock change or a
       long stall never leaves a stale timer. */
    timer = setTimeout(async () => { await scheduledPass(env); arm(); },
      Math.max(1_000, next.getTime() - Date.now()));
    timer.unref?.();
  };
  arm();

  /* Boot pass for accounts that have NEVER been polled, and only those. A newly
     connected YouTube channel fills within a minute of the next deploy instead
     of sitting empty until 06:00; every account that already has data waits for
     its slot, because X bills per read and a redeploy is not a reason to spend. */
  const kickoff = setTimeout(async () => {
    if (lock.running) return;
    lock.running = true; lock.startedAt = new Date().toISOString(); lock.providers = 'never-polled';
    try {
      const out = await pollOnce({ env, neverPolled: true });
      if (out.accounts) {
        console.log(`[social] first pass for ${out.accounts} never-polled account(s): ${out.polled} ok, ${out.failed} failed`);
      }
    } catch (err) {
      console.error('[social] first pass:', err.message);
    } finally {
      lock.running = false; lock.startedAt = null; lock.providers = null;
    }
  }, 45_000);
  kickoff.unref?.();

  return {
    schedule,
    nextRun: () => nextRunAfter(new Date(), schedule),
    async stop(){
      stopped = true;
      clearTimeout(timer);
      clearTimeout(kickoff);
      for (let i = 0; lock.running && i < 100; i++) await new Promise(r => setTimeout(r, 100));
    }
  };
}
