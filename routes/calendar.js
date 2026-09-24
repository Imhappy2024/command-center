/* Calendar. Reads from the same account rows as mail — one grant covers both
   feeds, so there is nothing separate to connect and nothing separate to store.

   IMAP accounts are excluded automatically: they advertise feeds ['mail'] only,
   so accountsFor('calendar') never returns one. */

import express from 'express';
import { accountsFor } from '../lib/accounts.js';
import { guarded } from './guard.js';
import * as provider from '../providers/index.js';
import { SAFE_TZ } from '../lib/timezone.js';

const isIso = v => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/* Where a meeting is, as a closed set.

   Free text is what produced a calendar whose "location" is sometimes a street
   address, sometimes a room, usually nothing, and never something the Join
   button can use. Two options, both of which end in a link somebody can click.
   Anything else is refused here rather than silently stored. */
const PLACES = new Set(['teams', 'zoom']);

/* A wall-clock string Graph will accept: YYYY-MM-DDTHH:mm:ss, no zone on it.
   The zone travels separately, which is what keeps 2pm at 2pm across a
   daylight-saving change rather than freezing today's offset into the event. */
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const localTime = v => {
  const s = String(v || '').trim();
  if (!LOCAL.test(s)) return null;
  return s.length === 16 ? s + ':00' : s;
};

/* What the browser sent, checked and shaped. Returns a string on refusal. */
function readEvent(body, env){
  const title = String(body?.title || '').trim();
  if (!title) return 'A title is required.';
  if (title.length > 250) return 'That title is longer than 250 characters.';

  const start = localTime(body?.start);
  const end = localTime(body?.end);
  if (!start) return 'Start must look like 2026-09-25T14:00.';
  if (!end) return 'End must look like 2026-09-25T15:00.';
  if (Date.parse(end + 'Z') <= Date.parse(start + 'Z')) return 'The end has to be after the start.';

  const place = body?.place == null || body.place === '' ? null : String(body.place);
  if (place !== null && !PLACES.has(place)) {
    return `Location must be ${[...PLACES].join(' or ')}.`;
  }
  const zoomUrl = String(env.ZOOM_MEETING_URL || '').trim();
  if (place === 'zoom' && !zoomUrl) {
    return 'ZOOM_MEETING_URL is not set on this server, so there is no Zoom room to put '
      + 'in the invite. Set it, or choose Teams.';
  }

  const attendees = (Array.isArray(body?.attendees) ? body.attendees : [])
    .map(a => String(a).trim()).filter(a => a.includes('@')).slice(0, 50);

  return {
    title,
    startLocal: start,
    endLocal: end,
    tz: SAFE_TZ,
    notes: String(body?.notes || '').slice(0, 4000),
    place,
    zoomUrl,
    attendees,
    allDay: Boolean(body?.allDay)
  };
}

const warn = (account, err) => ({
  account: account.id,
  label: account.label,
  email: account.email,
  error: err?.message || String(err)
});

export function calendarRoutes({ auth, env = process.env }){
  const r = express.Router();
  const json = express.json({ limit: '64kb' });

  /* Which calendar a write goes to.

     Not "the one the browser named": a client that can name any account id can
     write to any connected calendar, including a person's own mailbox. Writes
     go to the calendars this app is configured to write to, and today that is
     exactly the ones whose provider implements the operations. */
  const writable = async () =>
    (await accountsFor('calendar')).filter(a => provider.canWriteEvents(a) && a.status === 'ok');

  const pickTarget = async wanted => {
    const list = await writable();
    if (!list.length) return null;
    if (!wanted || wanted === 'all') return list[0];
    return list.find(a => a.id === wanted) || null;
  };

  /* What the composer needs to draw itself: whether anything can be written to
     at all, and whether Zoom is an option on this deployment. */
  r.get('/api/calendar/capabilities', auth.require,
    guarded('api/calendar/capabilities', async (req, res) => {
      const list = await writable();
      res.json({
        canWrite: list.length > 0,
        timeZone: SAFE_TZ,
        targets: list.map(a => ({ id: a.id, label: a.label, email: a.email })),
        places: [
          { id: 'teams', label: 'Microsoft Teams', available: true },
          { id: 'zoom', label: 'Zoom',
            available: Boolean(String(env.ZOOM_MEETING_URL || '').trim()),
            why: String(env.ZOOM_MEETING_URL || '').trim()
              ? null : 'ZOOM_MEETING_URL is not set on this server.' }
        ]
      });
    }));

  r.post('/api/calendar/events', auth.require, json,
    guarded('api/calendar/events:create', async (req, res) => {
      const target = await pickTarget(req.body?.account);
      if (!target) {
        return res.status(400).json({ error: 'No calendar here can be written to. That needs '
          + 'MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID and MS_SERVICE_USER, with '
          + 'Calendars.ReadWrite granted to the app as an Application permission.' });
      }
      const shaped = readEvent(req.body, env);
      if (typeof shaped === 'string') return res.status(400).json({ error: shaped });

      const made = await provider.createEvent(target, shaped);
      console.log('[calendar] created %s on %s', made.id, target.id);
      res.json({ ok: true, id: made.id, join: made.join, account: target.id });
    }));

  r.patch('/api/calendar/events/:id', auth.require, json,
    guarded('api/calendar/events:update', async (req, res) => {
      const target = await pickTarget(req.body?.account);
      if (!target) return res.status(400).json({ error: 'No calendar here can be written to.' });
      const shaped = readEvent(req.body, env);
      if (typeof shaped === 'string') return res.status(400).json({ error: shaped });

      const saved = await provider.updateEvent(target, req.params.id, shaped);
      console.log('[calendar] updated %s on %s', req.params.id, target.id);
      res.json({ ok: true, id: saved.id, join: saved.join, account: target.id });
    }));

  r.delete('/api/calendar/events/:id', auth.require,
    guarded('api/calendar/events:delete', async (req, res) => {
      const target = await pickTarget(req.query.account);
      if (!target) return res.status(400).json({ error: 'No calendar here can be written to.' });
      await provider.deleteEvent(target, req.params.id);
      console.log('[calendar] cancelled %s on %s', req.params.id, target.id);
      res.json({ ok: true, id: req.params.id });
    }));

  r.get('/api/calendar', auth.require, guarded('api/calendar', async (req, res) => {
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
  }));

  return r;
}
