/* Postgres access. One pool, one query helper, one migration runner.

   Tokens live here rather than on disk because Railway's container filesystem
   is ephemeral: without a mounted volume a redeploy would wipe every stored
   refresh token and silently disconnect all of them. */

import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* Railway's private network hostname terminates no TLS, so asking for SSL there
   fails outright. Its public proxy requires SSL but presents a certificate the
   default trust store rejects. Neither is a case where verification buys
   anything — the private link never leaves Railway's network, and the public one
   is already authenticated by the password in the URL. */
function sslFor(url){
  if (process.env.PGSSLMODE === 'disable') return false;
  if (/\.railway\.internal|localhost|127\.0\.0\.1|::1/.test(url)) return false;
  return { rejectUnauthorized: false };
}

let pool = null;

export function connect(url){
  if (pool) return pool;
  pool = new pg.Pool({
    connectionString: url,
    ssl: sslFor(url),
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000
  });
  /* An idle client erroring emits on the pool, and an unhandled 'error' event
     takes the process down. Postgres restarts are routine on Railway; the pool
     replaces the client on its own, so logging is the whole job. */
  pool.on('error', err => console.error('[db] idle client error:', err.message));
  return pool;
}

export const query = (text, params) => connect(process.env.DATABASE_URL).query(text, params);

/* Schema is applied on every boot, not versioned. Every statement in
   schema.sql is IF NOT EXISTS, so re-running it is a no-op once settled. */
export async function migrate(){
  const sql = await readFile(path.join(HERE, 'schema.sql'), 'utf8');
  await query(sql);
}

/* The live-update triggers, kept in their own file because they touch portal
   tables and schema.sql must never do that. Idempotent (CREATE OR REPLACE plus
   DROP/CREATE TRIGGER), and non-fatal: a role without trigger privileges means
   no live updates, not no dashboard — the caller logs the reason and boots on. */
export async function applyNotifyTriggers(){
  const sql = await readFile(path.join(HERE, 'notify-triggers.sql'), 'utf8');
  await query(sql);
}

/* A dedicated single connection, outside the pool. LISTEN binds to one backend
   connection for its lifetime, and a pooled client that gets recycled takes its
   subscriptions with it. Session-pooler note: LISTEN works in session mode,
   which is what DATABASE_URL is documented to be; in transaction mode it
   silently never fires. */
export function dedicatedClient(){
  const url = process.env.DATABASE_URL;
  return new pg.Client({ connectionString: url, ssl: sslFor(url) });
}

export async function close(){
  if (!pool) return;
  await pool.end().catch(() => {});
  pool = null;
}
