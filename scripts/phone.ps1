# Dashboard on your phone, in one step. Downloads Cloudflare Tunnel the first time (no winget needed), starts it and
# gives JobAgent its address. JobAgent must be running. Keep this window open; closing it disconnects your phone.
#   Run:  powershell -ExecutionPolicy Bypass -File scripts\phone.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$HOME\.bun\bin"
$host.UI.RawUI.WindowTitle = 'JobAgent phone access (keep this window open)'

if (Get-Command bun -ErrorAction SilentlyContinue) {
    bun scripts/phone.ts
    $code = $LASTEXITCODE
} else {
    Write-Host '  Run the setup first:  scripts\setup.ps1' -ForegroundColor Red
    $code = 1
}
# A right-click run closes the window on exit: leave the reason on screen.
if ($code -ne 0) { Read-Host '  Press Enter to close' | Out-Null }
exit $code
