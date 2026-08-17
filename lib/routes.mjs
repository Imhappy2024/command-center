/* Login, and the OAuth connect/disconnect round trip. */

import express from 'express';
import path from 'node:path';
import {
  PROVIDERS, isConfigured, exchangeCode, listConnections, accountKey, normaliseId
} from './providers.mjs';
import { getMessage, sendMessage, saveDraft, actOnMessage } from './mail.mjs';
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

export function mountRoutes(app, { env, auth, store, secret, publicDir, onConnected }){
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
    if (!store.enabled) {
      res.status(500).json({ error: 'No encryption key available for the token store.' });
      return false;
    }
    return true;
  };

  /* Which variables the process actually received. Names and presence only —
     never values. Unauthenticated only while there is no password to check
     against, which is exactly the state this exists to diagnose. */
  r.get('/api/env-check', (req, res) => {
    if (auth.enabled && !auth.valid(req)) return res.status(401).json({ error: 'not signed in' });

    const expected = [
      'APP_PASSWORD', 'PUBLIC_URL', 'DATA_DIR', 'ENCRYPTION_KEY',
      'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
      'MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_SERVICE_USER',
      'CLICKUP_TOKEN', 'N8N_BASE_URL', 'N8N_API_KEY', 'AGENT_TIMEZONE',
      'GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_IMPERSONATE_USER'
    ];

    res.json({
      vars: Object.fromEntries(expected.map(name => [name, {
        // Defined-but-empty is a different mistake from never-defined.
        present: Object.prototype.hasOwnProperty.call(env, name),
        set: Boolean(env[name])
      }])),
      // Deliberately fuzzy: a misspelling like APP_PASWORD is invisible to an
      // exact-name check, and that is precisely the case worth surfacing.
      lookalikes: Object.keys(env)
        .filter(k => !expected.includes(k)
          && /APP|PAS|PWD|PUBLIC|DATA|ENCRYPT|GOOGLE|CLICK|^MS_|N8N|TIME_?ZONE|TOKEN|SECRET|CLIENT/i.test(k)
          && !/^(GIT_ASKPASS|PATH|PATHEXT|PROMPT|APPDATA|LOCALAPPDATA)$/i.test(k))
        .sort(),
      computed: {
        loginEnabled: auth.enabled,
        storeEnabled: store.enabled,
        dataDir: env.DATA_DIR || '(default ./data — not persistent on Railway)'
      }
    });
  });

  r.get('/api/connections', auth.require, async (req, res) => {
    const conns = await listConnections(store);
    res.json({
      canConnect: store.enabled,
      loginRequired: auth.enabled,
      // Open dashboard + connected mailbox = the URL is the mail. Worth saying.
      publicUrlWarning: !auth.enabled,
      persistent: Boolean(env.DATA_DIR),
      totalAccounts: conns.length,
      providers: Object.entries(PROVIDERS).map(([name, p]) => {
        const accounts = conns.filter(c => c.provider === name);
        return {
          name,
          label: p.label,
          detail: p.detail,
          feeds: p.feeds,
          configured: isConfigured(name, env),
          setupHint: p.setupHint,
          accounts: accounts.map(a => ({
            accountId: a.accountId,
            account: a.account,
            connectedAt: a.connectedAt
          })),
          connected: accounts.length > 0,
          redirectUri: redirectUri(req, env, name)
        };
      })
    });
  });

  /* Where to land after the round trip, so Connect from the Inbox comes back
     to the Inbox. Restricted to a bare view name — never an arbitrary URL. */
  const safeReturn = v => (/^[a-z]{1,20}$/.test(String(v || '')) ? String(v) : 'connections');

  r.get('/connect/:provider', auth.require, (req, res) => {
    const name = req.params.provider;
    const p = PROVIDERS[name];
    if (!p) return res.status(404).send('Unknown provider');
    if (!guard(req, res)) return;
    if (!isConfigured(name, env)) {
      return res.status(400).send(`${p.label} is not set up on the server. ${p.setupHint}`);
    }

    const state = newState();
    const back = safeReturn(req.query.return);
    setCookie(res, STATE_COOKIE, sign(`${name}:${state}:${back}`, secret), {
      maxAge: 600, secure: isSecure(req)
    });
    res.redirect(p.authorizeUrl(env, { redirect: redirectUri(req, env, name), state }));
  });

  r.get('/oauth/callback/:provider', auth.require, async (req, res) => {
    const name = req.params.provider;
    const p = PROVIDERS[name];
    if (!p) return res.status(404).send('Unknown provider');
    if (!guard(req, res)) return;

    const cookie = unsign(parseCookies(req.headers.cookie)[STATE_COOKIE], secret);
    const [cookieName, cookieState, cookieBack] = String(cookie || '').split(':');
    const back = safeReturn(cookieBack);
    const fail = msg => res.redirect(`/#${back}?error=` + encodeURIComponent(msg));

    if (req.query.error) {
      return fail(`${p.label} refused: ${req.query.error_description || req.query.error}`);
    }

    clearCookie(res, STATE_COOKIE, { secure: isSecure(req) });
    if (!cookie || cookieName !== name || cookieState !== req.query.state) {
      return fail('State mismatch — start the connection again from this page.');
    }
    if (!req.query.code) return fail('No authorisation code returned.');

    try {
      const record = await exchangeCode(name, env, {
        code: String(req.query.code),
        redirect: redirectUri(req, env, name)
      });
      // Keyed by address, so connecting a second mailbox adds rather than replaces.
      const id = normaliseId(record.account) || `account-${(await listConnections(store)).length + 1}`;
      await store.set(accountKey(name, id), record);
      onConnected?.(name);
      res.redirect(`/#${back}?connected=` + encodeURIComponent(record.account || p.label));
    } catch (err) {
      fail(`${p.label} token exchange failed: ${err.message}`);
    }
  });

  /* ---------------- mail actions ---------------- */

  const mailRoute = handler => [auth.require, express.json({ limit: '1mb' }), async (req, res) => {
    if (!guard(req, res)) return;
    try {
      res.json(await handler(req));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }];

  r.get('/api/message/:provider/:accountId/:id', auth.require, async (req, res) => {
    if (!guard(req, res)) return;
    try {
      res.json(await getMessage({
        provider: req.params.provider,
        accountId: decodeURIComponent(req.params.accountId),
        id: req.params.id
      }, env, store));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  r.post('/api/mail/send', ...mailRoute(async req => {
    const out = await sendMessage(req.body || {}, env, store);
    onConnected?.('send');   // refresh so the sent item leaves the unread list
    return out;
  }));

  r.post('/api/mail/draft', ...mailRoute(req => saveDraft(req.body || {}, env, store)));

  r.post('/api/mail/action', ...mailRoute(async req => {
    const out = await actOnMessage(req.body || {}, env, store);
    onConnected?.('mail-action');
    return out;
  }));

  r.post('/api/disconnect', auth.require, express.json(), async (req, res) => {
    const { provider, accountId } = req.body || {};
    if (!PROVIDERS[provider]) return res.status(404).json({ error: 'Unknown provider' });
    if (!guard(req, res)) return;

    const match = (await listConnections(store))
      .find(c => c.provider === provider && c.accountId === String(accountId || ''));
    if (!match) return res.status(404).json({ error: 'Not connected' });

    await store.remove(match.key);
    onConnected?.(provider);
    res.json({ ok: true, removed: match.account });
  });

  app.use(r);
}
