/* Finding a file in Google Drive.

   One endpoint, one verb, read only. It exists so Hommie can turn a name someone
   said out loud into a real URL that OpusClip can fetch, and for nothing else --
   there is no browse, no download and no write, because none of those is needed
   to answer "the day one video in Raw videos".

   It uses the same Google grant as mail and calendar. That grant now asks for
   drive.readonly, so a connection made before this existed keeps working for
   mail and has to be reconnected before a search returns anything. The provider
   reports that as itself rather than as an empty result, because "nothing
   matched" and "you have not granted this" send people to very different
   places. */

import express from 'express';
import { accountsFor, getAccessToken } from '../lib/accounts.js';
import * as google from '../providers/google.js';

export function driveRoutes({ auth }){
  const r = express.Router();

  const account = async () => {
    const rows = (await accountsFor('mail')).filter(a => a.provider === 'google');
    if (!rows.length) {
      throw Object.assign(new Error('No Google account is connected.'), { status: 409 });
    }
    const live = rows.find(a => a.status === 'ok') || rows[0];
    if (live.status !== 'ok') {
      throw Object.assign(
        new Error('The Google connection needs reconnecting before Drive can be searched.'),
        { status: 409 });
    }
    return live;
  };

  r.get('/api/drive/find', auth.require, async (req, res) => {
    const name = String(req.query.name || '').trim();
    if (name.length < 2) {
      return res.status(400).json({ error: 'give at least two characters of the file name' });
    }
    try {
      const acct = await account();
      const token = await getAccessToken(acct.id);
      const out = await google.findFiles(token, {
        name,
        folder: req.query.folder ? String(req.query.folder).trim() : null,
        /* Videos unless asked otherwise. Every caller so far is looking for
           something to clip, and an unfiltered search for "day 1" in a Drive
           full of documents is not a useful answer. */
        video: req.query.video !== '0',
        limit: 12
      });
      res.json({ ok: true, account: acct.label || acct.email, searched: name, ...out });
    } catch (err) {
      res.status(err.reauth ? 409 : err.status || 502).json({ error: err.message });
    }
  });

  return r;
}
