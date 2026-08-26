/* Postgres access. Two databases, one pool each, one query helper for each.

   DATABASE_URL      command-center's OWN tables: accounts, webhook_events,
                     sync_state, social_*. Railway's Postgres today. This is
                     where the encrypted mail tokens live, which is why it is not
                     simply repointed at Supabase — doing so would silently
                     disconnect every connected mailbox.

   SUPABASE_DB_URL   the portal database: lead, ghl_*, appointment and the rest.
                     command-center reads it, LISTENs on it, and writes to it
                     only through the webhook processor and the send path.
                     Falls back to DATABASE_URL when unset, which is the
                     single-database layout the original brief described.

   Tokens live in a database rather than on disk because Railway's container
   filesystem is ephemeral: without a mounted volume a redeploy would wipe every
   stored refresh token and silently disconnect all of them. */

import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Railway's private network hostname terminates no TLS, so asking for SSL there
   fails outright. Its public proxy and Supabase's pooler both require SSL but
   present certificates the default trust store rejects. Neither is a case where
   verification buys anything — the private link never leaves Railway's network,
   and the others are already authenticated by the password in the URL. */
function sslFor(url){
  if (process.env.PGSSLMODE === 'disable') return false;
  if (/\.railway\.internal|localhost|127\.0\.0\.1|::1/.test(url)) return false;
  return { rejectUnauthorized: false };
}

export const ownDbUrl = () => process.env.DATABASE_URL;
export const ghlDbUrl = () => process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

/* Same URL, same pool: with SUPABASE_DB_URL unset both helpers share one. */
const pools = new Map();

function poolFor(url){
  if (!url) throw new Error('no database URL configured');
  let pool = pools.get(url);
  if (pool) return pool;

  pool = new pg.Pool({
    connectionString: url,
    ssl: sslFor(url),
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  /* An idle client erroring emits on the pool, and an unhandled 'error' event
     takes the process down. Postgres restarts are routine on managed hosting;
     the pool replaces the client on its own, so logging is the whole job. */
  pool.on('error', err => console.error('[db] idle client error:', err.message));
  pools.set(url, pool);
  return pool;
}

/* Kept for anything that imported it by name; now resolves to the own-tables pool. */
export const connect = () => poolFor(ownDbUrl());

/* command-center's own tables. */
export const query = (text, params) => poolFor(ownDbUrl()).query(text, params);

/* The portal's GHL tables. Every read in lib/ghl-data.js, every portal write in
   the webhook processor and the send path, and nothing else. */
export const ghlQuery = (text, params) => poolFor(ghlDbUrl()).query(text, params);

/* A dedicated client from the same pool, for the rare portal write that has to
   be a transaction. ghlQuery hands out whichever connection happens to be free,
   so a BEGIN and its COMMIT sent through it can land on different ones -- the
   transaction is then a fiction, and a half-applied ownership change is exactly
   the kind of thing that leaves the tree and the record disagreeing. Callers
   must release(). */
export const ghlClient = () => poolFor(ghlDbUrl()).connect();

/* Schema is applied on every boot, not versioned. Every statement in
   schema.sql is IF NOT EXISTS, so re-running it is a no-op once settled.
   Own tables only, so it runs against DATABASE_URL and never against Supabase. */
export async function migrate(){
  const sql = await readFile(path.join(HERE, 'schema.sql'), 'utf8');
  await query(sql);
}

/* The live-update triggers, kept in their own file because they touch portal
   tables and schema.sql must never do that. Runs against the GHL database.
   Idempotent (CREATE OR REPLACE plus DROP/CREATE TRIGGER), and non-fatal: a
   role without trigger privileges means no live updates, not no dashboard. */
export async function applyNotifyTriggers(){
  const sql = await readFile(path.join(HERE, 'notify-triggers.sql'), 'utf8');
  await ghlQuery(sql);
}

/* A dedicated single connection to the GHL database, outside the pool. LISTEN
   binds to one backend connection for its lifetime, and a pooled client that
   gets recycled takes its subscriptions with it.

   Session-pooler note: LISTEN works in Supabase's session mode (port 5432) and
   silently never fires in transaction mode (port 6543). describeDb() warns. */
export function dedicatedClient(){
  const url = ghlDbUrl();
  return new pg.Client({ connectionString: url, ssl: sslFor(url) });
}

/* Host, port and a plain-English kind, for boot logs and /api/ghl/diag. Never
   the credentials. */
export function describeDb(url){
  if (!url) return { host: null, port: null, kind: 'unset', warning: 'not set' };
  try {
    const u = new URL(url);
    const port = Number(u.port) || 5432;
    const host = u.hostname;
    const kind = /supabase\.(com|co)$/.test(host) ? 'supabase'
               : /railway/.test(host) ? 'railway'
               : /localhost|127\.0\.0\.1/.test(host) ? 'local'
               : 'other';
    let warning = null;
    if (kind === 'supabase' && port === 6543) {
      warning = 'port 6543 is the TRANSACTION pooler — LISTEN/NOTIFY never fires there; use the session pooler on 5432';
    }
    return { host, port, kind, warning };
  } catch {
    return { host: null, port: null, kind: 'invalid', warning: 'did not parse as a URL' };
  }
}

export async function close(){
  await Promise.all([...pools.values()].map(p => p.end().catch(() => {})));
  pools.clear();
}
