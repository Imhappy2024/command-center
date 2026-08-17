/* Calendar. Reads from the same account rows as mail — one grant covers both
   feeds, so there is nothing separate to connect and nothing separate to store.

   IMAP accounts are excluded automatically: they advertise feeds ['mail'] only,
   so accountsFor('calendar') never returns one. */

import express from 'express';
import { accountsFor } from '../lib/accounts.js';
import * as provider from '../providers/index.js';

const isIso = v => typeof v === 'string' && !Number.isNaN(Date.parse(v));

const warn = (account, err) => ({
  account: account.id,
  label: account.label,
  email: account.email,
  error: err?.message || String(err)
});

export function calendarRoutes({ auth }){
  const r = express.Router();

  r.get('/api/calendar', auth.require, async (req, res) => {
    /* The frontend derives the window from the view it is drawing, so it always
       sends both. The default is only a floor for a bare request. */
    const from = isIso(req.query.from) ? new Date(req.query.from).toISOString() : new Date().toISOString();
    const to = isIso(req.query.to)
      ? new Date(req.query.to).toISOString()
      : new Date(Date.parse(from) + 7 * 86_400_000).toISOString();

    if (Date.parse(to) <= Date.parse(from)) {
      return res.status(400).json({ error: 'to must be after from' });
    }

    const all = await accountsFor('calendar');
    const which = req.query.account;
    const accounts = (!which || which === 'all') ? all : all.filter(a => a.id === which);
    if (!accounts.length) return res.json({ events: [], warnings: [] });

    const results = await Promise.allSettled(
      accounts.map(a => provider.listEvents(a, from, to))
    );

    const events = [];
    const warnings = [];
    results.forEach((out, i) => {
      if (out.status === 'fulfilled') events.push(...out.value);
      else warnings.push(warn(accounts[i], out.reason));
    });

    res.json({
      events: events.sort((a, b) => (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0)),
      warnings
    });
  });

  return r;
}
