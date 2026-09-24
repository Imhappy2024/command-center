/* One Outlook calendar, connected by configuration rather than by a person.

   Chris's calendar could have been connected the ordinary way — he signs in,
   grants the app his mailbox, and a refresh token lands in the accounts table.
   That needs him at a browser, it breaks when he changes his password, and it
   is a strange thing to ask of somebody whose calendar this dashboard exists to
   show. The tenant can grant it once instead.

   So this row is minted from MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT_ID /
   MS_SERVICE_USER, exactly the way the GHL and HeyReach rows are minted from
   their own variables. It behaves like any other calendar afterwards: its own
   colour, its own toggle among the sources, and the same read path.

   Verified before it is written. An app that has not been granted
   Calendars.ReadWrite as an APPLICATION permission gets a token quite happily
   and then fails on the first read, which would look like an empty calendar
   rather than a misconfiguration. Asking for one day of the mailbox turns that
   into a sentence in the boot log. */

import { query } from '../db/index.js';
import { upsertStaticToken } from './accounts.js';
import * as microsoft from '../providers/microsoft.js';

export const SERVICE_ID = uid => `microsoft_service:${uid}`;

export const configured = (env = process.env) => microsoft.appConfigured(env);

export async function seedOutlookService(env = process.env){
  if (!configured(env)) return { configured: false };

  const user = String(env.MS_SERVICE_USER).trim();
  const id = SERVICE_ID(user.toLowerCase());

  /* Mint a token and use it once. Both steps can fail for different reasons
     and the message that comes back names which. */
  const tok = await microsoft.appToken(env);
  const day = 24 * 3600_000;
  await microsoft.listEvents({
    token: tok.accessToken,
    cal: id,
    mailbox: user,
    from: new Date(Date.now() - day).toISOString(),
    to: new Date(Date.now() + day).toISOString()
  });

  /* The row already exists after the first boot; labelSource 'env' keeps a
     name the owner has since typed in the UI. There is no secret to store --
     the credential is the client secret in the environment -- so the token
     column holds the marker the refresh path replaces on first use. */
  await upsertStaticToken({
    provider: 'microsoft_service',
    uid: user.toLowerCase(),
    display: user,
    label: (user.split('@')[0] || 'Outlook').slice(0, 24),
    color: '#5B8DEF',
    token: 'client_credentials',
    meta: { mailbox: user, seededFrom: 'MS_SERVICE_USER' },
    labelSource: 'env'
  });

  return { configured: true, id, user };
}

/* The service calendar row, for the routes that write to it. */
export async function serviceAccount(){
  const { rows } = await query(
    `SELECT id, label, email, meta, status FROM accounts
      WHERE provider = 'microsoft_service'
        AND COALESCE(meta->>'excluded', 'false') <> 'true'
      ORDER BY connected_at ASC LIMIT 1`);
  const r = rows[0];
  return r ? { id: r.id, label: r.label, email: r.email,
    mailbox: r.meta?.mailbox || null, status: r.status, provider: 'microsoft_service' } : null;
}
