# JobAgent setup for Windows. Safe to run again at any time: it skips what is already done.
# Run:  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($n, $text) { Write-Host ''; Write-Host "[$n/5] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  !   $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "  X   $text" -ForegroundColor Red; Write-Host ''; Write-Host 'Fix that, then run this setup again.'; exit 1 }
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$HOME\.bun\bin;$HOME\.local\bin"
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Ask-YesNo($q) { $a = Read-Host "  $q [Y/n]"; return ($a -eq '' -or $a -match '^[Yy]') }

Write-Host ''
Write-Host '  JobAgent setup' -ForegroundColor White
Write-Host '  Finds jobs, tailors your resume and prepares applications. Nothing is sent without you.'

# ---- 1. Tools ----
Step 1 'Checking your computer'
Refresh-Path
foreach ($t in @(@{ cmd = 'uv'; id = 'astral-sh.uv'; what = 'uv (runs the Python helper)' }, @{ cmd = 'bun'; id = 'Oven-sh.Bun'; what = 'Bun (runs the app)' })) {
    if (Has $t.cmd) { Ok $t.what; continue }
    if (-not (Has 'winget')) { Fail "$($t.what) is missing. Install it, then run setup again." }
    if (-not (Ask-YesNo "$($t.what) is missing. Install it now?")) { Fail "$($t.what) is needed." }
    winget install --id $t.id -e --accept-source-agreements --accept-package-agreements | Out-Host
    Refresh-Path
    if (Has $t.cmd) { Ok $t.what } else { Fail "Installed $($t.cmd), but this window can't see it yet. Close this window, open a new one, and run setup again." }
}
if (-not (Has 'claude')) {
    Warn 'Claude Code is missing. JobAgent uses it (with your own Claude subscription) to do the thinking.'
    if (Ask-YesNo 'Install Claude Code now?') { Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression; Refresh-Path }
    if (-not (Has 'claude')) { Fail 'Install Claude Code from https://claude.com/claude-code, then run setup again.' }
}
Ok 'Claude Code'
$auth = $null
try { $auth = claude auth status 2>$null | ConvertFrom-Json } catch { }
if ($auth -and -not $auth.loggedIn) {
    Warn 'Claude Code is not logged in. A browser window opens: log in with your Claude (Pro or Max) account.'
    claude auth login
    try { $auth = claude auth status 2>$null | ConvertFrom-Json } catch { }
    if ($auth -and -not $auth.loggedIn) { Fail 'Claude is still not logged in.' }
}
Ok 'Claude account'

# ---- 2. Install ----
Step 2 'Installing JobAgent (a few minutes the first time)'
Push-Location app; bun install --silent | Out-Null; Pop-Location; Ok 'App'
uv sync --project agent --quiet; Ok 'Python helper'
Write-Host '  ... downloading the browser used to fill in forms (about 150 MB, first time only)'
uv run --quiet --project agent playwright install chromium | Out-Null; Ok 'Form-filling browser'
New-Item -ItemType Directory -Force data | Out-Null

# ---- 3. Telegram bot ----
Step 3 'Your Telegram bot'
$envFile = 'data\.env'
$bot = $null
if (Test-Path $envFile) {
    $token = ((Get-Content $envFile -Raw) -replace '(?s).*TELEGRAM_BOT_TOKEN=([^\r\n]+).*', '$1').Trim()
    try { $bot = (Invoke-RestMethod "https://api.telegram.org/bot$token/getMe").result.username; Ok "Bot @$bot" } catch { Warn 'The saved bot token no longer works. Let''s set a new one.'; Remove-Item $envFile }
}
while (-not $bot) {
    Write-Host ''
    Write-Host '  JobAgent talks to you through your own private Telegram bot. To make one (1 minute):'
    Write-Host '    1. In Telegram, open a chat with @BotFather  (https://t.me/BotFather)'
    Write-Host '    2. Send  /newbot , pick any name, then a username ending in "bot"'
    Write-Host '    3. BotFather replies with a token like  123456789:AAH...  Copy it.'
    Write-Host ''
    $token = (Read-Host '  Paste the token here').Trim()
    if (-not $token) { continue }
    try {
        $bot = (Invoke-RestMethod "https://api.telegram.org/bot$token/getMe").result.username
        # No BOM: the app matches ^TELEGRAM_BOT_TOKEN= at the start of a line.
        [System.IO.File]::WriteAllText((Join-Path (Get-Location) $envFile), "TELEGRAM_BOT_TOKEN=$token`n", (New-Object System.Text.UTF8Encoding $false))
        Ok "Bot @$bot saved"
    } catch { Warn 'Telegram did not accept that token. Copy the whole line BotFather sent, and try again.' }
}

# ---- 4. Check ----
Step 4 'Checking everything'
$r = uv run --quiet --project agent jobagent setup-check | ConvertFrom-Json
foreach ($c in $r.checks) {
    if ($c.ok) { Ok $c.name } elseif ($c.required) { Warn "$($c.name): $($c.detail)" } else { Warn "$($c.name) (optional): $($c.detail)" }
}
if (-not $r.ok) { Fail 'Something required is missing (see above).' }

# ---- 5. Connect ----
Step 5 'Connect your phone'
$p = uv run --quiet --project agent jobagent pair --new --bot $bot | ConvertFrom-Json
if ($p.ok) {
    Write-Host ''
    Write-Host '  Scan this with your phone camera, or open the link in Telegram, then tap START:' -ForegroundColor White
    Write-Host ''
    Write-Host $p.qr
    Write-Host "  $($p.link)" -ForegroundColor White
    Write-Host "  (works once, for $($p.valid_minutes) minutes)"
} elseif ($p.code -eq 'already_paired') { Ok 'Already connected to your Telegram' }
else { Fail "Could not make a pairing link: $($p.error)" }

Write-Host ''
Write-Host '  Setup is done. JobAgent starts now; keep its window open while you use it.' -ForegroundColor Green
Write-Host '  Next time, start it with:  scripts\start.ps1'
Write-Host ''
& (Join-Path $PSScriptRoot 'start.ps1')
