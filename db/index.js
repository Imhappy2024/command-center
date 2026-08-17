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

export async function close(){
  if (!pool) return;
  await pool.end().catch(() => {});
  pool = null;
}
