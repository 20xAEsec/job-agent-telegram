# Run JobAgent in the background: it starts when you log in to Windows, with no window, and restarts if it crashes.
#   Turn on:   powershell -ExecutionPolicy Bypass -File scripts\background.ps1
#   Turn off:  powershell -ExecutionPolicy Bypass -File scripts\background.ps1 -Remove
#   Status:    powershell -ExecutionPolicy Bypass -File scripts\background.ps1 -Status
param([switch]$Remove, [switch]$Status)
$ErrorActionPreference = 'Stop'
$name = 'JobAgent'
$start = Join-Path $PSScriptRoot 'start.ps1'

if ($Status) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host 'Background mode is off.'; exit 0 }
    $i = Get-ScheduledTaskInfo -TaskName $name
    Write-Host "Background mode is on. State: $($t.State). Last run: $($i.LastRunTime) (result $($i.LastTaskResult))."
    Write-Host 'Logs: data\logs\app.log'
    exit 0
}
if ($Remove) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host 'Background mode is off. Start JobAgent with scripts\start.ps1 when you want it.' -ForegroundColor Green
    exit 0
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$start`"" -WorkingDirectory (Split-Path $PSScriptRoot -Parent)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Crash-loop protection: at most 3 restarts, a minute apart; then it stays off until the next login.
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host 'Background mode is on: JobAgent runs now and every time you log in, with no window.' -ForegroundColor Green
Write-Host 'Turn it off with:  scripts\background.ps1 -Remove'
