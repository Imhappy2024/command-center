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
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AGENTS } from '../lib/agent-briefs.js';
import { pipeline } from 'node:stream/promises';
import { query } from '../db/index.js';
import { runNow, providerFamily, pollerStatus } from '../lib/social-sync.js';
/* summariseMetrics, not summarise: claudeRoutes() declares its own summarise()
   for session titles, and a function declaration inside that closure shadows a
   module import silently. The pull stored session-title fields as its metrics
   summary for a whole run before a comparison test noticed. */
import { compact, summarise as summariseMetrics, compare, agoLabel } from '../lib/agent-metrics.js';
import { HOMMIE, HOMMIE_META } from '../lib/hommie-brief.js';
import { execFile } from 'node:child_process';

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

/* Tools that cannot work on this surface, whatever the permission settings say.

   AskUserQuestion is the interactive question widget. A stream-json session has
   no terminal to draw it in and no channel to answer it on, so the call fails
   and the turn stops -- which is what the "connectors are connected but Claude
   cannot access them" report actually was: the connector calls had succeeded,
   and the widget failing straight afterwards ended the turn before the work.

   --allowed-tools would not have stopped it. That flag auto-approves; it does
   not remove. A tool left off the list still exists and simply asks permission,
   and asking permission in a headless run is the same thing as failing. Only
   --disallowed-tools takes the tool out of Claude's hands, which turns the
   question into plain text the chat can actually render. */
const IMPOSSIBLE_HERE = ['AskUserQuestion'];

/* The widget itself is not gone, only the built-in one. tools/ask-mcp.mjs is
   attached to every turn as an MCP server offering the same thing through a
   channel this surface actually has, and this is where Claude is told to use it.

   Saying so matters as much as providing it: the CLAUDE.md files on this machine
   name AskUserQuestion directly, so without this Claude keeps reaching for a
   tool that is no longer there and falls back to prose. */
const ASK_SERVER = 'command_center';
const ASK_TOOL = 'mcp__' + ASK_SERVER + '__ask_user';
const ASK_SCRIPT = fileURLToPath(new URL('../tools/ask-mcp.mjs', import.meta.url));

/* The analyst agents get a second tool server: the one that reads this app's
   metrics and draws tables and video into the panel beside the chat. It is
   attached only on an agent turn, so an ordinary Claude conversation is not
   handed six tools it has no use for. */
const AGENT_SERVER = 'command_center_agent';
const AGENT_SCRIPT = fileURLToPath(new URL('../tools/agent-mcp.mjs', import.meta.url));

/* Hommie gets its own server rather than a bigger version of the analysts'.
   The analysts are locked to one platform each and that lock is the point of
   them; Hommie reads everything and can act, so mixing the two would mean the
   YouTube analyst inheriting a tool that can push to GitHub. */
const HOMMIE_SERVER = 'hommie';
const HOMMIE_SCRIPT = fileURLToPath(new URL('../tools/hommie-mcp.mjs', import.meta.url));

/* Repair mode needs a shell and an editor. They are added to the permitted set
   only for a turn the user has armed from the browser, and never otherwise --
   a voice assistant that can run bash on a misheard sentence is not something
   to leave switched on. */
const REPAIR_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite'];

const SURFACE_NOTE = [
  'You are running inside the Command Center dashboard, in a chat panel in a web page,',
  'not a terminal. The built-in AskUserQuestion tool does not work here and has been',
  'removed. The interactive question widget on this surface is the tool ' + ASK_TOOL + ':',
  'it renders your options as buttons in this chat and returns what the user picked.',
  'Call it exactly where you would have called AskUserQuestion, and read any standing',
  'instruction about asking with tappable options or an interactive widget as meaning',
  'that tool. Ask everything you need in one call rather than several. The user can',
  'always type a free-text answer, so never add your own "Other" option. If the tool',
  'is genuinely unavailable, write the question and numbered options as plain text and',
  'end your turn.'
].join(' ');

/* Only appended on a turn the user has armed. It is written as a procedure
   rather than a permission, because the failure mode of a self-healing agent is
   not refusing to act -- it is acting confidently on a diagnosis it never
   checked, and shipping that. */
const REPAIR_NOTE = [
  '# Repair mode is on',
  '',
  'You can read and change the code of this dashboard, run its tests, commit and',
  'push. Pushing deploys. Work in this order and do not skip a step:',
  '',
  '1. **Reproduce before you diagnose.** Call repair_check first, every time. If',
  '   it passes, the thing the user is describing is not a parse or boot error and',
  '   guessing at a file will waste both your time and theirs. Ask what they saw.',
  '2. **Look before you touch.** repair_status says what is already changed. Some',
  '   of it may not be yours, and sweeping someone else\'s work into your commit is',
  '   worse than the bug.',
  '3. **Read the actual code.** Read the file. Do not infer what it says from the',
  '   error and edit blind.',
  '4. **The smallest change that fixes it.** Not a refactor, not a tidy-up. One',
  '   cause, one fix.',
  '5. **repair_check again.** A change that has not been preflighted has not been',
  '   tested. If it fails, read the output and fix it; do not ship and hope.',
  '6. **Say what you are shipping and get a yes** before repair_ship. Name the',
  '   files and the one-line reason. repair_ship runs the preflight again itself',
  '   and refuses on a failure, so it cannot be talked past.',
  '7. **Wait, then verify.** Give the deploy about two minutes, then repair_live',
  '   with the SHA. If it is still on the old commit, wait and check again --',
  '   do not push anything else at it.',
  '',
  'If you cannot find the cause, say so. "I could not work out what is wrong, here',
  'is what I ruled out" is a real answer and a wrong fix shipped confidently is not.',
  'Never change a file to make a test pass when the test is right.',
  '',
  'Out loud, this is all one or two sentences at a time: what you are checking,',
  'what you found, what you want to do. Not a running commentary.'
].join('\n');

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

  /* ---- the question channel ------------------------------------------------

     One turn runs at a time, so one channel exists at a time: a token the ask
     server proves itself with, the live SSE writer that puts the question on
     screen, and the questions still waiting for an answer.

     A question outlives the tool call that made it only in the sense that the
     HTTP request answering it is a different request from the one asking. The
     ask server long-polls instead of holding one open request for as long as a
     person takes to decide, because undici times a fetch out after five minutes
     and people take longer than that. */
  let ask = null;

  const askCancelAll = why => {
    if (!ask) return;
    for (const q of ask.pending.values()) {
      if (q.state !== 'pending') continue;
      q.state = 'cancelled';
      q.why = why;
      q.waiters.splice(0).forEach(fn => fn());
    }
  };

  /* Loopback only, and only with this turn's token. The ask server is a child of
     this process; nothing else has any business here. */
  const askCaller = req => {
    if (!ask) return false;
    const ip = String(req.socket.remoteAddress || '');
    if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(ip)) return false;
    /* Either header. Both tool servers are spawned by this turn and carry the
       same token; they just name it after themselves, and reading only one of
       the two names cost an agent turn that failed four tool calls with "not
       this turn" and then apologised to the user for a connection problem that
       did not exist. */
    const given = String(req.get('x-ask-token') || req.get('x-agent-token') || '');
    if (given.length !== ask.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ask.token));
  };

  /* Called by the ask server when Claude wants to ask something. Returns as soon
     as the question is on screen; the answer is collected by polling. */
  r.post('/api/claude/ask', express.json({ limit: '256kb' }), (req, res) => {
    if (!askCaller(req)) return res.status(403).json({ error: 'not this turn' });
    const questions = Array.isArray(req.body?.questions) ? req.body.questions.slice(0, 4) : [];
    if (!questions.length) return res.status(400).json({ error: 'no questions' });

    /* Shaped here rather than trusted: this text goes straight into the page. */
    const clean = questions.map(q => ({
      question: String(q?.question || '').slice(0, 400),
      header: String(q?.header || '').slice(0, 24),
      multiSelect: Boolean(q?.multiSelect),
      options: (Array.isArray(q?.options) ? q.options : []).slice(0, 4).map(o => ({
        label: String(o?.label || '').slice(0, 120),
        description: String(o?.description || '').slice(0, 300)
      })).filter(o => o.label)
    })).filter(q => q.question && q.options.length >= 2);
    if (!clean.length) return res.status(400).json({ error: 'no usable questions' });

    const id = crypto.randomUUID();
    ask.pending.set(id, { id, questions: clean, state: 'pending', answers: null, waiters: [] });
    try { ask.send('ask', { id, questions: clean }); } catch { /* the page went away */ }
    res.json({ id, state: 'pending' });
  });

  /* The ask server's long poll. Holds for waitMs and then says "still pending",
     which keeps the request short enough never to hit a client timeout and makes
     a dead parent obvious within one poll. */
  r.post('/api/claude/ask/poll', express.json({ limit: '16kb' }), (req, res) => {
    if (!askCaller(req)) return res.status(403).json({ error: 'not this turn' });
    const q = ask.pending.get(String(req.body?.id || ''));
    if (!q) return res.json({ state: 'cancelled' });

    const reply = () => res.json(q.state === 'answered'
      ? { state: 'answered', answers: q.answers, freeText: q.freeText || undefined }
      : { state: q.state });
    if (q.state !== 'pending') return reply();

    const wait = Math.min(30_000, Math.max(1000, Number(req.body?.waitMs) || 20_000));
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); reply(); };
    const timer = setTimeout(() => { if (!done) { done = true; res.json({ state: 'pending' }); } }, wait);
    q.waiters.push(finish);
    res.on('close', () => { done = true; clearTimeout(timer); });
  });

  /* ---- the agent surface ------------------------------------------------

     Same token and the same loopback rule as the ask channel: these are called
     by a tool server this process spawned for the turn in flight, and by
     nothing else. */

  /* Draw something in the panel beside the conversation. Fire and forget -- the
     agent does not wait for a human here, it just puts a table on screen. */
  r.post('/api/claude/agent/show', express.json({ limit: '1mb' }), (req, res) => {
    if (!askCaller(req)) return res.status(403).json({ error: 'not this turn' });
    const panel = req.body?.panel;
    if (!panel || typeof panel !== 'object') return res.status(400).json({ error: 'no panel' });
    try {
      ask.send('panel', { id: crypto.randomUUID(), at: Date.now(), ...panel });
    } catch { /* the page went away mid-turn */ }
    res.json({ ok: true });
  });

  /* Read something. The kinds are enumerated rather than proxying an arbitrary
     path: a tool server that can fetch any URL on this origin is a tool server
     that can read the whole app. */
  r.post('/api/claude/agent/data', express.json({ limit: '64kb' }), async (req, res) => {
    if (!askCaller(req)) return res.status(403).json({ error: 'not this turn' });
    const b = req.body || {};
    const base = 'http://127.0.0.1:' + (req.socket.localPort || env.PORT || 3000);
    const inner = async (method, path, body) => {
      const r2 = await fetch(base + path, {
        method,
        headers: {
          /* The user's own session. Nothing here elevates anything. */
          ...(ask.cookie ? { cookie: ask.cookie } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const t = await r2.text();
      let j = null; try { j = JSON.parse(t); } catch { /* raw */ }
      if (!r2.ok) throw Object.assign(new Error((j && j.error) || ('inner ' + r2.status)), { status: r2.status });
      return j || {};
    };

    try {
      if (b.kind === 'platform') {
        const key = String(b.platform || '');
        if (!['youtube', 'facebook', 'instagram', 'x', 'meta_ads'].includes(key)) {
          return res.status(400).json({ error: 'unknown platform: ' + key });
        }
        if (ask.platform && key !== ask.platform) {
          return res.status(403).json({
            error: 'This agent reads ' + ask.platform + ' only. ' + key
              + ' belongs to a different agent in the same menu.'
          });
        }
        const range = [7, 28, 90].includes(Number(b.range)) ? Number(b.range) : 28;
        return res.json(await inner('GET', '/api/social/platform/' + key + '?range=' + range));
      }
      if (b.kind === 'clips') {
        return res.json(await inner('GET', '/api/systems'));
      }
      /* What the agent said to do, in its own words, so the next pull can ask
         whether it happened. Recorded by the agent rather than parsed out of its
         prose: "was this followed" needs a claim with an edge on it, and prose
         does not have one. */
      if (b.kind === 'record_actions') {
        const items = (Array.isArray(b.actions) ? b.actions : []).slice(0, 12)
          .map(a => ({
            headline: String(a?.headline || '').slice(0, 300),
            detail: a?.detail ? String(a.detail).slice(0, 2000) : null,
            metric: a?.metric ? String(a.metric).slice(0, 120) : null,
            target: a?.target ? String(a.target).slice(0, 300) : null
          })).filter(a => a.headline);
        if (!items.length) return res.status(400).json({ error: 'no actions to record' });
        for (const a of items) {
          await query(
            'INSERT INTO agent_actions (id, agent, pull_id, thread_id, headline, detail, metric, target)'
            + ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [crypto.randomUUID(), ask.agentId || 'unknown', ask.pullId || null,
              ask.threadId || null, a.headline, a.detail, a.metric, a.target]);
        }
        return res.json({ recorded: items.length,
          note: 'Stored. The next pull hands these back to you with the numbers that '
            + 'moved since, so you can say whether they were acted on.' });
      }
      /* Writing a video's packaging back. YouTube only. The schema does not
         offer this to any other agent, and the platform is checked here as well,
         because a schema is a suggestion to a model and this is a change to a
         live channel. */
      if (b.kind === 'update_video' || b.kind === 'read_video') {
        if (ask.platform !== 'youtube') {
          return res.status(403).json({ error: 'Only the YouTube agent can touch a video.' });
        }
        const id = String(b.videoId || '').trim();
        if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
          return res.status(400).json({ error: 'that is not a YouTube video id' });
        }
        if (b.kind === 'read_video') {
          return res.json(await inner('GET', '/api/social/youtube/video/' + id));
        }
        const body = {};
        if (typeof b.title === 'string') body.title = b.title;
        if (typeof b.description === 'string') body.description = b.description;
        if (Array.isArray(b.tags)) body.tags = b.tags;
        if (!Object.keys(body).length) return res.status(400).json({ error: 'nothing to change' });
        return res.json(await inner('POST', '/api/social/youtube/video/' + id, body));
      }
      if (b.kind === 'create_clip') {
        /* The clip route takes videoUrl and a prefs object; the tool takes a
           flat shape because that is easier for a model to get right. The
           mapping belongs here, next to the route it has to match. */
        return res.json(await inner('POST', '/api/systems/clip/projects', {
          videoUrl: String(b.url || ''),
          title: b.title || null,
          prefs: {
            model: 'ClipBasic',
            durations: [[0, 30], [30, 60], [60, 90]],
            genre: 'Auto',
            keywords: b.keywords || '',
            prompt: b.prompt || '',
            rangeStart: b.rangeStart == null ? '' : String(b.rangeStart),
            rangeEnd: b.rangeEnd == null ? '' : String(b.rangeEnd),
            sourceLang: 'auto', aspect: 'portrait',
            removeFiller: false, skipCurate: false, templateId: ''
          }
        }));
      }
      res.status(400).json({ error: 'unknown kind: ' + b.kind });
    } catch (err) {
      res.status(err.status && err.status < 500 ? err.status : 502).json({ error: err.message });
    }
  });

  /* ---- Hommie ------------------------------------------------------------

     One assistant across the whole dashboard, driven by voice. Everything it can
     do is an enumerated kind here that maps to one of this app's own routes,
     carrying the browser's session -- there is no pass-through, because a tool
     that can reach an arbitrary URL on this origin is one misheard sentence away
     from a DELETE. */

  /* Things Hommie makes the page do: change section, draw a panel, or queue an
     analyst run. Pushed down the same SSE stream the turn is already using. */
  r.post('/api/claude/hommie/act', express.json({ limit: '1mb' }), (req, res) => {
    if (!askCaller(req)) return res.status(403).json({ error: 'not this turn' });
    const b = req.body || {};
    try {
      if (b.action === 'navigate') {
        ask.send('hommie', { kind: 'navigate', section: String(b.section || ''),
          view: b.view ? String(b.view) : null });
      } else if (b.action === 'panel') {
        ask.send('hommie', { kind: 'panel',
          panel: { id: crypto.randomUUID(), at: Date.now(), ...(b.panel || {}) } });
      } else if (b.action === 'analyze') {
        ask.send('hommie', { kind: 'analyze', platform: String(b.platform || '') });
      } else if (b.action === 'connectors') {
        ask.send('hommie', { kind: 'connectors', which: String(b.which || ''),
          reason: String(b.reason || '') });
      } else {
        return res.status(400).json({ error: 'unknown action' });
      }
    } catch { /* the page went away mid-turn */ }
    res.json({ ok: true });
  });

  /* Preflight, git and the deployed copy. Kept here rather than let loose as
     shell strings: the model picks the verb, never the command line. */
  const sh = (cmd, args, opts) => new Promise(done => {
    execFile(cmd, args, { cwd: CWD, maxBuffer: 8 * 1024 * 1024, timeout: 240_000, ...opts },
      (error, stdout, stderr) => done({
        ok: !error,
        code: error?.code ?? 0,
        out: String(stdout || '').slice(-6000),
        err: String(stderr || '').slice(-4000)
      }));
  });

  const preflight = async () => {
    const r2 = await sh(process.execPath, ['tools/preflight.mjs']);
    return { passed: r2.ok, output: (r2.out + (r2.err ? '\n' + r2.err : '')).slice(-4000) };
  };

  r.post('/api/claude/hommie/data', express.json({ limit: '256kb' }), async (req, res) => {
    if (!askCaller(req)) return res.status(403).json({ error: 'not this turn' });
    const b = req.body || {};
    const base = 'http://127.0.0.1:' + (req.socket.localPort || env.PORT || 3000);
    const inner = async (method, pathname, body) => {
      const r2 = await fetch(base + pathname, {
        method,
        headers: {
          ...(ask.cookie ? { cookie: ask.cookie } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const t = await r2.text();
      let j = null; try { j = JSON.parse(t); } catch { /* raw */ }
      if (!r2.ok) throw Object.assign(new Error((j && j.error) || ('inner ' + r2.status)), { status: r2.status });
      return j || {};
    };
    /* Everything heard out loud is approximate, so every name match here is
       loose and case-insensitive rather than exact. */
    const has = (hay, needle) => !needle
      || String(hay || '').toLowerCase().includes(String(needle).toLowerCase());
    const cap = (n, d, max) => Math.min(max, Math.max(1, Number(n) || d));

    try {
      switch (b.kind) {
        case 'tasks': {
          const j = await inner('GET', '/api/tasks');
          if (!j.configured) return res.json({ connected: false, reason: j.reason });
          const now = Date.now();
          const closed = t => t.canonical === 'done' || t.canonical === 'closed' || Boolean(t.closed);
          const all = j.tasks || [];
          const day = 86_400_000;
          const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
          const f = String(b.filter || 'overdue');
          let rows = all.filter(t => {
            if (f === 'all') return true;
            if (f === 'closed') return closed(t);
            if (f === 'open') return !closed(t);
            if (f === 'unassigned') return !closed(t) && !(t.assignees || []).length;
            if (closed(t) || !t.due) return false;
            if (f === 'overdue') return t.due < now;
            if (f === 'today') return t.due <= endOfToday.getTime();
            if (f === 'week') return t.due <= endOfToday.getTime() + 7 * day;
            return true;
          });
          if (b.assignee) {
            rows = rows.filter(t => (t.assignees || []).some(a =>
              has(a.username, b.assignee) || has(a.email, b.assignee)));
          }
          if (b.list) rows = rows.filter(t => has(t.list?.name, b.list) || has(t.space?.name, b.list));
          if (b.search) rows = rows.filter(t => has(t.name, b.search));
          rows.sort((x, y) => (x.due || Infinity) - (y.due || Infinity));

          /* Who owns the pile, so "fourteen overdue and eleven of them are Ben's"
             is one call rather than fourteen. */
          const byPerson = {};
          for (const t of rows) {
            for (const a of (t.assignees || [])) {
              byPerson[a.username] = (byPerson[a.username] || 0) + 1;
            }
            if (!(t.assignees || []).length) byPerson['(unassigned)'] = (byPerson['(unassigned)'] || 0) + 1;
          }
          const limit = cap(b.limit, 25, 100);
          return res.json({
            filter: f, count: rows.length, warming: Boolean(j.warming),
            progress: j.warming ? j.progress : undefined,
            byAssignee: Object.entries(byPerson).sort((x, y) => y[1] - x[1])
              .slice(0, 8).map(([who, n]) => ({ who, n })),
            tasks: rows.slice(0, limit).map(t => ({
              name: t.name, url: t.url, status: t.status,
              due: t.due ? new Date(t.due).toISOString().slice(0, 10) : null,
              daysLate: t.due && t.due < now ? Math.floor((now - t.due) / day) : null,
              assignees: (t.assignees || []).map(a => a.username),
              list: t.list?.name || null, space: t.space?.name || null,
              priority: t.priority || null
            })),
            truncated: Math.max(0, rows.length - limit)
          });
        }

        case 'social': {
          const key = String(b.platform || '');
          if (!['youtube', 'facebook', 'instagram', 'x', 'meta_ads'].includes(key)) {
            return res.status(400).json({ error: 'unknown platform: ' + key });
          }
          const range = [7, 28, 90].includes(Number(b.range)) ? Number(b.range) : 28;
          const raw = await inner('GET', '/api/social/platform/' + key + '?range=' + range);
          const c = compact(key, raw);
          return res.json({ ...c, summary: summariseMetrics(key, c) });
        }

        case 'leads': {
          const q = b.search ? '?q=' + encodeURIComponent(String(b.search)) : '';
          const j = await inner('GET', '/api/ghl/leads' + q);
          let rows = j.leads || [];
          if (b.stage) rows = rows.filter(l => has(l.stageName, b.stage));
          const limit = cap(b.limit, 15, 50);
          return res.json({
            count: rows.length, searched: j.search || null,
            leads: rows.slice(0, limit).map(l => ({
              name: l.name, email: l.email || null, phone: l.phone || null,
              stage: l.stageName, status: l.status, value: l.value,
              tags: l.tags, owner: l.owner || null, last: l.last
            })),
            truncated: Math.max(0, rows.length - limit)
          });
        }

        case 'properties': {
          const j = await inner('GET', '/api/properties');
          let rows = j.properties || [];
          if (b.search) {
            rows = rows.filter(p => has(p.address, b.search) || has(p.name, b.search)
              || has(p.entityName, b.search) || has(p.city, b.search));
          }
          const limit = cap(b.limit, 15, 50);
          return res.json({
            count: rows.length,
            properties: rows.slice(0, limit),
            truncated: Math.max(0, rows.length - limit)
          });
        }

        case 'calendar': {
          const j = await inner('GET', '/api/calendar');
          const days = cap(b.days, 7, 60);
          const until = Date.now() + days * 86_400_000;
          const rows = (j.events || []).filter(e => {
            const t = Date.parse(e.start || e.startsAt || '');
            return Number.isFinite(t) && t <= until && t >= Date.now() - 3_600_000;
          });
          return res.json({ days, count: rows.length, events: rows.slice(0, 40) });
        }

        case 'mail': {
          const folder = ['inbox', 'sent', 'archive', 'spam', 'trash']
            .includes(String(b.folder)) ? String(b.folder) : 'inbox';
          const j = await inner('GET', '/api/mail?folder=' + folder);
          const limit = cap(b.limit, 15, 40);
          const rows = (j.messages || j.mail || []);
          return res.json({
            folder, count: rows.length,
            messages: rows.slice(0, limit).map(m => ({
              from: m.from || m.sender || null, subject: m.subject || '(no subject)',
              when: m.when || m.date || null, unread: Boolean(m.unread)
            }))
          });
        }

        case 'clips': return res.json(await inner('GET', '/api/systems'));

        case 'drive_find':
          return res.json(await inner('GET', '/api/drive/find?name='
            + encodeURIComponent(String(b.name || ''))
            + (b.folder ? '&folder=' + encodeURIComponent(String(b.folder)) : '')
            + (b.video === false ? '' : '&video=1')));

        case 'create_clip': {
          const lengths = Array.isArray(b.lengths) && b.lengths.length
            ? b.lengths.slice(0, 4).map(p => [Number(p[0]) || 0, Number(p[1]) || 60])
            : [[0, 30], [30, 60], [60, 90]];
          return res.json(await inner('POST', '/api/systems/clip/projects', {
            videoUrl: String(b.url || ''),
            title: b.title || null,
            prefs: {
              model: 'ClipBasic', durations: lengths, genre: 'Auto',
              keywords: b.keywords || '', prompt: b.prompt || '',
              rangeStart: b.rangeStart == null ? '' : String(b.rangeStart),
              rangeEnd: b.rangeEnd == null ? '' : String(b.rangeEnd),
              sourceLang: 'auto', aspect: 'portrait',
              removeFiller: false, skipCurate: false, templateId: ''
            }
          }));
        }

        case 'analyze': {
          const key = String(b.platform || '');
          const agent = Object.values(AGENTS).find(a => a.platform === key);
          if (!agent) return res.status(400).json({ error: 'no analyst for ' + key });
          /* Queued in the browser rather than started here. One Claude turn runs
             at a time and this IS that turn, so starting a second would 409
             against Hommie itself. The page runs it the moment Hommie is done. */
          ask.send('hommie', { kind: 'analyze', platform: key, agent: agent.id });
          return res.json({ queued: true, agent: agent.id, platform: key,
            note: 'It starts as soon as this turn ends and runs in Systems.' });
        }

        case 'read_video':
        case 'update_video': {
          const id = String(b.videoId || '').trim();
          if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
            return res.status(400).json({ error: 'that is not a YouTube video id' });
          }
          if (b.kind === 'read_video') {
            return res.json(await inner('GET', '/api/social/youtube/video/' + id));
          }
          const body = {};
          if (typeof b.title === 'string') body.title = b.title;
          if (typeof b.description === 'string') body.description = b.description;
          if (!Object.keys(body).length) return res.status(400).json({ error: 'nothing to change' });
          return res.json(await inner('POST', '/api/social/youtube/video/' + id, body));
        }

        /* ---- repair. Only reachable on a turn the user armed. ---- */
        case 'repair_check':
        case 'repair_status':
        case 'repair_ship':
        case 'repair_live': {
          if (!ask.repair) {
            return res.status(403).json({
              error: 'Repair mode is off. The user has to turn it on with the Repair switch '
                + 'next to the microphone before anything can touch the code.' });
          }
          if (b.kind === 'repair_check') return res.json(await preflight());

          if (b.kind === 'repair_status') {
            const st = await sh('git', ['status', '--porcelain']);
            const log = await sh('git', ['log', '--oneline', '-6']);
            const branch = await sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
            const files = st.out.split(/\r?\n/).filter(Boolean).map(l => l.trim());
            return res.json({
              branch: branch.out.trim(),
              changed: files, changedCount: files.length,
              recent: log.out.split(/\r?\n/).filter(Boolean),
              note: files.length
                ? 'Some of this may not be yours. Say what you are about to commit before you do.'
                : 'Nothing is changed.'
            });
          }

          if (b.kind === 'repair_ship') {
            const msg = String(b.message || '').trim();
            if (!msg) return res.status(400).json({ error: 'a commit needs a message' });
            /* Preflight here, every time, rather than trusting a flag set
               earlier in the turn. A commit that was not tested at the moment it
               was made is an untested commit. */
            const pre = await preflight();
            if (!pre.passed) {
              return res.json({ shipped: false, reason: 'preflight failed', output: pre.output,
                note: 'Nothing was committed. Fix this first, then ship.' });
            }
            const st = await sh('git', ['status', '--porcelain']);
            if (!st.out.trim()) return res.json({ shipped: false, reason: 'nothing to commit' });

            const add = await sh('git', ['add', '-A']);
            if (!add.ok) return res.json({ shipped: false, reason: 'git add failed', output: add.err });
            const full = msg + (b.body ? '\n\n' + String(b.body) : '')
              + '\n\nCo-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>';
            const commit = await sh('git', ['commit', '-m', full]);
            if (!commit.ok) return res.json({ shipped: false, reason: 'git commit failed', output: commit.err || commit.out });
            const push = await sh('git', ['push']);
            if (!push.ok) {
              const sha0 = await sh('git', ['rev-parse', '--short', 'HEAD']);
              return res.json({ shipped: false, committed: true, sha: sha0.out.trim(),
                reason: 'the commit landed locally but the push failed', output: push.err,
                note: 'Say so plainly. Do not commit again.' });
            }
            const sha = await sh('git', ['rev-parse', '--short', 'HEAD']);
            console.log('[hommie] shipped ' + sha.out.trim() + ': ' + msg);
            return res.json({ shipped: true, sha: sha.out.trim(), message: msg,
              note: 'Pushed. Give the deploy about two minutes, then call repair_live.' });
          }

          /* repair_live */
          const url = env.PUBLIC_URL || '';
          if (!/^https?:\/\//.test(url)) {
            return res.json({ checked: false, reason: 'PUBLIC_URL is not set, so there is no deployed copy to check.' });
          }
          const started = Date.now();
          let health = null, version = null, error = null;
          try {
            const h = await fetch(url.replace(/\/+$/, '') + '/api/health',
              { signal: AbortSignal.timeout(15_000) });
            health = h.status;
            const v = await fetch(url.replace(/\/+$/, '') + '/api/app/version',
              { signal: AbortSignal.timeout(15_000) }).then(x => x.json()).catch(() => null);
            version = v || null;
          } catch (e) { error = e.message; }
          const live = version?.commit || version?.sha || null;
          const want = b.expectCommit ? String(b.expectCommit).slice(0, 12) : null;
          return res.json({
            checked: true, url, health, error,
            liveCommit: live, expected: want,
            match: want && live ? String(live).startsWith(want) || want.startsWith(String(live)) : null,
            tookMs: Date.now() - started,
            note: want && live && !(String(live).startsWith(want) || want.startsWith(String(live)))
              ? 'Still on the old commit. Wait and check again rather than pushing anything else.'
              : undefined
          });
        }

        default:
          return res.status(400).json({ error: 'unknown kind: ' + b.kind });
      }
    } catch (err2) {
      res.status(err2.status && err2.status < 500 ? err2.status : 502).json({ error: err2.message });
    }
  });

  /* ---- Analyze: fetch live, then hand the agent the data ------------------

     Pressing Analyze is not a message. It is a trigger: go to the platform, get
     today's numbers, and start reading them.

     Two things follow from that. The turn does not begin with an instruction --
     it begins with the data, and the brief is what tells the agent that a
     metrics payload arriving on its own means "analyse this". Writing the
     instruction into the prompt instead would put the agent's behaviour in a
     string in the browser, where it cannot be researched, versioned, or kept
     consistent between the button and a follow-up question.

     And the data is FRESH. The dashboard's stored numbers are as of the last
     poll, which can be six hours old, and an analyst reading yesterday's figures
     while calling them today's is worse than one that made you wait. */

  const FAMILY_OF = {
    youtube: 'youtube', x: 'x',
    facebook: 'meta', instagram: 'meta', meta_ads: 'meta'
  };

  /* The stored numbers for one platform, read through this app's own API with
     the caller's session -- the same path the agent's tools take, so a pull and
     a follow-up question cannot disagree about the same window. */
  const readPlatform = async (req, key, range) => {
    const base = 'http://127.0.0.1:' + (req.socket.localPort || env.PORT || 3000);
    const res = await fetch(base + '/api/social/platform/' + key + '?range=' + range,
      { headers: req.headers.cookie ? { cookie: req.headers.cookie } : {} });
    const t = await res.text();
    let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
    if (!res.ok) throw new Error((j && j.error) || ('the platform read returned ' + res.status));
    return j || {};
  };

  r.post('/api/claude/agent/pull', auth.require, express.json({ limit: '16kb' }), async (req, res) => {
    const agent = AGENTS[String(req.body?.agent || '')];
    if (!agent) return res.status(400).json({ error: 'unknown agent' });
    const range = [7, 28, 90].includes(Number(req.body?.range)) ? Number(req.body.range) : 28;
    const platform = agent.platform;

    /* Live first. A failure here is reported and the pull continues against
       stored data: half an analysis of this morning's numbers beats an error
       message, as long as it says which of the two it is looking at. */
    const live = { attempted: true, ok: false, polled: 0, failed: 0, error: null, waited: false };
    try {
      const family = providerFamily(FAMILY_OF[platform] || platform);
      if (!family) { live.attempted = false; live.error = 'no fetcher for ' + platform; }
      else if (pollerStatus().running) {
        /* Someone else is already fetching. Waiting for their pass is right:
           two concurrent polls of the same account is how you get rate-limited
           on the one API whose quota cannot be bought. */
        live.waited = true;
        for (let i = 0; i < 90 && pollerStatus().running; i++) {
          await new Promise(done => setTimeout(done, 1000));
        }
        live.ok = !pollerStatus().running;
        if (!live.ok) live.error = 'A fetch was still running after 90 seconds.';
      } else {
        const out = await runNow({ env, providers: family });
        live.polled = out.polled || 0;
        live.failed = out.failed || 0;
        /* polled > 0, not merely "no error".

           pollOnce skips any account already flagged for reconnection, and it
           reports that as a clean pass with nothing polled. Reading that as a
           successful live fetch is how the card came to say "Live from YouTube"
           over numbers that were six hours old and could not have been anything
           else -- the worst failure this endpoint has, because it is the one the
           reader has no way to notice. */
        live.ok = Boolean(out.ok) && !out.failed && live.polled > 0;
        if (out.failed) {
          live.error = (out.results || []).filter(x => !x.ok)
            .map(x => x.label + ': ' + x.error).join('; ');
        } else if (!out.ok) {
          live.error = 'A fetch was already running.';
        } else if (!live.polled) {
          live.error = out.accounts
            ? 'Every connected account is flagged for reconnection, so nothing was fetched. '
              + 'Reconnect it in Connections.'
            : 'No account of this kind is connected, so there was nothing to fetch.';
        }
      }
    } catch (err) {
      live.error = err.message;
    }

    try {
      const raw = await readPlatform(req, platform, range);
      const data = compact(platform, raw);
      const summary = summariseMetrics(platform, data);

      /* What happened last time, and what was recommended then. Absent on a
         first pull, and absent means absent -- the brief says not to narrate a
         comparison that does not exist. */
      const { rows: prevRows } = await query(
        'SELECT id, fetched_at, summary FROM agent_pulls'
        + ' WHERE agent = $1 ORDER BY fetched_at DESC LIMIT 1',
        [agent.id]).catch(() => ({ rows: [] }));
      const prev = prevRows[0] || null;
      let previous = null;
      if (prev) {
        const { rows: acts } = await query(
          'SELECT headline, detail, metric, target, created_at FROM agent_actions'
          + ' WHERE agent = $1 AND created_at >= $2 ORDER BY created_at ASC LIMIT 20',
          [agent.id, prev.fetched_at]).catch(() => ({ rows: [] }));
        previous = {
          pulledAt: prev.fetched_at,
          pulledAgo: agoLabel(prev.fetched_at),
          change: compare(prev.summary, summary),
          youRecommended: acts.map(a => ({
            headline: a.headline, detail: a.detail || undefined,
            metric: a.metric || undefined, target: a.target || undefined
          }))
        };
      }

      const pullId = crypto.randomUUID();
      await query(
        'INSERT INTO agent_pulls (id, agent, platform, range_days, live, live_error, summary)'
        + ' VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [pullId, agent.id, platform, range, live.ok, live.error, JSON.stringify(summary)]
      ).catch(err => console.error('[agent] could not record the pull:', err.message));

      res.json({
        ok: true, pullId, agent: agent.id, platform, range,
        fetchedAt: new Date().toISOString(),
        live, summary, previous, data,
        source: live.ok ? 'live' : 'stored'
      });
    } catch (err) {
      res.status(502).json({ error: err.message, live });
    }
  });

  /* ---- conversations ------------------------------------------------------

     Server-side rather than in the browser, and not for convenience: the agent
     has to be able to see what it said last time to check whether its own advice
     was taken. History kept only in localStorage is history the agent cannot
     read. */

  const threadRow = (row, full) => ({
    id: row.id, agent: row.agent, title: row.title || 'Untitled',
    sessionId: row.session_id || null,
    createdAt: row.created_at, updatedAt: row.updated_at, pullId: row.pull_id || null,
    count: Array.isArray(row.messages) ? row.messages.length : 0,
    ...(full ? { messages: row.messages || [], panels: row.panels || [] } : {})
  });

  r.get('/api/claude/agent/threads', auth.require, async (req, res) => {
    try {
      const agent = String(req.query.agent || '');
      const { rows } = await query(
        'SELECT id, agent, title, session_id, created_at, updated_at, pull_id, messages'
        + ' FROM agent_threads'
        + " WHERE ($1 = '' OR agent = $1)"
        + ' ORDER BY updated_at DESC LIMIT 60', [agent]);
      res.json({ ok: true, threads: rows.map(x => threadRow(x, false)) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  r.get('/api/claude/agent/threads/:id', auth.require, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM agent_threads WHERE id = $1', [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'no such conversation' });
      res.json({ ok: true, thread: threadRow(rows[0], true) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* Upsert. The browser owns the id and writes the whole thread after each turn,
     which keeps this to one statement and means a dropped response never leaves
     half a conversation behind. */
  r.put('/api/claude/agent/threads/:id', auth.require, express.json({ limit: '8mb' }),
    async (req, res) => {
      const b = req.body || {};
      if (!AGENTS[String(b.agent || '')]) return res.status(400).json({ error: 'unknown agent' });
      try {
        await query(
          'INSERT INTO agent_threads (id, agent, title, session_id, pull_id, messages, panels, updated_at)'
          + ' VALUES ($1,$2,$3,$4,$5,$6,$7, now())'
          + ' ON CONFLICT (id) DO UPDATE SET'
          + '   title = EXCLUDED.title, session_id = EXCLUDED.session_id,'
          + '   pull_id = COALESCE(EXCLUDED.pull_id, agent_threads.pull_id),'
          + '   messages = EXCLUDED.messages, panels = EXCLUDED.panels, updated_at = now()',
          [String(req.params.id), b.agent, String(b.title || '').slice(0, 200) || null,
            b.sessionId || null, b.pullId || null,
            JSON.stringify(b.messages || []), JSON.stringify(b.panels || [])]);
        res.json({ ok: true });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

  r.delete('/api/claude/agent/threads/:id', auth.require, async (req, res) => {
    try {
      await query('DELETE FROM agent_threads WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  /* The browser, once the user has tapped. */
  r.post('/api/claude/ask/answer', auth.require, express.json({ limit: '64kb' }), (req, res) => {
    const q = ask && ask.pending.get(String(req.body?.id || ''));
    if (!q) return res.status(404).json({ error: 'that question is no longer open' });
    if (q.state !== 'pending') return res.json({ ok: true, state: q.state });

    /* Keyed by question index, because two questions can share a header. */
    const answers = {};
    const given = req.body?.answers && typeof req.body.answers === 'object' ? req.body.answers : {};
    q.questions.forEach((qq, i) => {
      const v = given[String(i)];
      if (Array.isArray(v)) answers[String(i)] = v.map(x => String(x).slice(0, 300)).slice(0, 8);
      else if (typeof v === 'string' && v.trim()) answers[String(i)] = v.slice(0, 300);
    });
    if (!Object.keys(answers).length) return res.status(400).json({ error: 'nothing chosen' });

    q.answers = answers;
    q.freeText = typeof req.body?.freeText === 'string' ? req.body.freeText.slice(0, 2000) : '';
    q.state = 'answered';
    q.waiters.splice(0).forEach(fn => fn());
    res.json({ ok: true, state: 'answered' });
  });

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

  r.get('/api/claude/agents', auth.require, (req, res) => {
    res.json({ ok: true, agents: Object.values(AGENTS).map(a => ({
      id: a.id, platform: a.platform, label: a.label, short: a.short,
      accent: a.accent, blurb: a.blurb
    })) });
  });

  r.post('/api/claude/stop', auth.require, (req, res) => {
    /* Before the kill, not after: the ask server is polling, and a question left
       pending would keep it polling against a turn that no longer exists. */
    askCancelAll('stopped');
    if (running) { running.kill('SIGTERM'); running = null; }
    res.json({ ok: true });
  });

  r.post('/api/claude/chat', auth.require, express.json({ limit: '1mb' }), (req, res) => {
    if (running) return res.status(409).json({ error: 'already running a turn' });
    const b = req.body || {};
    const prompt = String(b.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'empty prompt' });

    /* An agent turn is an ordinary turn with a brief and an extra tool server.
       Everything else -- streaming, connectors, the ask widget -- is unchanged,
       which is the point: there is one chat implementation, not two.

       Hommie is the same trick again with a different brief and a different tool
       server. It is deliberately NOT in AGENTS: those are platform analysts, each
       locked to one platform, and letting Hommie join that list is how the
       YouTube analyst would end up inheriting a tool that pushes to GitHub. */
    const agent = b.agent && AGENTS[String(b.agent)] ? AGENTS[String(b.agent)] : null;
    const hommie = !agent && String(b.agent || '') === HOMMIE_META.id;
    /* Armed from the browser, per turn. Never sticky and never a default. */
    const repair = hommie && b.repair === true;

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
    /* Spoken answers are short and the questions are mostly lookups, so the
       slowest model is the wrong default here -- the thinking time is the wait,
       and it is a wait someone is standing in silence for. Overridable from the
       Hommie settings, and every other surface keeps whatever it had. */
    if (b.model) args.push('--model', String(b.model));
    else if (hommie) args.push('--model', 'sonnet');
    if (b.effort) args.push('--effort', String(b.effort));

    const bad = msg => { res.write(`event: fatal\ndata: ${JSON.stringify({ error: msg })}\n\n`); res.end(); running = null; };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    /* The ask server rides along on every turn, whatever else is configured.

       It is spawned with this process's own node binary rather than whatever
       "node" resolves to on PATH inside the CLI's environment, and told where to
       call back by the port this very request arrived on -- guessing 3000 is how
       you get a widget that silently never appears on a machine running two
       copies. */
    const askToken = crypto.randomBytes(24).toString('hex');
    const selfUrl = 'http://127.0.0.1:' + (req.socket.localPort || env.PORT || 3000);
    let servers = {
      [ASK_SERVER]: {
        command: process.execPath,
        args: [ASK_SCRIPT],
        env: { CC_ASK_URL: selfUrl, CC_ASK_TOKEN: askToken }
      }
    };
    if (agent) {
      servers[AGENT_SERVER] = {
        command: process.execPath,
        args: [AGENT_SCRIPT],
        env: { CC_AGENT_URL: selfUrl, CC_AGENT_TOKEN: askToken, CC_AGENT_PLATFORM: agent.platform }
      };
    }
    if (hommie) {
      servers[HOMMIE_SERVER] = {
        command: process.execPath,
        args: [HOMMIE_SCRIPT],
        env: { CC_AGENT_URL: selfUrl, CC_AGENT_TOKEN: askToken,
          /* The tool list itself is shorter when repair is off: an unarmed
             Hommie is not told the repair tools exist, rather than being told
             about them and asked not to reach for them. */
          CC_HOMMIE_REPAIR: repair ? '1' : '0' }
      };
    }
    /* Hommie throws the account connectors away.

       Measured: they cost 8.1 seconds of session startup before the first token
       can be thought about, and they put 397 tools in the session -- past the
       point where the CLI defers them, so every single turn began with a
       ToolSearch round trip to find a tool Hommie was always going to use.
       Neither buys anything: Hommie's own server already reaches everything in
       this dashboard.

       A spoken assistant is the one surface where that is unarguable. Eight
       seconds of silence after you say someone's name is the difference between
       talking to something and waiting for it. */
    /* Hommie throws the account connectors away UNLESS this turn asked for one.

       Measured: attaching all of them costs 8.1 seconds of session startup
       before the first token can be thought about, and puts 397 tools in the
       session -- past the point where the CLI defers them, so every turn began
       with a ToolSearch round trip to find a tool Hommie was always going to
       use. Without them: 2.6 seconds and 37 tools.

       So the fast path is the default and the slow one is asked for by name.
       Hommie has a tool that says "this needs Dropbox", the page hears it, tells
       the user to hold on, and runs the question again with that one server
       attached. Eight seconds of silence after saying someone's name is the
       difference between talking to something and waiting for it; eight seconds
       after being told to hold on is just how long it takes. */
    const hommieWantsConnectors = hommie && b.useMcp === true
      && Array.isArray(b.mcpServers) && b.mcpServers.length > 0;
    let strictMcp = hommie && !hommieWantsConnectors;
    if (b.mcp && String(b.mcp).trim()) {
      try {
        const parsed = JSON.parse(String(b.mcp));
        /* The user's servers first, so a config of their own cannot quietly
           replace the one that draws the questions. */
        servers = { ...(parsed.mcpServers || parsed), ...servers };
        strictMcp = true;
      } catch { return bad('MCP config is not valid JSON.'); }
    }
    args.push('--mcp-config', JSON.stringify({ mcpServers: servers }));
    /* --strict-mcp-config throws away the account's connectors, so it goes on
       only when the user supplied a config that means to replace them. */
    if (strictMcp) args.push('--strict-mcp-config');

    ask = { token: askToken, send: (ev, d) => send(ev, d), pending: new Map(),
      /* Kept for the duration of the turn only, and used solely to call this
         same server back as the person who started it. */
      cookie: req.headers.cookie || '',
      /* The one platform this turn's agent may read. Enforced here as well as in
         the tool schema: the schema is a suggestion to a model, this is not. */
      platform: agent ? agent.platform : null,
      /* Which agent, which pull and which conversation this turn belongs to, so
         anything the agent records lands attached to them rather than floating
         free. */
      agentId: agent ? agent.id : (hommie ? HOMMIE_META.id : null),
      pullId: b.pullId ? String(b.pullId).slice(0, 64) : null,
      threadId: b.threadId ? String(b.threadId).slice(0, 64) : null,
      /* Checked by the repair kinds. Held here rather than read back off the
         request, so a later call in the same turn cannot arm itself. */
      repair };
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
    /* One flag, not two: a second --append-system-prompt replaces the first
       rather than adding to it, and the surface note is the half that must not
       be the one dropped. */
    const extraSystem = [SURFACE_NOTE, agent && agent.brief, hommie && HOMMIE,
      hommie && repair && REPAIR_NOTE,
      b.appendSystem && String(b.appendSystem).trim()].filter(Boolean).join('\n\n');
    args.push('--append-system-prompt', extraSystem);
    /* --allowed-tools AUTO-APPROVES; it does not remove. Every built-in stays in
       the session's tool list whether or not it was named, so an unarmed Hommie
       was still offered Bash -- and on this surface there is no permission
       prompt to stop it being used. --disallowed-tools is the only flag that
       takes a tool away, so that is what guards repair mode.

       Hommie only. The Claude section is a full Claude Code session and gates
       its own write tools on CLAUDE_WRITE; narrowing it here would quietly
       change what that switch means. */
    const strippedForHommie = hommie && !repair
      ? ['Bash', 'Edit', 'Write', 'NotebookEdit'] : [];
    args.push('--disallowed-tools', ...IMPOSSIBLE_HERE, ...strippedForHommie);
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
    /* Always allowed, and not part of mcpAllow: asking the user a question is
       the one MCP call that cannot do any harm, and it must work on a turn where
       connectors are switched off. */
    const askAllow = 'mcp__' + ASK_SERVER;
    /* The agent's own tools read this dashboard and draw in its panel. Neither
       can reach outside the app, so they are allowed for the whole turn rather
       than being gated behind the connector switch. */
    const always = agent ? [askAllow, 'mcp__' + AGENT_SERVER]
      : hommie ? [askAllow, 'mcp__' + HOMMIE_SERVER]
      : [askAllow];
    /* Repair mode widens the built-in set for this turn only. Without it Hommie
       has the dashboard tools and nothing that can touch a file, which is what
       every other turn gets. */
    const builtins = repair ? REPAIR_TOOLS : PERMITTED;
    if (builtins) {
      const use = asked && asked.length ? asked.filter(t => builtins.includes(t)) : builtins;
      args.push('--allowed-tools', ...(use.length ? use : builtins), ...mcpAllow, ...always);
    } else if (asked && asked.length) {
      args.push('--allowed-tools', ...asked, ...mcpAllow, ...always);
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

    const writePrompt = () => {
      if (promptSent) return;
      promptSent = true;
      try {
        child.stdin.write(JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: prompt }] }
        }) + '\n');
      } catch { /* the child went away */ }
    };

    let promptSent = false;
    let mcpTimer = null;

    /* Send immediately unless connectors are wanted.

       MCP servers attach asynchronously, and a turn that starts before they are
       ready simply does not see them -- the model answers "no Front connector is
       available" while Front is three seconds from connecting. So when connectors
       matter, hold the prompt until every server has stopped saying "pending".
       Ones that need re-authenticating never will, so they do not count.

       Nothing waits when useMcp is false, which is the common case and must stay
       as fast as it was. */
    /* The ask server counts here too. A turn that starts before it attaches has
       no way to ask a question, which is the whole bug this fixes -- and it is a
       local stdio process, so waiting for it costs a fraction of a second. */
    const waitFor = [...mcpAllow, 'mcp__' + ASK_SERVER,
      ...(agent ? ['mcp__' + AGENT_SERVER] : []),
      ...(hommie ? ['mcp__' + HOMMIE_SERVER] : [])];
    const onlyAsk = !mcpAllow.length;
    send('status', { phase: 'connectors', text: onlyAsk ? 'starting…' : 'attaching connectors…' });
    /* A ceiling, because one wedged server must not hold the turn forever. */
    mcpTimer = setTimeout(() => {
      if (!onlyAsk) send('status', { phase: 'connectors', text: 'proceeding without all connectors' });
      writePrompt();
    /* The ceiling exists for account connectors, which are remote and slow. The
       two local stdio servers attach in well under a second, so waiting eight
       for them is eight seconds of silence bought for nothing. */
    }, !onlyAsk ? 45_000 : hommie ? 2_500 : 8_000);

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

        /* Server states arrive on `system` frames after init. Once none are
           pending, the session is as connected as it is going to get. */
        if (!promptSent && frame.type === 'system' && Array.isArray(frame.mcp_servers)) {
          /* Only the servers this turn actually asked for. Waiting on all 25 --
             including a dozen that need re-authenticating and will never settle --
             turned a nine-second turn into a fifty-nine-second one for no gain. */
          const wanted = frame.mcp_servers.filter(sv =>
            waitFor.includes('mcp__' + String(sv.name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')));
          const watch = wanted.length ? wanted : frame.mcp_servers;
          const pending = watch.filter(sv => sv.status === 'pending');
          send('status', {
            phase: 'connectors',
            text: pending.length
              ? (onlyAsk ? 'starting…' : 'attaching connectors… ' + (watch.length - pending.length) + '/' + watch.length)
              : (onlyAsk ? 'ready' : 'connectors ready'),
            servers: watch.map(sv => ({ name: sv.name, status: sv.status }))
          });
          if (!pending.length) {
            if (mcpTimer) { clearTimeout(mcpTimer); mcpTimer = null; }
            writePrompt();
          }
        }
        /* A `result` frame ends the turn. Nothing more is coming, and the session
           would otherwise wait for another message forever. */
        if (frame.type === 'result' && !finished) {
          finished = true;
          if (mcpTimer) { clearTimeout(mcpTimer); mcpTimer = null; }
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
    child.on('close', code => {
      askCancelAll('turn ended');
      send('done', { code });
      running = null;
      res.end();
    });
    /* res, not req. `req` emits 'close' as soon as the request body has been
       read — which with a JSON body parser is immediately — and killing the
       child there ended every turn before it produced a token. The response
       closing is what actually means the client went away. */
    res.on('close', () => {
      if (mcpTimer) { clearTimeout(mcpTimer); mcpTimer = null; }
      askCancelAll('page closed');
      if (running === child) { child.kill('SIGTERM'); running = null; }
    });
  });

  return r;
}
