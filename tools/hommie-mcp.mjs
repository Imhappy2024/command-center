/* Hommie's hands.

   The analyst agents each read one platform. Hommie reads the whole dashboard
   and can act in it, which makes the shape of this file the interesting part:
   every capability is an enumerated tool that maps to one of this app's own HTTP
   routes, carrying the browser's own session. There is no "call any endpoint"
   tool and there never should be -- a voice assistant that can reach an
   arbitrary URL on this origin is one misheard sentence away from a DELETE.

   Reads are free. Anything that changes state says so in its description, and
   the brief requires a confirmation before it is called. Both halves matter: the
   description is what the model reads, the brief is what makes it wait.

   Same stdio rules as any MCP server: stdout carries nothing but JSON-RPC, and
   diagnostics go to stderr. */

import process from 'node:process';

const URL_BASE = process.env.CC_AGENT_URL || '';
const TOKEN = process.env.CC_AGENT_TOKEN || '';
/* Repair mode is armed from the browser and passed in here, because the tool
   list itself changes: an unarmed Hommie is not told these tools exist. */
const REPAIR = process.env.CC_HOMMIE_REPAIR === '1';
const NAME = 'hommie';
const VERSION = '1.0.0';

const log = m => { try { process.stderr.write('[hommie-mcp] ' + m + '\n'); } catch { /* nothing to do */ } };

/* The sections, as Hommie should describe them out loud. Kept here rather than
   fetched, because "what can you do" must answer instantly and must not depend
   on a section being reachable. */
const SECTIONS = [
  ['overview', 'Overview', 'The whole dashboard at a glance.'],
  ['inbox', 'Instantly', 'Email.'],
  ['calendar', 'Calendar', 'Google Calendar events.'],
  ['tasks', 'Tasks', 'The ClickUp workspace: spaces, lists, assignees, due dates.'],
  ['leads', 'GHL', 'Leads and conversations, mirrored from GoHighLevel into Supabase.'],
  ['properties', 'Properties', 'The portfolio: entities, properties, units, loans, insurance.'],
  ['social', 'Social', 'YouTube, Facebook, Instagram, X and the Meta ad account.'],
  ['claude', 'Claude', 'A full Claude Code session.'],
  ['systems', 'Systems', 'OpusClip, and the five analyst agents behind Pull and analyze metrics.']
];

const TOOLS = [
  {
    name: 'whats_where',
    description: 'The dashboard\'s sections and what lives in each. Call this when you are '
      + 'not sure which tool answers a question, rather than guessing.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'navigate',
    description: 'Open a section on the screen in front of the user. Do this when the answer '
      + 'is something to look at rather than something to hear. Say what you opened.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['section'],
      properties: {
        section: { type: 'string', enum: SECTIONS.map(s => s[0]) },
        view: { type: 'string', description: 'Optional sub-view, e.g. "overview" or "all" in Tasks, a platform in Social.' }
      }
    }
  },

  /* ---- reads ---- */
  {
    name: 'tasks',
    description: [
      'Read the ClickUp workspace. Returns a count as well as rows, so "how many",',
      '"which ones" and "whose" are one call each.',
      '',
      'filter: overdue (past due and not closed), today, week, unassigned, open,',
      'closed, or all. Combine with assignee, list or a text search.',
      '',
      'The workspace is large and the first read after a restart can take a couple',
      'of minutes to warm. If it comes back warming, say so and offer to try again.'
    ].join(' '),
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {
        filter: { type: 'string', enum: ['overdue', 'today', 'week', 'unassigned', 'open', 'closed', 'all'], default: 'overdue' },
        assignee: { type: 'string', description: 'Part of a name or email. Matched loosely, because it was heard out loud.' },
        list: { type: 'string', description: 'Part of a list or space name.' },
        search: { type: 'string', description: 'Part of a task title.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }
      }
    }
  },
  {
    name: 'social',
    description: 'Metrics for one platform over a window: youtube, facebook, instagram, x or '
      + 'meta_ads. Reads what the dashboard has stored. To fetch live and get a full expert '
      + 'analysis, use analyze instead.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['platform'],
      properties: {
        platform: { type: 'string', enum: ['youtube', 'facebook', 'instagram', 'x', 'meta_ads'] },
        range: { type: 'integer', enum: [7, 28, 90], default: 28 }
      }
    }
  },
  {
    name: 'leads',
    description: 'Search leads by name, email, phone, tag, owner or source. Phone numbers match '
      + 'however they were said. Returns the matches and how many there are.',
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {
        search: { type: 'string' },
        stage: { type: 'string', description: 'Exact stage name, if the user named one.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 }
      }
    }
  },
  {
    name: 'properties',
    description: 'The portfolio. Search by address or owning entity, or ask for the totals.',
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {
        search: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 }
      }
    }
  },
  {
    name: 'calendar',
    description: 'Events in a window. Default is the next seven days.',
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {
        days: { type: 'integer', minimum: 1, maximum: 60, default: 7 }
      }
    }
  },
  {
    name: 'mail',
    description: 'Recent mail in a folder. Subjects and senders, not bodies.',
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {
        folder: { type: 'string', enum: ['inbox', 'sent', 'archive', 'spam', 'trash'], default: 'inbox' },
        limit: { type: 'integer', minimum: 1, maximum: 40, default: 15 }
      }
    }
  },
  {
    name: 'clips',
    description: 'OpusClip projects and the clips inside them, with scores and durations.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'drive_find',
    description: [
      'Search Google Drive by file name, optionally inside a named folder.',
      'Use this to turn "the day one video in Raw videos" into a real file with a',
      'URL that create_clip can take. Returns the closest matches; if there is',
      'more than one, ask which.',
      '',
      'If Drive access has not been granted yet this says so, and the fix is for',
      'the user to reconnect Google in Connections.'
    ].join(' '),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['name'],
      properties: {
        name: { type: 'string', description: 'Part of the file name, as heard.' },
        folder: { type: 'string', description: 'Part of a folder name to look inside.' },
        video: { type: 'boolean', description: 'Only video files. Default true when looking for something to clip.' }
      }
    }
  },

  /* ---- actions ---- */
  {
    name: 'create_clip',
    description: [
      'Send a video to OpusClip and start it cutting short vertical clips.',
      '',
      'THIS SPENDS CREDITS. Confirm the file, the clip length and the topic',
      'keywords with ask_user before calling it, because all three change the',
      'output and a rerun costs again.',
      '',
      'Returns a project id. Clips take a few minutes, so say it is running and',
      'call clips later rather than waiting.'
    ].join(' '),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['url'],
      properties: {
        url: { type: 'string', description: 'A video URL OpusClip accepts: Google Drive, Dropbox, YouTube, Vimeo and similar.' },
        title: { type: 'string' },
        prompt: { type: 'string', description: 'What to look for, in words.' },
        keywords: { type: 'string', description: 'Comma-separated topics to favour.' },
        lengths: {
          type: 'array', maxItems: 4,
          description: 'Clip lengths in seconds as [min,max] pairs, e.g. [[0,30],[30,60]]. Default covers 0-90.',
          items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer' } }
        },
        rangeStart: { type: 'integer', minimum: 0, description: 'Seconds into the video to start looking.' },
        rangeEnd: { type: 'integer', minimum: 0 }
      }
    }
  },
  {
    name: 'analyze',
    description: [
      'Hand a platform to its specialist analyst: it fetches live from the platform',
      'and runs the full expert read in the Systems section.',
      '',
      'It takes a few minutes and it runs on its own. Start it, say it is running,',
      'and carry on -- do not wait for it and do not narrate it. The result appears',
      'in Systems under Pull and analyze metrics.'
    ].join(' '),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['platform'],
      properties: {
        platform: { type: 'string', enum: ['youtube', 'facebook', 'instagram', 'x', 'meta_ads'] }
      }
    }
  },
  {
    name: 'update_video',
    description: [
      'Change a published YouTube video\'s title or description. THIS IS LIVE and',
      'the public sees it within seconds. Read it first, propose the exact wording,',
      'confirm with ask_user, and only then call this. The result carries the',
      'previous values -- say them back so the change can be undone by hand.'
    ].join(' '),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['videoId'],
      properties: {
        videoId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' }
      }
    }
  },
  {
    name: 'read_video',
    description: 'One YouTube video\'s live title, description, tags and category.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['videoId'],
      properties: { videoId: { type: 'string' } }
    }
  },

  /* ---- showing ---- */
  {
    name: 'show_table',
    description: 'Put a table on the screen. Use it for anything you would otherwise read out '
      + 'row by row -- which is anything longer than three items, because nobody can hold a '
      + 'spoken list. Say what it shows in one sentence and refer to it.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['title', 'columns', 'rows'],
      properties: {
        title: { type: 'string' },
        note: { type: 'string' },
        columns: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
        rows: {
          type: 'array', minItems: 1, maxItems: 200,
          items: {
            type: 'array',
            items: {
              anyOf: [
                { type: ['string', 'number', 'boolean', 'null'] },
                { type: 'object', additionalProperties: false, required: ['text', 'url'],
                  properties: { text: { type: 'string' }, url: { type: 'string' } } }
              ]
            }
          }
        },
        tones: { type: 'array', items: { type: 'string', enum: ['bad', 'warn', 'good', ''] } }
      }
    }
  },
  {
    name: 'show_note',
    description: 'Pin a short block of text on screen: a verdict, a list of next actions, '
      + 'something the user will want to still be there after the conversation moves on.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['title', 'body'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown. Short.' },
        tone: { type: 'string', enum: ['bad', 'warn', 'good', ''] }
      }
    }
  },

  /* ---- repair, only when armed ---- */
  ...(REPAIR ? [{
    name: 'repair_check',
    description: [
      'Run the project\'s own preflight: every JS file parses, both inline script',
      'blocks in the dashboard parse and run, the module graph resolves, the schema',
      'is idempotent, and boot reaches migrate().',
      '',
      'Run this BEFORE you change anything, so you know whether you are fixing a',
      'real break, and again after, so you know whether you fixed it. A change that',
      'was not preflighted is a change that has not been tested.'
    ].join(' '),
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  }, {
    name: 'repair_status',
    description: 'What is changed and uncommitted right now, and the last few commits. '
      + 'Look before you touch anything: work in progress that is not yours must not be '
      + 'swept into a commit.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  }, {
    name: 'repair_ship',
    description: [
      'Commit everything currently changed and push it to GitHub, which deploys.',
      '',
      'Refuses unless repair_check passed since the last edit. Confirm with the user',
      'first, saying what files are going and what the message says.',
      '',
      'After it lands, wait and then call repair_live to see whether the deployed',
      'copy is actually up.'
    ].join(' '),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['message'],
      properties: {
        message: { type: 'string', description: 'The commit subject. One line, says what changed and why.' },
        body: { type: 'string', description: 'Optional longer explanation.' }
      }
    }
  }, {
    name: 'repair_live',
    description: 'Check the deployed copy: is it up, and is it running the commit that was '
      + 'just pushed. Give the deploy a couple of minutes before the first call; if it is '
      + 'still on the old commit, wait and call again rather than pushing anything else.',
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {
        expectCommit: { type: 'string', description: 'The short SHA repair_ship returned.' }
      }
    }
  }] : [])
];

/* ---- talking to the dashboard ---- */

async function call(pathname, body){
  const r = await fetch(URL_BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': TOKEN },
    body: JSON.stringify(body || {})
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* fall through */ }
  if (!r.ok) throw new Error((json && json.error) || ('the dashboard returned ' + r.status));
  return json || {};
}

const data = body => call('/api/claude/hommie/data', body);

/* ---- the tools themselves ---- */

async function run(name, args){
  switch (name) {
    case 'whats_where':
      return { sections: SECTIONS.map(([id, label, what]) => ({ id, label, what })),
        note: 'navigate opens any of these on screen.' };

    case 'navigate':
      await call('/api/claude/hommie/act',
        { action: 'navigate', section: args.section, view: args.view || null });
      return { opened: args.section,
        note: 'It is on screen now. Say so; do not also describe what is on it.' };

    case 'tasks':      return data({ kind: 'tasks', ...args });
    case 'social':     return data({ kind: 'social', ...args });
    case 'leads':      return data({ kind: 'leads', ...args });
    case 'properties': return data({ kind: 'properties', ...args });
    case 'calendar':   return data({ kind: 'calendar', ...args });
    case 'mail':       return data({ kind: 'mail', ...args });
    case 'clips':      return data({ kind: 'clips' });
    case 'drive_find': return data({ kind: 'drive_find', ...args });

    case 'create_clip': {
      const out = await data({ kind: 'create_clip', ...args });
      return { ...out, note: 'Started. Clips take a few minutes; call clips later rather than waiting.' };
    }
    case 'analyze': {
      const out = await data({ kind: 'analyze', platform: args.platform });
      return { ...out,
        note: 'Running on its own in Systems. Do not wait for it and do not narrate it.' };
    }
    case 'read_video':   return data({ kind: 'read_video', videoId: args.videoId });
    case 'update_video': {
      const body = { kind: 'update_video', videoId: args.videoId };
      if (typeof args.title === 'string') body.title = args.title;
      if (typeof args.description === 'string') body.description = args.description;
      if (!('title' in body) && !('description' in body)) {
        throw new Error('Nothing to change. Send a title or a description.');
      }
      const out = await data(body);
      return { ...out, note: 'Live on the channel now. Say the previous title back.' };
    }

    case 'show_table': {
      const cols = (args.columns || []).map(String);
      const rows = (args.rows || []).map(r => (Array.isArray(r) ? r : [r]));
      /* Refused rather than rendered ragged: a short row silently shifts every
         cell after the gap into the wrong column, which is worse than an error
         because it looks like data. */
      const wrong = rows.findIndex(r => r.length !== cols.length);
      if (wrong >= 0) {
        throw new Error('row ' + (wrong + 1) + ' has ' + rows[wrong].length + ' cells but there are '
          + cols.length + ' columns. Every row must match the header.');
      }
      await call('/api/claude/hommie/act', { action: 'panel', panel: { kind: 'table', ...args } });
      return { shown: true, rows: rows.length,
        note: 'On screen. Refer to it; do not read the rows out.' };
    }
    case 'show_note':
      await call('/api/claude/hommie/act', { action: 'panel', panel: { kind: 'note', ...args } });
      return { shown: true };

    case 'repair_check':  return data({ kind: 'repair_check' });
    case 'repair_status': return data({ kind: 'repair_status' });
    case 'repair_ship':   return data({ kind: 'repair_ship', message: args.message, body: args.body });
    case 'repair_live':   return data({ kind: 'repair_live', expectCommit: args.expectCommit });

    default:
      throw new Error('no such tool: ' + name);
  }
}

/* ---- JSON-RPC over stdio ---- */

const write = obj => { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch { /* parent gone */ } };
const ok = (id, result) => write({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg){
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION }
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return isNotification ? undefined : ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'resources/list') return ok(id, { resources: [] });
  if (method === 'prompts/list') return ok(id, { prompts: [] });

  if (method === 'tools/call') {
    try {
      const out = await run(params?.name, params?.arguments || {});
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
    } catch (e) {
      log(params?.name + ' failed: ' + e.message);
      /* isError, not a JSON-RPC error: the model should see what went wrong and
         adapt, not have the call disappear. */
      return ok(id, { isError: true, content: [{ type: 'text', text: e.message }] });
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
    /* Not awaited: a slow read must not stop this server answering the ping that
       tells the client it is alive. */
    Promise.resolve(handle(msg)).catch(e => {
      log('handler threw: ' + e.message);
      if (msg && msg.id != null) err(msg.id, -32603, e.message);
    });
  }
});

process.stdin.on('end', () => process.exit(0));
if (!URL_BASE || !TOKEN) log('started without CC_AGENT_URL/CC_AGENT_TOKEN; every call will fail');
log('ready' + (REPAIR ? ', repair armed' : ''));
