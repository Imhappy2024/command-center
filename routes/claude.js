/* Claude, when Command Center is running on your own machine.

   Same contract as tools/claude-bridge.mjs, mounted under /api/claude. When the
   dashboard is local there is no reason to run a second process: the server can
   spawn `claude -p` itself, and the browser talks to its own origin — no bridge,
   no token, no CORS, no mixed content.

   THIS NEVER MOUNTS ON A HOSTED DEPLOYMENT.

   That is the whole safety story. The Railway deployment runs AUTH_MODE=open —
   anyone with the URL can use it — and an endpoint that spawns a coding agent
   with filesystem access would hand every one of them a shell on the server.
   So it mounts only when nothing indicates a hosted environment, and the boot
   log says which way it went. To run it somewhere hosted anyway you have to set
   CLAUDE_LOCAL=1 deliberately, and you should not.

   Billing: Claude Code is a first-party client already signed in to your
   subscription, so turns are billed there rather than to API credits. Nothing
   here ever touches /v1/messages. */

import express from 'express';
import path from 'node:path';
import { spawnClaude, claudeOnce, resolveClaude, strippedBilling } from '../lib/claude-cli.js';

/* Hosted platforms all announce themselves. If any of these is set we are not
   on someone's laptop, and this router does not exist. */
const HOSTED_MARKERS = [
  'RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID',
  'RENDER', 'FLY_APP_NAME', 'DYNO', 'VERCEL', 'AWS_EXECUTION_ENV',
  'KUBERNETES_SERVICE_HOST', 'GOOGLE_CLOUD_PROJECT'
];

export function claudeIsLocal(env = process.env){
  if (env.CLAUDE_LOCAL === '0') return false;
  if (env.CLAUDE_LOCAL === '1') return true;
  return !HOSTED_MARKERS.some(k => env[k]);
}

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'];

export function claudeRoutes({ env, auth }){
  const r = express.Router();

  const CWD = path.resolve(env.CLAUDE_DIR || process.cwd());
  /* Read-only unless asked otherwise. Even locally, the dashboard is a web page,
     and a web page that can rewrite your repo by default is not a good default. */
  const writable = env.CLAUDE_WRITE === '1';
  const PERMITTED = env.CLAUDE_YOLO === '1' ? null
    : writable ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;

  let running = null;

  r.get('/api/claude/health', auth.require, (req, res) => {
    res.json({
      ok: true, authed: true, local: true, cwd: CWD,
      tools: PERMITTED ? PERMITTED.join(',') : 'all (yolo)',
      permitted: PERMITTED,
      writable: Boolean(writable || env.CLAUDE_YOLO === '1'),
      busy: Boolean(running),
      launch: resolveClaude(env).kind,
      /* Names any API-billing variable found in the environment and removed
         from the child, so "this bills to the subscription" is checkable. */
      strippedForBilling: strippedBilling(env)
    });
  });

  r.get('/api/claude/auth', auth.require, async (req, res) => {
    const out = await claudeOnce(['auth','status'], { cwd: CWD });
    if (!out.stdout) return res.json({ ok:false, error: out.error || out.stderr || 'auth status failed' });
    try { res.json({ ok:true, account: JSON.parse(out.stdout) }); }
    catch { res.json({ ok:true, raw: out.stdout }); }
  });

  r.get('/api/claude/plugins', auth.require, async (req, res) => {
    const out = await claudeOnce(['plugin','list'], { cwd: CWD });
    res.json({ ok: out.ok, text: out.stdout || out.stderr || '', error: out.error });
  });

  r.post('/api/claude/plugins', auth.require, express.json(), async (req, res) => {
    const verb = ['enable', 'disable'].includes(req.body?.action) ? req.body.action : null;
    /* Pattern-checked, never interpolated into a shell. */
    const name = /^[\w.@/-]{1,80}$/.test(String(req.body?.name || '')) ? String(req.body.name) : null;
    if (!verb || !name) return res.status(400).json({ error: 'need action enable|disable and a valid plugin name' });
    const out = await claudeOnce(['plugin', verb, name], { cwd: CWD, timeoutMs: 40_000 });
    res.json({ ok: out.ok, text: out.stdout || out.stderr || '', error: out.error });
  });

  r.get('/api/claude/mcp', auth.require, async (req, res) => {
    const out = await claudeOnce(['mcp','list'], { cwd: CWD, timeoutMs: 30_000 });
    res.json({ ok: out.ok, text: out.stdout || out.stderr || '', error: out.error });
  });

  r.post('/api/claude/stop', auth.require, (req, res) => {
    if (running) { running.kill('SIGTERM'); running = null; }
    res.json({ ok: true });
  });

  r.post('/api/claude/chat', auth.require, express.json({ limit: '1mb' }), (req, res) => {
    if (running) return res.status(409).json({ error: 'already running a turn' });
    const b = req.body || {};
    const prompt = String(b.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'empty prompt' });

    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
    if (b.sessionId) args.push('--resume', String(b.sessionId));
    if (b.model) args.push('--model', String(b.model));
    if (b.effort) args.push('--effort', String(b.effort));

    const bad = msg => { res.write(`event: fatal\ndata: ${JSON.stringify({ error: msg })}\n\n`); res.end(); running = null; };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    if (b.mcp && String(b.mcp).trim()) {
      try {
        const parsed = JSON.parse(String(b.mcp));
        args.push('--mcp-config', JSON.stringify(parsed.mcpServers ? parsed : { mcpServers: parsed }), '--strict-mcp-config');
      } catch { return bad('MCP config is not valid JSON.'); }
    }
    for (const d of (b.pluginDirs || []).slice(0, 8)) if (String(d).trim()) args.push('--plugin-dir', String(d).trim());
    for (const d of (b.addDirs || []).slice(0, 8)) if (String(d).trim()) args.push('--add-dir', String(d).trim());
    if (b.agents && String(b.agents).trim()) {
      try { JSON.parse(b.agents); args.push('--agents', String(b.agents).trim()); }
      catch { return bad('Agents config is not valid JSON.'); }
    }
    if (b.settings && String(b.settings).trim()) {
      try { JSON.parse(b.settings); args.push('--settings', String(b.settings).trim()); }
      catch { return bad('Settings is not valid JSON.'); }
    }
    if (b.appendSystem && String(b.appendSystem).trim()) args.push('--append-system-prompt', String(b.appendSystem).trim());
    if (b.noSkills) args.push('--disable-slash-commands');

    /* The browser may narrow the tool set but never widen it past what this
       process was started with. */
    const asked = Array.isArray(b.tools) ? b.tools.filter(t => typeof t === 'string' && /^[A-Za-z]+$/.test(t)) : null;
    if (PERMITTED) {
      const use = asked && asked.length ? asked.filter(t => PERMITTED.includes(t)) : PERMITTED;
      args.push('--allowed-tools', ...(use.length ? use : PERMITTED));
    } else if (asked && asked.length) {
      args.push('--allowed-tools', ...asked);
    } else {
      args.push('--dangerously-skip-permissions');
    }
    const MODES = ['plan', 'default', 'acceptEdits', 'dontAsk', 'auto'];
    if (b.permissionMode && MODES.includes(b.permissionMode)) args.push('--permission-mode', b.permissionMode);

    /* The prompt goes to stdin, not argv — see lib/claude-cli.js. */
    const child = spawnClaude(args, { cwd: CWD, prompt });
    running = child;

    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { send('msg', JSON.parse(line)); } catch { send('raw', { text: line }); }
      }
    });
    child.stderr.on('data', c => send('stderr', { text: c.toString() }));
    child.on('error', err => {
      send('fatal', { error: err.code === 'ENOENT'
        ? 'The `claude` command was not found. Install Claude Code and make sure it is on PATH.'
        : err.message });
      running = null; res.end();
    });
    child.on('close', code => { send('done', { code }); running = null; res.end(); });
    /* res, not req. `req` emits 'close' as soon as the request body has been
       read — which with a JSON body parser is immediately — and killing the
       child there ended every turn before it produced a token. The response
       closing is what actually means the client went away. */
    res.on('close', () => { if (running === child) { child.kill('SIGTERM'); running = null; } });
  });

  return r;
}
