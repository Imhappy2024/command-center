/* Version, update check, and updating in place.

   Only mounted on a local install — the same gate the Claude routes use. A
   hosted deployment updates by deploying, and an endpoint that runs `git pull`
   on a public URL is a remote code execution hole with a friendly name.

   The check asks GitHub for the default branch's head commit and compares it to
   the one this working copy is on. That is cheap, needs no release process, and
   is honest about what "new version" means for a repo that deploys from main. */

import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

export function selfUpdateRoutes({ env, auth }){
  const r = express.Router();
  let updating = false;

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
      const u = `https://api.github.com/repos/${info.owner}/${info.repo}/commits/${encodeURIComponent(branch)}`;
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
