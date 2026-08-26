/* Load .env into process.env, if there is one.

   There was no loader at all: the app read process.env and nothing else, which
   is correct on Railway (variables are injected) and quietly broken everywhere
   else. `cp .env.example .env && npm run dev` did nothing, and the startup error
   said "or in .env for a local run" — advice the code did not implement.

   Node's --env-file would do this, but --env-file errors when the file is
   missing (so it cannot be in the `start` script that Railway runs) and
   --env-file-if-exists only landed in 20.12 while package.json allows 20.0.
   Sixty lines is cheaper than a dependency or a version floor.

   Real environment variables always win. On a hosted platform the injected
   values are the truth, and a stale committed .env must never override them. */

import fs from 'node:fs';

/* export FOO=bar and FOO: bar are both common enough in pasted snippets that
   silently ignoring the line is worse than accepting it. */
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*?)\s*$/;

export function parseEnv(text){
  const out = {};
  /* Strip a BOM — a .env saved from Notepad or PowerShell's Out-File has one,
     and it would otherwise become part of the first variable's name. */
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2];

    if (val.startsWith('"') && val.endsWith('"') && val.length > 1) {
      val = val.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r')
               .replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (val.startsWith("'") && val.endsWith("'") && val.length > 1) {
      /* Single quotes are literal, as in a shell. */
      val = val.slice(1, -1);
    } else {
      /* Unquoted: a # begins a comment, but only with space before it, so a
         value that is legitimately full of hashes (a secret) survives. */
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

/* Returns the names it set, so the caller can say so in the boot log. */
export function loadEnvFile(file = '.env', env = process.env){
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return []; }                      // no file is the normal hosted case

  const applied = [];
  for (const [k, v] of Object.entries(parseEnv(text))) {
    /* Set only what is absent or empty. An injected variable outranks the file;
       an empty placeholder left in a copied .env.example does not count as set. */
    if (env[k] === undefined || env[k] === '') { env[k] = v; applied.push(k); }
  }
  return applied;
}
