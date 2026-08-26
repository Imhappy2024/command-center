# Wait for the server, then open the app window.
#
# This was a Start-Job inside command-center.ps1 and it did not reliably open
# anything: the job is a separate PowerShell process whose lifetime is tied to
# the parent's job table, and Start-Process from inside it was silently doing
# nothing while the launcher happily logged that it had opened a window. A
# detached process with its own script is predictable, and it can be run by hand
# to see what it does.
#
# Chromium's --app is what makes it a window rather than a tab: no address bar,
# no tab strip, its own taskbar button. --user-data-dir gives it a separate
# window list so it does not group under the everyday browser.

param(
  [Parameter(Mandatory=$true)][string]$Url,
  [string]$Exe = '',
  [string]$ProfileDir = '',
  [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Continue'
$log = Join-Path (Split-Path -Parent $PSScriptRoot) 'logs\window.log'
function Log($m){
  try { Add-Content -Path $log -Value ((Get-Date -Format 'HH:mm:ss') + '  ' + $m) -Encoding utf8 } catch {}
}

Log ("waiting for " + $Url)
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$up = $false
while ((Get-Date) -lt $deadline) {
  try {
    Invoke-WebRequest -Uri ($Url + '/api/app/version') -UseBasicParsing -TimeoutSec 2 | Out-Null
    $up = $true; break
  } catch { Start-Sleep -Milliseconds 400 }
}
if (-not $up) { Log 'server never answered; not opening a window'; exit 1 }

if ($Exe -and (Test-Path $Exe)) {
  $args = @("--app=$Url", "--no-first-run", "--no-default-browser-check", "--window-size=1440,900")
  if ($ProfileDir) {
    New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
    # A stale singleton lock from a previous run makes Chromium exit without a
    # word, which looks exactly like "it does not launch".
    foreach ($n in @('SingletonLock','SingletonCookie','SingletonSocket')) {
      $f = Join-Path $ProfileDir $n
      if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue; Log ("cleared stale " + $n) }
    }
    $args += "--user-data-dir=$ProfileDir"
  }
  Log ("launching " + (Split-Path -Leaf $Exe))
  Start-Process $Exe -ArgumentList $args
  # If Chromium exits immediately the window never appears, and falling back to a
  # tab is better than showing nothing at all.
  Start-Sleep -Seconds 4
  $win = Get-Process -Name (($Exe | Split-Path -Leaf) -replace '\.exe$','') -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowTitle -like '*Command Center*' }
  if (-not $win) { Log 'no app window appeared; falling back to the default browser'; Start-Process $Url }
  else { Log ('window is up: ' + ($win | Select-Object -First 1).MainWindowTitle) }
} else {
  Log 'no Chromium found; opening the default browser'
  Start-Process $Url
}
