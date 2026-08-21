/* Express assembly, separated from the boot sequence so it can be mounted in a
   test without opening a database connection or a port. */

import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { makeAuth } from './session.js';
import { startWorker } from './ghl-webhook.js';
import { startPoller } from './social-sync.js';
import { authRoutes } from '../routes/auth.js';
import { connectRoutes } from '../routes/connect.js';
import { mailRoutes } from '../routes/mail.js';
import { calendarRoutes } from '../routes/calendar.js';
import { ghlRoutes } from '../routes/ghl.js';
import { socialRoutes } from '../routes/social.js';

/* index.html is served through here rather than by express.static, because the
   frontend needs to know which auth mode it is running under: on `open` it draws
   an "unprotected" marker in the rail, so a public deployment never looks
   identical to a gated one. Cached, revalidated by mtime, so editing the file in
   dev is picked up without a restart. */
function shellLoader(publicDir, mode){
  const file = path.join(publicDir, 'index.html');
  const inject = `<script>window.__AUTH_MODE = ${JSON.stringify(mode)};</script>\n</head>`;
  let cache = null;

  return async () => {
    const { mtimeMs } = await stat(file);
    if (cache?.mtimeMs === mtimeMs) return cache.html;

    const raw = await readFile(file, 'utf8');
    if (!raw.includes('</head>')) throw new Error('index.html has no </head> to inject into');
    cache = { mtimeMs, html: raw.replace('</head>', inject) };
    return cache.html;
  };
}

/* `background` defaults on but is an option rather than unconditional, because
   the whole point of this file is that it can be mounted in a test without
   opening a database connection — and the webhook worker polls Postgres. Pass
   background: false to keep that promise. */
export function createApp({ env, publicDir, background = true }){
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(compression());

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  const auth = makeAuth({
    mode: env.AUTH_MODE,
    password: env.APP_PASSWORD,
    secret: env.SESSION_SECRET,
    isSecure: () => String(env.PUBLIC_URL || '').startsWith('https:') || env.NODE_ENV === 'production'
  });

  /* Open so Railway's healthcheck can reach it without a session. Reports
     nothing about configuration or connected accounts. */
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), ts: new Date().toISOString() });
  });

  /* No /login at all when the gate is off. Mounting it would leave a form that
     sets a cookie nothing ever reads. */
  if (auth.isOpen) {
    app.get('/login', (req, res) => res.redirect('/'));
  } else {
    app.use(authRoutes({ auth, publicDir }));
    app.use('/login.html', (req, res) => res.redirect('/login'));
  }

  app.use(connectRoutes({ env, auth, secret: env.SESSION_SECRET }));
  app.use(mailRoutes({ env, auth }));
  app.use(calendarRoutes({ auth }));
  app.use(ghlRoutes({ env, auth }));
  app.use(socialRoutes({ env, auth }));

  const loadShell = shellLoader(publicDir, auth.mode);
  const shell = async (req, res) => {
    try {
      res.set('Content-Type', 'text/html; charset=utf-8')
         .set('Cache-Control', 'no-cache')
         .send(await loadShell());
    } catch (err) {
      console.error('[shell]', err.message);
      res.status(500).type('text/plain').send('Dashboard shell unavailable.');
    }
  };

  // Bypassing the injection by asking for the file directly would lose the flag.
  app.get(['/', '/index.html'], auth.require, shell);

  app.use(auth.require, express.static(publicDir, {
    index: false,
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
    if (!auth.valid(req)) return res.redirect('/login');
    shell(req, res).catch(next);
  });

  /* Background work hangs off app.locals so server.js can drain it from the
     shutdown handler it already has, rather than growing a second one. */
  app.locals.background = { socialMinutes: null, async stop(){} };
  if (background) {
    /* Two, not three. The GHL reconciler is gone: command-center no longer syncs
       GHL, so there is nothing here to reconcile. The webhook worker stays —
       it drains webhook_events into Supabase — and the social poller stays
       because those platform APIs still have to be called from somewhere. */
    const worker = startWorker();
    const social = startPoller({ env });
    app.locals.background = {
      socialMinutes: social.intervalMinutes,
      async stop(){
        /* Both awaited: each holds queries, and the pool closes next. */
        await Promise.all([worker.stop(), social.stop()]);
      }
    };
  }

  return app;
}
