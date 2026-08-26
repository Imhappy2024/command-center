import io

p = 'routes/claude.js'
s = io.open(p, encoding='utf-8').read()

# ---------------------------------------------------------------- the chat ---
old_head = """    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
    if (b.sessionId) args.push('--resume', String(b.sessionId));
    if (b.model) args.push('--model', String(b.model));
    if (b.effort) args.push('--effort', String(b.effort));"""

new_head = """    /* Streaming input, not one-shot -p.

       This is what makes MCP work. A `-p` run registers its MCP servers and then
       exits before any of them finish connecting -- measured on the session's own
       init frame, they sit at status "pending" and the turn ends with zero mcp__
       tools, whether they come from the account, a local config or an explicit
       --mcp-config. A streaming session stays alive long enough for them to
       attach: same machine, same account, the servers reach "connected" and a
       turn can call mcp__claude_ai_Front__get_my_identity and get an answer back.

       The cost is that stdin is now a protocol rather than a pipe: the prompt goes
       as one JSON line, and the turn is over when a `result` frame arrives. */
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json',
                  '--include-partial-messages', '--verbose'];
    if (b.sessionId) args.push('--resume', String(b.sessionId));
    if (b.model) args.push('--model', String(b.model));
    if (b.effort) args.push('--effort', String(b.effort));"""

assert old_head in s, 'chat args'
s = s.replace(old_head, new_head, 1)

# ---- allow MCP tools when asked -------------------------------------------
old_tools = """    /* The browser may narrow the tool set but never widen it past what this
       process was started with. */
    /* mcp__server and mcp__server__tool are legal tool names, and the old
       /^[A-Za-z]+$/ silently dropped every one of them -- which is why the
       account's connectors were attached to Claude Code and still unusable
       here. Underscores and digits allowed; nothing else, so nothing can smuggle
       a flag through. */
    const asked = Array.isArray(b.tools)
      ? b.tools.filter(t => typeof t === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,120}$/.test(t))
      : null;
    if (PERMITTED) {
      const use = asked && asked.length ? asked.filter(t => PERMITTED.includes(t)) : PERMITTED;
      args.push('--allowed-tools', ...(use.length ? use : PERMITTED));
    } else if (asked && asked.length) {
      args.push('--allowed-tools', ...asked);
    } else {
      args.push('--dangerously-skip-permissions');
    }"""

new_tools = """    /* The browser may narrow the tool set but never widen it past what this
       process was started with.

       mcp__server and mcp__server__tool are legal tool names, and the old
       /^[A-Za-z]+$/ dropped every one of them. Underscores and digits are allowed
       now; nothing else, so nothing can smuggle a flag through argv. */
    const asked = Array.isArray(b.tools)
      ? b.tools.filter(t => typeof t === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,120}$/.test(t))
      : null;

    /* Connectors are opt-in per turn. They are not read-only: this list includes
       Gmail, GHL and Supabase, so an unlucky prompt could send mail or run SQL.
       One deliberate switch is worth more than the convenience of having it on by
       default. */
    const mcpAllow = b.useMcp && Array.isArray(b.mcpServers)
      ? b.mcpServers
          .filter(n => typeof n === 'string')
          /* `claude.ai Front` is exposed as mcp__claude_ai_Front__<tool>; naming
             a server allows all of its tools. */
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
    }"""

assert old_tools in s, 'tool allow-list'
s = s.replace(old_tools, new_tools, 1)

# ---- send the prompt as a stream-json line, and end the turn on `result` ----
old_spawn = """    /* The prompt goes to stdin, not argv -- see lib/claude-cli.js. */
    const child = spawnClaude(args, { cwd: CWD, prompt });
    running = child;

    let buf = '';
    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { send('msg', JSON.parse(line)); } catch { send('raw', { text: line }); }
      }
    });"""

new_spawn = """    /* stdin stays open: in streaming mode closing it ends the session, and the
       process has to outlive the write for MCP servers to finish attaching. */
    const child = spawnClaude(args, { cwd: CWD, prompt: null, keepStdin: true });
    running = child;

    child.stdin.write(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] }
    }) + '\\n');

    let buf = '';
    let finished = false;
    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let frame = null;
        try { frame = JSON.parse(line); } catch { send('raw', { text: line }); continue; }
        send('msg', frame);
        /* A `result` frame is the end of the turn. Nothing else is coming, and
           the session would otherwise sit waiting for another message forever. */
        if (frame.type === 'result' && !finished) {
          finished = true;
          try { child.stdin.end(); } catch { /* already gone */ }
          setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* exited */ } }, 1500);
        }
      }
    });"""

assert old_spawn in s, 'spawn block'
s = s.replace(old_spawn, new_spawn, 1)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('chat endpoint now uses streaming input')

# ------------------------------------------------------------ claude-cli -----
p = 'lib/claude-cli.js'
s = io.open(p, encoding='utf-8').read()

a = """/* Spawn Claude Code. `prompt` is written to stdin when given. */
export function spawnClaude(args, { cwd, prompt = null, env = process.env } = {}){"""
b = """/* Spawn Claude Code. `prompt` is written to stdin when given.

   `keepStdin` leaves the pipe open for streaming-input mode, where stdin is a
   message channel rather than a one-shot prompt and closing it ends the session
   before the model has answered. */
export function spawnClaude(args, { cwd, prompt = null, env = process.env, keepStdin = false } = {}){"""
assert a in s, 'spawnClaude signature'
s = s.replace(a, b, 1)

a2 = """  if (prompt != null) {
    child.stdin.on('error', () => {});   // the child may exit before we finish writing
    child.stdin.end(prompt);
  } else {
    child.stdin.end();
  }
  return child;"""
b2 = """  child.stdin.on('error', () => {});    // the child may exit before we finish writing
  if (prompt != null) child.stdin.end(prompt);
  else if (!keepStdin) child.stdin.end();
  return child;"""
assert a2 in s, 'stdin handling'
s = s.replace(a2, b2, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('spawnClaude can keep stdin open')
