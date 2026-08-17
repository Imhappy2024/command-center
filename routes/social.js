/* Social metrics and ads.

   Nothing is connected yet and nothing can be: Meta requires Business
   Verification and App Review, which run on Meta's clock, and META_APP_ID is not
   set. These routes exist so the frontend has a real contract to load from and
   the views show their own empty states rather than a failed fetch.

   They return empty. They do not return plausible numbers. */

import express from 'express';

const configured = env => Boolean(env.META_APP_ID && env.META_APP_SECRET);

export function socialRoutes({ env, auth }){
  const r = express.Router();

  const notice = () => configured(env)
    ? 'Meta app configured, but no page or account is connected yet.'
    : 'No social source connected. Meta needs META_APP_ID and META_APP_SECRET, plus Business Verification.';

  r.get('/api/social', auth.require, (req, res) =>
    res.json({ platforms: [], configured: configured(env), notice: notice() }));

  r.get('/api/social/ads', auth.require, (req, res) =>
    res.json({ ads: null, configured: configured(env), notice: notice() }));

  r.get('/api/social/posts', auth.require, (req, res) =>
    res.json({ posts: [], configured: configured(env), notice: notice() }));

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

  r.post('/webhooks/meta', express.json({ limit: '1mb' }), (req, res) =>
    res.status(501).json({ error: 'Meta webhook receiver not built yet.' }));

  return r;
}
