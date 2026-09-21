/* Who may sign in, and how a password is checked.

   The gate used to be one shared APP_PASSWORD. That cannot say who is looking,
   cannot be revoked for one person without revoking it for everybody, and
   cannot be changed by the person using it. This is a row per person instead.

   ---------------------------------------------------------------------------
   Passwords are not stored. What is stored is scrypt over the password and 16
   random bytes of salt, which is a one-way function -- the row is enough to
   CHECK a password and not enough to learn one. The salt is per row, so two
   people who pick the same password do not produce the same hash, and a stolen
   table cannot be attacked by looking values up in a table someone prepared
   earlier.

   scrypt rather than SHA: it is deliberately slow and memory-hard, which is
   what makes guessing expensive. Node ships it, so this adds no dependency.

   ---------------------------------------------------------------------------
   Where the first passwords come from: APP_USERS in the environment, never
   this file. This repository is public. A password committed here would be
   public the moment it was pushed, and so would a hash of one -- scrypt slows
   an attacker down, it does not save a password that appears in a word list.
   The environment is the right home for a secret; source control never is. */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { query } from '../db/index.js';

/* Node's defaults, named rather than implied, because changing them later
   silently invalidates every stored password. N=16384, r=8, p=1. */
const KEYLEN = 64;
const SALT_BYTES = 16;

/* Eight, which is the floor rather than a recommendation. It is set here so
   that a password the owner has already chosen is not rejected by a rule
   invented after the fact; the honest defence against a short password is the
   attempt limiter on the sign-in route, not a number that makes people write
   their password down. */
export const MIN_PASSWORD = 8;

const norm = email => String(email || '').trim().toLowerCase();

function hash(password, salt){
  return scryptSync(String(password), Buffer.from(salt, 'hex'), KEYLEN).toString('hex');
}

/* Timing-safe, and false rather than throwing on a row with a malformed hash:
   a comparison that throws tells the caller something about the row. */
function matches(password, row){
  if (!row?.password_hash || !row?.password_salt) return false;
  let mine;
  try { mine = Buffer.from(hash(password, row.password_salt), 'hex'); }
  catch { return false; }
  const theirs = Buffer.from(row.password_hash, 'hex');
  if (mine.length !== theirs.length) return false;
  return timingSafeEqual(mine, theirs);
}

/* What a new password must clear.

   Length first, because it is the only rule that reliably buys anything: a
   twelve-character passphrase beats eight characters of punctuation, and rules
   demanding a symbol mostly produce Password1! -- which is exactly the shape a
   word list tries first. The repeat check is the one that matters for the
   account this was built for: "set a new password" must not accept the old one
   back. */
export function passwordProblem(password, { current = null } = {}){
  const p = String(password || '');
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (p.length > 200) return 'That is longer than 200 characters.';
  if (/^\s|\s$/.test(p)) return 'It cannot start or end with a space.';
  if (current && p === current) return 'That is the password you are replacing. Choose a different one.';
  return null;
}

export async function findByEmail(email){
  const { rows } = await query(`SELECT * FROM users WHERE email_lower = $1`, [norm(email)]);
  return rows[0] || null;
}

export async function findById(id){
  const { rows } = await query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function countUsers(){
  const { rows } = await query(`SELECT count(*)::int AS n FROM users`);
  return rows[0]?.n || 0;
}

/* The public shape. Never the hash, never the salt -- those are the two things
   this whole file exists to keep out of everything else. */
export const publicUser = u => (u ? {
  id: String(u.id),
  email: u.email,
  name: u.name,
  mustChangePassword: Boolean(u.must_change_password),
  lastLoginAt: u.last_login_at || null
} : null);

/* A sign-in. Returns the row on success and null on every kind of failure --
   wrong address, wrong password, disabled account -- because telling those
   apart tells someone which addresses exist. */
export async function authenticate(email, password){
  const row = await findByEmail(email);
  /* A hash is computed even when there is no such user, so that a wrong
     address and a wrong password take the same time to answer. Without it the
     difference is measurable and it enumerates the user list. */
  if (!row) {
    hash(String(password || ''), randomBytes(SALT_BYTES).toString('hex'));
    return null;
  }
  if (row.disabled) return null;
  if (!matches(password, row)) return null;
  return row;
}

export async function recordLogin(id){
  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [id]);
}

export async function setPassword(id, password, { mustChange = false } = {}){
  const salt = randomBytes(SALT_BYTES).toString('hex');
  await query(
    `UPDATE users
        SET password_hash = $2, password_salt = $3,
            must_change_password = $4, password_set_at = now()
      WHERE id = $1`,
    [id, hash(password, salt), salt, mustChange]);
}

export async function createUser({ email, name, password, mustChange = false }){
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const { rows } = await query(
    `INSERT INTO users (email, email_lower, name, password_hash, password_salt,
                        must_change_password)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (email_lower) DO NOTHING
     RETURNING *`,
    [String(email).trim(), norm(email), String(name || email).trim(),
     hash(password, salt), salt, mustChange]);
  return rows[0] || null;
}

/* ---------------------------------------------------------------------------
   Seeding, from APP_USERS.

   JSON rather than a delimited string, because a password is exactly the kind
   of value that contains a colon, a comma or a quote, and a format that breaks
   on those is a format that will one day let somebody in with half a password.

     APP_USERS=[{"email":"a@b.com","name":"A B","password":"…","mustChange":true}]

   Creating only. An address already in the table is left exactly as it is --
   its password, its name, and whether it still has to change it. Anything else
   would mean a redeploy silently resetting a password somebody had chosen, and
   putting back a must-change flag they had already cleared.
   --------------------------------------------------------------------------- */
export function declaredUsers(env = process.env){
  const raw = String(env.APP_USERS || '').trim();
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); }
  catch (err) {
    throw new Error('APP_USERS is not valid JSON, so no accounts were created: ' + err.message);
  }
  if (!Array.isArray(list)) throw new Error('APP_USERS must be a JSON array of objects.');

  return list.map((u, i) => {
    const email = norm(u?.email);
    if (!email || !email.includes('@')) {
      throw new Error(`APP_USERS[${i}] has no usable email address.`);
    }
    const problem = passwordProblem(u?.password);
    if (problem) throw new Error(`APP_USERS[${i}] (${email}): ${problem}`);
    return {
      email: String(u.email).trim(),
      name: String(u.name || u.email).trim(),
      password: String(u.password),
      /* Default true. An account someone else created and typed a password
         into is the normal case, and defaulting the other way would leave a
         password the setter knows sitting on the account indefinitely. */
      mustChange: u.mustChange === undefined ? true : Boolean(u.mustChange)
    };
  });
}

export async function seedUsers(env = process.env){
  const declared = declaredUsers(env);
  if (!declared.length) return { declared: 0, created: 0, existing: 0 };

  let created = 0, existing = 0;
  for (const u of declared) {
    const row = await createUser(u);
    if (row) created++; else existing++;
  }
  return { declared: declared.length, created, existing };
}
