/* Connecting and disconnecting mailboxes. */

import express from 'express';
import { PROVIDERS, isConfigured, exchangeCode } from '../lib/oauth.js';
import { newState, newVerifier, challengeFor, setPending, readPending, STATE_COOKIE, clearCookie }
  from '../lib/session.js';
import { listAccounts, upsertOAuth, upsertImap, renameAccount, deleteAccount } from '../lib/accounts.js';
import { guarded } from './guard.js';
import { verify as verifyImap } from '../providers/imap.js';

/* Built from PUBLIC_URL when it is set, never from request headers: Railway's
   proxy terminates TLS and hands the app http in req.protocol, so a
   header-derived URI would not byte-match the one registered with the provider
   and every connection would fail with redirect_uri_mismatch. */
export function baseUrl(req, env){
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

const redirectUri = (req, env, name) => `${baseUrl(req, env)}/oauth/callback/${name}`;

const safeLabel = v => String(v || '').trim().slice(0, 24);
const safeColor = v => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : '#8E9BA8');
const safePort = (v, fallback) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
};

export function connectRoutes({ env, auth, secret }){
  const r = express.Router();
  const isSecure = req => baseUrl(req, env).startsWith('https:');

  /* Keyed on ENCRYPTION_KEY, not APP_PASSWORD. Encryption is what actually
     matters for storing a long-lived credential; whether the dashboard asks for
     a login is a separate concern, and conflating the two meant AUTH_MODE=open
     silently disabled connecting. */
  const gate = (req, res) => {
    if (!env.ENCRYPTION_KEY) {
      res.status(403).json({
        error: 'ENCRYPTION_KEY is not set, so there is nowhere safe to store a token. Connecting is disabled.'
      });
      return false;
    }
    return true;
  };

  r.get('/api/accounts', auth.require, guarded('api/accounts', async (req, res) => {
    res.json({
        canConnect: Boolean(env.ENCRYPTION_KEY),
        providers: Object.fromEntries(
          Object.keys(PROVIDERS).map(name => [name, {
            label: PROVIDERS[name].label,
            feeds: PROVIDERS[name].feeds,
            configured: isConfigured(name, env),
            setupHint: PROVIDERS[name].setupHint
          }])
        ),
      accounts: await listAccounts()
    });
  }));

  r.post('/api/accounts/:id', auth.require, express.json(), guarded('api/accounts:rename', async (req, res) => {
    const { label, color } = req.body || {};
    const updated = await renameAccount(req.params.id, {
      label: label === undefined ? null : safeLabel(label) || null,
      color: color === undefined ? null : safeColor(color)
    });
    if (!updated) return res.status(404).json({ error: 'no such account' });
    res.json({ account: updated });
  }));

  r.delete('/api/accounts/:id', auth.require, guarded('api/accounts:delete', async (req, res) => {
    const gone = await deleteAccount(req.params.id);
    if (!gone) return res.status(404).json({ error: 'no such account' });
    res.json({ ok: true });
  }));

  /* ---------------- OAuth round trip ---------------- */

  r.get('/connect/:provider', auth.require, (req, res) => {
    const name = req.params.provider;
    const p = PROVIDERS[name];
    if (!p || !p.oauth) return res.status(404).send('Unknown provider');
    if (!gate(req, res)) return;
    if (!isConfigured(name, env)) {
      return res.status(400).send(`${p.label} is not set up on the server. ${p.setupHint}`);
    }

    const state = newState();
    const verifier = newVerifier();
    /* The label and colour travel in the cookie rather than the state parameter
       so they never appear in a provider's logs or in the redirect URL. */
    setPending(res, secret, {
      p: name,
      s: state,
      v: verifier,
      label: safeLabel(req.query.label) || p.label,
      color: safeColor(req.query.color)
    }, { secure: isSecure(req) });

    res.redirect(p.authorizeUrl(env, {
      redirect: redirectUri(req, env, name),
      state,
      challenge: challengeFor(verifier)
    }));
  });

  r.get('/oauth/callback/:provider', auth.require, async (req, res) => {
    const name = req.params.provider;
    const p = PROVIDERS[name];
    if (!p || !p.oauth) return res.status(404).send('Unknown provider');

    const fail = msg => res.redirect('/#inbox?error=' + encodeURIComponent(msg));
    if (req.query.error) {
      return fail(`${p.label} refused: ${req.query.error_description || req.query.error}`);
    }

    const pending = readPending(req, secret);
    clearCookie(res, STATE_COOKIE, { secure: isSecure(req) });

    if (!pending || pending.p !== name || pending.s !== req.query.state) {
      return fail('State mismatch — start the connection again from the Inbox.');
    }
    if (!req.query.code) return fail('No authorisation code returned.');

    try {
      const record = await exchangeCode(name, env, {
        code: String(req.query.code),
        redirect: redirectUri(req, env, name),
        verifier: pending.v
      });
      await upsertOAuth({
        provider: name,
        uid: record.uid,
        email: record.email,
        label: pending.label,
        color: pending.color,
        refreshToken: record.refreshToken,
        accessToken: record.accessToken,
        expiresAt: record.expiresAt,
        scope: record.scope
      });
      res.redirect('/#inbox?connected=' + encodeURIComponent(record.email || p.label));
    } catch (err) {
      console.error(`[connect:${name}]`, err.message);
      fail(`${p.label} connection failed: ${err.message}`);
    }
  });

  /* ---------------- IMAP ----------------
     No redirect: the credential is entered in our own form, so this is a POST
     that verifies before it writes. The password is proved against the host
     first so a typo surfaces here rather than as a permanently empty mailbox. */

  r.post('/connect/imap', auth.require, express.json(), async (req, res) => {
    if (!gate(req, res)) return;

    const b = req.body || {};
    const email = String(b.email || '').trim();
    const password = String(b.password || '');
    const imapHost = String(b.imapHost || '').trim().toLowerCase();

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (!imapHost) return res.status(400).json({ error: 'Enter the IMAP host.' });
    if (!password) return res.status(400).json({ error: 'Enter the app password.' });

    const config = {
      email,
      password,
      imapHost,
      imapPort: safePort(b.imapPort, 993),
      smtpHost: String(b.smtpHost || '').trim().toLowerCase() || imapHost,
      smtpPort: safePort(b.smtpPort, 465)
    };

    try {
      await verifyImap(config);
    } catch (err) {
      /* The provider's own wording is the useful part here — wrong password,
         host not found, TLS refused. It never contains the credential. */
      return res.status(400).json({ error: `Could not sign in to ${imapHost}: ${err.message}` });
    }

    try {
      const id = await upsertImap({
        // Host is part of the key because the same address can exist on more
        // than one server, and IMAP offers no account identifier of its own.
        uid: `${email.toLowerCase()}@${imapHost}`,
        email,
        label: safeLabel(b.label) || email,
        color: safeColor(b.color),
        password,
        imapHost: config.imapHost,
        imapPort: config.imapPort,
        smtpHost: config.smtpHost,
        smtpPort: config.smtpPort
      });
      res.json({ ok: true, id, email });
    } catch (err) {
      console.error('[connect:imap]', err.message);
      res.status(500).json({ error: 'Could not save the mailbox.' });
    }
  });

  return r;
}
