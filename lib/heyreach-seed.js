/* LinkedIn sender accounts, from one HeyReach key.

   There is no connect sheet for LinkedIn and there is no sign-in. HEYREACH_API_KEY
   is the whole credential, and the accounts it implies are discovered rather
   than entered: HeyReach knows which LinkedIn profiles the workspace sends as,
   so asking it beats asking a person to paste four profile URLs correctly.

   Runs at boot, after listen(), for the same reason GHL's seeding does -- it is
   a network round trip to somebody else's API, and nothing that calls a third
   party belongs in front of Railway's health check.

   Re-running is cheap and safe. A sender already stored keeps its label and
   colour; a sender removed in HeyReach is left alone rather than deleted, so
   its conversations stay readable and the row can be excluded by hand if the
   owner wants it gone. */

import { query } from '../db/index.js';
import { upsertStaticToken } from './accounts.js';
import * as heyreach from '../providers/heyreach.js';

/* Same order as the frontend's PALETTE, so a seeded sender gets a colour the
   UI would have offered anyway. */
const PALETTE = ['#D9A441', '#4E9E7E', '#5B8DEF', '#C2553F',
                 '#B07FD4', '#4FB8A8', '#E0784A', '#8E9BA8'];

export const accountIdFor = senderId => `linkedin:${senderId}`;

export function apiKey(env = process.env){
  return String(env.HEYREACH_API_KEY || '').trim();
}

/* One pass. Returns what happened so boot can say it in one line. */
export async function seedHeyReach(env = process.env){
  const key = apiKey(env);
  if (!key) return { configured: false, seeded: 0, senders: 0 };

  /* Checked before anything is written. A bad key otherwise shows up as four
     identical failures inside the first sync, several minutes later. */
  await heyreach.checkKey(key);

  const senders = await heyreach.senders(key);
  if (!senders.length) {
    return { configured: true, seeded: 0, senders: 0,
      note: 'HeyReach returned no LinkedIn sender accounts for this key.' };
  }

  const { rows } = await query(`SELECT color FROM accounts`);
  const used = new Set(rows.map(r => String(r.color || '').toLowerCase()));
  const nextColour = () => {
    const c = PALETTE.find(x => !used.has(x.toLowerCase())) || PALETTE[used.size % PALETTE.length];
    used.add(c.toLowerCase());
    return c;
  };

  let seeded = 0;
  for (const s of senders) {
    await upsertStaticToken({
      provider: 'linkedin',
      uid: s.id,
      display: s.label,
      label: s.label.slice(0, 24),
      color: nextColour(),
      /* The workspace key, stored per row. Every row carries the same secret,
         which is how getAccessToken() answers for an account without this
         module being in the read path. */
      token: key,
      meta: {
        senderId: s.id,
        profileUrl: s.profileUrl,
        avatar: s.avatar,
        heyreachStatus: s.status,
        seededFrom: 'HEYREACH_API_KEY'
      },
      /* 'env' so a name the owner types in the UI is never overwritten from
         here on the next deploy. */
      labelSource: 'env'
    });
    seeded++;
  }

  return { configured: true, seeded, senders: senders.length };
}

/* The connected sender rows, for the syncer and the webhook receiver. */
export async function senderAccounts(){
  const { rows } = await query(
    `SELECT id, label, meta, status FROM accounts WHERE provider = 'linkedin'
       AND COALESCE(meta->>'excluded', 'false') <> 'true'
     ORDER BY connected_at ASC`);
  return rows.map(r => ({
    id: r.id,
    label: r.label,
    status: r.status,
    senderId: r.meta?.senderId || String(r.id).replace(/^linkedin:/, ''),
    profileUrl: r.meta?.profileUrl || null
  }));
}
