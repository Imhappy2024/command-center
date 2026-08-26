/* Where the app keeps files it owns.

   Until now uploads went to the OS temp directory, which is right for a hosted
   deployment that must not accumulate state and wrong for a desktop app: a clip
   you rendered should still be there tomorrow, and you should be able to find it
   in a folder without asking where the app hid it.

   Everything lives under one directory inside the install, so it is obvious,
   backing it up is a copy, and deleting it is a clean reset:

     storage/
       attachments/   files and pasted images handed to Claude
       uploads/       source video waiting to be sent to OpusClip
       clips/         rendered clips pulled back down

   CC_DATA_DIR moves the lot. On Railway, point it at a mounted volume or leave
   it and accept that it is ephemeral -- the hosted deployment has no user
   sitting in front of it expecting yesterday's render. */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const KINDS = ['attachments', 'uploads', 'clips'];

export function storageRoot(env = process.env){
  if (env.CC_DATA_DIR) return path.resolve(env.CC_DATA_DIR);
  /* Railway injects this when a volume is mounted; using it means a deploy does
     not throw away what the last one produced. */
  if (env.RAILWAY_VOLUME_MOUNT_PATH) return path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'storage');
  return path.join(ROOT, 'storage');
}

/* Creates on demand rather than at boot: a hosted deployment with a read-only
   filesystem should fail when someone actually uploads, not refuse to start. */
export function dirFor(kind, env = process.env){
  if (!KINDS.includes(kind)) throw new Error('unknown storage kind: ' + kind);
  const dir = path.join(storageRoot(env), kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* A filename that cannot escape its directory and cannot collide.

   The original name is kept, because "clip-3-final.mp4" in a folder is worth
   more than a hex string, but it is stripped to a safe stem and prefixed with
   random bytes so two uploads of "video.mp4" do not overwrite each other. */
export function safeName(original){
  /* Control characters first: they survive path.basename and produce a name
     that is legal on disk and unquotable everywhere else. */
  const base = path.basename(String(original || 'file'))
    .split('').filter(ch => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f).join('');
  const ext = (base.match(/\.[A-Za-z0-9]{1,12}$/) || [''])[0].toLowerCase();
  const stem = base.slice(0, base.length - ext.length)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60) || 'file';
  return crypto.randomBytes(6).toString('hex') + '-' + stem + ext;
}

/* Resolve a stored file. The name arrives from a browser, so ../ is a matter of
   when rather than if.

   Refuses anything that is not already a bare filename instead of quietly
   basename-ing it into something valid: silently turning ../../secret.txt into
   <dir>/secret.txt is safe but hides the fact that a caller sent a path where a
   name belongs, and that is worth failing on. */
export function resolveStored(kind, name, env = process.env){
  const raw = String(name || '');
  if (!raw || raw !== path.basename(raw) || raw === '.' || raw === '..') return null;
  const dir = dirFor(kind, env);
  const full = path.resolve(dir, raw);
  /* Belt and braces: a name that survived the check above still must not land
     outside the directory (Windows device names, trailing dots, ADS colons). */
  if (full !== path.join(dir, raw) || !full.startsWith(dir + path.sep)) return null;
  return full;
}

export function describeStorage(env = process.env){
  const root = storageRoot(env);
  const out = { root, kinds: {} };
  for (const k of KINDS) {
    const dir = path.join(root, k);
    let files = 0, bytes = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        try { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) { files++; bytes += st.size; } }
        catch { /* vanished between readdir and stat */ }
      }
    } catch { /* not created yet */ }
    out.kinds[k] = { dir, files, bytes };
  }
  return out;
}
