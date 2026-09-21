/* Signing in, signing out, and choosing a password.

   Two ways in, and only ever one of them at a time:

     - a user row, matched on an address. This is the way.
     - APP_PASSWORD, the single shared password this replaced. Honoured ONLY
       while the users table is empty, so an existing deployment does not lock
       its owner out on the deploy that adds accounts, and a deployment that
       has accounts cannot be entered with a password that belongs to nobody.

   Failures are deliberately vague. "No such account" and "wrong password" are
   the same sentence here, because telling them apart turns the login form into
   a way of asking which addresses exist. */

import express from 'express';
import path from 'node:path';
import {
  authenticate, recordLogin, setPassword, countUsers, findById,
  passwordProblem, publicUser, MIN_PASSWORD
} from '../lib/users.js';
import { ipLimiter } from '../lib/ghl-webhook.js';

export function authRoutes({ auth, publicDir }){
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: '16kb' });

  /* Guessing has to be expensive, because this form is on the open internet and
     the passwords behind it are chosen by people.

     scrypt already makes each attempt slow for whoever HOLDS the table. This is
     the other half: making attempts scarce for whoever does not. Two counters,
     because either one alone has a hole — per address, and one machine can work
     through a list of accounts; per source, and a botnet spreads the same guess
     across a thousand addresses.

     Ten in fifteen minutes is generous for a person who has forgotten which of
     two passwords it was, and useless to anyone working through a word list.
     In memory, so a restart forgives everyone; this is a single instance, and a
     shared store would be a database round trip on the one route that must stay
     cheap under exactly the load an attacker creates. */
  const perSource = ipLimiter({ max: 10, windowMs: 15 * 60_000 });
  const perAccount = ipLimiter({ max: 10, windowMs: 15 * 60_000 });

  r.get('/login', async (req, res) => {
    if (auth.valid(req)) {
      const u = await auth.currentUser(req).catch(() => null);
      return res.redirect(u?.must_change_password ? auth.changePath : '/');
    }
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  r.post('/login', form, async (req, res) => {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');

    /* Counted before the password is looked at, so a locked-out source cannot
       keep spending scrypt calls, and answered with the same vague message as a
       wrong password — a distinct "too many attempts" would tell an attacker
       their aim is good enough to be worth slowing down. */
    if (!perSource(req.ip) || !perAccount(email.toLowerCase())) {
      console.warn('[auth] too many sign-in attempts for %s from %s', email || '(no address)', req.ip);
      return res.redirect('/login?error=1');
    }

    try {
      const user = await authenticate(email, password);
      if (user) {
        await recordLogin(user.id);
        auth.issue(res, user);
        return res.redirect(user.must_change_password ? auth.changePath : '/');
      }

      /* The shared password, and only with nobody in the table. */
      if ((await countUsers()) === 0 && auth.check(password)) {
        auth.issue(res, null);
        return res.redirect('/');
      }
    } catch (err) {
      console.error('[auth] sign-in failed:', err.message);
      return res.redirect('/login?down=1');
    }

    /* Same answer for a wrong address and a wrong password. */
    return res.redirect('/login?error=1');
  });

  /* The page an account has to pass through before anything else works, and
     also where anyone can change their own password on purpose. */
  r.get(auth.changePath, async (req, res) => {
    if (!auth.valid(req)) return res.redirect('/login');
    res.sendFile(path.join(publicDir, 'password.html'));
  });

  r.post(auth.changePath, form, async (req, res) => {
    if (!auth.valid(req)) return res.redirect('/login');

    const back = q => res.redirect(auth.changePath + '?' + q);
    let user;
    try { user = await auth.currentUser(req); }
    catch { return back('down=1'); }

    /* An APP_PASSWORD session has no account behind it, so there is nothing
       here to change. Said plainly rather than failing silently. */
    if (!user) return back('nouser=1');

    const current = String(req.body?.current || '');
    const next = String(req.body?.password || '');
    const again = String(req.body?.confirm || '');

    /* The current password, even mid-forced-change. Without it, a browser left
       open on this page is a password reset for whoever walks past it. */
    if (!(await authenticate(user.email, current))) return back('current=1');
    if (next !== again) return back('match=1');

    const problem = passwordProblem(next, { current });
    if (problem) return back('bad=' + encodeURIComponent(problem));

    await setPassword(user.id, next, { mustChange: false });
    /* Re-issued so the session reflects an account that is no longer pending,
       and so a password change refreshes the clock on the cookie. */
    auth.issue(res, await findById(user.id));
    return res.redirect('/?passwordset=1');
  });

  /* Who is signed in. The dashboard draws its account menu from this, and it
     is deliberately reachable during a forced change so that screen can greet
     the person by name. */
  r.get('/api/me', async (req, res) => {
    if (auth.isOpen) return res.json({ authMode: 'open', user: null, minPassword: MIN_PASSWORD });
    if (!auth.valid(req)) return res.status(401).json({ error: 'not signed in' });
    try {
      const u = await auth.currentUser(req);
      res.json({ authMode: auth.mode, user: publicUser(u), minPassword: MIN_PASSWORD });
    } catch (err) {
      res.status(503).json({ error: err.message });
    }
  });

  r.post('/logout', (req, res) => {
    auth.clear(res);
    res.redirect('/login?out=1');
  });

  return r;
}
