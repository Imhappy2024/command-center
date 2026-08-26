# Command Center launcher and supervisor (Windows).
#
# Two jobs:
#   1. Start the server with CC_SUPERVISED=1, so the in-app "Update now" button
#      can restart into the new code instead of just killing the process. That
#      env var is the only thing /api/app/restart checks — without a supervisor
#      it refuses, because exiting would leave nothing running.
#   2. Open the dashboard once the port answers.
#
# A clean exit (code 0) is treated as "restart me" — that is what the update
# flow does. Any other exit code is a crash, and it stops so the error stays on
# screen instead of scrolling past in a restart loop.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is not installed or not on PATH." -ForegroundColor Red
  Write-Host "Install it from https://nodejs.org (LTS), then run this again."
  Read-Host "Press Enter to close"
  exit 1
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host "Installing dependencies (first run only)..." -ForegroundColor Cyan
  npm install --omit=dev
  if ($LASTEXITCODE -ne 0) { Read-Host "npm install failed. Press Enter to close"; exit 1 }
}

if (-not (Test-Path (Join-Path $root '.env'))) {
  Write-Host ".env is missing. Copy .env.example to .env and fill it in first." -ForegroundColor Yellow
  Read-Host "Press Enter to close"
  exit 1
}

$env:CC_SUPERVISED = '1'
# Local run: the Claude section mounts, and so do the update endpoints.

# Read PORT out of .env rather than assuming 3000. server.js loads .env itself,
# so guessing here only means opening the browser on the wrong port.
$port = $env:PORT
if (-not $port) {
  $m = Select-String -Path (Join-Path $root '.env') -Pattern '^\s*(?:export\s+)?PORT\s*[=:]\s*(\d+)' |
       Select-Object -First 1
  if ($m) { $port = $m.Matches[0].Groups[1].Value }
}
if (-not $port) { $port = '3000' }
$url = "http://localhost:$port"

# Open the browser once, after the port actually answers. A restart should not
# pile up another tab.
Start-Job -ScriptBlock {
  param($u)
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process $u; return }
    catch { Start-Sleep -Milliseconds 500 }
  }
} -ArgumentList $url | Out-Null

Write-Host "Command Center -> $url" -ForegroundColor Green
Write-Host "Close this window to stop it.`n" -ForegroundColor DarkGray

while ($true) {
  node server.js
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    Write-Host "`nRestarting into the updated version...`n" -ForegroundColor Cyan
    Start-Sleep -Seconds 1
    continue
  }
  Write-Host "`nCommand Center exited with code $code." -ForegroundColor Red
  Read-Host "Press Enter to close"
  break
}
