---
name: setup-jobagent
description: Walk the owner through the whole JobAgent setup when they ask in the terminal ("set this up", "set it up", "install JobAgent", "get me started", "help me set up", "finish setting up", "it's not set up yet"). Checks what is already done, installs what is missing, opens Telegram and the setup window for them, and watches until their phone is connected and the questions are answered. Terminal use by the owner only.
---

# Set up JobAgent

You are talking to the computer's owner **in this terminal**. If your prompt starts with `JobAgent task:`, this is a headless task: refuse. Setup and pairing happen only on the owner's computer.

Goal: the owner does only what needs a human. They log in to Claude and Telegram if asked, create a bot, copy its token, tap **Start**, and answer the bot's questions. You do everything else.

How to talk to them:
- They may not be technical. One or two lines per message, plain words, no jargon.
- **One thing at a time.** Give the next action, not the whole list.
- Don't ask what you can check yourself. Don't make them report back what you can watch.
- If Claude Code asks them to allow a command, they choose **Yes**. Tell them this once, before the first command.

`ROOT` below is this project folder (the one with `scripts/setup.ps1`).

## 1. Look at the computer (read-only)

**Windows**, in PowerShell, from `ROOT`:
```powershell
$env:Path += ";$HOME\.bun\bin;$HOME\.local\bin"
foreach ($c in "uv","bun","claude","winget") { "{0}: {1}" -f $c, [bool](Get-Command $c -EA 0) }
"telegram app: " + (Test-Path "Registry::HKEY_CLASSES_ROOT\tg")
"app installed: " + ((Test-Path app\node_modules) -and (Test-Path agent\.venv))
"bot token saved: " + (Test-Path data\.env)
"phone connected: " + [bool](Select-String -Path data\settings.json -Pattern '"paired_user_id": *\d' -EA 0)
"questions done: " + [bool](Select-String -Path data\settings.json -Pattern '"onboarded": *true' -EA 0)
"running: " + [bool](Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | ? { $_.CommandLine -match "app[\\/]src[\\/]main\.ts" })
"background mode: " + [bool](Get-ScheduledTask -TaskName JobAgent -EA 0)
"claude logged in: " + (claude auth status | ConvertFrom-Json).loggedIn
```
**macOS/Linux:** `command -v uv bun claude brew`; `ls -d /Applications/Telegram*.app`; `test -d app/node_modules -a -d agent/.venv`; `test -f data/.env`; `grep -E '"paired_user_id": *[0-9]|"onboarded": *true' data/settings.json`; `pgrep -f '[b]un run app/src/main.ts'`; `claude auth status`.

`Test-Path data\.env` only checks that the file exists. Never open, print or read `data/.env`.

## 2. Pick up where they are

Use the **first** row that matches. Never redo finished work.

| What you found | Do this |
|---|---|
| Running, phone connected, questions done | Say it's set up and running (send `/menu` to the bot). Offer the dashboard (step 8). Stop. Set up again only if they ask. |
| Running, phone connected, questions not done | Ask them to send `/menu` to their bot and answer the questions. Watch (step 7, second watch). |
| Running, phone not connected | The link may have expired. Ask them to close the JobAgent window (background mode: you run `scripts\background.ps1 -Remove`), then do step 6. |
| Not running, app installed, token saved, phone connected | Only start it. Background mode on: `Start-ScheduledTask -TaskName JobAgent`. Otherwise open `scripts\start.ps1` / `scripts/start.sh` in its own window, the same way as step 6. Then check the log (step 7). |
| Anything else | Say what will happen (below), then steps 3 to 7, skipping what is already done. |

What will happen, in about 3 lines: about 10 minutes; you install what's needed; they make a private Telegram bot (1 minute) and tap Start; then the bot asks a few questions, starting with their resume (PDF or Word, so have it ready). Nothing is ever sent to an employer without their approval.

## 3. Install what's missing

Say in one line what you're installing and why, then run it. Windows may show a permission pop-up: they click **Yes**.

| Missing | Windows (PowerShell) | macOS with Homebrew |
|---|---|---|
| uv (runs the Python helper) | `powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 \| iex"` | `brew install uv` |
| Bun (runs the app) | `powershell -ExecutionPolicy Bypass -c "irm https://bun.sh/install.ps1 \| iex"` | `brew install oven-sh/bun/bun` |
| Telegram Desktop (optional) | with winget: `winget install -e --id Telegram.TelegramDesktop`; else `Start-Process https://desktop.telegram.org` and they install it | `brew install --cask telegram` |

- **No Homebrew, or Linux:** don't install uv or Bun yourself (this project blocks `curl` for you). Skip to step 4, then step 6: the setup window offers to install them and they press Enter. Telegram Desktop: https://desktop.telegram.org (Linux: `flatpak install flathub org.telegram.desktop`).
- **Telegram Desktop is optional.** It makes links open right on this computer. If they'd rather use only their phone, skip it: setup shows a QR code to scan.
- **Claude not logged in:** they type `! claude auth login` (a browser opens) and use a Claude **Pro or Max** plan (https://claude.com/pricing). JobAgent runs on their own subscription.
- After a fresh install your shell may not find the new tool. Refresh Path the way `scripts/setup.ps1` does (`Refresh-Path`) instead of asking them to restart.

## 4. Open Telegram and get it signed in

Do this now so they can sign in while step 5 installs.
- Windows: `Start-Process "tg://resolve?domain=BotFather"`. macOS: `open "tg://resolve?domain=BotFather"`. No Telegram app: open `https://web.telegram.org` instead.
- If Telegram Desktop is new, it asks them to sign in. Easiest from their phone: **Telegram → Settings → Devices → Link Desktop Device**, then scan the code on screen.
- No Telegram account at all? They install Telegram on their phone first (https://telegram.org/apps) and sign up with their phone number.

## 5. Prepare the app (you run these; no input needed)

Only if uv and Bun are present. From `ROOT`, one at a time, one line of progress each:
```
cd app && bun install
uv sync --project agent
uv run --project agent playwright install chromium     # ~150 MB the first time; allow up to 10 minutes
```
This makes the setup window in step 6 fly through its install step. If one fails, fix it here; the error is easier to read in your shell than theirs.

## 6. Open the setup window for them

The setup script must run in its **own window**. It asks for the bot token, which must never pass through this chat, and it ends by starting JobAgent. **Never** run it with the Bash or PowerShell tool in this session, or with `!`.

Keep the inner quotes: the folder path often contains spaces.
- Windows:
  `Start-Process powershell -WorkingDirectory "<ROOT>" -ArgumentList "-NoExit","-ExecutionPolicy","Bypass","-File","`"<ROOT>\scripts\setup.ps1`""`
- macOS:
  `osascript -e 'tell application "Terminal" to do script "cd \"<ROOT>\" && bash scripts/setup.sh"' -e 'tell application "Terminal" to activate'`
- Linux: they open a terminal in this folder and run `bash scripts/setup.sh`.

Start the watch in step 7 right away, then tell them what to do in the window (short):
1. The first checks finish by themselves. If it asks to install something, press **Enter**.
2. **Telegram opens BotFather.** Tap **Start**, send `/newbot`, type any name, then a username ending in `bot` (like `maria_jobs_bot`).
3. BotFather answers with a token like `123456789:AAH…`. **Click it** (that copies it), switch back to the setup window and press **Enter**.
   **Don't paste the token here.** It belongs only in that window.
4. A **QR code** appears. With Telegram Desktop, the bot opens by itself: tap **Start**. Otherwise, scan the QR with the phone camera and tap **Start**.
5. **Windows:** the window then asks about running in the background. **Answer it now**: the bot only replies once JobAgent is running. Press **Enter** for yes (recommended: no window to keep open, starts when they log in), then **Enter** again to close. If they type `n`, that window is JobAgent: keep it open (minimizing is fine).
   **macOS/Linux:** that window is now JobAgent. Keep it open; closing it turns JobAgent off.

## 7. Watch for the connection

Don't make them tell you when they're done. Run this in the background (`run_in_background: true`, from `ROOT`). Reading `data/settings.json` is fine. Never edit it.

Bash:
```bash
for i in $(seq 1 240); do grep -Eq '"paired_user_id": *[0-9]' data/settings.json 2>/dev/null && { echo PAIRED; exit 0; }; sleep 5; done; echo TIMEOUT
```
No Bash on Windows, use PowerShell:
```powershell
foreach ($i in 1..240) { if (Select-String -Path data\settings.json -Pattern '"paired_user_id": *\d' -Quiet -EA 0) { "PAIRED"; exit }; Start-Sleep 5 }; "TIMEOUT"
```

- **PAIRED:** check the last lines of `data/logs/app.log` for `polling as @…` and any error. Tell them they're connected, and that the bot now asks a few questions on their phone (about 3 minutes): their resume (send the PDF or Word file; from this computer they can drag it into the chat), the roles, location and pay they want, work eligibility, and a few optional ones.
- Then watch a second time, the same loop with the pattern `"onboarded": *true`, printing `DONE`. On **DONE**, tell them in 3 lines: setup is finished; send a job link to the bot to try it; practice mode is on, so nothing is submitted until they turn it off in ⚙️ Settings.
- **TIMEOUT** (20 minutes): ask where they got stuck, and use the table below.

## 8. Show them the dashboard (optional)

Tell them in two lines that JobAgent also has a dashboard. It shows their whole pipeline on one screen with Approve and Skip, and it opens from Telegram: Home → 🖥 Dashboard gives a private link to open in the browser on this computer. Find the port in `data/logs/app.log` (the last `dashboard on http://127.0.0.1:<port>` line; it's 4777 unless that was taken).

Then ask whether they'd also like it on their phone. If they say no, you're done.

If they say yes:
1. **Windows:** open the phone script in its own window (never inside this session, because it would stop when this session ends):
   `Start-Process powershell -WorkingDirectory "<ROOT>" -ArgumentList "-ExecutionPolicy","Bypass","-File","`"<ROOT>\scripts\phone.ps1`""`
   It gets cloudflared, starts the tunnel and gives JobAgent the address. When the window says their phone can reach the dashboard, they keep it open.
2. **macOS/Linux:** install cloudflared (`brew install cloudflared`, or https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), have them run `cloudflared tunnel --url http://127.0.0.1:<port>` in a **new** terminal window and keep it open, then send the `https://….trycloudflare.com` address to JobAgent: Home → 🖥 Dashboard → 📱 Set up phone access.
3. In Telegram, Home → 🖥 Dashboard → **📱 Open dashboard** opens it inside Telegram.
4. Say in one line what to expect:
   - Only their Telegram account can sign in.
   - Private answers are never shown.
   - A quick tunnel gets a new address each time it starts: on Windows they run `scripts\phone.ps1` again; otherwise they send the new one.
   - They can turn it off with 🚫 Turn off phone access.

   [docs/dashboard.md](../../../docs/dashboard.md) has the details if they ask.

## If something goes wrong

| What they see | What to do |
|---|---|
| A token in this chat | Don't repeat it. In BotFather, send `/revoke`, pick the bot, and put the **new** token in the setup window. |
| "Telegram did not accept that token" / "could not find a bot token" | They copied part of it, or something else. Click the token in BotFather's message again, then press Enter. |
| "…is missing. Close this window, open a new one" | A fresh install the window can't see yet. Close it and do step 6 again. |
| Tapped Start but the bot is silent | JobAgent isn't running: they still need to answer the background question (step 6, item 5), or the window was closed. Computer must be awake. Check `data/logs/app.log`. |
| "JobAgent is already running" | Only one copy can use the bot. Close the other JobAgent window and do step 6 again. |
| "Another program is using this Telegram bot" | Something else is polling the same bot, often an older JobAgent (v1, or one started by another Claude session). Find it (`bun`/`node` processes) and ask them before stopping it. |
| The pairing link expired (15 minutes) | Stop JobAgent (close its window, or `scripts\background.ps1 -Remove`), then step 6. It makes a fresh link and skips everything already done. |
| The phone dashboard says "Open the dashboard from your JobAgent chat" | It must be opened with the 📱 Open dashboard button, not a browser. Check that the tunnel window is still open and that the address they sent is the current one. |
| "That link is old" on the computer | They should open the newest link from Home → 🖥 Dashboard. |
| A different Telegram account should own it | They run `uv run --project agent jobagent pair --reset` themselves in their own terminal, then setup again. |
| "docx->pdf converter (optional)" warning | Only matters for Word resumes. Install Microsoft Word or LibreOffice (https://www.libreoffice.org/download/), or upload a PDF resume. |

## Never

- Run `jobagent pair`, `credentials`, `login`, `handoff` or `submit` yourself, or `fill` without `--dry-run`.
- Read, print or ask for the bot token or anything in `data/.env`; edit `data/settings.json` or any `approval.json`.
- Read or print `data/dashboard.json` (it holds the dashboard's secret), or set the phone address yourself. Only `scripts\phone.ps1` in its own window, or the owner in Telegram, sets it.
- Run the setup, start or phone scripts inside this session.
- Edit `.claude/settings.json` to get around a blocked command.
- Turn practice mode off, or tell them how to skip the approval step.
