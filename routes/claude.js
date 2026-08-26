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
import { dirFor, safeName, resolveStored, describeStorage } from '../lib/appdirs.js';
import fs from 'node:fs';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';

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

  /* ---- signing in and switching accounts ----------------------------------

     `claude auth login` prints an authorize URL, opens a browser, and starts a
     callback server on an ephemeral localhost port. So the flow completes on its
     own as long as the process stays alive -- which means this endpoint has to
     hold the child open and stream, not spawn-and-collect. (Learned the hard
     way: killing it early leaves the browser landing on a dead port.)

     The page also shows a code, for when the callback cannot be reached, so
     /auth/code exists to paste one into the waiting process's stdin.

     The link is handed to the browser rather than followed here. Signing in is
     the user's action -- the server should never be the one authenticating an
     account on their behalf. */

  let pendingLogin = null;

  r.post('/api/claude/auth/login', auth.require, express.json(), (req, res) => {
    if (pendingLogin) return res.status(409).json({ error: 'a sign-in is already waiting' });

    const b = req.body || {};
    const args = ['auth', 'login'];
    /* --console would bill to API credits, which is the opposite of the point,
       so it is not offered. */
    args.push('--claudeai');
    if (b.sso) args.push('--sso');
    if (typeof b.email === 'string' && /^[^\s@]{1,120}@[^\s@]{1,120}$/.test(b.email.trim())) {
      args.push('--email', b.email.trim());
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const child = spawnClaude(args, { cwd: CWD, prompt: null });
    pendingLogin = child;

    let buf = '', urlSent = false;
    const onText = chunk => {
      /* The CLI paints with ANSI. Strip it before matching or the URL comes
         back wrapped in escape codes. */
      const text = chunk.toString().replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '');
      buf += text;
      send('log', { text });
      if (!urlSent) {
        const m = buf.match(/https:\/\/[^\s'"]+oauth[^\s'"]*/i);
        if (m) { urlSent = true; send('url', { url: m[0] }); }
      }
    };
    child.stdout.on('data', onText);
    child.stderr.on('data', onText);

    /* Five minutes is generous for a browser round trip and short enough that a
       forgotten tab does not pin a child process forever. */
    const giveUp = setTimeout(() => {
      if (pendingLogin === child) { send('log', { text: '\nTimed out waiting for the browser.\n' }); child.kill('SIGTERM'); }
    }, 5 * 60_000);

    child.on('error', err => {
      clearTimeout(giveUp);
      send('fatal', { error: err.message });
      pendingLogin = null; res.end();
    });

    child.on('close', async code => {
      clearTimeout(giveUp);
      pendingLogin = null;
      /* Report what actually happened rather than trusting the exit code. */
      const after = await claudeOnce(['auth', 'status'], { cwd: CWD });
      let account = null;
      try { account = JSON.parse(after.stdout); } catch { /* leave null */ }
      send('done', { code, loggedIn: Boolean(account?.loggedIn), account });
      res.end();
    });

    /* Unlike a chat turn, this must NOT die when the browser navigates away --
       the callback server inside the child is what the OAuth redirect hits. */
    res.on('close', () => { /* deliberately empty */ });
  });

  r.post('/api/claude/auth/code', auth.require, express.json(), (req, res) => {
    if (!pendingLogin) return res.status(409).json({ error: 'no sign-in is waiting for a code' });
    const code = String(req.body?.code || '').trim();
    /* Whatever the page shows, it is an opaque token: accept a conservative
       character set and nothing whitespace-separated. */
    if (!/^[A-Za-z0-9._~#-]{8,512}$/.test(code)) return res.status(400).json({ error: 'that does not look like an authorization code' });
    pendingLogin.stdin.write(code + '\n');
    res.json({ ok: true });
  });

  r.post('/api/claude/auth/cancel', auth.require, (req, res) => {
    if (pendingLogin) { pendingLogin.kill('SIGTERM'); pendingLogin = null; }
    res.json({ ok: true });
  });

  r.post('/api/claude/auth/logout', auth.require, async (req, res) => {
    if (pendingLogin) { pendingLogin.kill('SIGTERM'); pendingLogin = null; }
    const out = await claudeOnce(['auth', 'logout'], { cwd: CWD, timeoutMs: 30_000 });
    const after = await claudeOnce(['auth', 'status'], { cwd: CWD });
    let account = null;
    try { account = JSON.parse(after.stdout); } catch { /* leave null */ }
    res.json({ ok: out.ok, text: out.stdout || out.stderr || '', loggedIn: Boolean(account?.loggedIn) });
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

  /* ---- connectors (MCP) ---------------------------------------------------

     `claude mcp list` prints one line per server:

       claude.ai Front: https://mcp.frontapp.com/mcp - ✓ Connected

     Parsed into rows so the UI can group and act on them rather than showing a
     wall of terminal output. The name is everything before the last colon that
     precedes a URL, because the names themselves contain colons and spaces. */
  /* `claude mcp list` prints two different shapes, and a parser that only knows
     one of them silently drops the other -- which is exactly what happened: a
     server added from this page never appeared, so adding looked broken when it
     had worked.

       claude.ai Front: https://mcp.frontapp.com/mcp - ✓ Connected
       cctest: https://example.com/mcp (HTTP) - ✗ Failed to connect

     Parsed from the right rather than the left: the status follows the last
     " - ", an optional "(HTTP)" transport marker sits before it, and only then
     is the remainder split into name and target. Splitting on the first colon
     would cut "https" off the URL. */
  function parseMcpList(text){
    const rows = [];
    for (const raw of String(text || '').split('\n')) {
      const line = raw.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '').trim();
      if (!line || /^Checking MCP server health/i.test(line) || !line.includes(':')) continue;

      const cut = line.lastIndexOf(' - ');
      if (cut < 0) continue;
      const status = line.slice(cut + 3).trim();
      let left = line.slice(0, cut).trim();

      let transport = '';
      const tm = /\s\(([A-Za-z]+)\)$/.exec(left);
      if (tm) { transport = tm[1].toLowerCase(); left = left.slice(0, tm.index).trim(); }

      const c = left.indexOf(': ');
      if (c < 0) continue;
      const name = left.slice(0, c).trim();
      const target = left.slice(c + 2).trim();
      if (!name || !target) continue;

      rows.push({
        name, url: target, transport,
        state: /connected/i.test(status) && !/not/i.test(status) ? 'connected'
             : /auth/i.test(status) ? 'needs-auth'
             : /fail/i.test(status) ? 'failed' : 'unknown',
        status,
        /* claude.ai-prefixed servers come from the account rather than a local
           config, which is why they cannot be removed from here. */
        source: /^claude\.ai\b/.test(name) ? 'account' : 'local'
      });
    }
    return rows;
  }

  r.get('/api/claude/mcp', auth.require, async (req, res) => {
    const out = await claudeOnce(['mcp', 'list'], { cwd: CWD, timeoutMs: 60_000 });
    const servers = parseMcpList(out.stdout || out.stderr || '');
    res.json({
      ok: out.ok || servers.length > 0,     // a failed health check still lists servers
      servers,
      counts: {
        total: servers.length,
        connected: servers.filter(s2 => s2.state === 'connected').length,
        needsAuth: servers.filter(s2 => s2.state === 'needs-auth').length,
        failed: servers.filter(s2 => s2.state === 'failed').length
      },
      text: out.stdout || out.stderr || '',
      error: out.error,
      /* Measured, not assumed: `claude mcp list` reports a health check, and a
         healthy server is NOT the same as one a turn can use. On this build a
         headless `claude -p` run registers MCP servers as "pending" and ends up
         with no mcp__ tools at all -- with the account connectors, with a local
         config, and with an explicit --mcp-config. So the panel must not imply
         Claude can reach these from here. */
      usableInTurns: false
    });
  });

  r.post('/api/claude/mcp', auth.require, express.json(), async (req, res) => {
    const action = req.body?.action;
    const name = String(req.body?.name || '').trim();
    /* Server names go into argv, never a shell -- but keep them boring anyway. */
    if (!/^[\w .@:-]{1,80}$/.test(name)) return res.status(400).json({ error: 'that is not a valid server name' });

    if (action === 'remove') {
      const out = await claudeOnce(['mcp', 'remove', name], { cwd: CWD, timeoutMs: 40_000 });
      return res.json({ ok: out.ok, text: out.stdout || out.stderr || '', error: out.error });
    }
    if (action === 'add') {
      const url = String(req.body?.url || '').trim();
      /* http(s) only. A local stdio server would mean running an arbitrary
         command on this machine from a web page, which is not a thing this
         endpoint is going to offer. */
      if (!/^https:\/\/[\w.-]+(:\d+)?(\/\S*)?$/.test(url)) {
        return res.status(400).json({ error: 'need an https URL. Local command servers must be added with the CLI.' });
      }
      const transport = req.body?.transport === 'sse' ? 'sse' : 'http';
      const out = await claudeOnce(['mcp', 'add', '--transport', transport, name, url], { cwd: CWD, timeoutMs: 60_000 });
      return res.json({ ok: out.ok, text: out.stdout || out.stderr || '', error: out.error });
    }
    res.status(400).json({ error: 'need action add|remove' });
  });

  /* ---- custom instructions -----------------------------------------------

     Claude Code reads CLAUDE.md as standing instructions: ~/.claude/CLAUDE.md
     applies everywhere, and one in the working directory applies to this project.
     So this edits those files rather than inventing a settings field -- the same
     reasoning as the session history. Instructions written here apply to the CLI
     and the editor extension too, which is usually what someone wants and always
     worth saying out loud.

     Distinct from the per-message system-prompt suffix in Settings: that one
     lasts a single turn, these persist. */

  const INSTRUCTION_LIMIT = 256 * 1024;

  function instructionFile(scope){
    if (scope === 'user') return path.join(os.homedir(), '.claude', 'CLAUDE.md');
    if (scope === 'project') return path.join(CWD, 'CLAUDE.md');
    return null;
  }

  function readInstruction(scope){
    const file = instructionFile(scope);
    let text = '', exists = false, bytes = 0;
    try {
      const st = fs.statSync(file);
      exists = st.isFile();
      bytes = st.size;
      /* Refuse to load something enormous into a textarea rather than hanging
         the page trying. */
      text = bytes <= INSTRUCTION_LIMIT ? fs.readFileSync(file, 'utf8') : '';
    } catch { /* not written yet, which is the normal case */ }
    return { scope, path: file, exists, bytes, text, tooBig: bytes > INSTRUCTION_LIMIT };
  }

  r.get('/api/claude/instructions', auth.require, (req, res) => {
    res.json({
      ok: true,
      user: readInstruction('user'),
      project: readInstruction('project'),
      note: 'CLAUDE.md is read by Claude Code itself, so these apply to the CLI and the editor extension as well.'
    });
  });

  r.put('/api/claude/instructions', auth.require, express.json({ limit: '1mb' }), (req, res) => {
    const scope = req.body?.scope;
    const file = instructionFile(scope);
    if (!file) return res.status(400).json({ error: 'scope must be user or project' });

    const text = String(req.body?.text ?? '');
    if (text.length > INSTRUCTION_LIMIT) return res.status(413).json({ error: 'that is larger than 256 KB' });

    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      /* Keep one backup before overwriting. These are hand-written instructions
         that may have taken a while to get right, and a web textarea is exactly
         the sort of place they get wiped by accident. */
      if (fs.existsSync(file)) {
        try { fs.copyFileSync(file, file + '.bak'); } catch { /* best effort */ }
      }
      fs.writeFileSync(file, text, 'utf8');
      res.json({ ok: true, ...readInstruction(scope) });
    } catch (err) {
      res.status(500).json({ error: 'could not write ' + file + ': ' + err.message });
    }
  });

  /* ---- skills -------------------------------------------------------------

     Claude Code loads skills from disk, not from the account: the Skills list in
     the Claude desktop app is a different set and does not appear here. Read the
     directories it actually reads, so this reflects what a turn can invoke. */
  function readSkills(){
    const roots = [
      { dir: path.join(os.homedir(), '.claude', 'skills'), scope: 'personal' },
      { dir: path.join(CWD, '.claude', 'skills'), scope: 'project' }
    ];
    const out = [];
    const seen = new Set();
    for (const { dir, scope } of roots) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || seen.has(e.name)) continue;
        seen.add(e.name);
        const skill = { name: e.name, scope, description: '', path: path.join(dir, e.name) };
        try {
          const md = fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8');
          /* Frontmatter description, which may be a folded YAML block. */
          const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
          if (fm) {
            const d = /description:\s*(?:>|\|)?\s*\r?\n?([\s\S]*?)(?:\r?\n[a-z_]+:|$)/i.exec(fm[1]);
            if (d) skill.description = d[1].split('\n').map(l => l.trim()).join(' ').trim().slice(0, 400);
          }
        } catch { /* a skill without a readable SKILL.md still exists */ }
        out.push(skill);
      }
    }
    return out.sort((a2, b2) => a2.name.localeCompare(b2.name));
  }

  r.get('/api/claude/skills', auth.require, (req, res) => {
    try {
      const skills = readSkills();
      res.json({
        ok: true, skills,
        roots: {
          personal: path.join(os.homedir(), '.claude', 'skills'),
          project: path.join(CWD, '.claude', 'skills')
        },
        /* Worth stating plainly in the UI: these are not the account's skills. */
        note: 'Claude Code loads skills from disk. Skills configured in the Claude apps are a separate set.'
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* ---- chat history -------------------------------------------------------

     Claude Code already keeps every session on disk, so this reads those rather
     than inventing a second store. Two things follow, and both are the point:
     history here is the same history as the CLI and the VS Code extension, and
     nothing has to be migrated or kept in sync.

     Layout is ~/.claude/projects/<encoded cwd>/<session-id>.jsonl, one JSON
     record per line. The directory name is the working directory with every
     character that is not a letter or digit replaced by a hyphen -- checked
     against the real directories on disk rather than assumed. */

  function projectDirFor(cwd){
    const encoded = String(cwd).replace(/[^A-Za-z0-9]/g, '-');
    const base = path.join(os.homedir(), '.claude', 'projects');
    const guess = path.join(base, encoded);
    if (fs.existsSync(guess)) return guess;
    /* The encoding could change. Fall back to asking the transcripts where they
       came from, which is authoritative. */
    try {
      for (const d of fs.readdirSync(base, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const dir = path.join(base, d.name);
        const first = fs.readdirSync(dir).find(f => f.endsWith('.jsonl'));
        if (!first) continue;
        const head = fs.readFileSync(path.join(dir, first), 'utf8').slice(0, 8000).split('\n');
        for (const line of head) {
          try {
            const rec = JSON.parse(line);
            if (rec.cwd && path.resolve(rec.cwd) === path.resolve(cwd)) return dir;
          } catch { /* not every line is a record we can read */ }
        }
      }
    } catch { /* no projects directory yet */ }
    return guess;
  }

  /* First user prompt makes the title, the way every chat client does it. */
  function summarise(file){
    const out = { title: '', prompts: 0, lastAt: null, model: null };
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.timestamp) out.lastAt = rec.timestamp;
      if (rec.type === 'user' && rec.message) {
        const c = rec.message.content;
        const str = typeof c === 'string' ? c
          : Array.isArray(c) ? c.map(b => (typeof b === 'string' ? b : b.text || '')).join(' ') : '';
        const clean = str.replace(/\s+/g, ' ').trim();
        /* Skip the synthetic frames: tool results and interrupt notices arrive
           as user records too, and neither is something anybody typed. */
        if (clean && !/^(<|\[Request interrupted)/.test(clean)) {
          out.prompts++;
          if (!out.title) out.title = clean.slice(0, 120);
        }
      }
      if (rec.type === 'assistant' && rec.message?.model && !out.model) out.model = rec.message.model;
    }
    return out;
  }

  r.get('/api/claude/sessions', auth.require, (req, res) => {
    const dir = projectDirFor(CWD);
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); }
    catch { return res.json({ ok: true, sessions: [], dir, note: 'no history yet' }); }

    const sessions = [];
    for (const f of files) {
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const info = summarise(full);
      /* A transcript with no real prompt in it is a session that never got off
         the ground -- showing it would just be noise in the list. */
      if (!info.prompts) continue;
      sessions.push({
        id: path.basename(f, '.jsonl'),
        title: info.title || 'Untitled',
        prompts: info.prompts,
        model: info.model,
        updated: (info.lastAt || st.mtime.toISOString()),
        bytes: st.size
      });
    }
    sessions.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    res.json({ ok: true, sessions, dir, cwd: CWD });
  });

  /* The transcript itself, so opening a past chat shows what was said rather
     than an empty pane with a session id attached. */
  r.get('/api/claude/sessions/:id', auth.require, (req, res) => {
    if (!/^[0-9a-fA-F-]{8,64}$/.test(req.params.id)) return res.status(400).json({ error: 'not a session id' });
    const file = path.join(projectDirFor(CWD), req.params.id + '.jsonl');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'no transcript for that session' });

    const messages = [];
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { return res.status(500).json({ error: err.message }); }

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type !== 'user' && rec.type !== 'assistant') continue;
      const c = rec.message?.content;
      const blocks = Array.isArray(c) ? c : (typeof c === 'string' ? [{ type: 'text', text: c }] : []);

      let bodyText = '';
      const steps = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) bodyText += (bodyText ? '\n' : '') + b.text;
        else if (b.type === 'thinking' && b.thinking) steps.push({ kind: 'thinking', name: 'Thinking', body: b.thinking });
        else if (b.type === 'tool_use') {
          const detail = b.input?.file_path || b.input?.pattern || b.input?.command || b.input?.url || '';
          let body = '';
          try { body = JSON.stringify(b.input, null, 2); } catch { /* unserialisable input */ }
          steps.push({ kind: 'tool', id: b.id, name: b.name, detail: String(detail).slice(0, 140), body });
        } else if (b.type === 'tool_result') {
          /* Attach to whichever step asked, so the row can be opened. */
          const step = messages.flatMap(m => m.steps || []).find(t => t.id === b.tool_use_id);
          const out = Array.isArray(b.content) ? b.content.map(x => x.text || '').join('\n')
                    : (typeof b.content === 'string' ? b.content : '');
          if (step) step.body = (step.body ? step.body + '\n\n— result —\n' : '') + out;
        }
      }
      const interrupted = /^\[Request interrupted/.test(bodyText);
      if (!bodyText && !steps.length) continue;
      if (rec.type === 'user' && interrupted) continue;
      messages.push({ role: rec.type === 'user' ? 'user' : 'assistant', text: bodyText, steps, at: rec.timestamp });
    }

    res.json({ ok: true, id: req.params.id, messages });
  });

  /* Deleting a chat deletes Claude Code's transcript, because that store is the
     history -- there is no private copy to remove instead. Worth being plain
     about in the UI: the chat also disappears from the CLI and the editor
     extension, since all three read the same directory.

     The id is checked against the file that is actually there rather than
     trusted into a path. */
  r.delete('/api/claude/sessions/:id', auth.require, (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return res.status(400).json({ error: 'not a session id' });

    const dir = projectDirFor(CWD);
    const file = path.join(dir, id + '.jsonl');
    /* path.join with a checked id cannot escape, but assert it anyway: this
       deletes a file, and the cost of being wrong is somebody's history. */
    if (path.dirname(file) !== dir) return res.status(400).json({ error: 'not a session id' });
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'that chat is already gone' });

    /* Refuse while a turn is in flight -- Claude Code has the file open and is
       still appending to it. */
    if (running) return res.status(409).json({ error: 'a turn is running; stop it first' });

    try {
      fs.unlinkSync(file);
      res.json({ ok: true, id });
    } catch (err) {
      res.status(500).json({ error: 'could not delete it: ' + err.message });
    }
  });

  /* ---- attachments --------------------------------------------------------

     Raw body with the name in a header, rather than multipart: there is no
     multipart parser in this project and adding one to accept a single file
     would be the largest dependency in it. The browser sends the File as the
     body, which fetch does natively. */
  r.post('/api/claude/files', auth.require, async (req, res) => {
    const kind = req.query.kind === 'uploads' ? 'uploads' : 'attachments';
    const declared = Number(req.headers['content-length'] || 0);
    const LIMIT = 64 * 1024 * 1024;
    if (declared > LIMIT) return res.status(413).json({ error: 'that file is over 64 MB' });

    let dir, dest;
    try {
      dir = dirFor(kind, env);
      dest = path.join(dir, safeName(req.headers['x-filename'] || 'file'));
    } catch (err) { return res.status(500).json({ error: 'cannot write to storage: ' + err.message }); }

    try {
      /* No byte counter on the request stream: attaching a data listener puts it
         into flowing mode and the first chunks are discarded before pipeline()
         attaches. Learned that the hard way on the OpusClip upload. */
      await pipeline(req, fs.createWriteStream(dest));
      const size = fs.statSync(dest).size;
      if (size > LIMIT) { fs.unlinkSync(dest); return res.status(413).json({ error: 'that file is over 64 MB' }); }
      res.json({ ok: true, name: path.basename(dest), path: dest, size, kind });
    } catch (err) {
      try { fs.unlinkSync(dest); } catch { /* nothing to clean */ }
      res.status(500).json({ error: err.message });
    }
  });

  r.get('/api/claude/files', auth.require, (req, res) => {
    res.json({ ok: true, storage: describeStorage(env) });
  });

  /* Serving an attachment back is how the composer shows a thumbnail of what you
     just pasted. Only files this app wrote, only by bare name. */
  r.get('/api/claude/files/:kind/:name', auth.require, (req, res) => {
    const kind = ['attachments', 'uploads', 'clips'].includes(req.params.kind) ? req.params.kind : null;
    if (!kind) return res.status(404).json({ error: 'not found' });
    const full = resolveStored(kind, req.params.name, env);
    if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
    res.sendFile(full);
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

    /* Streaming input, not one-shot -p.

       This is what makes MCP work. A `-p` run registers its MCP servers and then
       exits before any of them finish connecting: measured on the session's own
       init frame they sit at status "pending", and the turn ends with zero mcp__
       tools whether the servers come from the account, a local config, or an
       explicit --mcp-config. A streaming session stays alive long enough for them
       to attach, and then a turn really can call
       mcp__claude_ai_Front__get_my_identity and get an answer back.

       The cost is that stdin becomes a protocol rather than a pipe: the prompt
       goes as one JSON line, and the turn is over when a `result` frame lands. */
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json',
                  '--include-partial-messages', '--verbose'];
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
    /* mcp__server and mcp__server__tool are legal tool names, and the old
       /^[A-Za-z]+$/ silently dropped every one of them -- which is why the
       account's connectors were attached to Claude Code and still unusable
       here. Underscores and digits allowed; nothing else, so nothing can smuggle
       a flag through. */
    const asked = Array.isArray(b.tools)
      ? b.tools.filter(t => typeof t === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,120}$/.test(t))
      : null;

    /* Connectors are opt-in per turn. They are not read-only -- the list includes
       Gmail, GHL and Supabase, so an unlucky prompt could send mail or run SQL.
       One deliberate switch is worth more than having it on by default.

       `claude.ai Front` is exposed as mcp__claude_ai_Front__<tool>, and naming a
       server allows every tool it offers. */
    const mcpAllow = b.useMcp && Array.isArray(b.mcpServers)
      ? b.mcpServers
          .filter(n => typeof n === 'string')
          .map(n => 'mcp__' + n.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, ''))
          .filter(n => /^mcp__[A-Za-z0-9_]{1,120}$/.test(n))
          .slice(0, 40)
      : [];
    if (PERMITTED) {
      const use = asked && asked.length ? asked.filter(t => PERMITTED.includes(t)) : PERMITTED;
      args.push('--allowed-tools', ...(use.length ? use : PERMITTED), ...mcpAllow);
    } else if (asked && asked.length) {
      args.push('--allowed-tools', ...asked, ...mcpAllow);
    } else {
      args.push('--dangerously-skip-permissions');
    }
    const MODES = ['plan', 'default', 'acceptEdits', 'dontAsk', 'auto'];
    if (b.permissionMode && MODES.includes(b.permissionMode)) args.push('--permission-mode', b.permissionMode);

    /* The prompt goes to stdin, not argv — see lib/claude-cli.js. */
    /* stdin stays open: in streaming mode closing it ends the session, and the
       process has to outlive the write for the MCP servers to attach. */
    const child = spawnClaude(args, { cwd: CWD, prompt: null, keepStdin: true });
    running = child;

    child.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] }
    }) + '\n');

    let buf = '';
    let finished = false;
    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame = null;
        try { frame = JSON.parse(line); } catch { send('raw', { text: line }); continue; }
        send('msg', frame);
        /* A `result` frame ends the turn. Nothing more is coming, and the session
           would otherwise wait for another message forever. */
        if (frame.type === 'result' && !finished) {
          finished = true;
          try { child.stdin.end(); } catch { /* already gone */ }
          setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* exited */ } }, 1500);
        }
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
