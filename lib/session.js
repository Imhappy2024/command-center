/* Signed-cookie sessions, the password gate, and the short-lived cookie that
   carries OAuth state across the provider round trip. No dependencies: an HMAC
   over an expiry is all a single-user dashboard needs. */

import { createHmac, timingSafeEqual, randomBytes, scryptSync, createHash } from 'node:crypto';

export const SESSION_COOKIE = 'cc_session';
export const STATE_COOKIE = 'cc_oauth_state';

const hmac = (value, secret) => createHmac('sha256', secret).update(value).digest('base64url');

export function sign(value, secret){
  return `${Buffer.from(String(value)).toString('base64url')}.${hmac(String(value), secret)}`;
}

export function unsign(signed, secret){
  if (typeof signed !== 'string') return null;
  const dot = signed.lastIndexOf('.');
  if (dot < 1) return null;
  let value;
  try { value = Buffer.from(signed.slice(0, dot), 'base64url').toString('utf8'); }
  catch { return null; }
  const got = Buffer.from(signed.slice(dot + 1));
  const want = Buffer.from(hmac(value, secret));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return value;
}

export function parseCookies(header){
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, { maxAge, secure }){
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (secure) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

export const clearCookie = (res, name, { secure }) =>
  setCookie(res, name, '', { maxAge: 0, secure });

/* Compared over hashes so the length of the configured password never leaks
   through the timing of a mismatch. */
export function passwordMatches(given, expected){
  if (!expected) return false;
  const a = scryptSync(String(given), 'command-center.login', 32);
  const b = scryptSync(String(expected), 'command-center.login', 32);
  return timingSafeEqual(a, b);
}

/* ---------------- PKCE ----------------
   The client secret already authenticates the token exchange, so PKCE is belt
   and braces here. It costs nothing and it closes the window where an
   authorization code intercepted from the redirect could be redeemed by
   someone else. */

export const newVerifier = () => randomBytes(32).toString('base64url');
export const challengeFor = verifier =>
  createHash('sha256').update(verifier).digest('base64url');
export const newState = () => randomBytes(24).toString('base64url');

/* The label and colour ride through the round trip in this cookie so the
   account lands already named, without a second round of prompting. */
export function setPending(res, secret, data, { secure }){
  setCookie(res, STATE_COOKIE, sign(JSON.stringify(data), secret), { maxAge: 600, secure });
}

export function readPending(req, secret){
  const raw = unsign(parseCookies(req.headers.cookie)[STATE_COOKIE], secret);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/* ---------------- the gate ----------------

   Three modes, because "always require a password" locked the owner out of his
   own dashboard and "never require one" publishes his mail.

     open      no gate at all — no /login, no redirect, no cookie check
     remember  one sign-in per browser: a year-long cookie whose expiry slides
               forward on every request, so a browser in regular use never lapses
     password  a 14-day cookie that does not slide

   Only remember and password need APP_PASSWORD. */

export const AUTH_MODES = ['open', 'remember', 'password'];

export const normaliseMode = value => {
  const mode = String(value || 'remember').trim().toLowerCase();
  return AUTH_MODES.includes(mode) ? mode : null;
};

/* The cookie carries WHO, not just until-when.

   It used to hold an expiry and nothing else, because there was one password
   and therefore one person. With a row per person the session has to name one,
   or the app cannot say whose it is, cannot show a name, and cannot make one
   person change their password without making everybody do it.

   Written as JSON inside the same signed envelope. A cookie from before this
   change is a bare number: that is still honoured as a session with no user
   attached, so a deploy does not sign everybody out, and it is exactly what an
   APP_PASSWORD sign-in still produces. */
function packSession(userId, exp){
  return JSON.stringify({ u: userId == null ? null : String(userId), e: exp });
}

function unpackSession(raw){
  if (raw == null) return null;
  /* The old shape. */
  if (/^\d+$/.test(raw)) return { userId: null, exp: Number(raw) };
  try {
    const o = JSON.parse(raw);
    const exp = Number(o?.e);
    if (!exp) return null;
    return { userId: o?.u == null ? null : String(o.u), exp };
  } catch { return null; }
}

/* `loadUser` is injected rather than imported so this file keeps its promise of
   having no dependencies -- it is HMAC and cookies, and it must not be the
   thing that drags a database pool into a unit test. */
export function makeAuth({ mode = 'remember', password, secret, isSecure, loadUser = null }){
  const isOpen = mode === 'open';
  const sliding = mode === 'remember';
  const ttlHours = sliding ? 24 * 365 : 24 * 14;

  const issue = (res, user = null) => {
    const exp = Date.now() + ttlHours * 3600_000;
    setCookie(res, SESSION_COOKIE, sign(packSession(user?.id ?? null, exp), secret),
      { maxAge: ttlHours * 3600, secure: isSecure() });
  };

  const session = req => {
    const s = unpackSession(unsign(parseCookies(req.headers.cookie)[SESSION_COOKIE], secret));
    return s && s.exp > Date.now() ? s : null;
  };

  const valid = req => (isOpen ? true : Boolean(session(req)));

  /* Who is signed in, or null. A session naming a user who has since been
     deleted or disabled is not a session. */
  const currentUser = async req => {
    const s = session(req);
    if (!s?.userId || !loadUser) return null;
    const u = await loadUser(s.userId);
    return u && !u.disabled ? u : null;
  };

  /* Where an unfinished sign-in has to go before anything else works.

     A password somebody else typed is not that person's password yet, so an
     account marked must_change_password can reach exactly two places: the page
     that sets one, and signing out. Enforced here rather than in the browser,
     because a gate that only exists in the browser is not a gate. */
  const CHANGE_PATH = '/password';
  const allowedWhileChanging = p =>
    p === CHANGE_PATH || p === '/logout' || p === '/api/me' || p === '/api/health';

  return {
    mode,
    isOpen,
    issue,
    valid,
    session,
    currentUser,
    changePath: CHANGE_PATH,
    clear: res => clearCookie(res, SESSION_COOKIE, { secure: isSecure() }),
    /* The legacy shared password. Only consulted when no user rows exist --
       see lib/app.js -- so a deployment that predates accounts keeps working
       and one that has them cannot be entered by a password nobody owns. */
    check: given => passwordMatches(given, password),

    /* Async, and every await inside is guarded, because Express 4 does not await
       a middleware: a promise that rejected here would become an unhandled
       rejection and the request would hang rather than fail. The outer catch is
       the backstop for anything the inner guards miss. */
    require: async (req, res, next) => {
      try {
        return await gate(req, res, next);
      } catch (err) {
        console.error('[auth] the gate threw:', err.message);
        if (res.headersSent) return;
        if (req.path.startsWith('/api/')) {
          return res.status(503).json({ error: 'cannot verify the session right now' });
        }
        return res.status(503).type('text/plain').send('Cannot verify the session right now.');
      }
    }
  };

  async function gate(req, res, next){
    {
      // A pass-through, not a check that always passes: nothing reads a cookie,
      // so there is no way for a stale one to cause a redirect loop.
      if (isOpen) return next();

      const s = session(req);
      if (!s) {
        /* Pages redirect to the login screen; API routes get a 401 so a fetch
           sees a status rather than a redirect to HTML it cannot parse. */
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not signed in' });
        return res.redirect('/login');
      }

      let user = null;
      if (s.userId && loadUser) {
        try { user = await loadUser(s.userId); }
        catch (err) {
          /* A database that cannot answer must not become an open door. */
          console.error('[auth] could not load the signed-in user:', err.message);
          if (req.path.startsWith('/api/')) {
            return res.status(503).json({ error: 'cannot verify the session right now' });
          }
          return res.status(503).type('text/plain').send('Cannot verify the session right now.');
        }
        if (!user || user.disabled) {
          clearCookie(res, SESSION_COOKIE, { secure: isSecure() });
          if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'that account is no longer active' });
          }
          return res.redirect('/login?gone=1');
        }
      }
      req.user = user;

      if (user?.must_change_password && !allowedWhileChanging(req.path)) {
        if (req.path.startsWith('/api/')) {
          return res.status(403).json({ error: 'set a new password first', mustChangePassword: true });
        }
        return res.redirect(CHANGE_PATH);
      }

      /* Re-stamp the cookie so the year is measured from the last visit rather
         than the first. A browser used even once a year never sees the sign-in
         again; one abandoned for a year expires on its own. */
      if (sliding) issue(res, user);
      return next();
    }
  }
}
