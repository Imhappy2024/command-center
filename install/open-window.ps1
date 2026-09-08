# Wait for the server, then open the app window.
#
# This was a Start-Job inside command-center.ps1 and it did not reliably open
# anything: the job is a separate PowerShell process whose lifetime is tied to
# the parent's job table, and Start-Process from inside it was silently doing
# nothing while the launcher happily logged that it had opened a window. A
# detached process with its own script is predictable, and it can be run by hand
# to see what it does.
#
# It opens the DEFAULT BROWSER now, not a Chromium --app window.
#
# The app-window framing was dropped deliberately. A --app window offers no
# Install button, so the app could never be installed as a PWA while it was
# being launched into one -- and installing is the better version of the same
# idea: the browser gives it its own window and taskbar icon, but it is the
# user's choice and it runs in the profile they are already signed into.
#
# That last part mattered more than it sounds. --user-data-dir gave it a
# throwaway profile signed into nothing, so every Google or Meta grant started
# from a cold sign-in, and a --app window has no address bar or back button to
# recover with if a redirect went wrong.
#
# -AppWindow (or COMMAND_CENTER_APP_WINDOW=1) puts the old behaviour back.

param(
  [Parameter(Mandatory=$true)][string]$Url,
  [string]$Exe = '',
  [string]$ProfileDir = '',
  [switch]$AppWindow,
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
$lastErr = ''
while ((Get-Date) -lt $deadline) {
  try {
    # -ErrorAction Stop so a failure actually reaches the catch: with
    # ErrorActionPreference = Continue a non-terminating error slips past it and
    # the loop spins for the full timeout learning nothing.
    Invoke-WebRequest -Uri ($Url + '/api/app/version') -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
    $up = $true; break
  } catch { $lastErr = $_.Exception.Message; Start-Sleep -Milliseconds 400 }
}
if (-not $up) { Log ('server never answered; not opening a window -- ' + $lastErr); exit 1 }

$wantApp = $AppWindow -or ($env:COMMAND_CENTER_APP_WINDOW -eq '1')

if (-not $wantApp) {
  # The ordinary browser, in the ordinary profile. Start-Process on a URL hands
  # it to whatever the user has set as default, which is the point.
  Log 'opening the default browser'
  Start-Process $Url
  Log 'if you would rather have a window of its own, install it from the browser'
  exit 0
}

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
  Log ("launching " + (Split-Path -Leaf $Exe) + " in app mode (asked for)")
  Start-Process $Exe -ArgumentList $args
  # If Chromium exits immediately the window never appears, and falling back to a
  # tab is better than showing nothing at all.
  Start-Sleep -Seconds 4
  $win = Get-Process -Name (($Exe | Split-Path -Leaf) -replace '\.exe$','') -ErrorAction SilentlyContinue |
         Where-Object { $_.MainWindowTitle -like '*Command Center*' }
  if (-not $win) { Log 'no app window appeared; falling back to the default browser'; Start-Process $Url }
  else { Log ('window is up: ' + ($win | Select-Object -First 1).MainWindowTitle) }
} else {
  Log 'app mode was asked for but no Chromium was found; opening the default browser'
  Start-Process $Url
}
