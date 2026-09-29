# AIcad watchdog: keeps the gateway and its Cloudflare tunnel alive.
#
# Runs every minute from a per-user scheduled task (scripts\install-watchdog.ps1).
# Processes it starts belong to the Task Scheduler, not to whichever terminal
# happened to launch the gateway last, which is what used to kill it.
#
#   gateway : GET /api/health must return 200 within 10s, else restart.
#   tunnel  : cloudflared for this port must exist and its last connection
#             event must be a successful registration, else restart.
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [int]$Port = 3000,
  [switch]$NoTunnel
)
$ErrorActionPreference = "Continue"
$logDir = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "watchdog.log"
function Log([string]$msg) {
  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg)
}

# ---------------------------------------------------------------- gateway ---
$healthy = $false
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/api/health" -TimeoutSec 10
  $healthy = ($r.StatusCode -eq 200)
} catch { $healthy = $false }

if (-not $healthy) {
  Log "gateway unhealthy on port $Port, restarting"
  # A hung server still holds the port; clear it so the new one can bind.
  $stale = netstat -ano | Select-String ":$Port\s.*LISTENING" |
    ForEach-Object { ($_ -split "\s+")[-1] } | Select-Object -Unique
  foreach ($p in $stale) {
    if ($p -match '^\d+$' -and [int]$p -ne 0) {
      Log "stopping stale pid $p"
      Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Seconds 2
  Start-Process -FilePath (Join-Path $PSScriptRoot "start-gateway.cmd") -ArgumentList "$Port" -WindowStyle Hidden
  Log "gateway start issued"
}

# ----------------------------------------------------------------- tunnel ---
if ($NoTunnel) { exit 0 }
if (-not (Get-Command cloudflared.exe -ErrorAction SilentlyContinue)) { exit 0 }

$tunnelLog = Join-Path $logDir "tunnel.log"
$proc = Get-CimInstance Win32_Process -Filter "name='cloudflared.exe'" |
  Where-Object { $_.CommandLine -match "localhost:$Port(\s|$)" }

$tunnelOk = $false
if ($proc) {
  $tunnelOk = $true
  if (Test-Path $tunnelLog) {
    # cloudflared is quiet when healthy, so compare the last registration
    # against the last retry: a retry after the last registration means the
    # edge connection is gone and, for a quick tunnel, the hostname with it.
    $lines = Get-Content $tunnelLog -Tail 400
    $lastReg = -1; $lastRetry = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match "Registered tunnel connection") { $lastReg = $i }
      elseif ($lines[$i] -match "Retrying connection|Serve tunnel error") { $lastRetry = $i }
    }
    if ($lastRetry -gt $lastReg) { $tunnelOk = $false }
  }
}

if (-not $tunnelOk) {
  if ($proc) {
    Log "tunnel lost its edge connection, restarting cloudflared"
    foreach ($p in $proc) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    if (Test-Path $tunnelLog) {
      Move-Item $tunnelLog (Join-Path $logDir ("tunnel-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))) -Force
    }
    Start-Sleep -Seconds 2
  } else {
    Log "tunnel for port $Port not running, starting"
  }
  Start-Process -FilePath (Join-Path $PSScriptRoot "start-tunnel.cmd") -ArgumentList "$Port" -WindowStyle Hidden
}

# Publish the current quick-tunnel URL so clients can find it after a restart.
if (Test-Path $tunnelLog) {
  $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1
  if ($m) {
    $url = $m.Matches[0].Value
    $urlFile = Join-Path $logDir "tunnel-url.txt"
    $prev = if (Test-Path $urlFile) { (Get-Content $urlFile -Raw).Trim() } else { "" }
    if ($url -ne $prev) {
      Set-Content -Path $urlFile -Value $url -Encoding ascii
      Log "tunnel url: $url"
    }
  }
}
