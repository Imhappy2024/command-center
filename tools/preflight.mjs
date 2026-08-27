/* Preflight: what has to be true before a push can possibly boot on Railway.

   Written after a deploy crash-looped for ten minutes on a backtick inside a SQL
   template literal — a one-character error that node --check catches instantly,
   in a file whose syntax had been verified two edits earlier and not since.
   Checking every file every time costs a second and removes the chance to forget.

   Run: node tools/preflight.mjs
*/

import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['node_modules', '.git', '.nixpacks']);

let failures = 0;
const fail = (what, detail) => {
  console.error(`  FAIL  ${what}`);
  if (detail) console.error(String(detail).split('\n').slice(0, 6).map(l => `        ${l}`).join('\n'));
  failures++;
};
const pass = what => console.log(`  ok    ${what}`);

function walk(dir, out = []){
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const js = files.filter(f => f.endsWith('.js') || f.endsWith('.mjs'));

/* ---- 1. Every JS file parses -------------------------------------------- */
console.log('\nSyntax');
for (const f of js) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    fail(path.relative(ROOT, f), err.stderr?.toString() || err.message);
  }
}
if (!failures) pass(`${js.length} JS files parse`);

/* ---- 2. Inline <script> blocks in HTML parse ----------------------------- */
console.log('\nInline scripts');
for (const f of files.filter(f => f.endsWith('.html'))) {
  const html = readFileSync(f, 'utf8');
  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  blocks.forEach((m, i) => {
    /* Written through a temp file so the error message keeps a line number. */
    const tmp = path.join(ROOT, `.preflight-${i}.tmp.js`);
    try {
      writeFileSync(tmp, m[1]);
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (err) {
      fail(`${path.relative(ROOT, f)} <script> #${i + 1}`, err.stderr?.toString());
    } finally {
      try { unlinkSync(tmp); } catch { /* already gone */ }
    }
  });
  if (blocks.length) pass(`${path.relative(ROOT, f)} — ${blocks.length} script blocks parse`);
}

/* ---- 3. Every module actually imports ------------------------------------
   --check proves a file parses; it does not prove its imports resolve or that
   its module-scope code runs. A missing export only shows up here. */
console.log('\nModule graph');
try {
  execFileSync(process.execPath, ['-e',
    "import('./lib/app.js').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})"],
    { cwd: ROOT, stdio: 'pipe' });
  pass('lib/app.js resolves every import');
} catch (err) {
  fail('module graph', err.stderr?.toString());
}

/* ---- 4. JSON files parse -------------------------------------------------
   railway.json deciding not to parse is a deploy that never starts. */
console.log('\nJSON');
for (const f of files.filter(f => f.endsWith('.json') && !f.includes('package-lock'))) {
  try {
    JSON.parse(readFileSync(f, 'utf8'));
    pass(path.relative(ROOT, f));
  } catch (err) {
    fail(path.relative(ROOT, f), err.message);
  }
}

/* ---- 5. Schema stays idempotent ------------------------------------------
   schema.sql runs in full on every boot, inside one implicit transaction. A
   single unguarded CREATE fails the whole migration and the container dies. */
console.log('\nSchema');
const sql = readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
const creates = (sql.match(/^\s*CREATE\s+(TABLE|INDEX)/gim) || []).length;
const guarded = (sql.match(/^\s*CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/gim) || []).length;
const alters = (sql.match(/^\s*ALTER\s+TABLE/gim) || []).length;
const aguard = (sql.match(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/gi) || []).length;
if (creates === guarded && alters === aguard) {
  pass(`${creates} CREATE and ${alters} ALTER statements, all idempotent`);
} else {
  fail('schema.sql', `${creates - guarded} unguarded CREATE, ${alters - aguard} unguarded ALTER`);
}

/* ---- 6. Boot reaches listen() --------------------------------------------
   The one that would have caught the crash loop end to end. Boots against a
   deliberately unreachable database: the process must get far enough to report
   the migration failure by name, which proves imports, env checks and the whole
   pre-listen path are sound. A crash before that point is the real bug. */
console.log('\nBoot');
await new Promise(resolve => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_MODE: 'open',
      SESSION_SECRET: 'p'.repeat(40),
      ENCRYPTION_KEY: 'q'.repeat(40),
      PUBLIC_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
      PORT: '39997'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });

  const done = () => {
    if (/Database migration failed/.test(out)) {
      pass('boot reaches migrate() — imports, env checks and crypto init all fine');
    } else if (/SyntaxError|ReferenceError|TypeError|ERR_MODULE_NOT_FOUND|does not provide an export/.test(out)) {
      fail('boot crashes before migrate()', out);
    } else {
      fail('boot did not reach migrate()', out || '(no output)');
    }
    resolve();
  };

  child.on('exit', done);
  setTimeout(() => { child.kill(); done(); }, 20_000);
});

/* ---------------------------------------------------------------------------
   Does the page actually RUN?

   `node --check` parses; it does not execute. A `let` declared below its first
   use is perfectly valid syntax and throws at load, and because function
   declarations hoist, the page half-works: the views render but every statement
   after the throw is silently skipped -- half the rail, all the bottom-of-file
   wiring. That shipped once. It does not get to ship twice.

   The DOM stub is deliberately thin. This is not testing behaviour, only that
   the top level of every script block completes.
   --------------------------------------------------------------------------- */
{
  const vm = await import('node:vm');
  const html = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const src = blocks.join('\n;\n');

  const el = () => ({
    innerHTML: '', textContent: '', value: '', dataset: {}, hidden: false, disabled: false,
    checked: false, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    style: { setProperty(){}, removeProperty(){} },
    classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    querySelector: () => null, querySelectorAll: () => [],
    appendChild(){}, addEventListener(){}, removeAttribute(){}, setAttribute(){},
    focus(){}, blur(){}, click(){}, closest: () => null,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 })
  });

  const ctx = {
    console: { log(){}, warn(){}, error(){}, info(){} },
    addEventListener(){}, removeEventListener(){}, dispatchEvent: () => true,
    setTimeout, setInterval: () => 0, clearInterval(){}, clearTimeout(){},
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => '' }),
    location: { hash: '', pathname: '/', origin: 'http://localhost', search: '', href: '/' },
    history: { replaceState(){}, pushState(){} },
    navigator: { clipboard: { writeText(){} }, language: 'en-US', userAgent: 'preflight' },
    localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    sessionStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    indexedDB: { open: () => ({ addEventListener(){} }) },
    EventSource: function(){ this.close = () => {}; this.addEventListener = () => {}; },
    AbortController: function(){ this.abort = () => {}; this.signal = {}; },
    AbortSignal: { timeout: () => ({}) },
    TextDecoder, TextEncoder, URLSearchParams, URL, Date, Math, JSON, Intl,
    Event: function(){}, CustomEvent: function(){},
    requestAnimationFrame: cb => { cb(0); return 1; }, cancelAnimationFrame(){},
    matchMedia: () => ({ matches: false, addEventListener(){}, addListener(){} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    alert(){}, confirm: () => false, prompt: () => null, open(){}, scrollTo(){},
    document: {
      getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [],
      createElement: () => el(), createDocumentFragment: () => el(),
      addEventListener(){}, removeEventListener(){},
      body: el(), documentElement: el(), head: el(), title: ''
    },
    __AUTH_MODE: 'open', __BOOT: 1
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);

  try {
    new vm.Script(src, { filename: 'index.html:<script>' }).runInContext(ctx, { timeout: 15_000 });
    pass(`public/index.html top level runs clean (${blocks.length} blocks, ${Math.round(src.length / 1024)} KB)`);
  } catch (err) {
    fail('public/index.html throws at load', err.name + ': ' + err.message
      + '\n        Function declarations hoist, so the page will half-work: views render,'
      + '\n        everything after the throw is silently skipped.');
  }
}

console.log('');
if (failures) {
  console.error(`preflight FAILED — ${failures} problem${failures === 1 ? '' : 's'}\n`);
  process.exit(1);
}
console.log('preflight passed\n');
