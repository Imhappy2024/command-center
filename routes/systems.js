/* Systems: automations that are run by hand.

   Seven are listed. Three — Create a Clip, Pull and Analyze Metrics, and
   Checkout Links — are built; the other four say so rather than presenting a
   button that does nothing.

   Create a Clip wraps OpusClip. The first version hosted uploads on this server
   and handed OpusClip the URL, which the service refuses: `videoUrl` only
   accepts links from a platform whitelist, and anything else fails preflight
   with a 422. Local files go through OpusClip's own four-step upload instead,
   and the bytes are streamed request-to-storage without ever touching our disk.
   The public /media route that existed to serve them is gone with it. */

import express from 'express';
import { Readable } from 'node:stream';
import * as opus from '../providers/opus.js';
import * as whop from '../providers/whop.js';
import * as store from '../lib/clip-store.js';
import * as whopStore from '../lib/whop-store.js';
import { guarded } from './guard.js';

export const AUTOMATIONS = [
  { id:'clip',      name:'Create a Clip',            built:true,
    blurb:'Turn a long video into short vertical clips with OpusClip, preview them, then schedule.' },
  { id:'metrics',   name:'Pull and Analyze Metrics', built:true, agent:true,
    blurb:'Four analyst agents — YouTube, Facebook, Instagram, X. They read the numbers, '
      + 'show the working, and say what to change.' },
  { id:'whop',      name:'Checkout Links',           built:true,
    blurb:'Create a Whop product with its price and get a checkout link back, ready to copy.' },
  { id:'today',     name:'Plan Today',               built:false,
    blurb:'Calendar, unread mail and open leads folded into one running order.' },
  { id:'tomorrow',  name:'Plan Tomorrow',            built:false,
    blurb:'The same, built the evening before.' },
  { id:'inbox',     name:'Inbox brief',              built:false,
    blurb:'What arrived, what needs a reply, and what can wait.' },
  { id:'weekly',    name:'Weekly Review',            built:false,
    blurb:'Seven days of leads, spend and publishing in one page.' }
];

const MAX_UPLOAD = 30 * 1024 * 1024 * 1024;   // the service's own ceiling

export function systemRoutes({ env, auth }){
  const r = express.Router();
  const cfg = () => opus.configured(env);

  /* ---------------- listing ---------------- */

  r.get('/api/systems', auth.require, guarded('api/systems', async (req, res) => {
    const projects = await store.listProjects(12).catch(() => []);
    res.json({
      automations: AUTOMATIONS,
      clip: {
        configured: cfg(),
        setupHint: 'Set OPUS_API_KEY from clip.opus.pro/dashboard. OPUS_ORG_ID is optional.',
        sourceHosts: opus.SOURCE_HOSTS,
        recent: projects
      },
      whop: {
        configured: whop.configured(env),
        setupHint: 'Set WHOP_API_KEY to an Account API key from your Whop dashboard settings.'
      }
    });
  }));

  /* ---------------- upload ----------------

     Four steps, and the bytes never land on our disk: ask OpusClip for an
     upload link, open the resumable session, then pipe this request straight
     into it. The browser sends the raw file as the body, so there is no
     multipart parser; Node needs duplex:'half' to use a stream as a fetch body.

     What comes back is an uploadId, and THAT is what the create call passes as
     videoUrl. Handing the service a URL of our own is what failed before. */
  r.post('/api/systems/clip/upload', auth.require, async (req, res) => {
    if (!cfg()) return res.status(400).json({ error: 'OpusClip is not configured. Set OPUS_API_KEY.' });
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD) {
      return res.status(413).json({ error: 'That file is over OpusClip\'s 30 GB ceiling.' });
    }
    if (declared === 0) return res.status(400).json({ error: 'Empty upload.' });

    /* A long transfer must not be cut off by a socket timeout. */
    req.setTimeout?.(0);
    res.setTimeout?.(0);

    let session;
    try {
      session = await opus.beginUpload(env);
    } catch (err) {
      return res.status(502).json({ error: 'Could not start the upload: ' + err.message });
    }

    try {
      const put = await fetch(session.location, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(declared) },
        body: Readable.toWeb(req),
        duplex: 'half'
      });
      if (!put.ok) {
        const t = await put.text().catch(() => '');
        return res.status(502).json({ error: `Storage rejected the upload (${put.status}). ${t.slice(0, 200)}` });
      }
    } catch (err) {
      return res.status(502).json({ error: 'Upload failed: ' + err.message });
    }

    res.json({ uploadId: session.uploadId, bytes: declared });
  });

  /* ---------------- create ---------------- */

  r.post('/api/systems/clip/projects', auth.require, express.json({ limit: '1mb' }),
    guarded('api/systems/clip:create', async (req, res) => {
      const b = req.body || {};
      if (!cfg()) return res.status(400).json({ error: 'OpusClip is not configured. Set OPUS_API_KEY.' });

      const sourceKind = b.uploadId ? 'upload' : 'url';
      let videoUrl;
      if (sourceKind === 'upload') {
        videoUrl = String(b.uploadId);
      } else {
        videoUrl = String(b.videoUrl || '').trim();
        if (!/^https?:\/\//i.test(videoUrl)) {
          return res.status(400).json({ error: 'Paste a full http(s) video link, or upload a file.' });
        }
        /* Refused here rather than after a round trip: the service rejects
           anything off its whitelist at preflight, and its own message does not
           say which links it would have taken. */
        if (!opus.sourceLooksSupported(videoUrl)) {
          return res.status(400).json({
            error: 'OpusClip only fetches links from YouTube, Vimeo, Google Drive, Zoom, Rumble, Twitch, '
              + 'Facebook, LinkedIn, X, Dropbox, Riverside, Loom, Frame.io and StreamYard, or a direct .mp4. '
              + 'Upload the file instead.'
          });
        }
      }

      const prefs = b.prefs || {};
      const id = store.newId();
      await store.createProjectRow({
        id, title: b.title || null, sourceKind,
        sourceUrl: sourceKind === 'url' ? videoUrl : null,
        mediaToken: null, prefs
      });

      try {
        const base = (env.PUBLIC_URL || '').replace(/\/+$/, '');
        const out = await opus.createProject(env, {
          videoUrl, title: b.title || null, prefs,
          webhookUrl: base ? base + '/webhooks/opus' : null
        });
        if (!out.opusProjectId) {
          await store.setProjectStatus(id, 'failed', 'OpusClip returned no project id.');
          return res.status(502).json({ error: 'OpusClip returned no project id.', projectId: id, raw: out.raw });
        }
        res.json({ project: await store.setProjectSubmitted(id, out) });
      } catch (err) {
        await store.setProjectStatus(id, 'failed', err.message);
        res.status(err.status === 401 ? 401 : 502).json({ error: err.message, projectId: id });
      }
    }));

  /* ---------------- read + poll ---------------- */

  r.get('/api/systems/clip/projects', auth.require, guarded('api/systems/clip:list', async (req, res) => {
    res.json({ projects: await store.listProjects(40) });
  }));

  r.get('/api/systems/clip/projects/:id', auth.require, guarded('api/systems/clip:one', async (req, res) => {
    const project = await store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'No such project.' });
    const clips = await store.listClips(project.id);
    const schedules = await store.listSchedules(clips.map(c => c.id));
    res.json({ project, clips, schedules });
  }));

  /* Ask OpusClip what it has. Polling rather than waiting on the webhook,
     because a webhook that has not been configured leaves a project stuck at
     "processing" forever with no way to find out otherwise. */
  r.post('/api/systems/clip/projects/:id/refresh', auth.require,
    guarded('api/systems/clip:refresh', async (req, res) => {
      const project = await store.getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'No such project.' });
      if (!project.opusProjectId) return res.status(400).json({ error: 'This project was never accepted by OpusClip.' });
      if (!cfg()) return res.status(400).json({ error: 'OpusClip is not configured.' });

      try {
        const found = await opus.getClips(env, project.opusProjectId);
        const n = await store.upsertClips(project.id, found);
        if (n) await store.setProjectStatus(project.id, 'ready', null);
        res.json({
          project: await store.getProject(project.id),
          clips: await store.listClips(project.id),
          found: n,
          note: n ? null : 'No clips yet. Rendering usually takes a few minutes per hour of source.'
        });
      } catch (err) {
        await store.setProjectStatus(project.id, project.status, err.message);
        res.status(502).json({ error: err.message });
      }
    }));

  r.delete('/api/systems/clip/projects/:id', auth.require,
    guarded('api/systems/clip:delete', async (req, res) => {
      await store.deleteProject(req.params.id);
      res.json({ ok: true });
    }));

  /* ---------------- brand templates + destinations ---------------- */

  r.get('/api/systems/clip/templates', auth.require, guarded('api/systems/clip:templates', async (req, res) => {
    if (!cfg()) return res.json({ templates: [], configured: false });
    try { res.json({ templates: await opus.brandTemplates(env), configured: true }); }
    catch (err) { res.json({ templates: [], configured: true, error: err.message }); }
  }));

  r.get('/api/systems/clip/destinations', auth.require, guarded('api/systems/clip:dest', async (req, res) => {
    if (!cfg()) return res.json({ accounts: [], configured: false });
    try { res.json({ accounts: await opus.socialAccounts(env), configured: true }); }
    catch (err) { res.json({ accounts: [], configured: true, error: err.message }); }
  }));

  r.get('/api/systems/clip/usage', auth.require, guarded('api/systems/clip:usage', async (req, res) => {
    if (!cfg()) return res.json({ configured: false });
    try { res.json({ configured: true, ...(await opus.usage(env)) }); }
    catch (err) { res.json({ configured: true, error: err.message }); }
  }));

  /* One clip, gone from our list. OpusClip keeps its own copy — this is the
     dashboard's view, not a deletion on their side, and the wording says so. */
  r.delete('/api/systems/clip/clips/:id', auth.require, guarded('api/systems/clip:delclip', async (req, res) => {
    await store.deleteClip(req.params.id);
    res.json({ ok: true });
  }));

  /* ---------------- publish / schedule ---------------- */

  /* Publish or schedule. `targets` is a list of accounts, so one clip can go to
     one platform, several, or all of them in a single action. Each target is
     recorded separately: a partial failure has to be visible per destination
     rather than collapsing the whole thing into one error. */
  r.post('/api/systems/clip/clips/:id/schedule', auth.require, express.json(),
    guarded('api/systems/clip:schedule', async (req, res) => {
      const clip = await store.getClip(req.params.id);
      if (!clip) return res.status(404).json({ error: 'No such clip.' });
      if (!cfg()) return res.status(400).json({ error: 'OpusClip is not configured.' });

      const project = await store.getProject(clip.projectId);
      if (!project?.opusProjectId) return res.status(400).json({ error: 'That clip has no OpusClip project.' });

      const targets = Array.isArray(req.body?.targets) ? req.body.targets : [];
      if (!targets.length) return res.status(400).json({ error: 'Pick at least one account to post to.' });

      const when = req.body?.publishAt ? new Date(req.body.publishAt) : null;
      if (req.body?.publishAt && isNaN(when?.getTime())) {
        return res.status(400).json({ error: 'That is not a valid date and time.' });
      }
      if (when && when.getTime() < Date.now() - 60_000) {
        return res.status(400).json({ error: 'That time has already passed.' });
      }

      const title = String(req.body?.title || clip.title || '').slice(0, 300);
      const description = String(req.body?.description || '').slice(0, 5000);
      const privacy = ['public', 'private', 'unlisted'].includes(req.body?.privacy) ? req.body.privacy : undefined;

      const results = [];
      for (const t of targets) {
        const rowId = store.newId('sch');
        const label = [t.platformLabel, t.name].filter(Boolean).join(' · ') || t.postAccountId;
        try {
          const args = {
            projectId: project.opusProjectId, clipId: clip.opusClipId,
            postAccountId: t.postAccountId, subAccountId: t.subAccountId || null,
            title, description, privacy
          };
          const out = when
            ? await opus.schedulePost(env, { ...args, publishAt: when.toISOString() })
            : await opus.publishNow(env, args);
          await store.addSchedule({
            id: rowId, clipId: clip.id, target: label, caption: description,
            scheduledAt: when ? when.toISOString() : null,
            opusScheduleId: when ? out.scheduleId : null,
            status: when ? 'scheduled' : 'published'
          });
          results.push({ target: label, ok: true });
        } catch (err) {
          await store.addSchedule({
            id: rowId, clipId: clip.id, target: label, caption: description,
            scheduledAt: when ? when.toISOString() : null, status: 'failed', error: err.message
          });
          results.push({ target: label, ok: false, error: err.message });
        }
      }
      const failed = results.filter(x => !x.ok);
      res.status(failed.length && failed.length === results.length ? 502 : 200)
         .json({ ok: !failed.length, results });
    }));

  /* ---------------- webhook ---------------- */

  r.post('/webhooks/opus', express.json({ limit: '2mb' }), async (req, res) => {
    /* Answered immediately: a webhook that waits on our database is a webhook
       the sender retries. */
    res.json({ ok: true });
    try {
      const b = req.body || {};
      const opusId = b.projectId || b.project?.id || b.data?.projectId || b.data?.project?.id;
      if (!opusId) return;
      const project = await store.getProjectByOpusId(String(opusId));
      if (!project) return;
      const out = await opus.getClips(env, project.opusProjectId);
      const n = await store.upsertClips(project.id, out.clips);
      if (n) await store.setProjectStatus(project.id, 'ready', null);
      console.log(`[opus:webhook] ${project.id}: ${n} clip(s)`);
    } catch (err) {
      console.error('[opus:webhook]', err.message);
    }
  });

  /* ---------------- diagnostics ----------------

     The response shapes are inferred from documentation that does not publish
     them. This returns what the service actually sends, so the readers in
     providers/opus.js can be corrected against a real payload rather than
     against more docs. */
  r.get('/api/systems/clip/diag', auth.require, guarded('api/systems/clip:diag', async (req, res) => {
    const out = { configured: cfg(), base: 'https://api.opus.pro/api', durableStorage: store.mediaIsDurable(env) };
    if (!cfg()) { out.hint = 'Set OPUS_API_KEY.'; return res.json(out); }
    const probe = async (name, path) => {
      try { out[name] = { ok: true, body: await opus.raw(env, path) }; }
      catch (err) { out[name] = { ok: false, status: err.status, error: err.message }; }
    };
    await probe('brandTemplates', '/brand-templates?q=mine');
    await probe('socialAccounts', '/social-accounts?q=mine');
    await probe('usage', '/api-usage?q=mine');
    if (req.query.projectId) {
      await probe('exportableClips', `/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(req.query.projectId)}`);
    }
    res.json(out);
  }));

  /* =========================================================================
     Checkout Links — Whop.

     A product on Whop holds no price; a plan does, and the plan's purchase_url
     is the checkout link. So "create a product" here is two writes, and the
     link only exists after the second one. That ordering is why a plan failure
     still returns 200 with the product and an explanatory note rather than an
     error: the product is real by then, and telling the user it failed would
     leave an orphan they cannot see.
     ========================================================================= */

  const whopCfg = () => whop.configured(env);
  const notConfigured = res => res.status(400).json({
    error: 'Whop is not configured. Set WHOP_API_KEY.' });

  /* The list. Prices come from three places, in descending order of trust:
     the plan Whop returns for the product, the row we wrote when we created it,
     and nothing. */
  r.get('/api/systems/whop/products', auth.require,
    guarded('api/systems/whop:list', async (req, res) => {
      if (!whopCfg()) {
        return res.json({ configured: false, products: [],
          setupHint: 'Set WHOP_API_KEY to an Account API key from your Whop dashboard settings.' });
      }

      const remembered = await whopStore.byProduct().catch(() => new Map());

      let products, warning = null;
      try {
        products = await whop.listProducts(env, { limit: 60 });
      } catch (err) {
        /* An unreachable Whop should still show what we created, so the copy
           buttons keep working while the API is down. */
        const rows = await whopStore.recent(60).catch(() => []);
        return res.status(err.status === 401 ? 401 : 200).json({
          configured: true,
          products: rows.map(m => ({
            id: m.productId, title: m.title, priceLabel: m.priceLabel,
            url: m.purchaseUrl, productUrl: m.productUrl, planId: m.planId,
            createdAt: m.createdAt, stale: true
          })),
          error: err.message,
          warning: 'Showing links saved here — Whop could not be reached.'
        });
      }

      /* One call for every plan on the account, then joined in memory. Asking
         per product would be a request per row. */
      let plansByProduct = null;
      try {
        const plans = await whop.listPlans(env);
        if (plans) {
          plansByProduct = new Map();
          for (const p of plans) {
            const pid = whop.planProductId(p);
            if (!pid) continue;
            if (!plansByProduct.has(pid)) plansByProduct.set(pid, []);
            plansByProduct.get(pid).push(p);
          }
        }
      } catch (err) {
        warning = 'Prices could not be read from Whop: ' + err.message;
      }

      const shaped = products.map(p => {
        const mine = remembered.get(p.id) || null;
        const plans = plansByProduct?.get(p.id) || [];
        /* The cheapest visible plan is the one a storefront leads with. */
        const plan = plans.filter(x => x?.visibility !== 'archived')
          .sort((a, b) => Number(a?.initial_price ?? 0) - Number(b?.initial_price ?? 0))[0] || null;

        return {
          id: p.id,
          title: p.title || p.id,
          visibility: p.visibility || null,
          memberCount: p.member_count ?? null,
          createdAt: p.created_at || mine?.createdAt || null,
          planId: plan?.id || mine?.planId || null,
          priceLabel: whop.planLabel(plan) || mine?.priceLabel || null,
          url: whop.absolute(plan?.purchase_url)
            || mine?.purchaseUrl
            || whop.planCheckoutUrl(plan?.id || mine?.planId),
          productUrl: whop.productPageUrl(p) || mine?.productUrl || null
        };
      });

      res.json({ configured: true, products: shaped, warning, periods: whop.PERIODS,
        currencies: whop.CURRENCIES });
    }));

  /* Create. `access` is 'free' or 'paid'; a free product is a one-time plan at
     zero, which is how Whop expresses free access. */
  r.post('/api/systems/whop/products', auth.require, express.json({ limit: '64kb' }),
    guarded('api/systems/whop:create', async (req, res) => {
      if (!whopCfg()) return notConfigured(res);
      const b = req.body || {};

      const title = String(b.title || '').trim();
      if (!title) return res.status(400).json({ error: 'Give the product a name.' });
      if (title.length > 80) return res.status(400).json({ error: 'Whop caps a product name at 80 characters.' });

      const free = b.access === 'free';
      const amount = free ? 0 : Number(b.amount);
      if (!free && (!Number.isFinite(amount) || amount < 0)) {
        return res.status(400).json({ error: 'That is not a price.' });
      }
      if (!free && amount > 999999) {
        return res.status(400).json({ error: 'That price is too large.' });
      }

      /* A recurring plan that charges nothing is a subscription to zero, and
         Whop has no reason to accept one. Paid-at-zero is free access, so it is
         created as free access and the response says so. */
      const zeroed = !free && amount === 0;
      const planType = (free || zeroed) ? 'one_time'
        : (b.planType === 'renewal' ? 'renewal' : 'one_time');

      const currency = whop.CURRENCIES.includes(String(b.currency || '').toLowerCase())
        ? String(b.currency).toLowerCase() : 'usd';
      const billingPeriodDays = whop.PERIODS.some(p => p.days === Number(b.billingPeriodDays))
        ? Number(b.billingPeriodDays) : 30;

      let product;
      try {
        product = await whop.createProduct(env, { title });
      } catch (err) {
        return res.status(err.status === 401 ? 401 : 502).json({ error: err.message });
      }

      /* From here the product exists on Whop. Everything below reports rather
         than fails, so a half-finished create is visible instead of invisible. */
      let plan = null;
      let note = zeroed ? 'The price was zero, so this was created as free access.' : null;
      try {
        plan = await whop.createPlan(env, {
          productId: product.id, planType, amount, currency, billingPeriodDays
        });
      } catch (err) {
        note = 'The product was created, but its price was not: ' + err.message
          + ' Set the price in Whop, then reload this list.';
      }

      const url = plan ? await whop.resolveLink(env, plan) : null;
      const productUrl = whop.productPageUrl(product);
      const priceLabel = whop.priceLabel({ planType, amount, currency, billingPeriodDays });

      if (plan) {
        await whopStore.remember({
          productId: product.id, planId: plan.id, title,
          planType, amount, currency,
          billingPeriodDays: planType === 'renewal' ? billingPeriodDays : null,
          priceLabel, purchaseUrl: url, productUrl
        }).catch(err => console.error('[whop] could not save the link locally:', err.message));
      }

      res.json({
        product: {
          id: product.id,
          title: product.title || title,
          visibility: product.visibility || null,
          memberCount: product.member_count ?? 0,
          createdAt: product.created_at || new Date().toISOString(),
          planId: plan?.id || null,
          priceLabel: plan ? priceLabel : null,
          url,
          productUrl
        },
        note
      });
    }));

  /* Drops our copy of the link. The product stays on Whop — deleting it there
     would take the members with it, and this button is in a dashboard. */
  r.delete('/api/systems/whop/products/:id', auth.require,
    guarded('api/systems/whop:forget', async (req, res) => {
      await whopStore.forget(req.params.id);
      res.json({ ok: true, note: 'Removed from the saved links. The product is still on Whop.' });
    }));

  /* Same purpose as the OpusClip probe above: read the shapes back from the
     real account rather than from prose. */
  r.get('/api/systems/whop/diag', auth.require, guarded('api/systems/whop:diag', async (req, res) => {
    const out = { configured: whopCfg(), base: 'https://api.whop.com/api/v1' };
    if (!whopCfg()) { out.hint = 'Set WHOP_API_KEY.'; return res.json(out); }
    const probe = async (name, path, query) => {
      try { out[name] = { ok: true, body: await whop.raw(env, path, query) }; }
      catch (err) { out[name] = { ok: false, status: err.status, error: err.message }; }
    };
    await probe('me', '/accounts/me');
    let acct = null;
    try { acct = await whop.accountId(env); out.accountId = acct; } catch (err) { out.accountError = err.message; }
    if (acct) {
      await probe('products', '/products', { account_id: acct, first: 3 });
      await probe('plans', '/plans', { account_id: acct, first: 3 });
    }
    res.json(out);
  }));

  return r;
}
