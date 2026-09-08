/* Version, update check, and updating in place.

   Only mounted on a local install — the same gate the Claude routes use. A
   hosted deployment updates by deploying, and an endpoint that runs `git pull`
   on a public URL is a remote code execution hole with a friendly name.

   The check asks GitHub for the default branch's head commit and compares it to
   the one this working copy is on. That is cheap, needs no release process, and
   is honest about what "new version" means for a repo that deploys from main. */

import express from 'express';
import { idleFor, busyReport } from '../lib/inflight.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* The GitHub API base, overridable.

   Default is the real one. It is a seam for two reasons: GitHub Enterprise
   lives on a different host, and the end-to-end test for auto-updating needs
   to answer the check itself without editing this file -- an edit here makes
   the working tree dirty, which the updater then refuses to update over, so
   the test could never reach the thing it was testing. */
const GH_API = (process.env.CC_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');

function git(args, timeoutMs = 20_000){
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd: ROOT });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill('SIGTERM'); resolve({ ok:false, error:'timed out' }); }, timeoutMs);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => { clearTimeout(t); resolve({ ok:false, error: e.code === 'ENOENT' ? 'git is not installed' : e.message }); });
    child.on('close', code => { clearTimeout(t); resolve({ ok: code === 0, stdout: out.trim(), stderr: err.trim() }); });
  });
}

/* npm without a shell.
   `spawn('npm.cmd', args)` fails outright on Windows (Node refuses to spawn a
   .cmd without a shell) and `shell: true` concatenates argv instead of escaping
   it — Node says so with DEP0190. Same trap as lib/claude-cli.js. npm ships as
   a plain Node script next to the node binary, so spawn that directly. */
function spawnNpm(args){
  const dir = path.dirname(process.execPath);
  for (const cli of [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),          // Windows
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')  // Unix
  ]) {
    if (fs.existsSync(cli)) return spawn(process.execPath, [cli, ...args], { cwd: ROOT });
  }
  /* Not where it usually lives. The shell form is the fallback, and these
     particular arguments contain nothing that needs escaping. */
  return spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args,
               { cwd: ROOT, shell: process.platform === 'win32' });
}

function pkgVersion(){
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

/* owner/repo from the origin remote, whatever form it takes. */
function parseRemote(url){
  const m = /github\.com[:/]([^/]+)\/([^/.\s]+)/i.exec(String(url || ''));
  return m ? { owner: m[1], repo: m[2] } : null;
}

export function selfUpdateRoutes({ env, auth, boot = Date.now() }){
  const r = express.Router();
  let updating = false;

  /* ---------- updating without being asked ----------

     Everything needed for this already existed: a check against GitHub, a pull
     that refuses to discard uncommitted work, and a launcher loop that reads
     exit 0 as "bring the new build up". What was missing was anything that
     decided to do it, so the update sat behind a button in a dashboard nobody
     necessarily had open.

     Three rules it will not break.

     ONLY UNDER THE LAUNCHER. Exiting is how the new code gets loaded, so
     without a supervisor to restart it, auto-updating means quietly shutting
     the app down. CC_SUPERVISED is set by install/command-center.ps1 and by
     nothing else.

     NEVER OVER UNCOMMITTED WORK. The manual path already refuses; so does this,
     and it says so rather than retrying every quarter hour forever.

     NEVER MID-FLIGHT. A restart is only invisible if nothing is in the middle
     of happening -- a Claude turn streaming, an upload, a three-minute ClickUp
     walk. The code is pulled as soon as it is available, because that is
     harmless: this process goes on serving the old code from memory. Only the
     restart waits, and it waits for the app to actually be idle. */
  const AUTO = env.CC_SUPERVISED === '1' && env.CC_AUTO_UPDATE !== '0';
  const EVERY_MS = Math.max(2, Number(env.CC_AUTO_UPDATE_MINUTES) || 15) * 60_000;
  /* Eight seconds of nothing at all. Long enough that a burst of polling does
     not read as idle, short enough to come round often. */
  const IDLE_MS = 8_000;
  /* A pull that fails will keep failing -- a diverged branch, a broken remote,
     no npm. Retrying every fifteen minutes just fills the log. */
  const BACKOFF_MS = 6 * 60 * 60_000;

  /* What the UI is told, so "auto-updates are on" is never a claim the server
     cannot back up, and a blocked update is visible rather than silent. */
  const autoState = {
    enabled: AUTO,
    /* off | idle | pulling | waiting-for-idle | blocked | failed */
    phase: AUTO ? 'idle' : 'off',
    reason: AUTO ? null
      : env.CC_SUPERVISED !== '1'
        ? 'Nothing is supervising this process, so exiting would stop the app rather than restart it. '
          + 'Launch it with the Command Center shortcut to enable this.'
        : 'Switched off by CC_AUTO_UPDATE=0.',
    lastCheck: null,
    lastError: null,
    pulledTo: null,
    restartAt: null,
    every: EVERY_MS
  };

  let blockedUntil = 0;
  let restartPending = false;

  async function pullAndStage(){
    autoState.phase = 'pulling';
    const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty.ok && dirty.stdout) {
      autoState.phase = 'blocked';
      autoState.reason = 'There are uncommitted changes in the install folder, and updating would '
        + 'overwrite them. Commit or stash them and it will pick up on the next check.';
      autoState.lastError = dirty.stdout.split('\n').slice(0, 6).join('; ');
      /* Not a backoff: this clears itself the moment the tree is clean, and
         checking a dirty tree costs one git call. */
      return false;
    }

    const pull = await git(['pull', '--ff-only'], 90_000);
    if (!pull.ok) {
      autoState.phase = 'failed';
      autoState.reason = 'git pull failed. Retrying in six hours, or use the update button.';
      autoState.lastError = (pull.stderr || pull.error || 'unknown').slice(0, 300);
      blockedUntil = Date.now() + BACKOFF_MS;
      console.error('[auto-update] pull failed: ' + autoState.lastError);
      return false;
    }

    const install = await new Promise(resolve => {
      const child = spawnNpm(['install', '--omit=dev']);
      let err = '';
      child.stderr.on('data', c => { err += c; });
      child.on('error', e => resolve({ ok: false, error: e.message }));
      child.on('close', code => resolve({ ok: code === 0, error: code === 0 ? null : err.slice(-300) }));
    });
    if (!install.ok) {
      /* The pull already happened, so the files on disk are the new version and
         a restart would run them against the old dependencies. Worse than not
         restarting, so it does not. */
      autoState.phase = 'failed';
      autoState.reason = 'The new code is on disk but npm install failed, so it has NOT been restarted. '
        + 'Run npm install in the install folder.';
      autoState.lastError = install.error;
      blockedUntil = Date.now() + BACKOFF_MS;
      console.error('[auto-update] npm install failed: ' + install.error);
      return false;
    }

    const head = await git(['rev-parse', 'HEAD']);
    autoState.pulledTo = head.ok ? head.stdout.slice(0, 8) : null;
    autoState.phase = 'waiting-for-idle';
    autoState.reason = 'Updated on disk. Restarting as soon as nothing is in the middle of running.';
    restartPending = true;
    console.log('[auto-update] pulled to ' + autoState.pulledTo + '; waiting for an idle moment to restart');
    return true;
  }

  /* Called on a short timer once something has been staged. Separate from the
     check timer because "is anything happening right now" needs asking often
     and costs nothing, while asking GitHub does not. */
  function maybeRestart(){
    if (!restartPending) return;
    if (!idleFor(IDLE_MS)) return;
    const b = busyReport();
    console.log('[auto-update] restarting into ' + autoState.pulledTo
      + ' (idle ' + Math.round(b.idleMs / 1000) + 's'
      + (b.stale ? ', ' + b.stale + ' abandoned connection(s) ignored' : '') + ')');
    autoState.phase = 'restarting';
    autoState.restartAt = Date.now();
    restartPending = false;
    /* Exit 0 is the launcher's signal to bring the new build up. */
    setTimeout(() => process.exit(0), 400);
  }

  async function tick(){
    if (!AUTO || updating || restartPending) return;
    if (Date.now() < blockedUntil) return;
    updating = true;
    try {
      autoState.lastCheck = new Date().toISOString();
      const head = await git(['rev-parse', 'HEAD']);
      if (!head.ok) return;
      const remote = await git(['remote', 'get-url', 'origin']);
      const info = parseRemote(remote.stdout);
      if (!info) {
        autoState.phase = 'blocked';
        autoState.reason = 'No GitHub origin remote to check against.';
        blockedUntil = Date.now() + BACKOFF_MS;
        return;
      }
      const branchOut = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = branchOut.ok && branchOut.stdout !== 'HEAD' ? branchOut.stdout : 'main';
      const gh = await fetch(
        `${GH_API}/repos/${info.owner}/${info.repo}/commits/${encodeURIComponent(branch)}`,
        { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'command-center' },
          signal: AbortSignal.timeout(12_000) });
      if (!gh.ok) {
        /* A private repo answers 404 to an unauthenticated call. That is a
           visibility problem, not "no updates", and it is not worth six hours
           of silence -- the next check may be authenticated or the repo public
           again. */
        autoState.phase = 'blocked';
        autoState.reason = gh.status === 404
          ? 'GitHub returned 404 for this repo and branch. If it is private, the check cannot see it; '
            + 'pulling in the install folder still works.'
          : 'GitHub returned ' + gh.status + '.';
        return;
      }
      const j = await gh.json();
      const latest = j.sha || '';
      if (!latest || latest === head.stdout) {
        autoState.phase = 'idle';
        autoState.reason = null;
        autoState.lastError = null;
        return;
      }
      console.log('[auto-update] ' + head.stdout.slice(0, 8) + ' -> ' + latest.slice(0, 8)
        + ': ' + (j.commit?.message || '').split('\n')[0]);
      await pullAndStage();
    } catch (err) {
      /* Offline is the common case and is not worth a backoff. */
      autoState.lastError = err.message;
      if (autoState.phase !== 'waiting-for-idle') autoState.phase = 'idle';
    } finally { updating = false; }
  }

  if (AUTO) {
    /* Not on boot. A restart loop caused by a bad commit is the one failure
       mode that would take the app down for good, and a two-minute delay means
       the window is open and readable before anything can exit. */
    const first = setTimeout(tick, 2 * 60_000);
    const every = setInterval(tick, EVERY_MS);
    const idleWatch = setInterval(maybeRestart, 3_000);
    for (const t of [first, every, idleWatch]) t.unref?.();
    console.log('[auto-update] on — checking every '
      + Math.round(EVERY_MS / 60_000) + ' minutes, restarting only when idle');
  } else {
    console.log('[auto-update] off — ' + autoState.reason);
  }

  r.get('/api/app/auto-update', auth.require, (req, res) => {
    res.json({ ...autoState, busy: busyReport(), restartPending });
  });

  /* Check right now rather than at the next interval.

     Useful on its own -- 'I just pushed, take it' -- and it is how the
     end-to-end test avoids waiting out the deliberate two-minute first-check
     delay without weakening that delay for real installs. It runs the same
     tick() as the timer, so there is no second code path to keep honest. */
  r.post('/api/app/auto-update/check', auth.require, async (req, res) => {
    if (!AUTO) return res.status(400).json({ error: autoState.reason || 'auto-update is off' });
    blockedUntil = 0;
    await tick();
    res.json({ ...autoState, busy: busyReport(), restartPending });
  });

  r.get('/api/app/version', auth.require, async (req, res) => {
    const [head, branch, dirty] = await Promise.all([
      git(['rev-parse', 'HEAD']),
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      /* --untracked-files=no: an untracked file is not a reason to refuse.
         A stray note or log in the install folder would otherwise block every
         update forever, and a pull only conflicts with an untracked file when
         it would overwrite one — which git refuses by itself, with a message
         that says which file. */
      git(['status', '--porcelain', '--untracked-files=no'])
    ]);
    res.json({
      version: pkgVersion(),
      commit: head.ok ? head.stdout.slice(0, 8) : null,
      branch: branch.ok ? branch.stdout : null,
      /* Uncommitted work is why an update might refuse, so say it up front. */
      dirty: dirty.ok ? Boolean(dirty.stdout) : null,
      /* The UI only offers Quit when something is listening for it. */
      supervised: env.CC_SUPERVISED === '1',
      /* So the rail can say "auto-updates on" only when they really are, and
         name the reason when they are not. */
      auto: { enabled: autoState.enabled, phase: autoState.phase, reason: autoState.reason,
        pulledTo: autoState.pulledTo },
      /* Compared against the stamp baked into the page. Different means the
         server restarted underneath the browser, so what is on screen is the
         previous build's UI. */
      boot,
      root: ROOT
    });
  });

  r.get('/api/app/update-check', auth.require, async (req, res) => {
    const head = await git(['rev-parse', 'HEAD']);
    if (!head.ok) return res.json({ ok:false, error: head.error || 'not a git checkout' });

    const remote = await git(['remote', 'get-url', 'origin']);
    const info = parseRemote(remote.stdout);
    if (!info) return res.json({ ok:false, error:'no GitHub origin remote to check against' });

    const branchOut = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = branchOut.ok && branchOut.stdout !== 'HEAD' ? branchOut.stdout : 'main';

    try {
      const u = `${GH_API}/repos/${info.owner}/${info.repo}/commits/${encodeURIComponent(branch)}`;
      const gh = await fetch(u, {
        headers: { Accept:'application/vnd.github+json', 'User-Agent':'command-center' },
        signal: AbortSignal.timeout(12_000)
      });
      if (!gh.ok) {
        /* A 404 here means the remote could not be seen — the repo went
           private, was renamed, or this branch is local-only. Either way it is
           an answer about visibility, not "no updates", and reporting it as
           up to date would be a lie the user acts on. */
        return res.json({ ok:false, error: gh.status === 404
          ? `GitHub returned 404 for ${info.owner}/${info.repo}@${branch} — the repo may be private `
            + 'or the branch may not exist there. Pulling in the install folder still works.'
          : 'GitHub returned ' + gh.status });
      }
      const j = await gh.json();
      const latest = j.sha || '';
      const behind = latest && latest !== head.stdout;
      res.json({
        ok: true, behind,
        current: head.stdout.slice(0, 8),
        latest: latest.slice(0, 8),
        message: behind ? (j.commit?.message || '').split('\n')[0] : null,
        when: j.commit?.author?.date || null,
        branch
      });
    } catch (err) {
      res.json({ ok:false, error: 'Could not reach GitHub: ' + err.message });
    }
  });

  r.post('/api/app/update', auth.require, express.json(), async (req, res) => {
    if (updating) return res.status(409).json({ error:'an update is already running' });
    updating = true;
    try {
      /* Tracked changes only — see the note in /api/app/version. */
      const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
      /* Never discard someone's uncommitted work to install an update. */
      if (dirty.ok && dirty.stdout) {
        return res.status(409).json({
          error: 'There are uncommitted changes in the install folder. Commit or stash them first — '
            + 'updating would overwrite them.',
          files: dirty.stdout.split('\n').slice(0, 10)
        });
      }
      const pull = await git(['pull', '--ff-only'], 90_000);
      if (!pull.ok) {
        return res.status(502).json({ error: 'git pull failed: ' + (pull.stderr || pull.error || 'unknown') });
      }
      const install = await new Promise(resolve => {
        const child = spawnNpm(['install', '--omit=dev']);
        let err = '';
        child.stderr.on('data', c => { err += c; });
        child.on('error', e => resolve({ ok:false, error: e.message }));
        child.on('close', code => resolve({ ok: code === 0, error: code === 0 ? null : err.slice(-400) }));
      });
      res.json({
        ok: true,
        pulled: pull.stdout,
        deps: install.ok ? 'installed' : 'npm install failed: ' + install.error,
        /* The new code is on disk but this process is still the old one. */
        restartRequired: true
      });
    } finally { updating = false; }
  });

  /* Stop for good. With the launcher running hidden there is no console window
     to close, so the only way out would otherwise be Task Manager.

     The exit code is what separates this from a restart: 0 tells the launcher
     loop to bring the new build up, this one tells it to stop. */
  r.post('/api/app/quit', auth.require, (req, res) => {
    if (env.CC_SUPERVISED !== '1') {
      return res.status(400).json({ error: 'Not running under the launcher, so there is nothing to signal. Stop the process however you started it.' });
    }
    const code = Number(env.CC_QUIT_CODE) || 9;
    res.json({ ok: true, quitting: true });
    setTimeout(() => process.exit(code), 250);
  });

  /* Exits so a supervisor — the launcher script, a service wrapper, nodemon —
     brings the new code up. Without one, the user restarts it themselves; the
     UI says which case they are in. */
  r.post('/api/app/restart', auth.require, (req, res) => {
    if (env.CC_SUPERVISED !== '1') {
      return res.status(400).json({ error:'Nothing is supervising this process, so exiting would just stop it. Restart it yourself.' });
    }
    res.json({ ok:true, restarting:true });
    setTimeout(() => process.exit(0), 250);
  });

  return r;
}
