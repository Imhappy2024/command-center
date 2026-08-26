/* Express assembly, separated from the boot sequence so it can be mounted in a
   test without opening a database connection or a port. */

import express from 'express';
import compression from 'compression';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { makeAuth } from './session.js';
import { startWorker } from './ghl-webhook.js';
import { startLive } from './ghl-live.js';
import { startPoller } from './social-sync.js';
import { authRoutes } from '../routes/auth.js';
import { connectRoutes } from '../routes/connect.js';
import { mailRoutes } from '../routes/mail.js';
import { calendarRoutes } from '../routes/calendar.js';
import { ghlRoutes } from '../routes/ghl.js';
import { socialRoutes } from '../routes/social.js';
import { systemRoutes } from '../routes/systems.js';
import { claudeRoutes, claudeIsLocal } from '../routes/claude.js';
import { selfUpdateRoutes } from '../routes/selfupdate.js';
import { taskRoutes } from '../routes/tasks.js';
import { propertyRoutes } from '../routes/properties.js';

/* index.html is served through here rather than by express.static, because the
   frontend needs to know which auth mode it is running under: on `open` it draws
   an "unprotected" marker in the rail, so a public deployment never looks
   identical to a gated one. Cached, revalidated by mtime, so editing the file in
   dev is picked up without a restart. */
/* When this process started. A page carries the stamp it was served with, so
   the frontend can tell the server restarted underneath it -- which is exactly
   what happens after an in-app update, and what otherwise leaves someone
   looking at last build's UI wondering why nothing changed. */
export const BOOT = Date.now();

function shellLoader(publicDir, mode){
  const file = path.join(publicDir, 'index.html');
  const inject = `<script>window.__AUTH_MODE = ${JSON.stringify(mode)};window.__BOOT = ${BOOT};</script>\n</head>`;
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

  /* The live bridge exists only alongside the other background work: it holds a
     dedicated database connection, which is exactly what tests mounting this app
     with background:false are promised not to open. Routes get a null and skip
     the SSE endpoint. */
  const live = background ? startLive() : { async stop(){} };

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
  app.use(ghlRoutes({ env, auth, live }));
  app.use(socialRoutes({ env, auth }));
  app.use(taskRoutes({ env, auth }));
  app.use(propertyRoutes({ env, auth }));
  /* Systems mounts /media/:token unauthenticated on purpose — OpusClip fetches
     uploaded source video from there and carries no session. The unguessable
     token is what contains it. */
  app.use(systemRoutes({ env, auth }));
  /* Only on a local run. A hosted deployment must never expose an endpoint that
     spawns a coding agent — this one is AUTH_MODE=open, so that would be a shell
     for anyone with the URL. */
  if (claudeIsLocal(env)) {
    app.use(claudeRoutes({ env, auth }));
    /* Same gate: `git pull` behind a public URL is remote code execution with a
       friendly name. A hosted deployment updates by deploying. */
    app.use(selfUpdateRoutes({ env, auth, boot: BOOT }));
  }

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

  /* The manifest and icons sit in front of auth. A browser fetches both when
     deciding whether the page is installable, and in `remember` mode a 401 on
     the manifest means the Install option never appears. Neither file reveals
     anything: they are a name, a colour and five flat images. */
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json')
       .set('Cache-Control', 'public, max-age=3600')
       .sendFile(path.join(publicDir, 'manifest.webmanifest'));
  });
  app.use('/icons', express.static(path.join(publicDir, 'icons'), {
    maxAge: '7d', index: false, fallthrough: false
  }));
  app.get('/favicon.ico', (req, res) => {
    res.set('Cache-Control', 'public, max-age=604800')
       .sendFile(path.join(publicDir, 'favicon.ico'));
  });

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
  app.locals.background = { social: null, async stop(){} };
  if (background) {
    /* The webhook worker drains webhook_events into Supabase; the social poller
       calls platform APIs that have to be called from somewhere; the live bridge
       LISTENs for the portal triggers and streams them to open dashboards. */
    const worker = startWorker();
    const social = startPoller({ env });
    app.locals.background = {
      social,
      async stop(){
        /* All awaited: each holds a connection, and the pool closes next. */
        await Promise.all([worker.stop(), social.stop(), live.stop()]);
      }
    };
  }

  return app;
}
