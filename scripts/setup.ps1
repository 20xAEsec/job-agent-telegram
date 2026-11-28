# JobAgent setup for Windows. Safe to run again at any time: it skips what is already done.
# Run:  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($n, $text) { Write-Host ''; Write-Host "[$n/5] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK  $text" -ForegroundColor Green }
function Warn($text) { Write-Host "  !   $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "  X   $text" -ForegroundColor Red; Write-Host ''; Write-Host 'Fix that, then run this setup again.'; Read-Host '  Press Enter to close' | Out-Null; exit 1 } # a right-click run closes the window on exit
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$HOME\.bun\bin;$HOME\.local\bin"
}
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
# Telegram Desktop registers tg:// links; with it, links open straight in the app on this computer.
function Has-TelegramApp { Test-Path 'Registry::HKEY_CLASSES_ROOT\tg' }
function Find-Token($text) { [regex]::Match([string]$text, '\d{5,}:[A-Za-z0-9_-]{30,}').Value }
function Ask-YesNo($q) { $a = Read-Host "  $q [Y/n]"; return ($a -eq '' -or $a -match '^[Yy]') }

Write-Host ''
Write-Host '  JobAgent setup' -ForegroundColor White
Write-Host '  Finds jobs, tailors your resume and prepares applications. Nothing is sent without you.'

# ---- 1. Tools ----
Step 1 'Checking your computer'
Refresh-Path
foreach ($t in @(@{ cmd = 'uv'; url = 'https://astral.sh/uv/install.ps1'; what = 'uv (runs the Python helper)' }, @{ cmd = 'bun'; url = 'https://bun.sh/install.ps1'; what = 'Bun (runs the app)' })) {
    if (Has $t.cmd) { Ok $t.what; continue }
    if (-not (Ask-YesNo "$($t.what) is missing. Install it now?")) { Fail "$($t.what) is needed." }
    # The tool's own installer, so no package manager is needed. A separate process: an installer may call exit.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm $($t.url) | iex" | Out-Host
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
$opened = $false
while (-not $bot) {
    if (-not $opened) {
        $opened = $true
        if (Has-TelegramApp) { Start-Process 'tg://resolve?domain=BotFather' } else { Start-Process 'https://t.me/BotFather' }
    }
    Write-Host ''
    Write-Host '  JobAgent talks to you through your own private Telegram bot. To make one (1 minute):'
    Write-Host '    1. In Telegram, open a chat with @BotFather  (https://t.me/BotFather, I just opened it) and tap START'
    Write-Host '    2. Send  /newbot , pick any name, then a username ending in "bot" (if it is taken, add some digits)'
    Write-Host '    3. BotFather replies with a token like  123456789:AAH...  Click it to copy it.'
    Write-Host '  Telegram only on your phone? Open https://web.telegram.org on this computer to copy the token there.'
    Write-Host ''
    $typed = Read-Host '  Paste the token here, or just press Enter once you copied it'
    if (-not $typed) { $typed = Get-Clipboard -Raw -ErrorAction SilentlyContinue }
    $token = Find-Token $typed
    if (-not $token) { Warn 'I could not find a bot token there. It looks like 123456789:AAH... (copy it from BotFather''s message).'; continue }
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
    if (Has-TelegramApp) {
        Start-Process "tg://resolve?domain=$bot&start=$($p.pairing_code)"
        Write-Host '  I also opened it in Telegram on this computer: tap START there.' -ForegroundColor White
    }
} elseif ($p.code -eq 'already_paired') { Ok 'Already connected to your Telegram' }
else { Fail "Could not make a pairing link: $($p.error)" }

Write-Host ''
Write-Host '  Setup is done. In Telegram I ask for your resume first: have it ready as a PDF or Word file.' -ForegroundColor Green
Write-Host '  Want the dashboard on your phone too? While JobAgent runs, run:  scripts\phone.ps1'
Write-Host ''
# JobAgent only works while it runs; most "it stopped answering" is a closed window.
if (Ask-YesNo 'Keep JobAgent running in the background (no window, starts when you log in)? The bot replies once you answer.') {
    & (Join-Path $PSScriptRoot 'background.ps1')
    Read-Host '  Press Enter to close this window' | Out-Null
    exit 0
}
Write-Host '  JobAgent starts now; keep its window open while you use it.' -ForegroundColor Green
Write-Host '  Next time, start it with:  scripts\start.ps1  (or turn on background mode:  scripts\background.ps1)'
Write-Host ''
& (Join-Path $PSScriptRoot 'start.ps1')
