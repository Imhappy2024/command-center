/* Login, and the OAuth connect/disconnect round trip. */

import express from 'express';
import path from 'node:path';
import { PROVIDERS, isConfigured, exchangeCode } from './providers.mjs';
import {
  STATE_COOKIE, sign, unsign, parseCookies, setCookie, clearCookie,
  passwordMatches, newState
} from './session.mjs';

export function baseUrl(req, env){
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

const redirectUri = (req, env, name) => `${baseUrl(req, env)}/oauth/callback/${name}`;

export function mountRoutes(app, { env, auth, store, publicDir, onConnected }){
  const r = express.Router();
  const isSecure = req => baseUrl(req, env).startsWith('https:');

  /* ---------------- login ---------------- */

  r.get('/login', (req, res) => {
    if (!auth.enabled || auth.valid(req)) return res.redirect('/');
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  r.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    if (!auth.enabled) return res.redirect('/');
    if (!passwordMatches(req.body?.password || '', env.APP_PASSWORD)) {
      return res.redirect('/login?error=1');
    }
    auth.issue(res);
    res.redirect('/');
  });

  r.post('/logout', (req, res) => { auth.clear(res); res.redirect('/login'); });

  /* ---------------- connections ---------------- */

  const guard = (req, res) => {
    if (!auth.enabled) {
      res.status(403).json({
        error: 'Set APP_PASSWORD before connecting accounts. Without a login, ' +
               'anyone with this URL could connect an account or read the mail of one already connected.'
      });
      return false;
    }
    if (!store.enabled) {
      res.status(500).json({ error: 'No encryption key: set ENCRYPTION_KEY or APP_PASSWORD.' });
      return false;
    }
    return true;
  };

  r.get('/api/connections', auth.require, async (req, res) => {
    const saved = await store.all();
    res.json({
      canConnect: auth.enabled && store.enabled,
      loginRequired: auth.enabled,
      persistent: Boolean(env.DATA_DIR),
      redirectBase: `${baseUrl(req, env)}/oauth/callback/`,
      providers: Object.entries(PROVIDERS).map(([name, p]) => {
        const rec = saved[`oauth:${name}`];
        return {
          name,
          label: p.label,
          detail: p.detail,
          feeds: p.feeds,
          configured: isConfigured(name, env),
          setupHint: p.setupHint,
          connected: Boolean(rec),
          account: rec?.account || null,
          connectedAt: rec?.connected_at || null,
          redirectUri: redirectUri(req, env, name)
        };
      })
    });
  });

  r.get('/connect/:provider', auth.require, (req, res) => {
    const name = req.params.provider;
    const p = PROVIDERS[name];
    if (!p) return res.status(404).send('Unknown provider');
    if (!guard(req, res)) return;
    if (!isConfigured(name, env)) {
      return res.status(400).send(`${p.label} is not set up on the server. ${p.setupHint}`);
    }

    const state = newState();
    setCookie(res, STATE_COOKIE, sign(`${name}:${state}`, env.APP_PASSWORD), {
      maxAge: 600, secure: isSecure(req)
    });
    res.redirect(p.authorizeUrl(env, { redirect: redirectUri(req, env, name), state }));
  });

  r.get('/oauth/callback/:provider', auth.require, async (req, res) => {
    const name = req.params.provider;
    const p = PROVIDERS[name];
    if (!p) return res.status(404).send('Unknown provider');
    if (!guard(req, res)) return;

    const fail = msg => res.redirect('/#connections?error=' + encodeURIComponent(msg));

    if (req.query.error) {
      return fail(`${p.label} refused: ${req.query.error_description || req.query.error}`);
    }

    const expected = unsign(parseCookies(req.headers.cookie)[STATE_COOKIE], env.APP_PASSWORD);
    clearCookie(res, STATE_COOKIE, { secure: isSecure(req) });
    if (!expected || expected !== `${name}:${req.query.state}`) {
      return fail('State mismatch — start the connection again from this page.');
    }
    if (!req.query.code) return fail('No authorisation code returned.');

    try {
      const record = await exchangeCode(name, env, {
        code: String(req.query.code),
        redirect: redirectUri(req, env, name)
      });
      await store.set(`oauth:${name}`, record);
      onConnected?.(name);
      res.redirect('/#connections?connected=' + encodeURIComponent(p.label));
    } catch (err) {
      fail(`${p.label} token exchange failed: ${err.message}`);
    }
  });

  r.post('/api/disconnect/:provider', auth.require, express.json(), async (req, res) => {
    const name = req.params.provider;
    if (!PROVIDERS[name]) return res.status(404).json({ error: 'Unknown provider' });
    if (!guard(req, res)) return;
    const removed = await store.remove(`oauth:${name}`);
    onConnected?.(name);
    res.json({ ok: true, removed });
  });

  app.use(r);
}
