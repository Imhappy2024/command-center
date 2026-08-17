/* AES-256-GCM for the credentials stored in Postgres.

   Refresh tokens and IMAP app passwords are long-lived: whoever holds one reads
   the mailbox until it is revoked. A database dump, a leaked backup or a stray
   `SELECT *` in a log must not be enough, so nothing goes in as plaintext.

   Ciphertext is base64 of iv | tag | body, which fits a single TEXT column. */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

let key = null;

/* Derived once. scrypt is deliberately slow, and doing it per row would show up
   on every mail fetch across every account. */
export function initCrypto(secret){
  if (!secret) throw new Error('ENCRYPTION_KEY is required');
  key = scryptSync(String(secret), 'command-center.tokens.v1', 32);
}

export function encrypt(plain){
  if (!key) throw new Error('crypto not initialised');
  if (plain == null) return null;
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function decrypt(payload){
  if (!key) throw new Error('crypto not initialised');
  if (payload == null) return null;
  const raw = Buffer.from(String(payload), 'base64');
  if (raw.length <= IV_LEN + TAG_LEN) throw new Error('ciphertext truncated');
  const d = createDecipheriv(ALGO, key, raw.subarray(0, IV_LEN));
  d.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
  /* Throws if the tag does not verify, which means the row was tampered with or
     ENCRYPTION_KEY changed. Both are worth failing on rather than guessing. */
  return Buffer.concat([d.update(raw.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf8');
}
