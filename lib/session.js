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

export function makeAuth({ password, secret, ttlHours = 24 * 14, isSecure }){
  const issue = res => {
    const exp = Date.now() + ttlHours * 3600_000;
    setCookie(res, SESSION_COOKIE, sign(exp, secret), { maxAge: ttlHours * 3600, secure: isSecure() });
  };

  const valid = req => {
    const exp = unsign(parseCookies(req.headers.cookie)[SESSION_COOKIE], secret);
    return Boolean(exp) && Number(exp) > Date.now();
  };

  return {
    issue,
    valid,
    clear: res => clearCookie(res, SESSION_COOKIE, { secure: isSecure() }),
    check: given => passwordMatches(given, password),
    /* Pages redirect to the login screen; API routes get a 401 so a fetch sees
       a status rather than a redirect to HTML it cannot parse. */
    require: (req, res, next) => {
      if (valid(req)) return next();
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not signed in' });
      return res.redirect('/login');
    }
  };
}
