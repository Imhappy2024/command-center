/* Sub-accounts declared as environment variables.

   Four locations are already configured in Railway, and pasting tokens through
   the Connect sheet after every fresh database is busywork. Pairs are matched on
   the suffix:

     GHL_TOKEN_<NAME>       Private Integration Token
     GHL_LOCATION_<NAME>    Location ID
     GHL_LABEL_<NAME>       optional sidebar label
     GHL_COLOR_<NAME>       optional hex

   GHL tokens never auto-refresh, so rotation is a Railway variable edit rather
   than a UI task — which across four sub-accounts is the point of this file.

   The Connect sheet still works. It is how a fifth sub-account is added without
   a redeploy. */

import { query } from '../db/index.js';
import { getAccount, upsertStaticToken } from './accounts.js';
import { decrypt } from './crypto.js';
import { verifyLocation, GhlError } from '../providers/ghl.js';
import { resume } from './ghl-limiter.js';

/* Same order as the frontend's PALETTE, so an env-seeded sub-account gets a
   colour the UI would have offered anyway. */
const PALETTE = ['#D9A441', '#4E9E7E', '#5B8DEF', '#C2553F',
                 '#B07FD4', '#4FB8A8', '#E0784A', '#8E9BA8'];

const VERIFY_TIMEOUT_MS = 10_000;

const titleCase = name => name
  .toLowerCase()
  .split(/[_\s]+/)
  .filter(Boolean)
  .map(w => w[0].toUpperCase() + w.slice(1))
  .join(' ');

const safeLabel = v => String(v || '').trim().slice(0, 24);
const safeColor = v => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : null);

/* Every GHL_TOKEN_* in the environment, paired with its location. */
export function declared(env = process.env){
  const out = [];
  for (const key of Object.keys(env)) {
    const m = /^GHL_TOKEN_(.+)$/.exec(key);
    if (!m) continue;
    const name = m[1];
    const token = String(env[key] || '').trim();
    if (!token) continue;
    out.push({
      name,
      token,
      locationId: String(env[`GHL_LOCATION_${name}`] || '').trim(),
      label: safeLabel(env[`GHL_LABEL_${name}`]),
      color: safeColor(env[`GHL_COLOR_${name}`])
    });
  }
  return out;
}

/* Whether the stored token already matches. A match means nothing to do and no
   verification call: four wasted requests on every deploy otherwise. */
function storedTokenMatches(row, token){
  if (!row) return false;
  try { return decrypt(row.refresh_token) === token; }
  catch { return false; }   // key rotated or row corrupt — treat as a mismatch
}

/* Colours are assigned from PALETTE in declaration order, skipping any already
   taken by a connected account, so two seeded sub-accounts never share one. */
function colourPicker(taken){
  const used = new Set(taken.map(c => String(c || '').toLowerCase()));
  return () => {
    const free = PALETTE.find(c => !used.has(c.toLowerCase()));
    const pick = free || PALETTE[used.size % PALETTE.length];
    used.add(pick.toLowerCase());
    return pick;
  };
}

/* Runs after migrate() and before listen(). Never throws and never exits: three
   working locations beat none, so a bad pair is logged by name and skipped. */
export async function seedFromEnv(env = process.env){
  const entries = declared(env);
  if (!entries.length) return { seeded: 0, skipped: 0 };

  /* Colour assignment needs to know what is already in use, and a database that
     is unreachable is not a reason to fail boot — migrate() has already proved
     it, so this is belt and braces. */
  let existingColours = [];
  try {
    const { rows } = await query(`SELECT color FROM accounts`);
    existingColours = rows.map(r => r.color);
  } catch (err) {
    console.error('[ghl:seed] could not read existing colours:', err.message);
  }
  const nextColour = colourPicker(existingColours);

  let seeded = 0;
  let skipped = 0;

  for (const e of entries) {
    if (!e.locationId) {
      console.error(`[ghl:seed] GHL_TOKEN_${e.name} is set but GHL_LOCATION_${e.name} is missing — skipped`);
      skipped++;
      continue;
    }

    const id = `ghl:${e.locationId}`;
    let row = null;
    try {
      row = await getAccount(id);
    } catch (err) {
      console.error(`[ghl:seed] ${e.name}: could not read the existing row: ${err.message}`);
      skipped++;
      continue;
    }

    if (storedTokenMatches(row, e.token)) continue;   // nothing changed

    /* Either new or rotated. Verifying proves the token is valid *and* scoped to
       that location, which no shape check can tell you. */
    let found;
    try {
      found = await verifyLocation(e.token, e.locationId,
        { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
    } catch (err) {
      const why = err instanceof GhlError ? err.message : `could not reach GHL: ${err.message}`;
      console.error(`[ghl:seed] ${e.name} (${e.locationId}) not connected — ${why}`);
      skipped++;
      continue;
    }

    try {
      await upsertStaticToken({
        provider: 'ghl',
        uid: e.locationId,
        display: found.name,
        label: e.label || safeLabel(found.name) || titleCase(e.name),
        color: e.color || row?.color || nextColour(),
        token: e.token,
        meta: { locationName: found.name, seededFrom: `GHL_TOKEN_${e.name}` },
        /* 'env' so a label the owner typed in the UI is never overwritten from
           here. upsertStaticToken keeps 'user' once it has been set. */
        labelSource: 'env'
      });
      /* A rotated token clears the stop the limiter put on this location after
         the old one started returning 401. */
      resume(e.locationId);
      seeded++;
      console.log(`[ghl:seed] ${row ? 'token rotated for' : 'connected'} ${found.name} (${e.locationId})`);
    } catch (err) {
      console.error(`[ghl:seed] ${e.name}: could not store the token: ${err.message}`);
      skipped++;
    }
  }

  return { seeded, skipped, declared: entries.length };
}
