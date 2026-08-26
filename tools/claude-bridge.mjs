#!/usr/bin/env node
/* Claude bridge — run this on YOUR machine, not on the server.
   ============================================================

   Why this exists.

   A Claude subscription cannot be billed through the raw API. Anthropic's OAuth
   profiles bind to an API organisation and are credit-billed, and the documented
   answer for servers is Workload Identity Federation — still the API, still
   credits. So a dashboard that called /v1/messages would spend credits no matter
   how it authenticated.

   Claude Code is the exception, because it is a first-party client: it is
   already signed in to the subscription on this machine and has a headless mode.
   So the dashboard does not talk to Anthropic at all — your browser talks to
   this process over localhost, and this process runs `claude -p`. The
   subscription pays because Claude Code is what is running. Nothing goes through
   the Railway server, which never sees a prompt, a reply, or a credential.

   http://localhost is a "potentially trustworthy origin", so an HTTPS page is
   allowed to call it without tripping mixed-content blocking.

   Security. This is a local HTTP server that can run a coding agent with tool
   access, so it is treated as one:

     - bound to 127.0.0.1, never a routable interface
     - a shared token is required on every request, printed once at startup;
       without it any web page you happened to have open could drive this
     - the Origin header is checked against an allow-list
     - tools default to read-only. Claude can read, search and fetch; it cannot
       write, edit, or run shell commands unless you widen ALLOWED_TOOLS below
     - the working directory is one you name, so it cannot wander your disk

   Two ways to run Claude on your subscription:

     1. This bridge, on your machine. Claude sees the folder you point it at, so
        it can read and edit your actual project — the editor experience.
     2. `claude setup-token` mints a long-lived token that requires a Claude
        subscription, which is how Claude Code runs in CI. Put that in
        CLAUDE_CODE_OAUTH_TOKEN and Claude Code runs headless anywhere,
        including on the dashboard's own server — but then it only sees the
        server's disk, not your project.

   This file is option 1.

   Usage:
     node tools/claude-bridge.mjs --dir /path/to/project
     node tools/claude-bridge.mjs --dir . --port 8787 --write
*/

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { spawnClaude, claudeOnce } from '../lib/claude-cli.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = name => argv.includes('--' + name);

const PORT = Number(arg('port', 8787));
const CWD = path.resolve(arg('dir', process.cwd()));
const TOKEN = arg('token', process.env.CLAUDE_BRIDGE_TOKEN || randomBytes(16).toString('hex'));

/* Origins allowed to drive this. Add your own with --origin. */
const ORIGINS = new Set([
  'https://command-center-production-a10e.up.railway.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  arg('origin', null)
].filter(Boolean));

/* Read-only by default. --write adds the mutating tools; --yolo removes the
   guard rails entirely and is exactly as sensible as it sounds. */
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const ALLOWED_TOOLS = flag('yolo') ? null
  : flag('write') ? [...READ_TOOLS, ...WRITE_TOOLS, 'Bash']
  : READ_TOOLS;

if (!fs.existsSync(CWD) || !fs.statSync(CWD).isDirectory()) {
  console.error('Not a directory: ' + CWD);
  process.exit(1);
}

/* One child at a time. Claude Code is not cheap to run and a browser that
   retries would otherwise fan out into several concurrent agents. */
let running = null;
const BRIDGE_VERSION = 2;

/* The management subcommands (`claude auth status`, `claude plugin list`, ...)
   are one-shot and fast, unlike a chat turn. Kept separate from the streaming
   path and never given user-supplied argv — the only variable parts are a
   plugin name matched against a strict pattern and a fixed verb. */
const json = (res, obj, status = 200) =>
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj));

function cors(req, res){
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-bridge-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

const authed = req => req.headers['x-bridge-token'] === TOKEN
  || new URL(req.url, 'http://x').searchParams.get('token') === TOKEN;

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const url = new URL(req.url, 'http://127.0.0.1');

  /* Reachability probe. Deliberately says nothing about the machine beyond
     "a bridge is here" until the token checks out. */
  if (url.pathname === '/health') {
    if (!authed(req)) return res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ok: true, authed: false }));
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      ok: true, authed: true, cwd: CWD,
      tools: ALLOWED_TOOLS ? ALLOWED_TOOLS.join(',') : 'all (yolo)',
      /* The ceiling, so the dashboard offers only what this process would
         actually honour instead of showing checkboxes that do nothing. */
      permitted: ALLOWED_TOOLS,
      writable: Boolean(flag('write') || flag('yolo')),
      busy: Boolean(running),
      version: BRIDGE_VERSION
    }));
  }

  /* Which account Claude Code is signed in as. `claude auth status` prints
     JSON, including subscriptionType — which is how the dashboard can show that
     a subscription is paying rather than API credits. */
  if (url.pathname === '/auth') {
    if (!authed(req)) return json(res, { error: 'unauthorized' }, 401);
    const r = await claudeOnce(['auth','status'], { cwd: CWD });
    if (!r.ok && !r.stdout) return json(res, { ok:false, error: r.error || r.stderr || 'auth status failed' });
    try { return json(res, { ok:true, account: JSON.parse(r.stdout) }); }
    catch { return json(res, { ok:true, raw: r.stdout }); }
  }

  /* Installed plugins, and enable/disable. Claude Code owns the state; this
     only reads it and flips it. */
  if (url.pathname === '/plugins' && req.method === 'GET') {
    if (!authed(req)) return json(res, { error: 'unauthorized' }, 401);
    const r = await claudeOnce(['plugin','list'], { cwd: CWD });
    return json(res, { ok: r.ok, text: r.stdout || r.stderr || '', error: r.error });
  }
  if (url.pathname === '/plugins' && req.method === 'POST') {
    if (!authed(req)) return json(res, { error: 'unauthorized' }, 401);
    let b = ''; for await (const c of req) { b += c; if (b.length > 4096) return res.writeHead(413).end(); }
    let p2 = {}; try { p2 = JSON.parse(b || '{}'); } catch { return json(res, { error:'bad json' }, 400); }
    const verb = ['enable', 'disable'].includes(p2.action) ? p2.action : null;
    /* Never interpolate a name into a shell; and refuse anything that is not a
       plain plugin identifier, so a crafted request cannot smuggle argv. */
    const name = /^[\w.@/-]{1,80}$/.test(String(p2.name || '')) ? String(p2.name) : null;
    if (!verb || !name) return json(res, { error: 'need action enable|disable and a valid plugin name' }, 400);
    const r = await claudeOnce(['plugin', verb, name], { cwd: CWD, timeoutMs: 40_000 });
    return json(res, { ok: r.ok, text: r.stdout || r.stderr || '', error: r.error });
  }

  /* MCP servers Claude Code already knows about, as distinct from the
     per-session ones the dashboard passes inline. */
  if (url.pathname === '/mcp' && req.method === 'GET') {
    if (!authed(req)) return json(res, { error: 'unauthorized' }, 401);
    const r = await claudeOnce(['mcp','list'], { cwd: CWD, timeoutMs: 30_000 });
    return json(res, { ok: r.ok, text: r.stdout || r.stderr || '', error: r.error });
  }

  if (url.pathname === '/stop') {
    if (!authed(req)) return res.writeHead(401).end();
    if (running) { running.kill('SIGTERM'); running = null; }
    return res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  }

  if (url.pathname !== '/chat' || req.method !== 'POST') return res.writeHead(404).end();
  if (!authed(req)) return res.writeHead(401, { 'Content-Type': 'application/json' })
    .end('{"error":"bad or missing bridge token"}');
  if (running) return res.writeHead(409, { 'Content-Type': 'application/json' })
    .end('{"error":"already running a turn"}');

  let body = '';
  for await (const c of req) {
    body += c;
    if (body.length > 1e6) return res.writeHead(413).end();
  }
  let payload = {};
  try { payload = JSON.parse(body || '{}'); } catch { return res.writeHead(400).end('{"error":"bad json"}'); }

  const prompt = String(payload.prompt || '').trim();
  if (!prompt) return res.writeHead(400, { 'Content-Type': 'application/json' })
    .end('{"error":"empty prompt"}');

  /* stream-json + partial messages is what makes this feel like the editor:
     text arrives token by token rather than in one lump at the end. */
  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
  if (payload.sessionId) args.push('--resume', String(payload.sessionId));
  if (payload.model) args.push('--model', String(payload.model));
  if (payload.effort) args.push('--effort', String(payload.effort));

  /* Everything below is a real Claude Code session flag, set per turn from the
     dashboard. Nothing here is invented — each one appears in `claude --help`. */

  /* MCP servers. Passed as a JSON string rather than a file so the dashboard
     can hold the config without writing to your disk. --strict-mcp-config keeps
     it to exactly what was sent, so a stale server in ~/.claude.json cannot
     join a session the UI says has none. */
  if (payload.mcp && String(payload.mcp).trim()) {
    let mcp = String(payload.mcp).trim();
    try {
      const parsed = JSON.parse(mcp);
      /* Accept either the full {mcpServers:{...}} envelope or just the inner
         map, because both are things people paste. */
      mcp = JSON.stringify(parsed.mcpServers ? parsed : { mcpServers: parsed });
    } catch {
      send('fatal', { error: 'MCP config is not valid JSON.' });
      running = null; return res.end();
    }
    args.push('--mcp-config', mcp, '--strict-mcp-config');
  }

  /* Plugin directories, repeatable. */
  for (const dir of (payload.pluginDirs || []).slice(0, 8)) {
    if (String(dir).trim()) args.push('--plugin-dir', String(dir).trim());
  }

  /* Extra directories Claude may touch beyond --dir. */
  for (const dir of (payload.addDirs || []).slice(0, 8)) {
    if (String(dir).trim()) args.push('--add-dir', String(dir).trim());
  }

  /* Custom subagents, as the JSON object the flag documents. */
  if (payload.agents && String(payload.agents).trim()) {
    try { JSON.parse(payload.agents); } catch {
      send('fatal', { error: 'Agents config is not valid JSON.' });
      running = null; return res.end();
    }
    args.push('--agents', String(payload.agents).trim());
  }

  if (payload.appendSystem && String(payload.appendSystem).trim()) {
    args.push('--append-system-prompt', String(payload.appendSystem).trim());
  }

  /* General settings, as the JSON string the flag accepts. */
  if (payload.settings && String(payload.settings).trim()) {
    try { JSON.parse(payload.settings); } catch {
      send('fatal', { error: 'Settings is not valid JSON.' });
      running = null; return res.end();
    }
    args.push('--settings', String(payload.settings).trim());
  }

  /* Skills are invoked as /skill-name inside the prompt, so they work by
     default; this only exists to turn them off. */
  if (payload.noSkills) args.push('--disable-slash-commands');

  /* Tool surface. An explicit list from the dashboard wins over this process's
     default, but only ever narrows what --write / --yolo already permit —
     the browser cannot widen its own permissions. */
  const asked = Array.isArray(payload.tools) ? payload.tools.filter(t => typeof t === 'string' && /^[A-Za-z]+$/.test(t)) : null;
  const permitted = ALLOWED_TOOLS;
  if (permitted) {
    const use = asked && asked.length ? asked.filter(t => permitted.includes(t)) : permitted;
    args.push('--allowed-tools', ...(use.length ? use : permitted));
  } else if (asked && asked.length) {
    args.push('--allowed-tools', ...asked);
  } else {
    args.push('--dangerously-skip-permissions');
  }

  /* Permission mode, but never an escalation: bypassPermissions from a browser
     on a read-only bridge would defeat the point of the bridge being read-only. */
  const MODES = ['plan', 'default', 'acceptEdits', 'dontAsk', 'auto'];
  if (payload.permissionMode && MODES.includes(payload.permissionMode)) {
    args.push('--permission-mode', payload.permissionMode);
  }

  args.push(prompt);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const child = spawn('claude', args, { cwd: CWD, shell: process.platform === 'win32' });
  running = child;

  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString();
    /* One JSON object per line. A partial line stays in the buffer. */
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { send('msg', JSON.parse(line)); }
      catch { send('raw', { text: line }); }
    }
  });
  child.stderr.on('data', c => send('stderr', { text: c.toString() }));

  child.on('error', err => {
    send('fatal', { error: err.code === 'ENOENT'
      ? 'The `claude` command was not found. Install Claude Code and make sure it is on PATH.'
      : err.message });
    running = null;
    res.end();
  });
  child.on('close', code => {
    send('done', { code });
    running = null;
    res.end();
  });

  /* res, not req. `req` emits 'close' as soon as the request body has been
     read — which with a JSON body parser is immediately — and killing the
     child there ended every turn before it produced a token. The response
     closing is what actually means the client went away. */
  res.on('close', () => { if (running === child) { child.kill('SIGTERM'); running = null; } });
});

server.listen(PORT, '127.0.0.1', () => {
  const w = flag('yolo') ? 'ALL TOOLS (yolo)' : flag('write') ? 'read + write + bash' : 'read-only';
  console.log('');
  console.log('  Claude bridge running');
  console.log('  ---------------------');
  console.log('  url        http://127.0.0.1:' + PORT);
  console.log('  directory  ' + CWD);
  console.log('  tools      ' + w);
  console.log('');
  console.log('  Paste this token into the dashboard once:');
  console.log('');
  console.log('      ' + TOKEN);
  console.log('');
  console.log('  Nothing leaves this machine except what Claude Code itself sends');
  console.log('  to Anthropic. The dashboard server never sees any of it.');
  console.log('');
});
