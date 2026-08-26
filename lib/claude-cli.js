/* Finding and running the Claude Code CLI without a shell.

   The obvious `spawn('claude', args, {shell:true})` has two problems, and on
   Windows they are not theoretical:

     - Node refuses to spawn a .cmd without a shell (EINVAL), and the npm
       installed `claude` on Windows IS a .cmd shim. So shell:true looks
       mandatory.
     - With shell:true the arguments are concatenated, not escaped — Node emits
       DEP0190 saying exactly that. A prompt containing a space becomes several
       shell words, which is why the first version returned an empty reply: the
       prompt never arrived intact.

   The shim is a wrapper around a plain Node script, so the fix is to skip the
   shim: spawn this process's own node binary with cli.js as the first argument.
   No shell, Node escapes the argv itself, and it behaves identically on Windows,
   macOS and Linux.

   The prompt still goes over stdin rather than argv — `claude -p` reads it from
   there — because a long prompt is exactly the kind of thing that runs into a
   command-line length limit. */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

let cached = null;

/* Where a global install puts @anthropic-ai/claude-code. */
function candidates(env){
  const out = [];
  if (env.CLAUDE_CLI) out.push(env.CLAUDE_CLI);

  const rel = path.join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const roots = [
    env.APPDATA && path.join(env.APPDATA, 'npm'),          // Windows npm global
    env.npm_config_prefix,
    env.NVM_BIN && path.dirname(env.NVM_BIN),
    '/usr/local/lib', '/usr/lib', '/opt/homebrew/lib',
    path.join(os.homedir(), '.npm-global'),
    path.join(os.homedir(), '.local'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm')
  ].filter(Boolean);

  for (const r of roots) out.push(path.join(r, rel));
  /* A local dependency, if the app happens to have one. */
  out.push(path.resolve(rel));
  return out;
}

/* { kind:'node', cli } when the script was found, { kind:'shell' } otherwise.
   The shell form still works — it is just the one with the quoting caveat, so it
   is the fallback rather than the default. */
export function resolveClaude(env = process.env){
  if (cached) return cached;
  for (const c of candidates(env)) {
    try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return (cached = { kind:'node', cli: c }); }
    catch { /* unreadable candidate, keep looking */ }
  }
  return (cached = { kind:'shell' });
}

/* Variables that switch Claude Code from the subscription to API billing. The
   whole point of running this locally is that turns bill to the subscription, so
   a stray key in .env must not quietly redirect them to metered credits — and a
   .env assembled by copying another project's is exactly how that happens. It
   happened here: merging a Railway export brought ANTHROPIC_API_KEY along with
   it. Stripping them in code means the guarantee does not depend on what is in
   the environment. */
const BILLING_OVERRIDES = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'
];

/* Which overrides were stripped, so the UI can say the guarantee held. */
export function strippedBilling(env = process.env){
  return BILLING_OVERRIDES.filter(k => env[k]);
}

function childEnv(env){
  const out = { ...env };
  for (const k of BILLING_OVERRIDES) delete out[k];
  return out;
}

/* Spawn Claude Code. `prompt` is written to stdin when given. */
/* `keepStdin` leaves the pipe open for streaming-input mode, where stdin is a
   message channel rather than a one-shot prompt and closing it would end the
   session before the model has answered. */
export function spawnClaude(args, { cwd, prompt = null, env = process.env, keepStdin = false } = {}){
  const how = resolveClaude(env);
  const childProcessEnv = childEnv(env);
  const child = how.kind === 'node'
    ? spawn(process.execPath, [how.cli, ...args], { cwd, env: childProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    /* Last resort. Quoted here because with a shell nothing else will. */
    : spawn('claude', args.map(shellQuote), { cwd, env: childProcessEnv, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });

  child.stdin.on('error', () => {});    // the child may exit before we finish writing
  if (prompt != null) child.stdin.end(prompt);
  else if (!keepStdin) child.stdin.end();
  return child;
}

function shellQuote(a){
  const s = String(a);
  if (process.platform === 'win32') return /[\s"^&|<>()]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  return /[^\w@%+=:,./-]/.test(s) ? "'" + s.replace(/'/g, `'\\''`) + "'" : s;
}

/* One-shot commands (auth status, plugin list) collected into a string. */
export function claudeOnce(args, { cwd, timeoutMs = 20_000, env = process.env } = {}){
  return new Promise(resolve => {
    let child;
    try { child = spawnClaude(args, { cwd, env }); }
    catch (err) { return resolve({ ok:false, error: err.message }); }
    let out = '', errOut = '';
    const t = setTimeout(() => { child.kill('SIGTERM'); resolve({ ok:false, error:'timed out' }); }, timeoutMs);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { errOut += c; });
    child.on('error', e => { clearTimeout(t); resolve({ ok:false, error: e.code === 'ENOENT'
      ? 'Claude Code was not found. Install it, or set CLAUDE_CLI to its cli.js.' : e.message }); });
    child.on('close', code => { clearTimeout(t);
      resolve({ ok: code === 0, code, stdout: out.trim(), stderr: errOut.trim() }); });
  });
}
