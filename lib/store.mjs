/* Encrypted token store.

   Refresh tokens are long-lived credentials, so they are never written in the
   clear. AES-256-GCM, key derived from ENCRYPTION_KEY (or APP_PASSWORD).

   The backing file lives in DATA_DIR. On Railway that filesystem is ephemeral
   unless a volume is mounted — see the README. Without one, a redeploy drops
   the tokens and you reconnect. */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export class TokenStore {
  constructor({ file, secret }){
    this.file = file;
    this.key = secret ? scryptSync(secret, 'command-center.tokens.v1', 32) : null;
    this.cache = null;
  }

  get enabled(){ return Boolean(this.key); }

  async all(){
    if (!this.enabled) return {};
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.file);
      const iv = raw.subarray(0, IV_LEN);
      const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const body = raw.subarray(IV_LEN + TAG_LEN);
      const d = createDecipheriv(ALGO, this.key, iv);
      d.setAuthTag(tag);
      this.cache = JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Usually means the key changed. Refuse to guess; start clean.
        console.error('[store] could not decrypt, starting empty:', err.message);
      }
      this.cache = {};
    }
    return this.cache;
  }

  async get(key){ return (await this.all())[key] || null; }

  async set(key, value){
    const all = await this.all();
    all[key] = value;
    await this.#flush();
  }

  async remove(key){
    const all = await this.all();
    if (!(key in all)) return false;
    delete all[key];
    await this.#flush();
    return true;
  }

  async destroy(){
    this.cache = {};
    await unlink(this.file).catch(() => {});
  }

  async #flush(){
    if (!this.enabled) throw new Error('token store has no encryption key');
    const iv = randomBytes(IV_LEN);
    const c = createCipheriv(ALGO, this.key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(this.cache), 'utf8'), c.final()]);
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await writeFile(tmp, Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
