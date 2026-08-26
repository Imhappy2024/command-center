# Command Center launcher and supervisor (Windows).
#
# Started hidden by command-center.vbs, so there is no console window behind the
# app. That has consequences this script has to handle rather than ignore:
#
#   * Nothing can be printed at the user. Output goes to logs\launcher.log and
#     logs\server.log, and a real failure raises a message box, because a hidden
#     process that dies silently is indistinguishable from one that never ran.
#   * There is no window to close to stop it. /api/app/quit exits with
#     $QUIT_CODE and this loop treats that as "stop", as opposed to 0 which
#     means "the updater restarted me".
#   * Clicking the shortcut twice must not start a second server fighting for
#     the port. If the port already answers, this just opens the app window.
#
# Run install\"Command Center.cmd" instead to get the same thing with a visible
# console, which is what you want when something is wrong.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$QUIT_CODE = 9          # matches CC_QUIT_CODE in routes/selfupdate.js
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$launcherLog = Join-Path $logDir 'launcher.log'
$serverLog = Join-Path $logDir 'server.log'

function Log($m){
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m
  Add-Content -Path $launcherLog -Value $line -Encoding utf8
  # Harmless when hidden, useful when run from the .cmd.
  Write-Host $m
}

function Fail($title, $body){
  Log ("FAILED: " + $title + " -- " + $body)
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      ($body + "`n`nLog: " + $launcherLog), ('Command Center - ' + $title),
      'OK', 'Error') | Out-Null
  } catch {
    # No WinForms (rare). The log is still there, and a visible run shows this.
    Write-Host $body -ForegroundColor Red
  }
  exit 1
}

Log '--- launch ---'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js missing' 'Node.js is not installed, or not on PATH. Install the LTS build from https://nodejs.org and launch again.'
}

if (-not (Test-Path (Join-Path $root '.env'))) {
  Fail 'Not configured' 'There is no .env in the install folder. Copy .env.example to .env and fill in DATABASE_URL and ENCRYPTION_KEY.'
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Log 'installing dependencies (first run)'
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { npm install --omit=dev 2>&1 | Add-Content -Path $launcherLog -Encoding utf8; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
  if ($code -ne 0) { Fail 'Install failed' "npm install exited with code $code." }
}

# PORT comes from .env -- server.js reads it from there, so guessing would only
# mean opening the app window on the wrong address.
$port = $env:PORT
if (-not $port) {
  $m = Select-String -Path (Join-Path $root '.env') -Pattern '^\s*(?:export\s+)?PORT\s*[=:]\s*(\d+)' |
       Select-Object -First 1
  if ($m) { $port = $m.Matches[0].Groups[1].Value }
}
if (-not $port) { $port = '3000' }
$url = "http://localhost:$port"

# Chromium's --app is a window with no address bar, no tabs and its own taskbar
# button. A dedicated --user-data-dir gives it a separate window list so it does
# not group under the everyday browser. AUTH_MODE is open on a local install, so
# a separate profile costs nothing -- there is no login to carry over.
function Find-Chromium {
  $candidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

$browser = Find-Chromium
$profileDir = Join-Path $env:LOCALAPPDATA 'CommandCenter\.appwindow'

# Hand the window off to a detached process. Doing it inline would block the
# supervisor, and doing it in a Start-Job did not reliably open anything.
function Open-AppWindow {
  $opener = Join-Path $PSScriptRoot 'open-window.ps1'
  Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $opener + '"'),
    '-Url', $url, '-Exe', ('"' + $browser + '"'), '-ProfileDir', ('"' + $profileDir + '"')
  )
}

function Test-Up {
  try { Invoke-WebRequest -Uri ($url + '/api/app/version') -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true }
  catch { return $false }
}

# Already running? Just show it. Two servers on one port is the more confusing
# failure, and it is the one a second click would otherwise cause.
if (Test-Up) {
  Log 'already running; opening the app window'
  Open-AppWindow
  exit 0
}

$env:CC_SUPERVISED = '1'        # lets /api/app/restart actually restart
$env:CC_QUIT_CODE = "$QUIT_CODE"

# The opener waits for the port itself, so this returns immediately and the
# supervisor gets on with starting the server.
Open-AppWindow

$where = ' in the default browser'
if ($browser) { $where = ' in ' + (Split-Path -Leaf $browser) }
Log ("serving " + $url + $where)

while ($true) {
  # Keep the previous run's log rather than growing one forever; a crash is
  # diagnosed from the run that crashed.
  if (Test-Path $serverLog) { Move-Item $serverLog ($serverLog + '.1') -Force }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { node server.js 2>&1 | Tee-Object -FilePath $serverLog | Out-Null; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }

  if ($code -eq 0) { Log 'restarting into the updated version'; Start-Sleep -Seconds 1; continue }
  if ($code -eq $QUIT_CODE) { Log 'quit requested'; break }

  $tail = ''
  if (Test-Path $serverLog) { $tail = (Get-Content $serverLog -Tail 12) -join "`n" }
  Fail 'Stopped unexpectedly' ("Command Center exited with code $code.`n`n" + $tail)
}
