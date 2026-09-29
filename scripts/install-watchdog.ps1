# Registers scripts\watchdog.ps1 as a per-user scheduled task that fires at
# logon and then every minute. No administrator rights needed.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1 -Uninstall
param(
  [string]$TaskName = "AIcad Watchdog",
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed task '$TaskName'."
  exit 0
}

$script = Join-Path $PSScriptRoot "watchdog.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""

$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($every, $logon) `
  -Settings $settings -Force | Out-Null
Write-Host "Registered task '$TaskName' (every minute + at logon) running $script"
