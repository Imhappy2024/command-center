/* The accounts table, and the one function every provider call goes through to
   get a usable access token. */

import { query } from '../db/index.js';
import { encrypt, decrypt } from './crypto.js';
import { PROVIDERS, refreshTokens, refreshKindOf } from './oauth.js';

export const accountId = (provider, uid) => `${provider}:${uid}`;

/* Public shape. Never includes ciphertext, never includes a token.

   `unread` from the brief's response shape is deliberately absent: the frontend
   derives its counts from MAIL, which it already has, and producing the number
   here would mean an extra provider round trip per account on every page load
   purely to compute something nobody reads. */
const publicRow = r => ({
  id: r.id,
  provider: r.provider,
  email: r.email,
  label: r.label,
  color: r.color,
  status: r.status,
  /* Which views may show this account. IMAP has no calendar, so it must not
     appear as a calendar toggle that would sit empty forever. */
  feeds: PROVIDERS[r.provider]?.feeds || ['mail'],
  lastError: r.last_error || null,
  connectedAt: r.connected_at,
  /* Only the sending identities, picked out of meta rather than shipping the
     whole object — meta also holds provenance like which env var seeded the row,
     which the browser has no business knowing. */
  senders: r.meta?.senders || null
});

/* Mail-capable rows only. The table also holds GHL sub-accounts, which are not
   mailboxes and must never appear in the Inbox sidebar or as a calendar. */
export const listAccounts = () => accountsFor('mail');

export async function listAll(){
  const { rows } = await query(`SELECT * FROM accounts ORDER BY connected_at ASC`);
  return rows.map(publicRow);
}

/* GHL and anything else authenticated by a token the user pastes. There is no
   refresh, so the stored secret is returned as-is.

   labelSource decides whether an incoming label and colour may overwrite what is
   already stored. A sub-account seeded from environment variables passes 'env'
   and must not clobber a name the owner has since typed in the UI; the Connect
   sheet passes 'user' and does own the name. Without this, every redeploy would
   rename four sub-accounts back to their environment defaults. */
export async function upsertStaticToken({ provider, uid, display, label, color, token, meta = {}, labelSource = 'user' }){
  const id = accountId(provider, uid);
  const incomingMeta = { ...meta, labelSource };
  await query(
    `INSERT INTO accounts
       (id, provider, provider_uid, email, label, color, refresh_token,
        auth_kind, meta, status, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'static_token',$8,'ok',NULL)
     ON CONFLICT (provider, provider_uid) DO UPDATE SET
       email         = EXCLUDED.email,
       refresh_token = EXCLUDED.refresh_token,
       auth_kind     = 'static_token',
       status        = 'ok',
       last_error    = NULL,
       label         = CASE WHEN accounts.meta->>'labelSource' = 'user'
                            THEN accounts.label ELSE EXCLUDED.label END,
       color         = CASE WHEN accounts.meta->>'labelSource' = 'user'
                            THEN accounts.color ELSE EXCLUDED.color END,
       /* Incoming keys win so a renamed location updates, except labelSource
          itself: once it is 'user' it stays 'user'. */
       meta          = (COALESCE(accounts.meta, '{}'::jsonb) || EXCLUDED.meta)
                       || jsonb_build_object('labelSource',
                            COALESCE(NULLIF(accounts.meta->>'labelSource', 'env'),
                                     EXCLUDED.meta->>'labelSource', 'env'))`,
    [id, provider, uid, display, label, color, encrypt(token), incomingMeta]
  );
  return id;
}

/* Merge a patch into an account's meta without touching its credential. Used by
   the sync job to cache things that change rarely and must not be fetched from a
   request handler — a GHL sub-account's sending numbers, for one. */
export async function mergeAccountMeta(id, patch){
  const { rows } = await query(
    `UPDATE accounts
        SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
      WHERE id = $1
      RETURNING meta`,
    [id, JSON.stringify(patch || {})]
  );
  return rows[0]?.meta || null;
}

export async function getStaticToken(id){
  const row = await getAccount(id);
  if (!row) throw new Error(`Unknown connection ${id}`);
  if (row.auth_kind !== 'static_token') throw new Error(`${id} is not a token connection`);
  return { token: decrypt(row.refresh_token), uid: row.provider_uid, meta: row.meta || {} };
}

export async function getAccount(id){
  const { rows } = await query(`SELECT * FROM accounts WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function accountsFor(feed){
  const { rows } = await query(`SELECT * FROM accounts ORDER BY connected_at ASC`);
  return rows
    .filter(r => (PROVIDERS[r.provider]?.feeds || []).includes(feed))
    .map(publicRow);
}

/* Reconnecting an account must not rename it. The label and colour were chosen
   once and are how the mailbox is recognised in the sidebar; the point of
   reconnecting is to replace dead tokens, not to start over. Rename goes
   through POST /api/accounts/:id instead. */
/* `meta` carries whatever a provider needs without a column per provider: an
   Instagram row's parent Page id, an ad account's currency. Merged rather than
   replaced, so a later reconnect that knows less does not erase what an earlier
   one stored. */
export async function upsertOAuth({ provider, uid, email, label, color, refreshToken, accessToken, expiresAt, scope, meta = {} }){
  const id = accountId(provider, uid);
  await query(
    `INSERT INTO accounts
       (id, provider, provider_uid, email, label, color,
        refresh_token, access_token, expires_at, scope, meta, status, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ok',NULL)
     ON CONFLICT (provider, provider_uid) DO UPDATE SET
       email         = EXCLUDED.email,
       refresh_token = EXCLUDED.refresh_token,
       access_token  = EXCLUDED.access_token,
       expires_at    = EXCLUDED.expires_at,
       scope         = EXCLUDED.scope,
       meta          = COALESCE(accounts.meta, '{}'::jsonb) || EXCLUDED.meta,
       status        = 'ok',
       last_error    = NULL,
       label         = accounts.label,
       color         = accounts.color`,
    [id, provider, uid, email, label, color,
     encrypt(refreshToken), encrypt(accessToken), expiresAt, scope, meta]
  );
  return id;
}

/* Colours for rows the user never named, so two Pages discovered from one grant
   do not arrive identical. Same palette the frontend offers. */
const PALETTE = ['#D9A441', '#4E9E7E', '#5B8DEF', '#C2553F',
                 '#B07FD4', '#4FB8A8', '#E0784A', '#8E9BA8'];

export async function nextColour(){
  const { rows } = await query(`SELECT color FROM accounts`);
  const used = new Set(rows.map(r => String(r.color || '').toLowerCase()));
  return PALETTE.find(c => !used.has(c.toLowerCase())) || PALETTE[used.size % PALETTE.length];
}

export async function upsertImap({ uid, email, label, color, password, imapHost, imapPort, smtpHost, smtpPort }){
  const id = accountId('imap', uid);
  await query(
    `INSERT INTO accounts
       (id, provider, provider_uid, email, label, color, refresh_token,
        imap_host, imap_port, smtp_host, smtp_port, status, last_error)
     VALUES ($1,'imap',$2,$3,$4,$5,$6,$7,$8,$9,$10,'ok',NULL)
     ON CONFLICT (provider, provider_uid) DO UPDATE SET
       email         = EXCLUDED.email,
       refresh_token = EXCLUDED.refresh_token,
       imap_host     = EXCLUDED.imap_host,
       imap_port     = EXCLUDED.imap_port,
       smtp_host     = EXCLUDED.smtp_host,
       smtp_port     = EXCLUDED.smtp_port,
       status        = 'ok',
       last_error    = NULL,
       label         = accounts.label,
       color         = accounts.color`,
    [id, uid, email, label, color, encrypt(password), imapHost, imapPort, smtpHost, smtpPort]
  );
  return id;
}

/* Marks the label as the owner's choice, which is what stops the environment
   seeder overwriting it on the next deploy. */
export async function renameAccount(id, { label, color }){
  const { rows } = await query(
    `UPDATE accounts SET
       label = COALESCE($2, label),
       color = COALESCE($3, color),
       meta  = CASE WHEN $2::text IS NULL AND $3::text IS NULL
                    THEN COALESCE(meta, '{}'::jsonb)
                    ELSE COALESCE(meta, '{}'::jsonb) || '{"labelSource":"user"}'::jsonb END
     WHERE id = $1 RETURNING *`,
    [id, label ?? null, color ?? null]
  );
  return rows[0] ? publicRow(rows[0]) : null;
}

export async function deleteAccount(id){
  const { rowCount } = await query(`DELETE FROM accounts WHERE id = $1`, [id]);
  return rowCount > 0;
}

async function markReauth(id, message){
  await query(
    `UPDATE accounts SET status = 'reauth', last_error = $2 WHERE id = $1`,
    [id, String(message).slice(0, 500)]
  );
}

/* Concurrent refreshes of the same account are the one thing that must not
   happen. Microsoft invalidates the old refresh token as soon as it issues a
   new one, so two in-flight refreshes race: the loser persists a token the
   provider has already revoked, and the account is dead until reconnected.
   Callers fan out with Promise.allSettled, so this is reachable in normal use. */
const inFlight = new Map();

/* How long before expiry a credential is renewed, by refresh kind.

   A minute is right for an hour-long OAuth access token. It is wrong for Meta's
   sixty-day long-lived token: that one has to be exchanged well before it lapses,
   because once it does there is no refresh token to fall back on and the only fix
   is signing in again. */
const RENEW_MARGIN_MS = {
  refresh_token: 60_000,
  long_lived_exchange: 7 * 86_400_000
};

export async function getAccessToken(id){
  if (inFlight.has(id)) return inFlight.get(id);

  const work = (async () => {
    const row = await getAccount(id);
    if (!row) throw new Error(`Unknown account ${id}`);
    if (row.provider === 'imap') throw new Error('IMAP accounts have no access token');

    const kind = refreshKindOf(row.provider);

    /* Never expires — a Facebook Page token derived from a long-lived user token.
       Returned straight from storage rather than round-tripping through a refresh
       that would only hand the same value back and write a row for nothing. */
    if (kind === 'none') return decrypt(row.refresh_token);

    const margin = RENEW_MARGIN_MS[kind] ?? 60_000;
    if (row.access_token && Number(row.expires_at) > Date.now() + margin) {
      return decrypt(row.access_token);
    }

    try {
      const fresh = await refreshTokens(row.provider, process.env, decrypt(row.refresh_token));
      await query(
        `UPDATE accounts SET
           access_token = $2, refresh_token = $3, expires_at = $4,
           scope = COALESCE($5, scope), status = 'ok', last_error = NULL
         WHERE id = $1`,
        [id, encrypt(fresh.accessToken), encrypt(fresh.refreshToken), fresh.expiresAt, fresh.scope]
      );
      return fresh.accessToken;
    } catch (err) {
      /* The row is kept. A revoked or expired grant is fixed by reconnecting,
         and deleting it would lose the label, the colour, and any idea that the
         mailbox was ever there. The sidebar shows it with a red marker instead,
         and one dead mailbox never takes down the others. */
      await markReauth(id, err.message);
      throw new Error(`${row.email || id} needs reconnecting: ${err.message}`);
    }
  })().finally(() => inFlight.delete(id));

  inFlight.set(id, work);
  return work;
}

export async function getImapConfig(id){
  const row = await getAccount(id);
  if (!row) throw new Error(`Unknown account ${id}`);
  if (row.provider !== 'imap') throw new Error('Not an IMAP account');
  return {
    email: row.email,
    password: decrypt(row.refresh_token),
    imapHost: row.imap_host,
    imapPort: row.imap_port || 993,
    smtpHost: row.smtp_host || row.imap_host,
    smtpPort: row.smtp_port || 465
  };
}

export { markReauth };
