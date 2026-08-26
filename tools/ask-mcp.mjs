/* An MCP server whose only job is to put a question on the user's screen.

   Claude Code's own AskUserQuestion draws an interactive widget in a terminal.
   The dashboard is not a terminal, so in a stream-json session that tool has
   nowhere to draw and no channel to be answered on: every call comes back
   is_error and the turn stops, usually right in the middle of the thing you
   asked for.

   This replaces it. The tool call arrives here over stdio, this process posts
   the question back to the Command Center, the dashboard renders it as real
   buttons in the chat, and the answer comes back down the same path. From
   Claude's side it is an ordinary tool that blocks and then returns what the
   user picked -- which is exactly what the built-in one does.

   Two rules for a stdio MCP server, both easy to break and both fatal:
   stdout carries nothing but JSON-RPC (every diagnostic goes to stderr), and
   the process must not exit while the parent still has the session open. */

import process from 'node:process';

const URL_BASE = process.env.CC_ASK_URL || '';
const TOKEN = process.env.CC_ASK_TOKEN || '';
const NAME = 'command_center';
const VERSION = '1.0.0';

/* Long-poll rather than one blocking request. undici gives a fetch with a
   five-minute headers timeout, and a question can easily sit unanswered for
   longer than that; a request that returns every 20 seconds never trips it, and
   it also means a dead parent is noticed in 20 seconds instead of never. */
const POLL_MS = 20_000;
const GIVE_UP_MS = 15 * 60 * 1000;

const log = m => { try { process.stderr.write('[ask-mcp] ' + m + '\n'); } catch { /* nothing to do */ } };

const TOOL = {
  name: 'ask_user',
  description: [
    'Ask the user a question and wait for their answer. This is the interactive',
    'question widget for this surface: the options appear in the chat as buttons',
    'the user taps, and the tool returns what they chose.',
    '',
    'Use it wherever you would otherwise use AskUserQuestion (which is unavailable',
    'here), and whenever a standing instruction tells you to offer tappable options',
    'rather than writing candidates out as prose.',
    '',
    'Ask everything you need in ONE call: up to 4 questions, each with 2-4 options.',
    'The user can always type a free-text answer instead of picking one, so do not',
    'add an "Other" option yourself. Only ask about things you genuinely cannot',
    'decide, and never ask a question the conversation has already answered.'
  ].join('\n'),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array', minItems: 1, maxItems: 4,
        description: 'The questions to put on screen, all at once.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'header', 'options'],
          properties: {
            question: { type: 'string', description: 'The full question, ending in a question mark.' },
            header: { type: 'string', description: 'A very short label for the question, 12 characters or fewer. Example: "Recipient".' },
            multiSelect: { type: 'boolean', description: 'True when more than one option may be chosen.' },
            options: {
              type: 'array', minItems: 2, maxItems: 4,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label'],
                properties: {
                  label: { type: 'string', description: 'The text on the button. Keep it to a few words.' },
                  description: { type: 'string', description: 'One line under the label saying what this choice means.' }
                }
              }
            }
          }
        }
      }
    }
  }
};

/* ---- talking to the dashboard ---- */

async function post(pathname, body){
  const r = await fetch(URL_BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ask-Token': TOKEN },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* fall through to the raw text */ }
  if (!r.ok) throw new Error((json && json.error) || ('ask endpoint returned ' + r.status));
  return json || {};
}

async function askUser(questions){
  const { id } = await post('/api/claude/ask', { questions, waitMs: 0 });
  const until = Date.now() + GIVE_UP_MS;
  for (;;) {
    const r = await post('/api/claude/ask/poll', { id, waitMs: POLL_MS });
    if (r.state === 'answered') return r;
    if (r.state === 'cancelled') return { state: 'cancelled' };
    if (r.state !== 'pending') throw new Error('unexpected state: ' + r.state);
    if (Date.now() > until) return { state: 'timeout' };
  }
}

/* What Claude gets back. Keyed by header so a multi-question call reads as
   answers to named questions rather than a positional array. */
function render(result, questions){
  if (result.state === 'cancelled') {
    return 'The question was dismissed because the turn ended. Do not retry; '
      + 'ask again in your next reply as plain text.';
  }
  if (result.state === 'timeout') {
    return 'The user did not answer within 15 minutes. Stop and wait for them '
      + 'rather than choosing on their behalf.';
  }
  const out = {};
  (questions || []).forEach((q, i) => {
    const a = (result.answers || {})[String(i)];
    if (a == null) return;
    out[q.header || q.question] = a;
  });
  if (result.freeText) out._note = result.freeText;
  return JSON.stringify(out, null, 2);
}

/* ---- JSON-RPC over stdio ---- */

const write = obj => { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch { /* parent gone */ } };
const ok = (id, result) => write({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg){
  const { id, method, params } = msg;
  /* A notification has no id and must never be answered. Replying to one is the
     quickest way to make a client hang up. */
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    return ok(id, {
      /* Echo the client's version rather than asserting one: this server has no
         version-specific behaviour, so whatever the client speaks is fine. */
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION }
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return isNotification ? undefined : ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: [TOOL] });
  if (method === 'resources/list') return ok(id, { resources: [] });
  if (method === 'prompts/list') return ok(id, { prompts: [] });

  if (method === 'tools/call') {
    if (params?.name !== TOOL.name) return err(id, -32602, 'no such tool: ' + params?.name);
    const questions = params?.arguments?.questions;
    if (!Array.isArray(questions) || !questions.length) {
      return err(id, -32602, 'questions must be a non-empty array');
    }
    try {
      const result = await askUser(questions);
      return ok(id, { content: [{ type: 'text', text: render(result, questions) }] });
    } catch (e) {
      log('ask failed: ' + e.message);
      /* isError, not a JSON-RPC error: the model should see what went wrong and
         fall back to asking in prose, not have the whole call vanish. */
      return ok(id, {
        isError: true,
        content: [{ type: 'text', text: 'Could not reach the dashboard to ask: ' + e.message
          + '. Ask the user in plain text instead.' }]
      });
    }
  }

  if (!isNotification) err(id, -32601, 'method not found: ' + method);
}

let buf = '';
process.stdin.on('data', chunk => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('unparseable line'); continue; }
    /* Not awaited: a tools/call blocks for as long as the user takes to answer,
       and blocking the reader would stop this server responding to anything else
       (including the ping that tells the client it is still alive). */
    Promise.resolve(handle(msg)).catch(e => {
      log('handler threw: ' + e.message);
      if (msg && msg.id != null) err(msg.id, -32603, e.message);
    });
  }
});

process.stdin.on('end', () => process.exit(0));
if (!URL_BASE || !TOKEN) log('started without CC_ASK_URL/CC_ASK_TOKEN; every ask will fail');
