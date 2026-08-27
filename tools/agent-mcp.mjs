/* The analyst agents' tools.

   Two kinds of thing live here and they are worth separating in your head.

   READING: get_metrics and get_posts hand the agent this dashboard's own
   numbers. They go back through the app's HTTP API using the browser's own
   session, not around it -- the agent sees exactly what the person who opened
   the chat is allowed to see, and there is no second code path to the database
   to keep in step.

   SHOWING: show_table, show_video and show_note put something on the screen
   beside the conversation. This is the part that makes an analyst agent useful
   rather than chatty. A model that can only emit text has to describe a table;
   one that can render it can point at a row. The panel is not a dashboard -- it
   is a spreadsheet and a video player, because those are the two things an
   analysis of video metrics actually needs to put in front of someone.

   Same stdio rules as any MCP server: stdout carries nothing but JSON-RPC, and
   diagnostics go to stderr. */

import process from 'node:process';

const URL_BASE = process.env.CC_AGENT_URL || '';
const TOKEN = process.env.CC_AGENT_TOKEN || '';
const PLATFORM = process.env.CC_AGENT_PLATFORM || '';
const NAME = 'command_center_agent';
const VERSION = '1.0.0';

const log = m => { try { process.stderr.write('[agent-mcp] ' + m + '\n'); } catch { /* nothing to do */ } };

/* Each agent is a specialist and can read exactly one platform. Not a
   convention -- the tool schema offers one value and the server rejects anything
   else, because an agent told it can read four platforms will eventually read
   four, and a YouTube analyst that has just looked at Instagram stops being a
   YouTube analyst. */
const LABEL = { youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram',
  x: 'X', meta_ads: 'the Meta ad account' };
const MINE = LABEL[PLATFORM] ? PLATFORM : 'youtube';
const MY_LABEL = LABEL[MINE];
/* Ads have campaigns, not posts. */
const ORGANIC = MINE !== 'meta_ads';

const TOOLS = [
  {
    name: 'get_metrics',
    description: 'Read this dashboard\'s stored metrics for ' + MY_LABEL + ' over a window. '
      + (ORGANIC
          ? 'Returns the daily series, account totals and recent posts.'
          : 'Returns per-campaign rows, account totals, the daily series and the previous '
            + 'window for comparison.')
      + ' Call it before answering anything quantitative, and call it more than once with '
      + 'different ranges when you need to tell a trend from a wobble. This is the only '
      + 'platform you can read.',
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {
        range: { type: 'integer', enum: [7, 28, 90], default: 28,
          description: 'Window in days. 7, 28 or 90.' }
      }
    }
  },
  ...(ORGANIC ? [{
    name: 'get_posts',
    description: 'Recent ' + MY_LABEL + ' posts with their individual stats. This is where '
      + 'outliers live: rank against the median and the ones doing several times it are what '
      + 'this account is actually good at. Each carries its permalink, so you can put the '
      + 'title in a table as a link and the reader can open it.',
    inputSchema: {
      type: 'object', additionalProperties: false, properties: {
        range: { type: 'integer', enum: [7, 28, 90], default: 90 }
      }
    }
  }] : []),
  {
    name: 'show_table',
    description: [
      'Put a table on the screen next to the conversation. Use it for anything',
      'you would otherwise describe row by row: a ranking of campaigns by spend,',
      'a retention comparison, an outlier list, a significance calculation.',
      '',
      'Say what the table shows in your reply; do not repeat the rows in prose.',
      'Numbers are right-aligned automatically. Mark rows that need attention',
      'with a tone so the reader\'s eye lands on them first.'
    ].join(' '),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['title', 'columns', 'rows'],
      properties: {
        title: { type: 'string', description: 'What the table is. Short.' },
        note: { type: 'string', description: 'One line under the title: the window, the caveat, the source.' },
        columns: {
          type: 'array', minItems: 1, maxItems: 12,
          description: 'Column headers, left to right.',
          items: { type: 'string' }
        },
        rows: {
          type: 'array', minItems: 1, maxItems: 200,
          description: 'Each row is an array of cells, same length as columns. Numbers stay '
            + 'numbers. A cell may also be {"text":"...","url":"..."} to make it a link -- use '
            + 'that for a post or video title so the reader can open it, and a video link opens '
            + 'in a player rather than a new tab.',
          items: {
            type: 'array',
            items: {
              anyOf: [
                { type: ['string', 'number', 'boolean', 'null'] },
                {
                  type: 'object', additionalProperties: false, required: ['text', 'url'],
                  properties: { text: { type: 'string' }, url: { type: 'string' } }
                }
              ]
            }
          }
        },
        tones: {
          type: 'array',
          description: 'Optional, one per row: "bad", "warn", "good" or "" for plain.',
          items: { type: 'string', enum: ['bad', 'warn', 'good', ''] }
        },
        total: {
          type: 'array',
          description: 'Optional footer row, same shape as a row.',
          items: { type: ['string', 'number', 'boolean', 'null'] }
        }
      }
    }
  },
  {
    name: 'show_video',
    description: [
      'Put a video player on the screen. Use it to show the user the thing you',
      'are talking about: the video whose retention you are analysing, a clip',
      'you generated, an ad creative. Accepts a YouTube URL or ID, or a direct',
      'file URL.',
      '',
      'startAt jumps to the moment that matters -- the drop in the retention',
      'curve, the hook you want changed. That is the difference between a link',
      'and a demonstration.'
    ].join(' '),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['url'],
      properties: {
        url: { type: 'string', description: 'YouTube URL or video id, or a direct https URL to a video file.' },
        title: { type: 'string' },
        note: { type: 'string', description: 'Why you are showing it.' },
        startAt: { type: 'integer', minimum: 0, description: 'Seconds to start at.' }
      }
    }
  },
  {
    name: 'show_note',
    description: [
      'Pin a short block of text to the panel: a verdict, a calculation worked',
      'through, a list of next actions. Use it for the thing the user will want',
      'to still be on screen after the conversation has moved on.'
    ].join(' '),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['title', 'body'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown. Keep it short; the conversation is for detail.' },
        tone: { type: 'string', enum: ['bad', 'warn', 'good', ''], description: 'Optional emphasis.' }
      }
    }
  },
  {
    name: 'list_clips',
    description: 'Recent OpusClip projects and the clips in them, with their scores and durations.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'create_clip',
    description: [
      'Send a video to OpusClip and start it cutting short vertical clips.',
      'Returns a project id; the clips take a few minutes, so call list_clips',
      'afterwards rather than waiting. Only do this when asked -- suggest the',
      'timestamps first and offer.'
    ].join(' '),
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['url'],
      properties: {
        url: { type: 'string', description: 'A video URL from a platform OpusClip accepts (YouTube, Drive, Dropbox, Vimeo, and similar).' },
        prompt: { type: 'string', description: 'What to look for, in words.' },
        keywords: { type: 'string', description: 'Comma-separated topics to favour.' },
        rangeStart: { type: 'integer', minimum: 0, description: 'Seconds into the video to start looking.' },
        rangeEnd: { type: 'integer', minimum: 0 }
      }
    }
  }
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

/* A metrics payload is far too big to hand a model whole -- 90 days of rows per
   campaign per account. This keeps the parts an analysis needs and says what it
   dropped, rather than silently truncating in the middle of an array. */
function compact(platform, j){
  if (!j || j.connected === false) {
    return { platform, connected: false,
      reason: j?.grantConnected === false
        ? 'No account of this kind is connected in the dashboard.'
        : 'Connected, but no account rows were found.' };
  }
  const out = {
    platform, range: j.range,
    accounts: (j.accounts || []).map(a => ({ id: a.id, label: a.label, status: a.status }))
  };

  if (j.ads) {
    const a = j.ads;
    out.currency = a.currency;
    out.totals = a.totals;
    out.previousWindow = a.previous;
    out.campaigns = (a.campaigns || []).map(c => ({
      name: c.name, account: c.account, objective: c.objective, status: c.status,
      spend: c.spend, impressions: c.impressions, clicks: c.clicks, results: c.results,
      ctr: c.ctr, cpc: c.cpc, cpm: c.cpm, costPerResult: c.cpa,
      peakDailyFrequency: c.peakFrequency
    }));
    out.daily = (a.daily || []).map(d => ({
      day: d.day, spend: d.spend, impressions: d.impressions, clicks: d.clicks,
      results: d.results, reach: d.reach
    }));
    /* Stated rather than left for the model to work out, because getting it
       wrong is the single most common error in reading this data. */
    out.readMe = [
      'reach is per-day only and counts unique people -- do NOT sum it across days.',
      'Window-level frequency cannot be derived from summed reach; peakDailyFrequency is the real fatigue signal.',
      'Every ratio here was derived from summed counts. Do not average the ratios again.'
    ];
  }

  if (j.series) {
    out.daily = j.series.map(s => ({
      day: s.day, followers: s.followers, reach: s.reach, views: s.views,
      interactions: s.interactions, posts: s.posts
    }));
  }
  if (j.posts) {
    out.postCount = j.posts.length;
    out.posts = j.posts.slice(0, 60).map(p => ({
      title: p.title, url: p.permalink, published: p.publishedAt,
      views: p.views, reach: p.reach, interactions: p.interactions, shares: p.shares
    }));
    if (j.posts.length > 60) out.postsTruncated = j.posts.length - 60;
  }
  return out;
}

/* ---- the tools themselves ---- */

async function run(name, args){
  if (name === 'get_metrics' || name === 'get_posts') {
    /* The agent's own platform, whatever it asked for. */
    const platform = MINE;
    const range = [7, 28, 90].includes(args?.range) ? args.range : (name === 'get_posts' ? 90 : 28);
    const j = await call('/api/claude/agent/data', { kind: 'platform', platform, range });
    const out = compact(platform, j);
    if (name === 'get_posts') {
      return { platform, range, connected: out.connected !== false,
        postCount: out.postCount || 0, posts: out.posts || [],
        note: out.posts?.length ? undefined : 'No posts are stored for this window.' };
    }
    return out;
  }

  if (name === 'show_table') {
    const cols = (args.columns || []).map(String);
    const rows = (args.rows || []).map(r => (Array.isArray(r) ? r : [r]));
    /* Refused rather than rendered ragged: a row shorter than the header
       silently shifts every cell after the gap into the wrong column, which is
       worse than an error because it looks like data. */
    const wrong = rows.findIndex(r => r.length !== cols.length);
    for (const r of rows) {
      for (const c of r) {
        if (c && typeof c === 'object' && !('text' in c && 'url' in c)) {
          throw new Error('a cell object must have both text and url');
        }
      }
    }
    if (wrong >= 0) {
      throw new Error('row ' + (wrong + 1) + ' has ' + rows[wrong].length + ' cells but there are '
        + cols.length + ' columns. Every row must match the header.');
    }
    await call('/api/claude/agent/show', { panel: { kind: 'table', ...args } });
    return { shown: true, rows: rows.length,
      note: 'The table is on screen. Refer to it; do not repeat the rows in your reply.' };
  }

  if (name === 'show_video') {
    await call('/api/claude/agent/show', { panel: { kind: 'video', ...args } });
    return { shown: true, note: 'The player is on screen.' };
  }

  if (name === 'show_note') {
    await call('/api/claude/agent/show', { panel: { kind: 'note', ...args } });
    return { shown: true };
  }

  if (name === 'list_clips') return call('/api/claude/agent/data', { kind: 'clips' });

  if (name === 'create_clip') {
    return call('/api/claude/agent/data', { kind: 'create_clip', ...args });
  }

  throw new Error('no such tool: ' + name);
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
    /* Not awaited: a slow metrics read must not stop this server answering the
       ping that tells the client it is alive. */
    Promise.resolve(handle(msg)).catch(e => {
      log('handler threw: ' + e.message);
      if (msg && msg.id != null) err(msg.id, -32603, e.message);
    });
  }
});

process.stdin.on('end', () => process.exit(0));
if (!URL_BASE || !TOKEN) log('started without CC_AGENT_URL/CC_AGENT_TOKEN; every call will fail');
