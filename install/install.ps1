# Install Command Center on a Windows machine.
#
#   irm https://raw.githubusercontent.com/Imhappy2024/command-center/main/install/install.ps1 | iex
#
# or, from a checkout:  powershell -ExecutionPolicy Bypass -File install\install.ps1
#
# What it does: checks for git and Node, clones (or updates) into
# %LOCALAPPDATA%\CommandCenter, installs dependencies, seeds .env from the
# example, and puts a Start Menu + Desktop shortcut on the launcher.
#
# It is deliberately not an .exe. See install/README.md for why, and for the
# one-liner that wraps the launcher into one if you want that anyway.

param(
  [string]$Repo   = 'https://github.com/Imhappy2024/command-center.git',
  [string]$Branch = 'main',
  [string]$Dir    = (Join-Path $env:LOCALAPPDATA 'CommandCenter'),
  # For testing the install into a throwaway directory without putting a
  # shortcut to it on the real Desktop.
  [switch]$NoShortcuts
)

$ErrorActionPreference = 'Stop'
function Step($m){ Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m){ Write-Host "    $m" -ForegroundColor Yellow }

# Run a native command and judge it by its exit code, not by whether it wrote to
# stderr. git and npm both report ordinary progress on stderr -- `git clone` says
# "Cloning into ..." there -- and with ErrorActionPreference = Stop, a host that
# merges stderr into the pipeline turns that chatter into a terminating error and
# the install dies partway through having done nothing wrong.
function Native($exe, [string[]]$Arguments){
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $exe @Arguments; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
  if ($code -ne 0) { throw "$exe $($Arguments -join ' ') failed (exit $code)" }
}

Step 'Checking prerequisites'
foreach ($cmd in 'git','node','npm') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "$cmd is not installed or not on PATH." -ForegroundColor Red
    if ($cmd -eq 'git') { Write-Host 'Install it from https://git-scm.com/download/win' }
    else { Write-Host 'Install Node.js LTS from https://nodejs.org' }
    exit 1
  }
}
# Node 20 is the floor (package.json engines); older Node fails on syntax the
# app uses, and that failure is confusing rather than obvious.
$major = [int]((node -v) -replace '^v(\d+).*$','$1')
if ($major -lt 20) { Write-Host "Node $major is too old -- Command Center needs 20 or newer." -ForegroundColor Red; exit 1 }
Write-Host "    git, Node $major, npm OK"

if (Test-Path (Join-Path $Dir '.git')) {
  Step "Updating the existing install at $Dir"
  Push-Location $Dir
  # Never clobber local edits on an update -- the same rule the in-app updater follows.
  # --untracked-files=no: a stray file in the folder is not a reason to refuse,
  # same rule the in-app updater follows.
  if (git status --porcelain --untracked-files=no) {
    Warn 'There are local changes; skipping the pull. Commit or stash them, then re-run.'
  } else { Native git @('pull','--ff-only') }
  Pop-Location
} else {
  Step "Cloning into $Dir"
  if ((Test-Path $Dir) -and (Get-ChildItem $Dir -Force | Select-Object -First 1)) {
    Write-Host "$Dir already exists and is not a git checkout. Move it aside first." -ForegroundColor Red
    exit 1
  }
  Native git @('clone','--branch',$Branch,'--depth','50',$Repo,$Dir)
}

Push-Location $Dir
Step 'Installing dependencies'
try { Native npm @('install','--omit=dev') }
catch { Pop-Location; Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }

if (-not (Test-Path '.env')) {
  Step 'Creating .env from the example'
  Copy-Item '.env.example' '.env'
  Warn 'Fill in .env before first use -- at minimum DATABASE_URL and ENCRYPTION_KEY.'
}
Pop-Location

if ($NoShortcuts) {
  Write-Host ''
  Write-Host "Installed to $Dir (no shortcuts)." -ForegroundColor Green
  exit 0
}

Step 'Creating shortcuts'
# The .vbs starts the launcher hidden -- no console window behind the app.
# install\"Command Center.cmd" is still there for a visible, debuggable run.
$launcher = Join-Path $Dir 'install\command-center.vbs'
$icon     = Join-Path $Dir 'public\favicon.ico'
$shell    = New-Object -ComObject WScript.Shell
foreach ($where in @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Command Center.lnk'),
  (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Command Center.lnk')
)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $where) | Out-Null
  $lnk = $shell.CreateShortcut($where)
  $lnk.TargetPath       = $launcher
  $lnk.WorkingDirectory = $Dir
  $lnk.Description      = 'Command Center'
  if (Test-Path $icon) { $lnk.IconLocation = $icon }
  $lnk.Save()
}

Write-Host ''
Write-Host 'Installed.' -ForegroundColor Green
Write-Host "  Location : $Dir"
Write-Host "  Launch   : the Command Center shortcut (no console window)"
Write-Host "  Debug    : install\Command Center.cmd runs the same thing visibly"
Write-Host "  Config   : $Dir\.env"
Write-Host ''
Write-Host 'Updates: the dashboard checks GitHub itself and shows an Update button' -ForegroundColor DarkGray
Write-Host 'in the sidebar. Because the launcher supervises the process, updating' -ForegroundColor DarkGray
Write-Host 'restarts into the new version without you touching a terminal.' -ForegroundColor DarkGray
