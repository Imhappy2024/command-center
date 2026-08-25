/* Connecting and disconnecting mailboxes. */

import express from 'express';
import { PROVIDERS, isConfigured, exchangeCode } from '../lib/oauth.js';
import { newState, newVerifier, challengeFor, setPending, readPending, STATE_COOKIE, clearCookie }
  from '../lib/session.js';
import { listAccounts, upsertOAuth, upsertImap, renameAccount, deleteAccount, nextColour }
  from '../lib/accounts.js';
import { guarded } from './guard.js';
import { verify as verifyImap } from '../providers/imap.js';
import { query } from '../db/index.js';

/* Why a connect attempt failed, kept in the database rather than only in the
   process log. A failed OAuth round trip shows the user a banner that is gone on
   the next click, and the server-side reason — which is the useful half — lived
   only in stdout. On a hosted deploy that means the one person who can read it
   is whoever still has the log stream open. Recorded per provider, overwritten
   each attempt, and cleared by a success, so it is always "what happened last
   time" and never a growing table. */
async function recordConnect(provider, error){
  try {
    await query(
      `INSERT INTO sync_state (key, cursor, last_run, last_error, updated_at)
       VALUES ($1, NULL, now(), $2, now())
       ON CONFLICT (key) DO UPDATE SET
         last_run   = now(),
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [`connect:${provider}`, error ? String(error).slice(0, 500) : null]);
  } catch (err) {
    /* Diagnostics must never be the reason a connection fails. */
    console.error('[connect] could not record attempt:', err.message);
  }
}

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

  /* One endpoint, one source of truth for what is configured. Each sheet filters
     this map by feed — the mailbox sheet on 'mail', the social sheet on 'social'
     — so the greying-out logic is written once.

     Derived providers are excluded. A Facebook Page row exists in PROVIDERS so
     feed filtering and refresh semantics resolve for it, but it is produced by
     discovering a Meta grant and there is nothing to connect it with directly. */
  r.get('/api/accounts', auth.require, guarded('api/accounts', async (req, res) => {
    res.json({
      canConnect: Boolean(env.ENCRYPTION_KEY),
      providers: Object.fromEntries(
        Object.entries(PROVIDERS)
          .filter(([, p]) => !p.derived)
          .map(([name, p]) => [name, {
            label: p.label,
            feeds: p.feeds,
            blurb: p.blurb || null,
            configured: isConfigured(name, env),
            setupHint: p.setupHint
          }])
      ),
      accounts: await listAccounts()
    });
  }));

  /* The last connect attempt per provider. Answers "I clicked connect and
     nothing appeared" without needing the deploy's log stream. */
  r.get('/api/connect/diag', auth.require, guarded('api/connect:diag', async (req, res) => {
    const { rows } = await query(
      `SELECT key, last_run, last_error FROM sync_state
        WHERE key LIKE 'connect:%' ORDER BY last_run DESC NULLS LAST`);
    res.json({
      accounts: (await listAccounts()).map(a => ({ id: a.id, provider: a.provider, status: a.status })),
      attempts: rows.map(r2 => ({
        provider: r2.key.replace(/^connect:/, ''),
        at: r2.last_run,
        ok: !r2.last_error,
        error: r2.last_error
      }))
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

    /* Errors return to the view the connection was started from, so a failed
       Meta grant reports itself on Social rather than on the Inbox. */
    const view = (p.feeds || []).includes('social') ? 'social' : 'inbox';
    const fail = msg => {
      /* Recorded before redirecting: the two pre-flight failures (state mismatch,
         no code) never reach the try block below, and they are exactly the ones
         that look like "nothing happened" from the browser. */
      recordConnect(name, msg).catch(() => {});
      return res.redirect(`/#${view}?error=` + encodeURIComponent(msg));
    };
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

      /* The grant itself is always a row. For Meta it is the row that holds the
         renewable user token and the one a disconnect should cascade from, even
         though it is not what the Social view reads. */
      await upsertOAuth({
        provider: name,
        uid: record.uid,
        email: record.email,
        label: pending.label,
        color: pending.color,
        refreshToken: record.refreshToken,
        accessToken: record.accessToken,
        expiresAt: record.expiresAt,
        scope: record.grantedScopes || record.scope
      });

      /* One grant, several accounts. Meta returns a row per Page, per linked
         Instagram account and per ad account; every other provider has no
         discover() and lands exactly one row, as before.

         A short list is not an error. Facebook's dialog lets the user pick which
         Pages to grant, so one Page out of four is a correct outcome. */
      let assets = [];
      if (p.discover) {
        assets = await p.discover(record.accessToken, env, record);
        for (const a of assets) {
          await upsertOAuth({
            provider: a.provider,
            uid: a.uid,
            email: a.display,
            /* The label the user typed names the grant. Discovered assets are
               named after themselves, because "Business" repeated across four
               Pages tells you nothing in a sidebar. */
            label: (a.display || a.provider).slice(0, 24),
            color: a.color || await nextColour(),
            refreshToken: a.token,
            accessToken: a.token,
            expiresAt: a.expiresAt ?? null,
            scope: record.grantedScopes || record.scope,
            meta: a.meta || {}
          });
        }
      }

      const what = assets.length
        ? `${assets.length} ${assets.length === 1 ? 'account' : 'accounts'}`
        : (record.email || p.label);
      await recordConnect(name, null);
      res.redirect(`/#${view}?connected=` + encodeURIComponent(what));
    } catch (err) {
      console.error(`[connect:${name}]`, err.message);
      /* err.message, not the prettied banner text: the provider's own words are
         what identify a disabled API or a channel-less Google account. */
      await recordConnect(name, err.message);
      res.redirect(`/#${view}?error=` + encodeURIComponent(`${p.label} connection failed: ${err.message}`));
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
