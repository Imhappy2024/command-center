/* Encrypted token store.

   Refresh tokens are long-lived credentials, so they are never written in the
   clear. AES-256-GCM, key derived from ENCRYPTION_KEY (or APP_PASSWORD).

   The backing file lives in DATA_DIR. On Railway that filesystem is ephemeral
   unless a volume is mounted — see the README. Without one, a redeploy drops
   the tokens and you reconnect. */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, open, stat } from 'node:fs/promises';
import path from 'node:path';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

export class TokenStore {
  constructor({ file, secret }){
    this.file = file;
    this.key = secret ? scryptSync(secret, 'command-center.tokens.v1', 32) : null;
    // Writes are serialised so a read-modify-write cannot interleave with another.
    this.queue = Promise.resolve();
  }

  get enabled(){ return Boolean(this.key); }

  /* Deliberately uncached. The server and `npm run refresh` are separate
     processes, and Microsoft rotates the refresh token on every renewal — a
     stale in-memory copy flushed later would overwrite a newer, working token
     with a dead one. Re-reading a few KB is far cheaper than that failure. */
  async all(){
    if (!this.enabled) return {};
    try {
      const raw = await readFile(this.file);
      const iv = raw.subarray(0, IV_LEN);
      const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
      const body = raw.subarray(IV_LEN + TAG_LEN);
      const d = createDecipheriv(ALGO, this.key, iv);
      d.setAuthTag(tag);
      return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString('utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Usually means the key changed. Refuse to guess; start clean.
        console.error('[store] could not decrypt, starting empty:', err.message);
      }
      return {};
    }
  }

  async get(key){ return (await this.all())[key] || null; }

  async set(key, value){
    return this.#mutate(all => { all[key] = value; return true; });
  }

  async remove(key){
    return this.#mutate(all => {
      if (!(key in all)) return false;
      delete all[key];
      return true;
    });
  }

  async destroy(){
    await unlink(this.file).catch(() => {});
  }

  /* Cross-process exclusive lock. The in-process queue only orders this
     process's writes; the server and `npm run refresh` are separate processes
     that would otherwise both read, both modify, and the second rename would
     silently discard the first one's change. */
  async #withLock(fn){
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + 5000;

    for (;;) {
      try {
        await (await open(lock, 'wx')).close();
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // Reclaim a lock left behind by a process that died mid-write.
        const age = await stat(lock).then(s => Date.now() - s.mtimeMs).catch(() => 0);
        if (age > 10_000) { await unlink(lock).catch(() => {}); continue; }
        if (Date.now() > deadline) throw new Error('token store stayed locked by another process');
        await new Promise(r => setTimeout(r, 20 + Math.floor(Math.random() * 60)));
      }
    }

    try { return await fn(); }
    finally { await unlink(lock).catch(() => {}); }
  }

  #mutate(apply){
    const next = this.queue.then(() => this.#withLock(async () => {
      if (!this.enabled) throw new Error('token store has no encryption key');
      const all = await this.all();
      const changed = apply(all);
      if (changed) await this.#write(all);
      return changed;
    }));
    // Keep the chain alive even if this link rejects.
    this.queue = next.catch(() => {});
    return next;
  }

  async #write(data){
    const iv = randomBytes(IV_LEN);
    const c = createCipheriv(ALGO, this.key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(data), 'utf8'), c.final()]);
    await mkdir(path.dirname(this.file), { recursive: true });

    /* Unique temp name per write. A fixed one collides when two processes
       (the server and `npm run refresh`) flush at the same moment: both create
       the same path, the first rename consumes it, the second fails ENOENT.
       Rename stays atomic, so the loser is simply overwritten, not lost. */
    const tmp = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }
}
