# Starts JobAgent. Keep this window open (you can minimize it); closing it turns JobAgent off.
# -Practice forces practice mode on (nothing is ever submitted), whatever the setting says.
param([switch]$Practice)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$HOME\.bun\bin;$HOME\.local\bin"
$host.UI.RawUI.WindowTitle = 'JobAgent (keep this window open)'

$r = uv run --quiet --project agent jobagent setup-check | ConvertFrom-Json
if (-not $r.ok) {
    Write-Host 'JobAgent cannot start yet:' -ForegroundColor Red
    $r.checks | Where-Object { -not $_.ok -and $_.required } | ForEach-Object { Write-Host "  X  $($_.name): $($_.detail)" }
    Write-Host ''
    Write-Host 'Run the setup to fix it:  scripts\setup.ps1'
    exit 1
}
if ($Practice) { $env:JOBAGENT_DRY_RUN = '1' }
bun run app/src/main.ts
