# Running Command Center on your own Windows machine

Two reasons to install it locally rather than only using the Railway URL:

- **The Claude section only works locally.** It spawns `claude -p` on the machine
  serving the page, so the Claude Code that answers is the one signed in to your
  subscription. On the hosted deployment those routes are not mounted at all —
  `AUTH_MODE=open` means anyone with the URL could otherwise get a shell.
- **Updates are self-service.** A local install checks GitHub and updates itself
  from the sidebar.

## Install

One line, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/Imhappy2024/command-center/main/install/install.ps1 | iex
```

It checks for git and Node 20+, clones into `%LOCALAPPDATA%\CommandCenter`,
installs dependencies, copies `.env.example` to `.env`, and puts a **Command
Center** shortcut on the Desktop and in the Start Menu.

Then fill in `%LOCALAPPDATA%\CommandCenter\.env` — at minimum `DATABASE_URL` and
`ENCRYPTION_KEY` — and launch the shortcut. It opens `http://localhost:3000`
once the port answers.

Prerequisites it will not install for you:

| Need | Where |
|---|---|
| Node.js 20+ | <https://nodejs.org> (LTS) |
| Git | <https://git-scm.com/download/win> |
| Claude Code | `npm i -g @anthropic-ai/claude-code`, then `claude` once to sign in |

## Updating

The sidebar shows the version, the commit, and whether the working copy has
local edits. Once an hour (and on load) it asks GitHub for the head of `main`
and compares. When you are behind, a banner offers **Update now**, which:

1. Refuses if there are uncommitted changes in the install folder — an update
   that silently discards your edits is worse than no update.
2. `git pull --ff-only`, then `npm install --omit=dev`.
3. Restarts. The launcher supervises the process (`CC_SUPERVISED=1`), so a clean
   exit brings the new code straight back up and the page reloads itself.

Launched some other way — `npm start` in a terminal, say — nothing is supervising
the process, so `/api/app/restart` refuses and the banner tells you to restart it
yourself. That is deliberate: exiting would just stop it.

The check is an unauthenticated read of the GitHub API, which works because the
repo is public. If it ever goes private that read starts answering 404, and the
sidebar reports it as a permissions problem rather than as "up to date" — an
update check that cannot see the remote must not claim the install is current.

## Why there is no .exe

You asked for a single `.exe` to carry between machines. Honest answer: it is
possible, and it is the wrong trade here.

A real one-file `.exe` means Node's [Single Executable
Applications](https://nodejs.org/api/single-executable-applications.html) — which
takes exactly one JavaScript file, so every dependency (`express`, `pg`, `imap`,
`mailparser`, `nodemailer`) has to be bundled first, and `pg` carries native
bindings that do not bundle cleanly. You would be maintaining a build pipeline,
shipping a ~120 MB binary, and re-shipping the whole thing for every change —
losing the in-app updater, which is the feature you asked for in the same breath.

And it buys nothing: **Claude Code needs Node on the machine anyway.** The
prerequisite the `.exe` would exist to avoid is one you already have.

So the installer is the packaging. One line to install, a Desktop shortcut to
launch, a button in the sidebar to update — the same experience, without the
build step.

If you still want something that looks like an app icon, wrap the launcher:

```powershell
Install-Module ps2exe -Scope CurrentUser
ps2exe .\install\command-center.ps1 .\CommandCenter.exe -noConsole
```

That produces a real `.exe` that starts the local server. It still needs the
checkout and Node present — it is a launcher with an icon, not a self-contained
build, and this file is clear about that so nobody is surprised later.
