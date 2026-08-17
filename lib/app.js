/* Express assembly, separated from the boot sequence so it can be mounted in a
   test without opening a database connection or a port. */

import express from 'express';
import compression from 'compression';
import path from 'node:path';

import { makeAuth } from './session.js';
import { authRoutes } from '../routes/auth.js';
import { connectRoutes } from '../routes/connect.js';
import { mailRoutes } from '../routes/mail.js';
import { calendarRoutes } from '../routes/calendar.js';

export function createApp({ env, publicDir }){
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
    password: env.APP_PASSWORD,
    secret: env.SESSION_SECRET,
    isSecure: () => String(env.PUBLIC_URL || '').startsWith('https:') || env.NODE_ENV === 'production'
  });

  /* Open so Railway's healthcheck can reach it without a session. Reports
     nothing about configuration or connected accounts. */
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), ts: new Date().toISOString() });
  });

  app.use(authRoutes({ auth, publicDir }));
  app.use(connectRoutes({ env, auth, secret: env.SESSION_SECRET }));
  app.use(mailRoutes({ env, auth }));
  app.use(calendarRoutes({ auth }));

  /* login.html is reachable only through /login, which renders it while signed
     out; everything else under public/ is behind the gate. */
  app.use('/login.html', (req, res) => res.redirect('/login'));
  app.use(auth.require, express.static(publicDir, {
    extensions: ['html'],
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
    if (!auth.valid(req)) return res.redirect('/login');
    res.status(200).sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}
