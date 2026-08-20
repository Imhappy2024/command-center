/* Social metrics and ads.

   Every route here reads social_metrics, social_posts and ads_daily. No platform
   API is called from a request handler — lib/social-sync.js owns that, on a
   timer. YouTube's quota cannot be bought, Meta Ads throttles on spend, and X
   bills per read; a dashboard that fetched on page load would be slow, expensive
   and rate-limited at once.

   Nothing here invents a number. No prior snapshot means a zero delta, not an
   estimate, and a platform that publishes no such metric reads as absent rather
   than as measured zero. */

import express from 'express';
import { query } from '../db/index.js';
import { accountsFor } from '../lib/accounts.js';
import { guarded } from './guard.js';

const configured = env => Boolean(env.META_APP_ID && env.META_APP_SECRET);

const RANGES = [7, 28, 90];
const rangeOf = q => {
  const n = Number(q);
  return RANGES.includes(n) ? n : 28;
};

/* The four platforms the Social view draws a card for. The grant row (`meta`)
   publishes no metrics of its own, and LinkedIn is rendered by the frontend as a
   permanently closed API. */
const PLATFORMS = ['facebook', 'instagram', 'youtube', 'x'];

const TZ = process.env.AGENT_TIMEZONE || undefined;
const monthDay = d => new Intl.DateTimeFormat('en-US',
  { timeZone: TZ, month: 'short', day: 'numeric' }).format(d);

/* 'now', '3h', 'Yesterday', 'Aug 4' — the Content table's `when` column. */
function whenLabel(value, now = Date.now()){
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const ms = now - d.getTime();
  if (ms < 3_600_000) return 'now';
  if (ms < 86_400_000) return `${Math.max(1, Math.floor(ms / 3_600_000))}h`;
  if (ms < 2 * 86_400_000) return 'Yesterday';
  return monthDay(d);
}

export function socialRoutes({ env, auth }){
  const r = express.Router();

  const notice = accounts => {
    if (!accounts.length) {
      return configured(env)
        ? 'Meta app configured, but no page or account is connected yet.'
        : 'No social source connected. Meta needs META_APP_ID and META_APP_SECRET, plus Business Verification.';
    }
    const stale = accounts.filter(a => a.status !== 'ok');
    return stale.length
      ? `${stale.length} of ${accounts.length} accounts need reconnecting.`
      : null;
  };

  /* ---------------- audience ---------------- */

  r.get('/api/social', auth.require, guarded('api/social', async (req, res) => {
    const days = rangeOf(req.query.range);
    const accounts = (await accountsFor('social'))
      .filter(a => PLATFORMS.includes(a.provider));

    if (!accounts.length) {
      return res.json({ platforms: [], configured: configured(env), notice: notice([]) });
    }

    const ids = accounts.map(a => a.id);

    /* Two facts per account in one pass: the totals across the window, and the
       newest and oldest follower readings inside it. The delta is the difference
       between those two readings — which is why social_metrics exists at all, and
       why it is 0 rather than a guess before a second day has been recorded. */
    const { rows } = await query(
      `WITH win AS (
         SELECT * FROM social_metrics
          WHERE account_id = ANY($1)
            AND day >= (CURRENT_DATE - $2::int)
       ),
       totals AS (
         SELECT account_id,
                SUM(reach)        AS reach,
                SUM(views)        AS views,
                SUM(interactions) AS interactions
           FROM win GROUP BY account_id
       ),
       newest AS (
         SELECT DISTINCT ON (account_id) account_id, followers, day
           FROM win WHERE followers IS NOT NULL
          ORDER BY account_id, day DESC
       ),
       oldest AS (
         SELECT DISTINCT ON (account_id) account_id, followers, day
           FROM win WHERE followers IS NOT NULL
          ORDER BY account_id, day ASC
       )
       SELECT a.id AS account_id,
              t.reach, t.views, t.interactions,
              n.followers AS followers_now, n.day AS newest_day,
              o.followers AS followers_then, o.day AS oldest_day
         FROM unnest($1::text[]) AS a(id)
         LEFT JOIN totals t ON t.account_id = a.id
         LEFT JOIN newest n ON n.account_id = a.id
         LEFT JOIN oldest o ON o.account_id = a.id`,
      [ids, days]
    );

    const byId = new Map(rows.map(r2 => [r2.account_id, r2]));

    const platforms = accounts.map(a => {
      const m = byId.get(a.id) || {};
      const followers = Number(m.followers_now) || 0;

      /* Only a real earlier reading produces a delta. One snapshot means the
         newest and the oldest are the same row, which is correctly 0. */
      const hasTwo = m.newest_day && m.oldest_day && m.newest_day !== m.oldest_day;
      const followerDelta = hasTwo
        ? (Number(m.followers_now) || 0) - (Number(m.followers_then) || 0)
        : 0;

      /* The UI calls num() on these and .toFixed(2) on engagement, so all four
         have to be numbers. NULL in the table means the platform publishes no
         such metric — YouTube has no unique-reach figure and X none either — and
         it surfaces here as 0 because the card has nowhere to say "not
         published". Noted in the README rather than papered over. */
      const reach = Number(m.reach) || 0;
      const views = Number(m.views) || 0;
      const interactions = Number(m.interactions) || 0;

      return {
        platform: a.provider,
        handle: a.email || a.label,
        followers,
        followerDelta,
        reach,
        views,
        /* Interactions over reach, never over followers. Guarded because a
           platform with no reach figure would otherwise divide by zero and render
           Infinity. */
        engagement: reach > 0 ? (interactions / reach) * 100 : 0,
        status: a.status
      };
    });

    res.json({ platforms, configured: configured(env), notice: notice(accounts) });
  }));

  /* ---------------- ads ---------------- */

  r.get('/api/social/ads', auth.require, guarded('api/social/ads', async (req, res) => {
    const days = rangeOf(req.query.range);
    const accounts = (await accountsFor('social')).filter(a => a.provider === 'meta_ads');

    /* null, not an empty object. The UI has an empty state that explains
       Business Verification, and it keys on ads being absent. */
    if (!accounts.length) {
      return res.json({ ads: null, configured: configured(env), notice: notice([]) });
    }

    const ids = accounts.map(a => a.id);

    const { rows: latest } = await query(
      `SELECT DISTINCT ON (account_id, campaign_id)
              account_id, campaign_id, campaign, objective, status,
              spend, reach, results, currency, day
         FROM ads_daily
        WHERE account_id = ANY($1) AND day >= (CURRENT_DATE - $2::int)
        ORDER BY account_id, campaign_id, day DESC`,
      [ids, days]
    );

    if (!latest.length) {
      return res.json({
        ads: null,
        configured: configured(env),
        notice: 'An ad account is connected, but no data has been polled yet.'
      });
    }

    const rollups = latest.filter(r2 => r2.campaign_id === '');
    const campaigns = latest.filter(r2 => r2.campaign_id !== '');

    const spend = rollups.reduce((n, r2) => n + Number(r2.spend), 0);
    const results = rollups.reduce((n, r2) => n + Number(r2.results), 0);
    const reach = rollups.reduce((n, r2) => n + Number(r2.reach), 0);

    /* Compared against the window immediately before this one. Absent that, the
       delta is 0 — the UI renders it as a percentage and an invented trend is
       worse than a flat one. */
    const { rows: prior } = await query(
      `SELECT COALESCE(SUM(spend), 0) AS spend, COALESCE(SUM(results), 0) AS results
         FROM ads_daily
        WHERE account_id = ANY($1) AND campaign_id = ''
          AND day <  (CURRENT_DATE - $2::int)
          AND day >= (CURRENT_DATE - ($2::int * 2))`,
      [ids, days]
    );

    const prevSpend = Number(prior[0]?.spend) || 0;
    const prevResults = Number(prior[0]?.results) || 0;

    const pct = (now, before) => before > 0 ? Math.round(((now - before) / before) * 100) : 0;
    const cpl = (s, n) => n > 0 ? s / n : 0;

    res.json({
      ads: {
        spend,
        results,
        resultsDelta: pct(results, prevResults),
        cplDelta: pct(cpl(spend, results), cpl(prevSpend, prevResults)),
        reach,
        campaigns: campaigns
          .map(c => ({
            name: c.campaign || '(unnamed campaign)',
            objective: c.objective || '',
            spend: Number(c.spend) || 0,
            results: Number(c.results) || 0,
            status: c.status || 'Active'
          }))
          .sort((a, b) => b.spend - a.spend)
      },
      configured: configured(env),
      notice: notice(accounts)
    });
  }));

  /* ---------------- content ---------------- */

  r.get('/api/social/posts', auth.require, guarded('api/social/posts', async (req, res) => {
    const days = rangeOf(req.query.range);
    const accounts = (await accountsFor('social'))
      .filter(a => PLATFORMS.includes(a.provider));

    if (!accounts.length) {
      return res.json({ posts: [], configured: configured(env), notice: notice([]) });
    }

    const { rows } = await query(
      `SELECT platform, title, published_at, reach, views, shares
         FROM social_posts
        WHERE account_id = ANY($1)
          AND published_at >= (now() - ($2::int || ' days')::interval)
        ORDER BY published_at DESC
        LIMIT 200`,
      [accounts.map(a => a.id), days]
    );

    /* The Content table ranks by shares divided by reach, so a post with no reach
       figure has no rank and would render Infinity. YouTube and X publish no
       per-post reach at all, which means their posts cannot appear in a table
       built on that ratio. Dropped here rather than rendered as nonsense, and
       counted so the omission is visible instead of silent. */
    const rankable = rows.filter(p => Number(p.reach) > 0);
    const dropped = rows.length - rankable.length;

    res.json({
      posts: rankable.map(p => ({
        platform: p.platform,
        title: p.title || '(untitled)',
        when: whenLabel(p.published_at),
        reach: Number(p.reach) || 0,
        views: Number(p.views) || 0,
        shares: Number(p.shares) || 0
      })),
      configured: configured(env),
      notice: dropped
        ? `${dropped} post${dropped === 1 ? '' : 's'} hidden: this table ranks by shares per reach, `
          + 'and YouTube and X publish no per-post reach.'
        : notice(accounts)
    });
  }));

  /* Meta verifies a subscription by echoing hub.challenge back. Answering it
     correctly costs nothing and means the subscription can be set up before the
     event handler exists. */
  r.get('/webhooks/meta', (req, res) => {
    const token = env.META_WEBHOOK_VERIFY_TOKEN;
    if (!token) return res.sendStatus(503);
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === token) {
      return res.status(200).send(String(req.query['hub.challenge'] || ''));
    }
    res.sendStatus(403);
  });

  /* Still 501. This is a metrics build with no subscriptions, and answering 200
     would tell Meta a receiver exists when none does. */
  r.post('/webhooks/meta', express.json({ limit: '1mb' }), (req, res) =>
    res.status(501).json({ error: 'Meta webhook receiver not built yet.' }));

  return r;
}
